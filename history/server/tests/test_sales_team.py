"""销售协同：主管加派的任务（状态一步步走、必填拦住、改派带上下文）、协同请求（60 秒一段往上转、先到先得）。"""

from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from app.database import get_db
from app.deps import create_access_token
from app.enums import StaffRole, StaffStatus
from app.main import app
from app.models import SalesCollab, Staff
from app.services import sales_team as st


def _staff(db, role, username, **kw):
    s = Staff(staff_no=f"no-{username}", username=username, password_hash="x", name=username, role=role,
              status=kw.get("status", StaffStatus.ACTIVE))
    db.add(s)
    db.flush()
    return s


@pytest.fixture()
def people(db_session):
    db = db_session
    out = {
        "boss": _staff(db, StaffRole.ADMIN, "boss"),
        "tao": _staff(db, StaffRole.SALES, "tao"),
        "shao": _staff(db, StaffRole.SALES, "shao"),
        "gone": _staff(db, StaffRole.SALES, "gone", status=StaffStatus.DISABLED),
        "wh": _staff(db, StaffRole.WAREHOUSE, "wh"),
    }
    db.commit()
    return out


@pytest.fixture()
def client(db_session):
    app.dependency_overrides[get_db] = lambda: db_session
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _auth(s):
    return {"Authorization": f"Bearer {create_access_token(s.id, s.role)}"}


def _due(hours=5):
    return f"{datetime.utcnow() + timedelta(hours=8 + hours):%Y-%m-%d %H:%M}"


def test_加派_必填拦住_只能派给在职销售(client, people):
    boss, tao, gone = people["boss"], people["tao"], people["gone"]
    post = lambda body: client.post("/api/sales-workbench/tasks", json=body, headers=_auth(boss))
    ok = {"title": "把 27 寸显示器过一遍价", "scope": "只看小米、AOC 两个牌子", "due": _due(), "to": tao.id}
    assert "交付时间" in post({**ok, "due": ""}).json()["detail"]
    assert "范围" in post({**ok, "scope": " "}).json()["detail"]
    assert "已经过了" in post({**ok, "due": _due(-10)}).json()["detail"]
    assert post({**ok, "to": gone.id}).status_code == 400
    # 销售不能加派
    assert client.post("/api/sales-workbench/tasks", json=ok, headers=_auth(tao)).status_code == 403
    r = post(ok)
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "待接收" and r.json()["assignee"] == "tao"
    assert client.get("/api/sales-workbench/team", headers=_auth(boss)).json()["staff"] == [
        {"id": people["shao"].id, "name": "shao"}, {"id": tao.id, "name": "tao"}]


def test_加派_状态一步步走_今天里谁该动手谁看到(db_session, client, people):
    db, boss, tao, shao = db_session, people["boss"], people["tao"], people["shao"]
    t = st.create_task(db, boss, {"title": "核 5 台 iPhone 的成色", "scope": "架上 A3 层", "due": _due(), "to": tao.id})
    act = lambda who, a, body=None: client.post(f"/api/sales-workbench/tasks/{t['id']}/{a}", json=body or {}, headers=_auth(who))

    # 接手人：新派的是红的
    rows = st.today_tasks(db, tao)
    assert [(r["level"], r["button"]) for r in rows] == [("red", "看要求")]
    assert st.today_tasks(db, shao) == []
    # 别人看不到、也动不了
    assert client.get(f"/api/sales-workbench/tasks/{t['id']}", headers=_auth(shao)).status_code == 404
    # 主管不能替接手人接收；状态不对不能跳步
    assert act(boss, "accept").status_code == 403
    assert "不能交验收" in act(tao, "submit", {"note": "x"}).json()["detail"]

    assert act(tao, "accept").json()["state"] == "执行中"
    assert st.today_tasks(db, tao)[0]["level"] == "yellow"
    assert "等谁" in act(tao, "wait", {"wait_why": "等仓管拍照"}).json()["detail"]
    r = act(tao, "wait", {"wait_who": "仓管", "wait_why": "拍成色照", "wait_until": "明天上午"}).json()
    assert r["state"] == "等待外部" and "在等 仓管" in st.today_tasks(db, tao)[0]["sub"]
    assert act(tao, "resume").json()["state"] == "执行中"
    assert "说明" in act(tao, "submit").json()["detail"]
    assert act(tao, "submit", {"note": "5 台都核了，2 台降一档"}).json()["state"] == "待验收"
    # 交上去就不占接手人的清单了，主管那边红
    assert st.today_tasks(db, tao) == []
    assert [(r["level"], r["button"]) for r in st.today_tasks(db, boss)] == [("red", "去验收")]
    assert act(tao, "approve").status_code == 403
    assert act(boss, "reject", {"note": "缺照片"}).json()["state"] == "退回补正"
    assert "被退回：缺照片" in st.today_tasks(db, tao)[0]["sub"]
    act(tao, "submit", {"note": "补了照片"})
    r = act(boss, "approve").json()
    assert r["state"] == "已验收" and r["can"] == []
    assert [x["action"] for x in r["log"]] == ["派出", "接收", "等待外部", "恢复执行", "交验收", "退回补正", "交验收", "验收通过"]
    assert st.today_tasks(db, boss) == [] and st.today_tasks(db, tao) == []


def test_改派_必须写转交上下文_接手人第一眼看到(db_session, client, people):
    db, boss, tao, shao = db_session, people["boss"], people["tao"], people["shao"]
    t = st.create_task(db, boss, {"title": "跟进一单退货", "scope": "单号 123", "due": _due(), "to": tao.id})
    st.act(db, tao, t["id"], "accept", {})
    st.act(db, tao, t["id"], "block", {"note": "买家不回"})
    assert st.today_tasks(db, boss)[0]["button"] == "去接管"
    url = f"/api/sales-workbench/tasks/{t['id']}/reassign"
    assert "转交上下文" in client.post(url, json={"to": shao.id}, headers=_auth(boss)).json()["detail"]
    r = client.post(url, json={"to": shao.id, "handoff": "已催两次；未完成：退款；下一步：打电话"}, headers=_auth(boss)).json()
    assert r["state"] == "待接收" and r["assignee"] == "shao"
    assert st.today_tasks(db, tao) == []
    assert "上一个人留的话：已催两次" in st.today_tasks(db, shao)[0]["sub"]
    # 详情里主管能改派时带上能派的人
    assert "staff" in client.get(f"/api/sales-workbench/tasks/{t['id']}", headers=_auth(boss)).json()


def test_过了交付时间变红(db_session, people):
    from app.models import SalesTask

    db, boss, tao = db_session, people["boss"], people["tao"]
    t = st.create_task(db, boss, {"title": "x", "scope": "y", "due": _due(), "to": tao.id})
    st.act(db, tao, t["id"], "accept", {})
    assert st.today_tasks(db, tao)[0]["level"] == "yellow"
    db.get(SalesTask, t["id"]).due_at = datetime.utcnow() - timedelta(minutes=1)
    db.commit()
    row = st.today_tasks(db, tao)[0]
    assert row["level"] == "red" and "（已过）" in row["sub"]
    assert st.task_out(db, db.get(SalesTask, t["id"]), tao)["late"] is True


def test_协同请求_60秒一段往上转(db_session, people):
    db, (boss, tao, shao, wh) = db_session, (people[k] for k in ("boss", "tao", "shao", "wh"))
    c = st.create_collab(db, wh, {"title": "买家要验机视频", "conversation_id": "cv1", "owner_names": ["tao"]})
    assert c["to"] == "tao" and c["url"].endswith("id=cv1")
    t0 = datetime.utcnow()
    ids = lambda who, sec: [x["id"] for x in st.live(db, who, t0 + timedelta(seconds=sec))["waiting"]]
    # 0–60 秒：只给会话那个号的负责人
    assert ids(tao, 5) == [c["id"]] and ids(shao, 5) == [] and ids(boss, 5) == []
    assert st.live(db, tao, t0 + timedelta(seconds=5))["waiting"][0]["stage"] == "open"
    # 60–120 秒：所有在岗销售
    assert ids(shao, 70) == [c["id"]] and ids(boss, 70) == []
    # 120 秒后：主管也看得到
    w = st.live(db, boss, t0 + timedelta(seconds=130))["waiting"]
    assert [x["stage"] for x in w] == ["sup"]
    # 提的人自己在「我提的」里看
    assert [x["id"] for x in st.live(db, wh, t0)["sent"]] == [c["id"]]
    # 12 小时还没人接就不再弹
    assert ids(boss, 13 * 3600) == []


def test_协同请求_先到先得_做完了(client, db_session, people):
    db, (tao, shao, wh) = db_session, (people[k] for k in ("tao", "shao", "wh"))
    r = client.post("/api/sales-workbench/collab", json={"title": "请拍一段开机视频", "sku_code": "S1"}, headers=_auth(wh))
    assert r.status_code == 200, r.text
    cid = r.json()["id"]
    assert r.json()["to"] == "" and r.json()["url"].endswith("code=S1")
    assert client.post(f"/api/sales-workbench/collab/{cid}/take", headers=_auth(shao)).status_code == 200
    r = client.post(f"/api/sales-workbench/collab/{cid}/take", headers=_auth(tao))
    assert r.status_code == 409 and "shao" in r.json()["detail"]
    # 仓管不能接
    assert client.post(f"/api/sales-workbench/collab/{cid}/take", headers=_auth(wh)).status_code == 403
    live = client.get("/api/sales-workbench/collab", headers=_auth(shao)).json()
    assert [x["id"] for x in live["mine"]] == [cid] and live["waiting"] == []
    assert client.get("/api/sales-workbench/collab", headers=_auth(wh)).json()["sent"][0]["taken_by"] == "shao"
    assert client.post(f"/api/sales-workbench/collab/{cid}/done", headers=_auth(tao)).status_code == 400
    assert client.post(f"/api/sales-workbench/collab/{cid}/done", headers=_auth(shao)).status_code == 200
    assert client.get("/api/sales-workbench/collab", headers=_auth(shao)).json()["mine"] == []
    assert db.get(SalesCollab, cid).state == "done"


def test_没见过的情况_主管红_回了提的人黄_记成规则大家看(client, db_session, people):
    db, boss, tao, shao = db_session, people["boss"], people["tao"], people["shao"]
    post = lambda who, url, body: client.post(f"/api/sales-workbench/{url}", json=body, headers=_auth(who))
    assert "说清" in post(tao, "reports", {"text": "啊"}).json()["detail"]
    rid = post(tao, "reports", {"text": "买家说收到有亮点，验货照里没有", "sku_code": "T1"}).json()["id"]
    assert [(r["level"], r["tag"]) for r in st.report_tasks(db, boss)] == [("red", "新情况")]
    assert st.report_tasks(db, tao) == [] and st.report_tasks(db, shao) == []
    assert post(tao, f"reports/{rid}/answer", {"answer": "先拍视频"}).status_code == 403
    assert "该怎么办" in post(boss, f"reports/{rid}/answer", {"answer": ""}).json()["detail"]
    r = post(boss, f"reports/{rid}/answer", {"answer": "先让仓管拍开机视频，再决定退不退", "is_rule": True}).json()
    assert r["state"] == "answered" and r["is_rule"]
    assert st.report_tasks(db, boss) == []
    assert [(x["level"], x["tag"]) for x in st.report_tasks(db, tao)] == [("yellow", "主管回了")]
    # 别人在规则里看得到；提的人打开这页就算看过
    assert [x["answer"][:5] for x in client.get("/api/sales-workbench/reports", headers=_auth(shao)).json()["rules"]] == ["先让仓管拍"]
    page = client.get("/api/sales-workbench/reports", headers=_auth(tao)).json()
    assert page["mine"][0]["answered_by"] == "boss" and page["waiting"] == []
    assert st.report_tasks(db, tao) == []
    assert client.get("/api/sales-workbench/reports", headers=_auth(people["wh"])).status_code == 403


def test_collab_replied_expired_and_sup_ping(db_session, monkeypatch):
    """会话里有人回了就自动关；12 小时没人接关掉、提的人看得到；转到主管叫一声（只叫一次）。"""
    from datetime import datetime, timedelta
    from app.models import SalesCollab
    from app.services import sales_team as st

    db = db_session
    pings = []
    monkeypatch.setattr("app.services.staff_notify.send", lambda staff, title, body, **kw: pings.append((staff.username if staff else None, title)))
    a, b, boss = _staff(db, StaffRole.SALES, "a"), _staff(db, StaffRole.SALES, "b"), _staff(db, StaffRole.ADMIN, "boss")
    db.commit()
    c1 = st.create_collab(db, a, {"title": "帮回一下", "conversation_id": "conv-1", "owner_names": ["b"]})
    assert pings == [("b", "同事请你帮忙")]
    assert st.close_for_conversation(db, b, "conv-1") == 1
    sent = st.live(db, a)["sent"]
    assert [(x["id"], x["stage"], x["taken_by"]) for x in sent] == [(c1["id"], "replied", "b")]

    c2 = st.create_collab(db, a, {"title": "没人理"})
    row = db.get(SalesCollab, c2["id"])
    row.created_at = datetime.utcnow() - timedelta(minutes=3)
    db.commit()
    st.live(db, b)
    st.live(db, b)
    assert pings.count(("boss", "协同请求没人接")) == 1
    row.created_at = datetime.utcnow() - timedelta(hours=13)
    db.commit()
    assert st.live(db, b)["waiting"] == []
    assert any(x["id"] == c2["id"] and x["stage"] == "expired" for x in st.live(db, a)["sent"])

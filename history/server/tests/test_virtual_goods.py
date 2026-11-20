"""虚拟商品线：8 步证据校验、跟卖跳步、换人复现、主管批上架、补码判重、聊天认单、检查拦单、发码、作废换码、退款记名单、「今天」。"""

import asyncio
from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.database import get_db
from app.deps import create_access_token
from app.enums import StaffRole, StaffStatus
from app.main import app
from app.models import Staff, VirtualBuyerFlag, VirtualCode, VirtualOrder, VirtualReveal
from app.services import virtual_goods as vg
from app.services.gc_bridge import client as gc
from app.services.ledger_crypto import unseal


def _staff(db, role, username):
    s = Staff(staff_no=f"no-{username}", username=username, password_hash="x", name=username, role=role,
              status=StaffStatus.ACTIVE)
    db.add(s)
    db.flush()
    return s


@pytest.fixture()
def people(db_session):
    out = {"boss": _staff(db_session, StaffRole.ADMIN, "boss"), "boss2": _staff(db_session, StaffRole.ADMIN, "boss2"),
           "tao": _staff(db_session, StaffRole.SALES, "tao"), "shao": _staff(db_session, StaffRole.SALES, "shao")}
    db_session.commit()
    return out


EV = {
    1: {"source": "闲鱼榜单", "dedup": "搜过麦当劳，没有"},
    2: {"闲鱼": "25 条，16～61 元", "淘宝": "无", "京东": "无"},
    3: {"main": "券商", "backup": "无", "cost": "36", "qualify": "无", "quota": "每周 100 张"},
    4: {"price": "46", "cost": "36"},
    5: {"how": "买了 1 张自己核销", "result": "能用"},
    6: {"result": "照卡做成了"},
    7: {"listing": "麦当劳双人餐", "script": "您好，券码如下", "guide": "App 里兑换", "refund": "未发码可退",
        "stop": "连续 3 张被反馈已用"},
}


def _card(db, user, **kw):
    return vg.create(db, user, {"name": "麦当劳 双人餐", "path": ["A 码券类", "A1 餐饮券", "麦当劳"], **kw})


def _walk_to_sale(db, people, *, peers=""):
    tao, shao, boss = people["tao"], people["shao"], people["boss"]
    p = _card(db, tao)
    for n in range(1, 8):
        if p["step"] != n:
            continue
        who = shao if n == 6 else tao
        body = {"evidence": EV[n], "images": ["https://x/1.jpg"] if n == 5 else []}
        if n == 2:
            body["peers"] = peers
        p = vg.advance(db, who, p["id"], body)
    assert p["state"] == "pending"
    return vg.review(db, boss, p["id"], {"ok": True})


def test_evidence_rules(db_session, people):
    p = _card(db_session, people["tao"])
    with pytest.raises(HTTPException) as e:
        vg.advance(db_session, people["tao"], p["id"], {"evidence": {"source": "榜单"}})
    assert "查重" in e.value.detail and "待核" in e.value.detail
    with pytest.raises(HTTPException) as e:
        vg.advance(db_session, people["tao"], p["id"], {"evidence": {"source": "0", "dedup": "x"}})
    assert "填了 0" in e.value.detail
    # 别人的卡不能替他交
    with pytest.raises(HTTPException):
        vg.advance(db_session, people["shao"], p["id"], {"evidence": EV[1]})
    p = vg.advance(db_session, people["tao"], p["id"], {"evidence": EV[1]})
    assert p["step"] == 2


def test_follow_skips_5_6_and_test_needs_other_person(db_session, people):
    tao, shao = people["tao"], people["shao"]
    p = _card(db_session, tao)
    p = vg.advance(db_session, tao, p["id"], {"evidence": EV[1]})
    f = vg.advance(db_session, tao, p["id"], {"evidence": EV[2], "peers": "https://www.goofish.com/item?id=1084382196124"})
    assert f["listing_type"] == "follow"
    f = vg.advance(db_session, tao, f["id"], {"evidence": EV[3]})
    f = vg.advance(db_session, tao, f["id"], {"evidence": EV[4]})
    assert f["step"] == 7 and [s["state"] for s in f["steps"]][4:6] == ["skip", "skip"]

    q = _card(db_session, tao)
    for n in (1, 2, 3, 4):
        q = vg.advance(db_session, tao, q["id"], {"evidence": EV[n]})
    with pytest.raises(HTTPException) as e:
        vg.advance(db_session, tao, q["id"], {"evidence": EV[5]})
    assert "截图" in e.value.detail
    q = vg.advance(db_session, tao, q["id"], {"evidence": EV[5], "images": ["https://x/1.jpg"]})
    with pytest.raises(HTTPException) as e:
        vg.advance(db_session, tao, q["id"], {"evidence": EV[6]})
    assert e.value.status_code == 403
    q = vg.advance(db_session, shao, q["id"], {"evidence": EV[6]})
    assert q["step"] == 7


def test_review_rules(db_session, people):
    tao, boss, boss2 = people["tao"], people["boss"], people["boss2"]
    p = _card(db_session, boss)
    for n in (1, 2, 3, 4):
        p = vg.advance(db_session, boss, p["id"], {"evidence": EV[n], "peers": "1084382196124" if n == 2 else ""})
    p = vg.advance(db_session, boss, p["id"], {"evidence": EV[7]})
    with pytest.raises(HTTPException) as e:
        vg.review(db_session, boss, p["id"], {"ok": True})
    assert "自己交的" in e.value.detail
    with pytest.raises(HTTPException):
        vg.review(db_session, tao, p["id"], {"ok": True})
    with pytest.raises(HTTPException):
        vg.review(db_session, boss2, p["id"], {"ok": False, "note": "缺"})
    vg.update(db_session, boss2, p["id"], {"compliance": {"level": "C"}})
    with pytest.raises(HTTPException) as e:
        vg.review(db_session, boss2, p["id"], {"ok": True})
    assert "律师" in e.value.detail
    p = vg.review(db_session, boss2, p["id"], {"ok": False, "note": "停止条件写具体些"})
    assert p["state"] == "research" and p["step"] == 7 and p["reject_note"]


def test_restock_dedup_and_auto_needs_on_sale(db_session, people):
    tao = people["tao"]
    p = _card(db_session, tao)
    with pytest.raises(HTTPException):
        vg.update(db_session, tao, p["id"], {"auto_delivery": True})
    r = vg.restock(db_session, tao, p["id"], {"codes": "AAA\nBBB\nAAA\n\n", "supplier": "券商"})
    assert r["added"] == 2 and r["dup"] == 1
    r = vg.restock(db_session, tao, p["id"], {"codes": "BBB\nCCC"})
    assert r["added"] == 1 and r["product"]["stock"]["avail"] == 3
    with pytest.raises(HTTPException):
        vg.restock(db_session, tao, p["id"], {"codes": "CCC"})
    # 库里不存明文
    assert all(c.code_enc not in ("AAA", "BBB", "CCC") for c in db_session.query(VirtualCode))


def _paid(conv="c1", msg="m1", buyer="b***1", item="1084382196124", status="等待卖家发货", at=None):
    return {"conversation_id": conv, "account_id": "a1", "item_id": item, "peer_key": buyer, "peer_nick": "小鹿",
            "item_price": "46.00", "order_status": status,
            "paid": [{"id": msg, "at": (at or datetime.utcnow()).isoformat()}]}


def test_orders_from_chat_checks_send_void(db_session, people, monkeypatch):
    db, tao = db_session, people["tao"]
    p = _walk_to_sale(db, people)
    vg.update(db, tao, p["id"], {"item_ids": "https://www.goofish.com/item?id=1084382196124"})
    sent = []

    async def fake_send(cid, text, by_name=None):
        sent.append((cid, text))
        return {"task_id": f"t{len(sent)}"}

    monkeypatch.setattr(gc, "virtual_send", fake_send)

    # 没码：等补货
    assert vg.apply_paid(db, [_paid()])["new"] == 1
    assert vg.apply_paid(db, [_paid()])["new"] == 0
    o = db.query(VirtualOrder).one()
    assert o.status == "waiting" and o.amount == 46
    vg.restock(db, tao, p["id"], {"codes": "CODE-1\nCODE-2"})
    db.refresh(o)
    assert o.status == "ready"

    asyncio.run(vg.send(db, tao, o.id))
    assert o.status == "sending" and "CODE-1" in sent[0][1] and "App 里兑换" in sent[0][1]
    assert db.query(VirtualReveal).filter_by(action="send").count() == 1

    async def task_ok(tid):
        return {"status": "SUCCESS"}

    monkeypatch.setattr(gc, "get_task", task_ok)
    asyncio.run(vg.check_sending(db))
    assert o.status == "sent"

    # 同一买家又买：上一单没确认 → 拦住
    vg.apply_paid(db, [_paid(conv="c2", msg="m2")])
    o2 = db.query(VirtualOrder).filter_by(paid_msg_id="m2").one()
    assert o2.status == "held" and "上一单" in o2.hits[0]
    with pytest.raises(HTTPException):
        asyncio.run(vg.send(db, tao, o2.id))
    vg.release(db, people["shao"], o2.id)
    assert o2.status == "ready"

    # 第一单买家说码用不了：作废，再发换一张
    o.status = "ready"
    db.commit()
    vg.void_code(db, tao, o.id, {"note": "买家说已被使用"})
    asyncio.run(vg.send(db, tao, o.id))
    assert "CODE-2" in sent[-1][1]
    assert vg.reveal(db, tao, o.id)["code"] == "CODE-2"


def test_refund_and_blacklist(db_session, people):
    db, tao = db_session, people["tao"]
    p = _walk_to_sale(db, people)
    vg.update(db, tao, p["id"], {"item_ids": "1084382196124"})
    vg.apply_paid(db, [_paid()])
    vg.apply_paid(db, [_paid(status="买家申请退款")])
    o = db.query(VirtualOrder).one()
    assert o.status == "refund"
    assert db.query(VirtualBuyerFlag).one().refunds == 1
    vg.flag_buyer(db, tao, {"buyer_key": "b***1", "blacklisted": True, "note": "要了码说没收到"})
    vg.apply_paid(db, [_paid(conv="c3", msg="m3")])
    o3 = db.query(VirtualOrder).filter_by(paid_msg_id="m3").one()
    assert o3.status == "held" and any("退款名单" in h for h in o3.hits)


def test_auto_delivery_needs_both_switches(db_session, people, monkeypatch):
    db, tao, boss = db_session, people["tao"], people["boss"]
    p = _walk_to_sale(db, people)
    vg.update(db, tao, p["id"], {"item_ids": "1084382196124", "auto_delivery": True})
    vg.restock(db, tao, p["id"], {"codes": "X1"})

    async def fake_paid(ids):
        return [_paid()]

    async def fake_send(cid, text, by_name=None):
        return {"task_id": "t1"}

    monkeypatch.setattr(gc, "virtual_paid", fake_paid)
    monkeypatch.setattr(gc, "virtual_send", fake_send)
    r = asyncio.run(vg.sync(db))
    assert r["new"] == 1 and r["auto_sent"] == 0  # 总开关默认关
    with pytest.raises(HTTPException):
        vg.set_auto(db, tao, True)
    vg.set_auto(db, boss, True)
    r = asyncio.run(vg.sync(db))
    assert r["auto_sent"] == 1
    o = db.query(VirtualOrder).one()
    assert o.status == "sending" and o.sent_by_id is None


def test_today_tasks(db_session, people):
    db, tao = db_session, people["tao"]
    p = _walk_to_sale(db, people)
    vg.update(db, tao, p["id"], {"item_ids": "1084382196124"})
    vg.restock(db, tao, p["id"], {"codes": "Y1"})
    vg.apply_paid(db, [_paid(at=datetime.utcnow() - timedelta(minutes=3))])
    tasks = vg.today_tasks(db, tao)
    send = [t for t in tasks if t["key"].startswith("virtual:")]
    assert send and send[0]["level"] == "red" and "3 分钟" in send[0]["sub"]
    stock = [t for t in tasks if t["key"].startswith("virtual-stock:")]
    assert stock and stock[0]["level"] == "yellow"  # 1 张，低于提醒线 10
    assert vg.today_tasks(db, people["shao"]) == []  # 不是他负责的


def test_routes(db_session, people):
    app.dependency_overrides[get_db] = lambda: db_session
    try:
        c = TestClient(app)
        h = {"Authorization": f"Bearer {create_access_token(people['tao'].id, people['tao'].role)}"}
        r = c.post("/api/virtual/products", json={"name": "肯德基 2+1", "path": "A 码券类 › A1 餐饮券"}, headers=h)
        assert r.status_code == 200 and r.json()["code"].startswith("VC")
        g = c.get("/api/virtual/products", headers=h).json()
        assert g["items"][0]["name"] == "肯德基 2+1"
        assert any(n["name"] == "A 码券类" and n["n"] == 1 for n in g["tree"])
        assert c.post("/api/virtual/settings/auto-delivery?on=true", headers=h).status_code == 403
    finally:
        app.dependency_overrides.pop(get_db, None)

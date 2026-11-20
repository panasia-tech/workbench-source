"""网页版发布撞上「完成认证才可继续发布」:停手、留现场、叫人、人处理完能解冻(2026-10-06)。

现场:闲鱼弹了「完成认证才可继续发布 / 扫码进行认证」,判据里没有这句,流程当它是普通
弹窗,点不动等超时,失败清理再把页面跳回首页——人正扫着码,页面没了,也没有任何提醒。
"""
import pytest

from app.flow import runner
from app.flow.engine import RISK_ANCHORS, RiskHit
from app.flow.web import publish_flow_web as pw

VERIFY_DIALOG = ["完成认证才可继续发布", "扫码进行认证"]


def test_verify_dialog_is_a_risk_signal():
    assert "完成认证才可继续发布" in RISK_ANCHORS
    with pytest.raises(RiskHit) as hit:
        pw._check_risk([{"desc": "完成认证才可继续发布"}])
    assert hit.value.anchor == "完成认证才可继续发布"


class _Page:
    url = pw.PUBLISH_URL


class _FakeBrowser:
    """进发布页就是那个认证弹窗。记下所有导航,看失败后有没有被跳走。"""

    def __init__(self, descs):
        self.descs = descs
        self.page = _Page()
        self.launched = []
        self.cleared = 0

    def launch_app(self, url):
        self.launched.append(url)

    def screen_size(self):
        return 1280, 800

    def dump_nodes(self):
        return [{"desc": d, "cls": "", "center": (640, 300 + 40 * i), "size": (300, 32)}
                for i, d in enumerate(self.descs)]

    def screencap(self):
        return b""

    def clear_media(self, uris=None):
        self.cleared += 1
        return 0


SPEC = {"images": ["https://img.example.com/a.jpg"], "description": "测试宝贝", "price": 99,
        "shipping": {"mode": "free"}, "confirm_publish": True}


def test_risk_on_publish_page_stops_and_leaves_the_dialog(monkeypatch):
    monkeypatch.setattr(pw.time, "sleep", lambda *_: None)
    t = _FakeBrowser(VERIFY_DIALOG)
    result = pw.run_publish_web(t, SPEC, shot_sink=lambda name, data: f"shot/{name}")
    assert result["ok"] is False
    assert result["risk"] == "完成认证才可继续发布"
    assert t.launched == [pw.PUBLISH_URL], "命中风控后不能再跳页——那个弹窗要人来扫码"
    assert t.cleared == 1, "下载到本机的图照样清(不动页面)"


def test_ordinary_failure_still_cleans_up(monkeypatch):
    """不是风控的失败(这里是没登录)照旧离开发布页,别把半张表单留给下一个任务。"""
    monkeypatch.setattr(pw.time, "sleep", lambda *_: None)
    t = _FakeBrowser(["随便什么"])
    result = pw.run_publish_web(t, SPEC, shot_sink=lambda name, data: f"shot/{name}")
    assert result["ok"] is False and not result["risk"]
    assert t.launched[0] == pw.PUBLISH_URL and t.launched[-1] == "https://www.goofish.com"


def test_risk_freezes_account_and_tells_someone_where_to_go(db, monkeypatch):
    from app.models import Account, AccountStatus, Device, RiskState, Task, TaskStatus

    monkeypatch.setattr("app.jobs.on_task_result", lambda *a, **k: None)
    sent = []
    # 企微直发在线上报 60020(新服务器 IP 不在可信 IP 里),得能回退 Server酱
    monkeypatch.setattr("app.notify.notify_wecom", lambda *a, **k: False)
    monkeypatch.setattr("app.notify.notify", lambda title, desp, **k: sent.append((title, desp)) or True)
    # Server酱通道发不了图:风控现场截图降级为 24h 签名直链拼进文本
    monkeypatch.setattr("app.notify.storage.signed_url",
                        lambda key, expires=1800, width=None: f"https://oss.example/{key}?e={expires}")

    db.add(Device(id="dev-b", name="浏览器号", token="t", hw_id="k1env777", kind="browser"))
    acc = Account(nick="嘻嘻小铺", device_id="dev-b", status=AccountStatus.ACTIVE)
    db.add(acc); db.flush()
    running = Task(task_type="goods_publish", account_id=acc.id, device_id="dev-b", status=TaskStatus.RUNNING)
    pending = Task(task_type="goods_publish", account_id=acc.id, status=TaskStatus.PENDING)
    db.add(running); db.add(pending); db.commit()

    runner._apply_result(db, running, {"ok": False, "risk": "完成认证才可继续发布", "failed_step": "publish",
                                       "reason": "完成认证才可继续发布", "shot": "oss-shots/risk.jpg",
                                       "done": []})

    db.refresh(acc); db.refresh(pending)
    assert acc.status == AccountStatus.FROZEN and acc.risk_state == RiskState.FROZEN
    assert pending.status == TaskStatus.CANCELLED
    [(title, desp)] = sent
    assert "人工" in title
    assert "嘻嘻小铺" in desp and "完成认证才可继续发布" in desp
    assert "k1env777" in desp, "要说清去哪个浏览器窗口处理"
    assert "解冻" in desp
    assert "https://oss.example/oss-shots/risk.jpg?e=86400" in desp, "风控通知要带上现场截图链接"


def test_unfreeze_payload_is_allowed_without_admin(db_session):
    """行情台/守护端的解冻会把风控一起清掉;没有管理员令牌也只放行这一种组合。"""
    from fastapi import HTTPException
    from starlette.requests import Request

    from app.api import update_account
    from app.models import Account
    from app.schemas import AccountUpdate

    db_session.add(Account(id="acc-r", nick="号R", status="FROZEN", risk_state="FROZEN",
                           risk_note="命中风控:完成认证才可继续发布"))
    db_session.commit()
    outside = Request({"type": "http", "client": ("127.0.0.1", 1), "method": "PATCH", "path": "/",
                       "query_string": b"", "headers": [(b"x-real-ip", b"127.0.0.1")]})
    sales = {"role": "SALES"}

    out = update_account("acc-r", AccountUpdate(status="ACTIVE", risk_state="NORMAL", risk_note=""),
                         request=outside, db=db_session, staff=sales)
    assert (out.status, out.risk_state, out.risk_note) == ("ACTIVE", "NORMAL", "")

    for sneaky in (dict(status="ACTIVE", risk_state="WARN"),
                   dict(status="ACTIVE", risk_note="随便写"),
                   dict(status="ACTIVE", nick="改名"),
                   dict(risk_state="NORMAL")):
        with pytest.raises(HTTPException) as denied:
            update_account("acc-r", AccountUpdate(**sneaky), request=outside, db=db_session, staff=sales)
        assert denied.value.status_code == 403, sneaky

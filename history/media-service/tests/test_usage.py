from app import library, usage
from app.config import get_settings
from app.models import AlertLog
from tests.conftest import login


def _publish(db, storage, video, item_id="wh-basic-01"):
    library.create_item(db, item_id, "第1课", audience="staff")
    v = library.add_version(db, storage, item_id, video)
    library.publish(db, item_id, v.version_no)
    return v


def _month():
    return usage.beijing_today().strftime("%Y-%m")


def test_plays_counted_once_per_viewer_per_day(client, db, storage, video):
    v = _publish(db, storage, video)
    login(client, staff_id="E001")
    for _ in range(3):  # 播放页续签地址
        assert client.get("/api/m/wh-basic-01/play").status_code == 200
    login(client, staff_id="E002")
    client.get("/api/m/wh-basic-01/play")

    u = usage.month_usage(db, storage, _month())
    assert (u.views, u.viewers) == (2, 2)
    assert u.egress_bytes == 2 * v.size
    assert u.storage_bytes == v.size
    assert u.by_item[0][:3] == ("wh-basic-01", "第1课", 2)
    assert any("2 人看了 2 次" in line for line in usage.report_lines(u, get_settings()))


class _Resp:
    status_code = 200
    headers = {"content-type": "application/json"}

    def __init__(self, errcode=0):
        self._errcode = errcode

    def json(self):
        return {"errcode": self._errcode, "errmsg": "ok" if not self._errcode else "keywords not in content"}


def test_alert_sent_once_per_month(client, db, storage, video, monkeypatch):
    _publish(db, storage, video)
    login(client)
    client.get("/api/m/wh-basic-01/play")
    sent = []
    monkeypatch.setattr(usage.httpx, "post", lambda url, **kw: sent.append((url, kw["json"])) or _Resp())

    monkeypatch.setenv("MEDIA_PRICE_EGRESS_PER_GB", "1000000")  # 让一次播放就超线
    monkeypatch.setenv("MEDIA_ALERT_WEBHOOK", "https://hooks.example.invalid/demo")
    monkeypatch.setenv("MEDIA_ALERT_WEBHOOK_SECRET", "SECxyz")
    for threshold, expect in (("0", "没开"), ("100000000", "没到")):
        monkeypatch.setenv("MEDIA_ALERT_MONTHLY_YUAN", threshold)
        get_settings.cache_clear()
        assert expect in usage.maybe_alert(db, usage.month_usage(db, None, _month()), get_settings())
    assert not sent

    monkeypatch.setenv("MEDIA_ALERT_MONTHLY_YUAN", "1")
    get_settings.cache_clear()
    s = get_settings()
    u = usage.month_usage(db, None, _month())
    assert "已发钉钉提醒" in usage.maybe_alert(db, u, s)
    assert "&timestamp=" in sent[0][0] and "&sign=" in sent[0][0]
    assert "费用提醒" in sent[0][1]["text"]["content"]
    assert "已经提醒过" in usage.maybe_alert(db, u, s) and len(sent) == 1


def test_alert_failure_not_marked_sent(client, db, storage, video, monkeypatch):
    _publish(db, storage, video)
    login(client)
    client.get("/api/m/wh-basic-01/play")
    monkeypatch.setattr(usage.httpx, "post", lambda url, **kw: _Resp(errcode=310000))
    monkeypatch.setenv("MEDIA_PRICE_EGRESS_PER_GB", "1000000")
    monkeypatch.setenv("MEDIA_ALERT_MONTHLY_YUAN", "1")
    monkeypatch.setenv("MEDIA_ALERT_WEBHOOK", "https://hooks.example.invalid/demo")
    get_settings.cache_clear()
    msg = usage.maybe_alert(db, usage.month_usage(db, None, _month()), get_settings())
    assert "没发出去" in msg and db.get(AlertLog, _month()) is None

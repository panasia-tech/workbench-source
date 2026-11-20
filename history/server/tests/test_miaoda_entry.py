"""员工工作台免登录进 H5（/auth/miaoda-entry、/auth/miaoda-confirm）。

# 为什么不能直接信工作台

工作台「我的 → ERP 账号绑定」妙搭时期是员工自己填 ERP 账号 ID，那边不校验。verify 回来的 erpUserId
只是"他说他是谁"——直接按它发登录令牌，谁在工作台填上管理员账号就能免密进 ERP。工作台搬出妙搭后，
它能担保的时候在 verify 里回 erpVerified=true（本人用 ERP 账号从统一登录登的、工作台 ID 就是 ERP 员工 ID）。

# 这里钉死的

  1. 同一个工作台账号第一次进来只拿到确认票据、没有登录令牌；输对一次这个 ERP 账号的密码才记
     绑定（miaoda_binding），之后才免登录；
  2. 工作台那边改绑成别的账号，要重新确认；
  3. 确认只收密码、账号取自票据，走普通登录同一套防暴力计数；
  4. 票据不能当登录令牌，登录令牌也不能当票据；
  5. token 作废 / 过期（工作台回 400）→ 401；没配 key、连不上 → 503，H5 照常走账号密码；
  6. verify 带 Bearer key、只发 token；
  7. 工作台担保了（erpVerified 是 JSON 的 true）而且工作台 ID 就是这个员工的 ID：直接登录、记一条绑定，
     不用输密码；没担保、没这个字段、ID 对不上、这个工作台 ID 已经确认绑在别的账号上：照旧要输密码；
  8. 担保了也挡不住的：账号不存在、设备账号、停用的。
"""

from datetime import datetime, timedelta

import httpx
import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from jose import jwt

from app.config import settings
from app.deps import create_access_token, get_current_user
from app.enums import StaffRole, StaffStatus
from app.models import MiaodaBinding, Staff
from app.routers.auth import miaoda_confirm, miaoda_entry
from app.schemas.auth import MiaodaConfirmRequest, MiaodaEntryRequest
from app.services import miaoda_entry as svc
from app.services.password import hash_password


def _staff(db, username="admin", role=StaffRole.ADMIN, password="DEMO_ONLY_REDACTED", status=StaffStatus.ACTIVE, staff_no=None):
    s = Staff(staff_no=staff_no or f"M-{username}", name="测试", username=username,
              password_hash=hash_password(password), role=role, status=status)
    db.add(s)
    db.commit()
    return s


@pytest.fixture()
def workbench(monkeypatch):
    """假的工作台 verify：登记过的 entry_token 换一次身份，用过即作废。"""
    issued = {}

    def fake_verify(entry_token):
        if entry_token not in issued:
            raise svc.EntryRejected("entry token 无效或已被使用")
        return svc.MiaodaUser(*issued.pop(entry_token))

    monkeypatch.setattr(svc, "verify", fake_verify)
    return issued


def _enter(db, workbench, erp_user_id="admin", miaoda_user_id="m1", token="t1", verified=False):
    workbench[token] = (miaoda_user_id, erp_user_id, verified)
    return miaoda_entry(MiaodaEntryRequest(entry_token=token), db)


def _confirm(db, ticket, password="DEMO_ONLY_REDACTED"):
    return miaoda_confirm(MiaodaConfirmRequest(ticket=ticket, password=password), db)


def test_第一次进来只给确认票据不给登录令牌(db_session, workbench):
    _staff(db_session)
    res = _enter(db_session, workbench)
    assert res.needs_confirm and res.ticket and res.username == "admin"
    assert res.token is None
    assert db_session.get(MiaodaBinding, "m1") is None


def test_输对密码才记绑定_之后免登录(db_session, workbench):
    admin = _staff(db_session)
    first = _enter(db_session, workbench)
    ok = _confirm(db_session, first.ticket)
    assert ok.token and ok.tabs and ok.landing_page
    assert db_session.get(MiaodaBinding, "m1").staff_id == admin.id

    again = _enter(db_session, workbench, token="t2")
    assert again.token and not again.needs_confirm
    assert again.landing_page in {t.pagePath for t in again.tabs}


def test_密码错不记绑定(db_session, workbench):
    _staff(db_session)
    first = _enter(db_session, workbench)
    with pytest.raises(HTTPException) as e:
        _confirm(db_session, first.ticket, password="DEMO_ONLY_REDACTED")
    assert e.value.status_code == 400
    assert db_session.get(MiaodaBinding, "m1") is None
    assert _enter(db_session, workbench, token="t2").needs_confirm


def test_工作台改绑别的账号要重新确认(db_session, workbench):
    _staff(db_session)
    other = _staff(db_session, username="zhangsan", role=StaffRole.SALES)
    _confirm(db_session, _enter(db_session, workbench).ticket)

    res = _enter(db_session, workbench, erp_user_id="zhangsan", token="t2")
    assert res.needs_confirm and res.username == "zhangsan" and res.token is None
    assert svc.read_ticket(res.ticket) == ("m1", other.id)


def test_工号和内部ID也认(db_session, workbench):
    s = _staff(db_session, username="zhang", role=StaffRole.SALES, staff_no="E009")
    assert _enter(db_session, workbench, erp_user_id="E009").username == "zhang"
    assert _enter(db_session, workbench, erp_user_id=s.id, token="t2").username == "zhang"


def test_绑定的账号不存在回401(db_session, workbench):
    with pytest.raises(HTTPException) as e:
        _enter(db_session, workbench, erp_user_id="nobody")
    assert e.value.status_code == 401


@pytest.mark.parametrize("role,status", [
    (StaffRole.CRAWLER, StaffStatus.ACTIVE),
    (StaffRole.ADMIN, StaffStatus.DISABLED),
])
def test_设备账号和停用账号进不来(db_session, workbench, role, status):
    _staff(db_session, role=role, status=status)
    with pytest.raises(HTTPException) as e:
        _enter(db_session, workbench)
    assert e.value.status_code == 403


def test_token作废回401带工作台给的原因(db_session, workbench):
    _staff(db_session)
    with pytest.raises(HTTPException) as e:
        miaoda_entry(MiaodaEntryRequest(entry_token="DEMO_ONLY_REDACTED"), db_session)
    assert e.value.status_code == 401
    assert "无效或已被使用" in e.value.detail


def test_工作台不通回503(db_session, monkeypatch):
    def down(entry_token):
        raise svc.EntryUnavailable("连不上工作台")

    monkeypatch.setattr(svc, "verify", down)
    with pytest.raises(HTTPException) as e:
        miaoda_entry(MiaodaEntryRequest(entry_token="t1"), db_session)
    assert e.value.status_code == 503


def test_票据不能当登录令牌(db_session, workbench):
    _staff(db_session)
    ticket = _enter(db_session, workbench).ticket
    with pytest.raises(HTTPException) as e:
        get_current_user(HTTPAuthorizationCredentials(scheme="Bearer", credentials=ticket), db_session)
    assert e.value.status_code == 401


def test_登录令牌和伪造过期的票据都不能确认(db_session, workbench):
    admin = _staff(db_session)
    expired = jwt.encode(
        {"typ": "miaoda_confirm", "mid": "m1", "sid": admin.id, "exp": datetime.utcnow() - timedelta(minutes=1)},
        settings.jwt_secret, algorithm="HS256",
    )
    for ticket in (create_access_token(admin.id, admin.role), "not-a-ticket", expired):
        with pytest.raises(HTTPException) as e:
            _confirm(db_session, ticket)
        assert e.value.status_code == 401
    assert db_session.get(MiaodaBinding, "m1") is None


# ---------------------------------------------------------------- 工作台担保（erpVerified）


def test_工作台担保了_工作台ID就是员工ID_直接登录记绑定(db_session, workbench):
    admin = _staff(db_session)
    res = _enter(db_session, workbench, erp_user_id=admin.id, miaoda_user_id=admin.id, verified=True)
    assert res.token and not res.needs_confirm and res.ticket is None
    assert res.landing_page in {t.pagePath for t in res.tabs}
    binding = db_session.get(MiaodaBinding, admin.id)
    assert binding.staff_id == admin.id and binding.last_entry_at is not None
    again = _enter(db_session, workbench, erp_user_id=admin.id, miaoda_user_id=admin.id, token="t2")
    assert again.token and not again.needs_confirm, "记下了，之后没担保也照样免登录"


def test_工作台担保了_但工作台ID不是这个员工_照旧要输密码(db_session, workbench):
    _staff(db_session)
    other = _staff(db_session, username="zhangsan", role=StaffRole.SALES)
    for mid in (other.id, "1871790158440555"):   # 别人的 ERP ID；妙搭时期那种数字 ID
        res = _enter(db_session, workbench, erp_user_id="admin", miaoda_user_id=mid, token=f"t-{mid}", verified=True)
        assert res.needs_confirm and res.token is None and res.username == "admin"
        assert db_session.get(MiaodaBinding, mid) is None


def test_工作台没担保_ID对得上也要输密码(db_session, workbench):
    admin = _staff(db_session)
    res = _enter(db_session, workbench, erp_user_id=admin.id, miaoda_user_id=admin.id, verified=False)
    assert res.needs_confirm and res.token is None
    assert db_session.get(MiaodaBinding, admin.id) is None


def test_verify没给erpVerified_走老路要输密码(db_session, monkeypatch, bridge_key):
    admin = _staff(db_session)
    _fake_post(monkeypatch, httpx.Response(200, json={
        "miaodaUserId": admin.id, "erpUserId": admin.id, "erpUsername": "测试"}))
    res = miaoda_entry(MiaodaEntryRequest(entry_token="t1"), db_session)
    assert res.needs_confirm and res.token is None
    assert db_session.get(MiaodaBinding, admin.id) is None


def test_工作台担保了_但这个工作台ID已确认绑在别的账号上_照旧要输密码(db_session, workbench):
    admin = _staff(db_session)
    other = _staff(db_session, username="zhangsan", role=StaffRole.SALES)
    db_session.add(MiaodaBinding(miaoda_user_id=admin.id, staff_id=other.id))
    db_session.commit()
    res = _enter(db_session, workbench, erp_user_id=admin.id, miaoda_user_id=admin.id, verified=True)
    assert res.needs_confirm and res.token is None and res.username == "admin"
    assert db_session.get(MiaodaBinding, admin.id).staff_id == other.id, "不悄悄改绑"


@pytest.mark.parametrize("role,status", [
    (StaffRole.CRAWLER, StaffStatus.ACTIVE),
    (StaffRole.ADMIN, StaffStatus.DISABLED),
])
def test_工作台担保了也挡住设备账号和停用账号(db_session, workbench, role, status):
    s = _staff(db_session, role=role, status=status)
    with pytest.raises(HTTPException) as e:
        _enter(db_session, workbench, erp_user_id=s.id, miaoda_user_id=s.id, verified=True)
    assert e.value.status_code == 403
    assert db_session.get(MiaodaBinding, s.id) is None


def test_工作台担保了_账号不存在回401(db_session, workbench):
    with pytest.raises(HTTPException) as e:
        _enter(db_session, workbench, erp_user_id="no-such-id", miaoda_user_id="no-such-id", verified=True)
    assert e.value.status_code == 401


# ---------------------------------------------------------------- verify 本身


@pytest.fixture()
def bridge_key(monkeypatch):
    monkeypatch.setattr(settings, "erp_bridge_api_key", "k-test")


def _fake_post(monkeypatch, response=None, error=None):
    calls = []

    def post(url, **kwargs):
        calls.append((url, kwargs))
        if error:
            raise error
        return response

    monkeypatch.setattr(svc.httpx, "post", post)
    return calls


def test_verify带key只发token(monkeypatch, bridge_key):
    calls = _fake_post(monkeypatch, httpx.Response(
        200, json={"miaodaUserId": "1871790158440555", "erpUserId": "zhangsan", "erpUsername": "张三"}))
    who = svc.verify("abc")
    assert who == svc.MiaodaUser(miaoda_user_id="1871790158440555", erp_user_id="zhangsan")
    url, kwargs = calls[0]
    assert url == settings.erp_bridge_verify_url
    assert kwargs["json"] == {"token": "abc"}
    assert kwargs["headers"] == {"Authorization": "Bearer k-test"}


@pytest.mark.parametrize("extra,expect", [
    ({}, False),
    ({"erpVerified": True}, True),
    ({"erpVerified": False}, False),
    ({"erpVerified": "true"}, False),
    ({"erpVerified": 1}, False),
    ({"erpVerified": None}, False),
])
def test_verify的erpVerified只认JSON的true(monkeypatch, bridge_key, extra, expect):
    _fake_post(monkeypatch, httpx.Response(200, json={"miaodaUserId": "u-1", "erpUserId": "u-1", **extra}))
    assert svc.verify("abc").erp_verified is expect


def test_verify数字ID也认(monkeypatch, bridge_key):
    _fake_post(monkeypatch, httpx.Response(200, json={"miaodaUserId": 1871790158440555, "erpUserId": "admin"}))
    assert svc.verify("abc").miaoda_user_id == "1871790158440555"


def test_verify回400带原因(monkeypatch, bridge_key):
    _fake_post(monkeypatch, httpx.Response(400, json={"error": {"message": "entry token 已过期，请从工作台重新进入"}}))
    with pytest.raises(svc.EntryRejected, match="已过期"):
        svc.verify("abc")


@pytest.mark.parametrize("response,error", [
    (httpx.Response(502, text="bad gateway"), None),
    (httpx.Response(200, json={"miaodaUserId": "1"}), None),
    (None, httpx.ConnectError("refused")),
])
def test_verify工作台出问题(monkeypatch, bridge_key, response, error):
    _fake_post(monkeypatch, response, error)
    with pytest.raises(svc.EntryUnavailable):
        svc.verify("abc")


def test_verify没配key不发请求(monkeypatch):
    monkeypatch.setattr(settings, "erp_bridge_api_key", "")
    calls = _fake_post(monkeypatch, httpx.Response(200, json={}))
    with pytest.raises(svc.EntryUnavailable):
        svc.verify("abc")
    assert calls == []

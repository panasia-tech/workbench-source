"""H5 钉钉工作台免登：code 换 userid → 按 staff.dingtalk_userid 发令牌；没关联 / 不能登 H5 / 没激活回 403，没配凭证 503。"""
import pytest
from fastapi import HTTPException

from app.enums import StaffRole, StaffStatus
from app.models import Staff
from app.routers import auth as R
from app.schemas.auth import DingtalkLoginRequest
from app.services import dingtalk


def _staff(db, username, role, userid, status=StaffStatus.ACTIVE):
    s = Staff(staff_no=username, username=username, name=username, role=role, status=status,
              password_hash="x", dingtalk_userid=userid)
    db.add(s)
    db.commit()
    return s


@pytest.fixture()
def ready(monkeypatch):
    monkeypatch.setattr(dingtalk, "h5_sso_ready", lambda: True)
    monkeypatch.setattr(dingtalk, "userinfo_by_auth_code", lambda code: {"userid": {"c1": "u1", "c2": "u2", "c3": "u3"}.get(code, "nobody")})


def test_linked_staff_gets_token(db_session, ready):
    s = _staff(db_session, "sales1", StaffRole.SALES, "u1")
    out = R.dingtalk_login(DingtalkLoginRequest(code="c1"), db_session)
    assert out.token and out.staff.id == s.id


def test_unlinked_inactive_or_device_role_is_403(db_session, ready):
    _staff(db_session, "pending", StaffRole.SALES, "u2", status=StaffStatus.PENDING)
    with pytest.raises(HTTPException) as e:
        R.dingtalk_login(DingtalkLoginRequest(code="nope"), db_session)
    assert e.value.status_code == 403 and "未关联" in e.value.detail
    with pytest.raises(HTTPException) as e:
        R.dingtalk_login(DingtalkLoginRequest(code="c2"), db_session)
    assert e.value.status_code == 403 and "未激活" in e.value.detail


def test_bad_code_is_401_and_not_configured_is_503(db_session, monkeypatch):
    monkeypatch.setattr(dingtalk, "h5_sso_ready", lambda: True)

    def boom(code):
        raise dingtalk.DingtalkError(40078, "不存在的临时授权码")
    monkeypatch.setattr(dingtalk, "userinfo_by_auth_code", boom)
    with pytest.raises(HTTPException) as e:
        R.dingtalk_login(DingtalkLoginRequest(code="x"), db_session)
    assert e.value.status_code == 401
    monkeypatch.setattr(dingtalk, "h5_sso_ready", lambda: False)
    with pytest.raises(HTTPException) as e:
        R.dingtalk_login(DingtalkLoginRequest(code="x"), db_session)
    assert e.value.status_code == 503
    assert R.dingtalk_config().enabled is False


def _poster(result):
    def poster(url, payload):
        if "accessToken" in url:
            return {"accessToken": "t", "expireIn": 7200}
        return {"errcode": 0, "result": result}
    return poster


def test_userinfo_by_auth_code_rejects_empty_and_missing_userid():
    with pytest.raises(dingtalk.DingtalkError):
        dingtalk.userinfo_by_auth_code("")
    with pytest.raises(dingtalk.DingtalkError):
        dingtalk.userinfo_by_auth_code("c", poster=_poster({}))
    assert dingtalk.userinfo_by_auth_code("c", poster=_poster({"userid": "u9"}))["userid"] == "u9"

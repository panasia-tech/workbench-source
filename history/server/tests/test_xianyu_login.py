"""咸鱼外卖助手（桌面端）的登录门（/auth/xianyu-login）。

# 为什么单开一条

巡航台是巡航台，这个应用是这个应用：现有的门放行名单都对不上——
  - /auth/workbench-login 只放销售/采购/管理员；
  - /auth/h5-login 少业务员，而且登录记录会算在 H5 头上，查不清是谁从哪进来的。

# 这里钉死的

  1. 放行的角色 = 全部真人员工（enums.HUMAN_ROLES），设备账号进不来；
  2. 返回 ERP 的登录令牌和员工信息（咸鱼外卖的服务端拿令牌去 /auth/me 验人）；
  3. /auth/xianyu-refresh 拿有效令牌换新令牌：7 天内用过就一直续，过期才要重新输密码。
"""

import pytest
from fastapi import HTTPException

from app.deps import decode_token
from app.enums import HUMAN_ROLES, StaffRole, StaffStatus
from app.models import Staff
from app.routers.auth import LOGIN_SURFACES, xianyu_login, xianyu_refresh
from app.schemas.auth import AdminLoginRequest
from app.services.password import hash_password


def _staff(db, role, username="u1", password="DEMO_ONLY_REDACTED"):
    s = Staff(staff_no=f"X-{username}", name="测试", username=username,
              password_hash=hash_password(password), role=role, status=StaffStatus.ACTIVE)
    db.add(s)
    db.commit()
    return s


def _login(db, username="u1", password="DEMO_ONLY_REDACTED"):
    return xianyu_login(AdminLoginRequest(username=username, password=password), db)


def test_放行的角色就是全部真人员工():
    assert set(LOGIN_SURFACES["xianyu"]) == set(HUMAN_ROLES)


@pytest.mark.parametrize("role", list(HUMAN_ROLES))
def test_员工都能登录(db_session, role):
    s = _staff(db_session, role)
    res = _login(db_session)
    assert res.token
    assert res.staff.id == s.id


@pytest.mark.parametrize("role", [StaffRole.CRAWLER, StaffRole.RFID_DEVICE])
def test_设备账号进不来(db_session, role):
    _staff(db_session, role)
    with pytest.raises(HTTPException) as e:
        _login(db_session)
    assert e.value.status_code == 403


def test_密码错误(db_session):
    _staff(db_session, StaffRole.SALES)
    with pytest.raises(HTTPException) as e:
        _login(db_session, password="DEMO_ONLY_REDACTED")
    assert e.value.status_code in (400, 401)


# ---- 续期：7 天内用过就续，令牌过期才要重新输密码 ----


def test_续期换新令牌(db_session):
    s = _staff(db_session, StaffRole.WAREHOUSE)
    res = xianyu_refresh(s)
    assert res.token
    assert decode_token(res.token)["sub"] == s.id
    assert res.staff.id == s.id


def test_设备账号不能续期(db_session):
    s = _staff(db_session, StaffRole.CRAWLER)
    with pytest.raises(HTTPException) as e:
        xianyu_refresh(s)
    assert e.value.status_code == 403

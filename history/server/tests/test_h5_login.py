"""H5 / PWA 版的登录门（/auth/h5-login）。

# 为什么单开一条

H5 就是小程序本身（h5/ 把 miniprogram/ 的源码直接编译成网页），只是没有微信：
不能 wx.login 换 openid，只能账号密码。现有的门都不合用——
  - /auth/bind 要微信 code，还会写 openid；
  - /auth/workbench-login 只放销售/采购/管理员，仓管、议价、财务进不来；
  - /auth/dev-login 不限角色，靠 allow_dev_login 把门，生产关着。

# 这里钉死的

  1. 放行的角色 = 小程序有 tab 可落地的角色（deps.ROLE_TAB_KEYS）。两张表对不上，
     要么有人登录成功却落不了地，要么有角色在小程序能用、H5 却进不来；
  2. 返回 tabs / landing_page，页面按它落地（和小程序登录同一个返回结构）；
  3. **不碰 openid**：同一个人小程序、H5 两边都在用，H5 这边登录不该改他的微信绑定。
"""

import pytest

from app.deps import ROLE_TAB_KEYS
from app.enums import StaffRole, StaffStatus
from app.models import Staff
from app.routers.auth import LOGIN_SURFACES, h5_login
from app.schemas.auth import AdminLoginRequest
from app.services.password import hash_password


def _staff(db, role, username="u1", password="DEMO_ONLY_REDACTED", openid=None):
    s = Staff(staff_no=f"H-{username}", name="测试", username=username,
              password_hash=hash_password(password), role=role,
              status=StaffStatus.ACTIVE, openid=openid)
    db.add(s)
    db.commit()
    return s


def _login(db, username="u1", password="DEMO_ONLY_REDACTED"):
    return h5_login(AdminLoginRequest(username=username, password=password), db)


def test_放行的角色就是小程序能落地的角色():
    assert set(LOGIN_SURFACES["h5"]) == set(ROLE_TAB_KEYS), (
        "H5 的门和小程序的 tab 表对不上：改了 deps.ROLE_TAB_KEYS 就同步 LOGIN_SURFACES['h5']"
    )


@pytest.mark.parametrize("role", list(LOGIN_SURFACES["h5"]))
def test_登录带落地页(db_session, role):
    _staff(db_session, role)
    res = _login(db_session)
    assert res.token
    assert res.tabs, "没有 tab 就落不了地，H5 会卡在登录页"
    assert res.landing_page in {t.pagePath for t in res.tabs}


def test_财务落在我的(db_session):
    _staff(db_session, StaffRole.FINANCE)
    assert _login(db_session).landing_page == "pages/profile/index"


def test_不碰微信绑定(db_session):
    s = _staff(db_session, StaffRole.WAREHOUSE, openid="wx-openid-1")
    _login(db_session)
    db_session.refresh(s)
    assert s.openid == "wx-openid-1"

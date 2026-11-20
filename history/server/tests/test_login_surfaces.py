"""登录入口的放行表：谁能从哪个门进来。

# 为什么有这张表

五个密码登录端点（admin / workbench / device / crawler / dev）曾经是五份几乎一样
的代码：查 Staff → 验密码 → 判角色 → 判状态 → 签令牌，只有角色白名单和报错话术
不同。复制到第五份时它已经不是「简单所以不用抽象」，而是「改一处容易漏另外四处」。

现在逻辑收成一个 `_password_login`，放行名单收成 `LOGIN_SURFACES`。端点本身保留
不动——小程序、后台、PDA、工作台、执行端各自写死了自己的地址，合并 URL 要一次
协调所有客户端发版，不值得。合的是后面那段逻辑。

# 这里钉死的

  1. 每个门只放它该放的角色，**而且相互之间不串**；
  2. 人走的门和无人值守执行端走的门必须分开——混了，「谁在操作」就永远查不清；
  3. 密码错和查无此人是同一句话（分开说等于送一个枚举用户名的接口）；
  4. 停用的账号哪个门都进不去；
  5. 开发登录不限角色，所以必须有 allow_dev_login 把门，生产关着。
"""

import pytest
from fastapi import HTTPException

from app.enums import StaffRole, StaffStatus
from app.models import Staff
from app.routers import auth
from app.routers.auth import LOGIN_SURFACES
from app.schemas.auth import AdminLoginRequest, DeviceLoginRequest
from app.services.password import hash_password

# 门 → 端点函数 + 入参类型
DOORS = {
    "admin": (auth.admin_login, AdminLoginRequest),
    "workbench": (auth.workbench_login, AdminLoginRequest),
    "h5": (auth.h5_login, AdminLoginRequest),
    "device": (auth.device_login, DeviceLoginRequest),
    "crawler": (auth.crawler_login, DeviceLoginRequest),
}

ALL_ROLES = [
    StaffRole.ADMIN, StaffRole.SALES, StaffRole.PURCHASER, StaffRole.WAREHOUSE,
    StaffRole.NEGOTIATOR, StaffRole.FINANCE, StaffRole.CRAWLER,
    StaffRole.MARKET_BOT, StaffRole.RFID_DEVICE,
]


def _staff(db, role, username="u1", password="DEMO_ONLY_REDACTED", status=StaffStatus.ACTIVE):
    s = Staff(staff_no=f"T-{username}", name="测试", username=username,
              password_hash=hash_password(password), role=role, status=status)
    db.add(s)
    db.commit()
    return s


def _enter(door, db, username="u1", password="DEMO_ONLY_REDACTED"):
    fn, schema = DOORS[door]
    return fn(schema(username=username, password=password), db)


@pytest.mark.parametrize("door", list(DOORS))
@pytest.mark.parametrize("role", ALL_ROLES)
def test_每个门只放它该放的角色(db_session, door, role):
    """把 9 个角色 × 每个门全部跑一遍：表里写了才进得去，没写就 403。

    逐个门写断言容易漏——漏掉的那格恰好是「某个角色意外能进某个门」。
    """
    _staff(db_session, role)
    allowed = LOGIN_SURFACES[door]
    if role in allowed:
        assert _enter(door, db_session).staff.role == role
    else:
        with pytest.raises(HTTPException) as exc:
            _enter(door, db_session)
        assert exc.value.status_code == 403


def test_人和无人值守执行端走不同的门():
    """混了的后果：审计上分不清是人干的还是机器干的。

    2026-09-13 之前整个工作台就是拿设备账号登的，于是所有操作都记在同一个
    机器账号头上，查不出是哪个人、哪台机器。
    """
    human = set(LOGIN_SURFACES["workbench"]) | set(LOGIN_SURFACES["h5"])
    machine = set(LOGIN_SURFACES["crawler"]) | set(LOGIN_SURFACES["device"])
    assert not (human & machine), f"人和机器的门串了：{human & machine}"


def test_管理员的门最小():
    assert LOGIN_SURFACES["admin"] == (StaffRole.ADMIN,)


def test_开发登录不限角色但要有开关():
    """它是唯一 allowed=None 的门。没有 allow_dev_login 把着，就是个后门。"""
    assert LOGIN_SURFACES["dev"] is None
    import inspect
    assert "allow_dev_login" in inspect.getsource(auth.dev_login)


@pytest.mark.parametrize("door", list(DOORS))
def test_密码错和查无此人是同一句话(db_session, door):
    """分开说等于送一个枚举用户名的接口。"""
    role = LOGIN_SURFACES[door][0]
    _staff(db_session, role)
    with pytest.raises(HTTPException) as wrong_pw:
        _enter(door, db_session, password="DEMO_ONLY_REDACTED")
    with pytest.raises(HTTPException) as no_user:
        _enter(door, db_session, username="nobody")
    assert wrong_pw.value.status_code == no_user.value.status_code == 400
    assert wrong_pw.value.detail == no_user.value.detail


@pytest.mark.parametrize("door", list(DOORS))
def test_停用的账号哪个门都进不去(db_session, door):
    _staff(db_session, LOGIN_SURFACES[door][0], status=StaffStatus.DISABLED)
    with pytest.raises(HTTPException) as exc:
        _enter(door, db_session)
    assert exc.value.status_code == 403
    assert "未激活" in exc.value.detail


def test_软删的账号进不去(db_session):
    """离职的人账号是软删的（deleted_at），不是真删——但门必须当他不存在。"""
    from datetime import datetime

    s = _staff(db_session, StaffRole.ADMIN)
    s.deleted_at = datetime.utcnow()
    db_session.commit()
    with pytest.raises(HTTPException) as exc:
        _enter("admin", db_session)
    assert exc.value.status_code == 400, "对外要表现成「账号或密码错误」，不能暴露这人存在过"

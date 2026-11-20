"""浏览器工作台的登录门（/auth/workbench-login）。

# 它为什么单开一条

工作台前面坐的是**人**。ERP 原有的两条登录路都不合用：
  - `/auth/admin-login` 只放行 ADMIN，那是后台管理的门；
  - `/auth/crawler-login` 只认设备账号，那是无人值守执行端的门。
工作台要的是第三种语义：员工账号 + 角色，角色决定登录后看见什么。

# 这里钉死的边界

  1. 销售 / 采购 / 管理员进得来，各自拿到自己的角色；
  2. 设备账号（CRAWLER / MARKET_BOT）**进不来** —— 它们有自己的门，混用会让
     "谁在操作"这件事永远查不清；
  3. 其余员工角色（仓管、议价、财务…）也进不来：工作台不是他们的工具；
  4. 停用的账号进不来；
  5. **服务端放行的角色，端上菜单表必须有** —— 这条是最要紧的一条，见下。

# 第 5 条为什么要在服务端测

登录成功但菜单为空 = 落地页算不出来 = 被弹回登录页。现场表现是"登录没反应"，
而服务端日志里是一次干净的 200，谁也查不出为什么（2026-09-13 真踩过，
当时是端上菜单表漏了 CRAWLER）。

两份表隔在两个仓库、两种语言里，靠人记住"改一处要同步另一处"是不可靠的。
所以这里直接去读端上那份 menu.js，把两边钉在一起：服务端放行了谁，那份表里就
必须有谁，且至少能看见一个页面。
"""

import re
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.enums import StaffRole, StaffStatus
from app.models import Staff
from app.routers.auth import LOGIN_SURFACES, workbench_login

WORKBENCH_ROLES = LOGIN_SURFACES["workbench"]
from app.schemas.auth import AdminLoginRequest
from app.services.password import hash_password

MENU_JS = (
    Path(__file__).resolve().parents[2]
    / "xianyu-seller-pilot/src/renderer/src/menu.js"
)


def _staff(db, role, username="u1", password="DEMO_ONLY_REDACTED", status=StaffStatus.ACTIVE):
    staff = Staff(
        staff_no=f"W-{username}",
        name="张三",
        username=username,
        password_hash=hash_password(password),
        role=role,
        status=status,
    )
    db.add(staff)
    db.commit()
    return staff


def _login(db, username="u1", password="DEMO_ONLY_REDACTED"):
    return workbench_login(AdminLoginRequest(username=username, password=password), db)


# --- 1. 三个角色进得来 --------------------------------------------------------
@pytest.mark.parametrize("role", [StaffRole.SALES, StaffRole.PURCHASER, StaffRole.ADMIN])
def test_销售采购管理员都能登(db_session, role):
    _staff(db_session, role)
    res = _login(db_session)
    assert res.token
    assert res.staff.role == role


# --- 2. 设备账号走它自己的门 --------------------------------------------------
@pytest.mark.parametrize("role", [StaffRole.CRAWLER, StaffRole.MARKET_BOT])
def test_设备账号进不来(db_session, role):
    _staff(db_session, role)
    with pytest.raises(HTTPException) as exc:
        _login(db_session)
    assert exc.value.status_code == 403, "设备账号该走 /auth/crawler-login，两条路不混"


# --- 3. 其余员工角色也进不来 --------------------------------------------------
@pytest.mark.parametrize("role", [StaffRole.WAREHOUSE, StaffRole.NEGOTIATOR, StaffRole.FINANCE])
def test_其余角色进不来(db_session, role):
    _staff(db_session, role)
    with pytest.raises(HTTPException) as exc:
        _login(db_session)
    assert exc.value.status_code == 403


# --- 4. 密码与账号状态 --------------------------------------------------------
def test_密码错(db_session):
    _staff(db_session, StaffRole.SALES)
    with pytest.raises(HTTPException) as exc:
        _login(db_session, password="DEMO_ONLY_REDACTED")
    assert exc.value.status_code == 400


def test_账号未激活(db_session):
    _staff(db_session, StaffRole.SALES, status=StaffStatus.DISABLED)
    with pytest.raises(HTTPException) as exc:
        _login(db_session)
    assert exc.value.status_code == 403


def test_查无此人(db_session):
    with pytest.raises(HTTPException) as exc:
        _login(db_session)
    assert exc.value.status_code == 400


# --- 5. 两份表必须对得上（本文件最要紧的一条）---------------------------------
def _menu_roles() -> set[str]:
    """把 menu.js 里所有出现过的角色名抠出来。

    只认 ROLES 那张表的键：它是"这个端认得的角色"的唯一声明，菜单项里的 roles
    数组只能从中取值。
    """
    src = MENU_JS.read_text(encoding="utf-8")
    block = re.search(r"export const ROLES = \{(.+?)\n\}", src, re.S)
    assert block, "menu.js 里找不到 ROLES 表，结构变了就改这里"
    return set(re.findall(r"^\s*([A-Z_]+):", block.group(1), re.M))


def _menu_visible_roles() -> set[str]:
    """至少出现在一个菜单项 roles 里的角色（roles 留空=所有人可见，单独处理）。"""
    src = MENU_JS.read_text(encoding="utf-8")
    if re.search(r"roles:\s*\[\s*\]", src):
        return _menu_roles()  # 有"所有人可见"的项，任何角色都至少看得到它
    return set(re.findall(r"'([A-Z_]+)'", src))


def test_放行的角色端上都认得():
    missing = {r.value if hasattr(r, "value") else str(r) for r in WORKBENCH_ROLES} - _menu_roles()
    assert not missing, (
        f"服务端放行了 {missing}，但 menu.js 的 ROLES 表里没有。"
        "后果不是报错，是登录成功后菜单为空、被弹回登录页——现场表现是「登录没反应」。"
    )


def test_放行的角色至少看得见一个页面():
    blind = {r.value if hasattr(r, "value") else str(r) for r in WORKBENCH_ROLES} - _menu_visible_roles()
    assert not blind, (
        f"{blind} 在 menu.js 里一个页面都进不去，落地页算不出来 → 登录即被弹回。"
    )

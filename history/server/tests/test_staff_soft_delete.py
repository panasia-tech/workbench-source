"""员工软删除：行保留 + 账号失效 + 用户名释放，且不再因历史业务单据被拦。

删除 API 原来是物理 db.delete(staff)，并因此必须拦住"有采购单/销售单/出库/调整单"的员工
（否则历史单据的 created_by_id / operator_id 外键悬空）。改软删后该拦截取消。
"""

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.enums import StaffRole, StaffStatus
from app.models import PurchaseOrder, Staff
from app.routers.staff import _ensure_editable_staff, delete_staff, list_staff

_TABLES = [Staff.__table__, PurchaseOrder.__table__]


@pytest.fixture()
def db():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine, tables=_TABLES)
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    try:
        yield session
    finally:
        session.close()


def _mk_staff(db, username="zhangsan", staff_no="E001", **kw):
    staff = Staff(
        staff_no=staff_no,
        username=username,
        password_hash="x",
        name="张三",
        role=StaffRole.PURCHASER,
        status=StaffStatus.ACTIVE,
        openid="wx-openid-1",
        **kw,
    )
    db.add(staff)
    db.commit()
    db.refresh(staff)
    return staff


def _admin(db):
    staff = Staff(
        staff_no="E999",
        username="admin",
        password_hash="x",
        name="管理员",
        role=StaffRole.ADMIN,
        status=StaffStatus.ACTIVE,
    )
    db.add(staff)
    db.commit()
    db.refresh(staff)
    return staff


def test_delete_staff_with_purchase_order_is_allowed_and_keeps_the_row(db):
    """核心回归：有历史采购单的员工现在可以删，且单据的制单人外键不悬空。"""
    admin = _admin(db)
    staff = _mk_staff(db)
    db.add(
        PurchaseOrder(
            order_no="PO001",
            status="PENDING",
            product_name="iPhone 15",
            unit_price=1000,
            created_by_id=staff.id,
        )
    )
    db.commit()

    delete_staff(staff.id, current=admin, db=db)

    order = db.query(PurchaseOrder).filter(PurchaseOrder.order_no == "PO001").one()
    assert order.created_by_id == staff.id  # 制单人未被置空
    assert db.get(Staff, staff.id) is not None  # 行还在，没被物理删除


def test_delete_staff_disables_account_and_frees_username(db):
    admin = _admin(db)
    staff = _mk_staff(db)
    staff_id = staff.id

    delete_staff(staff_id, current=admin, db=db)

    row = db.get(Staff, staff_id)
    assert row.deleted_at is not None
    assert row.status == StaffStatus.DISABLED  # 切断登录
    assert row.openid is None  # 微信可重新绑到别的账号
    assert row.username != "zhangsan"  # 用户名已释放
    assert row.username.startswith("zhangsan__del_")
    assert len(row.username) <= 64  # 不超 String(64)
    assert row.staff_no == "E001"  # 工号不释放，避免与历史单据重号


def test_freed_username_can_be_reused(db):
    admin = _admin(db)
    staff = _mk_staff(db)
    delete_staff(staff.id, current=admin, db=db)

    # 同名新员工可建（唯一约束不再被已删行占用）
    again = _mk_staff(db, username="zhangsan", staff_no="E002")
    assert again.id != staff.id
    assert db.query(Staff).filter(Staff.username == "zhangsan").count() == 1


def test_deleted_staff_hidden_from_list_and_not_editable(db):
    admin = _admin(db)
    staff = _mk_staff(db)
    delete_staff(staff.id, current=admin, db=db)

    listed = list_staff(page=1, size=10, sort_by="staff_no", sort_order="asc", _=admin, db=db)
    assert [s.id for s in listed.items] == [admin.id]
    assert listed.total == 1

    # 已删员工对外等同不存在：不能再改状态 / 改密 / 重复删除
    with pytest.raises(HTTPException) as exc:
        _ensure_editable_staff(db.get(Staff, staff.id), admin)
    assert exc.value.status_code == 404


def test_username_mangling_stays_unique_for_repeated_deletes(db):
    """同一用户名反复新建再删除，改写后的用户名不能互相撞（后缀取 staff.id）。"""
    admin = _admin(db)
    names = []
    for i in range(3):
        staff = _mk_staff(db, username="zhangsan", staff_no=f"E10{i}")
        delete_staff(staff.id, current=admin, db=db)
        names.append(db.get(Staff, staff.id).username)
    assert len(set(names)) == 3


def test_mangled_username_fits_column_at_max_length(db):
    """StaffCreate 不限长度，username 上限就是 DB 的 String(64)。
    改写规则 [:50] + '__del_'(6) + id[:8] 在满长用户名下正好 64，不会溢出。"""
    admin = _admin(db)
    staff = _mk_staff(db, username="u" * 64, staff_no="E500")

    delete_staff(staff.id, current=admin, db=db)

    assert len(db.get(Staff, staff.id).username) == 64

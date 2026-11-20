"""仓库 SPU 对照表接口：反查、唯一性、改挂、级联删除。

按仓库里现成的写法直接调用路由函数（不起 TestClient），只验业务分支。

自带 SQLite 夹具而不用 conftest 的 db_session，是为了打开 PRAGMA foreign_keys——
SPU 删除靠的是 warehouse_spu_sku 上的 ON DELETE CASCADE（模型侧 passive_deletes=True，
ORM 不会自己删子行），SQLite 默认不校验外键，不开这个开关就测不出真实的级联行为。
"""

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.enums import StaffRole, StaffStatus
from app.models import Staff, WarehouseSpu, WarehouseSpuSku
from app.routers.spu import (
    add_skus,
    create_spu,
    delete_spu,
    list_spus,
    lookup_by_sku,
    update_sku,
)
from app.schemas.spu import SpuCreate, SpuSkuAdd, SpuSkuUpdate


_TABLES = [Staff.__table__, WarehouseSpu.__table__, WarehouseSpuSku.__table__]


@pytest.fixture()
def db_session():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )

    @event.listens_for(engine, "connect")
    def _fk_on(dbapi_conn, _rec):
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine, tables=_TABLES)
    session = sessionmaker(bind=engine, autoflush=False, autocommit=False)()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def admin(db_session):
    staff = Staff(
        staff_no="E999", username="admin", password_hash="x", name="管理员",
        role=StaffRole.ADMIN, status=StaffStatus.ACTIVE,
    )
    db_session.add(staff)
    db_session.commit()
    return staff


def _mk(db, spu_code, brand, model, skus=()):
    return create_spu(
        SpuCreate(spu_code=spu_code, brand=brand, model=model, sku_codes=list(skus)),
        db=db, _=None,
    )


def test_新建SPU并挂SKU(db_session):
    out = _mk(db_session, "90000638", "小米", "空气净化器4PRO", ["18579673", "513211540140"])
    assert out.brand_model == "小米 空气净化器4PRO"
    assert out.sku_count == 2


def test_SPU编码重复被拒(db_session):
    _mk(db_session, "90000003", "戴森", "HT01")
    with pytest.raises(HTTPException) as exc:
        _mk(db_session, "90000003", "别的", "款")
    assert exc.value.status_code == 400


def test_按SKU编码反查(db_session):
    _mk(db_session, "90000638", "小米", "空气净化器4PRO", ["TMP-009"])
    got = lookup_by_sku(sku_code="tmp-009", db=db_session, _=None)  # 大小写不敏感
    assert got.matched and got.spu_code == "90000638"
    assert got.brand_model == "小米 空气净化器4PRO"


def test_反查不到不算错误(db_session):
    got = lookup_by_sku(sku_code="不存在的编码", db=db_session, _=None)
    assert got.matched is False and got.spu_code is None


def test_SKU编码带空格也能整串存取(db_session):
    """「SANC G7Pro Max」这类带空格的编码不能被切开。"""
    out = _mk(db_session, "90000430", "盛色", "G7", ["SANC G7Pro Max"])
    assert [s.sku_code for s in out.skus] == ["SANC G7Pro Max"]
    assert lookup_by_sku(sku_code="SANC G7Pro Max", db=db_session, _=None).matched


def test_SKU已挂别的SPU时拒绝而不是静默改挂(db_session):
    a = _mk(db_session, "90000614", "小米", "空气净化器3", ["69019809"])
    b = _mk(db_session, "90000645", "小米", "空气净化器5S")
    with pytest.raises(HTTPException) as exc:
        add_skus(b.id, SpuSkuAdd(sku_codes=["69019809"]), db=db_session, _=None)
    assert exc.value.status_code == 400 and "90000614" in exc.value.detail
    # 拒绝后 a 的对应不受影响（回滚不能把已有数据带走）
    assert len(db_session.get(WarehouseSpu, a.id).skus) == 1


def test_重复挂同一SPU是幂等的(db_session):
    a = _mk(db_session, "90000614", "小米", "空气净化器3", ["69019809"])
    with pytest.raises(HTTPException) as exc:
        add_skus(a.id, SpuSkuAdd(sku_codes=["69019809"]), db=db_session, _=None)
    assert exc.value.status_code == 400  # 没有新增
    assert db_session.query(WarehouseSpuSku).count() == 1


def test_改挂到别的SPU(db_session):
    a = _mk(db_session, "90000614", "小米", "空气净化器3", ["69019809"])
    b = _mk(db_session, "90000645", "小米", "空气净化器5S")
    row = db_session.query(WarehouseSpuSku).one()
    update_sku(row.id, SpuSkuUpdate(spu_id=b.id), db=db_session, _=None)
    assert db_session.query(WarehouseSpuSku).one().spu_id == b.id
    assert len(db_session.get(WarehouseSpu, a.id).skus) == 0


def test_改编码撞别的SPU的编码被拒(db_session):
    _mk(db_session, "90000614", "小米", "空气净化器3", ["69019809"])
    b = _mk(db_session, "90000645", "小米", "空气净化器5S", ["513211540141"])
    row = next(s for s in db_session.get(WarehouseSpu, b.id).skus)
    with pytest.raises(HTTPException) as exc:
        update_sku(row.id, SpuSkuUpdate(sku_code="69019809"), db=db_session, _=None)
    assert exc.value.status_code == 400


def test_删除SPU级联删除对应(db_session, admin):
    a = _mk(db_session, "90000638", "小米", "空气净化器4PRO", ["18579673", "513211540140"])
    delete_spu(a.id, db=db_session, _=admin)
    assert db_session.query(WarehouseSpu).count() == 0
    assert db_session.query(WarehouseSpuSku).count() == 0


def test_列表按SKU编码也能搜到所属SPU(db_session):
    _mk(db_session, "90000638", "小米", "空气净化器4PRO", ["TMP-009"])
    _mk(db_session, "90000003", "戴森", "HT01", ["513211549229"])
    page = list_spus(q="TMP-009", enabled=None, brand=None, unmapped=False,
                     page=1, page_size=50, db=db_session, _=None)
    assert page.total == 1 and page.items[0].spu_code == "90000638"


def test_只看没挂SKU的SPU(db_session):
    _mk(db_session, "90000638", "小米", "空气净化器4PRO", ["TMP-009"])
    _mk(db_session, "90000287", "雷神", "DQ27F240L")
    page = list_spus(q=None, enabled=None, brand=None, unmapped=True,
                     page=1, page_size=50, db=db_session, _=None)
    assert [i.spu_code for i in page.items] == ["90000287"]

"""4 位上架短编码:分配幂等 / 最小空闲号 / 出库回收复用。"""

from app.models import Sku
from app.services import short_code as sc


def _sku(db, code):
    s = Sku(sku_code=code, purchase_order_id="p1", inspection_id="i1",
            product_name="测试机", cost_price=100, status="IN_STOCK")
    db.add(s)
    db.flush()
    return s


def test_allocate_sequential_and_idempotent(db_session):
    db = db_session
    a, b = _sku(db, "M1"), _sku(db, "M2")
    assert sc.ensure_short_code(db, a) == "0001"
    assert sc.ensure_short_code(db, b) == "0002"
    assert sc.ensure_short_code(db, a) == "0001"  # 幂等:不重复分配


def test_release_reuses_smallest_free(db_session):
    db = db_session
    a, b, c = _sku(db, "M1"), _sku(db, "M2"), _sku(db, "M3")
    for s in (a, b, c):
        sc.ensure_short_code(db, s)
    assert (a.short_code, b.short_code, c.short_code) == ("0001", "0002", "0003")
    # 出库回收(语义= short_code 置空,见 routers/inventory._do_outbound)
    b.short_code = None
    db.flush()
    d = _sku(db, "M4")
    assert sc.ensure_short_code(db, d) == "0002"  # 回收的最小空闲号优先复用

"""69码更换:格式校验 / SPU 摘要 / 换码留痕(BARCODE_SET)。"""

import pytest
from fastapi import HTTPException

from app.enums import StockEventType
from app.models import Sku, Staff, StockEvent
from app.services import barcode as bc


def _sku(db, code, barcode=None, spu=None):
    s = Sku(sku_code=code, purchase_order_id="p1", inspection_id="i1",
            product_name="测试机", cost_price=100, status="IN_STOCK",
            barcode=barcode, spu=spu)
    db.add(s)
    db.flush()
    return s


def _user(db):
    u = Staff(staff_no="W001", username="wh1", password_hash="x", name="仓管甲",
              role="WAREHOUSE", status="ACTIVE")
    db.add(u)
    db.flush()
    return u


def test_normalize_barcode():
    assert bc.normalize_barcode(" 6901234567892 ") == "6901234567892"
    assert bc.normalize_barcode("") is None
    assert bc.normalize_barcode(None) is None
    with pytest.raises(HTTPException):
        bc.normalize_barcode("69012A")       # 非数字
    with pytest.raises(HTTPException):
        bc.normalize_barcode("690123")       # 位数不对


def test_barcode_status_and_spu_text():
    assert bc.barcode_status(None) == "PENDING"
    assert bc.barcode_status("  ") == "PENDING"
    assert bc.barcode_status("6901234567892") == "DONE"
    assert bc.spu_text(None) is None
    assert bc.spu_text({"ItemName": "耳机", "BrandName": "索尼", "ItemSpecification": "黑"}) == "耳机 索尼 黑"
    assert bc.spu_text({"ItemName": "耳机"}) == "耳机"
    assert bc.spu_text({}) is None


def test_apply_sku_barcode_writes_event_and_spu(db_session, monkeypatch):
    db, user = db_session, _user(db_session)
    monkeypatch.setattr(bc, "query_barcode", lambda code: {"status": "200", "ItemName": "耳机"})
    sku = _sku(db, "M1")

    event = bc.apply_sku_barcode(db, user, sku, barcode="6901234567892",
                                 source=bc.BARCODE_MIGRATION_SOURCE, commit=False)
    assert sku.barcode == "6901234567892"
    assert sku.spu["ItemName"] == "耳机"
    assert event.event_type == StockEventType.BARCODE_SET
    assert event.payload["old"] is None and event.payload["new"] == "6901234567892"
    assert bc.barcode_source_label(event.payload) == "小程序69码更换"


def test_apply_sku_barcode_replace_clears_old_spu(db_session, monkeypatch):
    db, user = db_session, _user(db_session)
    # 换码后条码库查不到:不阻断保存,spu 留空,详情页可手动重试
    monkeypatch.setattr(bc, "query_barcode",
                        lambda code: (_ for _ in ()).throw(HTTPException(status_code=404, detail="没查到")))
    sku = _sku(db, "M1", barcode="6901234567892", spu={"ItemName": "旧货"})

    event = bc.apply_sku_barcode(db, user, sku, barcode="6907654321098", commit=False)
    assert sku.barcode == "6907654321098"
    assert sku.spu is None
    assert event.payload["old"] == "6901234567892"
    assert event.payload["spu_found"] is False


def test_apply_sku_barcode_noop_when_same(db_session, monkeypatch):
    db, user = db_session, _user(db_session)
    monkeypatch.setattr(bc, "query_barcode", lambda code: {"ItemName": "耳机"})
    sku = _sku(db, "M1", barcode="6901234567892", spu={"ItemName": "耳机"})

    assert bc.apply_sku_barcode(db, user, sku, barcode=" 6901234567892 ", commit=False) is None
    assert sku.spu == {"ItemName": "耳机"}  # 未被清空重查
    assert db.query(StockEvent).count() == 0


def test_apply_sku_barcode_reuses_passed_spu(db_session, monkeypatch):
    """详情页 barcode-lookup 已查过一次,不再重复打付费接口。"""
    db, user = db_session, _user(db_session)
    calls = []
    monkeypatch.setattr(bc, "query_barcode", lambda code: calls.append(code) or {"ItemName": "不该被调用"})
    sku = _sku(db, "M1")

    bc.apply_sku_barcode(db, user, sku, barcode="6901234567892",
                         source="BARCODE_LOOKUP", commit=False, spu={"ItemName": "耳机"})
    assert calls == []
    assert sku.spu == {"ItemName": "耳机"}


# ---------------- 接口层：待更换/已更换分流 + 单件更换 ----------------


def _list(db, user, **kw):
    from app.routers.inventory import list_barcode_migration_items
    kw.setdefault("tab", "pending")
    kw.setdefault("q", None)
    kw.setdefault("page", 1)
    kw.setdefault("size", 20)
    return list_barcode_migration_items(db=db, user=user, **kw)


def test_list_splits_into_three_exclusive_buckets(db_session):
    db, user = db_session, _user(db_session)
    _sku(db, "M1")                                   # 无码 → 待更换
    _sku(db, "M2", barcode="")                       # 空串同样算待更换
    _sku(db, "M3", barcode="6901234567892", spu={"ItemName": "耳机", "BrandName": "索尼"})
    _sku(db, "M5", barcode="6907654321098")          # 有码但条码库没查到 → 未查到
    shipped = _sku(db, "M4")                         # 已发货不在范围内
    shipped.status = "SHIPPED"
    db.flush()

    pending = _list(db, user, tab="pending")
    assert {i.sku_code for i in pending.items} == {"M1", "M2"}
    assert pending.total == 2
    assert all(i.migration_status == "PENDING" and i.can_migrate for i in pending.items)

    done = _list(db, user, tab="done")
    assert [i.sku_code for i in done.items] == ["M3"]
    assert done.items[0].spu_text == "耳机 索尼"

    missing = _list(db, user, tab="missing")
    assert [i.sku_code for i in missing.items] == ["M5"]
    assert missing.items[0].spu_text is None
    assert missing.items[0].migration_status == "DONE"  # 码已录，只是没查到

    # 三桶互斥且覆盖全部在库
    assert pending.total + done.total + missing.total == 4


def test_list_rejects_bad_tab(db_session):
    with pytest.raises(HTTPException) as exc:
        _list(db_session, _user(db_session), tab="all")
    assert exc.value.status_code == 400


def test_list_search_matches_barcode(db_session):
    db, user = db_session, _user(db_session)
    _sku(db, "M1", barcode="6901234567892", spu={"ItemName": "耳机"})
    _sku(db, "M2", barcode="6907654321098", spu={"ItemName": "键盘"})
    res = _list(db, user, tab="done", q="690123")
    assert [i.sku_code for i in res.items] == ["M1"]


def test_recode_endpoint_writes_barcode_and_history(db_session, monkeypatch):
    from app.routers.inventory import barcode_migration_recode
    from app.schemas.inventory import BarcodeMigrationIn

    db, user = db_session, _user(db_session)
    monkeypatch.setattr(bc, "query_barcode", lambda code: {"ItemName": "耳机"})
    _sku(db, "M1")

    out = barcode_migration_recode(
        BarcodeMigrationIn(sku_code="m1", barcode="6901234567892"), db=db, user=user
    )
    assert out.barcode == "6901234567892"
    assert out.migration_status == "DONE"
    assert out.spu_text == "耳机"
    assert out.last_barcode_operator_name == "仓管甲"
    assert out.last_barcode_source == "小程序69码更换"
    assert out.last_barcode_old is None


def test_recode_endpoint_guards(db_session, monkeypatch):
    from app.routers.inventory import barcode_migration_recode
    from app.schemas.inventory import BarcodeMigrationIn

    db, user = db_session, _user(db_session)
    monkeypatch.setattr(bc, "query_barcode", lambda code: {"ItemName": "耳机"})
    shipped = _sku(db, "M9")
    shipped.status = "SHIPPED"
    db.flush()

    with pytest.raises(HTTPException) as exc:  # 货号不存在
        barcode_migration_recode(
            BarcodeMigrationIn(sku_code="NOPE", barcode="6901234567892"), db=db, user=user
        )
    assert exc.value.status_code == 404

    with pytest.raises(HTTPException) as exc:  # 不在库
        barcode_migration_recode(
            BarcodeMigrationIn(sku_code="M9", barcode="6901234567892"), db=db, user=user
        )
    assert exc.value.status_code == 400

    with pytest.raises(HTTPException) as exc:  # 位数不对
        barcode_migration_recode(
            BarcodeMigrationIn(sku_code="M9", barcode="690"), db=db, user=user
        )
    assert exc.value.status_code == 400


def test_cleared_spu_persists_as_sql_null(db_session, monkeypatch):
    """换码失败清空 spu 后必须落 SQL NULL，否则会从「未查到」Tab 里漏掉。

    JSON 列默认 none_as_null=False，赋 None 会存成 JSON 字面量 'null'（IS NULL 为假）。
    """
    from sqlalchemy import text

    db, user = db_session, _user(db_session)
    monkeypatch.setattr(bc, "query_barcode",
                        lambda code: (_ for _ in ()).throw(HTTPException(status_code=404, detail="没查到")))
    sku = _sku(db, "M1", barcode="6901234567892", spu={"ItemName": "旧货"})
    bc.apply_sku_barcode(db, user, sku, barcode="6907654321098", commit=False)
    db.flush()

    raw, is_null = db.execute(text("SELECT spu, spu IS NULL FROM sku WHERE sku_code='M1'")).one()
    assert raw is None and is_null, f"spu 落库成了 {raw!r}，应为 SQL NULL"

    missing = _list(db, user, tab="missing")
    assert [i.sku_code for i in missing.items] == ["M1"]

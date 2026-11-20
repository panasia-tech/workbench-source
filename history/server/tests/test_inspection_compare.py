"""采购工作台 W11：验货时卖家原话和实物对照、分栏、已披露、原因待判、差异工单带上检查项（禅道 #57）。"""
from datetime import datetime

import pytest
from fastapi import HTTPException

from app.models import InspectionCheckItem, InspectionException
from app.routers import inspection_ops as router
from app.schemas.inspection_ops import CheckItemUpdate
from app.services import inspection_compare as cmp
from app.services import inspection_ops as ops
from app.services import purchase_snapshot as snap
from tests.test_inspection_ops import _start, db, world  # noqa: F401 —— 共用夹具


def _fail(db, w, key, **kw):
    return router.update_check_item(w.task.id, key, CheckItemUpdate(result="FAIL", note="有问题", evidence=["https://x/a.jpg"], **kw),
                                    db, w.keeper)


def test_检查项分栏_对照下单时那版快照_全新提醒(db, world):
    snap.create_version(db, purchase_order_id=world.order.id, user_id=world.buyer.id, title="戴尔 U2720Q 几乎全新",
                        declared_model="U2720Q", specs="27寸 4K", condition_text="无划痕", accessories_text="原装支架、电源线",
                        freeze=True)
    db.commit()
    _start(db, world)
    view = router.read_check(world.task.id, db, world.keeper)
    dims = {i["item_key"]: i["dimension"] for i in view["items"]}
    assert dims["package"] == "packaging" and dims["identity"] == "identity" and dims["accessories"] == "accessory"
    assert dims["appearance"] == "appearance" and "function" in dims.values()
    c = view["compare"]
    assert c["snapshot"]["declared_model"] == "U2720Q"
    assert c["claims"]["accessory"] == "原装支架、电源线" and c["claims"]["appearance"] == "无划痕"
    assert c["risks"] == ["卖家写了「几乎全新」：按原文和实物逐项细查，不自动打折"]
    assert [g["label"] for g in c["groups"]][:2] == ["型号", "外观"]


def test_已披露不算新问题_原因默认待判_改通过就清掉(db, world):
    _start(db, world)
    out = _fail(db, world, "appearance", defect_part="右下角划痕", seller_claim="右下角有划痕", disclosed=True)
    assert out["disclosed"] and out["cause"] == "unknown" and out["cause_label"] == "待判（原因不明）"
    _fail(db, world, "accessories", defect_part="缺电源线")
    c = router.read_check(world.task.id, db, world.keeper)["compare"]
    assert c["new_problems"] == ["accessories"] and c["pending_cause"] == ["accessories"]
    with pytest.raises(HTTPException, match="原因只能"):
        _fail(db, world, "accessories", cause="随便")
    out = router.update_check_item(world.task.id, "appearance", CheckItemUpdate(result="PASS", evidence=["https://x/a.jpg"]),
                                   db, world.keeper)
    assert not out["disclosed"] and out["cause"] is None


def test_差异工单带上检查项和快照_说过的和通过的不让进(db, world):
    s = snap.create_version(db, purchase_order_id=world.order.id, user_id=world.buyer.id, title="戴尔", freeze=True)
    db.commit()
    _start(db, world)
    _fail(db, world, "appearance", defect_part="屏幕边框磕碰", seller_claim="无磕碰", cause="seller")
    _fail(db, world, "accessories", defect_part="缺支架", disclosed=True)
    with pytest.raises(HTTPException, match="原来说过"):
        router.raise_from_items(world.task.id, router.FromItemsIn(item_keys=["accessories"]), db, world.keeper)
    with pytest.raises(HTTPException, match="不是不通过"):
        router.raise_from_items(world.task.id, router.FromItemsIn(item_keys=["package"]), db, world.keeper)
    out = router.raise_from_items(world.task.id, router.FromItemsIn(item_keys=["appearance"]), db, world.keeper)
    assert out["check_item_keys"] == ["appearance"] and out["snapshot_id"] == s.id
    assert router.read_check(world.task.id, db, world.keeper)["compare"]["new_problems"] == [], "进了工单的不再提示建"
    exc = db.query(InspectionException).one()
    assert exc.exception_type == "MISMATCH" and "【外观】" in exc.description and "卖家说：无磕碰" in exc.description
    # 再加一项：追加到同一张没结的工单上
    _fail(db, world, "identity", defect_part="铭牌被撕", cause="transport")
    router.raise_from_items(world.task.id, router.FromItemsIn(item_keys=["identity"]), db, world.keeper)
    db.refresh(exc)
    assert db.query(InspectionException).count() == 1 and exc.check_item_keys == ["appearance", "identity"]


def test_只有下单后补抓的快照_对照它并提醒卖家可能改过(db, world):
    from app.models import PurchasePlatformOrder

    row = PurchasePlatformOrder(buyer_account="海蜘蛛", platform_order_no="O1")
    db.add(row)
    db.flush()
    world.order.platform_order_id = row.id
    snap.create_version(db, purchase_order_id=None, platform_order_id=row.id, user_id=None, title="第一次抓", capture_kind="late",
                        captured_at=datetime(2026, 11, 15, 3))
    snap.create_version(db, purchase_order_id=None, platform_order_id=row.id, user_id=None, title="卖家后来改的",
                        capture_kind="late", captured_at=datetime(2026, 11, 16, 3))
    db.commit()
    s = cmp.pick_snapshot(db, world.order)
    assert s.title == "第一次抓"
    assert "下单后补抓" in cmp.risks(world.order, s)[-1]

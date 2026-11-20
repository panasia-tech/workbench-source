"""采购工作台 W12：先在平台申请退货退款，等卖家主动提留货（禅道 #58 的验收用例）。"""
from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException

from app.models import InspectionException
from app.routers import inspection_ops as router
from app.schemas.inspection_ops import ExceptionIn
from app.services import purchase_aftersale as aftersale
from tests.test_inspection_ops import db, world  # noqa: F401 —— 共用夹具


def _exc(db, w):
    out = router.raise_exception(w.task.id, ExceptionIn(exception_type="MISMATCH", description="屏幕有亮点，卖家没说"), db, w.keeper)
    return out["id"]


def _as(db, w, eid, **kw):
    return router.update_aftersale(eid, router.AftersaleIn(**kw), db, w.buyer)


def test_没回执不能标已提交_期限要说来源(db, world):
    eid = _exc(db, world)
    out = _as(db, world, eid, status="preparing")
    assert out["aftersale_label"] == "准备材料"
    with pytest.raises(HTTPException, match="回执"):
        _as(db, world, eid, status="submitted")
    with pytest.raises(HTTPException, match="平台页面上写的还是自己估的"):
        _as(db, world, eid, deadline="2026-11-20T20:00")
    out = _as(db, world, eid, status="submitted", receipt=["https://x/r.jpg"], deadline="2026-11-20T20:00", deadline_source="estimate")
    assert out["aftersale_status"] == "submitted" and out["aftersale_deadline"].startswith("2026-11-20T20:00")
    assert any("自己估的" in h for h in out["aftersale_hints"])
    exc = db.get(InspectionException, eid)
    assert exc.aftersale_deadline == datetime(2026, 11, 20, 12, 0), "北京时间存成 UTC"
    with pytest.raises(HTTPException, match="为什么"):
        _as(db, world, eid, status="withdrawn")


def test_快到期限卖家没提留货提示PlanB_卖家提了就不提示_记谁先提的(db, world):
    eid = _exc(db, world)
    exc = db.get(InspectionException, eid)
    _as(db, world, eid, status="submitted", receipt=["https://x/r.jpg"])
    exc.aftersale_deadline, exc.deadline_source = datetime.utcnow() + timedelta(hours=10), "platform"
    db.commit()
    assert any("Plan B" in h for h in aftersale.hints(exc))
    with pytest.raises(HTTPException, match="原话"):
        router.add_keep_offer(eid, router.OfferIn(by="seller", text=" "), db, world.buyer)
    out = router.add_keep_offer(eid, router.OfferIn(by="seller", text="别退了，补你 80 吧", amount="80"), db, world.buyer)
    assert out["first_offer_by"] == "seller" and out["keep_offers"][0]["amount"] == "80.00" and out["keep_offers"][0]["first"]
    stored = datetime.fromisoformat(db.get(InspectionException, eid).keep_offers[0]["at"])
    assert out["keep_offers"][0]["at"] == (stored + timedelta(hours=8)).isoformat(), "存 UTC，给人看北京时间"
    assert not any("Plan B" in h for h in out["aftersale_hints"])
    router.add_keep_offer(eid, router.OfferIn(by="us", text="补 120 就留"), db, world.buyer)
    assert [o["by"] for o in db.get(InspectionException, eid).keep_offers] == ["seller", "us"]


def test_平台介入没结果不能结案_撤销不等于留货成交(db, world):
    eid = _exc(db, world)
    exc = db.get(InspectionException, eid)
    _as(db, world, eid, status="submitted", receipt=["https://x/r.jpg"])
    _as(db, world, eid, status="disputed", note="卖家不认，平台介入")
    assert "平台介入还没结果，不能结束" in router.close_blockers(db, exc)
    _as(db, world, eid, status="withdrawn", note="卖家同意补差，撤销申请")
    assert any("不等于留货谈成" in h for h in aftersale.hints(exc))
    assert "平台介入还没结果，不能结束" not in router.close_blockers(db, exc)
    assert "退款还没有结果，不能结束" in router.close_blockers(db, exc), "钱和货两头都要结（原有规则）"


def test_H5验货凭证页_只有能改的人看到售后表单(db, world):
    eid = _exc(db, world)
    mine = router.order_inspection("PO1", db, world.buyer)["exceptions"]
    assert [(e["id"], e["can_edit"]) for e in mine] == [(eid, True)], "采购员改自己单子的售后"
    assert [e["can_edit"] for e in router.order_inspection("PO1", db, world.seller)["exceptions"]] == [False], "销售只能看"
    with pytest.raises(HTTPException):
        router.update_aftersale(eid, router.AftersaleIn(status="preparing"), db, world.seller)

"""练习门禁（11-13）：开关开着时销售没做完三步练习，上架、审批、发货都被拦；管理员不拦；按顺序、服务端判对错。"""
import pytest
from fastapi import HTTPException

from app.enums import StaffRole, StaffStatus
from app.models import Staff
from app.routers import practice as R
from app.services import practice as P
from app.services.app_settings import set_setting


def _staff(db, name, role):
    row = Staff(staff_no=name, username=name, name=name, role=role, status=StaffStatus.ACTIVE, password_hash="x")
    db.add(row)
    db.flush()
    return row


@pytest.fixture()
def w(db_session):
    class W:
        pass

    x = W()
    x.db = db_session
    x.sales = _staff(db_session, "销售", StaffRole.SALES)
    x.wh = _staff(db_session, "仓管", StaffRole.WAREHOUSE)
    x.boss = _staff(db_session, "老板", StaffRole.ADMIN)
    db_session.commit()
    return x


def _on(w, on=True):
    set_setting(w.db, P.REQUIRED_KEY, "1" if on else "", None)
    w.db.commit()


def test_switch_off_nobody_gated(w):
    P.gate(w.db, w.sales)
    assert R.my_practice(w.db, w.sales)["gated"] is False


def test_switch_on_gates_only_unfinished_sales(w):
    _on(w)
    with pytest.raises(HTTPException) as e:
        P.gate(w.db, w.sales)
    assert e.value.status_code == 403 and "还差 3 步" in e.value.detail
    P.gate(w.db, w.wh)
    P.gate(w.db, w.boss)


def test_steps_in_order_and_checked_by_server(w):
    _on(w)
    with pytest.raises(HTTPException, match="先做完上一步"):
        R.submit_step(2, {"choice": 0}, w.db, w.sales)
    with pytest.raises(HTTPException, match="至少选 1 张"):
        R.submit_step(1, {"price": 3000}, w.db, w.sales)
    with pytest.raises(HTTPException, match="低于最低价 2860"):
        R.submit_step(1, {"price": 2500, "images": ["正面"]}, w.db, w.sales)
    out = R.submit_step(1, {"price": 2500, "images": ["正面"], "reason": "屏幕有划痕"}, w.db, w.sales)
    assert out["left"] == 2
    with pytest.raises(HTTPException, match="只有批过的号"):
        R.submit_step(2, {"choice": 1}, w.db, w.sales)
    R.submit_step(2, {"choice": 0}, w.db, w.sales)
    with pytest.raises(HTTPException, match="货号对不上"):
        R.submit_step(3, {"code": "PRACTICE-IP12", "tracking_no": "SF1234567890"}, w.db, w.sales)
    with pytest.raises(HTTPException, match="运单号"):
        R.submit_step(3, {"code": "practice-ip13", "tracking_no": "SF1"}, w.db, w.sales)
    out = R.submit_step(3, {"code": "practice-ip13", "tracking_no": "SF1234567890"}, w.db, w.sales)
    assert out["left"] == 0 and out["gated"] is False
    P.gate(w.db, w.sales)


def test_admin_sees_progress_and_toggles(w):
    out = R.write_setting(R.SettingIn(required=True), w.db, w.boss)
    assert out["required"] is True
    assert [(s["name"], s["done"]) for s in out["staff"]] == [("销售", 0)]
    R.submit_step(1, {"price": 3000, "images": ["正面"]}, w.db, w.sales)
    assert R.progress(w.db, w.boss)["staff"][0]["done"] == 1


def test_gate_blocks_real_endpoints(w):
    """真接口上的拦截：审批提交、手动成交都先过练习门禁。"""
    from app.routers import listing_approval as LA
    from app.routers import sales as S

    _on(w)
    with pytest.raises(HTTPException) as e:
        LA.submit("SK1", LA.ShopIdsIn(shop_ids=["x"]), w.db, w.sales)
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        S.manual_deal(S.ManualDealRequest.model_construct(sku_code="SK1"), w.db, w.sales)
    assert e.value.status_code == 403

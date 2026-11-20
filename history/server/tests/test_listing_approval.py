"""上架审批（11-03 老板定 D5/D6）。

钉死的口径：
  1. 开关关着一切照旧；开了以后只发批过的价和图，一个号一个作业，不回落商品原图。
  2. 售价不能低于 成本 × 比例（按实际挂出去的整数元），没成本不能提交。
  3. 每个号首图不同、整组不同；提交人不能自己批。
  4. 批完成本变了、比例调高了、退货回仓了，旧批准不能接着用。
  5. 焕新不等审批（11-10）：没批过的照原来的图重发；当初按批过的内容发的，照那份重发。
"""
import asyncio
from decimal import Decimal

import pytest
from fastapi import HTTPException

import app.services.gc_bridge.assembler as ASM
import app.services.gc_bridge.listing_ops as L
from app.enums import ListingInfoStatus, ShopListingStatus, SkuStatus, StaffRole, StaffStatus
from app.models import SaleShop, Sku, SkuListingInfo, SkuShopListing, Staff
from app.routers import listing_approval as R
from app.services import listing_approval as la
from app.services import shop_images as SI
from app.services.app_settings import set_setting
from app.services.gc_bridge import listing_refresh as LR


@pytest.fixture(autouse=True)
def _no_oss(monkeypatch):
    monkeypatch.setattr(ASM, "sign_oss_publish_image_url", lambda obj, expires=86400: obj)
    monkeypatch.setattr("app.services.oss_media.sign_oss_publish_image_url", lambda obj, expires=86400: obj)
    monkeypatch.setattr(LR, "sign_oss_publish_image_url", lambda obj, expires=86400: obj)
    monkeypatch.setattr(R, "sign_oss_url", lambda u, expires=86400: u)
    monkeypatch.setattr(R, "sign_oss_thumb_url", lambda u, size="small", expires=86400: u and f"thumb:{u}")
    monkeypatch.setattr(SI, "sign_oss_thumb_url", lambda u, size="small", expires=86400: u and f"thumb:{u}")
    monkeypatch.setattr(SI, "sign_oss_publish_image_url", lambda u, expires=86400: u)
    monkeypatch.setattr(la, "market_of", lambda db, sku: {"price": Decimal("1500"), "basis": "成交均价",
                                                          "date": None, "query": "x"})


def _staff(db, name, role):
    row = Staff(staff_no=name, username=name, name=name, role=role, status=StaffStatus.ACTIVE, password_hash="x")
    db.add(row)
    db.flush()
    return row


@pytest.fixture()
def w(db_session):
    db = db_session
    sku = Sku(sku_code="SK1", product_name="显示器", purchase_order_id="po1", inspection_id="in1",
              cost_price=Decimal("1000"), status=SkuStatus.IN_STOCK,
              images=["oss/a.jpg", "oss/b.jpg", "oss/c.jpg"])
    s1 = SaleShop(code="s1", label="店1", xianyu_user_name="甲", enabled=True, sort_order=0, gc_account_id="acc1")
    s2 = SaleShop(code="s2", label="店2", xianyu_user_name="乙", enabled=True, sort_order=1, gc_account_id="acc2")
    db.add_all([sku, s1, s2])
    db.flush()
    info = SkuListingInfo(sku_id=sku.id, images=["oss/a.jpg"], price=Decimal("1100"), status=ListingInfoStatus.READY)
    db.add(info)
    clerk = _staff(db, "员工", StaffRole.SALES)
    boss = _staff(db, "老板", StaffRole.ADMIN)
    db.commit()

    class W:
        pass

    x = W()
    x.db, x.sku, x.s1, x.s2, x.info, x.clerk, x.boss = db, sku, s1, s2, info, clerk, boss
    return x


def _approve(w, shop, price, images):
    R.save_draft("SK1", shop.id, R.DraftIn(price=price, images=images), w.db, w.clerk)
    R.submit("SK1", R.ShopIdsIn(shop_ids=[shop.id]), w.db, w.clerk)
    R.review("SK1", R.ReviewIn(shop_ids=[shop.id], approve=True), w.db, w.boss)


def _mock_gc(monkeypatch):
    calls = []

    async def noop(db):
        return None

    async def get_account(aid):
        return {"id": aid, "nick": {"acc1": "甲", "acc2": "乙"}[aid], "device_id": "d"}

    async def create_publish_job(sku, account_ids, spec, source="ERP", worry_free_by_account=None):
        calls.append({"accounts": account_ids, "spec": spec})
        return {"id": f"job-{len(calls)}"}

    async def list_devices():
        return []

    monkeypatch.setattr(L, "sync_gc_shops", noop)
    monkeypatch.setattr(L.gc, "get_account", get_account)
    monkeypatch.setattr(L.gc, "create_publish_job", create_publish_job)
    monkeypatch.setattr(L.gc, "list_devices", list_devices)
    return calls


def _on(w, ratio="1.00"):
    set_setting(w.db, la.REQUIRED_KEY, "1", None)
    set_setting(w.db, la.RATIO_KEY, ratio, None)
    # 老用例按“还要别人点通过”的流程验；提交即发布由单独用例覆盖
    set_setting(w.db, la.AUTO_PUBLISH_KEY, "0", None)
    w.db.commit()


def test_switch_off_publishes_as_before(w, monkeypatch):
    calls = _mock_gc(monkeypatch)
    asyncio.run(L.gc_publish_shops(w.db, w.sku, w.info, None))
    assert len(calls) == 1 and calls[0]["accounts"] == ["acc1", "acc2"]


def test_switch_on_blocks_without_approval(w, monkeypatch):
    calls = _mock_gc(monkeypatch)
    _on(w)
    with pytest.raises(ValueError, match="还没提交上架审批"):
        asyncio.run(L.gc_publish_shops(w.db, w.sku, w.info, None))
    assert calls == []
    row = w.db.query(SkuShopListing).filter(SkuShopListing.sale_shop_id == w.s1.id).one()
    assert row.last_error == "还没提交上架审批"


def test_each_account_gets_its_own_approved_price_and_images(w, monkeypatch):
    calls = _mock_gc(monkeypatch)
    _on(w)
    _approve(w, w.s1, 1290, ["oss/a.jpg", "oss/b.jpg"])
    _approve(w, w.s2, 1300, ["oss/c.jpg", "oss/d.jpg"])  # 两个号的图一张都不重叠
    rows = asyncio.run(L.gc_publish_shops(w.db, w.sku, w.info, None))
    assert len(rows) == 2 and len(calls) == 2
    by_acc = {c["accounts"][0]: c["spec"] for c in calls}
    assert by_acc["acc1"]["price"] == 1290 and by_acc["acc1"]["images"] == ["oss/a.jpg", "oss/b.jpg"]
    assert by_acc["acc2"]["price"] == 1300 and by_acc["acc2"]["images"] == ["oss/c.jpg", "oss/d.jpg"]
    assert all(r.listing_approval_id for r in rows)


def test_only_approved_shops_are_published(w, monkeypatch):
    calls = _mock_gc(monkeypatch)
    _on(w)
    _approve(w, w.s1, 1290, ["oss/a.jpg"])
    rows = asyncio.run(L.gc_publish_shops(w.db, w.sku, w.info, None))
    assert [c["accounts"] for c in calls] == [["acc1"]] and len(rows) == 1


def test_price_floor_uses_ratio_and_integer_yuan(w):
    _on(w, "1.30")
    R.save_draft("SK1", w.s1.id, R.DraftIn(price=Decimal("1299"), images=["oss/a.jpg"]), w.db, w.clerk)
    with pytest.raises(HTTPException, match="成本线 1300"):
        R.submit("SK1", R.ShopIdsIn(shop_ids=[w.s1.id]), w.db, w.clerk)
    R.save_draft("SK1", w.s1.id, R.DraftIn(price=Decimal("1300"), images=["oss/a.jpg"]), w.db, w.clerk)
    R.submit("SK1", R.ShopIdsIn(shop_ids=[w.s1.id]), w.db, w.clerk)


def test_no_cost_cannot_submit(w):
    w.sku.cost_price = Decimal("0")
    w.db.commit()
    R.save_draft("SK1", w.s1.id, R.DraftIn(price=Decimal("1300"), images=["oss/a.jpg"]), w.db, w.clerk)
    with pytest.raises(HTTPException, match="没有成本"):
        R.submit("SK1", R.ShopIdsIn(shop_ids=[w.s1.id]), w.db, w.clerk)


def test_settings_auto_publish_defaults_on_and_can_be_turned_off(w):
    assert R.read_settings(w.db, w.clerk)["auto_publish"] is True
    out = R.write_settings(R.SettingsIn(auto_publish=False), w.db, w.boss)
    assert out["auto_publish"] is False
    assert la.auto_publish_setting(w.db) is False


def test_submit_auto_publishes_when_setting_on(w):
    """提交即发布：提交后直接 APPROVED，不留待审批；后台发布任务被排上。"""
    _on(w)
    set_setting(w.db, la.AUTO_PUBLISH_KEY, "1", None)
    w.db.commit()
    R.save_draft("SK1", w.s1.id, R.DraftIn(price=Decimal("1300"), images=["oss/a.jpg"]), w.db, w.clerk)

    class BG:
        called = None

        def add_task(self, fn, *args):
            self.called = (fn, args)

    bg = BG()
    out = R.submit("SK1", R.ShopIdsIn(shop_ids=[w.s1.id]), w.db, w.clerk, background=bg)
    row = la.current(w.db, w.sku.id, w.s1.id)
    assert row.status == "APPROVED"
    assert row.reviewed_by == w.clerk.id
    assert row.review_note == "提交即发布"
    assert out["auto_publish"] is True
    assert bg.called[0] is R._auto_publish_submitted
    assert bg.called[1] == (w.sku.id, [w.s1.id])


def test_auto_publish_does_not_bypass_below_floor_admin_rule(w):
    """低价只有管理员能批：提交即发布开着，普通员工也不能把自己的低价直接发出去。"""
    _on(w, "1.30")
    set_setting(w.db, la.AUTO_PUBLISH_KEY, "1", None)
    w.db.commit()
    R.save_draft("SK1", w.s1.id, R.DraftIn(price=Decimal("1200"), images=["oss/a.jpg"], note="屏幕有划痕清仓"),
                 w.db, w.clerk)
    R.submit("SK1", R.ShopIdsIn(shop_ids=[w.s1.id]), w.db, w.clerk)
    row = la.current(w.db, w.sku.id, w.s1.id)
    assert row.status == "SUBMITTED", "低价仍要管理员点通过"
    R.review("SK1", R.ReviewIn(shop_ids=[w.s1.id], approve=True), w.db, w.boss)
    assert la.current(w.db, w.sku.id, w.s1.id).status == "APPROVED"


def test_same_first_image_or_same_set_is_rejected(w):
    _approve(w, w.s1, 1300, ["oss/a.jpg", "oss/b.jpg"])
    R.save_draft("SK1", w.s2.id, R.DraftIn(price=1300, images=["oss/a.jpg", "oss/c.jpg"]), w.db, w.clerk)
    with pytest.raises(HTTPException, match="首图和「店1」一样"):
        R.submit("SK1", R.ShopIdsIn(shop_ids=[w.s2.id]), w.db, w.clerk)
    R.save_draft("SK1", w.s2.id, R.DraftIn(price=1300, images=["oss/b.jpg", "oss/a.jpg"]), w.db, w.clerk)
    with pytest.raises(HTTPException, match="整组图"):
        R.submit("SK1", R.ShopIdsIn(shop_ids=[w.s2.id]), w.db, w.clerk)


def test_any_shared_image_is_rejected_not_only_the_first(w):
    """各号的图一张都不能重复（11-10 用户重申）：非首图撞了也拦，签名不同也是同一个文件。"""
    _approve(w, w.s1, 1300, ["oss/a.jpg", "oss/b.jpg"])
    signed = "oss/b.jpg?OSSAccessKeyId=k&Expires=1&Signature=s"
    R.save_draft("SK1", w.s2.id, R.DraftIn(price=1300, images=["oss/c.jpg", signed]), w.db, w.clerk)
    with pytest.raises(HTTPException) as exc:
        R.submit("SK1", R.ShopIdsIn(shop_ids=[w.s2.id]), w.db, w.clerk)
    assert exc.value.detail == "「店2」：第 2 张图和「店1」用的是同一张，每个号的图不能重复"
    R.save_draft("SK1", w.s2.id, R.DraftIn(price=1300, images=["oss/c.jpg"]), w.db, w.clerk)
    R.submit("SK1", R.ShopIdsIn(shop_ids=[w.s2.id]), w.db, w.clerk)
    assert la.current(w.db, w.sku.id, w.s2.id).status == "SUBMITTED"


def test_images_live_on_another_shop_count_even_when_it_uses_the_common_set(w):
    # 店1 在架、没单独挑图：挂的是上架信息那组（oss/a.jpg）
    w.db.add(SkuShopListing(sku_id=w.sku.id, sale_shop_id=w.s1.id, publish_status=ShopListingStatus.LISTED))
    w.db.commit()
    R.save_draft("SK1", w.s2.id, R.DraftIn(price=1300, images=["oss/c.jpg", "oss/a.jpg"]), w.db, w.clerk)
    with pytest.raises(HTTPException, match="第 2 张图和「店1」用的是同一张"):
        R.submit("SK1", R.ShopIdsIn(shop_ids=[w.s2.id]), w.db, w.clerk)


def test_submitter_cannot_approve_own_and_reject_needs_reason(w):
    R.save_draft("SK1", w.s1.id, R.DraftIn(price=1300, images=["oss/a.jpg"]), w.db, w.boss)
    R.submit("SK1", R.ShopIdsIn(shop_ids=[w.s1.id]), w.db, w.boss)
    with pytest.raises(HTTPException, match="别人来批"):
        R.review("SK1", R.ReviewIn(shop_ids=[w.s1.id], approve=True), w.db, w.boss)
    other = _staff(w.db, "管理员二", StaffRole.ADMIN)
    with pytest.raises(HTTPException, match="原因"):
        R.review("SK1", R.ReviewIn(shop_ids=[w.s1.id], approve=False), w.db, other)
    out = R.review("SK1", R.ReviewIn(shop_ids=[w.s1.id], approve=False, note="首图太暗"), w.db, other)
    assert out["shops"][0]["cell"]["label"] == "已退回"


def test_cost_change_or_higher_ratio_invalidates(w):
    _approve(w, w.s1, 1300, ["oss/a.jpg"])
    assert la.problem_for_publish(w.db, w.sku, la.current(w.db, w.sku.id, w.s1.id)) is None
    _on(w, "1.40")
    assert "成本线 1400" in la.problem_for_publish(w.db, w.sku, la.current(w.db, w.sku.id, w.s1.id))
    _on(w, "1.00")
    w.sku.cost_price = Decimal("1100")
    w.db.commit()
    assert "成本变了" in la.problem_for_publish(w.db, w.sku, la.current(w.db, w.sku.id, w.s1.id))
    tasks = R.list_tasks("all", None, 1, 20, w.db, w.clerk)
    assert tasks["items"][0]["cells"][w.s1.id]["state"] == "STALE"


def test_return_marks_approvals_stale(w):
    _approve(w, w.s1, 1300, ["oss/a.jpg"])
    la.mark_stale(w.db, w.sku.id, "退货回仓（RT1），要重新核状态")
    w.db.commit()
    assert "退货回仓" in la.problem_for_publish(w.db, w.sku, la.current(w.db, w.sku.id, w.s1.id))


def test_edit_after_approval_is_new_version_and_needs_reapproval(w):
    _approve(w, w.s1, 1300, ["oss/a.jpg"])
    R.save_draft("SK1", w.s1.id, R.DraftIn(price=1350, images=["oss/a.jpg"]), w.db, w.clerk)
    row = la.current(w.db, w.sku.id, w.s1.id)
    assert row.version == 2 and row.status == "DRAFT"
    assert la.problem_for_publish(w.db, w.sku, row) == "还没提交上架审批"


def test_listed_without_approval_is_flagged_for_fix(w):
    w.db.add(SkuShopListing(sku_id=w.sku.id, sale_shop_id=w.s1.id, publish_status=ShopListingStatus.LISTED))
    w.db.commit()
    tasks = R.list_tasks("fix", None, 1, 20, w.db, w.clerk)
    assert tasks["total"] == 1 and tasks["items"][0]["cells"][w.s1.id]["needs_fix"] is True
    assert tasks["counts"]["todo"] == 1


def test_refresh_does_not_wait_for_approval(w):
    _on(w)
    row = SkuShopListing(sku_id=w.sku.id, sale_shop_id=w.s1.id, publish_status=ShopListingStatus.LISTED,
                         gc_account_id="acc1", images=["oss/c.jpg"])
    w.db.add(row)
    w.db.commit()
    item = {"sku": "SK1", "account_id": "acc1", "status": "LIVE"}
    why, spec = LR._refresh_spec(w.db, item)
    assert why is None and spec["price"] == 1100 and spec["images"] == ["oss/c.jpg"]
    # 当初按批过的内容发的，照那份重发
    _approve(w, w.s1, 1300, ["oss/b.jpg"])
    row.listing_approval_id = la.current(w.db, w.sku.id, w.s1.id).id
    w.db.commit()
    why, spec = LR._refresh_spec(w.db, item)
    assert why is None and spec["price"] == 1300 and spec["images"] == ["oss/b.jpg"]


# ---------------------------------------------------------------- 手机端（11-10）


def test_sales_sees_cost_and_anyone_can_review(w):
    """11-10 用户定：销售能看成本；任何员工都能清洗、审批，只是自己提交的要别人批。"""
    _on(w, "1.20")
    R.save_draft("SK1", w.s1.id, R.DraftIn(price=1300, images=["oss/a.jpg"]), w.db, w.boss)
    R.submit("SK1", R.ShopIdsIn(shop_ids=[w.s1.id]), w.db, w.boss)
    tasks = R.list_tasks("all", None, 1, 20, w.db, w.clerk)
    assert tasks["cost_hidden"] is False and tasks["items"][0]["cost_price"].startswith("1000")
    assert tasks["items"][0]["thumb"] == "thumb:oss/a.jpg"
    out = R.read_sku("SK1", w.db, w.clerk)
    assert out["sku"]["cost_price"].startswith("1000") and out["floor_price"] == 1200
    assert out["can_review"] is True and out["shops"][0]["approval"]["submitted_by_me"] is False
    boss = R.read_sku("SK1", w.db, w.boss)
    assert boss["shops"][0]["approval"]["submitted_by_me"] is True
    with pytest.raises(HTTPException):
        R.review("SK1", R.ReviewIn(shop_ids=[w.s1.id], approve=True), w.db, w.boss)
    # 销售批老板提交的
    R.review("SK1", R.ReviewIn(shop_ids=[w.s1.id], approve=True), w.db, w.clerk)
    assert la.current(w.db, w.sku.id, w.s1.id).status == "APPROVED"


def test_every_staff_role_can_clean_and_review_but_not_devices():
    assert StaffRole.PURCHASER in R._EDITORS and StaffRole.FINANCE in R._EDITORS
    assert StaffRole.CRAWLER not in R._EDITORS and StaffRole.RFID_DEVICE not in R._EDITORS


def test_candidates_add_crawled_and_picked_uploads_never_cover(w, monkeypatch):
    w.sku.cover_url = "migrate/order-screenshot.jpg"
    w.db.commit()
    real = SI.options

    def fake_options(db, sku):
        out = real(db, sku)
        out["crawled"] = [{"url": "spu-ref/x/pool/1.jpg", "thumb": "t1", "grade": "bad", "flags": ["水印"]}]
        out["crawl_status"] = "已合格"
        return out

    monkeypatch.setattr(SI, "options", fake_options)
    upload = f"{SI.upload_dir(w.sku)}new.jpg"
    out = R.save_draft("SK1", w.s1.id, R.DraftIn(price=1300, images=[upload, "spu-ref/x/pool/1.jpg"]), w.db, w.clerk)
    by_raw = {c["raw"]: c for c in out["candidates"]}
    assert {"oss/a.jpg", "oss/b.jpg", "oss/c.jpg"} <= set(by_raw)
    assert by_raw["spu-ref/x/pool/1.jpg"]["crawled"] is True and by_raw["spu-ref/x/pool/1.jpg"]["flags"] == ["水印"]
    assert by_raw[upload]["source"] == "新上传" and by_raw["oss/a.jpg"]["thumb"] == "thumb:oss/a.jpg"
    assert "migrate/order-screenshot.jpg" not in by_raw
    assert out["crawl_status"] == "已合格" and out["upload_dir"] == "listing/shop-images/SK1/"
    assert out["shops"][0]["approval"]["images"][0]["thumb"] == f"thumb:{upload}"


def test_held_marks_images_live_on_other_shops(w):
    w.db.add(SkuShopListing(sku_id=w.sku.id, sale_shop_id=w.s2.id, publish_status=ShopListingStatus.LISTED,
                            images=["oss/c.jpg"]))
    w.db.commit()
    out = R.read_sku("SK1", w.db, w.clerk)
    assert out["held"] == {"oss/c.jpg": "店2"}


def test_occupied_uses_same_rule_as_submit_so_picker_can_disable(w):
    """选图页拿到的 occupied 必须覆盖提交时的撞图口径：已批审批 + 在架号公用图。"""
    _approve(w, w.s1, 1300, ["oss/a.jpg", "oss/b.jpg"])
    # 店2 在架、没单独挑图：挂的是上架信息那组（oss/a.jpg）
    w.db.add(SkuShopListing(sku_id=w.sku.id, sale_shop_id=w.s2.id, publish_status=ShopListingStatus.LISTED))
    w.db.commit()
    occupied = R.read_sku("SK1", w.db, w.clerk)["occupied"]
    assert occupied["oss/a.jpg"] == [{"id": w.s1.id, "label": "店1"}, {"id": w.s2.id, "label": "店2"}]
    assert occupied["oss/b.jpg"] == [{"id": w.s1.id, "label": "店1"}]


def test_occupied_includes_disabled_shops_that_still_hold_images(w):
    """停用/不在发布列表里的号也占着图；页面要能看到并禁用，不能提交时才报一个看不见的号。"""
    _approve(w, w.s1, 1300, ["oss/b.jpg"])
    w.s1.enabled = False
    w.db.commit()
    occupied = R.read_sku("SK1", w.db, w.clerk)["occupied"]
    assert occupied["oss/b.jpg"] == [{"id": w.s1.id, "label": "店1"}]


def test_market_drift_does_not_invalidate_approval(w, monkeypatch):
    """11-14 用户定：行情涨跌不让批准作废（只在库存商品卡上提醒核价）。"""
    _approve(w, w.s1, 1300, ["oss/a.jpg"])
    row = la.current(w.db, w.sku.id, w.s1.id)
    # 提交时行情 1500（fixture）；现在变成 1200，偏差 20%
    monkeypatch.setattr(la, "market_of", lambda db, sku: {"price": Decimal("1200"), "basis": "成交均价",
                                                          "date": None, "query": "x"})
    assert la.problem_for_publish(w.db, w.sku, row) is None


# ---------------------------------------------------------------- 手机端（11-10）


def test_below_floor_needs_reason_and_only_admin_approves(w, monkeypatch):
    """11-13：低于成本线不直接拦——写理由提交，只有管理员能批，批了能发；比例调高就失效。"""
    sent = []
    monkeypatch.setattr("app.services.staff_notify.send", lambda staff, title, body, **kw: sent.append((staff.username, title)))
    _on(w, "1.30")
    R.save_draft("SK1", w.s1.id, R.DraftIn(price=Decimal("1200"), images=["oss/a.jpg"]), w.db, w.clerk)
    with pytest.raises(HTTPException, match="写清为什么要低价"):
        R.submit("SK1", R.ShopIdsIn(shop_ids=[w.s1.id]), w.db, w.clerk)
    R.save_draft("SK1", w.s1.id, R.DraftIn(price=Decimal("1200"), images=["oss/a.jpg"], note="屏幕有划痕清仓"), w.db, w.clerk)
    out = R.submit("SK1", R.ShopIdsIn(shop_ids=[w.s1.id]), w.db, w.clerk)
    assert out["shops"][0]["approval"]["below_floor"] is True
    assert sent == [("老板", "低于成本线的上架价待你批")]
    other_clerk = _staff(w.db, "员工二", StaffRole.WAREHOUSE)
    with pytest.raises(HTTPException, match="只有管理员能批"):
        R.review("SK1", R.ReviewIn(shop_ids=[w.s1.id], approve=True), w.db, other_clerk)
    R.review("SK1", R.ReviewIn(shop_ids=[w.s1.id], approve=True), w.db, w.boss)
    row = la.current(w.db, w.sku.id, w.s1.id)
    assert row.status == "APPROVED"
    assert la.problem_for_publish(w.db, w.sku, row) is None
    _on(w, "1.40")
    assert "成本线 1400" in la.problem_for_publish(w.db, w.sku, row)


def test_low_price_approved_while_ratio_was_lowered_cannot_publish_after_restore(w, monkeypatch):
    """比例 1.30 时提交 1200（成本 1000）；管理员临时调到 1.10，这时不算低价、仓管就批得了；
    调回 1.30 后这条不能当成「管理员批过的低价」照发。"""
    monkeypatch.setattr("app.services.staff_notify.send", lambda *a, **kw: None)
    _on(w, "1.30")
    R.save_draft("SK1", w.s1.id, R.DraftIn(price=Decimal("1200"), images=["oss/a.jpg"], note="屏幕划痕清仓"), w.db, w.clerk)
    R.submit("SK1", R.ShopIdsIn(shop_ids=[w.s1.id]), w.db, w.clerk)
    _on(w, "1.10")
    other_clerk = _staff(w.db, "员工二", StaffRole.WAREHOUSE)
    R.review("SK1", R.ReviewIn(shop_ids=[w.s1.id], approve=True), w.db, other_clerk)
    row = la.current(w.db, w.sku.id, w.s1.id)
    assert la.problem_for_publish(w.db, w.sku, row) is None
    _on(w, "1.30")
    assert "成本线 1300" in la.problem_for_publish(w.db, w.sku, row)


def test_high_price_is_flagged_not_blocked(w):
    _on(w, "1.00")
    R.save_draft("SK1", w.s1.id, R.DraftIn(price=Decimal("5100"), images=["oss/a.jpg"]), w.db, w.clerk)
    out = R.submit("SK1", R.ShopIdsIn(shop_ids=[w.s1.id]), w.db, w.clerk)
    approval = out["shops"][0]["approval"]
    assert approval["high"] is True and approval["below_floor"] is False
    assert out["high_price_multiple"] == 5

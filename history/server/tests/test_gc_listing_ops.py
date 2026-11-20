"""新群控上下架 op:店铺→gc账号解析(仅已绑账号的镜像店铺)、建作业、SkuShopListing 处理中标记 + 回写收敛。

async op 用 asyncio.run 直调(未装 pytest-asyncio);gc client 与 sync_gc_shops 全部 monkeypatch。
"""
import asyncio
from decimal import Decimal

import pytest

import app.services.gc_bridge.assembler as ASM
import app.services.gc_bridge.listing_ops as L
from app.enums import ListingInfoStatus, ShopListingStatus, SkuStatus
from app.models import SaleShop, Sku, SkuListingInfo, SkuShopListing


@pytest.fixture(autouse=True)
def _no_oss(monkeypatch):
    monkeypatch.setattr(ASM, "sign_oss_publish_image_url", lambda obj, expires=86400: obj)


def _seed(db, *, nick="闲鱼A", enabled=True, bound=True):
    sku = Sku(sku_code="SK1", product_name="显示器", purchase_order_id="po1", inspection_id="in1",
              cost_price=Decimal("1"), status=SkuStatus.IN_STOCK,
              images=["oss/sku/product/a.jpg"], suggest_price=Decimal("100"))
    shop = SaleShop(code="s1", label="店1", xianyu_user_name=nick, enabled=enabled, sort_order=0,
                    gc_account_id=f"acc-{nick}" if bound else None)
    db.add_all([sku, shop])
    db.flush()
    info = SkuListingInfo(sku_id=sku.id, images=["oss/sku/product/a.jpg"], price=Decimal("199"),
                          express_fee=Decimal("0"), status=ListingInfoStatus.READY)
    db.add(info)
    db.commit()
    return sku, shop, info


def _default_account(shop, nick=None):
    return {"id": shop.gc_account_id, "nick": nick or shop.xianyu_user_name, "device_id": "dev1"}


def _mock_gc(monkeypatch, *, accounts=None, listings=None, devices=None, tasks=None):
    """accounts:{aid: account dict};缺省给不了(无绑定店铺)时返回 None。"""
    calls = {"publish": [], "delist": [], "delist_accounts": []}
    accts = accounts or {}

    async def noop_sync(db):
        return None

    async def get_account(aid):
        return accts.get(aid)

    async def create_publish_job(sku, account_ids, spec, source="ERP", worry_free_by_account=None):
        calls["publish"].append({"sku": sku, "account_ids": account_ids, "spec": spec,
                                 "worry_free_by_account": worry_free_by_account})
        return {"id": "job-pub-1"}

    async def create_delist_job(sku, source="ERP", account_ids=None):
        calls["delist"].append(sku)
        calls["delist_accounts"].append(account_ids)
        return {"id": "job-del-1"}

    async def list_listings(sku, account_id=None):
        return listings or []

    async def list_devices():
        # 默认无设备行(reported_nick 未知)→ 防错号软闸放行,不影响老用例
        return devices or []

    async def list_tasks(job_id):
        return tasks or []

    monkeypatch.setattr(L, "sync_gc_shops", noop_sync)   # 镜像同步在 shop_sync 测试里单测
    monkeypatch.setattr(L.gc, "get_account", get_account)
    monkeypatch.setattr(L.gc, "create_publish_job", create_publish_job)
    monkeypatch.setattr(L.gc, "create_delist_job", create_delist_job)
    monkeypatch.setattr(L.gc, "list_listings", list_listings)
    monkeypatch.setattr(L.gc, "list_devices", list_devices)
    monkeypatch.setattr(L.gc, "list_tasks", list_tasks)
    return calls


def test_publish_creates_job_and_marks_listing(db_session, monkeypatch):
    sku, shop, info = _seed(db_session)
    calls = _mock_gc(monkeypatch, accounts={shop.gc_account_id: _default_account(shop)})

    rows = asyncio.run(L.gc_publish_shops(db_session, sku, info, None))

    assert len(rows) == 1
    assert rows[0].publish_status == ShopListingStatus.LISTING
    assert rows[0].gc_job_id == "job-pub-1"
    assert rows[0].gc_account_id == "acc-闲鱼A"
    assert info.status == ListingInfoStatus.PUBLISHING
    # 发的是 sku_code + 解析出的 gc 账号 + 合法 spec(有图有价)
    assert calls["publish"][0]["sku"] == "SK1"
    assert calls["publish"][0]["account_ids"] == ["acc-闲鱼A"]
    assert calls["publish"][0]["spec"]["price"] == 199
    assert calls["publish"][0]["spec"]["images"] == ["oss/sku/product/a.jpg"]


def test_publish_all_skips_unbound_shops(db_session, monkeypatch):
    # 未绑 gc 账号的店铺(历史遗留)不参与发布:publish-all 直接无可发店铺
    sku, shop, info = _seed(db_session, bound=False)
    _mock_gc(monkeypatch)
    with pytest.raises(ValueError, match="无已绑定群控账号的店铺"):
        asyncio.run(L.gc_publish_shops(db_session, sku, info, None))


def test_publish_selected_unbound_shop_errors(db_session, monkeypatch):
    # 显式选择了未绑 gc 账号的店铺 → 明确报错(不静默跳过)
    sku, shop, info = _seed(db_session, bound=False)
    _mock_gc(monkeypatch)
    with pytest.raises(ValueError, match="所选店铺未绑定群控账号"):
        asyncio.run(L.gc_publish_shops(db_session, sku, info, [shop.id]))


def test_publish_errors_when_account_has_no_device(db_session, monkeypatch):
    sku, shop, info = _seed(db_session)
    acc = _default_account(shop)
    acc["device_id"] = None
    _mock_gc(monkeypatch, accounts={shop.gc_account_id: acc})
    with pytest.raises(ValueError, match="未绑定设备"):
        asyncio.run(L.gc_publish_shops(db_session, sku, info, None))


def test_publish_errors_when_account_missing(db_session, monkeypatch):
    # 绑定的 gc 账号已被删(同步还没把它停用)→ 明确报错
    sku, shop, info = _seed(db_session)
    _mock_gc(monkeypatch, accounts={})
    with pytest.raises(ValueError, match="群控账号已不存在"):
        asyncio.run(L.gc_publish_shops(db_session, sku, info, None))


def test_publish_blocks_when_device_logged_into_other_account(db_session, monkeypatch):
    # 账号轮换:设备当前登着「别的闲鱼」,而店铺期望「闲鱼A」→ 拒发,防发错号
    sku, shop, info = _seed(db_session, nick="闲鱼A")
    _mock_gc(monkeypatch,
             accounts={shop.gc_account_id: _default_account(shop)},
             devices=[{"id": "dev1", "reported_nick": "别的闲鱼"}])
    with pytest.raises(ValueError, match="发错号"):
        asyncio.run(L.gc_publish_shops(db_session, sku, info, None))


def test_publish_allows_when_reported_nick_matches(db_session, monkeypatch):
    # 设备当前登着正确账号 → 放行
    sku, shop, info = _seed(db_session, nick="闲鱼A")
    _mock_gc(monkeypatch,
             accounts={shop.gc_account_id: _default_account(shop)},
             devices=[{"id": "dev1", "reported_nick": "闲鱼A"}])
    rows = asyncio.run(L.gc_publish_shops(db_session, sku, info, None))
    assert len(rows) == 1 and rows[0].publish_status == ShopListingStatus.LISTING


def test_publish_allows_when_reported_nick_unknown(db_session, monkeypatch):
    # reported_nick 未上报(真机昵称读取未校准)→ 软闸放行,不回退现有绑定流程
    sku, shop, info = _seed(db_session, nick="闲鱼A")
    _mock_gc(monkeypatch,
             accounts={shop.gc_account_id: _default_account(shop)},
             devices=[{"id": "dev1", "reported_nick": None}])
    rows = asyncio.run(L.gc_publish_shops(db_session, sku, info, None))
    assert len(rows) == 1


def test_publish_erp_name_not_used_in_resolution(db_session, monkeypatch):
    # ERP 闲鱼账号名与 gc 完全无关也不参与解析;软闸比对的是 gc 账号 nick(真源)
    sku, shop, info = _seed(db_session, nick="ERP会员名tb123")
    _mock_gc(monkeypatch,
             accounts={shop.gc_account_id: _default_account(shop, nick="gc昵称")},
             devices=[{"id": "dev1", "reported_nick": "gc昵称"}])
    rows = asyncio.run(L.gc_publish_shops(db_session, sku, info, None))
    assert rows[0].gc_account_id == "acc-ERP会员名tb123"


def test_publish_sync_failure_falls_back_to_existing_mirror(db_session, monkeypatch):
    # 镜像同步异常(gc 不可达)→ 退化为 DB 已有镜像,不挡发布
    sku, shop, info = _seed(db_session)
    calls = _mock_gc(monkeypatch, accounts={shop.gc_account_id: _default_account(shop)})

    async def boom(db):
        raise ConnectionError("refused")
    monkeypatch.setattr(L, "sync_gc_shops", boom)

    rows = asyncio.run(L.gc_publish_shops(db_session, sku, info, None))
    assert len(rows) == 1 and calls["publish"]


def test_writeback_live_flips_to_listed(db_session, monkeypatch):
    sku, shop, info = _seed(db_session)
    row = SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id, gc_job_id="job-pub-1",
                         gc_account_id="acc-1", publish_status=ShopListingStatus.LISTING)
    db_session.add(row)
    db_session.commit()
    _mock_gc(monkeypatch, listings=[{"status": "LIVE"}])

    n = asyncio.run(L.sync_gc_publish_status(db_session, sku))
    assert n == 1
    assert row.publish_status == ShopListingStatus.LISTED
    assert row.gc_job_id is None   # 已收敛,清标记


def test_writeback_delisted_flips(db_session, monkeypatch):
    sku, shop, info = _seed(db_session)
    row = SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id, gc_job_id="job-del-1",
                         gc_account_id="acc-1", publish_status=ShopListingStatus.LISTED)
    db_session.add(row)
    db_session.commit()
    _mock_gc(monkeypatch, listings=[{"status": "DELISTED"}])

    n = asyncio.run(L.sync_gc_publish_status(db_session, sku))
    assert n == 1
    assert row.publish_status == ShopListingStatus.DELISTED
    assert row.delisted_at is not None


def test_writeback_deleted_by_refresh_counts_as_delisted(db_session, monkeypatch):
    # 链接焕新删了旧链接、货又被下架(不再重发):群控记 DELETED,店铺就是不在架了
    sku, shop, info = _seed(db_session)
    row = SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id, gc_job_id="job-del-1",
                         gc_account_id="acc-1", publish_status=ShopListingStatus.LISTED)
    db_session.add(row)
    db_session.commit()
    _mock_gc(monkeypatch, listings=[{"status": "DELETED"}])

    n = asyncio.run(L.sync_gc_publish_status(db_session, sku))
    assert n == 1
    assert row.publish_status == ShopListingStatus.DELISTED
    assert row.gc_job_id is None


def test_writeback_failed_task_flips_listing_to_failed(db_session, monkeypatch):
    # 发布任务 FAILED:gc 不长账本行,靠任务级状态收敛,行置 FAILED 并记 last_error
    sku, shop, info = _seed(db_session)
    row = SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id, gc_job_id="job-pub-1",
                         gc_account_id="acc-1", publish_status=ShopListingStatus.LISTING)
    db_session.add(row)
    db_session.commit()
    _mock_gc(monkeypatch, listings=[],
             tasks=[{"account_id": "acc-1", "status": "FAILED",
                     "error": "点「发布」后编辑页未推进", "failed_step": "publish"}])

    n = asyncio.run(L.sync_gc_publish_status(db_session, sku))
    assert n == 1
    assert row.publish_status == ShopListingStatus.FAILED
    assert row.gc_job_id is None
    assert "点「发布」后编辑页未推进" in row.last_error
    assert "[publish]" in row.last_error


def test_writeback_failed_delist_keeps_listed(db_session, monkeypatch):
    # 下架任务 FAILED:行保留 LISTED,记 last_error 并清 gc_job_id(不再卡「下架中」)
    sku, shop, info = _seed(db_session)
    row = SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id, gc_job_id="job-del-1",
                         gc_account_id="acc-1", publish_status=ShopListingStatus.LISTED)
    db_session.add(row)
    db_session.commit()
    _mock_gc(monkeypatch, listings=[],
             tasks=[{"account_id": "acc-1", "status": "FAILED", "error": "下架未找到商品",
                     "failed_step": "delist"}])

    n = asyncio.run(L.sync_gc_publish_status(db_session, sku))
    assert n == 0
    assert row.publish_status == ShopListingStatus.LISTED
    assert row.gc_job_id is None
    assert "下架未找到商品" in row.last_error


def test_writeback_success_but_uncertain_keeps_listing(db_session, monkeypatch):
    # 任务 SUCCESS 但账本 UNCERTAIN/缺:不改状态,记提示留人工对账(勿盲重发)
    sku, shop, info = _seed(db_session)
    row = SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id, gc_job_id="job-pub-1",
                         gc_account_id="acc-1", publish_status=ShopListingStatus.LISTING)
    db_session.add(row)
    db_session.commit()
    _mock_gc(monkeypatch, listings=[{"status": "UNCERTAIN"}],
             tasks=[{"account_id": "acc-1", "status": "SUCCESS"}])

    n = asyncio.run(L.sync_gc_publish_status(db_session, sku))
    assert n == 0
    assert row.publish_status == ShopListingStatus.LISTING
    assert row.gc_job_id == "job-pub-1"   # 未收敛,标记保留
    assert "待对账" in row.last_error


def test_writeback_running_task_untouched(db_session, monkeypatch):
    # 任务在途:不动,等下轮
    sku, shop, info = _seed(db_session)
    row = SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id, gc_job_id="job-pub-1",
                         gc_account_id="acc-1", publish_status=ShopListingStatus.LISTING)
    db_session.add(row)
    db_session.commit()
    _mock_gc(monkeypatch, listings=[],
             tasks=[{"account_id": "acc-1", "status": "RUNNING"}])

    n = asyncio.run(L.sync_gc_publish_status(db_session, sku))
    assert n == 0
    assert row.publish_status == ShopListingStatus.LISTING
    assert row.gc_job_id == "job-pub-1"
    assert row.last_error is None


# ---------------- 回写:下架中(LISTED + 作业号)等下架任务有结论 ----------------

def _delisting_row(db, sku, shop):
    row = SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id, gc_job_id="job-del-1",
                         gc_account_id="acc-1", publish_status=ShopListingStatus.LISTED)
    db.add(row)
    db.commit()
    return row


@pytest.mark.parametrize("tstatus", ["PENDING", "RUNNING"])
def test_writeback_live_while_delist_in_flight_stays_delisting(db_session, monkeypatch, tstatus):
    # 下架任务还在排队/在跑,账本当然还是 LIVE。以前这一支当上架确认把作业号清了,
    # 店铺又显示在架、还能再点一次下架;现在一直挂着「下架中」
    sku, shop, info = _seed(db_session)
    row = _delisting_row(db_session, sku, shop)
    _mock_gc(monkeypatch, listings=[{"status": "LIVE"}],
             tasks=[{"account_id": "acc-1", "status": tstatus}])

    n = asyncio.run(L.sync_gc_publish_status(db_session, sku))
    assert n == 0
    assert row.publish_status == ShopListingStatus.LISTED
    assert row.gc_job_id == "job-del-1"
    assert row.last_error is None


def test_writeback_live_delist_gc_unreachable_stays_delisting(db_session, monkeypatch):
    # 查不到任务(群控不可达)≠ 下架失败:不清标记,下轮再收
    sku, shop, info = _seed(db_session)
    row = _delisting_row(db_session, sku, shop)
    _mock_gc(monkeypatch, listings=[{"status": "LIVE"}])

    async def boom(job_id):
        raise ConnectionError("refused")
    monkeypatch.setattr(L.gc, "list_tasks", boom)

    asyncio.run(L.sync_gc_publish_status(db_session, sku))
    assert row.publish_status == ShopListingStatus.LISTED
    assert row.gc_job_id == "job-del-1"


@pytest.mark.parametrize("tstatus,error,step", [
    # 无忧卖商品网页版下不掉:点「确定」后平台弹 toast 拦下
    ("FAILED", "下架被平台拦截(无忧卖商品):为保障无忧卖流量推广效果,请前往『无忧卖-售卖中』修改价格和库存",
     "delist"),
    # 店铺离线/冻结/不在营业时间:任务派不出去,12 小时后群控定时清理
    ("CANCELLED", "超时未执行,定时清理", None),
])
def test_writeback_live_delist_failed_restores_listed(db_session, monkeypatch, tstatus, error, step):
    # 下架任务失败/取消:恢复在架(可以再点下架),记下原因
    sku, shop, info = _seed(db_session)
    row = _delisting_row(db_session, sku, shop)
    _mock_gc(monkeypatch, listings=[{"status": "LIVE"}],
             tasks=[{"account_id": "acc-1", "status": tstatus, "error": error, "failed_step": step}])

    n = asyncio.run(L.sync_gc_publish_status(db_session, sku))
    assert n == 0
    assert row.publish_status == ShopListingStatus.LISTED
    assert row.gc_job_id is None
    assert row.last_error == f"[{step or '-'}] {error}"


def test_writeback_delist_success_before_ledger_catches_up(db_session, monkeypatch):
    # 下架任务 SUCCESS、账本还停在 LIVE(群控先落任务状态、另开事务记账本):按任务结论收成已下架。
    # 不能写上架那句「待对账」——那句叫人别重发,还会被算进人工对账数
    sku, shop, info = _seed(db_session)
    row = _delisting_row(db_session, sku, shop)
    _mock_gc(monkeypatch, listings=[{"status": "LIVE"}],
             tasks=[{"account_id": "acc-1", "status": "SUCCESS"}])

    n = asyncio.run(L.sync_gc_publish_status(db_session, sku))
    assert n == 1
    assert row.publish_status == ShopListingStatus.DELISTED
    assert row.delisted_at is not None
    assert row.gc_job_id is None
    assert not row.last_error


def test_writeback_delist_taken_over_follows_new_job(db_session, monkeypatch):
    # 排队中的下架被新的下架作业接手:改盯新作业,不当成取消(原来清掉作业号、行留在架,新作业下掉了也不再收)
    sku, shop, info = _seed(db_session)
    row = _delisting_row(db_session, sku, shop)
    _mock_gc(monkeypatch, listings=[{"status": "LIVE"}],
             tasks=[{"account_id": "acc-1", "status": "CANCELLED", "error": "由新的下架作业接手:job-del-2"}])

    asyncio.run(L.sync_gc_publish_status(db_session, sku))
    assert row.publish_status == ShopListingStatus.LISTED
    assert row.gc_job_id == "job-del-2"


def test_writeback_empty_delist_job_releases_after_a_day(db_session, monkeypatch):
    # 下架时这些链接全在别的作业里跑着,新作业扇出 0 个:一天后清掉作业号、留在架,售出同步会重建下架
    from datetime import datetime, timedelta
    sku, shop, info = _seed(db_session)
    row = _delisting_row(db_session, sku, shop)
    _mock_gc(monkeypatch, listings=[{"status": "LIVE"}], tasks=[])
    asyncio.run(L.sync_gc_publish_status(db_session, sku))
    assert row.gc_job_id == "job-del-1", "刚建的不动"
    row.updated_at = datetime.utcnow() - timedelta(hours=25)
    db_session.commit()
    asyncio.run(L.sync_gc_publish_status(db_session, sku))
    assert row.publish_status == ShopListingStatus.LISTED and row.gc_job_id is None
    assert row.last_error == "这次下架没派出去，等重新下架"


# ---------------- 下架:只下所选店铺 ----------------

def _seed_listed(db, account_ids):
    """SK1 在几家店都已在架(LISTED、没有在途作业);第 i 家店的行挂 account_ids[i](None = 行上没记 gc 账号)。"""
    sku = Sku(sku_code="SK1", product_name="显示器", purchase_order_id="po1", inspection_id="in1",
              cost_price=Decimal("1"), status=SkuStatus.IN_STOCK)
    db.add(sku)
    db.flush()
    rows = []
    for i, aid in enumerate(account_ids):
        shop = SaleShop(code=f"s{i}", label=f"店{i}", xianyu_user_name=f"闲鱼{i}", enabled=True,
                        sort_order=i, gc_account_id=aid)
        db.add(shop)
        db.flush()
        row = SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id, gc_account_id=aid,
                             publish_status=ShopListingStatus.LISTED)
        db.add(row)
        rows.append(row)
    db.commit()
    return sku, rows


def test_delist_selected_sends_only_selected_accounts(db_session, monkeypatch):
    # 只勾店 0:群控只拿到店 0 的账号,店 1 不动。以前群控按 SKU 全账号下,没选的店也被下掉、ERP 里还显示在架
    sku, (r0, r1) = _seed_listed(db_session, ["acc-0", "acc-1"])
    calls = _mock_gc(monkeypatch)

    rows = asyncio.run(L.gc_delist_shops(db_session, sku, [r0.sale_shop_id]))

    assert calls["delist_accounts"] == [["acc-0"]]
    assert [r.id for r in rows] == [r0.id]
    assert r0.gc_job_id == "job-del-1" and r0.publish_status == ShopListingStatus.LISTED
    assert r1.gc_job_id is None


def test_delist_all_keeps_full_account(db_session, monkeypatch):
    # 不选店铺(下架全部 / 售出后全网下架):不带账号,群控照旧全账号下
    sku, (r0, r1) = _seed_listed(db_session, ["acc-0", "acc-1"])
    calls = _mock_gc(monkeypatch)

    rows = asyncio.run(L.gc_delist_shops(db_session, sku, None))

    assert calls["delist_accounts"] == [None]
    assert {r.id for r in rows} == {r0.id, r1.id}
    assert r0.gc_job_id == r1.gc_job_id == "job-del-1"


def test_delist_selected_skips_shops_already_delisting(db_session, monkeypatch):
    sku, (r0, r1) = _seed_listed(db_session, ["acc-0", "acc-1"])
    r0.gc_job_id = "job-del-old"      # 店 0 已经在下架中
    db_session.commit()
    calls = _mock_gc(monkeypatch)

    with pytest.raises(ValueError, match="正在下架中"):
        asyncio.run(L.gc_delist_shops(db_session, sku, [r0.sale_shop_id]))
    assert calls["delist"] == []

    rows = asyncio.run(L.gc_delist_shops(db_session, sku, [r0.sale_shop_id, r1.sale_shop_id]))
    assert calls["delist_accounts"] == [["acc-1"]]
    assert [r.id for r in rows] == [r1.id]
    assert r0.gc_job_id == "job-del-old"   # 在途的那单不被新作业冲掉


def test_delist_selected_marks_sibling_shop_on_same_account(db_session, monkeypatch):
    # 两家店挂同一个 gc 账号 = 闲鱼上同一条链接:只勾一家,另一家也会跟着下掉,一起标下架中
    sku, (r0, r1, r2) = _seed_listed(db_session, ["acc-0", "acc-0", "acc-2"])
    calls = _mock_gc(monkeypatch)

    rows = asyncio.run(L.gc_delist_shops(db_session, sku, [r0.sale_shop_id]))

    assert calls["delist_accounts"] == [["acc-0"]]
    assert {r.id for r in rows} == {r0.id, r1.id}
    assert r1.gc_job_id == "job-del-1"
    assert r2.gc_job_id is None


def test_delist_selected_row_without_gc_account_errors(db_session, monkeypatch):
    # 行上没有 gc 账号(不是群控发的):群控对不上,明确报错,不打一个回写永远收不了的标记
    sku, (r0,) = _seed_listed(db_session, [None])
    calls = _mock_gc(monkeypatch)

    with pytest.raises(ValueError, match="不是群控发的"):
        asyncio.run(L.gc_delist_shops(db_session, sku, [r0.sale_shop_id]))
    assert calls["delist"] == []
    assert r0.gc_job_id is None


def test_client_delist_payload_carries_accounts_only_when_given(monkeypatch):
    # 不传账号时请求体里就没有 account_ids:老调用方、售出全网下架照旧全账号
    sent = []

    async def fake_post(path, json):
        sent.append((path, json))
        return {"id": "job-x"}
    monkeypatch.setattr(L.gc, "_post", fake_post)

    asyncio.run(L.gc.create_delist_job("SK1"))
    asyncio.run(L.gc.create_delist_job("SK1", account_ids=["acc-0"]))
    assert sent == [
        ("/api/gc/jobs", {"job_type": "delist_sku", "sku": "SK1", "source": "ERP"}),
        ("/api/gc/jobs", {"job_type": "delist_sku", "sku": "SK1", "source": "ERP", "account_ids": ["acc-0"]}),
    ]

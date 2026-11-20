"""上架状态兜底对账：没人看的货也要收敛。

# 这条测试为什么存在

2026-09-16 查生产：sku_shop_listing 里 46 行卡在「上架中」，最老的是 8 月 13 日，
一个多月。而群控那边这些作业**全都有终态**（FAILED / CANCELLED / SUCCESS）——
收敛逻辑本身没问题，是没人调它。

`sync_gc_publish_status` 只在 `build_shops_payload` 里被调，而后者的两个入口
（GET 店铺列表 / 该 SKU 的 WS 每 3 秒一拍）都要求**有人正在看那件货**。
发出去之后再没人打开过的货，就永远停在「上架中」。

它自己的 docstring 写着「轮询式(供定时任务/接口触发)」——定时任务那半从没建。

# 钉住三件事

  1. 捞的是「在途 + 很久没动」的行，且按 SKU 去重；
  2. 正在被人看着的货不抢（grace 窗口内的行不碰，那边 WS 每 3 秒就在收敛）；
  3. 群控不可达时这一轮跳过，**不清 gc_job_id**——「查不到」和「确实失败了」
     是两件事，混了会把在途的货误判成终态。
"""

import asyncio
from datetime import datetime, timedelta
from decimal import Decimal

from app.enums import ShopListingStatus, SkuStatus
from app.models import SaleShop, Sku, SkuShopListing
from app.services.gc_bridge import reconcile


def _sku(db, code="SKU-R1"):
    s = Sku(sku_code=code, product_name="对账用", purchase_order_id="po1",
            inspection_id="in1", cost_price=Decimal("1"), status=SkuStatus.IN_STOCK)
    db.add(s)
    db.commit()
    return s


def _shop(db, code="shop-1"):
    sh = SaleShop(code=code, label=code, xianyu_user_name=code, enabled=True)
    db.add(sh)
    db.commit()
    return sh


def _row(db, sku, shop, *, job="job-1", status=ShopListingStatus.LISTING, age_min=60):
    r = SkuShopListing(
        sku_id=sku.id,
        sale_shop_id=shop.id,
        publish_status=status,
        gc_job_id=job,
        updated_at=datetime.utcnow() - timedelta(minutes=age_min),
    )
    db.add(r)
    db.commit()
    return r


def test_捞得到卡很久的在途行(db_session):
    sku = _sku(db_session)
    _row(db_session, sku, _shop(db_session), age_min=60)
    assert reconcile.pending_sku_ids(db_session, grace_min=10, limit=20) == [sku.id]


def test_刚动过的不碰(db_session):
    """正在被人看着的货，它的 WS 每 3 秒就在收敛，兜底不该跟它抢同一批行。"""
    sku = _sku(db_session)
    _row(db_session, sku, _shop(db_session), age_min=1)
    assert reconcile.pending_sku_ids(db_session, grace_min=10, limit=20) == []


def test_已经收敛的不捞(db_session):
    """gc_job_id 被清掉 = 已经有结论了，没什么可对的。"""
    sku = _sku(db_session)
    _row(db_session, sku, _shop(db_session), job=None, status=ShopListingStatus.LISTED)
    assert reconcile.pending_sku_ids(db_session, grace_min=10, limit=20) == []


def test_同一件货多行只算一件(db_session):
    """收敛是按 SKU 做的（一次过完它所有店铺行），多行不该触发多次。"""
    sku = _sku(db_session)
    for i in range(3):
        _row(db_session, sku, _shop(db_session, f"shop-{i}"), job=f"job-{i}")
    assert reconcile.pending_sku_ids(db_session, grace_min=10, limit=20) == [sku.id]


def test_每轮有上限(db_session):
    """积压时慢慢消化，不要一次把群控打满。"""
    shop = _shop(db_session)
    for i in range(5):
        _row(db_session, _sku(db_session, f"SKU-R{i}"), shop, job=f"job-{i}")
    assert len(reconcile.pending_sku_ids(db_session, grace_min=10, limit=2)) == 2


def test_群控不可达时不清在途标记(db_session, monkeypatch):
    """「查不到」和「确实失败了」是两件事。

    混了的后果是把还在跑的货判成终态，然后有人看见 FAILED 去重发一次——
    于是同一件货在闲鱼上挂了两份。
    """
    sku = _sku(db_session)
    shop = _shop(db_session)
    row = _row(db_session, sku, shop)

    async def boom(*a, **k):
        raise RuntimeError("群控不可达")

    monkeypatch.setattr(
        "app.services.gc_bridge.listing_ops.sync_gc_publish_status", boom, raising=False
    )
    monkeypatch.setattr(reconcile, "SessionLocal", lambda: _Ctx(db_session))

    result = asyncio.run(reconcile.reconcile_once(grace_min=10, limit=20))
    assert result["failed"] == 1, "一件失败要记下来，但不该让整轮停摆"
    db_session.refresh(row)
    assert row.gc_job_id == "job-1", "群控答不上来时绝不能清在途标记"
    assert row.publish_status == ShopListingStatus.LISTING


class _Ctx:
    """把测试的 session 冒充成 SessionLocal() 的上下文管理器。"""

    def __init__(self, db):
        self.db = db

    def __enter__(self):
        return self.db

    def __exit__(self, *exc):
        return False


# --- 孤儿行与人工对账队列 -----------------------------------------------------
def test_待人工对账的行数得出来(db_session):
    """「任务成功但账本没确认」有意不自动收敛——猜错会让人重发，同一件货挂两份。

    但它们此前完全隐形：没有任何地方说得出「有几行在等人对账」，于是没人对。
    数出来，才有人管。
    """
    sku = _sku(db_session)
    shop = _shop(db_session)
    r = _row(db_session, sku, shop, job=None)
    r.last_error = "发布结果待对账(gc 账本未确认),请勿直接重发"
    db_session.commit()
    assert reconcile.needs_human_count(db_session) == 1

    r.last_error = "[price] 群控任务失败"
    db_session.commit()
    assert reconcile.needs_human_count(db_session) == 0, "普通失败不算等人对账"


def test_作业还没扇完不许判孤儿():
    """「作业里没有本账号的任务」要判 FAILED，前提是作业**已经扇完**。

    还在扇出途中就判，会把马上就要派出去的货误杀成失败——然后有人去重发。
    """
    from app.services.gc_bridge.listing_ops import _job_settled

    assert _job_settled([{"status": "SUCCESS"}, {"status": "FAILED"}]) is True
    assert _job_settled([{"status": "SUCCESS"}, {"status": "RUNNING"}]) is False
    assert _job_settled([]) is False, "查不到任务 ≠ 都跑完了，空列表绝不能当作已终结"


def test_刚建的行不判孤儿(db_session):
    """第二道闸：行本身也要足够久没动，不是刚建出来还没排上队。"""
    from app.services.gc_bridge.listing_ops import _stale

    sku = _sku(db_session)
    fresh = _row(db_session, sku, _shop(db_session, "s-fresh"), age_min=5)
    old = _row(db_session, sku, _shop(db_session, "s-old"), job="job-2", age_min=60 * 48)
    assert _stale(fresh) is False
    assert _stale(old) is True

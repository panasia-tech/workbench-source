"""gc 售出同步:真机聊天检出「已售」账本(gc Listing SOLD)→ ERP 标店/锁库存/全账号下架。

闭环:gc chat_scan 发现某账号宝贝被买(order_status 售出态 + 宝贝标题匹配账本标题,
老账本兼容 #NNNN 短编码)→ gc Listing 标 SOLD
→ 本模块(scripts/run_gc_sold_sync,systemd timer 周期跑)轮询:
  1. 对应 SkuShopListing 标 SOLD(终态,清在途作业标记防回写覆盖);
  2. SKU 锁占用(RESERVED/PLATFORM_SOLD,待发货);
  3. gc_delist_shops 建 delist_sku 作业,把同一 SKU 在**其它账号**的在架链接全部真机下架
     (防一货多卖;delist_sku 只碰 gc 侧 LIVE,已售账号的不受影响)。
幂等:已 SOLD 的店铺行直接跳过;在架行都已带着下架作业号时不重复建下架作业。

另外两件事跟着这个定时任务一起跑(11-11 #111 核查补的漏洞):
- heal_recoded_listings:ERP 换过货号的,gc 账本还记旧货号,上面按货号对账全对不上
  (xbox 手柄换码后卖了两次、还挂 6 个号)。每轮先把换码记录推给 gc,账本跟着换;
- warn_stuck_listings:货已出库/报损还挂着、或者下架卡在冻结的号上(任务派不出去,12 小时作废再建,
  一直空转),各通知管理员一次,让人去闲鱼手动下。
"""

import logging
from datetime import datetime, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.enums import ShopListingStatus, SkuStatus, StockEventType
from app.models import EventLog, Sku, SkuShopListing, StockEvent
from app.services.gc_bridge import client as gc
from app.services.gc_bridge.listing_ops import gc_delist_shops
from app.services.sku_reserve import reserve_sku_for_platform_sold

logger = logging.getLogger("gc_sold_sync")


RELEASED_EVENT = "platform_sold_released"


def released_listing_ids(db: Session) -> set[str]:
    """买家发货前取消、已放回在库的那几条 gc 已售账本：gc 那边一直是 SOLD，不能每轮再把货锁回去。"""
    ids: set[str] = set()
    for (payload,) in db.query(EventLog.payload).filter(EventLog.event_type == RELEASED_EVENT):
        ids.update((payload or {}).get("listing_ids") or [])
    return ids


def release_platform_sold(db: Session, sku: Sku, listing_ids: list[str], user_id: str, reason: str) -> None:
    """买家发货前取消：货放回在库，ERP 这边的已售店铺行改成已下架（不再算「漏抓」），记下这几条 gc 已售账本以后跳过。不 commit。"""
    from app.enums import ReserveSource
    from app.services.sku_reserve import clear_reserve

    if not (sku.status == SkuStatus.RESERVED and sku.reserve_source == ReserveSource.PLATFORM_SOLD):
        raise ValueError("这件货不是「闲鱼卖出待发货」，不用放回")
    clear_reserve(sku)
    for row in db.query(SkuShopListing).filter(SkuShopListing.sku_id == sku.id,
                                               SkuShopListing.publish_status == ShopListingStatus.SOLD):
        row.publish_status = ShopListingStatus.DELISTED
        row.last_error = f"买家取消：{reason}"[:255]
    db.add(EventLog(event_type=RELEASED_EVENT, entity_type="sku", entity_id=sku.id, operator_id=user_id,
                    payload={"sku_code": sku.sku_code, "listing_ids": listing_ids, "reason": reason},
                    occurred_at=datetime.utcnow()))


async def sync_gc_sold(db: Session) -> dict:
    """轮询 gc SOLD 账本并收敛到 ERP。返回 {sold, delist_jobs, skipped}。"""
    stats = {"sold": 0, "delist_jobs": 0, "skipped": 0}
    released = released_listing_ids(db)
    for lst in await gc.list_listings(status="SOLD"):
        if lst.get("id") in released:
            stats["skipped"] += 1
            continue
        sku_code, aid = lst.get("sku"), lst.get("account_id")
        sku = db.query(Sku).filter(Sku.sku_code == (sku_code or "")).first()
        if not sku or not aid:
            stats["skipped"] += 1
            continue
        row = db.query(SkuShopListing).filter(
            SkuShopListing.sku_id == sku.id, SkuShopListing.gc_account_id == aid
        ).first()
        if row and row.publish_status == ShopListingStatus.SOLD:
            stats["skipped"] += 1            # 已标过(每轮都会再拉到,幂等跳过)
        else:
            if row:
                row.publish_status = ShopListingStatus.SOLD
                row.sold_at = datetime.utcnow()
                row.gc_job_id = None         # 售出是终态,清在途标记防回写把它拉回 LISTED
                row.last_error = None
            reserve_sku_for_platform_sold(db, sku)
            stats["sold"] += 1
            logger.info("售出收敛:sku=%s account=%s → SOLD + 锁库存", sku_code, aid)
        # 确保其它店铺在架链接全账号下架(已 SOLD 的店铺行不在其中)。
        # 不只做于「新标 SOLD」当轮:上轮若因 gc 抖动/在途作业没建成,下轮补建。
        live = db.query(SkuShopListing).filter(
            SkuShopListing.sku_id == sku.id,
            SkuShopListing.publish_status == ShopListingStatus.LISTED,
        ).all()
        # 还有不在下架途中的在架店铺就建。不能是「一行在途就不建」:别的店正在「下架所选店铺」时,
        # 那单只下它自己,等它跑完的这段时间(设备离线能排 12 小时)其余店铺还挂着、还能被买走。
        # 全网下架建过之后所有行都带着作业号,不会每轮重复建。
        # 再按内存里的状态筛一遍:会话不自动 flush,本轮刚标 SOLD 的行这条查询里还查得到。
        if any(r.publish_status == ShopListingStatus.LISTED and not r.gc_job_id for r in live):
            rows = await gc_delist_shops(db, sku)
            if rows:
                stats["delist_jobs"] += 1
                logger.info("售出全网下架:sku=%s 波及 %d 店铺", sku_code, len(rows))
    db.commit()
    return stats


async def heal_recoded_listings(db: Session) -> int:
    """把 ERP 全部换码记录(按先后)推给 gc,账本里还是旧货号的行换成新货号。返回 gc 改了几条。"""
    events = (
        db.query(StockEvent)
        .filter(StockEvent.event_type == StockEventType.RECODE)
        .order_by(StockEvent.created_at)
        .all()
    )
    # 带上换码时间,gc 只改那之前建的链接。旧货号后来又分给了别的货(06 月导入时 sancg73→TMP-010,
    # 之后新建的另一台 G73 又叫 sancg73),后来那台的链接是换码之后才建的,不会被换走(11-11 首发错改过 8 条)。
    # 原来按「旧货号现在有没有货在用」跳过:后来那台再换一次号就不算在用了,06 月那条又会把它的链接改走;
    # 跳过期间老链接也一直被当成后来那台的。gc 要先发这一版(老版本不认 at,会全量重放)。
    pairs = []
    for e in events:
        p = e.payload or {}
        if p.get("old") and p.get("new"):
            pairs.append({"old": p["old"], "new": p["new"], "at": e.created_at.isoformat(timespec="seconds")})
    if not pairs:
        return 0
    n = await gc.recode_listings(pairs)
    if n:
        logger.info("gc 账本换货号 %d 条", n)
    return n


# 货已经不在仓库了;RESERVED 不算(锁货自己会联动下架,见 stock_lock_delist)
_LEFT = {SkuStatus.SHIPPED: "出库", SkuStatus.LOSS: "报损", SkuStatus.SPLIT: "拆分"}
_GC_ON_SHELF = ("LIVE", "UNCERTAIN")
_FROZEN = "FROZEN"
LEFT_EVENT = "gc_listing_left_live"
FROZEN_EVENT = "gc_delist_frozen"


# 同一件货同一类只提醒一次，但不是永远：退货再卖、换个号又卡住，过了这几天还会再说
NOTICE_AGAIN_DAYS = 7
# 下架卡在冻结的号上，卡了这么久才提醒：「冻结」也包括掉登录，通常几分钟自己恢复
FROZEN_GRACE = timedelta(hours=2)


def _noticed(db: Session, event_type: str, sku: Sku) -> bool:
    since = datetime.utcnow() - timedelta(days=NOTICE_AGAIN_DAYS)
    return db.query(EventLog.id).filter(EventLog.event_type == event_type, EventLog.entity_id == sku.id,
                                        EventLog.created_at >= since).first() is not None


def _remember(db: Session, event_type: str, sku: Sku, shops: list[str]) -> None:
    db.add(EventLog(event_type=event_type, entity_type="sku", entity_id=sku.id,
                    payload={"sku_code": sku.sku_code, "shops": shops}, occurred_at=datetime.utcnow()))


async def warn_stuck_listings(db: Session, notifier=None) -> dict:
    """该下没下掉的链接,每件货通知管理员一次(EventLog 记过就不再发)。"""
    from app.services.stock_lock_delist import _notify_admins, _shop_names

    stats = {"left_live": 0, "frozen": 0}

    # 1. 货已出库/报损,gc 账本里还挂着,又不在下架途中
    by_sku: dict[str, tuple[Sku, list[SkuShopListing]]] = {}
    for row, sku in (
        db.query(SkuShopListing, Sku).join(Sku, Sku.id == SkuShopListing.sku_id)
        .filter(SkuShopListing.publish_status == ShopListingStatus.LISTED,
                SkuShopListing.gc_job_id.is_(None),
                Sku.status.in_(list(_LEFT)))
        .all()
    ):
        by_sku.setdefault(sku.id, (sku, []))[1].append(row)
    for sku, rows in by_sku.values():
        if _noticed(db, LEFT_EVENT, sku):
            continue
        on_shelf = {l.get("account_id") for l in await gc.list_listings(sku=sku.sku_code)
                    if l.get("status") in _GC_ON_SHELF}
        hit = [r for r in rows if r.gc_account_id in on_shelf]
        if not hit:
            continue
        shops = _shop_names(db, hit)
        reason = _LEFT[sku.status]
        _remember(db, LEFT_EVENT, sku, shops)
        db.commit()
        _notify_admins(db, sku, reason, shops, "当时没有自动下架（早于联动下架开关，或货号对不上）", notifier)
        stats["left_live"] += 1

    # 2. 下架中(LISTED + 作业号)卡在冻结的号上:任务派不出去,解冻前下不掉
    delisting = (
        db.query(SkuShopListing, Sku).join(Sku, Sku.id == SkuShopListing.sku_id)
        .filter(SkuShopListing.publish_status == ShopListingStatus.LISTED,
                SkuShopListing.gc_job_id.isnot(None),
                SkuShopListing.gc_account_id.isnot(None))
        .all()
    )
    if delisting:
        accounts = {a.get("id"): a for a in await gc.list_accounts()}
        frozen = {aid for aid, a in accounts.items()
                  if a.get("status") == _FROZEN or a.get("risk_state") == _FROZEN}
        by_sku = {}
        stale_before = datetime.utcnow() - FROZEN_GRACE
        for row, sku in delisting:
            if row.gc_account_id in frozen and row.updated_at and row.updated_at < stale_before:
                by_sku.setdefault(sku.id, (sku, []))[1].append(row)
        for sku, rows in by_sku.values():
            if _noticed(db, FROZEN_EVENT, sku):
                continue
            shops = _shop_names(db, rows)
            _remember(db, FROZEN_EVENT, sku, shops)
            db.commit()
            reason = _LEFT.get(sku.status) or ("卖出" if sku.status == SkuStatus.RESERVED else "下架")
            _notify_admins(db, sku, reason, shops, "号被冻结（或掉登录），下架任务派不出去，已经卡了 2 小时以上", notifier,
                           todo="解冻后会自动下；急的话先去闲鱼手动下架，免得被人拍下。")
            stats["frozen"] += 1
    return stats

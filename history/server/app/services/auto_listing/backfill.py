"""存量在库货补行情价和图：只补，不发。

09-08 定的是「存量不进自动上架、人工上架」，11-03 D6 改成存量也要清洗，11-09 技术对接会
定为第一步：让在库货都有行情价和图，才能开始上架。

做法是把存量货登记进同一条流水线，但标 hold_publish：
  - 解析 SPU、取行情价、定价都跟新入库的货一样；
  - 不文生图（花钱，没同款参考时会猜错品类）；没实拍图就让图片爬虫按型号搜图，搜到直接用，
    搜不到才转人工「缺图」（11-09 老板定）；
  - 人工已经填过的上架价和图不覆盖；
  - 备好就停在 READY 挂起，不过议价闸门、不进发布。上架仍然走人工或上架审批。

点一次就当场跑完，不靠 worker——自动上架总开关关着也能用。跟 worker 抢同一把具名锁，
免得一件货同时被两边推。
"""

from __future__ import annotations

import logging
from datetime import datetime

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.enums import AutoListingStage, ShopListingStatus, SkuStatus
from app.models import Sku, SkuAutoListing, SkuShopListing
from app.services.auto_listing.pipeline import (
    HELD_READY,
    HELD_READY_CRAWLED,
    MISSING_PHOTO,
    WAIT_CRAWLER,
    advance,
    enqueue,
)
from app.services.auto_listing.pricing import REASON_BELOW_COST
from app.services.auto_listing.worker import _batch_lock
from app.services.spu_market_sync import sync_watchlist

logger = logging.getLogger(__name__)

# 一行最多推几步：RESOLVING → COLLECTING → READY 挂起，留一步余量
_MAX_STEPS = 4


class BackfillBusy(Exception):
    """worker 正拿着锁推流水线。"""


def listed_sku_ids(db: Session):
    """在任一店铺挂着的货（子查询）。"""
    return db.query(SkuShopListing.sku_id).filter(SkuShopListing.publish_status == ShopListingStatus.LISTED)


def new_candidates(db: Session) -> list[Sku]:
    """还没进过流水线、也没在任何店铺挂着的在库货。"""
    has_row = db.query(SkuAutoListing.sku_id)
    listed = listed_sku_ids(db)
    return (
        db.query(Sku)
        .filter(
            Sku.status == SkuStatus.IN_STOCK,
            or_(Sku.reserve_source.is_(None), Sku.reserve_source == ""),
            Sku.id.notin_(has_row),
            Sku.id.notin_(listed),
        )
        .order_by(Sku.sku_code)
        .all()
    )


def adopt_unresolved_inbound(db: Session, *, dry_run: bool = True) -> list[SkuAutoListing]:
    """入库时认不出型号、卡在转人工的自动上架行，改成存量行（只补价补图、不自动发布）。

    11-09 一次性处理：生产上有 28 件这样的货，没挂在任何店铺，存量回填又因为「已进过流水线」
    挑不中它们。改成存量行以后跟别的存量货一样进「填型号」弹窗，填好后停在待人工上架。
    在店铺挂着的、锁定的、不在库的不动。
    """
    rows = (
        db.query(SkuAutoListing)
        .join(Sku, Sku.id == SkuAutoListing.sku_id)
        .filter(
            SkuAutoListing.hold_publish.is_(False),
            SkuAutoListing.stage == AutoListingStage.NEEDS_HUMAN,
            SkuAutoListing.last_error.like("%SPU%"),
            Sku.status == SkuStatus.IN_STOCK,
            or_(Sku.reserve_source.is_(None), Sku.reserve_source == ""),
            SkuAutoListing.sku_id.notin_(listed_sku_ids(db)),
        )
        .all()
    )
    if not dry_run:
        for row in rows:
            row.hold_publish = True
        db.commit()
    return rows


def rerun_rows(db: Session) -> list[SkuAutoListing]:
    """以前回填过、还没备好、货还在库的行：等行情价的，和转人工的（可能图拍了、SPU 补了、价爬到了）。"""
    return (
        db.query(SkuAutoListing)
        .join(Sku, Sku.id == SkuAutoListing.sku_id)
        .filter(
            SkuAutoListing.hold_publish.is_(True),
            SkuAutoListing.stage.in_((AutoListingStage.COLLECTING, AutoListingStage.NEEDS_HUMAN)),
            Sku.status == SkuStatus.IN_STOCK,
        )
        .all()
    )


def outcome(row: SkuAutoListing) -> str:
    """存量行现在卡在哪。看板「要人做什么」和回填统计都按这个分。"""
    err = row.last_error or ""
    if row.stage == AutoListingStage.READY and err == HELD_READY:
        return "ready"
    if row.stage == AutoListingStage.READY and err == HELD_READY_CRAWLED:
        return "ready_crawled"
    if row.stage == AutoListingStage.DONE:
        return "listed"
    if row.stage == AutoListingStage.COLLECTING:
        return "waiting_image" if err == WAIT_CRAWLER else "waiting_price"
    if row.stage == AutoListingStage.NEEDS_HUMAN:
        if err.startswith(MISSING_PHOTO):
            return "missing_photo"
        if "SPU" in err:
            return "unresolved"
        if REASON_BELOW_COST in err:
            return "below_cost"
        return "needs_human"
    return "other"


def _push(db: Session, row: SkuAutoListing) -> None:
    if row.stage == AutoListingStage.NEEDS_HUMAN:
        # 跟看板「重跑」一样从头来，才吃得到人刚补的 SPU / 图 / 价
        row.stage = AutoListingStage.RESOLVING
        row.attempts = 0
        row.last_error = None
        row.collecting_since = None
    for _ in range(_MAX_STEPS):
        before = row.stage
        advance(db, row)  # 不给 publish：就算漏网走到发布那步也只会原地等
        if row.stage == before:
            break


def run_backfill(db: Session, *, dry_run: bool = True) -> dict:
    """先把在库 SPU 同步进行情监控清单，再把存量货逐件推到「备好 / 缺什么」。

    dry_run 只数不动。真跑时一行一提交，某件炸了不带走整批。
    """
    with _batch_lock(db) as acquired:
        if not acquired:
            raise BackfillBusy()

        watch = sync_watchlist(db, dry_run=dry_run)
        fresh = new_candidates(db)
        again = rerun_rows(db)
        result = {
            "dry_run": dry_run,
            "new": len(fresh),
            "rerun": len(again),
            "watch_created": watch["created"] + watch["reenabled"],
            "outcomes": {},
            "failed": 0,
        }
        if dry_run:
            return result

        rows = []
        for sku in fresh:
            rows.append(enqueue(db, sku, hold_publish=True))
        db.commit()
        rows.extend(again)

        outcomes: dict[str, int] = {}
        for row in rows:
            try:
                _push(db, row)
                db.commit()
            except Exception:  # noqa: BLE001 - 单件失败不能带走整批
                db.rollback()
                result["failed"] += 1
                logger.exception("存量回填推进失败: sku_id=%s", row.sku_id)
                continue
            key = outcome(row)
            outcomes[key] = outcomes.get(key, 0) + 1
        result["outcomes"] = outcomes
        logger.info("存量回填：新登记 %d、重跑 %d，结果 %s", len(fresh), len(again), outcomes)
        return result


def recheck_crawled_images(db: Session, *, dry_run: bool = True) -> dict:
    """11-10 一次性：爬虫给图打了质量分以后，「备好（爬虫图）」的货换掉带水印、海报字、拼图的图。
    员工在素材里淘汰了爬虫图以后也可以再跑一次。

    只动上架图全部来自爬虫池、没人改过的（有一张不是池子里的就当人改过，不碰）；有一张不是「可用」就换成池里可用的；
    一张能用的都没有就清空，重推一遍，落到「缺图」要人拍照。不发布。
    """
    from app.models import SkuListingInfo
    from app.services import image_material, product_image
    from app.services.oss_media import strip_oss_signature

    rows = (
        db.query(SkuAutoListing)
        .join(Sku, Sku.id == SkuAutoListing.sku_id)
        .filter(
            SkuAutoListing.hold_publish.is_(True),
            SkuAutoListing.stage == AutoListingStage.READY,
            SkuAutoListing.last_error == HELD_READY_CRAWLED,
            Sku.status == SkuStatus.IN_STOCK,
            SkuAutoListing.sku_id.notin_(listed_sku_ids(db)),
        )
        .all()
    )
    result = {"dry_run": dry_run, "checked": len(rows), "replaced": 0, "now_missing": 0, "kept": 0, "edited_by_hand": 0}
    for row in rows:
        info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == row.sku_id).first()
        pool = product_image.pool_for_spu(db, row.spu_id)
        have = [strip_oss_signature(u) for u in ((info.images if info else None) or [])]
        from_pool = {p["url"] for p in pool if p.get("url")}
        if not have or not set(have) <= from_pool:
            result["edited_by_hand"] += 1
            continue
        usable = [p["url"] for p in image_material.usable_crawled(db, pool)][:9]
        if set(have) <= set(usable):
            result["kept"] += 1  # 用的都还是可用的图,顺序变了也不折腾
            continue
        result["replaced" if usable else "now_missing"] += 1
        if dry_run:
            continue
        info.images = []
        row.stage = AutoListingStage.NEEDS_HUMAN  # _push 从头推：重新取爬虫图（已过滤）或落到缺图
        _push(db, row)
        db.commit()
    return result


def identify(db: Session, row: SkuAutoListing, *, brand: str, model: str) -> SkuAutoListing:
    """认不出型号时人填的品牌、型号：写回这件货，从头再解析一遍。

    存量行当场推到底（同 run_backfill）；新入库的行放回流水线，交给 worker。
    填了目录里也没有，行会再停在「解析不出 SPU」，由调用方告诉人去目录里加这一款。
    """
    sku = db.get(Sku, row.sku_id)
    sku.brand = brand
    sku.model = model
    if not row.hold_publish:
        row.stage = AutoListingStage.RESOLVING
        row.attempts = 0
        row.last_error = None
        row.collecting_since = None
        row.next_run_at = datetime.utcnow()
        db.commit()
        return row
    with _batch_lock(db) as acquired:
        if not acquired:
            raise BackfillBusy()
        row.stage = AutoListingStage.NEEDS_HUMAN  # 让 _push 按「重跑」从头来
        _push(db, row)
        db.commit()
    return row

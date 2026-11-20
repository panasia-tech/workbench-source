"""自动上架流水线的阶段推进。

一件 SKU 一行 sku_auto_listing，worker 每次把它往前推一步：

    RESOLVING → COLLECTING → (READY | WAIT_NEGOTIATION) → PUBLISHING → DONE
                    ↓                                          
                NEEDS_HUMAN（解析不出 / 行情倒挂 / 等价超期）

行情与图片在 COLLECTING 阶段预取，**不依赖议价**——议价一完成即可发布，
人不用等机器。议价本身仍是硬闸门（老板保留）。

图片优先用验货实拍图；没拍照的货按解析出的 SPU 文生图补一张（见 images.py）。

发布动作注入而非直接 import gc_bridge：gc_publish_shops 是 async 且要连群控服务端，
注入后阶段逻辑可以脱网回归。

hold_publish 的行（存量回填，见 backfill.py）走同样的解析和取价，但：不文生图，没实拍图就让
图片爬虫按型号搜图；不覆盖人工已填的上架信息；不过议价闸门，备好价和图就停在 READY 挂起，绝不发布。
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.config import settings
from app.enums import AutoListingStage, ListingInfoStatus, ShopListingStatus, SkuStatus
from app.models import CrawlProduct, Sku, SkuAutoListing, SkuListingInfo, SkuShopListing
from app.services.auto_listing.images import POLL_INTERVAL as IMAGE_POLL_INTERVAL
from app.services.auto_listing.images import ensure_images
from app.services.auto_listing.pricing import REASON_NO_MARKET_PRICE, resolve_price
from app.services.oss_media import strip_oss_signature
from app.services.short_code import ensure_short_code
from app.services.spu_resolve import resolve_spu

logger = logging.getLogger(__name__)

# 等行情价的耐心：超过这个时长还没价就转人工，不无限等
COLLECT_TIMEOUT = timedelta(days=3)
# 每次没推进就退避，避免空转刷库
RETRY_BASE = timedelta(minutes=10)
MAX_ATTEMPTS = 8
# 上架图上限（与 listing.save_listing 的 [:9] 对齐）
MAX_IMAGES = 9

# 存量回填的两种结局（看板和回填统计按这两句认）
HELD_READY = "存量：价和图已备好，等人工上架"
HELD_READY_CRAWLED = "存量：价已备好，图是爬虫按型号搜的，上架前看一眼"
WAIT_CRAWLER = "等图片爬虫按型号搜图"
MISSING_PHOTO = "缺图"
# 人工上架信息已经走到发布环节了，回填不去改它的状态
_INFO_STATUS_FILLABLE = (None, ListingInfoStatus.DRAFT, ListingInfoStatus.READY, ListingInfoStatus.FAILED)


def enqueue(db: Session, sku: Sku, *, hold_publish: bool = False) -> SkuAutoListing | None:
    """入库时登记一行。已登记则返回现有行（幂等，重复入库不会建两条）。"""
    row = db.query(SkuAutoListing).filter(SkuAutoListing.sku_id == sku.id).first()
    if row is not None:
        return row
    row = SkuAutoListing(
        sku_id=sku.id, stage=AutoListingStage.RESOLVING, next_run_at=datetime.utcnow(), hold_publish=hold_publish
    )
    db.add(row)
    return row


def enqueue_on_inbound(db: Session, sku: Sku) -> SkuAutoListing | None:
    """入库触发点统一入口。开关关着就当没这回事，登记失败也绝不拖垮入库本身。

    只 add 不 commit：跟着入库那一笔事务一起落，入库回滚了登记也跟着回滚，
    不会留下「没有货的流水线行」。

    **只管新入库的货**（老板 2026-09-08 定：开关打开前已在库的货由人工手动上架）。
    存量货 11-09 起另有入口 backfill.py：只补价补图、标 hold_publish，不会自动发布。
    """
    if not settings.auto_listing_enabled:
        return None
    try:
        return enqueue(db, sku)
    except Exception:  # noqa: BLE001 - 自动上架是增值项，入库是主干，绝不能反过来拖垮它
        logger.exception("登记自动上架失败: sku=%s", sku.sku_code)
        return None


def _fail_to_human(row: SkuAutoListing, reason: str) -> None:
    row.stage = AutoListingStage.NEEDS_HUMAN
    row.last_error = reason
    row.next_run_at = None


def _retry_later(row: SkuAutoListing, reason: str) -> None:
    """没推进就退避重试；次数用尽转人工，不无限重试。"""
    row.attempts += 1
    row.last_error = reason
    if row.attempts >= MAX_ATTEMPTS:
        _fail_to_human(row, f"重试 {row.attempts} 次仍未推进：{reason}")
        return
    row.next_run_at = datetime.utcnow() + RETRY_BASE * (2 ** min(row.attempts - 1, 5))


def market_price_for(db: Session, query: str | None):
    """按「品牌 型号」取监控清单里的最近价。取不到返回 None。"""
    q = (query or "").strip()
    if not q:
        return None
    row = (
        db.query(CrawlProduct)
        .filter((CrawlProduct.name == q) | (CrawlProduct.keyword == q))
        .first()
    )
    return row.last_price if row else None


def pick_images(sku: Sku) -> list[str]:
    """验货实拍图。没有的话由 images.ensure_images 按 SPU 文生图补。

    只取 Sku.images（产品实拍），绝不碰 location_images（库位图）
    和 negotiation_media（议价证据）——那是隐私/内部资料。
    存干净原始 URL，不存短效签名（与 listing.save_listing 同一口径）。
    """
    raw = [u for u in (sku.images or []) if isinstance(u, str) and u.strip()]
    return [strip_oss_signature(u) for u in raw[:MAX_IMAGES]]


def _write_listing_info(db: Session, sku: Sku, price, images: list[str]) -> SkuListingInfo:
    """写上架信息。写完与人工填的没有区别，人工上架路径照常可用。"""
    info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).first()
    if info is None:
        info = SkuListingInfo(sku_id=sku.id)
        db.add(info)
    info.price = price
    info.images = images
    info.status = ListingInfoStatus.READY
    ensure_short_code(db, sku)
    return info


def _info_of(db: Session, sku: Sku) -> SkuListingInfo | None:
    return db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).first()


def _fill_listing_info(db: Session, sku: Sku, price, images: list[str]) -> SkuListingInfo:
    """存量回填用：只补空着的价和图，人工填过的一律不动。"""
    info = _info_of(db, sku)
    if info is None:
        info = SkuListingInfo(sku_id=sku.id)
        db.add(info)
    if info.price is None:
        info.price = price
    if not info.images:
        info.images = images
    if info.status in _INFO_STATUS_FILLABLE:
        info.status = ListingInfoStatus.READY
    ensure_short_code(db, sku)
    return info


def _hold_ready(row: SkuAutoListing, *, crawled: bool = False) -> None:
    """存量行备好了：停在 READY 挂起，worker 不再捡，等人上架。"""
    row.stage = AutoListingStage.READY
    row.attempts = 0
    row.last_error = HELD_READY_CRAWLED if crawled else HELD_READY
    row.next_run_at = None


def _request_crawler_images(db: Session, row: SkuAutoListing) -> None:
    """让图片爬虫按 SPU 搜图。已在搜、已搜到的不重复发（request_for_spu 自己去重）。"""
    from app.models import WarehouseSpu
    from app.services import product_image

    spu = db.get(WarehouseSpu, row.spu_id) if row.spu_id else None
    if spu is not None:
        product_image.request_for_spu(db, spu)


def _crawler_images(db: Session, row: SkuAutoListing) -> tuple[list[str], str | None]:
    """返回 (爬虫的图, 拿不到的原因)。还在搜 → ([], None)。

    爬虫正式池的原图直接用（11-05 老板定：按店铺选图时爬虫图直接挂原图）；
    回填不发布，上架的人还会看到。被员工标了「需处理」的、没搜到的不用。
    """
    from app.models import SpuImageSearch
    from app.services import image_material, product_image

    if not product_image.enabled():
        return [], "图片爬虫没配置"
    search = (
        db.query(SpuImageSearch).filter(SpuImageSearch.spu_id == row.spu_id).first() if row.spu_id else None
    )
    if search is None:
        return [], "发起搜图失败（型号名太短或爬虫连不上），过会儿再点"
    if search.status == SpuImageSearch.SEARCHING:
        return [], None
    if search.status in (SpuImageSearch.REVIEWING, SpuImageSearch.READY):
        from app.models import WarehouseSpu
        from app.services import spu_image_archive

        spu = db.get(WarehouseSpu, row.spu_id) if row.spu_id else None
        pool = spu_image_archive.images_for_spu(db, spu) if spu else []
        if not pool:
            pool = product_image.pool_for_spu(db, row.spu_id)
        # 只拿「可用」的:爬虫评 bad 的(水印、海报字、拼图、人像)待人复核,像头像截图的、员工淘汰的不要
        urls = [p["url"] for p in image_material.usable_crawled(db, pool)]
        if not urls and not pool and search.reference_url:
            urls = [search.reference_url]
        if urls:
            row.image_count = len(urls[:MAX_IMAGES])
            return urls[:MAX_IMAGES], None
        if pool:
            return [], "爬虫搜到的图都不能直接用（水印、海报字、拼图或已淘汰），要拍实拍图"
        if search.status == SpuImageSearch.REVIEWING:
            return [], None  # 搜完了、图还在往图床转存
        return [], "爬虫搜到了但没有能用的图"
    if search.status == SpuImageSearch.REJECTED:
        return [], "爬虫搜的图被员工标了「需处理」"
    return [], f"爬虫没搜到这个型号的图（{search.error or search.status}）"


# ---------------------------------------------------------------- 各阶段

def _stage_resolving(db: Session, row: SkuAutoListing, sku: Sku) -> None:
    match = resolve_spu(db, sku)
    if not match.matched:
        _fail_to_human(row, "解析不出所属 SPU（品牌/型号不在对照表里）")
        return
    row.spu_id = match.spu.id
    row.spu_query = match.query
    row.match_how = match.how
    row.stage = AutoListingStage.COLLECTING
    row.collecting_since = datetime.utcnow()
    row.attempts = 0
    row.last_error = None
    row.next_run_at = datetime.utcnow()


def _stage_collecting(db: Session, row: SkuAutoListing, sku: Sku) -> None:
    price = market_price_for(db, row.spu_query)
    row.market_price = price

    held_images: list[str] = []
    if row.hold_publish:
        info = _info_of(db, sku)
        held_images = list(info.images) if info and info.images else pick_images(sku)
        if not held_images:
            # 没实拍图：先让爬虫按型号去搜着，跟等行情价并行
            _request_crawler_images(db, row)

    from app.services.listing_approval import min_cost_ratio

    resolved, reason = resolve_price(price, sku.cost_price, min_cost_ratio(db))
    if reason == REASON_NO_MARKET_PRICE:
        since = row.collecting_since or datetime.utcnow()
        if datetime.utcnow() - since > COLLECT_TIMEOUT:
            _fail_to_human(row, "等行情价超期（清单里该型号一直没爬到价）")
        else:
            _retry_later(row, "还没有行情价")
        return
    if reason is not None:
        # 行情倒挂等：停下让人看，绝不亏本自动挂
        _fail_to_human(row, f"不自动定价：{reason}（行情 {price} / 成本 {sku.cost_price}）")
        return
    from app.services.auto_listing.market_samples import sample_problem

    sample_reason, why = sample_problem(db, row.spu_query)
    if sample_reason:
        # 样本太少 / 价差太大：均价靠不住，停下让人定价（E04-10）
        _fail_to_human(row, f"不自动定价：{why}（{sample_reason}，行情 {price} / 成本 {sku.cost_price}）")
        return

    if row.hold_publish:
        crawled = False
        if not held_images:
            held_images, why = _crawler_images(db, row)
            if why:
                _fail_to_human(row, f"{MISSING_PHOTO}：没有实拍图，{why}（行情价 {price}）")
                return
            if not held_images:
                # 爬虫还在搜：等机器，不计重试次数
                row.last_error = WAIT_CRAWLER
                row.next_run_at = datetime.utcnow() + IMAGE_POLL_INTERVAL
                return
            crawled = True
        row.resolved_price = resolved
        _fill_listing_info(db, sku, resolved, held_images)
        _hold_ready(row, crawled=crawled)
        return

    images = pick_images(sku)
    if not images:
        # 没拍照的货：按解析出的 SPU 文生图补一张（老板 2026-09-08 定）
        images, err = ensure_images(db, row, sku)
        if err:
            _retry_later(row, err)
            return
        if not images:
            # 机器正在出图，等它——等机器和等人一样，不计进重试次数
            row.next_run_at = datetime.utcnow() + IMAGE_POLL_INTERVAL
            return

    row.resolved_price = resolved
    _write_listing_info(db, sku, resolved, images)
    row.attempts = 0
    row.last_error = None
    # 议价是硬闸门：已议价的直接待发，未议价的停在门闩上
    row.stage = (
        AutoListingStage.READY if sku.negotiated_at is not None else AutoListingStage.WAIT_NEGOTIATION
    )
    row.next_run_at = datetime.utcnow()


def _stage_wait_negotiation(db: Session, row: SkuAutoListing, sku: Sku) -> None:
    if sku.negotiated_at is not None:
        row.stage = AutoListingStage.READY
        row.attempts = 0
        row.last_error = None
        row.next_run_at = datetime.utcnow()
        return
    # 等人议价：慢速轮询，不计入重试次数（等人不是失败）
    row.next_run_at = datetime.utcnow() + timedelta(hours=1)


def _already_listed(db: Session, sku: Sku) -> bool:
    """任一店铺在架/已售即视为已上架。"""
    return (
        db.query(SkuShopListing)
        .filter(
            SkuShopListing.sku_id == sku.id,
            SkuShopListing.publish_status.in_(
                (ShopListingStatus.LISTED, ShopListingStatus.SOLD)
            ),
        )
        .first()
    ) is not None


def _waiting_for_approval(db: Session, sku: Sku) -> bool:
    """开了上架审批、而这件货一个店铺都还没有能用的批准。"""
    from app.services import listing_approval as la

    if not la.approval_required(db):
        return False
    approvals = la.current_by_shop(db, sku.id)
    return all(la.problem_for_publish(db, sku, a) for a in approvals.values()) if approvals else True


def _mark_done(row: SkuAutoListing) -> None:
    row.stage = AutoListingStage.DONE
    row.published_at = datetime.utcnow()
    row.next_run_at = None
    row.last_error = None


def _stage_publishing(db: Session, row: SkuAutoListing, sku: Sku) -> None:
    """已建发布作业，等群控回写。任一店铺在架即视为已上架。"""
    if _already_listed(db, sku):
        _mark_done(row)
        return
    _retry_later(row, "等群控回写上架结果")


def advance(db: Session, row: SkuAutoListing, *, publish=None) -> str:
    """把一行往前推一步，返回推进后的 stage。

    publish: 可调用对象 (db, sku, info) -> job_id，注入以便脱网回归。
             READY 阶段没给 publish 就原地等（worker 会带上真实实现）。
    """
    sku = db.get(Sku, row.sku_id)
    if sku is None:
        _fail_to_human(row, "SKU 不存在")
        return row.stage

    # 出库/锁定的货不该再自动上架
    if sku.status != SkuStatus.IN_STOCK or sku.reserve_source:
        _fail_to_human(row, f"SKU 已不在可上架状态（status={sku.status}）")
        return row.stage

    if row.stage == AutoListingStage.RESOLVING:
        _stage_resolving(db, row, sku)
    elif row.stage == AutoListingStage.COLLECTING:
        _stage_collecting(db, row, sku)
    elif row.stage == AutoListingStage.WAIT_NEGOTIATION:
        _stage_wait_negotiation(db, row, sku)
    elif row.stage == AutoListingStage.READY:
        # 人工上架路径是并行开着的：人已经发过了就让路，别再撞一次「已在架」
        if _already_listed(db, sku):
            _mark_done(row)
        elif row.hold_publish:
            _hold_ready(row, crawled=row.last_error == HELD_READY_CRAWLED)
        elif _waiting_for_approval(db, sku):
            # 等人清洗、审批：跟等议价一样不算失败，慢慢轮询
            row.last_error = "等上架审批（价和每个号的图批过才发）"
            row.next_run_at = datetime.utcnow() + timedelta(hours=1)
        elif publish is None:
            row.next_run_at = datetime.utcnow() + RETRY_BASE
        else:
            info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).first()
            try:
                row.gc_job_id = publish(db, sku, info)
                row.stage = AutoListingStage.PUBLISHING
                row.attempts = 0
                row.last_error = None
                row.next_run_at = datetime.utcnow() + RETRY_BASE
            except Exception as exc:  # noqa: BLE001 - 发布失败要留原因并退避重试
                _retry_later(row, f"发布失败：{exc}")
    elif row.stage == AutoListingStage.PUBLISHING:
        _stage_publishing(db, row, sku)

    return row.stage

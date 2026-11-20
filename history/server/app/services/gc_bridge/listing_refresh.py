"""链接焕新：在架满 N 天没卖掉的链接删掉重发（ERP 这一半）。

老板 2026-10-13 定：一个链接 7 天没有成交就删掉、重新发。每天定时跑一次
（systemd timer → scripts/run_listing_refresh.py）。

# 分工

群控知道每条链接哪天发的、哪个号今天还剩多少发布额度、哪条正有买家在问——由它列单子
（GET /api/gc/listings/refresh-candidates）、执行删和发、记账本。

ERP 知道货还在不在库、现在卖多少钱、该用哪些图——由它逐条判断、**现组**发布内容交给群控。
发布内容非现组不可：当初发布时那份里的商品图是 24 小时过期的签名链接，7 天后拿去重发，
图片必定下载失败，而那时旧链接已经删了。

# 不碰 ERP 的店铺状态

焕新期间 SkuShopListing 一直是 LISTED：业务上这家店一直在卖这件货，只是换了条链接，
删和发之间只空几分钟。gc_job_id 也不打——对账看到群控账本还是 LIVE 会当场把它清掉，
打了也盯不住。进度和失败在群控那边（任务列表 + 失败通知）；重发没成的群控留着占位，
第二天的单子里会再出现，这边照样给内容就是在重试。
"""

from __future__ import annotations

import logging
from collections import Counter
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.config import settings
from app.enums import ShopListingStatus, SkuStatus
from app.models import ListingApproval, SaleShop, Sku, SkuListingInfo, SkuShopListing
from app.services import listing_approval as la
from app.services.gc_bridge import client as gc
from app.services.gc_bridge.assembler import build_publish_spec
from app.services.oss_media import sign_oss_publish_image_url
from app.services.gc_bridge.listing_ops import _resolve_worry_free

logger = logging.getLogger("gc.listing_refresh")


def why_refresh_off() -> str | None:
    """焕新现在整体做不了的原因；能做返回 None。"""
    if not settings.listing_refresh_enabled:
        return "链接焕新未开启（LISTING_REFRESH_ENABLED）"
    if not settings.gc_publish_enabled:
        return "群控上架未启用（GC_PUBLISH_ENABLED）"
    if not settings.gc_publish_confirm:
        # 只填不发模式下焕新 = 只删不发
        return "群控发布是只填不发模式（GC_PUBLISH_CONFIRM=false），焕新会删了旧链接却发不上新的"
    return None


def _schedule_hold(sku: Sku, item: dict) -> str | None:
    """详情页给这件货设的暂停 / 推迟。旧链接已经删了的不拦：闲鱼上正空着，必须发回去。"""
    if item.get("status") == "PENDING_REPUBLISH":
        return None
    if sku.auto_refresh_paused:
        return "这件货暂停了自动上架"
    cn_today = (datetime.utcnow() + timedelta(hours=8)).date()
    if sku.auto_refresh_not_before and cn_today < sku.auto_refresh_not_before:
        return f"这件货排到 {sku.auto_refresh_not_before} 再上架"
    return None


def _refresh_spec(db: Session, item: dict, *, manual: bool = False) -> tuple[str | None, dict | None]:
    """这条链接能不能焕新；能就组好发布内容。返回 (不做的原因, spec)，二者恰有一个非空。

    manual=True 是员工在详情页点的「立即重新上架」，不看这件货的暂停和排程。
    """
    sku = db.query(Sku).filter(Sku.sku_code == item.get("sku")).first()
    if sku is None:
        return "ERP 里没有这个货号", None
    if sku.status != SkuStatus.IN_STOCK:
        return f"货不在库（{sku.status}）", None
    if not manual:
        hold = _schedule_hold(sku, item)
        if hold:
            return hold, None
    rows = (
        db.query(SkuShopListing)
        .filter(SkuShopListing.sku_id == sku.id,
                SkuShopListing.gc_account_id == item.get("account_id"))
        .all()
    )
    # 两个店铺挂在同一个群控账号上时会有两行，对应闲鱼上的同一条链接
    if any(r.gc_job_id for r in rows):
        return "这家店还有上下架在途", None
    listed = [r for r in rows if r.publish_status == ShopListingStatus.LISTED]
    if not listed:
        return "ERP 里这家店不是在架状态", None
    shop = next((s for s in (db.get(SaleShop, r.sale_shop_id) for r in listed) if s and s.enabled), None)
    if shop is None:
        return "店铺已停用", None
    info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).first()
    row = next(r for r in listed if r.sale_shop_id == shop.id)
    # 焕新不等上架审批（用户 11-10 定）：删掉的是已经在架的链接，照原样发回去。
    # 当初按批过的内容发的，还照那份发；那份已经不能用了（成本变了等）就跟没批过一样用原来的图
    approval = None
    if row.listing_approval_id:
        approved = db.get(ListingApproval, row.listing_approval_id)
        if approved is not None and not la.problem_for_publish(db, sku, approved):
            approval = approved
    if approval is None and info is not None and info.ai_image_unconfirmed and not row.images:
        return "上架图是没人确认过的 AI 图", None
    spec = build_publish_spec(sku, info, confirm_publish=settings.gc_publish_confirm,
                              worry_free_sell=_resolve_worry_free(row, shop))
    if approval is None and row.images:
        # 上架时员工给这个号单独挑过图,重发也用这组
        spec["images"] = [u for u in (sign_oss_publish_image_url(x) for x in row.images) if u]
    if approval is not None:
        spec = la.apply_to_spec(spec, approval)
        row.listing_approval_id = approval.id
    return None, spec


async def run_listing_refresh(db: Session, *, dry_run: bool = False, limit: int | None = None) -> dict:
    """跑一轮：拉单子 → 逐条判断、组内容 → 开焕新作业。

    dry_run 只判断不开单（上线前先看一眼会动哪些）；limit 最多开几单（第一次真跑先放一两条）。
    返回 {candidates, created, skipped, held_for_buyers, reasons, created_items}，供脚本打日志。
    """
    data = await gc.list_refresh_candidates()
    items = data.get("items") or []
    rooms = {k: int(v or 0) for k, v in (data.get("rooms") or {}).items()}
    reasons: Counter = Counter()
    created: list[dict] = []

    def skip(item: dict, why: str) -> None:
        reasons[why] += 1
        logger.info("焕新跳过 sku=%s 店铺=%s：%s", item.get("sku"), item.get("account_nick"), why)

    for item in items:
        if limit is not None and len(created) >= limit:
            break
        acc = item.get("account_id")
        if rooms.get(acc, 0) <= 0:
            skip(item, "这个号今天的焕新额度用完了")
            continue
        why, spec = _refresh_spec(db, item)
        if why:
            skip(item, why)
            continue
        if not dry_run:
            try:
                job = await gc.create_refresh_job(item["listing_id"], spec, source="ERP")
            except gc.GcRefreshSkipped as exc:
                skip(item, f"群控：{exc}")
                if "额度" in str(exc):
                    rooms[acc] = 0
                continue
            except gc.GcBridgeError as exc:
                skip(item, f"发布内容不合格：{exc}")
                continue
            item = {**item, "job_id": job.get("id")}
        rooms[acc] = rooms.get(acc, 0) - 1
        created.append(item)
        logger.info("焕新%s sku=%s 店铺=%s 上架于 %s%s", "（预演）" if dry_run else "开单",
                    item.get("sku"), item.get("account_nick"), item.get("published_at"),
                    "（旧链接已删，直接重发）" if item.get("status") == "PENDING_REPUBLISH" else "")
    return {
        "candidates": len(items),
        "created": len(created),
        "skipped": sum(reasons.values()),
        "held_for_buyers": int(data.get("held_for_buyers") or 0),
        "reasons": dict(reasons),
        "created_items": created,
    }

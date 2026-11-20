"""商品详情页的库龄和自动上架管理。

库龄 = 北京时间今天 - 入库那天。7 / 14 / 30 这三条线只用来显示和提醒，到线不会自动降价或下架。

自动上架就是链接焕新（gc_bridge/listing_refresh.py）：每天 09:30 跑一轮，在架满 7 天的删掉重发。
周期在群控 .env，这里只算每条链接下次轮到哪天，并管这一件货的暂停、推迟和手动重新上架。
算出来的是最早时间：当天额度满了或买家在聊，群控会顺延。
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, time, timedelta

from sqlalchemy.orm import Session

from app.config import settings
from app.enums import ShopListingStatus, SkuStatus
from app.models import SaleShop, Sku, SkuShopListing
from app.services.app_settings import get_setting, set_setting
from app.services.gc_bridge import client as gc
from app.services.gc_bridge.listing_refresh import _refresh_spec, why_refresh_off

logger = logging.getLogger("gc.listing_refresh")

STOCK_AGE_THRESHOLDS = "stock_age_thresholds"
DEFAULT_THRESHOLDS = {"target_days": 7, "clearance_days": 14, "max_days": 30}
_MAX_THRESHOLD_DAYS = 365
# deploy/systemd/erp-listing-refresh.timer 的时间
_REFRESH_RUN_AT = time(9, 30)
# 手动重新上架的下限：刚发上去又点一次，等于把新链接删掉再发一遍
_MANUAL_MIN_AGE = timedelta(hours=24)
_MAX_POSTPONE_DAYS = 90
_PENDING_REPUBLISH = "PENDING_REPUBLISH"
_STAGE_LABEL = {"normal": "正常", "clearance": "该清仓", "stale": "滞销"}


class StockAgeError(ValueError):
    """操作不成立，原话给人看。"""


def _cn(dt: datetime) -> datetime:
    return dt + timedelta(hours=8)


def _fmt(cn_dt: datetime | None) -> str | None:
    return cn_dt.strftime("%Y-%m-%d %H:%M") if cn_dt else None


def get_thresholds(db: Session) -> dict:
    try:
        saved = json.loads(get_setting(db, STOCK_AGE_THRESHOLDS) or "{}")
    except ValueError:
        saved = {}
    return {k: int(saved.get(k) or v) for k, v in DEFAULT_THRESHOLDS.items()}


def save_thresholds(db: Session, target_days: int, clearance_days: int, max_days: int,
                    staff_id: str | None) -> dict:
    if not 0 < target_days < clearance_days < max_days <= _MAX_THRESHOLD_DAYS:
        raise StockAgeError(f"天数要从小到大排，最长不超过 {_MAX_THRESHOLD_DAYS} 天")
    value = {"target_days": target_days, "clearance_days": clearance_days, "max_days": max_days}
    set_setting(db, STOCK_AGE_THRESHOLDS, json.dumps(value), staff_id)
    return value


def stock_age(sku: Sku, thresholds: dict, now: datetime) -> dict:
    inbound = sku.inbound_at or sku.created_at
    days = max(0, (_cn(now).date() - _cn(inbound).date()).days) if inbound else 0
    clearance, longest = thresholds["clearance_days"], thresholds["max_days"]
    stage = "normal" if days < clearance else "clearance" if days <= longest else "stale"
    return {
        **thresholds,
        "inbound_at": _fmt(_cn(inbound)) if inbound else None,
        "days": days,
        "stage": stage,
        "stage_label": _STAGE_LABEL[stage],
    }


def _next_run_day(published_at: datetime, min_age_days: int, not_before: date | None, now: datetime) -> date:
    """这条链接最早哪天的 09:30 轮到。"""
    due = _cn(published_at) + timedelta(days=min_age_days)
    day = due.date() if due.time() <= _REFRESH_RUN_AT else due.date() + timedelta(days=1)
    today = _cn(now)
    upcoming = today.date() if today.time() <= _REFRESH_RUN_AT else today.date() + timedelta(days=1)
    return max(day, upcoming, not_before or day)


def _parse_utc(value) -> datetime | None:
    if not value:
        return None
    return value if isinstance(value, datetime) else datetime.fromisoformat(str(value))


def _account_shops(db: Session, sku: Sku) -> dict[str, tuple[SkuShopListing, SaleShop]]:
    """群控账号 → 这件货在这个号上的店铺行。两个店铺挂同一个号时留在架的那行。"""
    rows = (
        db.query(SkuShopListing, SaleShop)
        .join(SaleShop, SaleShop.id == SkuShopListing.sale_shop_id)
        .filter(SkuShopListing.sku_id == sku.id)
        .all()
    )
    rows.sort(key=lambda r: r[0].publish_status == ShopListingStatus.LISTED)
    return {(row.gc_account_id or shop.gc_account_id): (row, shop)
            for row, shop in rows if row.gc_account_id or shop.gc_account_id}


async def build_stock_age(db: Session, sku: Sku, now: datetime | None = None) -> dict:
    now = now or datetime.utcnow()
    ledger, ledger_ok = {"items": []}, False
    if settings.gc_publish_enabled:
        try:
            ledger, ledger_ok = await gc.get_refresh_status(sku.sku_code), True
        except Exception as exc:   # 群控连不上不挡详情页，库龄照常显示
            logger.warning("查链接上架时间失败 sku=%s: %s", sku.sku_code, exc)
    min_age_days = int(ledger.get("min_age_days") or 7)
    in_stock = sku.status == SkuStatus.IN_STOCK
    today = _cn(now).date()

    by_account = {item.get("account_id"): item for item in ledger.get("items") or []}
    shops, last_listed, next_days = [], None, []
    for account_id, (row, shop) in _account_shops(db, sku).items():
        item = by_account.get(account_id)
        cell = {"shop_id": shop.id, "last_label": None, "last_at": None, "next_at": None,
                "next_in_days": None, "note": None, "can_refresh": False}
        if row.publish_status == ShopListingStatus.DELISTED and row.delisted_at:
            cell.update(last_label="上次下架", last_at=_fmt(_cn(row.delisted_at)))
        if row.publish_status == ShopListingStatus.LISTED and item:
            published = _parse_utc(item.get("published_at"))
            if published:
                cell.update(last_label="上次上架", last_at=_fmt(_cn(published)))
                last_listed = max(last_listed or published, published)
            waiting = item.get("status") == _PENDING_REPUBLISH
            if waiting:
                cell["last_label"] = "旧链接已删"
            usable = item.get("usable", True)
            if in_stock and usable and (waiting or not sku.auto_refresh_paused) and (waiting or published):
                day = (_next_run_day(now, 0, None, now) if waiting
                       else _next_run_day(published, min_age_days, sku.auto_refresh_not_before, now))
                next_days.append(day)
                cell.update(next_at=f"{day} 09:30", next_in_days=(day - today).days)
            cell["note"] = item.get("blocker") or (
                f"参加了{item['refresh_skip']}，自动焕新跳过；退出了点「立即重新上架」" if item.get("refresh_skip") else None)
            cell["can_refresh"] = in_stock and not item.get("blocker")
        shops.append(cell)

    next_day = min(next_days) if next_days else None
    return {
        "stock_age": stock_age(sku, get_thresholds(db), now),
        "auto_refresh": {
            "enabled": why_refresh_off() is None,
            "ledger_ok": ledger_ok,
            "paused": bool(sku.auto_refresh_paused),
            "not_before": sku.auto_refresh_not_before.isoformat() if sku.auto_refresh_not_before else None,
            "cycle_days": min_age_days,
            "last_at": _fmt(_cn(last_listed)) if last_listed else None,
            "last_ago_days": (today - _cn(last_listed).date()).days if last_listed else None,
            "next_at": f"{next_day} 09:30" if next_day else None,
            "next_in_days": (next_day - today).days if next_day else None,
        },
        "shops": shops,
    }


def set_auto_refresh(sku: Sku, changes: dict, now: datetime | None = None) -> None:
    """changes 里出现的才改：paused（是否暂停）、not_before（None = 取消推迟）。"""
    if sku.status != SkuStatus.IN_STOCK:
        raise StockAgeError("货不在库，没有自动上架")
    if changes.get("not_before"):
        today = _cn(now or datetime.utcnow()).date()
        day = changes["not_before"]
        if not today < day <= today + timedelta(days=_MAX_POSTPONE_DAYS):
            raise StockAgeError(f"只能排到明天到 {_MAX_POSTPONE_DAYS} 天内")
    if "paused" in changes:
        sku.auto_refresh_paused = bool(changes["paused"])
    if "not_before" in changes:
        sku.auto_refresh_not_before = changes["not_before"]


async def refresh_now(db: Session, sku: Sku, shop_ids: list[str] | None, operator: str,
                      now: datetime | None = None) -> dict:
    """手动重新上架：选中店铺的在架链接删掉重发。走和定时焕新同一条作业和同一份额度。

    买家在聊、刚发不到 24 小时的不动，放进 skipped 告诉人。返回 {created, skipped: [{shop, why}]}。
    """
    why = why_refresh_off()
    if why:
        raise StockAgeError(why)
    now = now or datetime.utcnow()
    try:
        ledger = await gc.get_refresh_status(sku.sku_code)
    except Exception as exc:
        raise StockAgeError("群控连不上，稍后再试") from exc
    shops = _account_shops(db, sku)
    created, skipped = 0, []
    for item in ledger.get("items") or []:
        account_id = item.get("account_id")
        row_shop = shops.get(account_id)
        if row_shop is None or (shop_ids and row_shop[1].id not in shop_ids):
            continue
        label = row_shop[1].label
        published = _parse_utc(item.get("published_at"))
        if item.get("blocker"):
            why = item["blocker"]
        elif item.get("status") != _PENDING_REPUBLISH and published and now - published < _MANUAL_MIN_AGE:
            why = "上架还不到 24 小时"
        else:
            why, spec = _refresh_spec(db, {"sku": sku.sku_code, "account_id": account_id,
                                           "status": item.get("status")}, manual=True)
            if not why:
                try:
                    await gc.create_refresh_job(item["listing_id"], spec, source="MANUAL")
                    created += 1
                    logger.info("手动重新上架 sku=%s 店铺=%s 操作人=%s", sku.sku_code, label, operator)
                except gc.GcBridgeError as exc:
                    why = str(exc)
        if why:
            skipped.append({"shop": label, "why": why})
    return {"created": created, "skipped": skipped}

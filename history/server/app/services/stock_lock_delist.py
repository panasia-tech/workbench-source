"""货被人工锁定 / 出库 / 报损以后，把还挂在各个号上的链接下掉（E05-16）。

以前只有平台售出（gc_bridge/sold_sync.py）会全网下架；换机锁货、手动出库、扫码出库、
手动成交、自提收款出库、报损、盘点报损这些人工入口改了货的状态，在架的号照样挂着，
还能被别的买家拍下——一货多卖。

各入口在**业务已经提交之后**调 after_stock_left：
- 开关（app_setting stock_lock_delist = "1"）关着：只记一条「本来会下架哪些号」
  （日志 + event_log），不碰群控。先看几天记下来的对不对，再打开。
- 开着：交给专用线程建群控全网下架作业（复用 gc_delist_shops，和售出全网下架同一口径）。
  下不成不回滚业务——锁货 / 出库已经算数，只在店铺行上记 last_error、通知管理员去手动下。
"""

from __future__ import annotations

import asyncio
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

from sqlalchemy.orm import Session

from app.config import settings
from app.enums import ShopListingStatus, StaffRole
from app.models import EventLog, SaleShop, Sku, SkuShopListing, Staff
from app.services.app_settings import get_setting

logger = logging.getLogger(__name__)

# 下架是对真实闲鱼的写操作，默认关；"1" 才真的下
ENABLED_KEY = "stock_lock_delist"
EVENT_TYPE = "stock_lock_delist"

_executor: ThreadPoolExecutor | None = None
_lock = threading.Lock()


def enabled(db: Session) -> bool:
    return get_setting(db, ENABLED_KEY, "") == "1"


def _waiting_rows(db: Session, sku_id: str) -> list[SkuShopListing]:
    """还在架、又不在下架途中的店铺行（带着作业号的已经在下了）。"""
    return (
        db.query(SkuShopListing)
        .filter(SkuShopListing.sku_id == sku_id,
                SkuShopListing.publish_status == ShopListingStatus.LISTED,
                SkuShopListing.gc_job_id.is_(None))
        .all()
    )


def _shop_names(db: Session, rows: list[SkuShopListing]) -> list[str]:
    ids = [r.sale_shop_id for r in rows]
    names = dict(db.query(SaleShop.id, SaleShop.label).filter(SaleShop.id.in_(ids)).all()) if ids else {}
    return [names.get(i) or i for i in ids]


def _record(db: Session, sku: Sku, mode: str, reason: str, shops: list[str],
            operator_id: str | None, error: str | None = None, job_id: str | None = None) -> None:
    payload = {"mode": mode, "reason": reason, "shops": shops}
    if error:
        payload["error"] = error
    if job_id:
        payload["job_id"] = job_id
    db.add(EventLog(event_type=EVENT_TYPE, entity_type="sku", entity_id=sku.sku_code,
                    operator_id=operator_id, payload=payload, occurred_at=datetime.utcnow()))


def after_stock_left(db: Session, sku: Sku | None, *, reason: str, operator_id: str | None = None,
                     submit=None) -> None:
    """业务提交之后调。不抛异常——下不下得掉都不能影响已经做完的锁货 / 出库。"""
    if sku is None:
        return
    try:
        rows = _waiting_rows(db, sku.id)
        if not rows:
            return
        shops = _shop_names(db, rows)
        if not enabled(db):
            logger.info("[联动下架·未开] %s %s：本来会下架 %s", reason, sku.sku_code, "、".join(shops))
            _record(db, sku, "DRY_RUN", reason, shops, operator_id)
            db.commit()
            return
        (submit or _submit)(sku.id, reason, operator_id)
    except Exception:  # noqa: BLE001
        db.rollback()
        logger.exception("联动下架没排上：sku=%s reason=%s", getattr(sku, "sku_code", None), reason)


def _submit(sku_id: str, reason: str, operator_id: str | None) -> None:
    """一个线程排队做：请求不等群控，也不占共享线程池。"""
    global _executor
    with _lock:
        if _executor is None:
            _executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="stock-delist")
    _executor.submit(_run_in_thread, sku_id, reason, operator_id)


def _run_in_thread(sku_id: str, reason: str, operator_id: str | None) -> None:
    from app.database import SessionLocal

    try:
        with SessionLocal() as db:
            sku = db.get(Sku, sku_id)
            if sku is not None:
                delist_now(db, sku, reason=reason, operator_id=operator_id)
    except Exception:  # noqa: BLE001
        logger.exception("联动下架线程出错：sku_id=%s", sku_id)


def delist_now(db: Session, sku: Sku, *, reason: str, operator_id: str | None = None,
               run=asyncio.run, notifier=None) -> list[SkuShopListing]:
    """真的建群控下架作业。必须在没有事件循环的线程里调（asyncio.run）。"""
    from app.services.gc_bridge.listing_ops import gc_delist_shops

    rows = _waiting_rows(db, sku.id)
    if not rows:
        return []
    shops = _shop_names(db, rows)
    try:
        if not settings.gc_publish_enabled:
            raise RuntimeError("群控上架没开（GC_PUBLISH_ENABLED）")
        done = run(gc_delist_shops(db, sku))  # 不传店铺 = 群控把这件货所有号上的链接都下掉
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        error = str(exc) or exc.__class__.__name__
        msg = f"{reason}后自动下架没成：{error}，要去闲鱼手动下"
        for row in _waiting_rows(db, sku.id):
            row.last_error = msg[:500]
        _record(db, sku, "FAILED", reason, shops, operator_id, error=error[:300])
        db.commit()
        logger.warning("联动下架失败：%s %s → %s", reason, sku.sku_code, error)
        _notify_admins(db, sku, reason, shops, error, notifier)
        return []
    job_id = done[0].gc_job_id if done else None
    _record(db, sku, "SENT", reason, shops, operator_id, job_id=job_id)
    db.commit()
    logger.info("联动下架已下发：%s %s → %s（作业 %s）", reason, sku.sku_code, "、".join(shops), job_id)
    return done


def _notify_admins(db: Session, sku: Sku, reason: str, shops: list[str], error: str, notifier=None,
                   todo: str = "去闲鱼手动下架，免得被人拍下。") -> None:
    from app.services import staff_notify

    send = notifier or staff_notify.send
    body = (f"{sku.sku_code} {sku.product_name or ''}\n{reason}了，但这些号上的链接没下掉：{'、'.join(shops)}\n"
            f"原因：{error}\n{todo}")
    admins = db.query(Staff).filter(Staff.role == StaffRole.ADMIN, Staff.status == "ACTIVE",
                                    Staff.deleted_at.is_(None))
    for admin in admins:
        try:
            send(admin, f"{reason}后链接没下掉", body)
        except Exception:  # noqa: BLE001 - 发不出去不影响别的
            logger.exception("联动下架通知发送失败")

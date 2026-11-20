"""物流轮询:已发货单据自动跟踪轨迹,签收后完结订单。

节奏(变化驱动退避,按天级精度控制 API 费用):新任务发货 24h 后才首查
(国内快递首日基本不可能签收);有新事件 12h;连续 1-2 次无变化 24h;
3 次以上 48h;发货超 30 天未签收转 EXPIRED 停止轮询。
单票全生命周期约 3-6 次查询。
签收判定:最新轨迹含"签收/代收/驿站/已取出"且不含"拒/失败/异常/退回"。
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.enums import SaleOrderStatus
from app.models import EventLog, SaleOrder
from app.models.logistics_poll import LogisticsPollTask
from app.services.express import get_tracking

logger = logging.getLogger(__name__)

STATE_ACTIVE = "ACTIVE"
STATE_NEED_PHONE = "NEED_PHONE"
STATE_DELIVERED = "DELIVERED"
STATE_EXCEPTION = "EXCEPTION"
STATE_EXPIRED = "EXPIRED"

ENTITY_SALE_ORDER = "SALE_ORDER"

# 退避间隔(天级精度,省 API 费用)
FIRST_CHECK_DELAY = timedelta(hours=24)
INTERVAL_ACTIVE = timedelta(hours=12)
INTERVAL_QUIET = timedelta(hours=24)
INTERVAL_STALE = timedelta(hours=48)
EXPIRE_AFTER = timedelta(days=30)

DELIVERED_KEYWORDS = ("签收", "代收", "驿站", "已取出", "妥投")
NEGATIVE_KEYWORDS = ("拒", "失败", "异常", "退回", "退件", "问题件")
EXCEPTION_KEYWORDS = ("拒收", "退回", "退件", "问题件", "异常")


def _needs_phone(tracking_no: str) -> bool:
    return (tracking_no or "").upper().startswith("SF")


def register_poll(
    db: Session,
    *,
    entity_type: str,
    entity_id: str,
    order_no: str | None,
    tracking_no: str,
    phone_suffix: str | None = None,
    shipped_at: datetime | None = None,
) -> LogisticsPollTask | None:
    tracking_no = (tracking_no or "").strip()
    if not tracking_no:
        return None
    existing = (
        db.query(LogisticsPollTask)
        .filter(
            LogisticsPollTask.entity_type == entity_type,
            LogisticsPollTask.entity_id == entity_id,
            LogisticsPollTask.tracking_no == tracking_no,
        )
        .first()
    )
    if existing:
        if phone_suffix and not existing.phone_suffix:
            existing.phone_suffix = phone_suffix
            if existing.state == STATE_NEED_PHONE:
                existing.state = STATE_ACTIVE
                existing.next_due_at = datetime.utcnow()
        return existing
    now = datetime.utcnow()
    ship_time = shipped_at or now
    task = LogisticsPollTask(
        entity_type=entity_type,
        entity_id=entity_id,
        order_no=order_no,
        tracking_no=tracking_no,
        phone_suffix=(phone_suffix or "").strip() or None,
        state=STATE_NEED_PHONE if (_needs_phone(tracking_no) and not phone_suffix) else STATE_ACTIVE,
        # 发货 24h 内不查(首日不可能签收),老单(补登记)立即可查
        next_due_at=max(now, ship_time + FIRST_CHECK_DELAY),
        shipped_at=ship_time,
    )
    db.add(task)
    return task


def backfill_sale_orders(db: Session) -> int:
    """为已发货且有运单号但还没有轮询任务的销售单补登记(幂等)。"""
    n = 0
    rows = (
        db.query(SaleOrder)
        .filter(SaleOrder.status == SaleOrderStatus.SHIPPED, SaleOrder.tracking_no.isnot(None), SaleOrder.tracking_no != "")
        .all()
    )
    for order in rows:
        task = register_poll(
            db,
            entity_type=ENTITY_SALE_ORDER,
            entity_id=order.id,
            order_no=order.order_no,
            tracking_no=order.tracking_no,
            phone_suffix=order.tracking_phone_suffix,
            shipped_at=order.updated_at,
        )
        if task and task.query_count == 0:
            n += 1
    return n


def _classify(traces: list[dict]) -> str:
    """根据最新轨迹文本判定: delivered / exception / in_transit"""
    if not traces:
        return "in_transit"
    latest = (traces[0].get("context") or "") + (traces[0].get("time") or "")
    for kw in EXCEPTION_KEYWORDS:
        if kw in latest:
            return "exception"
    for kw in DELIVERED_KEYWORDS:
        if kw in latest and not any(neg in latest for neg in NEGATIVE_KEYWORDS):
            return "delivered"
    return "in_transit"


def _complete_sale_order(db: Session, task: LogisticsPollTask) -> None:
    order = db.get(SaleOrder, task.entity_id)
    if order and order.status == SaleOrderStatus.SHIPPED:
        order.status = SaleOrderStatus.COMPLETED
        db.add(EventLog(
            event_type="LOGISTICS_DELIVERED",
            entity_type="sale_order",
            entity_id=order.id,
            payload={
                "order_no": order.order_no,
                "tracking_no": task.tracking_no,
                "last_event": task.last_status,
                "source": "logistics_poll",
            },
            occurred_at=datetime.utcnow(),
        ))


async def poll_one(db: Session, task: LogisticsPollTask) -> str:
    now = datetime.utcnow()
    task.last_checked_at = now
    task.query_count += 1

    if task.shipped_at and now - task.shipped_at > EXPIRE_AFTER:
        task.state = STATE_EXPIRED
        task.note = "发货超30天未签收,停止轮询"
        return "expired"

    try:
        data = await get_tracking(db, task.tracking_no, refresh=True, phone_suffix=task.phone_suffix or "")
    except Exception as exc:  # noqa: BLE001 配置缺失/网络错误,留到下轮
        task.next_due_at = now + INTERVAL_QUIET
        task.note = f"查询失败:{str(exc)[:100]}"
        return "error"

    msg = data.get("msg") or ""
    if not data.get("ok"):
        # 仅在"还没填手机尾号"时才停成 NEED_PHONE；已填尾号还报"手机"多半是顺丰未揽收/暂无数据，继续重试
        if "手机" in msg and not task.phone_suffix:
            task.state = STATE_NEED_PHONE
            task.note = msg[:200]
            return "need_phone"
        task.next_due_at = now + INTERVAL_QUIET
        task.note = f"{data.get('status')}:{msg[:150]}"
        return "error"

    traces = data.get("traces") or []
    latest = traces[0] if traces else {}
    new_event = (latest.get("time") or "") != (task.last_event_at or "")
    task.last_status = (latest.get("context") or "")[:500] or None
    task.last_event_at = latest.get("time") or task.last_event_at

    verdict = _classify(traces)
    if verdict == "delivered":
        task.state = STATE_DELIVERED
        if task.entity_type == ENTITY_SALE_ORDER:
            _complete_sale_order(db, task)
        return "delivered"
    if verdict == "exception":
        task.state = STATE_EXCEPTION
        return "exception"

    task.streak = 0 if new_event else task.streak + 1
    if task.streak == 0:
        task.next_due_at = now + INTERVAL_ACTIVE
    elif task.streak <= 2:
        task.next_due_at = now + INTERVAL_QUIET
    else:
        task.next_due_at = now + INTERVAL_STALE
    return "in_transit"


async def run_poll_batch(db: Session, *, limit: int = 50) -> dict:
    backfilled = backfill_sale_orders(db)
    db.commit()
    now = datetime.utcnow()
    tasks = (
        db.query(LogisticsPollTask)
        .filter(LogisticsPollTask.state == STATE_ACTIVE, LogisticsPollTask.next_due_at <= now)
        .order_by(LogisticsPollTask.next_due_at)
        .limit(limit)
        .all()
    )
    stats: dict[str, int] = {"backfilled": backfilled, "checked": len(tasks)}
    for task in tasks:
        result = await poll_one(db, task)
        stats[result] = stats.get(result, 0) + 1
        db.commit()
    return stats

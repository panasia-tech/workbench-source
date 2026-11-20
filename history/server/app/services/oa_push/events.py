"""OA 推送「事件层」：把 ORM 对象映射成 MCP 工具入参并登记到 outbox。

- 触发点(routers)与存量补推(scripts)都调用这里，保证映射口径一致。
- 每个 on_* 返回本次登记的 outbox id 列表（未启用/被去重则空）。真正投递由 outbox 的
  after_commit 监听器在业务 commit 后完成，调用方无需关心。
- 金额口径复用 services/commission.py 的费率常量，保证与工资单一致。
"""
from __future__ import annotations

import calendar
import json
import logging
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.enums import StaffRole
from app.models import SalesOutbound, Staff
from app.services import commission
from app.services.asset_intake import is_asset_intake_po
from app.services.finance import cn_range_to_utc
from app.services.oa_push import mapping
from app.services.oa_push.outbox import enqueue_push

logger = logging.getLogger(__name__)


def _src() -> str:
    return settings.oa_push_source_system or "erp"


def _round2(x) -> float:
    return round(float(x or 0), 2)


# ── 1) sync_staff_user ────────────────────────────────────────────────────
def build_staff_args(staff: Staff) -> dict[str, Any]:
    """ERP 是员工数据的源头，故恒带 createIfNotExists=true(文档 v1.8)：OA 侧没有该人就建，
    避免新员工同步一律挂 BLOCKED_NO_MAPPING、要人工补 erp_user_mapping。

    createIfNotExists 是 v1.8 新增参数，OA 的 inputSchema 未限制 additionalProperties，
    因此老版本(v1.7)收到会直接忽略、不报错 —— 可以先发,等 OA 升级后自动生效。
    创建模式下 name 与 role 为必填,所以 name 走兜底链(ERP 有 3 个历史账号姓名为空)。
    """
    args: dict[str, Any] = {
        "staffId": staff.id,
        "username": staff.username,
        "role": staff.role,
        "status": mapping.staff_status_to_oa(staff.status),
        "staffNo": staff.staff_no,
        "name": (staff.name or "").strip() or staff.username or staff.staff_no,
        "createIfNotExists": True,
    }
    if staff.shop:
        args["shop"] = staff.shop
    if staff.openid:
        args["openid"] = staff.openid
    if staff.password_hash:
        args["passwordHash"] = staff.password_hash
    return args


def on_staff_synced(db: Session, staff: Staff, *, dedup_ts: Optional[datetime] = None) -> list[str]:
    """员工创建/变更后调用。dedup_ts：存量补推传 staff.updated_at 保证可幂等重跑。"""
    if not settings.oa_push_enabled or not mapping.is_human_role(staff.role):
        return []
    db.flush()  # 新建员工需 flush 以分配 staff.id
    ts = dedup_ts or datetime.utcnow()
    dedup = f"sync_staff|{staff.id}|{ts.strftime('%Y%m%d%H%M%S')}"
    oid = enqueue_push(
        db, "sync_staff_user", build_staff_args(staff),
        dedup_key=dedup, source_type="staff", source_id=staff.id,
    )
    return [oid] if oid else []


# ── 2) push_sale_stat + 3) push_finance_record（出库）──────────────────────
def build_sale_stat_args(outbound: SalesOutbound, sale_order=None) -> dict[str, Any]:
    created = outbound.created_at or datetime.utcnow()
    pay = _round2(outbound.sale_price)
    cost = _round2(outbound.cost_price)
    args: dict[str, Any] = {
        "sourceSystem": _src(),
        "sourceNo": outbound.outbound_no,
        "erpStaffId": outbound.operator_id,
        "erpSkuId": outbound.sku_id,
        "payAmount": pay,
        "refundAmount": 0,
        "netPayAmount": pay,  # 净支付=支付-退款；出库时点退款=0
        "costAmount": cost,
        "grossProfit": round(pay - cost, 2),
        "payOrderCount": 1,
        "payUserCount": 1,
        "periodType": "day",
        "periodValue": mapping.period_day(created),
        "bizDate": mapping.biz_date(created),
    }
    if sale_order is not None:
        if getattr(sale_order, "platform", None):
            args["platform"] = sale_order.platform
        if getattr(sale_order, "shop_name", None):
            args["storeName"] = sale_order.shop_name
        if getattr(sale_order, "id", None):
            args["erpOrderId"] = sale_order.id
    return args


def build_finance_for_outbound(
    outbound: SalesOutbound, purchase_order, operator_role: Optional[str]
) -> list[tuple[dict[str, Any], str]]:
    """返回 [(finance入参, dedup后缀), ...]。金额口径同 commission.py / 工资单。"""
    created = outbound.created_at or datetime.utcnow()
    period = mapping.period_month(created)
    recs: list[tuple[dict[str, Any], str]] = []

    # 采购提成 → 采购单创建人；逾期采购件不发（与工资单一致）；资产录入的货录入人不拿提成
    if (
        purchase_order is not None
        and purchase_order.created_by_id
        and not purchase_order.is_overdue
        and not is_asset_intake_po(purchase_order)
    ):
        margin = (outbound.sale_price or Decimal("0")) - (outbound.cost_price or Decimal("0"))
        recs.append((
            {
                "erpStaffId": purchase_order.created_by_id,
                "settleZone": "income",
                "amount": _round2(margin * commission.PURCHASER_RATE),
                "itemDesc": f"采购提成｜{outbound.outbound_no}",
                "period": period,
            },
            "purchase",
        ))

    # 出库计件 → 操作人，按其角色（镜像 compute_payslip：仓管¥5 / 销售¥10 / 管理员两者兼得）
    role = (operator_role or "").upper()
    if role in (StaffRole.WAREHOUSE, StaffRole.ADMIN):
        recs.append((
            {
                "erpStaffId": outbound.operator_id, "settleZone": "income",
                "amount": float(commission.WAREHOUSE_OUTBOUND_FEE),
                "itemDesc": f"仓管出库计件｜{outbound.outbound_no}", "period": period,
            },
            "wh_outbound",
        ))
    if role in (StaffRole.SALES, StaffRole.ADMIN):
        recs.append((
            {
                "erpStaffId": outbound.operator_id, "settleZone": "income",
                "amount": float(commission.SALES_OUTBOUND_FEE),
                "itemDesc": f"销售出库计件｜{outbound.outbound_no}", "period": period,
            },
            "sales_outbound",
        ))
    return recs


def on_outbound_created(
    db: Session, *, outbound: SalesOutbound, purchase_order=None,
    operator_role: Optional[str] = None, sale_order=None,
) -> list[str]:
    """出库创建后调用（inventory._do_outbound）。推 1 条 sale_stat + 最多 3 条 finance。"""
    if not settings.oa_push_enabled:
        return []
    db.flush()  # 分配 outbound.id
    if sale_order is None and outbound.sale_order_id:
        from app.models import SaleOrder

        sale_order = db.get(SaleOrder, outbound.sale_order_id)
    ids: list[str] = []
    oid = enqueue_push(
        db, "push_sale_stat", build_sale_stat_args(outbound, sale_order),
        dedup_key=f"sale_stat|{outbound.id}", source_type="outbound", source_id=outbound.id,
    )
    if oid:
        ids.append(oid)
    for args, suffix in build_finance_for_outbound(outbound, purchase_order, operator_role):
        oid = enqueue_push(
            db, "push_finance_record", args,
            dedup_key=f"finance|outbound|{outbound.id}|{suffix}",
            source_type="outbound", source_id=outbound.id,
        )
        if oid:
            ids.append(oid)
    return ids


# ── 3) push_finance_record（验货计件）─────────────────────────────────────
def build_inspect_finance_args(inspection) -> dict[str, Any]:
    done_at = inspection.inspected_at or datetime.utcnow()
    return {
        "erpStaffId": inspection.inspector_id,
        "settleZone": "income",
        "amount": float(commission.WAREHOUSE_INSPECT_FEE),
        "itemDesc": f"验货计件｜{inspection.inspect_no}",
        "period": mapping.period_month(done_at),
    }


def on_inspection_done(db: Session, *, inspection) -> list[str]:
    """验货提交置 DONE 后调用。计 ¥5 给验货人。"""
    if not settings.oa_push_enabled or not inspection.inspector_id:
        return []
    oid = enqueue_push(
        db, "push_finance_record", build_inspect_finance_args(inspection),
        dedup_key=f"finance|inspect|{inspection.id}",
        source_type="inspection", source_id=inspection.id,
    )
    return [oid] if oid else []


# ── 5) push_reply_record（匿名反馈处理）──────────────────────────────────
def build_reply_args(feedback, handler_role: Optional[str] = None) -> dict[str, Any]:
    handled = feedback.handled_at or datetime.utcnow()
    args: dict[str, Any] = {
        "sourceSystem": _src(),
        "sourceNo": feedback.id,
        "erpStaffId": feedback.handled_by_id,
        "content": feedback.handled_note or "",
        "replyContent": feedback.content or "",
        "replyTime": mapping.datetime_cn_str(handled),
    }
    if handler_role:
        args["erpRole"] = handler_role  # OA 侧据此匹配 sys_role.role_key 填 roleId（ADMIN→PTADMIN）
    # 回复时长：反馈提交 → 处理完成。缺 created_at 或时序倒挂则不传。
    if feedback.created_at:
        elapsed = int((handled - feedback.created_at).total_seconds())
        if elapsed >= 0:
            args["responseSec"] = elapsed
    return args


def on_feedback_handled(db: Session, *, feedback, handler_role: Optional[str] = None) -> list[str]:
    """匿名反馈被处理(有处理人+处理说明)后调用。"""
    if not settings.oa_push_enabled or not feedback.handled_by_id or not feedback.handled_note:
        return []
    oid = enqueue_push(
        db, "push_reply_record", build_reply_args(feedback, handler_role),
        dedup_key=f"reply|feedback|{feedback.id}",
        source_type="feedback", source_id=feedback.id,
    )
    return [oid] if oid else []


# ── 4) push_kpi_record（月度：销售额达成）────────────────────────────────
def _kpi_targets() -> dict[str, Any]:
    raw = (settings.oa_kpi_targets or "").strip()
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except ValueError:
        logger.warning("OA_KPI_TARGETS 不是合法 JSON，已忽略")
        return {}


def _target_for(staff: Staff, targets: dict[str, Any]) -> Optional[float]:
    for key in (f"staff:{staff.id}", f"role:{staff.role}"):
        if key in targets:
            try:
                return float(targets[key])
            except (TypeError, ValueError):
                return None
    return None


def enqueue_kpi_for_month(db: Session, period_value: str) -> list[str]:
    """结算某月(YYYYMM)各销售员「销售额达成」KPI。无目标者跳过（completionRate 必填）。"""
    if not settings.oa_push_enabled:
        return []
    year, month = int(period_value[:4]), int(period_value[4:6])
    first = date(year, month, 1)
    last = date(year, month, calendar.monthrange(year, month)[1])
    start, end = cn_range_to_utc(first, last)

    rows = (
        db.query(SalesOutbound.operator_id, func.sum(SalesOutbound.sale_price))
        .filter(SalesOutbound.created_at >= start, SalesOutbound.created_at < end)
        .group_by(SalesOutbound.operator_id)
        .all()
    )
    amount_by_staff = {sid: float(total or 0) for sid, total in rows}

    sales_staff = (
        db.query(Staff).filter(Staff.role == StaffRole.SALES, Staff.deleted_at.is_(None)).all()
    )
    ranked = sorted(sales_staff, key=lambda s: amount_by_staff.get(s.id, 0.0), reverse=True)
    rank_of = {s.id: i + 1 for i, s in enumerate(ranked)}
    targets = _kpi_targets()

    ids: list[str] = []
    for s in sales_staff:
        target = _target_for(s, targets)
        if not target:  # 无目标→completionRate 无从谈起，跳过
            continue
        actual = amount_by_staff.get(s.id, 0.0)
        args = {
            "sourceSystem": _src(),
            "sourceNo": f"KPI-SALES-{period_value}-{s.id}",
            "erpStaffId": s.id,
            "erpRole": s.role,
            "kpiName": "销售额达成",
            "periodType": "month",
            "periodValue": period_value,
            "targetValue": round(target, 2),
            "actualValue": round(actual, 2),
            "completionRate": round(actual / target * 100, 2),
            "rankNum": rank_of.get(s.id),
        }
        oid = enqueue_push(
            db, "push_kpi_record", args,
            dedup_key=f"kpi|{s.id}|销售额达成|{period_value}",
            source_type="kpi", source_id=s.id,
        )
        if oid:
            ids.append(oid)
    return ids

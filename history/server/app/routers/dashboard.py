from datetime import date, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user, require_roles
from app.enums import InspectionStatus, SkuStatus, StaffRole
from app.models import Inspection, PurchaseOrder, SalesOutbound, Sku, Staff, StockEvent
from app.schemas._tz import utc_to_cn_iso
from app.schemas.common import AdminPeriodStats, CommissionStats, DashboardSummary, PayslipOut, RecentActivity, WorkloadStats
from app.services.asset_intake import not_asset_intake_inspection, not_asset_intake_po
from app.services.purchase_pieces import not_missing_piece
from app.services.commission import compute_commission, compute_payslip
from app.services.finance import china_today, cn_range_to_utc, cn_today_start_utc

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

PERIOD_KEYS = {"today", "yesterday", "7d", "30d"}


def _period_bounds(period: str) -> tuple[datetime, datetime]:
    """按北京时区计算周期边界，返回可与 created_at(naive UTC) 比较的 UTC naive 区间。"""
    now = datetime.utcnow()
    today = china_today()
    today_start = cn_range_to_utc(today, today)[0]
    if period == "today":
        return today_start, now
    if period == "yesterday":
        y = today - timedelta(days=1)
        return cn_range_to_utc(y, y)
    if period == "7d":
        return cn_range_to_utc(today - timedelta(days=6), today)[0], now
    if period == "30d":
        return cn_range_to_utc(today - timedelta(days=29), today)[0], now
    raise HTTPException(status_code=400, detail="无效统计周期")


def _to_float(val) -> float:
    return float(val or 0)


@router.get("/summary", summary="仪表盘今日概览", response_model=DashboardSummary)
def summary(db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    start = cn_today_start_utc()
    po_q = db.query(PurchaseOrder).filter(PurchaseOrder.created_at >= start, not_asset_intake_po())
    if user.role != StaffRole.ADMIN:
        po_q = po_q.filter(PurchaseOrder.created_by_id == user.id)
    outbound_q = db.query(SalesOutbound).filter(SalesOutbound.created_at >= start)
    if user.role != StaffRole.ADMIN:
        outbound_q = outbound_q.filter(SalesOutbound.operator_id == user.id)
    return DashboardSummary(
        today_purchase=po_q.count(),
        # 待验货 = 真正待处理的验货任务（Inspection PENDING），与验货列表口径一致。
        # 不能数 PurchaseOrder.PENDING_INSPECT：历史/迁移占位单里有大量已验(DONE)或
        # 无验货行的 PO 仍挂 PENDING_INSPECT，会让角标(285)远大于列表实际(10)。
        pending_inspect=db.query(Inspection)
        .filter(Inspection.status == InspectionStatus.PENDING, Inspection.deleted_at.is_(None))
        .count(),
        in_stock=db.query(Sku).filter(Sku.status == SkuStatus.IN_STOCK).count(),
        today_outbound=outbound_q.count(),
    )


@router.get("/activities", summary="最近业务动态", response_model=list[RecentActivity])
def activities(
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    q = db.query(StockEvent)
    if user.role != StaffRole.ADMIN:
        if user.role == StaffRole.PURCHASER:
            q = q.join(PurchaseOrder, StockEvent.purchase_order_id == PurchaseOrder.id).filter(
                PurchaseOrder.created_by_id == user.id
            )
        else:
            q = q.filter(StockEvent.operator_id == user.id)
    events = q.order_by(StockEvent.created_at.desc()).offset(offset).limit(limit).all()
    return [
        RecentActivity(
            event_type=e.event_type,
            ref_no=e.ref_no,
            summary=f"{e.event_type} {e.ref_no or ''}".strip(),
            created_at=utc_to_cn_iso(e.created_at) or "",
        )
        for e in events
    ]


@router.get("/workload", summary="今日工作量统计", response_model=WorkloadStats)
def workload(db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    start = cn_today_start_utc()
    return WorkloadStats(
        today_purchase=db.query(PurchaseOrder)
        .filter(PurchaseOrder.created_by_id == user.id, PurchaseOrder.created_at >= start, not_asset_intake_po())
        .count(),
        today_inspection=db.query(Inspection)
        .filter(
            Inspection.inspector_id == user.id,
            Inspection.inspected_at >= start,
            Inspection.deleted_at.is_(None),
        )
        .count(),
        today_sales=db.query(SalesOutbound)
        .filter(SalesOutbound.operator_id == user.id, SalesOutbound.created_at >= start)
        .count(),
    )


@router.get("/commission", summary="提成统计", response_model=CommissionStats)
def commission(
    period: str = Query("today"),
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    if period not in PERIOD_KEYS | {"month"}:
        raise HTTPException(status_code=400, detail="无效统计周期")
    return compute_commission(db, user, period)


@router.get("/payslip", summary="工资单明细", response_model=PayslipOut)
def payslip(
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    """当前登录员工的工资单明细：按中国日历区间逐笔列出各角色提成，逾期采购件显示 ¥0。"""
    today = china_today()
    df = date_from or today
    dt = date_to or today
    if dt < df:
        raise HTTPException(status_code=400, detail="结束日期不能早于开始日期")
    start, end = cn_range_to_utc(df, dt)
    return compute_payslip(db, user, start, end, df, dt)


@router.get("/admin-stats", summary="管理员周期统计", response_model=AdminPeriodStats)
def admin_stats(
    period: str = Query("today"),
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    if period not in PERIOD_KEYS:
        raise HTTPException(status_code=400, detail="无效统计周期")
    start, end = _period_bounds(period)

    # 资产录入的货算入库，但不算采购、不算验货
    purchase_q = db.query(PurchaseOrder).filter(
        PurchaseOrder.created_at >= start,
        PurchaseOrder.created_at < end,
        not_asset_intake_po(),
    )
    inspection_q = db.query(Inspection).filter(
        Inspection.status == InspectionStatus.DONE,
        Inspection.inspected_at >= start,
        Inspection.inspected_at < end,
        Inspection.deleted_at.is_(None),
        not_asset_intake_inspection(),
        not_missing_piece(),
    )
    inbound_q = db.query(Sku).filter(
        Sku.inbound_at >= start,
        Sku.inbound_at < end,
    )
    outbound_q = db.query(SalesOutbound).filter(
        SalesOutbound.created_at >= start,
        SalesOutbound.created_at < end,
    )

    purchase_amount = db.query(func.coalesce(func.sum(PurchaseOrder.unit_price), 0)).filter(
        PurchaseOrder.created_at >= start,
        PurchaseOrder.created_at < end,
        not_asset_intake_po(),
    ).scalar()
    sales_amount = db.query(func.coalesce(func.sum(SalesOutbound.sale_price), 0)).filter(
        SalesOutbound.created_at >= start,
        SalesOutbound.created_at < end,
    ).scalar()
    gross_profit = db.query(
        func.coalesce(func.sum(SalesOutbound.sale_price - SalesOutbound.cost_price), 0)
    ).filter(
        SalesOutbound.created_at >= start,
        SalesOutbound.created_at < end,
    ).scalar()

    return AdminPeriodStats(
        period=period,
        purchase_count=purchase_q.count(),
        purchase_amount=_to_float(purchase_amount),
        inspection_count=inspection_q.count(),
        inbound_count=inbound_q.count(),
        outbound_count=outbound_q.count(),
        sales_amount=_to_float(sales_amount),
        gross_profit=_to_float(gross_profit),
    )

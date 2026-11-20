from datetime import date
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.enums import InspectionStatus, ReturnOrderStatus, StaffRole
from app.models import DailyBill, Inspection, LedgerAlipay, PurchaseOrder, ReturnOrder, SalesOutbound, Sku, Staff
from app.schemas._tz import utc_to_cn_iso
from app.schemas.finance import (
    DailyBillCreate,
    DailyBillListResponse,
    DailyBillOut,
    DailyBillReminderOut,
    FinancePurchaseItem,
    FinancePurchaseList,
    FinanceSalesItem,
    FinanceSalesList,
    FinanceStatsOut,
)
from app.services.asset_intake import asset_intake_po, not_asset_intake_inspection, not_asset_intake_po
from app.services.purchase_pieces import not_missing_piece
from app.services.commission import (
    PURCHASER_RATE,
    SALES_OUTBOUND_FEE,
    WAREHOUSE_INSPECT_FEE,
    WAREHOUSE_OUTBOUND_FEE,
    platform_fee as outbound_fee,
)
from app.services.finance import china_today, cn_range_to_utc, china_yesterday, format_bill_date_label

router = APIRouter(prefix="/api/finance", tags=["finance"])


def _accounts(db: Session, ids) -> dict[str, str]:
    ids = {i for i in ids if i}
    return {a.id: a.account for a in db.query(LedgerAlipay).filter(LedgerAlipay.id.in_(ids)).all()} if ids else {}


def _to_out(row: DailyBill, uploader_name: str = "", account: str = "") -> DailyBillOut:
    return DailyBillOut(
        id=row.id,
        bill_date=row.bill_date,
        file_url=row.file_url,
        file_name=row.file_name,
        alipay_id=row.alipay_id or "",
        alipay_account=account,
        uploaded_by_name=uploader_name,
        created_at=utc_to_cn_iso(row.created_at) or "",
    )


@router.get("/daily-bills/reminder", summary="查询账单上传提醒", response_model=DailyBillReminderOut)
def daily_bill_reminder(
    _: Staff = Depends(require_roles(StaffRole.FINANCE, StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    missing = china_yesterday()
    exists = db.query(DailyBill.id).filter(DailyBill.bill_date == missing, DailyBill.alipay_id == "").first()
    if exists:
        return DailyBillReminderOut(needs_reminder=False)
    return DailyBillReminderOut(
        needs_reminder=True,
        missing_date=missing.isoformat(),
        missing_date_label=format_bill_date_label(missing),
    )


@router.get("/daily-bills", summary="查询每日账单列表", response_model=DailyBillListResponse)
def list_daily_bills(
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    alipay_id: str | None = Query(None, description="只看台账里这个支付宝的；空串 = ERP 自提收款那个；不传 = 全部"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    _: Staff = Depends(require_roles(StaffRole.FINANCE, StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    q = db.query(DailyBill)
    if date_from:
        q = q.filter(DailyBill.bill_date >= date_from)
    if date_to:
        q = q.filter(DailyBill.bill_date <= date_to)
    if alipay_id is not None:
        q = q.filter(DailyBill.alipay_id == alipay_id)
    total = q.count()
    rows = q.order_by(DailyBill.bill_date.desc()).offset((page - 1) * size).limit(size).all()
    staff_map = {
        s.id: s.name or s.username
        for s in db.query(Staff).filter(Staff.id.in_([r.uploaded_by_id for r in rows])).all()
    } if rows else {}
    accounts = _accounts(db, [r.alipay_id for r in rows])
    return DailyBillListResponse(
        items=[_to_out(r, staff_map.get(r.uploaded_by_id, ""), accounts.get(r.alipay_id, "")) for r in rows],
        total=total,
    )


@router.get("/daily-bills/{bill_date}", summary="查询指定日期账单", response_model=DailyBillOut)
def get_daily_bill(
    bill_date: date,
    alipay_id: str = Query("", description="台账里哪个支付宝；不传 = ERP 自提收款那个"),
    _: Staff = Depends(require_roles(StaffRole.FINANCE, StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    row = db.query(DailyBill).filter(DailyBill.bill_date == bill_date, DailyBill.alipay_id == alipay_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="该日期账单未上传")
    uploader = db.get(Staff, row.uploaded_by_id)
    return _to_out(row, (uploader.name or uploader.username) if uploader else "", _accounts(db, [row.alipay_id]).get(row.alipay_id, ""))


@router.post("/daily-bills", summary="上传每日账单", response_model=DailyBillOut)
def create_daily_bill(
    body: DailyBillCreate,
    user: Staff = Depends(require_roles(StaffRole.FINANCE, StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    if body.bill_date > china_today():
        raise HTTPException(status_code=400, detail="不能上传未来日期的账单")
    account = ""
    if body.alipay_id:
        ali = db.get(LedgerAlipay, body.alipay_id)
        if ali is None:
            raise HTTPException(status_code=400, detail="台账里没有这个支付宝")
        account = ali.account
    existing = db.query(DailyBill).filter(DailyBill.bill_date == body.bill_date,
                                          DailyBill.alipay_id == body.alipay_id).first()
    if existing:
        raise HTTPException(status_code=400, detail="这个户这一天的账单已上传，不可重复提交")
    row = DailyBill(
        bill_date=body.bill_date,
        alipay_id=body.alipay_id,
        file_url=body.file_url,
        file_name=body.file_name,
        uploaded_by_id=user.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return _to_out(row, user.name or user.username, account)


_FINANCE_ROLES = require_roles(StaffRole.FINANCE, StaffRole.ADMIN)


def _resolve_range(date_from: date | None, date_to: date | None) -> tuple[date, date]:
    today = china_today()
    df = date_from or today
    dt = date_to or today
    if dt < df:
        raise HTTPException(status_code=400, detail="结束日期不能早于开始日期")
    return df, dt


@router.get("/stats", summary="查询财务经营汇总", response_model=FinanceStatsOut)
def finance_stats(
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    _: Staff = Depends(_FINANCE_ROLES),
    db: Session = Depends(get_db),
):
    """实时经营汇总：按中国日历区间聚合采购支出、销售收入、成本、毛利、到手收益与退货。"""
    df, dt = _resolve_range(date_from, date_to)
    start, end = cn_range_to_utc(df, dt)

    # 资产录入的占位单不是采购支出（成本是来源系统的账面价，这期没花钱）
    purchase_count = db.query(PurchaseOrder).filter(
        PurchaseOrder.created_at >= start, PurchaseOrder.created_at < end, not_asset_intake_po()
    ).count()
    purchase_amount = db.query(func.coalesce(func.sum(PurchaseOrder.unit_price), 0)).filter(
        PurchaseOrder.created_at >= start, PurchaseOrder.created_at < end, not_asset_intake_po()
    ).scalar()

    outbounds = db.query(SalesOutbound).filter(
        SalesOutbound.created_at >= start, SalesOutbound.created_at < end
    ).all()
    sales_amount = Decimal("0")
    sales_cost = Decimal("0")
    platform_fee = Decimal("0")
    express_total = Decimal("0")
    for ob in outbounds:
        gross = ob.sale_price or Decimal("0")
        cost = ob.cost_price or Decimal("0")
        express = ob.express_fee or Decimal("0")
        # 平台手续费：填了实际服务费用实际的，没填按档估（见 commission.platform_fee）
        fee, _ = outbound_fee(ob)
        sales_amount += gross
        sales_cost += cost
        platform_fee += fee
        express_total += express
    sales_count = len(outbounds)
    gross_profit = sales_amount - sales_cost

    # 退货：本期未取消的退货，回冲已确认的毛利(原出库售价-成本)
    refund_q = (
        db.query(SalesOutbound)
        .join(ReturnOrder, ReturnOrder.outbound_id == SalesOutbound.id)
        .filter(
            ReturnOrder.created_at >= start,
            ReturnOrder.created_at < end,
            ReturnOrder.status != ReturnOrderStatus.CANCELLED,
        )
    )
    return_refund = Decimal("0")  # 退货销售额(展示用)
    return_margin = Decimal("0")  # 退货回冲的毛利(净利扣减用)
    return_count = 0
    for ob in refund_q.all():
        gross = ob.sale_price or Decimal("0")
        cost = ob.cost_price or Decimal("0")
        return_refund += gross
        return_margin += gross - cost
        return_count += 1

    # 员工工资(提成)：采购=毛利×10%，仓管=验货数×5+出库数×5，销售=出库数×10
    inspection_count = db.query(Inspection).filter(
        Inspection.status == InspectionStatus.DONE,
        Inspection.inspected_at >= start,
        Inspection.inspected_at < end,
        Inspection.deleted_at.is_(None),
        # 资产录入的占位验货单没人验，不计件
        not_asset_intake_inspection(),
        not_missing_piece(),
    ).count()
    # 不计入采购提成(工资)基数的出库毛利：逾期采购单、资产录入的货（录入人不拿提成）
    uncommissioned_margin = db.query(
        func.coalesce(func.sum(SalesOutbound.sale_price - SalesOutbound.cost_price), 0)
    ).join(Sku, SalesOutbound.sku_id == Sku.id).join(
        PurchaseOrder, Sku.purchase_order_id == PurchaseOrder.id
    ).filter(
        SalesOutbound.created_at >= start,
        SalesOutbound.created_at < end,
        or_(PurchaseOrder.is_overdue == True, asset_intake_po()),  # noqa: E712
    ).scalar() or Decimal("0")
    purchase_commission = (gross_profit - uncommissioned_margin) * PURCHASER_RATE
    warehouse_commission = inspection_count * WAREHOUSE_INSPECT_FEE + sales_count * WAREHOUSE_OUTBOUND_FEE
    sales_commission = sales_count * SALES_OUTBOUND_FEE
    staff_commission = purchase_commission + warehouse_commission + sales_commission

    # 净利润 = 毛利 − 平台费 − 快递 − 员工提成 − 退货回冲毛利
    net_profit = gross_profit - platform_fee - express_total - staff_commission - return_margin

    return FinanceStatsOut(
        date_from=df.isoformat(),
        date_to=dt.isoformat(),
        purchase_count=purchase_count,
        purchase_amount=float(purchase_amount or 0),
        sales_count=sales_count,
        sales_amount=float(sales_amount),
        sales_cost=float(sales_cost),
        gross_profit=float(gross_profit),
        platform_fee=float(platform_fee),
        express_fee=float(express_total),
        staff_commission=float(staff_commission),
        inspection_count=inspection_count,
        return_count=return_count,
        return_refund=float(return_refund),
        net_profit=float(net_profit),
    )


@router.get("/purchase-details", summary="查询采购支出明细", response_model=FinancePurchaseList)
def finance_purchase_details(
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    _: Staff = Depends(_FINANCE_ROLES),
    db: Session = Depends(get_db),
):
    df, dt = _resolve_range(date_from, date_to)
    start, end = cn_range_to_utc(df, dt)
    q = db.query(PurchaseOrder).filter(
        PurchaseOrder.created_at >= start, PurchaseOrder.created_at < end, not_asset_intake_po()
    )
    total = q.count()
    rows = q.order_by(PurchaseOrder.created_at.desc()).offset((page - 1) * size).limit(size).all()
    return FinancePurchaseList(
        items=[
            FinancePurchaseItem(
                id=r.id,
                order_no=r.order_no,
                created_at=utc_to_cn_iso(r.created_at) or "",
                product_name=r.product_name,
                brand=r.brand,
                model=r.model,
                spec=r.spec,
                unit_price=float(r.unit_price or 0),
                seller_name=r.seller_name,
                purchase_account=r.purchase_account,
            )
            for r in rows
        ],
        total=total,
    )


@router.get("/sales-details", summary="查询销售收入明细", response_model=FinanceSalesList)
def finance_sales_details(
    date_from: date | None = Query(None),
    date_to: date | None = Query(None),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    _: Staff = Depends(_FINANCE_ROLES),
    db: Session = Depends(get_db),
):
    df, dt = _resolve_range(date_from, date_to)
    start, end = cn_range_to_utc(df, dt)
    q = db.query(SalesOutbound).filter(
        SalesOutbound.created_at >= start, SalesOutbound.created_at < end
    )
    total = q.count()
    rows = q.order_by(SalesOutbound.created_at.desc()).offset((page - 1) * size).limit(size).all()
    return FinanceSalesList(
        items=[
            FinanceSalesItem(
                id=r.id,
                outbound_no=r.outbound_no,
                created_at=utc_to_cn_iso(r.created_at) or "",
                outbound_type=r.outbound_type,
                sale_price=float(r.sale_price or 0),
                cost_price=float(r.cost_price or 0),
                gross_profit=float((r.sale_price or 0) - (r.cost_price or 0)),
                express_fee=float(r.express_fee or 0),
                buyer_name=r.buyer_name,
            )
            for r in rows
        ],
        total=total,
    )

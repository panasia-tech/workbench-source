from datetime import date, datetime
from decimal import Decimal

from sqlalchemy.orm import Session

from app.enums import OutboundType, StaffRole
from app.models import Inspection, PurchaseOrder, SalesOutbound, Sku, Staff
from app.schemas.common import CommissionStats, PayslipItem, PayslipOut, PayslipSection
from app.services.asset_intake import not_asset_intake_inspection, not_asset_intake_po
from app.services.purchase_pieces import not_missing_piece

# 平台手续费：出库时填了闲鱼订单页上的实际服务费就用它；没填才估——无忧卖/未标记(历史默认) 2.6%，
# 普通订单 1.6%（鱼小铺 0.6% 基础 + 1%，不封顶），自提 0%
PLATFORM_FEE_RATE = Decimal("0.026")
PLATFORM_FEE_RATE_NORMAL = Decimal("0.016")
PURCHASER_RATE = Decimal("0.10")
WAREHOUSE_INSPECT_FEE = Decimal("5")
WAREHOUSE_OUTBOUND_FEE = Decimal("5")
SALES_OUTBOUND_FEE = Decimal("10")


def platform_fee(ob: SalesOutbound) -> tuple[Decimal, str]:
    """出库单的平台手续费金额与口径名（经营账单、导出、对账共用）。"""
    if ob.outbound_type == OutboundType.PICKUP:
        return Decimal("0"), "自提(0%)"
    if ob.platform_fee is not None:
        return Decimal(ob.platform_fee), "实际"
    gross = ob.sale_price or Decimal("0")
    if ob.worry_free is False:
        return (gross * PLATFORM_FEE_RATE_NORMAL).quantize(Decimal("0.01")), "估·普通(1.6%)"
    return (gross * PLATFORM_FEE_RATE).quantize(Decimal("0.01")), "估·无忧(2.6%)"


def _period_start(period: str):
    """按北京时区计算周期边界，返回可与 created_at(naive UTC) 比较的 UTC naive 区间。"""
    from datetime import datetime

    from app.services.finance import china_today, cn_range_to_utc

    now = datetime.utcnow()
    today = china_today()
    today_start = cn_range_to_utc(today, today)[0]
    if period == "month":
        return cn_range_to_utc(today.replace(day=1), today)[0], now
    return today_start, now


def compute_commission(db: Session, user: Staff, period: str = "today") -> CommissionStats:
    start, end = _period_start(period)
    result = CommissionStats(period=period, platform_fee_rate=float(PLATFORM_FEE_RATE))

    if user.role in (StaffRole.PURCHASER, StaffRole.ADMIN):
        q = (
            db.query(SalesOutbound, PurchaseOrder)
            .join(Sku, SalesOutbound.sku_id == Sku.id)
            .join(PurchaseOrder, Sku.purchase_order_id == PurchaseOrder.id)
            .filter(SalesOutbound.created_at >= start, SalesOutbound.created_at < end)
            # 逾期采购单不发放采购基础提成
            .filter(PurchaseOrder.is_overdue == False)  # noqa: E712
            # 资产录入的货录入人不拿提成
            .filter(not_asset_intake_po())
        )
        if user.role != StaffRole.ADMIN:
            q = q.filter(PurchaseOrder.created_by_id == user.id)
        total = Decimal("0")
        count = 0
        for outbound, _po in q.all():
            margin = outbound.sale_price - outbound.cost_price
            total += margin * PURCHASER_RATE
            count += 1
        result.purchase_commission = float(total)
        result.detail["purchase_outbound_count"] = count

    if user.role in (StaffRole.WAREHOUSE, StaffRole.ADMIN):
        insp_q = db.query(Inspection).filter(
            Inspection.inspected_at >= start,
            Inspection.inspected_at < end,
            Inspection.status == "DONE",
            # 资产录入的占位验货单没人验，不计件
            not_asset_intake_inspection(),
            # 一单多件里标「没到货」的那件没验，不计件
            not_missing_piece(),
        )
        out_q = db.query(SalesOutbound).filter(SalesOutbound.created_at >= start, SalesOutbound.created_at < end)
        if user.role != StaffRole.ADMIN:
            insp_q = insp_q.filter(Inspection.inspector_id == user.id)
            out_q = out_q.filter(SalesOutbound.operator_id == user.id)
        insp_count = insp_q.count()
        out_count = out_q.count()
        wh_total = insp_count * WAREHOUSE_INSPECT_FEE + out_count * WAREHOUSE_OUTBOUND_FEE
        result.warehouse_commission = float(wh_total)
        result.detail["inspection_count"] = insp_count
        result.detail["warehouse_outbound_count"] = out_count

    if user.role in (StaffRole.SALES, StaffRole.ADMIN):
        out_q = db.query(SalesOutbound).filter(SalesOutbound.created_at >= start, SalesOutbound.created_at < end)
        if user.role != StaffRole.ADMIN:
            out_q = out_q.filter(SalesOutbound.operator_id == user.id)
        sales_count = out_q.count()
        result.sales_commission = float(sales_count * SALES_OUTBOUND_FEE)
        result.detail["sales_outbound_count"] = sales_count

    # 注：原「到手参考」已下线，经营收益统一由 /api/finance/stats 的利润表口径提供。

    result.total_commission = result.purchase_commission + result.warehouse_commission + result.sales_commission
    return result


def compute_payslip(
    db: Session, user: Staff, start: datetime, end: datetime, date_from: date, date_to: date
) -> PayslipOut:
    """工资单明细：按角色分块、逐笔列出，与汇总口径一致但展开到每一笔。

    与 compute_commission 的总额一致（逾期件提成为 0，等价于汇总里把它们剔除），
    区别是逾期采购件**仍会列出来、提成显示 ¥0 并标记 is_overdue**，让员工看到原因。
    """
    is_admin = user.role == StaffRole.ADMIN
    sections: list[PayslipSection] = []
    grand_total = Decimal("0")

    # ---- 采购：按已售出商品的毛利(售价-成本)×10% 分成；逾期采购件不发、显示 ¥0 ----
    if user.role in (StaffRole.PURCHASER, StaffRole.ADMIN):
        q = (
            db.query(SalesOutbound, PurchaseOrder, Sku)
            .join(Sku, SalesOutbound.sku_id == Sku.id)
            .join(PurchaseOrder, Sku.purchase_order_id == PurchaseOrder.id)
            .filter(SalesOutbound.created_at >= start, SalesOutbound.created_at < end)
            # 资产录入的货录入人不拿提成
            .filter(not_asset_intake_po())
        )
        if not is_admin:
            q = q.filter(PurchaseOrder.created_by_id == user.id)
        items: list[PayslipItem] = []
        sec_total = Decimal("0")
        overdue_count = 0
        for ob, po, sku in q.order_by(SalesOutbound.created_at.desc()).all():
            margin = (ob.sale_price or Decimal("0")) - (ob.cost_price or Decimal("0"))
            if po.is_overdue:
                commission = Decimal("0")
                overdue_count += 1
            else:
                commission = margin * PURCHASER_RATE
            sec_total += commission
            items.append(PayslipItem(
                kind="purchase", ref_no=po.order_no,
                product_name=sku.product_name, sku_code=sku.sku_code,
                occurred_at=ob.created_at, base_amount=float(margin),
                commission=float(commission), is_overdue=po.is_overdue,
            ))
        sections.append(PayslipSection(
            role="PURCHASER", title="采购提成", commission_total=float(sec_total),
            note="已售出商品毛利(售价−成本)×10%；逾期采购(快件已进浙江/派送/签收)不发，显示 ¥0",
            overdue_count=overdue_count, items=items,
        ))
        grand_total += sec_total

    # ---- 仓管：验货 ¥5/件 + 出库 ¥5/件（计件，与逾期无关）----
    if user.role in (StaffRole.WAREHOUSE, StaffRole.ADMIN):
        items = []
        sec_total = Decimal("0")
        insp_q = (
            db.query(Inspection, PurchaseOrder)
            .join(PurchaseOrder, Inspection.purchase_order_id == PurchaseOrder.id)
            .filter(Inspection.inspected_at >= start, Inspection.inspected_at < end, Inspection.status == "DONE")
            # 资产录入的占位验货单没人验，不计件
            .filter(not_asset_intake_inspection(), not_missing_piece())
        )
        if not is_admin:
            insp_q = insp_q.filter(Inspection.inspector_id == user.id)
        for insp, po in insp_q.order_by(Inspection.inspected_at.desc()).all():
            sec_total += WAREHOUSE_INSPECT_FEE
            items.append(PayslipItem(
                kind="inspect", ref_no=insp.inspect_no, product_name=po.product_name,
                occurred_at=insp.inspected_at, commission=float(WAREHOUSE_INSPECT_FEE),
            ))
        out_q = (
            db.query(SalesOutbound, Sku).join(Sku, SalesOutbound.sku_id == Sku.id)
            .filter(SalesOutbound.created_at >= start, SalesOutbound.created_at < end)
        )
        if not is_admin:
            out_q = out_q.filter(SalesOutbound.operator_id == user.id)
        for ob, sku in out_q.order_by(SalesOutbound.created_at.desc()).all():
            sec_total += WAREHOUSE_OUTBOUND_FEE
            items.append(PayslipItem(
                kind="warehouse_outbound", ref_no=ob.outbound_no,
                product_name=sku.product_name, sku_code=sku.sku_code,
                occurred_at=ob.created_at, commission=float(WAREHOUSE_OUTBOUND_FEE),
            ))
        sections.append(PayslipSection(
            role="WAREHOUSE", title="仓管提成", commission_total=float(sec_total),
            note="验货 ¥5/件 + 出库 ¥5/件", items=items,
        ))
        grand_total += sec_total

    # ---- 销售：出库 ¥10/件（计件，与逾期无关）----
    if user.role in (StaffRole.SALES, StaffRole.ADMIN):
        items = []
        sec_total = Decimal("0")
        out_q = (
            db.query(SalesOutbound, Sku).join(Sku, SalesOutbound.sku_id == Sku.id)
            .filter(SalesOutbound.created_at >= start, SalesOutbound.created_at < end)
        )
        if not is_admin:
            out_q = out_q.filter(SalesOutbound.operator_id == user.id)
        for ob, sku in out_q.order_by(SalesOutbound.created_at.desc()).all():
            sec_total += SALES_OUTBOUND_FEE
            items.append(PayslipItem(
                kind="sales", ref_no=ob.outbound_no,
                product_name=sku.product_name, sku_code=sku.sku_code,
                occurred_at=ob.created_at, commission=float(SALES_OUTBOUND_FEE),
            ))
        sections.append(PayslipSection(
            role="SALES", title="销售提成", commission_total=float(sec_total),
            note="出库 ¥10/件", items=items,
        ))
        grand_total += sec_total

    return PayslipOut(
        date_from=date_from, date_to=date_to,
        total_commission=float(grand_total), sections=sections,
    )

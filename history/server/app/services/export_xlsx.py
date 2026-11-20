"""管理后台记录导出（xlsx 字节流）。

导出「列表页当前筛选条件下的全部记录」，查询逻辑与列表接口共用（见对应 router）。
时间列统一转北京时间字符串；状态/类型写中文，文案与管理后台列表展示一致。
"""

import io
from datetime import datetime
from decimal import Decimal

from openpyxl import Workbook

from app.enums import OrderStatus, OutboundType
from app.models import PurchaseOrder, SalesOutbound, Sku
from app.schemas._tz import utc_to_cn
from app.services.commission import platform_fee

# 单次导出行数上限（一次性内存生成，超出提示缩小日期范围）
EXPORT_MAX_ROWS = 50_000

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

PURCHASE_STATUS_LABELS = {
    OrderStatus.PENDING_INSPECT: "待验货",
    OrderStatus.IN_STOCK: "在库",
    OrderStatus.SHIPPED: "已出库",
    OrderStatus.LOSS: "盘亏",
    OrderStatus.CANCELLED: "已取消",
}

OUTBOUND_TYPE_LABELS = {
    OutboundType.ORDER_SHIP: "订单发货",
    OutboundType.PICKUP: "自提",
    OutboundType.SWITCH: "切单",
    OutboundType.MANUAL: "手动成交",
}


def _cn_time(dt: datetime | None) -> str:
    cn = utc_to_cn(dt)
    return cn.strftime("%Y-%m-%d %H:%M:%S") if cn else ""


def _num(value: Decimal | None) -> float | None:
    return float(value) if value is not None else None


def _build_sheet(title: str, headers: list[str], widths: list[int], rows) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = title
    ws.append(headers)
    for row in rows:
        ws.append(row)
    for idx, width in enumerate(widths):
        ws.column_dimensions[chr(ord("A") + idx)].width = width
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def build_purchase_export(
    orders: list[PurchaseOrder],
    names: dict[str, str],
    unnegotiated_ids: set[str],
) -> bytes:
    """采购记录导出。unnegotiated_ids：从未议价的采购单 id 集合（审计口径，见 router）。"""
    headers = [
        "采购单号", "状态", "商品名", "品牌", "型号", "规格", "成交金额",
        "闲鱼订单号", "交易流水号", "物流单号", "卖家昵称", "采购账号",
        "逾期采购", "未议价", "货况警示", "操作人", "下单时间", "付款时间", "创建时间", "备注",
    ]
    widths = [16, 9, 24, 12, 14, 12, 10, 22, 22, 18, 14, 12, 9, 9, 10, 10, 20, 20, 20, 24]
    rows = (
        [
            o.order_no,
            PURCHASE_STATUS_LABELS.get(o.status, o.status),
            o.product_name,
            o.brand or "",
            o.model or "",
            o.spec or "",
            _num(o.unit_price),
            o.external_order_no or "",
            o.transaction_no or "",
            o.tracking_no or "",
            o.seller_name or "",
            o.purchase_account or "",
            "是" if o.is_overdue else "",
            "是" if o.id in unnegotiated_ids else "",
            (o.condition_warning_text or "是") if o.condition_warning else "",
            names.get(o.created_by_id) or "",
            _cn_time(o.order_time),
            _cn_time(o.paid_at),
            _cn_time(o.created_at),
            o.remark or "",
        ]
        for o in orders
    )
    return _build_sheet("采购记录", headers, widths, rows)


def build_outbound_export(
    rows: list[tuple[SalesOutbound, Sku]],
    names: dict[str, str],
    returned_ids: set[str],
) -> bytes:
    """出库流水导出（含成本/手续费/到手收益）。returned_ids：存在未取消退货单的出库 id。
    到手收益 = 售价 - 成本 - 平台手续费 - 快递费；已退货行的收益已在经营账单按退货回冲，
    此处逐行仍展示原值并打「已退货」标记，由使用者自行剔除。"""
    headers = [
        "出库单号", "出库类型", "货号", "商品名", "规格", "买家",
        "售价", "成本价", "手续费口径", "平台手续费", "快递费", "到手收益",
        "已退货", "物流单号", "操作人", "出库时间",
    ]
    widths = [14, 10, 16, 24, 12, 14, 10, 10, 11, 11, 9, 10, 8, 18, 10, 20]

    def _rows():
        for ob, sku in rows:
            gross = ob.sale_price or Decimal("0")
            cost = ob.cost_price or Decimal("0")
            express = ob.express_fee or Decimal("0")
            fee, fee_label = platform_fee(ob)
            yield [
                ob.outbound_no,
                OUTBOUND_TYPE_LABELS.get(ob.outbound_type, ob.outbound_type),
                sku.sku_code,
                sku.product_name,
                sku.spec or "",
                ob.buyer_name or "",
                _num(ob.sale_price),
                _num(ob.cost_price),
                fee_label,
                float(fee),
                _num(ob.express_fee),
                float(gross - cost - fee - express),
                "是" if ob.id in returned_ids else "",
                ob.tracking_no or "",
                names.get(ob.operator_id) or "",
                _cn_time(ob.created_at),
            ]

    return _build_sheet("出库流水", headers, widths, _rows())

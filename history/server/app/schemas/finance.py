from datetime import date

from pydantic import BaseModel, Field


class DailyBillCreate(BaseModel):
    bill_date: date = Field(description="账单日期")
    file_url: str = Field(min_length=1, max_length=512, description="账单文件 URL")
    file_name: str = Field(min_length=1, max_length=256, description="账单文件名")
    alipay_id: str = Field(default="", max_length=36, description="台账里哪个支付宝的账单，不填 = ERP 自提收款那个")


class DailyBillOut(BaseModel):
    id: str = Field(description="主键 ID")
    bill_date: date = Field(description="账单日期")
    file_url: str = Field(description="账单文件 URL")
    file_name: str = Field(description="账单文件名")
    alipay_id: str = Field(default="", description="台账里哪个支付宝，空 = ERP 自提收款那个")
    alipay_account: str = Field(default="", description="支付宝账号，空 = ERP 自提收款那个")
    uploaded_by_name: str = Field(default="", description="上传人姓名")
    created_at: str = Field(default="", description="创建时间")


class DailyBillListResponse(BaseModel):
    items: list[DailyBillOut] = Field(description="每日账单列表")
    total: int = Field(description="总数")


class DailyBillReminderOut(BaseModel):
    needs_reminder: bool = Field(description="是否需要提醒上传账单")
    missing_date: str | None = Field(default=None, description="缺失的账单日期")
    missing_date_label: str | None = Field(default=None, description="缺失日期的展示文案")


class FinanceStatsOut(BaseModel):
    date_from: str = Field(description="统计开始日期")
    date_to: str = Field(description="统计结束日期")
    purchase_count: int = Field(default=0, description="采购单数")
    purchase_amount: float = Field(default=0, description="采购支出金额")
    sales_count: int = Field(default=0, description="销售出库单数")
    sales_amount: float = Field(default=0, description="销售收入金额")
    sales_cost: float = Field(default=0, description="销售成本")
    gross_profit: float = Field(default=0, description="毛利（销售额-成本）")
    platform_fee: float = Field(default=0, description="平台手续费")
    express_fee: float = Field(default=0, description="快递费")
    staff_commission: float = Field(default=0, description="员工提成（工资）合计")
    inspection_count: int = Field(default=0, description="验货完成数")
    return_count: int = Field(default=0, description="退货单数")
    return_refund: float = Field(default=0, description="退货销售额")
    net_profit: float = Field(default=0, description="净利润（毛利-平台费-快递-提成-退货回冲）")


class FinancePurchaseItem(BaseModel):
    id: str = Field(description="主键 ID")
    order_no: str = Field(description="采购单号")
    created_at: str = Field(description="创建时间")
    product_name: str = Field(description="商品名称")
    brand: str | None = Field(default=None, description="品牌")
    model: str | None = Field(default=None, description="型号")
    spec: str | None = Field(default=None, description="规格")
    unit_price: float = Field(default=0, description="单价")
    seller_name: str | None = Field(default=None, description="卖家名称")
    purchase_account: str | None = Field(default=None, description="采购账号")


class FinancePurchaseList(BaseModel):
    items: list[FinancePurchaseItem] = Field(description="采购支出明细列表")
    total: int = Field(description="总数")


class FinanceSalesItem(BaseModel):
    id: str = Field(description="主键 ID")
    outbound_no: str = Field(description="出库单号")
    created_at: str = Field(description="创建时间")
    outbound_type: str = Field(
        description="出库类型：ORDER_SHIP=订单发货 / PICKUP=自提 / SWITCH=切单 / MANUAL=手动成交"
    )
    sale_price: float = Field(default=0, description="销售售价")
    cost_price: float = Field(default=0, description="成本价")
    gross_profit: float = Field(default=0, description="毛利（售价-成本）")
    express_fee: float = Field(default=0, description="快递费")
    buyer_name: str | None = Field(default=None, description="买家名称")


class FinanceSalesList(BaseModel):
    items: list[FinanceSalesItem] = Field(description="销售收入明细列表")
    total: int = Field(description="总数")

from datetime import date

from pydantic import BaseModel, Field, model_validator

from app.schemas._tz import CNDatetime


class UploadTokenRequest(BaseModel):
    dir: str = Field(description="上传目录前缀")
    filename: str | None = Field(default=None, description="文件名，缺省时用随机名")


class UploadTokenResponse(BaseModel):
    upload_url: str = Field(description="预签名 PUT 上传地址")
    object_key: str = Field(description="OSS 对象 key")
    public_url: str = Field(description="公网访问地址")
    access_url: str = Field(description="预签名 GET 访问地址")
    expires_in: int = Field(description="凭证有效期（秒）")


class OssUploadResponse(BaseModel):
    object_key: str = Field(description="OSS 对象 key")
    public_url: str = Field(description="公网访问地址")
    access_url: str = Field(description="预签名 GET 访问地址")


class OcrRequest(BaseModel):
    image_url: str | None = Field(default=None, description="图片 URL，与 image_base64 二选一")
    image_base64: str | None = Field(default=None, description="图片 base64，与 image_url 二选一")

    @model_validator(mode="after")
    def require_image_source(self):
        if not self.image_url and not self.image_base64:
            raise ValueError("需要提供 image_url 或 image_base64")
        return self


class DashboardSummary(BaseModel):
    pending_inspect: int = Field(default=0, description="待验货数量")
    in_stock: int = Field(default=0, description="在库 SKU 数量")
    today_purchase: int = Field(default=0, description="今日采购单数")
    today_outbound: int = Field(default=0, description="今日出库数")


class RecentActivity(BaseModel):
    event_type: str = Field(description="事件类型（库存事件）")
    ref_no: str | None = Field(description="关联单号")
    summary: str = Field(description="动态摘要")
    created_at: str = Field(description="发生时间（北京时间 ISO）")


class WorkloadStats(BaseModel):
    today_purchase: int = Field(default=0, description="今日采购单数")
    today_inspection: int = Field(default=0, description="今日验货数")
    today_sales: int = Field(default=0, description="今日销售出库数")


class AdminPeriodStats(BaseModel):
    period: str = Field(description="统计周期 today=今日 / yesterday=昨日 / 7d=近7天 / 30d=近30天")
    purchase_count: int = Field(default=0, description="采购单数")
    purchase_amount: float = Field(default=0, description="采购金额")
    inspection_count: int = Field(default=0, description="验货完成数")
    inbound_count: int = Field(default=0, description="入库数")
    outbound_count: int = Field(default=0, description="出库数")
    sales_amount: float = Field(default=0, description="销售额")
    gross_profit: float = Field(default=0, description="毛利")


class MasterAccountOut(BaseModel):
    id: str = Field(description="主键 ID")
    code: str = Field(description="账号编码")
    label: str = Field(description="账号名称")
    enabled: bool = Field(description="是否启用")
    sort_order: int = Field(description="排序值")

    model_config = {"from_attributes": True}


class MasterLocationOut(BaseModel):
    id: str = Field(description="主键 ID")
    code: str = Field(description="库位编码")
    zone: str | None = Field(description="区域")
    enabled: bool = Field(description="是否启用")
    sort_order: int = Field(description="排序值")

    model_config = {"from_attributes": True}


class MasterAccountCreate(BaseModel):
    code: str = Field(description="账号编码")
    label: str = Field(description="账号名称")
    enabled: bool = Field(default=True, description="是否启用")
    sort_order: int = Field(default=0, description="排序值")


class MasterAccountUpdate(BaseModel):
    label: str | None = Field(default=None, description="账号名称")
    enabled: bool | None = Field(default=None, description="是否启用")
    sort_order: int | None = Field(default=None, description="排序值")


class MasterLocationCreate(BaseModel):
    code: str = Field(description="库位编码")
    zone: str | None = Field(default=None, description="区域")
    enabled: bool = Field(default=True, description="是否启用")
    sort_order: int = Field(default=0, description="排序值")


class MasterLocationUpdate(BaseModel):
    zone: str | None = Field(default=None, description="区域")
    enabled: bool | None = Field(default=None, description="是否启用")
    sort_order: int | None = Field(default=None, description="排序值")


class WarehouseTagOut(BaseModel):
    id: str = Field(description="主键 ID")
    name: str = Field(description="标签名称")
    enabled: bool = Field(description="是否启用")
    sort_order: int = Field(description="排序值")
    prompt: str | None = Field(default=None, description="AI 重绘提示词")
    ai_size: str | None = Field(default=None, description="AI 出图尺寸")
    ai_resolution: str | None = Field(default=None, description="AI 出图分辨率")

    model_config = {"from_attributes": True}


class WarehouseTagCreate(BaseModel):
    name: str = Field(description="标签名称")
    enabled: bool = Field(default=True, description="是否启用")
    sort_order: int = Field(default=0, description="排序值")
    prompt: str | None = Field(default=None, description="AI 重绘提示词")
    ai_size: str | None = Field(default=None, description="AI 出图尺寸")
    ai_resolution: str | None = Field(default=None, description="AI 出图分辨率")


class WarehouseTagUpdate(BaseModel):
    name: str | None = Field(default=None, description="标签名称")
    enabled: bool | None = Field(default=None, description="是否启用")
    sort_order: int | None = Field(default=None, description="排序值")
    prompt: str | None = Field(default=None, description="AI 重绘提示词")
    ai_size: str | None = Field(default=None, description="AI 出图尺寸")
    ai_resolution: str | None = Field(default=None, description="AI 出图分辨率")


class ProductTypeOut(BaseModel):
    id: str = Field(description="主键 ID")
    name: str = Field(description="种类类型名称")
    enabled: bool = Field(description="是否启用")
    sort_order: int = Field(description="排序值")
    prompt: str | None = Field(default=None, description="AI 生图/重绘提示词")
    ai_size: str | None = Field(default=None, description="AI 出图尺寸")
    ai_resolution: str | None = Field(default=None, description="AI 出图分辨率")

    model_config = {"from_attributes": True}


class ProductTypeCreate(BaseModel):
    name: str = Field(description="种类类型名称")
    enabled: bool = Field(default=True, description="是否启用")
    sort_order: int = Field(default=0, description="排序值")
    prompt: str | None = Field(default=None, description="AI 生图/重绘提示词")
    ai_size: str | None = Field(default=None, description="AI 出图尺寸")
    ai_resolution: str | None = Field(default=None, description="AI 出图分辨率")


class ProductTypeUpdate(BaseModel):
    name: str | None = Field(default=None, description="种类类型名称")
    enabled: bool | None = Field(default=None, description="是否启用")
    sort_order: int | None = Field(default=None, description="排序值")
    prompt: str | None = Field(default=None, description="AI 生图/重绘提示词")
    ai_size: str | None = Field(default=None, description="AI 出图尺寸")
    ai_resolution: str | None = Field(default=None, description="AI 出图分辨率")


class MasterSaleShopOut(BaseModel):
    id: str = Field(description="主键 ID")
    code: str = Field(description="店铺编码")
    label: str = Field(description="店铺名称")
    xianyu_user_name: str = Field(description="闲鱼账号名")
    enabled: bool = Field(description="是否启用")
    sort_order: int = Field(description="排序值")
    worry_free_sell: bool = Field(default=False, description="无忧卖账号级默认(可被单商品覆盖)")

    model_config = {"from_attributes": True}


class MasterSaleShopCreate(BaseModel):
    code: str = Field(description="店铺编码")
    label: str = Field(description="店铺名称")
    xianyu_user_name: str = Field(description="闲鱼账号名")
    enabled: bool = Field(default=True, description="是否启用")
    sort_order: int = Field(default=0, description="排序值")
    worry_free_sell: bool = Field(default=False, description="无忧卖账号级默认(可被单商品覆盖)")


class MasterSaleShopUpdate(BaseModel):
    label: str | None = Field(default=None, description="店铺名称")
    xianyu_user_name: str | None = Field(default=None, description="闲鱼账号名")
    enabled: bool | None = Field(default=None, description="是否启用")
    sort_order: int | None = Field(default=None, description="排序值")
    worry_free_sell: bool | None = Field(default=None, description="无忧卖账号级默认(可被单商品覆盖)")


class CommissionStats(BaseModel):
    period: str = Field(default="today", description="统计周期 today=今日 / yesterday=昨日 / 7d=近7天 / 30d=近30天 / month=本月")
    purchase_commission: float = Field(default=0, description="采购提成")
    warehouse_commission: float = Field(default=0, description="仓管提成")
    sales_commission: float = Field(default=0, description="销售提成")
    total_commission: float = Field(default=0, description="提成合计")
    platform_fee_rate: float = Field(default=0.026, description="平台手续费率")
    net_received_hint: float | None = Field(default=None, description="到手收益提示")
    detail: dict = Field(default_factory=dict, description="明细")


# ---------- 工资单明细（按角色分块、逐笔列出，逾期采购件显示 ¥0） ----------
class PayslipItem(BaseModel):
    kind: str = Field(description="purchase(采购按已售毛利分成) / inspect(验货计件) / warehouse_outbound(仓管出库计件) / sales(销售出库计件)")
    ref_no: str = Field(description="采购单号 / 验货单号 / 出库单号")
    product_name: str | None = Field(default=None, description="商品名称")
    sku_code: str | None = Field(default=None, description="SKU 编码")
    occurred_at: CNDatetime | None = Field(default=None, description="出库时间 / 验货时间")
    base_amount: float = Field(default=0, description="采购：该件毛利（售价-成本）；计件项无意义为 0")
    commission: float = Field(default=0, description="实发提成（逾期采购件为 0）")
    is_overdue: bool = Field(default=False, description="仅采购项可能为真：快件已进浙江/派送/签收，逾期不发提成")


class PayslipSection(BaseModel):
    role: str = Field(description="PURCHASER / WAREHOUSE / SALES")
    title: str = Field(description="分块标题")
    commission_total: float = Field(default=0, description="该块提成合计")
    note: str | None = Field(default=None, description="计费口径说明，如「验货 ¥5/件 + 出库 ¥5/件」")
    overdue_count: int = Field(default=0, description="该块内逾期(¥0)条数，便于前端提示")
    items: list[PayslipItem] = Field(default_factory=list, description="明细列表")


class PayslipOut(BaseModel):
    date_from: date = Field(description="开始日期")
    date_to: date = Field(description="结束日期")
    total_commission: float = Field(default=0, description="提成合计")
    sections: list[PayslipSection] = Field(default_factory=list, description="角色分块列表")

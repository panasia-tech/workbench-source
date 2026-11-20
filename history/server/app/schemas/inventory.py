from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from app.schemas._tz import CNDatetime


class SkuOut(BaseModel):
    id: str = Field(description="SKU 主键 ID")
    sku_code: str = Field(description="货号（标签打印的条形码即货号）")
    short_code: str | None = Field(default=None, description="上架短编码（4 位，上架时分配、出库回收复用，内部标识，不再嵌入闲鱼标题）")
    serial_number: str | None = Field(default=None, description="序列号")
    barcode: str | None = Field(default=None, description="商品条码（69码/EAN-13，同款同码）")
    spu: dict | None = Field(default=None, description="69码查询到的 SPU 商品信息（条码库返回的原始 JSON）")
    rfid_epc: str | None = Field(default=None, description="RFID 标签 EPC（一物一码）")
    purchase_order_id: str = Field(description="关联采购单 ID")
    product_name: str = Field(description="商品名称")
    brand: str | None = Field(description="品牌")
    model: str | None = Field(description="型号")
    spec: str | None = Field(description="规格")
    location_code: str | None = Field(description="库位号")
    condition_grade: str | None = Field(description="成色")
    product_type: str | None = Field(default=None, description="商品种类类型（入库单选，AI 生图按此取默认提示词）")
    cost_price: Decimal | None = Field(default=None, description="成本价（销售角色不可见，返回 None）")
    suggest_price: Decimal | None = Field(description="建议售价")
    status: str = Field(description="库存状态 IN_STOCK=在库 / RESERVED=锁单 / SHIPPED=已发货 / LOSS=报损 / SPLIT=拆分退役")
    reserve_source: str | None = Field(default=None, description="锁单来源 SWITCH=切单 / PLATFORM_SOLD=平台已售")
    warehouse_phase: str | None = Field(default=None, description="仓储阶段 pending_negotiation=待议价 / pending_inbound=待入库 / pending_create=待创建上架信息 / listing=发布中 / on_sale=在售 / locked=锁单 / shipped=已发货")
    listing_status: str | None = Field(default=None, description="上架信息状态")
    on_shelf_count: int = Field(default=0, description="在架店铺数（已上架 LISTED 的店铺数量）")
    cover_url: str | None = Field(description="封面图 URL")
    cover_thumb_url: str | None = Field(default=None, description="封面缩略图 URL")
    images: list = Field(description="商品图列表（产品实拍/上架展示，图片视频混合）")
    location_images: list = Field(default_factory=list, description="仓库定位图列表（找货/盘点用，与商品图分开）")
    tags: list[str] = Field(default_factory=list, description="标签列表")

    @field_validator("tags", "location_images", mode="before")
    @classmethod
    def _coerce_tags(cls, v):
        return v or []

    inbound_at: CNDatetime | None = Field(description="入库时间")
    outbound_at: CNDatetime | None = Field(description="出库时间")
    created_at: CNDatetime = Field(description="创建时间")
    operator_name: str | None = Field(default=None, description="操作人（验货员）姓名")

    model_config = {"from_attributes": True}


class LegacySnapshotOut(BaseModel):
    """老系统(秦丝)库存快照——搜索兜底展示用,仅供核对,不代表当前在库。"""

    goods_no: str | None = Field(description="老系统货号")
    product_name: str | None = Field(description="商品名称")
    model: str | None = Field(description="型号")
    serial_no: str | None = Field(description="序列号")
    barcode: str | None = Field(description="条码")
    cover_url: str | None = Field(description="封面图 URL")
    location: str | None = Field(description="库位")
    status: str | None = Field(description="老系统在库状态 IN_STOCK=在库 / OUT_STOCK=出库")
    qty: int = Field(description="数量")
    purchase_price_fen: int | None = Field(description="采购价（单位：分）")
    inbound_at: CNDatetime | None = Field(description="入库时间")
    legacy_tag: str | None = Field(description="老系统标签")
    migrated_sku_code: str | None = Field(description="已迁入新系统的对应货号，空=未迁移")

    model_config = {"from_attributes": True}


class SkuListResponse(BaseModel):
    items: list[SkuOut] = Field(description="SKU 列表")
    total: int = Field(description="总条数")
    page: int = Field(description="当前页码")
    size: int = Field(description="每页条数")
    legacy_matches: list[LegacySnapshotOut] = Field(default_factory=list, description="搜索无在库结果时的老系统历史记录兜底（仅搜索关键词非空且 total=0 时非空）")


class StockEventOut(BaseModel):
    id: str = Field(description="库存事件 ID")
    event_type: str = Field(description="事件类型 PURCHASE=采购 / INSPECT=验货 / INBOUND=入库 / NEGOTIATE=议价 / OUTBOUND=出库 / RETURN=退回 / LOSS=报损 / OVERFLOW=盈出 / REJECT=拒收 / RFID_BIND=绑定RFID / RFID_UNBIND=解绑RFID / RECODE=改码 / SPLIT=拆分 / EXPRESS_RECALL=召回快递")
    ref_no: str | None = Field(description="关联单号")
    operator_id: str | None = Field(description="操作人 ID")
    payload: dict | None = Field(description="事件附加数据")
    created_at: CNDatetime = Field(description="发生时间")

    model_config = {"from_attributes": True}


class SkuDetailOut(SkuOut):
    stock_events: list[StockEventOut] = Field(default=[], description="库存事件流水")
    tracking_no: str | None = Field(default=None, description="采购单上的入库快递单号（自由文本，不参与媒体签名）")
    purchase_order_no: str | None = Field(default=None, description="采购单号")


class SkuUpdateIn(BaseModel):
    """仓管补全在库商品信息；只更新请求里出现的字段。"""

    sku_code: str | None = Field(default=None, description="货号")
    product_name: str | None = Field(default=None, description="商品名称")
    model: str | None = Field(default=None, description="型号")
    spec: str | None = Field(default=None, description="规格")
    serial_number: str | None = Field(default=None, description="序列号")
    barcode: str | None = Field(default=None, description="商品条码（69码/EAN-13）")
    location_code: str | None = Field(default=None, description="库位号")
    condition_grade: str | None = Field(default=None, description="成色")
    images: list[str] | None = Field(default=None, description="商品图 URL 列表")
    location_images: list[str] | None = Field(default=None, description="仓库定位图 URL 列表")


class SkuMarketInfoIn(BaseModel):
    """行情工作台回写商品身份描述：**只有这三个字段**。

    这个 schema 本身就是权限边界。仓管的全量编辑走 SkuUpdateIn（能改货号、69码、
    规格、库位…），设备账号够不到那里——它只需要把闲鱼上查到的正确品名/品牌/型号
    补回来，那就只给它这三个字段。多一个字段都要有人重新想一遍为什么。
    """

    # extra="forbid"：多送一个字段直接 422，而不是被 pydantic 静默丢掉。
    # 静默丢弃会让调用方以为写成功了——回写这种事，"我以为改了"比"报错"危险得多。
    model_config = ConfigDict(extra="forbid")

    product_name: str | None = Field(default=None, description="商品名称")
    brand: str | None = Field(default=None, description="品牌")
    model: str | None = Field(default=None, description="型号")


class BarcodeLookupIn(BaseModel):
    """按 69码 查询商品信息（阿里云市场条码库）并把结果写入 sku.spu。"""

    barcode: str | None = Field(default=None, description="商品条码（69码）；留空用 SKU 上已存的 barcode")


class ManualInboundIn(BaseModel):
    """仓管手动入库（迁移旧系统货品）：自动造占位采购单+验货单，直接生成在库 SKU。

    比正常验货入库宽松——不依赖真实采购单；货号可手填旧码（留空自动生成）；
    可回填旧系统的原始入库时间。免议价（入库即定价，直接进上架待办）。
    """

    product_name: str | None = Field(default=None, description="商品名称（留空则由品牌+型号拼接，与采购单 compose 规则一致）")
    brand: str | None = Field(default=None, description="品牌")
    model: str | None = Field(default=None, description="型号")
    spec: str | None = Field(default=None, description="规格")
    sku_code: str | None = Field(default=None, description="货号（手填旧系统货号，留空自动生成 M日期-NNN）")
    serial_number: str = Field(description="序列号")
    barcode: str | None = Field(default=None, description="商品条码（69码/EAN-13，可扫码填写）")
    location_code: str = Field(description="库位号")
    condition_grade: str = Field(description="成色")
    product_type: str | None = Field(default=None, description="商品种类类型（入库单选，小程序端必填；旧客户端可空）")
    cost_price: Decimal = Field(..., ge=0, description="成本价")
    images: list[str] = Field(default_factory=list, description="商品图（图片/视频混合），接口内强制 ≥1 张")
    location_images: list[str] = Field(default_factory=list, description="仓库定位图")
    inbound_at: datetime | None = Field(default=None, description="旧系统原始入库时间（北京时间墙上时间），留空=当前")
    remark: str | None = Field(default=None, description="备注")


class ManualInboundResult(BaseModel):
    sku_code: str = Field(description="生成的货号")
    purchase_order_no: str = Field(description="生成的采购单号")


class InventorySummary(BaseModel):
    total_cost: Decimal | None = Field(default=None, description="在库总成本（销售角色不可见，返回 None）")
    total_count: int = Field(description="在库总件数（在库+锁单）")
    on_sale_count: int = Field(default=0, description="在售件数")
    locked_count: int = Field(default=0, description="锁单件数")


class OutboundScanRequest(BaseModel):
    sku_code: str = Field(description="货号")
    buyer_name: str | None = Field(default=None, description="买家名称")
    sale_price: Decimal = Field(description="售价")
    outbound_type: str = Field(default="ORDER_SHIP", description="出库类型 ORDER_SHIP=订单发货 / PICKUP=自提 / SWITCH=切单发货 / MANUAL=手动")
    tracking_no: str | None = Field(default=None, description="运单号")
    tracking_phone_suffix: str | None = Field(default=None, max_length=8, description="收件人手机尾号")
    remark: str | None = Field(default=None, description="备注")
    sale_order_id: str | None = Field(default=None, description="关联销售单 ID")
    express_fee: Decimal | None = Field(default=None, description="快递费")
    platform_fee: Decimal | None = Field(default=None, ge=0, description="闲鱼订单页上的实际服务费（元）；不知道就空着，按档估")


class OutboundManualRequest(BaseModel):
    sku_code: str = Field(description="货号")
    buyer_name: str | None = Field(default=None, description="买家名称")
    sale_price: Decimal = Field(description="售价")
    outbound_type: str = Field(description="出库类型 ORDER_SHIP=订单发货 / PICKUP=自提 / SWITCH=切单发货 / MANUAL=手动")
    evidence_urls: list[str] = Field(default_factory=list, description="成交/现场证据图（图片/视频）")
    payment_screenshot_url: str | None = Field(default=None, description="收款截图 URL")
    remark: str | None = Field(default=None, description="备注")
    sale_order_id: str | None = Field(default=None, description="关联销售单 ID")
    express_fee: Decimal | None = Field(default=None, description="快递费")
    tracking_no: str | None = Field(default=None, description="运单号")
    tracking_phone_suffix: str | None = Field(default=None, max_length=8, description="收件人手机尾号")
    worry_free: bool = Field(default=False, description="切单发货=平台交易：是否无忧卖（True=2.6% / False=普通1.6%）；自提不看此字段")
    platform_fee: Decimal | None = Field(default=None, ge=0, description="闲鱼订单页上的实际服务费（元，软件服务费+无忧卖服务费）；不知道就空着，按档估")


class AdjustRequest(BaseModel):
    sku_code: str = Field(description="货号")
    adjust_type: str = Field(description="调整类型 LOSS=报损 / OVERFLOW=盈出入库")
    reason: str | None = Field(default=None, description="调整原因")


class StocktakeItemIn(BaseModel):
    sku_code: str = Field(description="货号")
    source: str = Field(default="MANUAL", description="录入来源 MANUAL=手动录入 / RFID=RFID盘读")


# ---------------- RFID 盘点 ----------------


class RfidScanIn(BaseModel):
    epcs: list[str] = Field(description="RFID 标签 EPC 列表（EPC 即货号）")


class RfidScanResult(BaseModel):
    added_count: int = Field(description="本批新计入的件数")
    scanned_count: int = Field(description="会话累计已盘件数")
    unresolved: list[str] = Field(description="翻译不出（未绑定/外来标签）的 EPC")
    session: "StocktakeSessionOut" = Field(description="当前盘点会话")


# ---------------- 条码迁移改码（旧货号 → 新货号）----------------


class RecodeIn(BaseModel):
    old_sku_code: str = Field(description="旧货号")
    new_sku_code: str = Field(description="新货号")


class RecodeOut(BaseModel):
    old_sku_code: str = Field(description="旧货号")
    new_sku_code: str = Field(description="新货号")
    product_name: str | None = Field(default=None, description="商品名称")
    spec: str | None = Field(default=None, description="规格")
    location_code: str | None = Field(default=None, description="库位号")
    status: str | None = Field(default=None, description="库存状态")


# ---------------- 货号更换（旧货号 → 51321154 新货号）----------------


class SkuMigrationItem(BaseModel):
    id: str = Field(description="SKU 主键 ID")
    sku_code: str = Field(description="货号")
    product_name: str = Field(description="商品名称")
    spec: str | None = Field(default=None, description="规格")
    location_code: str | None = Field(default=None, description="库位号")
    status: str = Field(description="库存状态")
    migration_status: str = Field(description="更换状态 PENDING=待更换 / DONE=已更换（由货号前缀推导）")
    can_migrate: bool = Field(description="是否可更换货号")
    inbound_at: CNDatetime | None = Field(default=None, description="入库时间")
    last_recode_at: CNDatetime | None = Field(default=None, description="最近一次改码时间")
    last_recode_operator_name: str | None = Field(default=None, description="最近一次改码操作人")
    last_recode_source: str | None = Field(default=None, description="最近一次改码来源")

    model_config = {"from_attributes": True}


class SkuMigrationListResponse(BaseModel):
    items: list[SkuMigrationItem] = Field(description="货号更换列表")
    total: int = Field(description="总条数")
    page: int = Field(description="当前页码")
    size: int = Field(description="每页条数")


class SkuMigrationRecodeIn(BaseModel):
    old_sku_code: str = Field(description="旧货号")
    new_sku_code: str = Field(description="新货号（须以 51321154 开头）")


class SkuMigrationRecodeOut(RecodeOut):
    migration_status: str = Field(description="更换状态 PENDING=待更换 / DONE=已更换")
    last_recode_at: CNDatetime | None = Field(default=None, description="最近一次改码时间")
    last_recode_operator_name: str | None = Field(default=None, description="最近一次改码操作人")
    last_recode_source: str | None = Field(default=None, description="最近一次改码来源")


# ---------------- 69码更换（空/错 69码 → 新 69码）----------------


class BarcodeMigrationItem(BaseModel):
    id: str = Field(description="SKU 主键 ID")
    sku_code: str = Field(description="货号")
    product_name: str = Field(description="商品名称")
    spec: str | None = Field(default=None, description="规格")
    location_code: str | None = Field(default=None, description="库位号")
    status: str = Field(description="库存状态")
    barcode: str | None = Field(default=None, description="商品条码（69码），空=待更换")
    spu_text: str | None = Field(default=None, description="SPU 一行摘要（名称 品牌 规格），空=条码库没查到")
    migration_status: str = Field(description="更换状态 PENDING=待更换（69码为空）/ DONE=已更换")
    can_migrate: bool = Field(description="是否可更换 69码")
    inbound_at: CNDatetime | None = Field(default=None, description="入库时间")
    last_barcode_at: CNDatetime | None = Field(default=None, description="最近一次 69码变更时间")
    last_barcode_operator_name: str | None = Field(default=None, description="最近一次 69码变更操作人")
    last_barcode_source: str | None = Field(default=None, description="最近一次 69码变更来源")
    last_barcode_old: str | None = Field(default=None, description="最近一次变更前的旧 69码")

    model_config = {"from_attributes": True}


class BarcodeMigrationListResponse(BaseModel):
    items: list[BarcodeMigrationItem] = Field(description="69码更换列表")
    total: int = Field(description="总条数")
    page: int = Field(description="当前页码")
    size: int = Field(description="每页条数")


class BarcodeMigrationIn(BaseModel):
    sku_code: str = Field(description="货号（定位要改 69码的商品）")
    barcode: str = Field(description="新 69码（8/12/13/14 位数字）")


class StocktakeSkuBrief(BaseModel):
    sku_code: str = Field(description="货号")
    product_name: str | None = Field(default=None, description="商品名称")
    spec: str | None = Field(default=None, description="规格")
    location_code: str | None = Field(default=None, description="库位号")
    status: str | None = Field(default=None, description="库存状态")
    cover_url: str | None = Field(default=None, description="商品封面缩略图（详情接口按当前 sku 实时补充）")


class StocktakeDiffOut(BaseModel):
    warehouse_count: int = Field(description="在库应盘件数")
    scanned_count: int = Field(description="实际已盘件数")
    matched_count: int = Field(description="匹配件数")
    matched: list[StocktakeSkuBrief] = Field(description="盘平（匹配）商品列表")
    missing: list[StocktakeSkuBrief] = Field(description="盘亏（缺少）商品列表")
    surplus: list[StocktakeSkuBrief] = Field(description="盘盈（多出）商品列表")


class StocktakeSessionOut(BaseModel):
    id: str = Field(description="盘点会话 ID")
    session_no: str = Field(description="盘点单号")
    status: str = Field(description="盘点状态 IN_PROGRESS=盘点中 / PAUSED=已暂停 / COMPLETED=已完成比对 / PENDING_APPROVAL=待审批 / APPROVED=已通过 / REJECTED=已驳回")
    scanned_items: list = Field(description="已盘商品列表")
    warehouse_count: int = Field(description="在库应盘件数")
    scanned_count: int = Field(description="已盘件数")
    started_at: CNDatetime = Field(description="开始时间")
    paused_at: CNDatetime | None = Field(description="暂停时间")
    completed_at: CNDatetime | None = Field(description="完成比对时间")
    submitted_at: CNDatetime | None = Field(default=None, description="提交审核时间")
    reviewed_at: CNDatetime | None = Field(default=None, description="审核时间")
    review_comment: str | None = Field(default=None, description="审核意见")
    operator_name: str | None = Field(default=None, description="盘点操作人姓名")
    diff_result: StocktakeDiffOut | None = Field(default=None, description="盘点差异结果")
    proposals: list["StocktakeProposalOut"] = Field(default=[], description="差异处理方案列表")

    model_config = {"from_attributes": True}


class StocktakeProposalIn(BaseModel):
    sku_code: str = Field(description="货号")
    diff_type: str = Field(description="差异类型 MISSING=盘亏 / SURPLUS=盘盈")
    adjust_type: str | None = Field(default=None, description="调整方式 LOSS=报损 / OVERFLOW=盈出入库；留空=跳过不处理")
    reason: str | None = Field(default=None, description="处理原因")


class StocktakeProposalOut(BaseModel):
    id: str = Field(description="方案 ID")
    sku_code: str = Field(description="货号")
    diff_type: str = Field(description="差异类型 MISSING=盘亏 / SURPLUS=盘盈")
    adjust_type: str | None = Field(description="调整方式 LOSS=报损 / OVERFLOW=盈出入库")
    reason: str | None = Field(description="处理原因")
    status: str = Field(description="方案状态 PROPOSED=已拟定 / PENDING=待审批 / APPROVED=已通过 / REJECTED=已驳回 / APPLIED=已执行 / SKIPPED=跳过")
    adjust_no: str | None = Field(description="生成的调整单号")
    review_comment: str | None = Field(description="审核意见")
    created_at: CNDatetime = Field(description="创建时间")

    model_config = {"from_attributes": True}


class StocktakeReviewIn(BaseModel):
    comment: str | None = Field(default=None, description="审核意见")


class StocktakeListItem(BaseModel):
    id: str = Field(description="盘点会话 ID")
    session_no: str = Field(description="盘点单号")
    status: str = Field(description="盘点状态 IN_PROGRESS=盘点中 / PAUSED=已暂停 / COMPLETED=已完成比对 / PENDING_APPROVAL=待审批 / APPROVED=已通过 / REJECTED=已驳回")
    operator_name: str | None = Field(description="盘点操作人姓名")
    scanned_count: int = Field(description="已盘件数")
    missing_count: int = Field(description="盘亏件数")
    surplus_count: int = Field(description="盘盈件数")
    started_at: CNDatetime = Field(description="开始时间")
    completed_at: CNDatetime | None = Field(description="完成比对时间")
    submitted_at: CNDatetime | None = Field(description="提交审核时间")


class SkuSplitItem(BaseModel):
    brand: str | None = Field(default=None, description="品牌")
    model: str | None = Field(default=None, description="型号")
    spec: str | None = Field(default=None, description="规格")
    amount: Decimal = Field(description="拆出该件的金额（成本价）")
    condition_grade: str | None = Field(default=None, description="成色")
    location_code: str | None = Field(default=None, description="库位号")
    serial_number: str | None = Field(default=None, description="序列号")


class SkuSplitRequest(BaseModel):
    items: list[SkuSplitItem] = Field(description="拆分明细列表")


class SkuSplitResult(BaseModel):
    source_sku_code: str = Field(description="被拆分的原始货号")
    new_sku_codes: list[str] = Field(description="拆出的新货号列表")


class SalesOutboundOut(BaseModel):
    id: str = Field(description="出库记录 ID")
    outbound_no: str = Field(description="出库单号")
    sku_id: str = Field(description="SKU ID")
    buyer_name: str | None = Field(description="买家名称")
    outbound_type: str = Field(description="出库类型 ORDER_SHIP=订单发货 / PICKUP=自提 / SWITCH=切单发货 / MANUAL=手动")
    sale_price: Decimal = Field(description="售价")
    cost_price: Decimal = Field(description="成本价")
    express_fee: Decimal | None = Field(default=None, description="快递费")
    tracking_no: str | None = Field(description="运单号")
    created_at: CNDatetime = Field(description="出库时间")

    model_config = {"from_attributes": True}

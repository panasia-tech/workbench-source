from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field
from app.schemas._tz import CNDatetime

from app.schemas.express import ExpressTrackingOut


class PurchaseOrderCreate(BaseModel):
    brand: str = Field(description="品牌")
    model: str = Field(description="型号")
    spec: str | None = Field(default=None, description="规格")
    unit_price: Decimal = Field(description="成交金额")
    external_order_no: str = Field(description="闲鱼订单号")
    transaction_no: str = Field(description="交易流水号")
    tracking_no: str = Field(description="物流单号")
    tracking_phone_suffix: str | None = Field(default=None, description="顺丰手机后四位")
    order_time: CNDatetime = Field(description="下单时间")
    paid_at: CNDatetime = Field(description="付款时间")
    purchase_account: str = Field(description="采购账号")
    seller_name: str = Field(description="卖家昵称")
    remark: str | None = Field(default=None, description="备注")
    product_images: list[str] = Field(..., min_length=1, description="商品图 URL 列表（至少 1 张）")
    attachments: list[str] = Field(default_factory=list, description="附件 URL 列表")
    screenshot_url: str | None = Field(default=None, description="闲鱼截图1")
    screenshot_url_2: str | None = Field(default=None, description="闲鱼截图2")
    quantity: int = Field(default=1, ge=1, le=50, description="同一件商品买了几件：每件一张验货单，成交金额按件均摊")
    allow_duplicate: bool = Field(default=False, description="同订单号已存在采购单时是否放行：默认 False 拒绝(409)，前端二次确认后置 True(一单多件)")
    # 采购 Copilot / W04 商品快照（可选）：建单时一并落首版并冻结
    platform_item_id: str | None = Field(default=None, max_length=64, description="平台商品 ID（闲鱼 item_id）")
    source_url: str | None = Field(default=None, max_length=1024, description="商品原链接")
    snapshot_title: str | None = Field(default=None, max_length=512, description="下单前标题原文")
    snapshot_description: str | None = Field(default=None, description="下单前描述原文")
    snapshot_condition: str | None = Field(default=None, max_length=128, description="卖家声明成色原文")
    snapshot_accessories: str | None = Field(default=None, max_length=512, description="配件声明原文")
    snapshot_listed_price: Decimal | None = Field(default=None, description="页面标价")
    snapshot_id: str | None = Field(default=None, max_length=36, description="已有草稿快照 ID，建单时绑上并冻结")
    bargain_session_id: str | None = Field(default=None, max_length=36, description="谈妥的议价会话，建单后自动绑上")
    platform_order_id: str | None = Field(default=None, max_length=36, description="从「平台订单 · 待建单」一键建单时带上，建完自动挂上")
    price_rule_id: str | None = Field(default=None, max_length=36, description="下单时参考的那版公司价，锁在采购单上")


class PurchaseOrderOut(BaseModel):
    id: str = Field(description="采购单 ID")
    order_no: str = Field(description="采购单号")
    status: str = Field(description="采购单状态：PENDING_INSPECT=待验货 / IN_STOCK=已入库 / SHIPPED=已出库 / LOSS=报损 / CANCELLED=已取消")
    product_name: str = Field(description="商品名称（品牌+型号自动拼接）")
    brand: str | None = Field(description="品牌")
    model: str | None = Field(description="型号")
    spec: str | None = Field(description="规格")
    unit_price: Decimal = Field(description="成交金额")
    quantity: int = Field(default=1, description="件数（一单多件时 > 1）")
    external_order_no: str | None = Field(description="闲鱼订单号")
    transaction_no: str | None = Field(description="交易流水号")
    tracking_no: str | None = Field(description="物流单号")
    tracking_phone_suffix: str | None = Field(default=None, description="顺丰手机后四位")
    order_time: CNDatetime | None = Field(description="下单时间")
    paid_at: CNDatetime | None = Field(description="付款时间")
    purchase_account: str | None = Field(description="采购账号")
    seller_name: str | None = Field(description="卖家昵称")
    remark: str | None = Field(description="备注")
    product_images: list[str] = Field(default=[], description="商品图 URL 列表（详情返回，列表页置空）")
    attachments: list[str] = Field(default=[], description="附件 URL 列表")
    product_image: str | None = Field(default=None, description="首图 URL（列表页回填，用于缩略展示）")
    product_image_thumb: str | None = Field(default=None, description="首图缩略图 URL（列表页回填）")
    screenshot_url: str | None = Field(description="闲鱼截图1")
    screenshot_url_2: str | None = Field(default=None, description="闲鱼截图2")
    created_by_id: str = Field(description="创建人（采购员）ID")
    created_at: CNDatetime = Field(description="创建时间")
    updated_at: CNDatetime = Field(description="更新时间")
    operator_name: str | None = Field(default=None, description="创建人（采购员）姓名")
    asset_no: str | None = Field(default=None, description="资产编号：采购单已转为公司资产时回显（仅详情接口回填，列表为 None 避免 N+1）")
    is_overdue: bool = Field(default=False, description="逾期采购：提交时快件已到浙江省内，不发放基础提成")
    is_unnegotiated: bool = Field(default=False, description="未议价：已入库但 SKU 从未议价（排除 LEGACY_IMPORT 老库存），路由层批量回填")
    condition_warning: bool = Field(default=False, description="货况警示：实拍图疑似「全新/几乎全新」，命中关键词见 condition_warning_text")
    condition_warning_text: str | None = Field(default=None, description="货况警示命中的关键词")
    express_tracking: ExpressTrackingOut | None = Field(default=None, description="物流轨迹（有物流单号且缓存命中时回填）")

    model_config = {"from_attributes": True}


class PurchaseOrderUpdate(BaseModel):
    """历史采购单编辑：仅业务字段，全部可选；系统单号 order_no 与状态 status 不可改。"""

    brand: str | None = Field(default=None, description="品牌")
    model: str | None = Field(default=None, description="型号")
    spec: str | None = Field(default=None, description="规格")
    unit_price: Decimal | None = Field(default=None, description="成交金额")
    external_order_no: str | None = Field(default=None, description="闲鱼订单号")
    transaction_no: str | None = Field(default=None, description="交易流水号")
    tracking_no: str | None = Field(default=None, description="物流单号")
    tracking_phone_suffix: str | None = Field(default=None, description="顺丰手机后四位")
    order_time: CNDatetime | None = Field(default=None, description="下单时间")
    paid_at: CNDatetime | None = Field(default=None, description="付款时间")
    purchase_account: str | None = Field(default=None, description="采购账号")
    seller_name: str | None = Field(default=None, description="卖家昵称")
    remark: str | None = Field(default=None, description="备注")
    product_images: list[str] | None = Field(default=None, description="商品图 URL 列表")
    attachments: list[str] | None = Field(default=None, description="附件 URL 列表")
    screenshot_url: str | None = Field(default=None, description="闲鱼截图1")
    screenshot_url_2: str | None = Field(default=None, description="闲鱼截图2")
    is_overdue: bool | None = Field(default=None, description="逾期采购标记，仅管理员可在编辑里手动修正")
    condition_warning: bool | None = Field(default=None, description="货况警示，OCR 误报时管理员可在编辑里手动关闭")


class PurchaseChangeField(BaseModel):
    field: str = Field(description="变更字段名")
    label: str = Field(description="变更字段中文标签")
    old: str | None = Field(default=None, description="变更前值")
    new: str | None = Field(default=None, description="变更后值")


class PurchaseChangeOut(BaseModel):
    id: str = Field(description="变更记录 ID")
    operator_id: str | None = Field(default=None, description="操作人 ID")
    operator_name: str | None = Field(default=None, description="操作人姓名")
    changes: list[PurchaseChangeField] = Field(default=[], description="字段变更明细")
    cost_synced: bool = Field(default=False, description="是否联动回写了未议价商品的成本价")
    created_at: CNDatetime = Field(description="变更时间")


class PurchaseChangeListResponse(BaseModel):
    items: list[PurchaseChangeOut] = Field(description="修改记录列表")
    total: int = Field(description="总条数")


class PurchaseListResponse(BaseModel):
    items: list[PurchaseOrderOut] = Field(description="采购单列表")
    total: int = Field(description="总条数")
    page: int = Field(description="当前页码")
    size: int = Field(description="每页条数")


class PurchaseQuantityIn(BaseModel):
    quantity: int = Field(description="这张采购单一共几件（1~50）；一件都还没验时才能改")


class PurchasePiecesMissingIn(BaseModel):
    reason: str = Field(description="没到货的情况，比如「卖家说只剩 2 件」")


class PurchaseSnapshotIn(BaseModel):
    """采购商品快照（W04）：下单前原文/链接/平台商品 ID。"""

    platform: str = Field(default="xianyu", max_length=32)
    platform_item_id: str | None = Field(default=None, max_length=64)
    source_url: str | None = Field(default=None, max_length=1024)
    title: str | None = Field(default=None, max_length=512)
    description: str | None = Field(default=None)
    condition_text: str | None = Field(default=None, max_length=128)
    accessories_text: str | None = Field(default=None, max_length=512)
    listed_price: Decimal | None = Field(default=None)
    seller_name: str | None = Field(default=None, max_length=128)
    images: list[str] = Field(default_factory=list)
    raw_payload: dict | None = Field(default=None)
    capture_status: str = Field(default="OK", max_length=32, description="OK / FAILED / PARTIAL")
    capture_error: str | None = Field(default=None, max_length=255)
    purchase_order_id: str | None = Field(default=None, max_length=36, description="已有采购单则直接挂上")
    freeze: bool = Field(default=False, description="是否立刻冻结（下单完成时）")
    declared_model: str | None = Field(default=None, max_length=128, description="卖家写的型号原文")
    specs: str | None = Field(default=None, description="卖家写的规格原文")
    capture_kind: str = Field(default="manual", description="manual 采购手填 / live 下单前抓 / late 下单后补抓")
    videos: list[str] = Field(default_factory=list, description="商品视频原件")
    reports: list[str] = Field(default_factory=list, description="检测报告原件")


class PurchaseSnapshotOut(BaseModel):
    id: str
    purchase_order_id: str | None = None
    platform: str
    platform_item_id: str | None = None
    source_url: str | None = None
    title: str | None = None
    description: str | None = None
    condition_text: str | None = None
    accessories_text: str | None = None
    listed_price: Decimal | None = None
    seller_name: str | None = None
    images: list[str] = Field(default_factory=list)
    content_hash: str | None = None
    version: int
    root_id: str | None = None
    frozen_at: CNDatetime | None = None
    capture_status: str
    capture_error: str | None = None
    created_by_id: str | None = None
    created_at: CNDatetime | None = None
    platform_order_id: str | None = None
    declared_model: str | None = None
    specs: str | None = None
    capture_kind: str = "manual"
    capture_kind_label: str | None = None
    captured_at: CNDatetime | None = None
    media: list[dict] = Field(default_factory=list)
    media_saved: int = 0
    media_total: int = 0

    model_config = {"from_attributes": True}

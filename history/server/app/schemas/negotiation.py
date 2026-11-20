from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field
from app.schemas._tz import CNDatetime


class NegotiationItem(BaseModel):
    sku_id: str = Field(description="库存SKU ID")
    sku_code: str = Field(description="货号")
    product_name: str = Field(description="商品名称")
    brand: str | None = Field(default=None, description="品牌")
    model: str | None = Field(default=None, description="型号")
    spec: str | None = Field(default=None, description="规格")
    condition_grade: str | None = Field(default=None, description="成色等级")
    cost_price: Decimal = Field(description="成本价")
    suggest_price: Decimal | None = Field(default=None, description="建议售价")
    cover_url: str | None = Field(default=None, description="封面图URL")
    cover_thumb_url: str | None = Field(default=None, description="封面缩略图URL")
    location_images: list = Field(default_factory=list, description="仓库定位图：没有产品图时列表用它兜底显示")
    inbound_at: CNDatetime | None = Field(default=None, description="入库时间")
    location_code: str | None = Field(default=None, description="库位号")
    condition_warning: bool = Field(default=False, description="货况警示：实拍图疑似全新/几乎全新，议价端标红重点核对成交价")
    condition_warning_text: str | None = Field(default=None, description="货况警示文案")


class NegotiationDetail(NegotiationItem):
    images: list[str] = Field(default_factory=list, description="商品图片")
    negotiation_remark: str | None = Field(default=None, description="议价备注")
    negotiation_media: list[str] = Field(default_factory=list, description="议价证据（聊天截图/议价凭证/瑕疵视频等）")
    inspection_media: list[str] = Field(default_factory=list, description="验货环节上传的图片/视频（入库图+瑕疵图+瑕疵视频），议价时核对货况用")


class NegotiationHistoryItem(BaseModel):
    sku_id: str = Field(description="库存SKU ID")
    sku_code: str = Field(description="货号")
    product_name: str = Field(description="商品名称")
    spec: str | None = Field(default=None, description="规格")
    condition_grade: str | None = Field(default=None, description="成色等级")
    location_code: str | None = Field(default=None, description="库位号")
    cover_url: str | None = Field(default=None, description="封面图URL")
    cover_thumb_url: str | None = Field(default=None, description="封面缩略图URL")
    location_images: list = Field(default_factory=list, description="仓库定位图：没有产品图时列表用它兜底显示")
    status: str = Field(description="库存SKU状态")
    final_price: Decimal = Field(description="议价后的最终成交价（=修正后的实际采购成本）")
    old_cost: Decimal | None = Field(default=None, description="议价前的原始采购成本（来自NEGOTIATE事件留痕，历史数据可能为空）")
    negotiation_remark: str | None = Field(default=None, description="议价备注")
    negotiated_at: CNDatetime | None = Field(default=None, description="议价成交时间")
    negotiator_name: str | None = Field(default=None, description="议价操作人姓名")
    recalled_at: CNDatetime | None = Field(default=None, description="召回快递闭环时间；为空=待召回快递（议价已提交、改派凭证未补传）")


class NegotiationHistoryList(BaseModel):
    items: list[NegotiationHistoryItem] = Field(default_factory=list, description="议价记录列表")
    total: int = Field(default=0, description="总数")
    page: int = Field(default=1, description="当前页码")
    size: int = Field(default=20, description="每页数量")


class NegotiationHistoryDetail(NegotiationHistoryItem):
    brand: str | None = Field(default=None, description="品牌")
    model: str | None = Field(default=None, description="型号")
    inbound_at: CNDatetime | None = Field(default=None, description="入库时间")
    images: list[str] = Field(default_factory=list, description="商品图片")
    negotiation_media: list[str] = Field(default_factory=list, description="议价证据（采购员上传的聊天截图、议价凭证、瑕疵视频等）")
    inspection_media: list[str] = Field(default_factory=list, description="验货环节素材（入库图+瑕疵图+瑕疵视频）")
    need_transfer: bool = Field(default=False, description="是否跳转转账（暂未实现，仅记录开关意向）")
    redispatch_media: list[str] = Field(default_factory=list, description="顺丰改派/再次派件凭证（召回快递环节业务员补传）")


class NegotiationSubmit(BaseModel):
    suggest_price: Decimal = Field(..., gt=0, description="议定的最终成交价（修正实际采购成本）")
    remark: str | None = Field(default=None, description="议价备注")
    evidence: list[str] = Field(default_factory=list, description="议价证据：图片/视频的OSS公网URL混合列表")
    need_transfer: bool = Field(default=False, description="是否跳转转账（转账功能暂未实现，仅记录开关意向，前端暂时隐藏入口）")


class RecallSubmit(BaseModel):
    redispatch_media: list[str] = Field(..., min_length=1, description="顺丰改派/再次派件凭证（图片/视频混存的OSS公网URL），至少一项才算召回完成")


class NegotiationTaskOut(BaseModel):
    id: str = Field(description="议价单ID")
    order_no: str | None = Field(default=None, description="闲鱼订单号")
    purchase_no: str | None = Field(default=None, description="采购单号")
    goods_code: str | None = Field(default=None, description="货号")
    serial_no: str | None = Field(default=None, description="序列号")
    seller_nickname: str | None = Field(default=None, description="卖家昵称")
    product_name: str | None = Field(default=None, description="商品名称")
    location: str | None = Field(default=None, description="库位")
    inspection_result: str | None = Field(default=None, description="验货结果")
    inspection_result_text: str | None = Field(default=None, description="验货结果文案")
    inspection_description: str | None = Field(default=None, description="验货描述")
    purchase_price: Decimal | None = Field(default=None, description="采购价")
    product_images: list = Field(default_factory=list, description="商品图片")
    defect_images: list = Field(default_factory=list, description="瑕疵图")
    defect_videos: list = Field(default_factory=list, description="瑕疵视频")
    status: str = Field(description="议价单状态：OPEN=待处理 / CLOSED=已关闭 / CONVERTED=已转在库")
    close_note: str | None = Field(default=None, description="关闭备注")
    closed_at: CNDatetime | None = Field(default=None, description="关闭时间")
    closed_by_name: str | None = Field(default=None, description="关闭操作人姓名")
    created_at: CNDatetime | None = Field(default=None, description="创建时间")


class NegotiationTaskClose(BaseModel):
    close_note: str | None = Field(default=None, description="关闭备注")


class NegotiationTaskConvert(BaseModel):
    sku_code: str | None = Field(default=None, description="货号（留空则用原采购货号或自动生成）")
    cost_price: Decimal | None = Field(default=None, gt=0, description="成本价（留空则用原采购价）")
    location_code: str | None = Field(default=None, description="库位号")
    serial_number: str | None = Field(default=None, description="序列号")
    condition_grade: str | None = Field(default=None, description="成色等级")
    remark: str | None = Field(default=None, description="备注")
    location_images: list[str] = Field(default_factory=list, description="仓库定位图，与产品实拍图分开；历史照片绑定工具后续也写这个字段")


class NegotiationTaskConvertResult(BaseModel):
    task_id: str = Field(description="议价单ID")
    sku_code: str = Field(description="生成的货号")
    purchase_order_no: str = Field(description="生成的采购单号")

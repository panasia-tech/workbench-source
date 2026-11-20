from decimal import Decimal

from pydantic import BaseModel, Field

from app.schemas._tz import CNDatetime


class LawsuitCreate(BaseModel):
    purchase_order_id: str = Field(description="关联采购单 ID")
    evidence_media: list[str] = Field(
        default_factory=list, description="证据材料（建单第一步=证据优先，必须先传）"
    )
    lawyer_media: list[str] = Field(default_factory=list, description="律师材料/回复（后续补传）")
    court_media: list[str] = Field(default_factory=list, description="法院材料（后续补传）")
    judgment_media: list[str] = Field(default_factory=list, description="判决材料/结果（后续补传）")


class LawsuitUpdate(BaseModel):
    """部分更新四类材料；传入哪个就覆盖哪个（None 表示不动）。"""

    evidence_media: list[str] | None = Field(default=None, description="证据材料")
    lawyer_media: list[str] | None = Field(default=None, description="律师材料/回复")
    court_media: list[str] | None = Field(default=None, description="法院材料")
    judgment_media: list[str] | None = Field(default=None, description="判决材料/结果")


class LawsuitListItem(BaseModel):
    id: str = Field(description="主键 ID")
    lawsuit_no: str = Field(description="起诉单号")
    status: str = Field(
        description="状态：DRAFT=草稿 / EVIDENCE_SUBMITTED=已提交证据 / SUBMITTED_LAWYER=已提交律师回复 / PENDING_HEARING=待开庭 / JUDGED=已判决"
    )
    purchase_order_id: str = Field(description="关联采购单 ID")
    order_no: str | None = Field(default=None, description="采购单号")
    product_name: str | None = Field(default=None, description="商品名称")
    brand: str | None = Field(default=None, description="品牌")
    model: str | None = Field(default=None, description="型号")
    spec: str | None = Field(default=None, description="规格")
    unit_price: Decimal | None = Field(default=None, description="单价")
    product_image: str | None = Field(default=None, description="商品主图")
    product_image_thumb: str | None = Field(default=None, description="商品主图缩略图")
    created_at: CNDatetime = Field(description="创建时间")
    created_by_name: str | None = Field(default=None, description="建单人姓名")


class LawsuitDetail(BaseModel):
    id: str = Field(description="主键 ID")
    lawsuit_no: str = Field(description="起诉单号")
    status: str = Field(
        description="状态：DRAFT=草稿 / EVIDENCE_SUBMITTED=已提交证据 / SUBMITTED_LAWYER=已提交律师回复 / PENDING_HEARING=待开庭 / JUDGED=已判决"
    )
    purchase_order_id: str = Field(description="关联采购单 ID")
    order_no: str | None = Field(default=None, description="采购单号")
    product_name: str | None = Field(default=None, description="商品名称")
    brand: str | None = Field(default=None, description="品牌")
    model: str | None = Field(default=None, description="型号")
    spec: str | None = Field(default=None, description="规格")
    unit_price: Decimal | None = Field(default=None, description="单价")
    seller_name: str | None = Field(default=None, description="卖家名称")
    tracking_no: str | None = Field(default=None, description="快递单号")
    product_image: str | None = Field(default=None, description="商品主图")
    product_image_thumb: str | None = Field(default=None, description="商品主图缩略图")
    evidence_media: list[str] = Field(default_factory=list, description="证据材料")
    lawyer_media: list[str] = Field(default_factory=list, description="律师材料/回复")
    court_media: list[str] = Field(default_factory=list, description="法院材料")
    judgment_media: list[str] = Field(default_factory=list, description="判决材料/结果")
    created_at: CNDatetime = Field(description="创建时间")
    created_by_name: str | None = Field(default=None, description="建单人姓名")
    last_action_by_name: str | None = Field(default=None, description="最后整理（补材料）操作人姓名")
    last_action_at: CNDatetime | None = Field(default=None, description="最后整理时间")


class LawsuitListResponse(BaseModel):
    items: list[LawsuitListItem] = Field(description="起诉单列表")
    total: int = Field(description="总数")
    page: int = Field(description="当前页码")
    size: int = Field(description="每页条数")

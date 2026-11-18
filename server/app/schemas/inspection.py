from datetime import datetime

from decimal import Decimal



from pydantic import BaseModel, Field
from app.schemas._tz import CNDatetime





class InspectionSubmit(BaseModel):

    action_type: str = Field(default="INBOUND", description="INBOUND=验货入库, REJECT=拒签退回")

    listing_images: list[str] = Field(default_factory=list, description="入库上架实拍图")

    defect_images: list[str] = Field(default_factory=list, description="瑕疵图")

    defect_videos: list[str] = Field(default_factory=list, description="瑕疵视频")

    reject_images: list[str] = Field(default_factory=list, description="拒签凭证图")

    location_images: list[str] = Field(default_factory=list, description="仓库定位图（选填），入库时写入SKU，与实拍图分开")

    inspection_result: str | None = Field(default=None, description="验货结果：PASSED=通过 / MISMATCH=不符")

    sku_code: str | None = Field(default=None, description="货号")

    serial_number: str | None = Field(default=None, description="序列号")

    barcode: str | None = Field(default=None, description="商品条码（69码/EAN-13，可扫码填写）")

    location_code: str | None = Field(default=None, description="库位号")

    mismatch_remark: str | None = Field(default=None, description="货不符描述")

    actual_amount: Decimal | None = Field(default=None, description="实收金额（填写则作为成本价）")

    condition_grade: str | None = Field(default=None, description="成色等级")

    remark: str | None = Field(default=None, description="备注（拒签时为拒签原因）")

    tags: list[str] = Field(default_factory=list, description="仓库标签名称")

    product_type: str | None = Field(default=None, description="商品种类类型（入库单选，小程序端必填；旧客户端可空）")


class InspectionActualAmountUpdate(BaseModel):

    actual_amount: Decimal | None = Field(default=None, description="实收金额")





class InspectionOut(BaseModel):

    id: str = Field(description="验货单ID")

    inspect_no: str = Field(description="验货单号")

    purchase_order_id: str = Field(description="采购订单ID")

    piece_no: int = Field(default=1, description="采购单的第几件（从 1 起）")

    action_type: str | None = Field(description="INBOUND=验货入库 / REJECT=拒签退回")

    inspection_result: str | None = Field(description="验货结果：PASSED=通过 / MISMATCH=不符")

    listing_images: list = Field(description="入库上架实拍图")

    defect_images: list = Field(description="瑕疵图")

    defect_videos: list = Field(description="瑕疵视频")

    reject_images: list = Field(description="拒签凭证图")

    condition_grade: str | None = Field(description="成色等级")

    location_code: str | None = Field(description="库位号")

    mismatch_remark: str | None = Field(description="货不符描述")

    actual_amount: Decimal | None = Field(description="实收金额")

    remark: str | None = Field(description="备注")

    status: str = Field(description="状态：PENDING=待验货 / DONE=已完成")

    inspector_id: str | None = Field(description="验货员ID")

    inspected_at: CNDatetime | None = Field(description="验货时间")

    created_at: CNDatetime = Field(description="创建时间")



    model_config = {"from_attributes": True}





class InspectionDetailOut(InspectionOut):

    order_no: str | None = Field(default=None, description="采购单号")

    quantity: int = Field(default=1, description="采购单件数（一单多件时 > 1）")

    piece_label: str | None = Field(default=None, description="一单多件时是第几件，如「第 2/3 件」；一单一件为空")

    product_name: str | None = Field(default=None, description="商品名称")

    brand: str | None = Field(default=None, description="品牌")

    model: str | None = Field(default=None, description="型号")

    spec: str | None = Field(default=None, description="规格")

    unit_price: Decimal | None = Field(default=None, description="采购单价")

    order_status: str | None = Field(default=None, description="采购订单状态")

    product_image: str | None = Field(default=None, description="商品实拍图（取自采购单首图，与列表一致）")

    product_image_thumb: str | None = Field(default=None, description="商品实拍图缩略图")

    condition_warning: bool = Field(default=False, description="货况警示：实拍图疑似全新/几乎全新，前端标红重点核对")

    condition_warning_text: str | None = Field(default=None, description="货况警示文案")

    operator_name: str | None = Field(default=None, description="操作人姓名（拒签详情用）")

    tracking_no: str | None = Field(default=None, description="快递单号（拒签详情为被拒快件单号）")





class InspectionListItem(BaseModel):

    id: str = Field(description="验货单ID")

    inspect_no: str = Field(description="验货单号")

    purchase_order_id: str = Field(description="采购订单ID")

    piece_no: int = Field(default=1, description="采购单的第几件（从 1 起）")

    order_no: str | None = Field(default=None, description="采购单号")

    quantity: int = Field(default=1, description="采购单件数（一单多件时 > 1）")

    piece_label: str | None = Field(default=None, description="一单多件时是第几件，如「第 2/3 件」；一单一件为空")

    product_name: str | None = Field(default=None, description="商品名称")

    brand: str | None = Field(default=None, description="品牌")

    model: str | None = Field(default=None, description="型号")

    spec: str | None = Field(default=None, description="规格")

    unit_price: Decimal | None = Field(default=None, description="采购单价")

    product_image: str | None = Field(default=None, description="商品实拍图（采购单首图）")

    product_image_thumb: str | None = Field(default=None, description="商品实拍图缩略图")

    tracking_no: str | None = Field(default=None, description="快递单号")

    tracking_phone_suffix: str | None = Field(default=None, description="收件人手机号后缀")

    express_summary: str | None = Field(default=None, description="快递物流摘要")

    action_type: str | None = Field(default=None, description="INBOUND=验货入库 / REJECT=拒签退回")

    inspection_result: str | None = Field(default=None, description="验货结果：PASSED=通过 / MISMATCH=不符")

    condition_grade: str | None = Field(default=None, description="成色等级")

    location_code: str | None = Field(default=None, description="库位号")

    actual_amount: Decimal | None = Field(default=None, description="实收金额")

    status: str = Field(description="状态：PENDING=待验货 / DONE=已完成")

    inspector_id: str | None = Field(default=None, description="验货员ID")

    inspected_at: CNDatetime | None = Field(default=None, description="验货时间")

    created_at: CNDatetime = Field(description="创建时间")

    operator_name: str | None = Field(default=None, description="操作人姓名")

    condition_warning: bool = Field(default=False, description="货况警示：实拍图疑似全新/几乎全新，前端列表标红")

    condition_warning_text: str | None = Field(default=None, description="货况警示文案")





class RecallItem(BaseModel):
    """议价成功 24h 内的在库商品，提醒仓管及时召回。"""

    sku_id: str = Field(description="库存SKU ID")
    sku_code: str = Field(description="货号")
    product_name: str | None = Field(default=None, description="商品名称")
    brand: str | None = Field(default=None, description="品牌")
    model: str | None = Field(default=None, description="型号")
    spec: str | None = Field(default=None, description="规格")
    location_code: str | None = Field(default=None, description="库位号")
    cost_price: Decimal | None = Field(default=None, description="成本价")
    cover_url: str | None = Field(default=None, description="封面图URL")
    cover_thumb_url: str | None = Field(default=None, description="封面缩略图URL")
    order_no: str | None = Field(default=None, description="采购单号")
    negotiated_at: CNDatetime | None = Field(default=None, description="议价成交时间")
    pinned: bool = Field(default=True, description="是否置顶：召回项恒为True，置顶并显示「请及时召回商品」标签")


class InspectionListResponse(BaseModel):

    items: list[InspectionListItem] = Field(description="验货任务列表")

    recall_items: list[RecallItem] = Field(default=[], description="议价成功24h内待召回的在库商品，置顶在待验货列表上方")

    total: int = Field(description="总数")

    page: int = Field(description="当前页码")

    size: int = Field(description="每页数量")


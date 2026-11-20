from pydantic import BaseModel, Field

from app.schemas._tz import CNDatetime


class ReturnOrderCreate(BaseModel):
    sku_code: str = Field(description="商品货号")
    reason_code: str = Field(
        description="退回原因（ReturnReasonCode）：CUSTOMER_CANCEL=客户取消 / CUSTOMER_REJECT=客户拒收 / CUSTOMER_RETURN=客户退货 / WRONG_ITEM=发错商品 / LOGISTICS_RETURN=物流退回 / INTERNAL_ERROR=内部出库错误 / OTHER=其他(OTHER时reason必填)"
    )
    reason: str | None = Field(default=None, description="退回原因说明（reason_code为OTHER时必填）")


class ReturnReceiveRequest(BaseModel):
    """仓库收货核对：全部强制，替代原一键确认"""

    serial_number: str = Field(description="收货核对序列号")
    condition: str = Field(
        description="商品状态（ReturnCondition）：NORMAL=正常 / OPENED=已拆封 / USED=轻微使用 / ABNORMAL=异常(损坏/缺配件等)"
    )
    location_code: str = Field(description="上架仓库定位编码")
    media: list[str] = Field(min_length=1, description="退回照片URL列表（OSS public_url），至少1张")
    remark: str | None = Field(default=None, description="备注")
    mark_abnormal: bool = Field(
        default=False, description="序列号不符时置true走异常挂起（不恢复库存）"
    )
    abnormal_reason: str | None = Field(default=None, description="异常原因（标记异常时必填）")


class ReturnResolveRequest(BaseModel):
    """异常件裁决（管理员）"""

    action: str = Field(
        description="裁决动作（ReturnResolution）：RESTOCK=恢复在库 / LOSS=报损 / REJECT=驳回重新核对"
    )
    remark: str | None = Field(default=None, description="备注")


class ReturnOrderOut(BaseModel):
    id: str = Field(description="退货单ID")
    return_no: str = Field(description="退货单号")
    sku_id: str = Field(description="SKU ID")
    sku_code: str = Field(description="商品货号")
    product_name: str = Field(description="商品名称")
    status: str = Field(
        description="状态：RETURNING=退回中 / PENDING_INBOUND=待入库 / ABNORMAL=异常挂起 / DONE=已完成 / CANCELLED=已取消"
    )
    reason: str | None = Field(default=None, description="退回原因说明")
    reason_code: str | None = Field(default=None, description="退回原因编码（ReturnReasonCode）")
    created_by_id: str = Field(description="创建人ID")
    operator_name: str | None = Field(default=None, description="创建人姓名")
    receiver_id: str | None = Field(default=None, description="收货人ID")
    receiver_name: str | None = Field(default=None, description="收货人姓名")
    received_at: CNDatetime | None = Field(default=None, description="收货时间")
    received_serial: str | None = Field(default=None, description="收货核对序列号")
    received_condition: str | None = Field(default=None, description="收货商品状态（ReturnCondition）")
    received_location_code: str | None = Field(default=None, description="上架仓库定位编码")
    received_media: list | None = Field(
        default=None, description="退回照片URL列表（DB存量行为NULL，不能声明成必为list）"
    )
    received_remark: str | None = Field(default=None, description="收货备注")
    abnormal_reason: str | None = Field(default=None, description="异常原因")
    resolution: str | None = Field(
        default=None, description="异常裁决结果（ReturnResolution）：RESTOCK / LOSS / REJECT"
    )
    resolver_name: str | None = Field(default=None, description="裁决人姓名")
    resolved_at: CNDatetime | None = Field(default=None, description="裁决时间")
    created_at: CNDatetime = Field(description="创建时间")
    cover_url: str | None = Field(default=None, description="商品封面图URL")
    cover_thumb_url: str | None = Field(default=None, description="商品封面缩略图URL")
    location_images: list = Field(
        default_factory=list, description="仓库定位图：没有产品图时列表用它兜底显示"
    )

    model_config = {"from_attributes": True}


class ReturnOrderListResponse(BaseModel):
    items: list[ReturnOrderOut] = Field(description="退货单列表")
    total: int = Field(description="总数")
    page: int = Field(description="当前页码")
    size: int = Field(description="每页数量")

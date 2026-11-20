from datetime import datetime

from pydantic import BaseModel, Field
from app.schemas._tz import CNDatetime


class ArchiveEligibleOrderOut(BaseModel):
    id: str = Field(description="采购单ID")
    order_no: str = Field(description="采购单号")
    status: str = Field(description="采购单状态(终态) SHIPPED=已发货/LOSS=报损/CANCELLED=已取消")
    product_name: str = Field(description="商品名称")
    file_count: int = Field(description="可归档媒体文件数")
    ended_at: CNDatetime = Field(description="订单结束时间(最后更新时间)")
    created_at: CNDatetime = Field(description="创建时间")

    model_config = {"from_attributes": True}


class ArchiveEligibleListResponse(BaseModel):
    items: list[ArchiveEligibleOrderOut] = Field(description="可归档采购单列表")
    total: int = Field(description="总数")
    page: int = Field(description="当前页码")
    size: int = Field(description="每页数量")


class ArchiveBatchCreate(BaseModel):
    purchase_order_ids: list[str] = Field(min_length=1, max_length=50, description="待归档采购单ID列表(1-50个)")


class ArchiveOrderOut(BaseModel):
    id: str = Field(description="归档订单ID")
    purchase_order_id: str = Field(description="关联采购单ID")
    order_no: str = Field(description="采购单号")
    file_count: int = Field(description="归档文件数")
    oss_deleted_at: CNDatetime | None = Field(description="OSS文件清理时间(未清理为空)")

    model_config = {"from_attributes": True}


class ArchiveBatchOut(BaseModel):
    id: str = Field(description="批次ID")
    batch_no: str = Field(description="批次号")
    status: str = Field(description="批次状态 PENDING=待打包/PACKING=打包中/READY=打包完成/FAILED=失败/OSS_DELETED=已清理OSS")
    order_count: int = Field(description="订单数")
    file_count: int = Field(description="文件数")
    package_url: str | None = Field(description="归档包下载链接")
    package_object_key: str | None = Field(description="归档包OSS对象键")
    error_message: str | None = Field(description="错误信息")
    created_by_name: str | None = Field(default=None, description="创建人姓名")
    created_at: CNDatetime = Field(description="创建时间")
    packed_at: CNDatetime | None = Field(description="打包完成时间")
    oss_deleted_at: CNDatetime | None = Field(description="OSS清理时间")
    orders: list[ArchiveOrderOut] = Field(default_factory=list, description="批次内归档订单明细")

    model_config = {"from_attributes": True}


class ArchiveBatchListResponse(BaseModel):
    items: list[ArchiveBatchOut] = Field(description="归档批次列表")
    total: int = Field(description="总数")
    page: int = Field(description="当前页码")
    size: int = Field(description="每页数量")

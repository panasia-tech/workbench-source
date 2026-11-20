from datetime import date
from decimal import Decimal

from pydantic import BaseModel, Field

from app.schemas._tz import CNDatetime


class AssetDeviceCreate(BaseModel):
    device_name: str = Field(description="设备名称")
    asset_no: str | None = Field(default=None, description="资产编号，留空自动生成")
    device_sn: str | None = Field(default=None, description="设备序列号 SN")
    device_type: str | None = Field(default=None, description="设备类型")
    owner_id: str | None = Field(default=None, description="归属员工 ID")
    owner_name: str | None = Field(default=None, description="归属员工姓名")
    owner_account: str | None = Field(default=None, description="归属员工账号")
    office_site: str | None = Field(default=None, description="办公地点")
    status: str = Field(default="IDLE", description="资产状态：IDLE=在库 / IN_USE=使用中 / SCRAPPED=已报废")
    purpose: str | None = Field(default=None, description="用途")
    purchase_date: date | None = Field(default=None, description="采购日期")
    cost: Decimal = Field(default=0, description="成本金额")
    remark: str | None = Field(default=None, description="备注")
    image_files: list[str] = Field(default_factory=list, description="现场图片文件列表")
    purchase_order_id: str | None = Field(
        default=None, description="关联采购单 ID，自动带入品牌/型号/规格/单价/图片"
    )
    brand: str | None = Field(default=None, description="品牌")
    model: str | None = Field(default=None, description="型号")
    spec: str | None = Field(default=None, description="规格")
    unit_price: Decimal | None = Field(default=None, description="单价")
    product_images: list[str] = Field(default_factory=list, description="商品图片列表（来自采购单）")


class AssetDeviceUpdate(BaseModel):
    device_name: str | None = Field(default=None, description="设备名称")
    asset_no: str | None = Field(default=None, description="资产编号")
    device_sn: str | None = Field(default=None, description="设备序列号 SN")
    device_type: str | None = Field(default=None, description="设备类型")
    owner_id: str | None = Field(default=None, description="归属员工 ID")
    owner_name: str | None = Field(default=None, description="归属员工姓名")
    owner_account: str | None = Field(default=None, description="归属员工账号")
    office_site: str | None = Field(default=None, description="办公地点")
    status: str | None = Field(default=None, description="资产状态：IDLE=在库 / IN_USE=使用中 / SCRAPPED=已报废")
    purpose: str | None = Field(default=None, description="用途")
    purchase_date: date | None = Field(default=None, description="采购日期")
    cost: Decimal | None = Field(default=None, description="成本金额")
    remark: str | None = Field(default=None, description="备注")
    image_files: list[str] | None = Field(default=None, description="现场图片文件列表")
    purchase_order_id: str | None = Field(default=None, description="关联采购单 ID")
    brand: str | None = Field(default=None, description="品牌")
    model: str | None = Field(default=None, description="型号")
    spec: str | None = Field(default=None, description="规格")
    unit_price: Decimal | None = Field(default=None, description="单价")
    product_images: list[str] | None = Field(default=None, description="商品图片列表")


class AssetDeviceOut(BaseModel):
    id: str = Field(description="主键 ID")
    asset_no: str = Field(description="资产编号")
    device_name: str = Field(description="设备名称")
    device_sn: str | None = Field(default=None, description="设备序列号 SN")
    sn_normalized: str | None = Field(default=None, description="标准化后的 SN（查重用）")
    device_type: str | None = Field(default=None, description="设备类型")
    owner_id: str | None = Field(default=None, description="归属员工 ID")
    owner_name: str | None = Field(default=None, description="归属员工姓名")
    owner_account: str | None = Field(default=None, description="归属员工账号")
    office_site: str | None = Field(default=None, description="办公地点")
    status: str = Field(description="资产状态：IDLE=在库 / IN_USE=使用中 / SCRAPPED=已报废")
    purpose: str | None = Field(default=None, description="用途")
    purchase_date: date | None = Field(default=None, description="采购日期")
    cost: Decimal = Field(description="成本金额")
    remark: str | None = Field(default=None, description="备注")
    image_files: list[str] = Field(default=[], description="现场图片文件列表（OSS 签名 URL）")
    purchase_order_id: str | None = Field(default=None, description="关联采购单 ID")
    purchase_order_no: str | None = Field(default=None, description="关联采购单号")
    brand: str | None = Field(default=None, description="品牌")
    model: str | None = Field(default=None, description="型号")
    spec: str | None = Field(default=None, description="规格")
    unit_price: Decimal | None = Field(default=None, description="单价")
    product_images: list[str] = Field(default=[], description="商品图片列表（OSS 签名 URL）")
    created_at: CNDatetime = Field(description="创建时间")
    updated_at: CNDatetime = Field(description="更新时间")

    model_config = {"from_attributes": True}


class AssetNoCheckOut(BaseModel):
    """扫码查重结果：只暴露非敏感字段（不含成本），供全员查重用。"""

    exists: bool = Field(description="资产编号是否已存在")
    device_name: str | None = Field(default=None, description="设备名称")
    owner_name: str | None = Field(default=None, description="归属员工姓名")
    status: str | None = Field(default=None, description="资产状态：IDLE=在库 / IN_USE=使用中 / SCRAPPED=已报废")
    office_site: str | None = Field(default=None, description="办公地点")
    updated_at: CNDatetime | None = Field(default=None, description="更新时间")


class AssetListResponse(BaseModel):
    items: list[AssetDeviceOut] = Field(description="资产设备列表")
    total: int = Field(description="总数")
    page: int = Field(description="当前页码")
    size: int = Field(description="每页条数")

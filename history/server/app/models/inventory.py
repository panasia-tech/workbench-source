from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, JSON, Numeric, String, false
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class Sku(Base, TimestampMixin):
    __tablename__ = "sku"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    sku_code: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    # 上架短编码(4 位):上架时分配,出库回收复用,作内部标识(见 services/short_code.py;
    # 2026-08-31 起不再嵌进闲鱼标题)
    short_code: Mapped[str | None] = mapped_column(String(8), nullable=True, index=True)
    serial_number: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    # 商品条码（69码/EAN-13）：同款商品同码，多件货会重复，非唯一；收货入库时可扫码填写。
    barcode: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    # 69码查询到的 SPU 商品信息（阿里云市场条码库返回的原始 JSON，由 barcode-lookup 接口写入）
    # none_as_null=True 必须带：JSON 列默认把 Python None 存成 JSON 字面量 'null'（IS NULL 为假），
    # 换码时清空 spu 就会让「没查到」的商品从 spu IS NULL 的筛选里漏掉。
    spu: Mapped[dict | None] = mapped_column(JSON(none_as_null=True), nullable=True)
    # RFID 标签 EPC，一物一码（每件货唯一绑定一张标签）。绑定/盘点由 PDA 手持机写入。
    rfid_epc: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True, index=True)
    purchase_order_id: Mapped[str] = mapped_column(String(36), ForeignKey("purchase_order.id"), index=True)
    inspection_id: Mapped[str] = mapped_column(String(36), ForeignKey("inspection.id"))
    product_name: Mapped[str] = mapped_column(String(256))
    brand: Mapped[str | None] = mapped_column(String(128), nullable=True)
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    spec: Mapped[str | None] = mapped_column(String(128), nullable=True)
    location_code: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    condition_grade: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # 商品种类类型（入库单选必填，存 product_type.name，与 tags 一样按名软关联）。
    # 上架时小程序按此默认选中 AI 生图种类。旧数据/议价转在库路径可为空。
    product_type: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # 货况警示：入库时从采购单 condition_warning 冗余拷贝，议价端读它标红（避免 join 采购单）
    condition_warning: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")
    condition_warning_text: Mapped[str | None] = mapped_column(String(64), nullable=True)
    cost_price: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    suggest_price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    status: Mapped[str] = mapped_column(String(32), index=True)
    reserve_source: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)
    cover_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    images: Mapped[list] = mapped_column(JSON, default=list)
    # 仓库定位图（找货/盘点用），与 images（产品实拍/上架展示用）严格分开，不得混用
    location_images: Mapped[list] = mapped_column(JSON, default=list)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    inbound_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 商品详情页的自动上架管理（链接焕新）：这件货暂停 / 这天（北京时间）之前先不动。
    # 只拦定时焕新，手动「立即重新上架」和旧链接已删等重发的不受影响。
    auto_refresh_paused: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    auto_refresh_not_before: Mapped[date | None] = mapped_column(Date, nullable=True)
    negotiated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    negotiation_remark: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # 议价证据（图片/视频混存的 OSS 公网 URL 列表），与产品实拍图 images 分开
    negotiation_media: Mapped[list] = mapped_column(JSON, default=list)
    # 议价后「召回快递」环节：业务员补传顺丰改派/再次派件截图后才算流程闭环。
    # recalled_at 为空 = 待召回快递（议价已提交但未补改派记录）；有值 = 已召回，进历史议价。
    recalled_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 顺丰改派/再次派件凭证（图片/视频混存的 OSS 公网 URL 列表）
    redispatch_media: Mapped[list] = mapped_column(JSON, default=list)
    outbound_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    purchase_order = relationship("PurchaseOrder", back_populates="skus")
    stock_events = relationship("StockEvent", back_populates="sku", order_by="StockEvent.created_at")


class StockEvent(Base):
    __tablename__ = "stock_event"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    purchase_order_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("purchase_order.id"), index=True)
    sku_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("sku.id"), index=True)
    event_type: Mapped[str] = mapped_column(String(32))
    ref_no: Mapped[str | None] = mapped_column(String(32), nullable=True)
    operator_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)

    sku = relationship("Sku", back_populates="stock_events")


class InventoryAdjustment(Base):
    __tablename__ = "inventory_adjustment"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    adjust_no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    sku_id: Mapped[str] = mapped_column(String(36), ForeignKey("sku.id"), index=True)
    adjust_type: Mapped[str] = mapped_column(String(16))
    reason: Mapped[str | None] = mapped_column(String(512), nullable=True)
    operator_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class StocktakeSession(Base, TimestampMixin):
    __tablename__ = "stocktake_session"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    session_no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    status: Mapped[str] = mapped_column(String(32), index=True)
    operator_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)
    scanned_items: Mapped[list] = mapped_column(JSON, default=list)
    diff_result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    paused_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reviewer_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    review_comment: Mapped[str | None] = mapped_column(String(512), nullable=True)


class StocktakeAdjustment(Base):
    __tablename__ = "stocktake_adjustment"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    session_id: Mapped[str] = mapped_column(String(36), ForeignKey("stocktake_session.id"), index=True)
    sku_code: Mapped[str] = mapped_column(String(64), index=True)
    diff_type: Mapped[str] = mapped_column(String(16))
    adjust_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    reason: Mapped[str | None] = mapped_column(String(512), nullable=True)
    status: Mapped[str] = mapped_column(String(32), index=True)
    adjust_no: Mapped[str | None] = mapped_column(String(32), nullable=True)
    operator_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"))
    reviewer_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    review_comment: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

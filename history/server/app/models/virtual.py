"""虚拟商品线（卡券、数字权益）：产品卡、卡券库存、从聊天认出来的订单。规矩见 services/virtual_goods.py。

卡券明文不进库：code_enc 用 ledger_crypto 加密，code_hash 只用来判重；每次看明文都记一笔 virtual_reveal。
"""
from datetime import datetime
from decimal import Decimal

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class VirtualProduct(Base, TimestampMixin):
    __tablename__ = "virtual_product"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    brand: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # 规格一句话：「双人餐 · 全国门店通用」
    face: Mapped[str | None] = mapped_column(String(256), nullable=True)
    # 分类路径，最多 4 层：["A 码券类", "A1 餐饮券", "连锁快餐饮品", "麦当劳"]
    path: Mapped[list] = mapped_column(JSON, default=list)
    # card 每单不同的码 / nocard 人人同一份内容 / topup 代充 / manual 人工
    delivery: Mapped[str] = mapped_column(String(16), default="card")
    # follow 跟卖（有同行在卖，免做第 5、6 步）/ test 路测（8 步全走）
    listing_type: Mapped[str] = mapped_column(String(16), default="test")
    # 走到第几步（1～8）；8 = 已批准上架、在售，之后每周复盘
    step: Mapped[int] = mapped_column(Integer, default=1)
    # research 研究中 / pending 等批上架 / on_sale 在售 / paused 暂停 / exited 退出
    state: Mapped[str] = mapped_column(String(16), default="research", index=True)
    cost: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    price: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    platform_fee_rate: Mapped[Decimal] = mapped_column(Numeric(6, 4), default=Decimal("0.016"))
    after_sale_reserve: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("1"))
    valid: Mapped[str | None] = mapped_column(String(64), nullable=True)
    region: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # 三个榜：{"闲鱼": "...", "淘宝": "...", "京东": "..."}；同行在售 [{platform, shop, price, url}]
    signals: Mapped[dict] = mapped_column(JSON, default=dict)
    peers: Mapped[list] = mapped_column(JSON, default=list)
    # 取得路径：{main, backup, cost, qualify, quota}
    sourcing: Mapped[dict] = mapped_column(JSON, default=dict)
    # 交付与售后：{script 话术, guide 使用指引, refund 退改规则, stop 停止条件, listing 上架文案}
    notes: Mapped[dict] = mapped_column(JSON, default=dict)
    # 合规：{level A/B/C, lawyer unsubmitted/pending/passed/rejected, note}
    compliance: Mapped[dict] = mapped_column(JSON, default=dict)
    # nocard 人人同一份内容（加密）
    shared_content_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 卖的是闲鱼上哪几条链接（人在闲鱼上发的，填商品 id）
    item_ids: Mapped[list] = mapped_column(JSON, default=list)
    warn_at: Mapped[int] = mapped_column(Integer, default=10)
    stop_at: Mapped[int] = mapped_column(Integer, default=0)
    auto_delivery: Mapped[bool] = mapped_column(Boolean, default=False)
    # 自动发之前查的三样：{refund_limit 同一买家退过几次就拦, blacklist 退款名单, prev_unconfirmed 上一单没确认}
    checks: Mapped[dict] = mapped_column(JSON, default=dict)
    decision: Mapped[str | None] = mapped_column(String(16), nullable=True)
    owner_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)
    created_by_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"))
    approved_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 主管退回第 7 步时写的意见
    reject_note: Mapped[str | None] = mapped_column(Text, nullable=True)


class VirtualEvidence(Base):
    """每一步交上来的证据（也包括第 7 步批准 / 退回、第 8 步周复盘），只增不改。"""

    __tablename__ = "virtual_evidence"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    product_id: Mapped[str] = mapped_column(String(36), ForeignKey("virtual_product.id"), index=True)
    step: Mapped[int] = mapped_column(Integer)
    # submit 交证据 / approve 批准上架 / reject 退回 / review 周复盘
    action: Mapped[str] = mapped_column(String(16), default="submit")
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    images: Mapped[list] = mapped_column(JSON, default=list)
    staff_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class VirtualCodeBatch(Base):
    __tablename__ = "virtual_code_batch"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    product_id: Mapped[str] = mapped_column(String(36), ForeignKey("virtual_product.id"), index=True)
    no: Mapped[int] = mapped_column(Integer)
    supplier: Mapped[str | None] = mapped_column(String(128), nullable=True)
    cost: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    qty: Mapped[int] = mapped_column(Integer, default=0)
    expire_on: Mapped[str | None] = mapped_column(String(16), nullable=True)
    staff_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class VirtualCode(Base):
    __tablename__ = "virtual_code"
    __table_args__ = (UniqueConstraint("product_id", "code_hash", name="uq_virtual_code_hash"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    product_id: Mapped[str] = mapped_column(String(36), ForeignKey("virtual_product.id"), index=True)
    batch_id: Mapped[str] = mapped_column(String(36), ForeignKey("virtual_code_batch.id"), index=True)
    code_enc: Mapped[str] = mapped_column(Text)
    code_hash: Mapped[str] = mapped_column(String(64))
    # avail 可用 / sold 已发给买家 / void 作废（买家说用不了、过期）
    status: Mapped[str] = mapped_column(String(16), default="avail", index=True)
    order_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    void_note: Mapped[str | None] = mapped_column(String(256), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class VirtualOrder(Base, TimestampMixin):
    """一笔付款 = 一单：会话里每出现一条买家的「我已付款」就记一单（paid_msg_id 去重）。"""

    __tablename__ = "virtual_order"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    product_id: Mapped[str] = mapped_column(String(36), ForeignKey("virtual_product.id"), index=True)
    paid_msg_id: Mapped[str] = mapped_column(String(36), unique=True)
    conversation_id: Mapped[str] = mapped_column(String(36), index=True)
    account_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    item_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    buyer_key: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    buyer_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    paid_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    # waiting 没码可发 / held 检查拦住 / ready 可以发 / sending 发出中 / sent 码已发到聊天
    # / done 买家确认了 / refund 买家申请退款 / closed 退了或关了
    status: Mapped[str] = mapped_column(String(16), default="ready", index=True)
    hits: Mapped[list] = mapped_column(JSON, default=list)
    platform_status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    code_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    send_task_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    send_error: Mapped[str | None] = mapped_column(String(256), nullable=True)
    sent_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    released_by_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)


class VirtualReveal(Base):
    """谁在什么时候看了 / 发了哪张码（显示卡密留痕）。"""

    __tablename__ = "virtual_reveal"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    code_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    product_id: Mapped[str] = mapped_column(String(36), index=True)
    order_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # reveal 看明文 / send 发到聊天 / auto 自动发 / void 作废
    action: Mapped[str] = mapped_column(String(16))
    staff_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class VirtualBuyerFlag(Base):
    """退款名单：退过款 / 闹过的买家，自动发货前先拦（全线共用，不分产品）。"""

    __tablename__ = "virtual_buyer_flag"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    buyer_key: Mapped[str] = mapped_column(String(128), unique=True)
    buyer_name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    refunds: Mapped[int] = mapped_column(Integer, default=0)
    blacklisted: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[str | None] = mapped_column(String(256), nullable=True)
    staff_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("staff.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

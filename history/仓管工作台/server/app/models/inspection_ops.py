"""验货规范、逐项全检、开箱凭证、异常跟踪、出库复核。

都挂在现有的验货单（inspection）和 SKU 上，不另起一套单据。
"""
from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class InspectionTemplate(Base, TimestampMixin):
    """某品类/品牌/型号的验货流程。匹配时型号优先，其次品牌，最后品类。"""

    __tablename__ = "inspection_template"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    name: Mapped[str] = mapped_column(String(128))
    category: Mapped[str] = mapped_column(String(64), index=True)
    brand: Mapped[str | None] = mapped_column(String(128), nullable=True)
    model: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # 商品名含这些词就算这个品类（采购单上没有品类字段，验货时只有商品名）
    keywords: Mapped[list] = mapped_column(JSON, default=list)
    # [{key, title, guide, need_photo}]
    steps: Mapped[list] = mapped_column(JSON, default=list)
    version: Mapped[int] = mapped_column(Integer, default=1)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class InspectionCheckItem(Base):
    """一张验货单的一个检查项。开始验货时从规范复制过来，之后改规范不影响这张单。"""

    __tablename__ = "inspection_check_item"
    __table_args__ = (UniqueConstraint("inspection_id", "item_key", name="uq_inspection_check_item"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    inspection_id: Mapped[str] = mapped_column(String(36), ForeignKey("inspection.id"), index=True)
    template_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    template_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    item_key: Mapped[str] = mapped_column(String(64))
    title: Mapped[str] = mapped_column(String(128))
    guide: Mapped[str | None] = mapped_column(Text, nullable=True)
    need_photo: Mapped[bool] = mapped_column(Boolean, default=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    # 空=没验；PASS / FAIL / UNTESTABLE（无法测试，必须写原因并留凭证）
    result: Mapped[str | None] = mapped_column(String(16), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    evidence: Mapped[list] = mapped_column(JSON, default=list)
    # 不通过时：瑕疵部位、卖家原来怎么描述的（和实测对比，给采购议价用）
    defect_part: Mapped[str | None] = mapped_column(String(64), nullable=True)
    seller_claim: Mapped[str | None] = mapped_column(String(255), nullable=True)
    operator_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    checked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 采购工作台 W11（11-16）：外观 / 功能 / 配件 / 包装 / 型号分栏；卖家原来说过的问题不算新问题；
    # 原因不明（运输还是卖家）先标待判，不默认卖家负责。见 services/inspection_compare.py
    dimension: Mapped[str | None] = mapped_column(String(16), nullable=True)
    disclosed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    cause: Mapped[str | None] = mapped_column(String(16), nullable=True)


class InspectionCheckItemLog(Base):
    """检查项每次填写、改答案、补测的记录：改前改后和经办人。改答案不再直接覆盖无痕。"""

    __tablename__ = "inspection_check_item_log"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    inspection_id: Mapped[str] = mapped_column(String(36), ForeignKey("inspection.id"), index=True)
    item_key: Mapped[str] = mapped_column(String(64))
    # FILL 第一次填 / CHANGE 提交前改答案 / RETEST 提交后补测（无法测试 → 通过/不通过）
    action: Mapped[str] = mapped_column(String(16))
    old_result: Mapped[str | None] = mapped_column(String(16), nullable=True)
    new_result: Mapped[str | None] = mapped_column(String(16), nullable=True)
    old_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    new_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    old_evidence: Mapped[list] = mapped_column(JSON, default=list)
    operator_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class InspectionEvidence(Base):
    """开箱视频、商品照、瑕疵照。sku_id 在入库后补上，采购/销售都按它查。"""

    __tablename__ = "inspection_evidence"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    inspection_id: Mapped[str] = mapped_column(String(36), ForeignKey("inspection.id"), index=True)
    purchase_order_id: Mapped[str] = mapped_column(String(36), index=True)
    sku_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String(16))  # UNBOX_VIDEO / PRODUCT_PHOTO / DEFECT_PHOTO
    url: Mapped[str] = mapped_column(String(512))
    item_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    device_label: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # 开始录的时间（不是上传时间）；录制中断（设备断开、录制出错、页面关闭后补传）照实标出，不冒充完整原片
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    interrupted: Mapped[bool] = mapped_column(Boolean, default=False, server_default="0")
    gap_note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    recorded_by: Mapped[str] = mapped_column(String(36))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class InspectionException(Base, TimestampMixin):
    """验货发现的异常：拒签退回、退货退款都在这一条上走完。不影响继续验货。"""

    __tablename__ = "inspection_exception"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    inspection_id: Mapped[str] = mapped_column(String(36), ForeignKey("inspection.id"), index=True)
    purchase_order_id: Mapped[str] = mapped_column(String(36), index=True)
    exception_type: Mapped[str] = mapped_column(String(16))  # DAMAGED / MISMATCH / OTHER
    description: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), index=True, default="OPEN")  # OPEN / CLOSED
    raised_by: Mapped[str] = mapped_column(String(36))
    raised_at: Mapped[datetime] = mapped_column(DateTime)
    # 负责人。业务员是接单的那个人，接单前为空
    handler_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    purchaser_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # 10 分钟时限：业务员接单、采购员交首轮凭证
    due_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    handler_ack_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    purchaser_evidence_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    purchaser_evidence: Mapped[list] = mapped_column(JSON, default=list)
    escalated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 拒签与退回物流
    reject_status: Mapped[str] = mapped_column(String(16), default="PENDING")
    return_tracking_no: Mapped[str | None] = mapped_column(String(64), nullable=True)
    return_carrier: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # 退回的目标发件网点
    return_station: Mapped[str | None] = mapped_column(String(128), nullable=True)
    # 退回运输：IN_TRANSIT 在途 / ABNORMAL 异常（丢件、拒收等，要人接管）/ SIGNED 网点已签收；「寄出」不等于「退到」
    return_logistics: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # 网点签收或可核对的接收凭证（截图、物流签收页）
    return_sign_evidence: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # 退款：申请不等于到账，两个状态分开（APPLIED 已申请 / ACCEPTED 已受理 / PARTIAL 部分到账 / RECEIVED 全额到账 / DENIED 被驳回）
    refund_status: Mapped[str] = mapped_column(String(16), default="PENDING")
    refund_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    # 已发生的扣费（运费等），核对「退款 + 扣费 = 采购金额」
    refund_fee: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    # 不足额、费用争议的原因和复核结果
    refund_shortfall_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    final_result: Mapped[str | None] = mapped_column(Text, nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 采购工作台 W11：从哪几个不通过的检查项建的、对照的是哪一版商品快照
    check_item_keys: Mapped[list | None] = mapped_column(JSON, nullable=True)
    snapshot_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # 采购工作台 W12：平台售后这一段（见 services/purchase_aftersale.py）
    aftersale_status: Mapped[str] = mapped_column(String(16), default="none", server_default="none")
    aftersale_deadline: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    deadline_source: Mapped[str | None] = mapped_column(String(16), nullable=True)
    aftersale_receipt: Mapped[list | None] = mapped_column(JSON, nullable=True)
    aftersale_submitted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    keep_offers: Mapped[list | None] = mapped_column(JSON, nullable=True)


class InspectionExceptionEvent(Base):
    """异常的处理留痕，通知也记在这里。"""

    __tablename__ = "inspection_exception_event"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    exception_id: Mapped[str] = mapped_column(String(36), ForeignKey("inspection_exception.id"), index=True)
    action: Mapped[str] = mapped_column(String(32))
    # 通知对象；不是通知时为空
    target_staff_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    operator_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 送达：PENDING 待发 / SENDING 发送中 / SENT 已发出 / NO_ACCOUNT 钉钉企微都没绑 / FAILED 发送失败（会重试）
    # 「已发出」是钉钉/企微接口收下了，不代表对方已经看了
    channel_status: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)
    channel_detail: Mapped[str | None] = mapped_column(String(255), nullable=True)
    channel_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 实际调了几次发送接口（失败会重试，到上限停）
    channel_attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class OutboundReview(Base):
    """销售发货前的复核。出库时消耗掉，退货后再发要重新复核。"""

    __tablename__ = "outbound_review"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    sku_id: Mapped[str] = mapped_column(String(36), ForeignKey("sku.id"), index=True)
    reviewer_id: Mapped[str] = mapped_column(String(36))
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 复核当时看到的内容，事后凭证有变也能对上
    snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    outbound_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # OK 核对无误 / PROBLEM 发现新问题：最新一条未用掉的是 PROBLEM 时一律不许出库（不看开关），处理后重新复核成 OK
    result: Mapped[str] = mapped_column(String(16), default="OK", server_default="OK")
    # 复核时扫/输的货号或序列号（核对实物身份）；当前货况照片
    identity_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    media: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # PROBLEM 被后来的 OK 复核接过去的时间（问题已处理）
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ReturnRecheck(Base):
    """客户退回的货重新验一遍（禅道 WH10-07/10）。一张退货单一份；按原验货的检查项逐项复验，对照入库时的结果。

    开了「退货入库前必须复验」时：没做完复验不能收货入库；复验发现问题只能标异常挂起，等管理员裁决。
    """

    __tablename__ = "return_recheck"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    return_order_id: Mapped[str] = mapped_column(String(36), unique=True)
    sku_id: Mapped[str] = mapped_column(String(36), index=True)
    inspection_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # 检查项照搬原验货单的（没有就用当前匹配的规范），每项带入库时的结果供对照：
    # [{key,title,guide,standard,need_photo,before_result,before_note,result,note,evidence,checked_at}]
    items: Mapped[list] = mapped_column(JSON, default=list)
    # OK 和入库时一致，可以恢复在库 / PROBLEM 发现新问题
    result: Mapped[str | None] = mapped_column(String(16), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    media: Mapped[list | None] = mapped_column(JSON, nullable=True)
    created_by: Mapped[str] = mapped_column(String(36))
    finished_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 应用层写 UTC（库的 now() 是北京时间，和历次影像按时间排会错位）
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

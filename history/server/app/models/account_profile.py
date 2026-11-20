from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class GcAccountProfile(Base, TimestampMixin):
    """群控账号初始化档案：一个 gc 闲鱼账号一行。

    自动采集(App identity 帧 / PC adb 兜底 → gc 服务器 gc_device,本表只镜像 + 承接人工补全):
    - 自动：昵称/会员名(tb)/设备 SN/双 IMEI/手机号/关联资产
    - 手填：运营商/套餐资费/法人名称/账号种类(8 种)/备注/异常处理策略(多选标签)
    必填手填项齐 → status COMPLETE。
    """

    __tablename__ = "gc_account_profile"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    # gc 侧账号 id(群控服务器 gc_account.id),一账号一档案
    gc_account_id: Mapped[str] = mapped_column(String(36), unique=True, index=True)
    # ---- 自动采集(只空补齐,不覆盖人工/已有值) ----
    nick: Mapped[str] = mapped_column(String(64), index=True)                    # 闲鱼昵称
    member_name: Mapped[str | None] = mapped_column(String(64), nullable=True)   # 闲鱼会员名(tb 开头)
    gc_device_id: Mapped[str | None] = mapped_column(String(36), nullable=True)  # 当前激活设备(gc 侧 id)
    device_serial: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    imei1: Mapped[str | None] = mapped_column(String(32), nullable=True)
    imei2: Mapped[str | None] = mapped_column(String(32), nullable=True)
    phone_number: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # 与资产管理结合:按 device_serial 匹配 asset_device.device_sn/sn_normalized
    asset_device_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("asset_device.id"), nullable=True, index=True
    )
    asset_no: Mapped[str | None] = mapped_column(String(32), nullable=True)      # 冗余资产编号,免 join
    # ---- 员工手填 ----
    carrier: Mapped[str | None] = mapped_column(String(32), nullable=True)       # 运营商
    plan_details: Mapped[str | None] = mapped_column(Text, nullable=True)        # 套餐资费
    legal_person: Mapped[str | None] = mapped_column(String(64), nullable=True)  # 法人名称
    account_type: Mapped[str | None] = mapped_column(String(16), nullable=True)  # 个人1/个人2/企业1~6
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 异常处理策略(多选纯标签):FACE_SCAN=法人扫脸 / BAD_REGISTER=不当注册 / NETWORK_DOWN=断网(续费软路由和话费充值)
    exception_strategies: Mapped[list] = mapped_column(JSON, default=list)
    # ---- 状态 ----
    status: Mapped[str] = mapped_column(String(16), default="PENDING", index=True)  # PENDING/COMPLETE
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_by_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("staff.id"), nullable=True
    )

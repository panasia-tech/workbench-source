"""资料、版本、配套文件、外部凭证、发布记录。

资料 ID 是固定入口 /m/<资料ID> 的一部分，建了就不改；换文件只新增版本、切换 published_version_id。
"""
from datetime import date, datetime, timezone

from sqlalchemy import ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


# 受众：public 公开宣发（要逐份确认，没确认按 staff 处理）、staff 公司内部通用、
# roles 岗位专属（roles 列出 ERP 角色或平台分组）、external 定向外部（只认外部凭证）
AUDIENCES = ("public", "staff", "roles", "external")


class MediaItem(Base):
    __tablename__ = "media_item"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    title: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(16), default="video")  # video / doc
    audience: Mapped[str] = mapped_column(String(16), default="staff")
    roles: Mapped[str] = mapped_column(String(500), default="")  # 逗号分隔
    description: Mapped[str] = mapped_column(Text, default="")
    # 工作台「培训视频」按课程分组、按 sort 排：series 是课程名（例「仓库通用基础课」），sort 是第几集
    series: Mapped[str] = mapped_column(String(100), default="")
    sort: Mapped[int] = mapped_column(default=0)
    published_version_id: Mapped[int | None] = mapped_column(ForeignKey("media_version.id", use_alter=True))
    public_confirmed_by: Mapped[str | None] = mapped_column(String(64))
    public_confirmed_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

    versions: Mapped[list["MediaVersion"]] = relationship(
        back_populates="item", foreign_keys="MediaVersion.item_id", order_by="MediaVersion.version_no"
    )
    published_version: Mapped["MediaVersion | None"] = relationship(foreign_keys=[published_version_id])
    attachments: Mapped[list["Attachment"]] = relationship(back_populates="item", order_by="Attachment.id")

    @property
    def role_set(self) -> set[str]:
        # ERP 角色是大写（WAREHOUSE），配的时候大小写随意
        return {r.strip().casefold() for r in self.roles.split(",") if r.strip()}


class MediaVersion(Base):
    __tablename__ = "media_version"
    __table_args__ = (UniqueConstraint("item_id", "version_no"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    item_id: Mapped[str] = mapped_column(ForeignKey("media_item.id"))
    version_no: Mapped[int]
    # 播放用的轻量版；母版另存，只给维护人员取
    object_key: Mapped[str] = mapped_column(String(500))
    content_type: Mapped[str] = mapped_column(String(100))
    size: Mapped[int]
    sha256: Mapped[str] = mapped_column(String(64))
    source_path: Mapped[str] = mapped_column(String(1000), default="")
    master_key: Mapped[str | None] = mapped_column(String(500))
    master_size: Mapped[int | None]
    master_sha256: Mapped[str | None] = mapped_column(String(64))
    # 上传后回读大小和校验值对上才算 verified，没对上的版本不许发布
    verified_at: Mapped[datetime | None]
    note: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

    item: Mapped[MediaItem] = relationship(back_populates="versions", foreign_keys=[item_id])


class Attachment(Base):
    """配套教材：PDF 在线预览，Word / PowerPoint 下载原件，MD 当说明直接读。"""

    __tablename__ = "media_attachment"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    item_id: Mapped[str] = mapped_column(ForeignKey("media_item.id"))
    title: Mapped[str] = mapped_column(String(200))
    object_key: Mapped[str] = mapped_column(String(500))
    content_type: Mapped[str] = mapped_column(String(100))
    size: Mapped[int]
    sha256: Mapped[str] = mapped_column(String(64))
    source_path: Mapped[str] = mapped_column(String(1000), default="")
    verified_at: Mapped[datetime | None]
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

    item: Mapped[MediaItem] = relationship(back_populates="attachments")


class ExternalPass(Base):
    """给外部人员的访问凭证：限定资料、有到期、可撤销。库里只存令牌的哈希。"""

    __tablename__ = "media_pass"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_sha256: Mapped[str] = mapped_column(String(64), unique=True)
    label: Mapped[str] = mapped_column(String(200))
    item_ids: Mapped[str] = mapped_column(Text)  # 逗号分隔
    expires_at: Mapped[datetime]
    revoked_at: Mapped[datetime | None]
    created_by: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(default=utcnow)

    @property
    def item_set(self) -> set[str]:
        return {i.strip() for i in self.item_ids.split(",") if i.strip()}


class PublishLog(Base):
    __tablename__ = "media_publish_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    item_id: Mapped[str] = mapped_column(ForeignKey("media_item.id"))
    from_version_id: Mapped[int | None]
    to_version_id: Mapped[int]
    action: Mapped[str] = mapped_column(String(16))  # publish / rollback
    actor: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(default=utcnow)


class PlayLog(Base):
    """取播放地址的记录：同一天同一个人看同一版本记一行，续签地址只加 count。估外网流量和费用用（mediactl usage）。"""

    __tablename__ = "media_play_log"
    __table_args__ = (UniqueConstraint("day", "item_id", "version_id", "viewer_key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    day: Mapped[date]  # 北京时间，和阿里云账单同一天界
    item_id: Mapped[str] = mapped_column(String(64))
    version_id: Mapped[int]
    viewer_key: Mapped[str] = mapped_column(String(80))  # staff:<员工ID> / pass:<凭证ID> / guest:<IP+UA 摘要>
    size: Mapped[int]  # 这一版视频多大：按看完一遍估流量，是上限
    count: Mapped[int] = mapped_column(default=1)
    first_at: Mapped[datetime] = mapped_column(default=utcnow)


class AlertLog(Base):
    """费用提醒发过没有：一个月只提醒一次。"""

    __tablename__ = "media_alert_log"

    month: Mapped[str] = mapped_column(String(7), primary_key=True)  # 2026-11
    yuan: Mapped[float]
    sent_at: Mapped[datetime] = mapped_column(default=utcnow)

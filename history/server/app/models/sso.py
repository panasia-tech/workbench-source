"""统一登录：ERP 当 Authentik 的账号来源（OIDC 授权码），员工 → 平台分组，以及同步进 Authentik、Frappe 的对照。

设计和取舍写在 services/oidc_provider.py、services/authentik_sync.py、services/frappe_sync.py、
services/authentik_access.py、services/frappe_departments.py 的开头；接入步骤见 docs/统一登录接入说明.md。
"""
from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import TimestampMixin, new_uuid


class OidcAuthCode(Base, TimestampMixin):
    """一次 ERP 账号登录：授权码，以及拿它换出来的 access_token。

    两个 worker 共用，所以落库不放内存。码和令牌都只存 SHA-256，库里读到的东西拿去也用不了。
    授权码 60 秒内、只能换一次；同一个码再来换，连同已经换出去的 access_token 一起作废（revoked_at）。
    """

    __tablename__ = "oidc_auth_code"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    code_hash: Mapped[str] = mapped_column(String(64), unique=True)
    client_id: Mapped[str] = mapped_column(String(128))
    staff_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)
    redirect_uri: Mapped[str] = mapped_column(String(512))
    scope: Mapped[str] = mapped_column(String(255))
    nonce: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # PKCE（只收 S256）
    code_challenge: Mapped[str] = mapped_column(String(128))
    # 输密码的时间（id_token 的 auth_time）
    auth_time: Mapped[datetime] = mapped_column(DateTime)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    access_token_hash: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    access_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class PlatformGroup(Base, TimestampMixin):
    """平台分组：员工在统一登录里进哪些组，各系统再按组给角色。

    进组有三种：按 ERP 角色自动进（roles）；手工挂到具体员工上（platform_group_member，
    比如某个人额外进「工作台老板」）；按 Frappe HR 员工档案上的部门进（frappe_department_map，四期）。
    分组在 Authentik 里由同步建、同步维护组员。

    authentik_* 是同步回写的：这个组在 Authentik 里对上了哪个组。登录时只把对上了的组发给
    Authentik（见 services/platform_groups.py 的 groups_for_staff）——没同步过的新组、改了名还没
    同步的组、和统一登录里别人的组重名的组，都不发。
    """

    __tablename__ = "platform_group"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    # 组名就是各系统看到的组名（工作台 AUTH_BOSS_GROUPS 这类配置填的就是它）。80 字是 ERP 自己定的上限
    name: Mapped[str] = mapped_column(String(80), unique=True)
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # 按这些 ERP 角色自动进组（只认真人角色，见 enums.HUMAN_ROLES）
    roles: Mapped[list] = mapped_column(JSON, default=list)
    # Authentik 里对上的组（pk 是 UUID）和当时的组名；同步出问题时 note 写原因
    authentik_pk: Mapped[str | None] = mapped_column(String(64), nullable=True)
    authentik_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    authentik_note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    authentik_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class PlatformGroupMember(Base, TimestampMixin):
    """手工挂进平台分组的员工（不看角色）。"""

    __tablename__ = "platform_group_member"
    __table_args__ = (UniqueConstraint("group_id", "staff_id", name="uq_platform_group_member"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    group_id: Mapped[str] = mapped_column(String(36), ForeignKey("platform_group.id"), index=True)
    staff_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)


class AuthentikAccount(Base, TimestampMixin):
    """员工在 Authentik 里的号，同步确认过才有这一行。

    ERP 登录页只给有这一行、且用户名对得上的员工签发身份：Authentik 那边按用户名认领同步建好的号，
    这一行保证被认领的一定是 ERP 同步建的号，不会是统一登录里别人的同名号（为什么见
    services/authentik_sync.py 开头）。
    """

    __tablename__ = "authentik_account"

    staff_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), primary_key=True)
    authentik_pk: Mapped[int] = mapped_column(Integer)
    authentik_username: Mapped[str] = mapped_column(String(150))
    synced_at: Mapped[datetime] = mapped_column(DateTime)


class FrappeRoleMap(Base, TimestampMixin):
    """平台分组 → Frappe 角色（hr.panasia.fun 一个站点装着 HR、Learning、CRM）。

    group_id 为空 = 所有员工（能用 ERP 账号登录统一登录的在职员工都给）。同步按这张表给角色，撤的时候只撤
    它自己加上去的（见 FrappeAccount.roles），别人在 Frappe 里给的不动。Frappe 自己按员工档案管的角色
    （Employee 这些）不能写进来，见 services/frappe_sync.py 的 BLOCKED_ROLES。
    """

    __tablename__ = "frappe_role_map"
    __table_args__ = (UniqueConstraint("group_id", "role", name="uq_frappe_role_map"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    group_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("platform_group.id"), nullable=True, index=True)
    # Frappe 的角色名（Role 的主键，Frappe 那边最长 140）
    role: Mapped[str] = mapped_column(String(140))


class PlatformAccessMap(Base, TimestampMixin):
    """平台分组 → 能进哪些系统（统一登录里的应用，后台「统一登录」页的「能进哪些系统」卡片）。

    group_id 为空 = 所有员工（能用 ERP 账号登录统一登录的在职员工都能进）。system 是 services/authentik_access.py
    里 SYSTEMS 的 key，一个系统对应 Authentik 里一个或几个应用。同步按这张表在应用上加减绑定，只碰它自己的绑定
    （ERP 建的组、两条「ERP 同步：」开头的策略），别人绑的一律不动。员工工作台不在表里：它有自己的策略，固定给所有员工。
    """

    __tablename__ = "platform_access_map"
    __table_args__ = (UniqueConstraint("group_id", "system", name="uq_platform_access_map"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    group_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("platform_group.id"), nullable=True, index=True)
    system: Mapped[str] = mapped_column(String(32))


class FrappeAccount(Base, TimestampMixin):
    """同步在 Frappe 里给员工建的号，和同步加上去的角色（同步写回）。

    roles 是同步自己加上去、归它撤的角色：换了分组、映射里删掉了，就凭这个从当初给过的人身上撤掉；不在这里的
    （HR 手工给的、各 app 自己加的）同步不撤。认号以 Frappe 那边为准（邮箱 + 创建人），这张表丢了，同步只会
    少撤，不会多撤。
    """

    __tablename__ = "frappe_account"

    staff_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), primary_key=True)
    # Frappe 的用户名就是邮箱（<员工ID>@staff.panasia.fun）
    frappe_user: Mapped[str] = mapped_column(String(140))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    roles: Mapped[list] = mapped_column(JSON, default=list)
    synced_at: Mapped[datetime] = mapped_column(DateTime)


class FrappeDepartmentMap(Base, TimestampMixin):
    """Frappe HR 的部门 → 平台分组（后台「统一登录」页的「部门 → 分组」卡片，四期）。

    一个部门可以进几个组。配在一个部门上，它下面各级部门的人也算。department 是 Frappe 里部门的名字（Department
    的主键，带公司后缀，比如「销售 - 泛亚」），部门在 Frappe 里改了名，这里要跟着改。见 services/frappe_departments.py。
    """

    __tablename__ = "frappe_department_map"
    __table_args__ = (UniqueConstraint("department", "group_id", name="uq_frappe_department_map"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    department: Mapped[str] = mapped_column(String(140))
    group_id: Mapped[str] = mapped_column(String(36), ForeignKey("platform_group.id"), index=True)


class FrappeEmployee(Base, TimestampMixin):
    """Frappe 同步读到的员工档案（Employee）：只存 User ID 是 ERP 占位邮箱、对得上 ERP 员工的（同步写回）。

    每次读 Frappe 成功整张重写；读不到就留着上一轮的，不会因为一时连不上把人移出组。登录、统一登录同步、后台按这张表
    算「按部门进组」，不现查 Frappe（services/platform_groups.py 的 membership）。状态是 Active 的才算；别的状态也存着，
    后台员工列表上看得出他为什么不算。
    """

    __tablename__ = "frappe_employee"

    # 员工档案号（Employee 的主键，比如 HR-EMP-00001）
    employee: Mapped[str] = mapped_column(String(140), primary_key=True)
    staff_id: Mapped[str] = mapped_column(String(36), ForeignKey("staff.id"), index=True)
    employee_name: Mapped[str] = mapped_column(String(140), default="")
    department: Mapped[str | None] = mapped_column(String(140), nullable=True)
    # 部门和它的各级上级（自己在前，一直到根），配在上级部门上的也算他
    department_path: Mapped[list] = mapped_column(JSON, default=list)
    # Active / Inactive / Suspended / Left
    status: Mapped[str] = mapped_column(String(32))
    synced_at: Mapped[datetime] = mapped_column(DateTime)

from pydantic import BaseModel, Field

from app.schemas._tz import CNDatetime


class SsoMemberOut(BaseModel):
    id: str = Field(description="员工ID")
    username: str = Field(description="登录账号")
    name: str = Field(description="姓名")
    staff_no: str = Field(description="工号")


class PlatformGroupOut(BaseModel):
    id: str = Field(description="分组ID")
    name: str = Field(description="组名（各系统看到的组名）")
    description: str | None = Field(default=None, description="说明")
    roles: list[str] = Field(description="按这些 ERP 角色自动进组")
    members: list[SsoMemberOut] = Field(description="手工挂进来的员工")
    synced: bool = Field(description="统一登录里已经对上（登录时会把这个组发过去）")
    authentik_note: str | None = Field(default=None, description="同步没对上的原因")
    authentik_synced_at: CNDatetime | None = Field(default=None, description="最近一次同步")
    departments: list[str] = Field(default=[], description="按这些 Frappe 部门进组（下级部门的人也算）")
    powerful: str | None = Field(default=None, description="权限大的组给一句为什么（配到部门上时提醒）")


class PlatformGroupWrite(BaseModel):
    name: str | None = Field(default=None, description="组名")
    description: str | None = Field(default=None, description="说明")
    roles: list[str] | None = Field(default=None, description="按这些 ERP 角色自动进组（只能是真人角色）")
    member_ids: list[str] | None = Field(default=None, description="手工挂进来的员工ID（整组覆盖）")


class SsoAccountOut(BaseModel):
    authentik_username: str = Field(description="统一登录里的用户名")
    synced_at: CNDatetime = Field(description="同步最近一次确认")


class SsoGroupSourceOut(BaseModel):
    kind: str = Field(description="role=按 ERP 角色 / manual=手工挂 / department=按 Frappe 部门")
    detail: str | None = Field(default=None, description="按哪个角色、哪个部门（配在上级部门上的，是那个上级部门）")


class SsoEmployeeOut(BaseModel):
    employee: str = Field(description="Frappe 员工档案号")
    employee_name: str = Field(description="档案上的姓名")
    department: str | None = Field(default=None, description="部门")
    path: list[str] = Field(default=[], description="部门和它的各级上级（自己在前）")
    status: str = Field(description="档案状态（Active 才算）")
    synced_at: CNDatetime | None = Field(default=None, description="Frappe 同步读到的时间")


class SsoStaffOut(BaseModel):
    id: str = Field(description="员工ID（统一登录里的 sub）")
    staff_no: str = Field(description="工号")
    username: str = Field(description="登录账号")
    name: str = Field(description="姓名")
    role: str = Field(description="角色")
    status: str = Field(description="账号状态")
    groups: list[str] = Field(description="登录时发给统一登录的组")
    groups_pending: list[str] = Field(description="该进、但统一登录里还没对上的组（等同步）")
    account: SsoAccountOut | None = Field(default=None, description="统一登录里的号（同步开好才有）")
    can_login: bool = Field(description="现在能不能用 ERP 账号登录统一登录")
    reason: str | None = Field(default=None, description="不能登录的原因")
    frappe_roles: list[str] = Field(default=[], description="按分组该有的 Frappe 角色")
    frappe_user: str | None = Field(default=None, description="同步在 Frappe 里给他建的号（邮箱），还没建是空")
    systems: list[str] = Field(default=[], description="按分组能进的系统（key，带固定的员工工作台）")
    group_sources: dict[str, list[SsoGroupSourceOut]] = Field(
        default={}, description="组名 → 因为什么进这个组（发的、等同步的组都有）")
    frappe_employees: list[SsoEmployeeOut] = Field(
        default=[], description="Frappe 里关联到他的员工档案（Frappe 同步上一轮读到的）")


class SsoStatusOut(BaseModel):
    oidc_enabled: bool = Field(description="OIDC_ENABLED 开没开")
    oidc_problem: str | None = Field(default=None, description="开了但没配好的原因")
    issuer: str | None = Field(default=None, description="发行方")
    discovery_url: str | None = Field(default=None, description="发现文档地址（Authentik 登录源填这个）")
    jwks_url: str | None = Field(default=None, description="JWKS 地址")
    redirect_uris: list[str] = Field(default=[], description="登记的回调地址")
    kid: str | None = Field(default=None, description="签名公钥指纹")
    sync_enabled: bool = Field(description="AUTHENTIK_SYNC_ENABLED 开没开")
    sync_problem: str | None = Field(default=None, description="同步跑不了的原因（预演也跑不了）")
    authentik_url: str = Field(description="Authentik 地址")
    user_path: str = Field(description="同步建的号放在哪个路径下")
    frappe_enabled: bool = Field(description="FRAPPE_SYNC_ENABLED 开没开")
    frappe_problem: str | None = Field(default=None, description="Frappe 同步跑不了的原因（预演也跑不了）")
    frappe_url: str = Field(description="Frappe 地址")
    access_enabled: bool = Field(default=False, description="AUTHENTIK_ACCESS_SYNC_ENABLED 开没开（能进哪些系统）")


class SyncRequest(BaseModel):
    dry_run: bool = Field(default=True, description="true=只预演不改；false=真改（要先开同步开关）")


class FrappeRoleRowOut(BaseModel):
    group_id: str | None = Field(default=None, description="分组ID；空 = 所有员工")
    group_name: str | None = Field(default=None, description="组名；空 = 所有员工")
    roles: list[str] = Field(description="给的 Frappe 角色")


class FrappeRoleRowWrite(BaseModel):
    group_id: str | None = Field(default=None, description="分组ID；空 = 所有员工")
    roles: list[str] = Field(default=[], description="给的 Frappe 角色")


class FrappeRoleMapWrite(BaseModel):
    rows: list[FrappeRoleRowWrite] = Field(description="整张映射（没写的分组 = 不给 Frappe 角色）")


class FrappeRoleOptionsOut(BaseModel):
    roles: list[str] = Field(description="Frappe 里能选的角色（停用的、Frappe 自己管的不列）")
    problem: str | None = Field(default=None, description="读不到时的原因（页面照样能手填角色名）")


class AccessSystemOut(BaseModel):
    key: str = Field(description="系统")
    name: str = Field(description="名字")
    description: str = Field(description="一句话说明")
    apps: list[str] = Field(description="统一登录里对应的应用（slug）")
    note: str | None = Field(default=None, description="页面上的提示")


class AccessRowOut(BaseModel):
    group_id: str | None = Field(default=None, description="分组ID；空 = 所有员工")
    group_name: str | None = Field(default=None, description="组名；空 = 所有员工")
    systems: list[str] = Field(description="能进的系统（key）")


class AccessMapOut(BaseModel):
    systems: list[AccessSystemOut] = Field(description="能配的系统（按页面顺序）")
    fixed: list[AccessSystemOut] = Field(description="固定给所有员工、这里不改的（员工工作台）")
    rows: list[AccessRowOut] = Field(description="所有员工一行，每个分组一行（没配的也列出来）")


class AccessRowWrite(BaseModel):
    group_id: str | None = Field(default=None, description="分组ID；空 = 所有员工")
    systems: list[str] = Field(default=[], description="能进的系统（key）")


class AccessMapWrite(BaseModel):
    rows: list[AccessRowWrite] = Field(description="整张映射（没写的分组 = 哪个系统都不能进）")


class DepartmentMapRowOut(BaseModel):
    department: str = Field(description="Frappe 的部门（下级部门的人也算）")
    group_ids: list[str] = Field(description="进这些分组")


class DepartmentMapRowWrite(BaseModel):
    department: str = Field(description="Frappe 的部门")
    group_ids: list[str] = Field(default=[], description="进这些分组（空 = 不按这个部门进组）")


class DepartmentMapWrite(BaseModel):
    rows: list[DepartmentMapRowWrite] = Field(description="整张映射（没写的部门 = 不按它进组）")


class DepartmentOptionOut(BaseModel):
    name: str = Field(description="部门（Frappe 里的名字）")
    parent: str | None = Field(default=None, description="上级部门")
    depth: int = Field(description="第几级（根是 0），下拉里缩进用")
    disabled: bool = Field(default=False, description="Frappe 里停用了")


class DepartmentOptionsOut(BaseModel):
    departments: list[DepartmentOptionOut] = Field(description="Frappe 里的部门（按树的顺序）")
    problem: str | None = Field(default=None, description="读不到时的原因（页面照样能手填部门名）")

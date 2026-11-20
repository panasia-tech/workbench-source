from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field


class StaffOut(BaseModel):
    id: str = Field(description="员工ID")
    staff_no: str = Field(description="工号")
    username: str = Field(description="登录用户名")
    name: str = Field(description="姓名")
    role: str = Field(description="角色 PURCHASER=采购/WAREHOUSE=仓库/NEGOTIATOR=议价/SALES=销售/FINANCE=财务/ADMIN=管理员/RFID_DEVICE=RFID设备/CRAWLER=爬虫设备")
    shop: str | None = Field(description="所属店铺")
    status: str = Field(description="账号状态 PENDING=待激活/ACTIVE=已激活/DISABLED=已禁用")
    wecom_userid: str | None = Field(default=None, description="企微账号(UserID),通知按它推送")
    dingtalk_userid: str | None = Field(default=None, description="关联的钉钉 userid:通知发到这里,钉钉离职时自动删号")
    department: str | None = Field(default=None, description="钉钉部门(含上级,「、」分隔),入职建号时记")
    github_account: str | None = Field(default=None, description="GitHub 邮箱或用户名")
    github_status: str | None = Field(default=None, description="最近一次 GitHub 仓库邀请的结果")

    model_config = {"from_attributes": True}


class TabItem(BaseModel):
    key: str = Field(description="标签键")
    text: str = Field(description="标签文字")
    pagePath: str = Field(description="页面路径")


class WxLoginRequest(BaseModel):
    code: str = Field(description="微信登录临时凭证 code")


class BindRequest(BaseModel):
    username: str = Field(description="登录用户名")
    password: str = Field(description="登录密码")
    code: str = Field(description="微信登录临时凭证 code")


class AdminLoginRequest(BaseModel):
    username: str = Field(description="登录用户名")
    password: str = Field(description="登录密码")


class RememberLoginRequest(BaseModel):
    remember_token: str = Field(description="H5「记住密码」凭证（POST /api/auth/h5-remember 发的那张）")


class DeviceLoginRequest(BaseModel):
    username: str = Field(description="登录用户名")
    password: str = Field(description="登录密码")


class ChangePasswordRequest(BaseModel):
    old_password: str = Field(description="原密码")
    new_password: str = Field(min_length=6, max_length=128, description="新密码(6-128位)")


class AuthResponse(BaseModel):
    token: str | None = Field(default=None, description="登录令牌(JWT)")
    staff: StaffOut | None = Field(default=None, description="员工信息")
    tabs: list[TabItem] = Field(default=[], description="底部导航标签列表")
    landing_page: str | None = Field(default=None, description="登录后落地页路径")
    needs_bind: bool = Field(default=False, description="是否需要先绑定账号")


class MiaodaEntryRequest(BaseModel):
    entry_token: str = Field(min_length=1, max_length=512, description="员工工作台给的一次性进入令牌")


class DingtalkLoginRequest(BaseModel):
    code: str = Field(min_length=1, max_length=512, description="钉钉 requestAuthCode 返回的临时授权码")


class DingtalkConfigOut(BaseModel):
    enabled: bool = Field(description="服务端钉钉应用凭证是否配齐，可做 H5 免登")
    client_id: str = Field(default="", description="前端 requestAuthCode 用的 Client ID（原 AppKey）")
    corp_id: str = Field(default="", description="企业 corpId；空则前端从钉钉环境自取")


class MiaodaConfirmRequest(BaseModel):
    ticket: str = Field(description="miaoda-entry 回的确认票据")
    password: str = Field(description="工作台绑定的那个 ERP 账号的密码")


class MiaodaEntryResponse(AuthResponse):
    needs_confirm: bool = Field(default=False, description="这个工作台账号第一次进来：要输一次 ERP 密码确认本人")
    ticket: str | None = Field(default=None, description="确认用的票据，10 分钟内有效")
    username: str | None = Field(default=None, description="要确认的 ERP 账号")


class StaffCreate(BaseModel):
    username: str = Field(description="登录用户名")
    password: str = Field(description="登录密码")
    name: str = Field(description="姓名")
    role: str = Field(default="PURCHASER", description="角色，默认 PURCHASER=采购")
    shop: str | None = Field(default=None, description="所属店铺")


class StaffUpdate(BaseModel):
    name: str | None = Field(default=None, description="姓名")
    role: str | None = Field(default=None, description="角色")
    shop: str | None = Field(default=None, description="所属店铺")
    status: str | None = Field(default=None, description="账号状态 PENDING=待激活/ACTIVE=已激活/DISABLED=已禁用")
    password: str | None = Field(default=None, description="新密码(填写则重置)")
    wecom_userid: str | None = Field(default=None, max_length=64, description="企微账号(UserID),空字符串=解绑")
    dingtalk_userid: str | None = Field(default=None, max_length=64, description="关联钉钉成员(仅管理员),空字符串=取消关联")
    github_account: str | None = Field(default=None, max_length=128, description="GitHub 邮箱或用户名(仅管理员),改了就自动邀请进代码仓库,空字符串=清空")


class StaffListResponse(BaseModel):
    items: list[StaffOut] = Field(description="员工列表")
    total: int = Field(description="总数")
    page: int = Field(description="当前页码")
    size: int = Field(description="每页数量")


class GithubAccountIn(BaseModel):
    account: str = Field(default="", max_length=128, description="GitHub 邮箱或用户名,空=清空")

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator


# ==================== 设备 ====================
class DeviceCreate(BaseModel):
    name: str
    note: str | None = None


class EnrollIn(BaseModel):
    """app HTTP 引导:按 hw_id(Android ANDROID_ID)幂等 upsert 设备,换回 MQTT 身份。

    kind:执行端类型,android(手机)/browser(AdsPower 浏览器);缺省 android。
    """
    hw_id: str
    kind: str | None = None
    brand: str | None = None
    model: str | None = None
    app_version: str | None = None
    enroll_secret: str


class EnrollOut(BaseModel):
    """gc 签发的 MQTT 身份:app 用 device_id/token 连 EMQX(鉴权模型不变)。"""
    device_id: str
    token: str
    kind: str


class DeviceUpdate(BaseModel):
    name: str | None = None
    status: str | None = None
    note: str | None = None


class HeartbeatIn(BaseModel):
    """app 每 5s 心跳:token 鉴权 + 端上实时状态(顺带同步就绪态,治 identity 陈旧)。"""
    token: str
    mqtt_connected: bool | None = None
    a11y_ready: bool | None = None
    blocking: str | None = None
    busy: bool | None = None


class DeviceInfoIn(BaseModel):
    """PC 守护端 adb 兜底采集的设备硬件信息(App READ_PHONE_STATE 读不到时的补充通道)。

    服务端只覆盖当前为空的字段——App identity 帧已上报的值不被顶掉。
    """
    serial: str | None = None
    imei1: str | None = None
    imei2: str | None = None
    phone_number: str | None = None


class DeviceOut(BaseModel):
    """设备对外的样子。**不含 token**:它是设备心跳与 MQTT 的凭据,只在 enroll 时
    交给设备本身。以前设备列表把它原样吐出来,公网谁拿到都能冒充任意一台设备
    (2026-10-06 发现)。"""
    id: str
    hw_id: str | None
    name: str
    kind: str
    status: str
    busy_task_id: str | None
    app_version: str | None
    brand: str | None
    model: str | None
    last_online_at: datetime | None
    last_report_at: datetime | None
    last_heartbeat_at: datetime | None
    # identity 帧持久化的自检就绪态(与 online 无关)
    last_ready: bool | None
    last_check_at: datetime | None
    blocking: str | None
    reported_nick: str | None
    account_id: str | None   # 该机当前登录账号所属(设备史)
    # event/exit_info 帧持久化(排障观察,与 online 无关)
    last_event: str | None
    last_event_at: datetime | None
    last_exit_reason: str | None
    last_exit_at: datetime | None
    # 设备硬件信息(App identity 帧 / PC adb 兜底采集)
    serial: str | None = None
    imei1: str | None = None
    imei2: str | None = None
    phone_number: str | None = None
    xianyu_member_name: str | None = None
    note: str | None
    maintenance_until: datetime | None = None
    created_at: datetime

    class Config:
        from_attributes = True


class DeviceWithTokenOut(DeviceOut):
    """只给「人工建设备」那一个接口用:建出来要把 token 配到设备上,只有这一次会给。"""
    token: str


# 没有凭据的外部请求看设备列表时抹掉的字段:个人信息与能定位到具体机器的标识。
# 守护端拿设备列表只为 id→名称(任务页显示用),这些它用不到。
DEVICE_PRIVATE_FIELDS = ("hw_id", "serial", "imei1", "imei2", "phone_number", "xianyu_member_name")


# ==================== 账号 ====================
class AccountCreate(BaseModel):
    nick: str
    device_id: str | None = None


class AccountBind(BaseModel):
    """按闲鱼账号名 upsert 的映射(= 设备号↔闲鱼账号名 表):nick 唯一,同名只更新 device_id。"""
    nick: str
    device_id: str | None = None


class AccountUpdate(BaseModel):
    nick: str | None = None
    device_id: str | None = None
    status: str | None = None
    daily_publish_quota: int | None = None
    daily_reprice_quota: int | None = None
    daily_delist_quota: int | None = None
    active_window: str | None = None
    risk_state: str | None = None
    risk_note: str | None = None


class AccountOut(BaseModel):
    id: str
    nick: str
    device_id: str | None
    status: str
    daily_publish_quota: int
    daily_reprice_quota: int
    daily_delist_quota: int
    active_window: str
    risk_state: str
    risk_note: str | None
    last_op_at: datetime | None
    created_at: datetime

    class Config:
        from_attributes = True


# ==================== 执行单元(账号 + 它当前的执行端)====================
class UnitQuota(BaseModel):
    """单个配额类别的今日用量。limit=0 表示不限,此时 used 仍照实给。"""

    used: int
    limit: int


class UnitDevice(BaseModel):
    """执行单元当前绑定的执行端。kind 决定它是真机还是浏览器,其余字段两类共用。"""

    id: str
    name: str
    kind: str                      # android(真机) / browser(AdsPower 浏览器)
    status: str
    serial: str | None = None
    brand: str | None = None
    model: str | None = None
    app_version: str | None = None
    last_ready: bool | None = None
    blocking: str | None = None
    last_online_at: datetime | None = None
    last_report_at: datetime | None = None
    last_event: str | None = None
    last_event_at: datetime | None = None

    class Config:
        from_attributes = True


class UnitTask(BaseModel):
    """该单元此刻在跑的任务(Device.busy_task_id 指向的那条)。"""

    id: str
    task_type: str
    status: str
    created_at: datetime | None = None

    class Config:
        from_attributes = True


class UnitOut(BaseModel):
    """执行单元 = 一个闲鱼账号 + 它当前的执行端 + 今日配额用量 + 在跑任务。

    账号是主体,执行端是属性——真机和浏览器在同一个列表里,靠 device.kind 区分。
    device 为 null = 账号还没绑执行端(空置单元)。
    """

    account_id: str
    nick: str
    status: str
    risk_state: str
    risk_note: str | None
    active_window: str
    last_op_at: datetime | None
    device: UnitDevice | None
    quota: dict[str, UnitQuota]    # publish / reprice / delist
    task: UnitTask | None


# ==================== 任务(控制类:直接下发;流程类:服务端引擎跑)====================
class TaskCreate(BaseModel):
    device_id: str
    task_type: str
    spec: dict | None = None
    account_id: str | None = None
    job_id: str | None = None
    source: str | None = "MANUAL"
    ref_type: str | None = None
    ref_id: str | None = None


class MaintenanceIn(BaseModel):
    reason: str = "update_code"
    # 报备有效期:超时没收尾就自动失效,调度器照常派(行情台半路崩了也不会把号永久挂起)
    minutes: int = Field(default=10, ge=1, le=60)


class TaskOut(BaseModel):
    id: str
    job_id: str | None
    device_id: str | None
    account_id: str | None
    task_type: str
    status: str
    spec: dict | None
    result: dict | None
    progress: str | None
    mark: str | None
    error: str | None
    failed_step: str | None
    shot_key: str | None
    created_at: datetime
    dispatched_at: datetime | None
    finished_at: datetime | None

    class Config:
        from_attributes = True


class TaskPageOut(BaseModel):
    """任务分页包装(with_total=true 时返回;默认仍返回 list[TaskOut] 保持兼容)。"""

    items: list[TaskOut]
    total: int


class ReplayStep(BaseModel):
    """回放的一步:流程发出的一个动作 + 动作后的截图(限时直链)。"""

    seq: int | None = None
    at: float | None = None          # 距任务开跑的秒数
    action: str                      # tap / swipe / set_text / launch_app / push_media …
    args: str = ""
    ms: int | None = None            # 动作本身耗时
    error: str | None = None
    shot_url: str | None = None
    thumb_url: str | None = None
    shot_error: str | None = None


class TaskReplayOut(BaseModel):
    task_id: str
    status: str
    live: bool                       # 任务还在跑,步骤是实时的
    steps: list[ReplayStep]
    result_shot_url: str | None = None
    result_thumb_url: str | None = None
    note: str | None = None          # 没有步骤时说明为什么(还没开始跑/没有留痕/读不到)


# ==================== 作业 Job ====================
class JobCreate(BaseModel):
    job_type: str                       # publish_batch / delist_sku / reprice_batch / relist_sku / polish_account / refresh_listing
    source: str | None = "MANUAL"
    # publish_batch
    sku: str | None = None
    # publish_batch / polish_account 必填;delist_sku 可选:只下这些账号上的在架链接(ERP「下架所选店铺」),
    # 不传 = 全账号(售出后全网下架走这条)
    account_ids: list[str] | None = None
    spec: dict | None = None
    # publish_batch 可选:按账号覆盖无忧卖 {account_id: bool}(ERP 侧已解析:格子覆盖→账号默认→False);
    # 缺账号回落 spec.worry_free_sell。
    worry_free_by_account: dict[str, bool] | None = None
    # reprice_batch: [{listing_id, new_price}]
    items: list[dict] | None = None
    # refresh_listing:要焕新的那条链接(spec 放 ERP 现组装的发布内容)
    listing_id: str | None = None


class ListingRecodeIn(BaseModel):
    # ERP 换货号的先后顺序:[{"old": 旧货号, "new": 新货号, "at": 换码时间 UTC ISO}],见 jobs.recode_listings
    pairs: list[dict]


class JobOut(BaseModel):
    id: str
    job_type: str
    source: str | None
    ref_type: str | None
    ref_id: str | None
    spec: dict | None
    status: str
    total: int
    succeeded: int
    failed: int
    created_at: datetime
    finished_at: datetime | None

    class Config:
        from_attributes = True


class ListingOut(BaseModel):
    id: str
    sku: str
    account_id: str
    item_id: str | None
    status: str
    price: int | None
    published_at: datetime | None
    expire_at: datetime | None
    last_synced_at: datetime | None
    job_id: str | None
    shot_key: str | None
    created_at: datetime

    class Config:
        from_attributes = True


# ==================== 聊天(会话/消息,只读)====================
class ConversationOut(BaseModel):
    id: str
    account_id: str
    account_nick: str | None = None   # 归属闲鱼账号昵称(聚合列表展示用,查询时 join 填充)
    peer_nick: str | None
    item_title: str | None
    item_price: str | None
    item_image: str | None
    order_status: str | None
    last_message: str | None
    last_message_at: datetime | None
    unread: int
    updated_at: datetime
    listing_sku: str | None = None    # 对上的 ERP 货号:聊天页「+」面板按它找同款在库货
    item_id: str | None = None        # 闲鱼商品 id
    item_url: str | None = None       # 闲鱼商品页,有 item_id 才有(查询时填)
    model_config = {"from_attributes": True}


class ChatMessageOut(BaseModel):
    id: str
    direction: str
    text: str
    msg_at: datetime | None
    created_at: datetime
    media: list[dict] | None = None   # 发出去的图片 / 视频 [{type, url, thumb}](现签)
    card: dict | None = None          # 只给我们自己看的商品小卡片 {title, grade, price};买家收到的是图片和文字
    model_config = {"from_attributes": True}


class ChatMediaIn(BaseModel):
    type: Literal["image", "video"]
    url: str = Field(min_length=1, max_length=2048)


class ChatCardIn(BaseModel):
    title: str = Field(default="", max_length=256)
    grade: str = Field(default="", max_length=32)
    price: str = Field(default="", max_length=32)


class ChatReplyIn(BaseModel):
    """人工回复入参:文字(上限 500 字,闲鱼单条私聊限制有富余),或者图片 / 视频。

    图片带文字只用于发商品:买家先收图片、再收文字,card 只在我们自己的聊天页显示成小卡片。
    两样都没有 → 422;文字全是空白 → 建单时拒(400),和原来一样。
    """
    text: str | None = Field(default=None, max_length=500)
    media: list[ChatMediaIn] | None = Field(default=None, max_length=12)
    card: ChatCardIn | None = None

    @model_validator(mode="after")
    def _need_something(self):
        if not self.text and not self.media:
            raise ValueError("回复内容为空")
        if self.text and self.media and not self.card:
            raise ValueError("图片视频和文字分开发:发图片视频时不带文字")
        if self.card and not self.media:
            raise ValueError("商品卡片要带图片")
        return self


# ---- EMQX HTTP 鉴权/ACL 钩子出入参 ----
class EmqxAuthIn(BaseModel):
    clientid: str | None = None
    username: str | None = None
    password: str | None = None


class EmqxAclIn(BaseModel):
    clientid: str | None = None
    username: str | None = None
    topic: str | None = None
    action: str | None = None  # publish / subscribe


class LogRequestIn(BaseModel):
    """下一条取日志待办。days 服务端会夹到 1~30——本地只保留 30 天，要更久也没有。"""

    owner_kind: str = Field(pattern="^(device|desktop)$", description="device=执行端；desktop=桌面端")
    owner_id: str = Field(min_length=1, max_length=64)
    days: int = 7
    note: str | None = None


class MarketDecisionIn(BaseModel):
    """行情一轮里对**一个型号**的处置。跑了没、为什么、等了多久、结果如何。

    action=skip 的那些同样要报——「为什么没跑」和「跑了什么」一样是决策，
    而且迁移后最容易出偏差的恰恰是这半边。
    """

    spu: str = Field(min_length=1, max_length=128, description="型号/SPU")
    action: str = Field(pattern="^(run|skip)$")
    reason: str | None = Field(default=None, max_length=255, description="skip 的原因 / run 的失败原因")
    waited_ms: int | None = Field(default=None, description="这条之前等了多久（本机节流）")
    duration_ms: int | None = None
    ok: bool | None = None
    failed_step: str | None = Field(default=None, max_length=64)
    price: float | None = Field(default=None, description="抓到的行情价")


class MarketRhythmIn(BaseModel):
    """这一轮**本机实际在用**的节奏参数。S3-0 只上报，不下发。

    为什么跟着轮次一起报，而不是单开一条配置接口：对照要问的是
    「这一轮的结果，是在什么节奏下跑出来的」——两者分开存，就对不上号了。

    上下界给得很宽（0 到 1 小时），只为挡住明显的脏值；不在这里判断 min 是否
    小于 max，那种反了的情况**本身就是要看见的现象**，不该被观测通道悄悄吞掉。
    """

    throttle_min_ms: int | None = Field(default=None, ge=0, le=3_600_000, description="型号之间的间隔下限")
    throttle_max_ms: int | None = Field(default=None, ge=0, le=3_600_000)
    query_delay_min_ms: int | None = Field(default=None, ge=0, le=3_600_000, description="同型号多条查询之间的间隔下限")
    query_delay_max_ms: int | None = Field(default=None, ge=0, le=3_600_000)
    daily_enabled: bool | None = None
    daily_time: str | None = Field(default=None, max_length=8, description="HH:MM")


class MarketRoundIn(BaseModel):
    """行情采集的一轮。一轮 = 一个账号在一段时间里跑完的一批型号。"""

    client_id: str = Field(min_length=1, max_length=64, description="哪台机器")
    account: str = Field(min_length=1, max_length=64, description="用哪个账号（昵称或账号 id）")
    trigger: str = Field(default="manual", max_length=32, description="daily / manual / resume")
    started_at: datetime | None = None
    finished_at: datetime | None = None
    decisions: list[MarketDecisionIn] = Field(default_factory=list)
    rhythm: MarketRhythmIn | None = None

"""群控调度中心数据模型(V2:大脑在服务端,账本收口)。

设备只做「手」,通过原语 RPC 被服务端流程引擎驱动;业务闭环靠三张账本表:
- Account  闲鱼账号(风控/配额主体,与设备可轮换)
- Listing  上架账本(SKU×账号×item_id×状态,下架/老化/防重发的依据)
- Job      业务作业(一个意图扇出到 N 个 Task)

Device / Task 保留:Device=手机,Task=某设备上跑完某账号的一条流程(挂在 Job 下)。
传输走 MQTT:设备用 device_id/token 连 EMQX,后端桥订 report/rpc_resp/status、发 cmd/rpc。
"""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def new_id() -> str:
    return uuid4().hex


class DeviceStatus:
    OFFLINE = "OFFLINE"
    ONLINE = "ONLINE"
    DISABLED = "DISABLED"


class AccountStatus:
    ACTIVE = "ACTIVE"
    FROZEN = "FROZEN"      # 命中风控或掉登录,暂停所有作业
    DISABLED = "DISABLED"


# 掉登录冻结的标记:runner 冻号时 risk_note 以它开头(只冻 status,risk_state 不动)。
# 执行端报出重新登录后按它自动解冻(mqtt_bridge._apply_identity);风控冻结不带它,仍要人工解冻。
LOGIN_LOST_NOTE = "账号掉登录"
LOGIN_LOST_NOTIFIED = " · 已通知"   # 浏览器号过了宽限期才通知人,通知过的备注带它


def is_login_lost_freeze(acc) -> bool:
    """是不是 runner 因掉登录冻的号(只冻 status、风控不动、备注以 LOGIN_LOST_NOTE 开头)。

    这种冻结机器能自己确认解除——登回去了就行,所以保活照样派给它去自救(scheduler),
    执行端报出昵称就自动解冻(mqtt_bridge)。风控冻结另冻 risk_state,两处都不碰。
    """
    return (acc.status == AccountStatus.FROZEN
            and acc.risk_state != RiskState.FROZEN
            and (acc.risk_note or "").startswith(LOGIN_LOST_NOTE))


def login_lost_since(acc) -> datetime | None:
    """掉登录冻结从什么时候开始(UTC),从备注「… @ <iso>」里读;读不出返回 None。"""
    tail = (acc.risk_note or "").replace(LOGIN_LOST_NOTIFIED, "").rpartition(" @ ")[2].strip()
    try:
        return datetime.fromisoformat(tail)
    except ValueError:
        return None



# 链接焕新(删掉重发)扇出的任务一律记这个 source。调度器靠它把「删完之后的重发」排到最前面,
# 焕新的额度与在途统计也靠它和普通上架分开数。
REFRESH_TASK_SOURCE = "LIFECYCLE"
# 焕新重发途中货卖了/被下架,新链接已经挂上去,要马上撤掉(jobs._on_republish_ok)。单独记来源:
# 后来的下架作业只取消还没开跑的焕新,撤回不能被一起取消;调度也把它排在最前。
REFRESH_UNDO_SOURCE = "LIFECYCLE_UNDO"


class RiskState:
    NORMAL = "NORMAL"
    WARN = "WARN"
    FROZEN = "FROZEN"


class ListingStatus:
    LIVE = "LIVE"                        # 在架
    DELISTED = "DELISTED"                # 已下架
    SOLD = "SOLD"                        # 已售(chat_scan / 浏览器号 sold_scan 检出,ERP 轮询后全网下架同款)
    # 链接焕新(jobs.create_refresh_listing)删掉了旧链接、新链接还没发上去。闲鱼上此刻没有它,
    # 但仍算占用(jobs._OCCUPYING):别的发布不能趁这个空当给同一账号再挂一份。
    # 重发失败就停在这里,第二天的焕新跳过删、直接重发。
    PENDING_REPUBLISH = "PENDING_REPUBLISH"
    # 链接删了且不再重发:焕新到一半货卖掉了/被下架了。和 DELISTED 不同,它没法「重新上架」。
    DELETED = "DELETED"
    ERROR = "ERROR"
    UNCERTAIN = "UNCERTAIN"              # 点了发布但没读到 item_id,待对账


class JobStatus:
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    DONE = "DONE"
    PARTIAL = "PARTIAL"   # 扇出的 task 部分成功
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class JobType:
    PUBLISH_BATCH = "publish_batch"
    DELIST_SKU = "delist_sku"
    RELIST_SKU = "relist_sku"
    POLISH_ACCOUNT = "polish_account"
    REPRICE_BATCH = "reprice_batch"
    SCRAPE_SHOP = "scrape_shop"
    CHAT_REPLY = "chat_reply"
    CHAT_SCAN = "chat_scan"
    KEEPALIVE = "keepalive"   # 浏览器号闲着时开一次闲鱼首页:保活 + 登录体检(scheduler._keepalive_pass)
    SOLD_SCAN = "sold_scan"   # 浏览器号定时读个人中心「已售出」,按 item_id 把卖掉的在架账本标 SOLD
    # 链接焕新:在架满 N 天没卖掉的链接删掉、同一账号重发(ERP 每天定时挑单子,见 jobs.create_refresh_listing)
    REFRESH_LISTING = "refresh_listing"
    # S3-0 影子模式：行情采集的一轮。本机仍自己决定跑什么，只是把决策与结果报上来，
    # 服务端只记录、不派发（market_crawl 刻意**不进** FLOWS，调度器因此不会碰它）。
    MARKET_CRAWL = "market_crawl"


class TaskStatus:
    PENDING = "PENDING"        # 已建,未派
    DISPATCHED = "DISPATCHED"  # 已交流程引擎/已发首帧
    RUNNING = "RUNNING"        # 执行中
    WAITING = "WAITING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


# 执行端 report.status → 本地任务状态(控制类任务仍走这条老链路)
REPORT_STATUS_MAP = {
    "run": TaskStatus.RUNNING,
    "wait": TaskStatus.WAITING,
    "end": TaskStatus.SUCCESS,
    "success": TaskStatus.SUCCESS,
    "error": TaskStatus.FAILED,
    "danger": TaskStatus.FAILED,
}

# 终态:迟到/重投的 report 帧不得把它回退(QoS1 会重投)
TERMINAL_TASK_STATUS = {TaskStatus.SUCCESS, TaskStatus.FAILED, TaskStatus.CANCELLED}


class Device(Base):
    __tablename__ = "gc_device"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    token: Mapped[str] = mapped_column(String(64), index=True, default=new_id)  # MQTT 密码/bind 令牌
    # Android Settings.Secure.ANDROID_ID:enroll 幂等 upsert 键(仅此用途;MQTT 身份仍由 id/token 签发)。
    # 唯一可空——老行为(手动建的设备)保持 null。
    hw_id: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    name: Mapped[str] = mapped_column(String(64))
    # 执行端类型:android(手机 App)/browser(AdsPower 指纹浏览器,闲鱼网页版)。决定走哪套流程集(runner.FLOWS/FLOWS_WEB)。
    kind: Mapped[str] = mapped_column(String(16), default="android")
    status: Mapped[str] = mapped_column(String(16), default=DeviceStatus.OFFLINE, index=True)
    # 端侧 identity 帧(gc/{id}/report kind=identity)持久化的自检就绪态。online 态**不**由此决定(归 status 帧)。
    last_ready: Mapped[bool | None] = mapped_column(Boolean, nullable=True)      # Preflight 是否就绪
    last_check_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)  # 最近一次自检时间
    blocking: Mapped[str | None] = mapped_column(String(255), nullable=True)    # 阻塞原因(未装闲鱼/未登录…)
    reported_nick: Mapped[str | None] = mapped_column(String(64), nullable=True)  # 该机当前登录的闲鱼昵称
    # 该机当前登录账号所属的 gc 账号(设备史:一个账号可有多台设备;激活设备在 Account.device_id,唯一)
    account_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("gc_account.id"), nullable=True, index=True
    )
    # 当前正在跑的 task(端侧无队列,一机一任务由调度器保证)
    busy_task_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    app_version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    brand: Mapped[str | None] = mapped_column(String(32), nullable=True)
    model: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_online_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_report_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 端侧 event 帧(gc/{id}/report kind=event):最近一次系统事件(如无障碍断链 accessibility_lost)。
    last_event: Mapped[str | None] = mapped_column(String(255), nullable=True)
    last_event_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 端侧 exit_info 帧(kind=exit_info):上次进程死因(ApplicationExitInfo reason_name/退出时刻)。
    last_exit_reason: Mapped[str | None] = mapped_column(String(64), nullable=True)
    last_exit_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # app HTTP 心跳最近时刻(每 5s 上报)。离线判定看它:超 heartbeat_timeout_sec 无心跳即 OFFLINE。
    # NULL = 该机还没升级到心跳版 app,不参与心跳扫描(仍走 MQTT status/LWT),新旧机制并存。
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 设备硬件信息(账号初始化档案用):App identity 帧上报(READ_PHONE_STATE,Android10+ 多半读不到),
    # 读不到的由 PC 守护端 adb 兜底经 POST /device-info 补齐(只填空字段)。
    serial: Mapped[str | None] = mapped_column(String(64), nullable=True)       # 设备序列号(ro.serialno)
    imei1: Mapped[str | None] = mapped_column(String(32), nullable=True)
    imei2: Mapped[str | None] = mapped_column(String(32), nullable=True)
    phone_number: Mapped[str | None] = mapped_column(String(32), nullable=True)  # SIM 本机号码(line1Number)
    # 闲鱼会员名(tb 开头):App 尽力读,读不到 null,ERP 档案允许员工手填
    xianyu_member_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 维护报备(行情台「更新执行端」前报、更新完收):报备期间调度器不给它派新活,
    # 期间因重启失败的任务在收尾时重新排队(见 api.begin_maintenance / end_maintenance)。
    # 过了 maintenance_until 还没收尾就当行情台半路没了,调度器照常派——不让一次没收尾的更新把号永久挂起。
    maintenance_since: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    maintenance_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    maintenance_reason: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    def in_maintenance(self, now: datetime) -> bool:
        return bool(self.maintenance_until) and self.maintenance_until > now


class Account(Base):
    """闲鱼账号:风控与配额主体。**昵称为唯一键**(identity 帧按 nick upsert,没有即自动注册)。
    一个账号可有多台设备(登录史见 Device.account_id),但激活设备只有一台(device_id)。"""

    __tablename__ = "gc_account"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    nick: Mapped[str] = mapped_column(String(64), unique=True)
    device_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("gc_device.id"), nullable=True, index=True
    )
    status: Mapped[str] = mapped_column(String(16), default=AccountStatus.ACTIVE, index=True)
    # 日配额(发布/改价/下架分开计),0=不限
    daily_publish_quota: Mapped[int] = mapped_column(Integer, default=100)   # 11-06 用户定:30 → 100
    daily_reprice_quota: Mapped[int] = mapped_column(Integer, default=50)
    daily_delist_quota: Mapped[int] = mapped_column(Integer, default=50)
    active_window: Mapped[str] = mapped_column(String(16), default="09:00-23:00")  # 只在作息窗口执行
    risk_state: Mapped[str] = mapped_column(String(16), default=RiskState.NORMAL, index=True)
    risk_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_op_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Listing(Base):
    """上架账本:SKU×账号×item_id×状态。下架/老化重发/防重发全靠它。"""

    __tablename__ = "gc_listing"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    sku: Mapped[str] = mapped_column(String(64), index=True)            # ERP 货号
    account_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("gc_account.id"), index=True
    )
    item_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)  # 闲鱼商品id,发布回读
    # 闲鱼实际标题(AI 从图生成，发布后回读)。没有 item_id 时，这是下架/改价**唯一**能精确
    # 定位到具体商品的依据——缺它就只能盲点列表第一行，且只敢支持单商品账号。
    title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default=ListingStatus.LIVE, index=True)
    price: Mapped[int | None] = mapped_column(Integer, nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    expire_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)  # 老化
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    job_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    shot_key: Mapped[str | None] = mapped_column(String(255), nullable=True)  # 异常截图 OSS key
    # 不焕新的原因。目前只有「无忧卖」:网页上删不掉,11-11 用户定先排掉、不处理
    refresh_skip: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Job(Base):
    """业务作业:一个意图扇出到 N 个 Task。ERP 事件/人工/老化触发。"""

    __tablename__ = "gc_job"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    job_type: Mapped[str] = mapped_column(String(32), index=True)
    source: Mapped[str | None] = mapped_column(String(32), nullable=True)  # ERP / MANUAL / AGING
    ref_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    ref_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    spec: Mapped[dict | None] = mapped_column(JSON, nullable=True)  # = PublishSpec 等
    status: Mapped[str] = mapped_column(String(16), default=JobStatus.PENDING, index=True)
    total: Mapped[int] = mapped_column(Integer, default=0)
    succeeded: Mapped[int] = mapped_column(Integer, default=0)
    failed: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Task(Base):
    """一次流程执行:在某设备上为某账号跑完一条流程(发布/下架/改价…),挂在 Job 下。

    控制类任务(重启/清缓存/上报机型)不挂 job,直接下发给设备走老 report 链路。
    """

    __tablename__ = "gc_task"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    job_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("gc_job.id"), nullable=True, index=True
    )
    device_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("gc_device.id"), nullable=True, index=True
    )
    account_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("gc_account.id"), nullable=True, index=True
    )
    task_type: Mapped[str] = mapped_column(String(32), index=True)
    status: Mapped[str] = mapped_column(String(16), default=TaskStatus.PENDING, index=True)
    spec: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    source: Mapped[str | None] = mapped_column(String(32), nullable=True)  # ERP / MANUAL
    ref_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    ref_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    # 执行端/引擎回传
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    progress: Mapped[str | None] = mapped_column(String(32), nullable=True)
    mark: Mapped[str | None] = mapped_column(String(255), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    failed_step: Mapped[str | None] = mapped_column(String(64), nullable=True)  # 失败步骤名
    shot_key: Mapped[str | None] = mapped_column(String(255), nullable=True)    # 失败截图 OSS key
    retry: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    dispatched_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Conversation(Base):
    __tablename__ = "gc_conversation"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(String(36), index=True)
    peer_key: Mapped[str] = mapped_column(String(128), index=True)
    peer_nick: Mapped[str | None] = mapped_column(String(128), nullable=True)
    item_title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    item_price: Mapped[str | None] = mapped_column(String(32), nullable=True)   # 聊天页商品卡价格文本(如 "1588.00")
    item_image: Mapped[str | None] = mapped_column(String(1024), nullable=True)  # 商品卡缩略图(OSS URL,经 job.spec.images 解析)
    order_status: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # 会话聊的是哪件货:按闲鱼商品 id / 标题 / 价格对上本号**唯一**一条在架账本才填,对不上留着上次的
    # (宁漏勿错)。聊天页「+」面板按 listing_sku 去 ERP 找同款在库货
    listing_sku: Mapped[str | None] = mapped_column(String(64), nullable=True)   # ERP 货号
    item_id: Mapped[str | None] = mapped_column(String(64), nullable=True)       # 闲鱼商品 id
    last_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_message_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    unread: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    __table_args__ = (UniqueConstraint("account_id", "peer_key", name="uq_conv_account_peer"),)


class ChatMessage(Base):
    __tablename__ = "gc_chat_message"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    conversation_id: Mapped[str] = mapped_column(String(36), index=True)
    direction: Mapped[str] = mapped_column(String(8))          # in / out
    text: Mapped[str] = mapped_column(Text)
    msg_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    dedup_key: Mapped[str] = mapped_column(String(64), index=True)
    # 发出去的图片 / 视频:[{type: image|video, key: OSS 对象键}],读的时候再签名;纯文字为空
    media: Mapped[list | None] = mapped_column(JSON, nullable=True)
    # 发商品时我们自己聊天页显示的小卡片:{title, grade, price};买家收到的是图片和文字
    card: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    __table_args__ = (UniqueConstraint("conversation_id", "dedup_key", name="uq_msg_conv_dedup"),)


class NotifyState(Base):
    """通知状态(KV 单行语义):Server酱推送的冷却时间戳与待提醒累计数(1c)。"""

    __tablename__ = "gc_notify_state"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class LogRequestStatus:
    PENDING = "PENDING"
    UPLOADED = "UPLOADED"
    CANCELLED = "CANCELLED"


class LogRequest(Base):
    """远程取日志的待办:谁的、要几天、传回来没有。

    为什么做成「待办」而不是「在线推送」:要日志的时候往往正是出事的时候,而那台机器
    很可能恰好不在线(关机、断网、进程崩了)。做成待办之后,端上每次心跳与每次启动都
    问一句「有没有要我传的」——在线就立刻传,不在线就下次启动补传,**一条路覆盖两种情况**,
    不必为离线单写一套。

    owner_kind 区分执行端(device,有设备身份)与桌面端(desktop,只有本机 client_id)。
    """

    __tablename__ = "gc_log_request"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    owner_kind: Mapped[str] = mapped_column(String(16), index=True)   # device / desktop
    owner_id: Mapped[str] = mapped_column(String(64), index=True)
    days: Mapped[int] = mapped_column(Integer, default=7)             # 要最近几天
    status: Mapped[str] = mapped_column(String(16), default=LogRequestStatus.PENDING, index=True)
    note: Mapped[str | None] = mapped_column(String(255), nullable=True)
    requested_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    uploaded_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    size_bytes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    path: Mapped[str | None] = mapped_column(String(255), nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)


class MarketAccountConfig(Base):
    """行情采集的节奏参数:每个账号一行。

    **S3-0 阶段这张表是「本机报上来的」,不是「服务端发下去的」**——服务端只存不发,
    source 就是用来把这两件事分开的(现在只会是 LOCAL_REPORT)。

    为什么现在就要建它:S3-1 要把决策权搬到服务端,那时它会翻转成权威来源。
    先让它装上本机**实际在用**的值,为的是搬家那天能对照——「新调度是不是比原来
    跑得慢了、跳得多了」,没有搬家前的同口径数据,这个问题只能凭感觉回答。

    按账号做主键而不是按机器:一个账号本来就只该由一台机器驱动(归属规则如此),
    但仍记下 client_id——两台机器报同一个账号时能看出来,那本身就是要查的问题。
    """

    __tablename__ = "gc_market_account_config"

    account: Mapped[str] = mapped_column(String(64), primary_key=True)
    client_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # 同一批型号之间的间隔(本机节流)
    throttle_min_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    throttle_max_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # 同一个型号的多条查询之间的间隔
    query_delay_min_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    query_delay_max_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    daily_enabled: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    daily_time: Mapped[str | None] = mapped_column(String(8), nullable=True)   # HH:MM
    source: Mapped[str] = mapped_column(String(16), default="LOCAL_REPORT")
    reported_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class AccountOwner(Base):
    """闲鱼号的负责员工（ERP 员工 id）。新买家消息推给他们，超时考核也算他们的。一个号可以多人。"""

    __tablename__ = "gc_account_owner"
    __table_args__ = (UniqueConstraint("account_id", "staff_id", name="uq_gc_account_owner"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(String(36), index=True)
    staff_id: Mapped[str] = mapped_column(String(36), index=True)
    staff_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class GcSetting(Base):
    """后台页面上改的键值设置（消息响应考核的时限、夜间不考核时段等）。"""

    __tablename__ = "gc_setting"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
    updated_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class ChatSla(Base):
    """一轮「买家来消息 → 员工看 → 员工回」。买家发了、我们还没回就开一轮，回了就结束。

    「看」= 员工在我们的 H5/小程序打开这个会话（闲鱼端的已读是机器人扫描造成的，不算）；
    「回」= 员工从我们的系统发出回复（记是谁）或在闲鱼端直接回（扫描读到我们这边的新消息，不知道是谁）。
    兜底自动回复不算员工处理。计时扣掉夜间不考核的时段。
    """

    __tablename__ = "gc_chat_sla"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    conversation_id: Mapped[str] = mapped_column(String(36), index=True)
    account_id: Mapped[str] = mapped_column(String(36), index=True)
    await_since: Mapped[datetime] = mapped_column(DateTime, index=True)
    notified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    read_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    read_by_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    reminded_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    escalated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    replied_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    replied_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    replied_by_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # APP 我们系统里回的 / XIANYU 闲鱼端直接回的
    replied_via: Mapped[str | None] = mapped_column(String(16), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)

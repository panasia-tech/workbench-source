"""浏览器工作台：装在员工电脑上的那个应用，以及它身上的爬虫租约。

# 为什么要有设备表

一个员工账号允许在多台电脑上同时登录（老板 2026-09-16 定）。于是「谁在操作」
不再等于「哪个账号」——同一个管理员可能在办公室和家里各开一个工作台。要把爬虫
指到某一台上，就得先让每台电脑有个稳定的名字。

设备 id 由客户端在**安装时**生成一次并落盘，不随 AdsPower、不随网络、不随登录
账号变。服务端不发 id：发 id 意味着客户端每次重装都会拿到新的一个，旧的那台
就变成一行永远不会再心跳的僵尸。

# 为什么爬虫开关是租约不是布尔值

行情爬虫和图片爬虫，**同一个功能同时只能在一台电脑上开着**，不然两台机器抢同一批
AdsPower 环境、重复采集、重复写库。本地开关做不到这件事：两台电脑各记一个
「我开着」，谁也不知道对方。

所以开关的真身是服务端的一行租约：功能 → 现在归哪台设备 + 什么时候到期。
点开启 = 去抢这一行，抢不到就明说被谁占着。持有方定期续租；断电、关机、拔网线
都不会主动还租约，只能靠**到期自动释放**——这就是 TTL 存在的唯一理由。

# 强制转移为什么不直接改 device_id

采集跑到一半被掐断，留下的是半批脏数据和一个开着的浏览器。所以管理员转移时
只写下 handoff_to：持有方在下一次续租时看见它，跑完当前这一轮再主动让位。
只有租约已经过期（那台机器本来就联系不上了）才直接改判。
"""

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.models.staff import new_uuid


class CrawlerFeature:
    """租约管着的功能。值直接进 URL 和数据库，别改。"""

    MARKET = "market"   # 行情爬虫：工作台自己的采集调度
    IMAGE = "image"     # 图片爬虫：还没接入，先占位（2026-09-16 老板确认「现在还没在跑」）

    ALL = (MARKET, IMAGE)
    LABEL = {MARKET: "行情爬虫", IMAGE: "图片爬虫"}


class WorkbenchDevice(Base):
    """一台装了浏览器工作台的电脑。"""

    __tablename__ = "workbench_device"

    # 客户端安装时生成并落盘，服务端只认不发（见模块 docstring）
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    # 电脑名，给人看的。同一个人两台机器全靠它区分，所以缺省也要有个能认的值
    name: Mapped[str] = mapped_column(String(64), default="未命名电脑")
    os: Mapped[str | None] = mapped_column(String(32), nullable=True)
    app_version: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # 最近一次登录这台机器的员工。只作展示——租约归设备，不归人：
    # 管理员下班关掉应用，租约该因为没人续期而释放，而不是因为"人走了"。
    last_staff_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    # 这台电脑上挂着哪些 AdsPower 环境（本机代理枚举得到，心跳时带上来）。
    #
    # 为什么要记：gc_device 和这张表模型的**不是同一个东西**。gc_device 一行 = 一个
    # 执行单元（一台手机，或一个 AdsPower 环境），它绑闲鱼账号、接任务、有配额和
    # 风控；这张表一行 = 一台员工的电脑。一台电脑上可以挂十几个环境——本机实测 11 个。
    # 是一对多，不是重复。
    #
    # 但此前两边毫无关联：管理员在「机器现状」看到 4 个浏览器执行端，在「爬虫开关」
    # 看到几台电脑，却说不出这些环境跑在谁的机器上。断电排查、环境抢占、把爬虫指到
    # 哪台——都要靠这条关联才问得清楚。
    ads_env_ids: Mapped[list | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class CrawlerLease(Base):
    """「这个爬虫现在归哪台电脑」——每个功能至多一行。"""

    __tablename__ = "crawler_lease"

    # 功能名本身就是主键：一个功能只能有一行，互斥由数据库保证，不靠应用层自觉
    feature: Mapped[str] = mapped_column(String(16), primary_key=True)
    device_id: Mapped[str] = mapped_column(String(64), index=True)
    # 抢到它的那个管理员，留作审计：出了事要知道是谁开的
    staff_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    acquired_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    # 过了这个点就算失联，别人可以抢。续租就是把它往后推。
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    # 管理员请求让位的目标设备。持有方下次续租时看见它，跑完当前这轮再放手。
    handoff_to: Mapped[str | None] = mapped_column(String(64), nullable=True)
    handoff_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    def held_at(self, now: datetime) -> bool:
        """此刻还算有人持有吗。过期 = 没人持有,谁都能抢。"""
        return self.expires_at > now


class AdsEnvPurpose(Base):
    """AdsPower 分组 → 谁驱动这个分组里的环境。

    # 为什么要收到服务端

    这张表原来是**每台机器一份**（adspower-executor/run/env_purposes.json）。
    谁改谁的，换台电脑就是另一套，而它是「同机两个驱动各管哪些环境」的唯一说明书——
    两台机器对同一个分组的归属判断不一致，就会有人去碰别人正开着的浏览器。

    AdsPower 自己已经把环境（指纹、代理、cookie）按账号同步了，所以要下发的
    只剩归属这一件事。工作台登录后把这张表推进本机代理，本地那份文件退化成缓存：
    服务端不可达时照旧能用，连上了就以服务端为准。

    # owner 只有三个值

    executor / desktop / none。它不是标签，是「谁来驱动」的真实答案，而全机只有
    两个驱动方加一个显式隔离区。允许自由填会让人建出一个谁也不会认领的用途，
    环境划进去就此沉默。
    """

    __tablename__ = "ads_env_purpose"

    # 分组名就是主键：AdsPower 侧也是按名字认的，多一个 id 只会多一次对不上的机会
    name: Mapped[str] = mapped_column(String(32), primary_key=True)
    owner: Mapped[str] = mapped_column(String(16))
    note: Mapped[str | None] = mapped_column(String(200), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


VALID_OWNERS = ("executor", "desktop", "none")


class CrawlRunStatus:
    PENDING = "PENDING"     # 已登记，等那台电脑来认领
    RUNNING = "RUNNING"     # 认领了，正在跑
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    ALL = (PENDING, RUNNING, SUCCESS, FAILED)


class MarketCrawlRun(Base):
    """一轮行情采集。

    # 为什么要把它搬到服务端

    采集此前完全是本机的事：桌面端自己定时、自己跑、结果存本机 electron-store。
    服务端只收到「决策影子」（每次定价怎么算的），**收不到轮次**——所以
    「昨晚那台电脑到底跑没跑」「跑了多久」「多少条失败」，只有坐在那台电脑前的人
    知道。爬虫租约解决了「谁该跑」，这张表解决「跑得怎么样」。

    顺带把手动触发也接上了：管理员在任意一台登录都能发起一轮，不必跑到那台
    电脑跟前去点。

    # 它不是任务队列

    一轮采集要跑几十分钟，中途还会断点续跑。这张表只记「登记 → 认领 → 结束」
    三个时刻和一份计数，不下发指令、不切片、不重试——采集内部的调度仍在端上。
    做成队列会把端上那套跑了三个月的断点逻辑推倒重来，不值得。

    # 离线也要能跑

    服务端不可达时端上照跑（采集是本机能力，不该因为网抖就停），跑完补登记，
    标记 offline_started。宁可事后知道，不要不知道。
    """

    __tablename__ = "market_crawl_run"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    # 指给哪台电脑。PENDING 时按爬虫租约的持有者派；端上认领时要对得上。
    device_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(16), default=CrawlRunStatus.PENDING, index=True)
    trigger: Mapped[str] = mapped_column(String(16), default="manual")   # manual / schedule
    staff_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # 端上自己的 run id：出问题时要能对到本机那份历史记录上去
    local_run_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    offline_started: Mapped[bool] = mapped_column(Boolean, default=False)
    total: Mapped[int] = mapped_column(Integer, default=0)
    success: Mapped[int] = mapped_column(Integer, default=0)
    failed: Mapped[int] = mapped_column(Integer, default=0)
    # 失败得分类才有用。端上一直在分这三类，却只把 success/failed 报上来，
    # 于是服务端看得到「失败 12 条」，看不到**为什么**——而这三类要采取的动作
    # 完全不同：
    #   empty        搜不到结果 → 搜索词或型号有问题，改任务
    #   invalid_price 价格解析不出 → 多半是闲鱼改版，去看选择器
    #   risk_control  撞了风控   → 停手、等冷却，**绝不是重试**
    # 最后这个是最该第一眼看见的：它意味着账号正在被盯上。
    empty: Mapped[int] = mapped_column(Integer, default=0)
    invalid_price: Mapped[int] = mapped_column(Integer, default=0)
    risk_control: Mapped[int] = mapped_column(Integer, default=0)
    reason: Mapped[str | None] = mapped_column(String(300), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class SnapshotRequestStatus:
    PENDING = "PENDING"
    UPLOADED = "UPLOADED"
    CANCELLED = "CANCELLED"


class CrawlSnapshotRequest(Base):
    """把某一轮采集的现场取回来。

    # 为什么做成「待办」而不是「传完再说」

    快照是整页 DOM，一个型号一轮最多 12 份。全量传是 GB 级的量，而**绝大多数
    永远不会有人看**——只有出了事那几轮才有人想看现场。所以默认不传，要看再取。

    而「要看的时候」往往正是出事的时候，那台电脑很可能恰好不在线（关机、断网、
    进程崩了）。做成待办之后，端上每次心跳都问一句「有没有要我传的」——在线就
    立刻传，不在线就下次开机补传，一条路覆盖两种情况。这个手法是从群控的
    gc_log_request 搬过来的，那边已经跑通。

    # 一轮只留一次

    同一轮重复点「取回现场」不再排队：现场是确定的东西，取一次就够，
    重复请求只会让那台电脑反复打包上传同一批文件。
    """

    __tablename__ = "crawl_snapshot_request"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    run_id: Mapped[str] = mapped_column(String(36), index=True)
    device_id: Mapped[str] = mapped_column(String(64), index=True)
    # 端上那一轮的 id：端上按它去本机找对应的快照文件
    local_run_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default=SnapshotRequestStatus.PENDING, index=True)
    requested_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    object_key: Mapped[str | None] = mapped_column(String(300), nullable=True)
    bytes: Mapped[int] = mapped_column(Integer, default=0)
    reason: Mapped[str | None] = mapped_column(String(300), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    uploaded_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


def new_device_id() -> str:
    """只在测试和回归里造 id 用；真实 id 由客户端生成。"""
    return new_uuid()

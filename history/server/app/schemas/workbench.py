"""浏览器工作台的设备心跳与爬虫租约。"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class DeviceHeartbeatIn(BaseModel):
    device_id: str = Field(min_length=8, max_length=64, description="客户端安装时生成并落盘的稳定 id")
    name: str = Field(default="", max_length=64, description="电脑名，给人看的")
    os: str | None = Field(default=None, max_length=32)
    app_version: str | None = Field(default=None, max_length=32)
    ads_env_ids: list[str] = Field(default_factory=list,
                                   description="这台电脑上挂着的 AdsPower 环境 id；本机代理不可达时为空")


class LeaseOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    feature: str = Field(description="market=行情爬虫 / image=图片爬虫")
    label: str = Field(description="功能中文名，界面直接用")
    held: bool = Field(description="此刻是否有人持有（过期即为 false）")
    device_id: str | None = Field(default=None, description="持有它的设备")
    device_name: str | None = Field(default=None, description="持有它的电脑名")
    mine: bool = Field(default=False, description="持有者是不是发起本次请求的这台")
    staff_name: str | None = Field(default=None, description="开启它的人")
    expires_at: datetime | None = Field(default=None, description="不续租的话什么时候自动释放")
    handoff_to: str | None = Field(default=None, description="管理员请求让位的目标设备")
    handoff_to_name: str | None = Field(default=None)
    available: bool = Field(default=True, description="这个功能有没有真实实现；图片爬虫暂未接入")


class DeviceOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    os: str | None = None
    app_version: str | None = None
    online: bool = Field(description="最近一个 TTL 内有没有心跳")
    last_seen_at: datetime
    last_staff_name: str | None = None
    ads_env_count: int = Field(default=0, description="这台电脑上挂着几个 AdsPower 环境")


class HeartbeatOut(BaseModel):
    server_time: datetime = Field(description="服务端此刻，端上据此判断租约还剩多久")
    ttl_sec: int = Field(description="多久没续租算失联")
    device: DeviceOut
    leases: list[LeaseOut] = Field(description="两个爬虫此刻分别归谁")
    pending_crawl_run_id: str | None = Field(
        default=None,
        description="有人给这台电脑派了一轮采集，端上认领后开跑；没有则为 null")
    pending_snapshot_request: dict | None = Field(
        default=None,
        description="有人要取这台电脑上某一轮的现场：{id, run_id, local_run_id}；没有则为 null")


class LeaseActionIn(BaseModel):
    device_id: str = Field(min_length=8, max_length=64)


class LeaseTransferIn(BaseModel):
    to_device_id: str = Field(min_length=8, max_length=64, description="转给哪台")


class LeaseListOut(BaseModel):
    ttl_sec: int
    server_time: datetime
    leases: list[LeaseOut]
    devices: list[DeviceOut] = Field(description="所有登记过的工作台电脑")


class EnvPurposeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    name: str = Field(description="AdsPower 分组名")
    owner: str = Field(description="executor=执行端 / desktop=桌面端 / none=隔离（谁也不碰）")
    note: str | None = None
    updated_at: datetime


class EnvPurposeIn(BaseModel):
    name: str = Field(min_length=1, max_length=32)
    owner: str = Field(description="executor / desktop / none")
    note: str | None = Field(default=None, max_length=200)


class EnvPurposeListOut(BaseModel):
    purposes: list[EnvPurposeOut]
    valid_owners: list[str]


class CrawlRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    status: str
    trigger: str = Field(description="manual=有人点的 / schedule=到点自动的")
    device_id: str | None = None
    device_name: str | None = None
    staff_name: str | None = None
    local_run_id: str | None = Field(default=None, description="端上那份历史记录的 id，出问题时对得上")
    offline_started: bool = Field(default=False, description="服务端当时不可达，端上先跑了、事后补登记")
    total: int = 0
    success: int = 0
    failed: int = 0
    empty: int = Field(default=0, description="搜不到结果：搜索词或型号有问题")
    invalid_price: int = Field(default=0, description="价格解析不出：多半是闲鱼改版")
    risk_control: int = Field(default=0, description="撞了风控：停手等冷却，绝不是重试")
    reason: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None
    snapshot: dict | None = Field(
        default=None,
        description="这一轮的现场取回状态；没人取过则为 null（界面据此决定显示按钮还是下载链接）")


class CrawlRunCreateIn(BaseModel):
    device_id: str | None = Field(default=None, description="指定哪台电脑跑；不给就派给当前持有行情爬虫租约的那台")
    trigger: str = Field(default="manual")
    local_run_id: str | None = Field(default=None, max_length=64)
    offline_started: bool = Field(default=False)


class CrawlRunClaimIn(BaseModel):
    device_id: str = Field(min_length=8, max_length=64)
    local_run_id: str | None = Field(default=None, max_length=64)


class CrawlRunFinishIn(BaseModel):
    device_id: str = Field(min_length=8, max_length=64)
    ok: bool
    total: int = 0
    success: int = 0
    failed: int = 0
    empty: int = 0
    invalid_price: int = 0
    risk_control: int = 0
    reason: str | None = Field(default=None, max_length=300)


class CrawlRunListOut(BaseModel):
    runs: list[CrawlRunOut]


class SnapshotRequestOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    run_id: str
    device_id: str
    status: str
    bytes: int = 0
    reason: str | None = None
    created_at: datetime
    uploaded_at: datetime | None = None
    download_url: str | None = Field(default=None, description="已回传时给一个限时下载地址")

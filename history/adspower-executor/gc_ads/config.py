"""配置加载：config.yaml + 本地身份文件（device_id/token 持久化）。"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class ServerConfig:
    # base_url 语义对齐群控 App 的 API_BASE:**已含 gc 前缀**,enroll 等路径直接往后拼 /enroll。
    # dev 直连后端 = http://127.0.0.1:8100/api/gc;prod 经 nginx = http://127.0.0.1:8000
    # (⚠️ 别用 http://127.0.0.1:8000 —— 那会绕过 /gc/ 反代打到 ERP 旧内嵌路由)。
    base_url: str = "http://127.0.0.1:8100/api/gc"
    enroll_secret: str = ""
    mqtt_host: str = "127.0.0.1"
    mqtt_port: int = 1883
    mqtt_tls: bool = False


@dataclass
class AdsPowerConfig:
    api_base: str = "http://127.0.0.1:50325"  # 勿用 local.adspower.net：会被代理 fake-ip 劫持
    user_id: str = ""
    headless: bool = False
    # 环境清单来源：api = 直接从 /api/v1/user/list 拉（付费版，默认）；
    # config = 只认 config.yaml 的 environments。api 拿不到时自动回退 config。
    env_source: str = "api"
    # 枚举结果缓存秒数：看门狗每 10s 巡检一次，而 Local API 限流 1 次/秒，
    # 不缓存会把枚举打成热路径。新建的环境最迟在一个 TTL 后纳管。
    env_cache_sec: int = 60
    # 只认领这些 AdsPower 分组里的环境（**归属边界**）。
    #
    # 同一台机器上桌面端 seller-pilot 也在驱动 AdsPower，两边必须各管各的环境，
    # 否则会抢同一个浏览器的标签页。用 AdsPower 自带的分组划边界：本执行端只碰
    # 这里列出的分组，其余归桌面端。
    #
    # 写法三选一：留空 / 一个分组名 / 多个（YAML 列表，或逗号分隔）。多个是给
    # 「一台机器同时驱动采购和销售两批环境」用的——销售从安卓搬到浏览器期间，
    # 两批会在同一台机器上共存一段时间，而把 env_group 改成单个销售分组会让采购
    # 那批的消息门铃一起停掉。
    #
    # 留空 = 认领全部环境（改造前的行为）。⚠️ 这是为「还没建分组」保留的过渡默认，
    # 一旦机器上同时跑桌面端就必须设上，否则两边会互相踩。
    # 没有分组的环境在过滤生效时谁也不碰——opt-in 比 opt-out 安全：
    # 新建环境漏了分组只是不被纳管，而不是被错误的一方抢走。
    env_group: str | list = ""
    # 本端在用途登记表里的身份。经本机代理（manage.py broker）时随 X-Ads-Owner
    # 请求头发出，代理据此校验「你有没有资格驱动这个环境」。直连时该头被忽略。
    owner: str = "executor"
    # 用途登记表：分组名 → 谁驱动这个分组的环境。
    #
    # 建环境必须指定用途（manage.py envs --create --purpose），用途不在表里直接拒绝，
    # 避免打错字建出一个谁也不认领的环境。这张表也是「同机两个驱动各管哪些环境」
    # 的唯一说明书，代理（broker）用它做强制校验。
    # owner 取值：executor / desktop / none。none = 显式隔离区，任何一方都不许碰
    # （代理会对它的写操作一律 403），用于停用、待排查、或人工手动操作的环境。
    env_purposes: dict = field(default_factory=lambda: {
        "行情": "executor",   # adspower-executor 常驻驱动（爬价 / 上下架）
        "采购": "executor",   # 采购员账号：常驻消息门铃 + 会话任务（见下方「销售」注）
        "销售": "executor",   # 销售号：网页版上下架（2026-09-15 老板定的方向，销售从
                             # 安卓 App 搬到浏览器，推翻 09-13「销售留在 App 群控」）。
                             # 这个分组名原先是历史遗留（里面装的是采购员账号、归桌面端），
                             # 现在它空了，名字正好归位到字面意思，语义不再拧着。
                             # 归执行端是因为上下架的单子由群控调度中心经 MQTT 派给执行端，
                             # 和「行情」「采购」同一条路；人工登录仍走工作台的环境页。
        "未分配": "none",     # 显式隔离：谁也不驱动，代理拒绝一切写操作
    })

    def env_groups(self) -> list[str]:
        """认领的分组名列表。兼容三种写法：留空 / 单个名字 / YAML 列表或逗号分隔。

        逗号分隔是为了让 config.yaml 里改一行就能加一个分组，不必改成列表语法；
        分组名本身不允许含逗号（AdsPower 侧也不该这么起名）。
        """
        raw = self.env_group
        parts = raw.split(",") if isinstance(raw, str) else [str(p) for p in (raw or [])]
        return [p.strip() for p in parts if p and p.strip()]


@dataclass
class XianyuConfig:
    home_url: str = "https://www.goofish.com"
    chat_url: str = ""


@dataclass
class ExecutorConfig:
    heartbeat_interval_sec: int = 5
    rpc_timeout_sec: int = 15
    screencap_timeout_sec: int = 30
    media_tmp_dir: str = "./tmp/media"
    # 常驻 /im 消息门铃(gc_ads/im_watch.py)：未读上涨就提示服务端立刻扫一轮，
    # 把「知道有新消息」的延迟从一轮 chat_scan（5 分钟）压到秒级。
    # **纯只读**：只 goto + evaluate，不点不发。关掉它只是退回周期轮询，功能不缺。
    im_watch_enabled: bool = True
    im_watch_poll_sec: float = 3.0              # 帧没来时的定期看一眼(长连接断了不至于瞎)
    im_watch_min_hint_interval_sec: float = 15.0  # 两次提示的最小间隔，别把 MQTT 刷满
    im_watch_retry_sec: float = 60.0            # 未登录/异常后的重试间隔
    # 这些会话的未读上涨不触发即时提示（闲鱼官方通知天天有，没必要为它占着设备扫一轮）。
    # 只压即时触发，周期 chat_scan 照常会扫到它们。
    im_watch_ignore_nicks: list = field(default_factory=lambda: ["通知消息"])
    # 代码热更新的静态目录（放 gc-ads-code-version.json 与各 .py）。
    # 留空 = 不查更新。改一行业务代码不必再重打 48MB 的 exe。
    code_update_url: str = "http://127.0.0.1:8000"


@dataclass
class EnvironmentEntry:
    """一个 AdsPower 环境 = 一台"设备" = 一个闲鱼账号。

    env_source=api 时这里不再是清单的事实来源，而是**覆盖项**：
    只为给环境起备注名，或用 enabled: false 把某个环境排除在纳管之外。
    config.yaml 里没写到的环境，一律按启用处理。
    """
    user_id: str
    name: str = ""          # 备注名（闲鱼昵称/店铺名），仅展示用
    enabled: bool = True    # False = 不纳管（api 来源下也照样排除）


def _serial_key(value) -> tuple[int, int | str]:
    """serial_number 是字符串，按数字排；非数字排到最后，保持顺序稳定。"""
    text = str(value or "").strip()
    return (0, int(text)) if text.isdigit() else (1, text)


@dataclass
class Config:
    server: ServerConfig = field(default_factory=ServerConfig)
    adspower: AdsPowerConfig = field(default_factory=AdsPowerConfig)
    xianyu: XianyuConfig = field(default_factory=XianyuConfig)
    executor: ExecutorConfig = field(default_factory=ExecutorConfig)
    environments: list[EnvironmentEntry] = field(default_factory=list)

    @classmethod
    def load(cls, path: str | Path = "config.yaml") -> "Config":
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
        return cls(
            server=ServerConfig(**data.get("server", {})),
            adspower=AdsPowerConfig(**data.get("adspower", {})),
            xianyu=XianyuConfig(**data.get("xianyu", {})),
            executor=ExecutorConfig(**data.get("executor", {})),
            environments=[EnvironmentEntry(**e) for e in data.get("environments", [])],
        )

    def env_user_ids(self, include_disabled: bool = False) -> list[str]:
        """纳管的环境清单。

        env_source=api（默认）：直接从 AdsPower /api/v1/user/list 拉全量环境，按
        serial_number 排序，再用 config.yaml 的 environments 作覆盖——只有显式写了
        enabled: false 的会被排除。API 不可达或免费版拒绝枚举时回退到 config.yaml，
        保证断网/降级套餐下仍可运行。

        env_source=config：只认 config.yaml，行为与改造前一致。
        """
        if self.adspower.env_source == "api":
            remote = self._remote_env_ids()
            if remote is not None:
                disabled = {e.user_id for e in self.environments if not e.enabled}
                return [uid for uid in remote if include_disabled or uid not in disabled]
        return self._config_env_ids(include_disabled)

    def _config_env_ids(self, include_disabled: bool = False) -> list[str]:
        ids = [e.user_id for e in self.environments if include_disabled or e.enabled]
        if not ids and self.adspower.user_id:
            ids = [self.adspower.user_id]
        return ids

    def _remote_env_ids(self) -> list[str] | None:
        """枚举结果（带 TTL 缓存）；不可用时返回 None 让调方回退。"""
        import time

        now = time.monotonic()
        cached = getattr(self, "_env_cache", None)
        if cached and now - cached[0] < self.adspower.env_cache_sec:
            return cached[1]

        from .adspower import AdsPowerClient, PaidFeatureUnavailable
        try:
            users = AdsPowerClient(self.adspower).list_users()
        except PaidFeatureUnavailable:
            # 免费版套餐：静默回退到 config.yaml，这是预期路径而非故障。
            self._env_cache = (now, None)
            return None
        except Exception:
            # API 不可达：本轮回退，但不缓存失败，下次巡检立刻重试。
            return None

        self._env_names = {u["user_id"]: u["name"] for u in users if u.get("name")}
        self._env_groups = {u["user_id"]: u.get("group_name", "") for u in users}
        self._env_total = len(users)

        groups = set(self.adspower.env_groups())
        if groups:
            users = [u for u in users if (u.get("group_name") or "").strip() in groups]

        ids = [u["user_id"] for u in sorted(
            users, key=lambda u: (_serial_key(u.get("serial_number")), u["user_id"]))]
        self._env_cache = (now, ids)
        return ids

    def env_group_report(self) -> dict:
        """给 CLI / doctor 用的归属说明：过滤生效了没、过滤掉了多少。"""
        groups = self.adspower.env_groups()
        group = "、".join(groups)   # 只作显示：CLI / doctor 打给人看
        self.env_user_ids()  # 触发一次枚举（走缓存）
        groups = getattr(self, "_env_groups", None)
        if groups is None:
            return {"group": group, "filtered": False, "total": 0, "claimed": 0, "ungrouped": 0}
        claimed = len(self.env_user_ids(include_disabled=True))
        return {
            "group": group,
            "filtered": bool(groups),
            "total": getattr(self, "_env_total", len(groups)),
            "claimed": claimed,
            "ungrouped": sum(1 for g in groups.values() if not (g or "").strip()),
        }

    def env_display_name(self, user_id: str) -> str:
        """备注名：config.yaml 写了的优先（人工命名），否则用 AdsPower 里的环境名。"""
        for entry in self.environments:
            if entry.user_id == user_id and entry.name:
                return entry.name
        return (getattr(self, "_env_names", None) or {}).get(user_id, "")

    def for_environment(self, user_id: str) -> "Config":
        """返回指定环境的配置副本（adspower.user_id 指向该环境，其余共享）。"""
        import copy
        cfg = copy.copy(self)
        cfg.adspower = copy.copy(self.adspower)
        cfg.adspower.user_id = user_id
        return cfg

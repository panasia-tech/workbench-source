"""本机 AdsPower 代理：全机唯一一条通往 Local API 的路。

# 为什么要它

同一台机器上有两个驱动在打 AdsPower Local API：
  - 桌面端 seller-pilot（JS / CDP），驱动「销售」那批环境
  - 本执行端 adspower-executor（Python / Playwright），驱动「行情」那批

两个独立进程带来两个问题，各自节流都解决不了：

1. **限流是按 AdsPower 进程算的。** Local API 限 1 次/秒，两边各守各的节奏，
   加起来照样超。撞限时 AdsPower 返回 HTTP 200 + code=-1，不抛异常，
   于是 is_active() 静默返回 False，看门狗把一个好好的浏览器judged成「掉了」去重启。

2. **归属只是口头约定。** S0 用 AdsPower 分组划了边界，但那是两侧各自读配置、
   各自自觉遵守。谁配错一个字（或者干脆没配），就会去驱动对方的环境，
   在 CDP 层面抢标签页——而且两边都不知道对方存在。

代理把这两件事一次解决：全机只剩一个进程碰 :50325，节流是全局的；
归属在这个唯一入口上被**强制执行**，而不是靠两边自觉。

# 为什么说原生协议

代理**原样复刻 AdsPower Local API 的路径和响应格式**，不发明新 API。
调方只需要把 base url 从 127.0.0.1:50325 改成 127.0.0.1:50326，其余代码一行不动：

    seller-pilot:  ADSPOWER_API_URL=http://127.0.0.1:50326
    executor:      config.yaml → adspower.api_base

这也意味着代理挂掉时，把 base url 改回 50325 就能立刻退回直连（功能照常，
只是失去全局节流与归属保护），不存在「被代理绑架」的风险。

# 归属怎么判

调方用 X-Ads-Owner 头声明自己是谁（desktop / executor）。代理查环境属于哪个
分组，再查用途登记表（config 的 env_purposes：分组名 → owner），对不上就 403。
没有声明头的请求按只读处理：查询放行，start/stop 拒绝——避免一个忘了配的
调方悄悄绕过归属。
"""
from __future__ import annotations

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .adspower import AdsPowerClient, PaidFeatureUnavailable
from .config import AdsPowerConfig

DEFAULT_PORT = 50326

# 需要归属校验的写操作。其余（查询类）一律放行——读不会抢标签页。
_GUARDED_PATHS = {"/api/v1/browser/start", "/api/v1/browser/stop"}

# 用途登记表里 owner 只能是这三个值:它不是标签,是"谁来驱动"的真实答案,
# 而全机只有两个驱动方（executor / desktop）加一个显式隔离区（none）。
# 允许自由填会让人建出一个谁也不会认领的用途,环境划进去就此沉默。
_VALID_OWNERS = ("executor", "desktop", "none")

# 用途登记表的可写副本。config.yaml 里那份是**出厂默认**,人在界面上改出来的以这份为准;
# 文件不存在就退回默认——删掉它等于恢复出厂设置。
#
# 路径可用 GC_ADS_PURPOSES_FILE 覆盖:这份落盘状态是进程外可见的,回归若读到开发机上
# 真实的那份,断言就会跟着本机现状漂(2026-09-14 实测:删掉「销售」之后归属用例直接翻绿)。
_DEFAULT_PURPOSES_FILE = Path(__file__).resolve().parents[1] / "run" / "env_purposes.json"


def _purposes_file() -> Path:
    override = os.environ.get("GC_ADS_PURPOSES_FILE")
    return Path(override) if override else _DEFAULT_PURPOSES_FILE

# 环境 → 分组 的缓存。查归属要调 user/list，而 start 是热路径，
# 不缓存会让每次启动都多付一次限流等待。
_GROUP_CACHE_SEC = 30


class OwnershipError(Exception):
    def __init__(self, user_id: str, group: str, owner: str, claimed_by: str):
        self.user_id, self.group, self.owner, self.claimed_by = user_id, group, owner, claimed_by
        super().__init__(
            f"环境 {user_id} 属于分组「{group or '未分组'}」，"
            + ("用途登记表里没有这个分组，按隔离处理"
               "（去工作台的浏览器环境页登记这个用途，或把环境移进已登记的分组）" if not owner
               else "被显式隔离（谁也不许驱动）" if owner == "none"
               else f"归 {owner} 驱动，但请求方自称 {claimed_by}"))


class AdsBroker:
    def __init__(self, cfg: AdsPowerConfig, port: int = DEFAULT_PORT, full_cfg=None):
        # ⚠️ 代理自己必须直连 AdsPower，否则会把请求转给自己形成死循环。
        direct = AdsPowerConfig(**{**cfg.__dict__, "api_base": _direct_base(cfg.api_base)})
        self.cfg = direct
        self.ads = AdsPowerClient(direct)
        self.port = port
        self.purposes = dict(getattr(cfg, "env_purposes", None) or {})
        self.purposes_source = "config"
        self._load_purposes()
        # 执行端进程的控制面。代理本来就是这台机器上「唯一入口」,把 supervisor 挂在
        # 它下面,界面才看得见真正在驱动浏览器的那个东西——否则人在界面上点「关闭」,
        # 浏览器被执行端的自愈立刻重开,而界面上完全看不出是谁干的。
        self.full_cfg = full_cfg
        self._groups: dict[str, str] = {}
        self._groups_at = 0.0
        self._lock = threading.Lock()
        self.stats = {"proxied": 0, "denied": 0, "errors": 0}

    # ---------- 用途登记表(可增删改查) ----------

    def _load_purposes(self) -> None:
        """有落盘副本就用它,没有就保持 config 里的出厂默认。读坏了不崩,如实退回默认。"""
        try:
            path = _purposes_file()
            if not path.exists():
                return
            data = json.loads(path.read_text(encoding="utf-8"))
            table = data.get("purposes") if isinstance(data, dict) else None
            if isinstance(table, dict) and table:
                self.purposes = {str(k): str(v) for k, v in table.items()}
                self.purposes_source = "file"
        except Exception as exc:
            print(f"⚠️ 用途登记表读取失败,沿用出厂默认: {exc}", flush=True)

    def _save_purposes(self) -> None:
        path = _purposes_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"purposes": self.purposes}, ensure_ascii=False, indent=2),
            encoding="utf-8")
        self.purposes_source = "file"

    def _envs_in_group(self, name: str) -> int:
        """某用途下还挂着几个环境。枚举不可用时返回 -1(未知),调方据此决定要不要拦。"""
        try:
            users = self.ads.list_users()
        except Exception:
            return -1
        return sum(1 for u in users if (u.get("group_name") or "").strip() == name)

    def upsert_purpose(self, name: str, owner: str) -> dict:
        """新增或改一条用途。owner 只能是 executor / desktop / none。"""
        name = str(name or "").strip()
        owner = str(owner or "").strip()
        if not name:
            raise ValueError("用途名不能为空")
        if len(name) > 32:
            raise ValueError("用途名过长(最多 32 字)")
        if owner not in _VALID_OWNERS:
            raise ValueError(f"owner 只能是 {' / '.join(_VALID_OWNERS)}，收到 {owner!r}")
        with self._lock:
            before = self.purposes.get(name)
            self.purposes[name] = owner
            self._save_purposes()
        return {"name": name, "owner": owner, "before": before}

    def delete_purpose(self, name: str) -> dict:
        """删一条用途。**里面还挂着环境就拒绝**——删掉登记只会让那批环境变成谁也不管,
        它们不会消失,只会安静地没人驱动,而现场看不出发生过什么。"""
        name = str(name or "").strip()
        with self._lock:
            if name not in self.purposes:
                raise ValueError(f"用途「{name}」不存在")
        count = self._envs_in_group(name)
        if count > 0:
            raise ValueError(f"用途「{name}」下还有 {count} 个环境，先把它们改到别的用途再删")
        if count < 0:
            raise ValueError("环境枚举不可用，无法确认该用途下是否还有环境，已拒绝删除")
        with self._lock:
            owner = self.purposes.pop(name)
            self._save_purposes()
        return {"name": name, "owner": owner}

    # ---------- 执行端进程 ----------

    def _supervisor(self):
        """造一个**直连** AdsPower 的 supervisor。

        ⚠️ 不能让它走代理：它的 api_base 默认指着 :50326，也就是代理自己。
        代理在自己的请求线程里再打自己，会卡在那条嵌套请求上，界面看到的是干等
        （2026-09-14 实测：/broker/executor 直接挂住，curl 拿不到任何响应）。
        与 __init__ 里给自身客户端做 _direct_base 是同一个理由。
        """
        if self.full_cfg is None:
            raise ValueError("代理未带完整配置启动，无法控制执行端进程")
        import copy

        from .supervisor import Supervisor
        cfg = copy.deepcopy(self.full_cfg)
        cfg.adspower.api_base = _direct_base(cfg.adspower.api_base)
        return Supervisor(cfg)

    def executor_status(self) -> list[dict]:
        return self._supervisor().status()

    def executor_start(self, user_id: str) -> dict:
        uid = str(user_id or "").strip()
        if not uid:
            raise ValueError("缺少 user_id")
        return self._supervisor().start_one(uid)

    def executor_stop(self, user_id: str, stop_browser: bool = False) -> dict:
        """停执行端。stop_browser=True 时连浏览器一起关。

        **关浏览器必须走这条路**:只调 AdsPower 的 browser/stop 没有用——执行端的
        自愈会在几秒内把它重开(它的职责就是这个)。先停进程再关浏览器,顺序反了白搭。
        """
        uid = str(user_id or "").strip()
        if not uid:
            raise ValueError("缺少 user_id")
        return self._supervisor().stop_one(uid, stop_browser=bool(stop_browser))

    # ---------- 归属 ----------

    def _group_of(self, user_id: str) -> str | None:
        """环境所属分组名；枚举不可用时返回 None（此时放行，见 check_ownership）。"""
        with self._lock:
            fresh = time.monotonic() - self._groups_at < _GROUP_CACHE_SEC
            if fresh and user_id in self._groups:
                return self._groups[user_id]
        try:
            users = self.ads.list_users()
        except (PaidFeatureUnavailable, Exception):
            return None
        mapping = {u["user_id"]: (u.get("group_name") or "").strip() for u in users}
        with self._lock:
            self._groups = mapping
            self._groups_at = time.monotonic()
        return mapping.get(user_id)

    def check_ownership(self, user_id: str, claimed_by: str) -> None:
        """归属不符抛 OwnershipError。

        唯一放行的是**代理判不出分组**（免费版不给枚举、断网、或压根没这个环境）：
        此时拒绝会让整机停摆，所以退回「不拦」，归属仍由两侧配置自觉保证。

        登记表里没有这个分组 —— **包括根本没分组的环境** —— 一律按隔离处理拒绝。
        这条以前是放行的，理由是「人工新建、尚未纳管的环境不该由代理替谁做主」，
        但代价没算清楚：AdsPower 对没分组的环境报的是**空分组名**，永远匹配不上
        登记表里那条「未分配」，于是「建环境时忘了选分组」= 悄悄地没有任何保护，
        而现场看不出发生过什么（2026-09-15 实测：本机 11 个环境里 5 个就挂在那儿）。
        忘配的代价从「静默失去保护」改成「当场报错，去把分组或用途补上」。
        """
        group = self._group_of(user_id)
        if group is None:
            return
        owner = self.purposes.get(group)
        if owner is None:
            raise OwnershipError(user_id, group, None, claimed_by)
        # owner=none 是显式隔离区：不是「还没分配」，而是「明确规定谁都别碰」，
        # 所以任何声明都拒绝，包括本该有权限的那一方。
        if owner != claimed_by:
            raise OwnershipError(user_id, group, owner, claimed_by)

    # ---------- 转发 ----------

    def forward(self, method: str, path: str, query: dict, body: dict) -> dict:
        params = {k: v[0] for k, v in query.items()}
        if method == "GET":
            return self.ads._get(path, params=params, timeout=60)
        return self.ads._post(path, body, timeout=60)

    def serve_forever(self) -> None:
        broker = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, fmt, *a):  # 静音默认 stderr 访问日志
                pass

            def _reply(self, payload: dict, status: int = 200) -> None:
                raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def _handle(self, method: str) -> None:
                parsed = urlparse(self.path)
                path, query = parsed.path, parse_qs(parsed.query)
                body = {}
                if method == "POST":
                    n = int(self.headers.get("Content-Length") or 0)
                    if n:
                        try:
                            body = json.loads(self.rfile.read(n) or b"{}")
                        except ValueError:
                            body = {}

                if path == "/broker/health":
                    return self._reply({"code": 0, "msg": "success", "data": {
                        "broker": "ads-broker", "upstream": broker.cfg.api_base,
                        "purposes": broker.purposes,
                        "purposes_source": broker.purposes_source, "stats": broker.stats}})

                # 用途登记表的增删改查。它就是「谁驱动哪批环境」的答案,过去只能改代码——
                # 一件随人随时间变的事被写死在源码里,每次调整都要找开发。
                if path == "/broker/purposes":
                    if method == "GET":
                        return self._reply({"code": 0, "msg": "success", "data": {
                            "purposes": dict(broker.purposes),
                            "source": broker.purposes_source,
                            "valid_owners": list(_VALID_OWNERS)}})
                    who = (self.headers.get("X-Ads-Owner") or "").strip() or "unknown"
                    try:
                        result = broker.upsert_purpose(body.get("name"), body.get("owner"))
                    except ValueError as exc:
                        return self._reply({"code": -1, "msg": str(exc)}, 400)
                    print(f"用途登记表更新（by {who}）: {result['name']} → {result['owner']}"
                          + (f"（原 {result['before']}）" if result["before"] else "（新增）"), flush=True)
                    return self._reply({"code": 0, "msg": "success", "data": result})

                if path == "/broker/executor":
                    try:
                        return self._reply({"code": 0, "msg": "success",
                                            "data": {"executors": broker.executor_status()}})
                    except Exception as exc:
                        return self._reply({"code": -1, "msg": f"读取执行端状态失败: {exc}"}, 500)

                if path in ("/broker/executor/start", "/broker/executor/stop") and method == "POST":
                    who = (self.headers.get("X-Ads-Owner") or "").strip() or "unknown"
                    try:
                        if path.endswith("/start"):
                            result = broker.executor_start(body.get("user_id"))
                        else:
                            result = broker.executor_stop(body.get("user_id"),
                                                          body.get("stop_browser"))
                    except ValueError as exc:
                        return self._reply({"code": -1, "msg": str(exc)}, 400)
                    except Exception as exc:
                        return self._reply({"code": -1, "msg": f"操作执行端失败: {exc}"}, 500)
                    print(f"执行端 {path.rsplit('/', 1)[1]}（by {who}）: "
                          f"{body.get('user_id')} → {result.get('note') or result}", flush=True)
                    return self._reply({"code": 0, "msg": "success", "data": result})

                if path == "/broker/purposes/delete" and method == "POST":
                    who = (self.headers.get("X-Ads-Owner") or "").strip() or "unknown"
                    try:
                        result = broker.delete_purpose(body.get("name"))
                    except ValueError as exc:
                        return self._reply({"code": -1, "msg": str(exc)}, 400)
                    print(f"用途登记表删除（by {who}）: {result['name']}", flush=True)
                    return self._reply({"code": 0, "msg": "success", "data": result})

                claimed = (self.headers.get("X-Ads-Owner") or "").strip()
                if path in _GUARDED_PATHS:
                    uid = str(body.get("user_id") or (query.get("user_id") or [""])[0]).strip()
                    if not claimed:
                        broker.stats["denied"] += 1
                        return self._reply({"code": -1, "msg":
                            "缺少 X-Ads-Owner 头：写操作必须声明调用方身份（desktop / executor）"}, 403)
                    if not uid:
                        return self._reply({"code": -1, "msg": "user_id is required"}, 400)
                    try:
                        broker.check_ownership(uid, claimed)
                    except OwnershipError as exc:
                        broker.stats["denied"] += 1
                        return self._reply({"code": -1, "msg": f"归属校验失败：{exc}"}, 403)

                try:
                    data = broker.forward(method, path, query, body)
                    broker.stats["proxied"] += 1
                    return self._reply(data)
                except Exception as exc:
                    broker.stats["errors"] += 1
                    return self._reply({"code": -1, "msg": f"代理转发失败: {exc}"}, 502)

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

        server = ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
        print(f"ads-broker 监听 127.0.0.1:{self.port} → 上游 {self.cfg.api_base}", flush=True)
        print(f"  用途登记表: {self.purposes}", flush=True)
        print("  调方把 base url 指到本端口即可；代理挂了改回上游就是直连降级", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nads-broker 退出", flush=True)
        finally:
            server.server_close()


def _direct_base(api_base: str) -> str:
    """把可能指向代理自己的 base url 拉回 AdsPower 本体，避免自环。"""
    base = str(api_base or "").rstrip("/")
    if base.endswith(f":{DEFAULT_PORT}"):
        return base.rsplit(":", 1)[0] + ":50325"
    return base or "http://127.0.0.1:50325"

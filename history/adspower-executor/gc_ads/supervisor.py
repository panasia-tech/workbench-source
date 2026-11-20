"""多环境进程管理器（manage.py 的实现层）。

模型：一个 AdsPower 环境 = 一个 executor 子进程（main.py --user-id <env>）。
- 状态落盘 run/supervisor.json：{user_id: {pid, log, started_at, stopped}}
  stopped=True 是「人工停止」标记，看门狗不会把它重新拉起。
- 进程存活用 os.kill(pid, 0) 探测；日志每环境一个 logs/executor_<user_id>.log。
- start 顺序：先让 AdsPower 开浏览器（start_browser，幂等），再拉起 executor
  （executor 内部还会再 start 一次/复用 ws，幂等安全）。
- 容量：Local API 不提供上限查询，start 撞限时 AdsPower 会返回错误——supervisor
  如实上报错误并继续其余环境，绝不静默吞掉。

⚠️ PID 复用风险：状态文件里的 pid 可能被系统复用。校验时同时比对进程的
命令行里是否含本环境的 --user-id，含才认定是我们的 executor。
"""
from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from .adspower import AdsPowerClient
from .config import Config
from .paths import app_root, is_frozen

ROOT = app_root()
STATE_FILE = ROOT / "run" / "supervisor.json"
LOG_DIR = ROOT / "logs"

_WATCH_INTERVAL_SEC = 10


def _venv_python() -> str:
    win = ROOT / ".venv" / "Scripts" / "python.exe"
    nix = ROOT / ".venv" / "bin" / "python"
    for p in (win, nix):
        if p.exists():
            return str(p)
    return sys.executable


def _executor_cmd(user_id: str) -> list[str]:
    """拉起 executor 子进程的命令行。打包态：本 exe 的 executor 子命令
    （不再依赖 .venv / main.py）；开发态：.venv 里的 python main.py。"""
    if is_frozen():
        return [sys.executable, "executor", "--config", "config.yaml",
                "--user-id", user_id]
    return [_venv_python(), "main.py", "--config", "config.yaml",
            "--user-id", user_id]


# 代理在状态文件里的键。用一个不可能与 AdsPower user_id 冲突的保留名
# （user_id 是字母数字，不含冒号），这样它能复用同一套 pid/日志/人工停止机制。
BROKER_KEY = "::broker"


def _broker_cmd() -> list[str]:
    """拉起本机 AdsPower 代理的命令行（与 executor 同构：打包态走 exe 子命令）。"""
    if is_frozen():
        return [sys.executable, "broker", "--config", "config.yaml"]
    return [_venv_python(), "manage.py", "--config", "config.yaml", "broker"]


def _load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            pass
    return {}


def _save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")


def _pid_alive(pid: int, user_id: str | None = None) -> bool:
    """pid 存活；给 user_id 时校验命令行确实属于该环境的 executor（防 PID 复用误判）。
    开发态命令行含 main.py --user-id X；打包态含 executor --user-id X。"""
    try:
        os.kill(pid, 0)
    except OSError:
        return False

    def _match(cmdline: str) -> bool:
        return bool(user_id) and user_id in cmdline and (
            "main.py" in cmdline or " executor" in cmdline)

    if user_id and platform_has_proc():
        try:
            cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().decode(errors="replace")
            return _match(cmdline)
        except OSError:
            return False
    if user_id and sys.platform == "darwin":
        try:
            out = subprocess.run(["ps", "-p", str(pid), "-o", "command="],
                                 capture_output=True, text=True, timeout=5).stdout
            return _match(out)
        except Exception:
            return True   # 查不动就信 pid 存活
    return True


def platform_has_proc() -> bool:
    return sys.platform.startswith("linux")


class Supervisor:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.ads = AdsPowerClient(cfg.adspower)
        self.state = _load_state()

    # ---------- 单环境操作 ----------

    def _reload(self) -> None:
        """磁盘状态是唯一事实来源：manage.py 各次调用、看门狗是不同进程，
        每次操作前必须重读，否则状态互相覆盖（2026-09-09 实测：看门狗内存态
        stopped=True 不刷新，kill -9 后永不拉起）。"""
        self.state = _load_state()

    def start_one(self, user_id: str) -> dict:
        """启动一个环境：AdsPower 开浏览器 → 拉起 executor 子进程。幂等。"""
        self._reload()
        entry = self.state.get(user_id) or {}
        pid = entry.get("pid")
        if pid and _pid_alive(int(pid), user_id) and not entry.get("stopped"):
            # executor 在跑 ≠ 浏览器在跑:浏览器可能被手动关掉(2026-09-10 实测:此时点「启动」
            # 直接返回「已在跑」,浏览器永远开不回来)。start_browser 幂等,已在跑只是拿回 ws。
            try:
                self.ads.start_browser(user_id)
                return {"user_id": user_id, "ok": True,
                        "note": f"executor 已在跑 (pid={pid}),浏览器已确认/重开"}
            except Exception as exc:
                return {"user_id": user_id, "ok": False,
                        "note": f"executor 已在跑但浏览器重开失败: {exc}"}

        try:
            self.ads.start_browser(user_id)
        except Exception as exc:
            return {"user_id": user_id, "ok": False,
                    "note": f"AdsPower 开浏览器失败: {exc}（环境不存在/套餐并发上限/未登录都会在这里报）"}

        LOG_DIR.mkdir(exist_ok=True)
        # executor 现在自己写日志（gc_ads/logs.py，按天切分、留 30 天），所以这里
        # **不能再往同一个文件重定向** —— 两个写入方会让每行出现两遍，而且轮转后
        # 这个 fd 还钉在旧 inode 上（2026-09-14 实测：日志整篇重复）。
        # stdout 只留给逃出 logging 的东西：解释器级 traceback、C 扩展的输出。
        log_path = LOG_DIR / f"executor_{user_id}.log"
        stdout_path = LOG_DIR / f"executor_{user_id}.out.log"
        log_f = open(stdout_path, "ab")
        env = dict(os.environ)
        # onefile 陷阱：父 exe 退出会清理自己的 _MEI 解压目录，子进程若继承
        # _MEI* 变量会误用那个已删目录（FileNotFoundError base_library.zip）。
        for k in [k for k in env if k.startswith("_MEI")]:
            env.pop(k)
        proc = subprocess.Popen(
            _executor_cmd(user_id),
            cwd=ROOT, stdout=log_f, stderr=subprocess.STDOUT,
            env=env,
            start_new_session=True,   # 脱离父进程，manage.py 退出后子进程继续跑
        )
        self.state[user_id] = {
            "pid": proc.pid,
            "log": str(log_path),
            "started_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "stopped": False,
        }
        _save_state(self.state)
        return {"user_id": user_id, "ok": True, "note": f"executor 已拉起 (pid={proc.pid})"}

    # ---------- 本机代理 ----------

    def start_broker(self) -> dict:
        """拉起本机 AdsPower 代理。幂等；人工 stop 过的不自动拉起（同 executor 语义）。

        代理是全机唯一一条通往 Local API 的路，两侧都指着它，所以它该和 executor
        一样受看门狗托管——手工起的进程关掉终端就没了，那正是遗留项里要解决的。
        """
        self._reload()
        entry = self.state.get(BROKER_KEY) or {}
        pid = entry.get("pid")
        if pid and _pid_alive(int(pid), None) and not entry.get("stopped"):
            return {"user_id": BROKER_KEY, "ok": True, "note": f"代理已在跑 (pid={pid})"}

        LOG_DIR.mkdir(exist_ok=True)
        log_path = LOG_DIR / "broker.log"
        log_f = open(log_path, "ab")
        env = dict(os.environ)
        for k in [k for k in env if k.startswith("_MEI")]:
            env.pop(k)
        proc = subprocess.Popen(
            _broker_cmd(), cwd=ROOT, stdout=log_f, stderr=subprocess.STDOUT,
            env=env, start_new_session=True,
        )
        self.state[BROKER_KEY] = {
            "pid": proc.pid, "log": str(log_path),
            "started_at": time.strftime("%Y-%m-%d %H:%M:%S"), "stopped": False,
        }
        _save_state(self.state)
        return {"user_id": BROKER_KEY, "ok": True, "note": f"代理已拉起 (pid={proc.pid})"}

    def stop_broker(self) -> dict:
        self._reload()
        entry = self.state.get(BROKER_KEY) or {}
        pid = entry.get("pid")
        if pid and _pid_alive(int(pid), None):
            try:
                os.kill(int(pid), signal.SIGTERM)
            except OSError:
                pass
        self.state[BROKER_KEY] = {**entry, "pid": None, "stopped": True}
        _save_state(self.state)
        return {"user_id": BROKER_KEY, "ok": True, "note": "代理已停"}

    def broker_alive(self) -> bool:
        self._reload()
        entry = self.state.get(BROKER_KEY) or {}
        pid = entry.get("pid")
        return bool(pid) and _pid_alive(int(pid), None) and not entry.get("stopped")

    def stop_one(self, user_id: str, stop_browser: bool = False) -> dict:
        """停止一个环境的 executor；stop_browser=True 时连 AdsPower 浏览器一起关。"""
        self._reload()
        entry = self.state.get(user_id) or {}
        pid = entry.get("pid")
        notes = []
        if pid and _pid_alive(int(pid), user_id):
            try:
                os.kill(int(pid), signal.SIGTERM)
                for _ in range(30):
                    if not _pid_alive(int(pid), user_id):
                        break
                    time.sleep(0.2)
                if _pid_alive(int(pid), user_id):
                    os.kill(int(pid), signal.SIGKILL)
                notes.append(f"executor 已停止 (pid={pid})")
            except OSError as exc:
                notes.append(f"kill 失败: {exc}")
        else:
            notes.append("executor 本就没在跑")
        entry["stopped"] = True
        entry["pid"] = pid
        self.state[user_id] = entry
        _save_state(self.state)
        if stop_browser:
            try:
                self.ads.stop_browser(user_id)
                notes.append("浏览器已关")
            except Exception as exc:
                notes.append(f"关浏览器失败: {exc}")
        return {"user_id": user_id, "ok": True, "note": "；".join(notes)}

    # ---------- 批量 ----------

    def start_all(self) -> list[dict]:
        # 代理先起：executor 的 api_base 指着它，晚起会让第一轮请求走降级直连。
        return [self.start_broker()] + [self.start_one(uid) for uid in self.cfg.env_user_ids()]

    def stop_all(self, stop_browser: bool = False) -> list[dict]:
        return [self.stop_one(uid, stop_browser) for uid in self.cfg.env_user_ids()]

    # ---------- 状态盘点 ----------

    def status(self) -> list[dict]:
        """配置环境 × AdsPower 运行态 × executor 进程态 三方对账。"""
        self._reload()
        running = {i.get("user_id") for i in self.ads.local_active()}
        rows = []
        broker = self.state.get(BROKER_KEY) or {}
        rows.append({
            "user_id": "(本机代理)",
            "name": "ads-broker",
            "browser": "—",
            "executor": (f"运行中 (pid={broker.get('pid')})" if self.broker_alive()
                         else ("已停止（人工）" if broker.get("stopped") else "未启动")),
            "log": broker.get("log") or "",
        })
        for uid in self.cfg.env_user_ids(include_disabled=True):
            entry = self.state.get(uid) or {}
            pid = entry.get("pid")
            alive = bool(pid) and _pid_alive(int(pid), uid) and not entry.get("stopped")
            name = self.cfg.env_display_name(uid)
            rows.append({
                "user_id": uid,
                "name": name,
                "browser": "运行中" if uid in running else "未启动",
                "executor": f"运行中 (pid={pid})" if alive else "已停止",
                "log": entry.get("log") or "",
            })
        return rows

    # ---------- 看门狗 ----------

    def run_forever(self, interval: int = _WATCH_INTERVAL_SEC) -> None:
        """前台看门狗：executor 崩了拉起、浏览器掉了重开；人工 stop 过的不碰。"""
        print(f"supervisor 看门狗启动，每 {interval}s 巡检一次，Ctrl-C 退出", flush=True)
        try:
            while True:
                self._reload()   # 磁盘状态可能被 manage.py stop/start 改过，每轮重读
                # 代理挂了要先拉起来：它是全机唯一入口，没有它两侧会降级直连，
                # 失去跨进程节流与环境归属保护。人工 stop 过的不碰（同 executor 语义）。
                if not (self.state.get(BROKER_KEY) or {}).get("stopped") and not self.broker_alive():
                    print(f"[{time.strftime('%H:%M:%S')}] 代理不在跑，拉起", flush=True)
                    print(f"  → {self.start_broker()['note']}", flush=True)
                for uid in self.cfg.env_user_ids():
                    entry = self.state.get(uid) or {}
                    if entry.get("stopped"):
                        continue
                    pid = entry.get("pid")
                    if not (pid and _pid_alive(int(pid), uid)):
                        print(f"[{time.strftime('%H:%M:%S')}] {uid} executor 不在跑，拉起",
                              flush=True)
                        r = self.start_one(uid)
                        print(f"  → {r['note']}", flush=True)
                    elif not self.ads.is_active(uid):
                        print(f"[{time.strftime('%H:%M:%S')}] {uid} 浏览器掉了，重开",
                              flush=True)
                        try:
                            self.ads.start_browser(uid)
                        except Exception as exc:
                            print(f"  → 重开失败: {exc}", flush=True)
                time.sleep(interval)
        except KeyboardInterrupt:
            print("supervisor 退出（executor 子进程保留运行）", flush=True)

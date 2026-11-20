"""AdsPower 安装/运行检测（manage.py doctor）。

检查项：
1. 安装：常见安装路径（macOS /Applications、Windows %LOCALAPPDATA%\\Programs）
2. 进程：AdsPower 客户端是否在跑
3. Local API：50325 是否可达（浏览器自动化的一切前提）
4. 套餐能力：user/list 等枚举接口是否开放（免费版不开放 → 环境清单只能靠本地配置）
5. 运行中实例：local-active 列表（当前开了几个环境）
6. 配置的环境：config.yaml environments 逐个查 active 状态
7. 上游依赖：调度中心 base_url、MQTT broker 端口可达性

只做只读探测，不做任何启停动作。
"""
from __future__ import annotations

import glob
import os
import platform
import plistlib
import socket
import subprocess
from dataclasses import dataclass, field

import httpx

from .adspower import AdsPowerClient
from .config import Config


@dataclass
class Check:
    name: str
    ok: bool
    detail: str = ""
    level: str = "required"   # required=不过则不可用 / info=仅提示


@dataclass
class DoctorReport:
    checks: list[Check] = field(default_factory=list)

    def add(self, name: str, ok: bool, detail: str = "", level: str = "required") -> None:
        self.checks.append(Check(name, ok, detail, level))

    @property
    def healthy(self) -> bool:
        return all(c.ok for c in self.checks if c.level == "required")


def _find_install() -> tuple[str | None, str | None]:
    """返回 (安装路径, 版本号)；未找到返回 (None, None)。"""
    if platform.system() == "Darwin":
        for p in sorted(glob.glob("/Applications/AdsPower*.app")):
            ver = None
            plist = os.path.join(p, "Contents", "Info.plist")
            try:
                with open(plist, "rb") as f:
                    ver = plistlib.load(f).get("CFBundleShortVersionString")
            except Exception:
                pass
            return p, ver
        return None, None
    if platform.system() == "Windows":
        local = os.environ.get("LOCALAPPDATA", "")
        for p in sorted(glob.glob(os.path.join(local, "Programs", "adspower*"))):
            return p, None
        return None, None
    return None, None   # Linux 无桌面客户端


def _process_running() -> bool:
    try:
        if platform.system() == "Windows":
            out = subprocess.run(["tasklist"], capture_output=True, text=True, timeout=10).stdout
            return "adspower" in out.lower()
        out = subprocess.run(["pgrep", "-fl", "AdsPower"], capture_output=True, text=True,
                             timeout=10).stdout
        return "AdsPower" in out
    except Exception:
        return False


def _tcp_open(host: str, port: int, timeout: float = 3.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def run_doctor(cfg: Config) -> DoctorReport:
    rep = DoctorReport()

    # 0. Python 运行环境（部署新机器时第一眼要看的）
    import importlib.util
    import sys
    from .paths import is_frozen
    ver = sys.version_info
    if is_frozen():
        rep.add("Python 运行时", True, f"打包内置（{ver.major}.{ver.minor}.{ver.micro}），目标机无需装 Python")
    else:
        rep.add("Python ≥3.10", ver >= (3, 10), f"{ver.major}.{ver.minor}.{ver.micro}（{sys.executable}）")
        rep.add("运行在项目 .venv 里", ".venv" in sys.executable,
                sys.executable if ".venv" in sys.executable else
                f"{sys.executable} —— 不是 .venv 的解释器，依赖可能装错位置", level="info")
    missing = [m for m in ("playwright", "paho.mqtt", "httpx", "yaml")
               if importlib.util.find_spec(m.split(".")[0]) is None]
    rep.add("依赖已安装", not missing,
            "playwright/paho-mqtt/httpx/pyyaml 齐全" if not missing else
            f"缺: {', '.join(missing)} → .venv/bin/pip install -r requirements.txt")

    # 1. 安装
    path, ver = _find_install()
    rep.add("AdsPower 已安装", path is not None,
            f"{path}" + (f" (v{ver})" if ver else "") if path else
            "未找到安装路径（macOS: /Applications/AdsPower*.app）")

    # 2. 进程
    running = _process_running()
    rep.add("AdsPower 进程在跑", running,
            "" if running else "请先启动 AdsPower 客户端并登录", level="info")

    # 3. Local API
    ads = AdsPowerClient(cfg.adspower)
    api_ok = ads.api_alive()
    rep.add("Local API 可达", api_ok,
            cfg.adspower.api_base if api_ok else
            f"{cfg.adspower.api_base} 无响应（客户端未启动 / 未开 API / 端口不对）")

    if api_ok:
        # 4. 套餐能力：枚举接口是否开放
        try:
            d = httpx.get(f"{cfg.adspower.api_base}/api/v1/user/list",
                          params={"page": 1, "page_size": 1}, timeout=8).json()
            paid = d.get("code") == 0
        except Exception:
            paid = False
        rep.add("套餐开放环境枚举 API", paid,
                "" if paid else "免费版：环境清单只能读本地 config.yaml environments",
                level="info")

        # 5. 运行中实例
        active = ads.local_active()
        rep.add("运行中的浏览器实例", True, f"{len(active)} 个：" +
                (", ".join(i.get("user_id", "?") for i in active) or "无"), level="info")

    # 6. 配置的环境逐个查状态
    env_ids = cfg.env_user_ids()
    if not env_ids:
        rep.add("已配置环境", False, "config.yaml 未配置 environments / adspower.user_id")
    else:
        for uid in env_ids:
            rep.add(f"环境 {uid}", api_ok and ads.is_active(uid),
                    "运行中" if (api_ok and ads.is_active(uid)) else "未启动",
                    level="info")

    # 7. 上游依赖
    try:
        r = httpx.get(f"{cfg.server.base_url}/devices", timeout=8)
        rep.add("调度中心可达", r.status_code == 200, cfg.server.base_url)
    except Exception as exc:
        rep.add("调度中心可达", False, f"{cfg.server.base_url}: {exc}")
    rep.add("MQTT broker 可达",
            _tcp_open(cfg.server.mqtt_host, cfg.server.mqtt_port),
            f"{cfg.server.mqtt_host}:{cfg.server.mqtt_port}")

    return rep


def format_report(rep: DoctorReport) -> str:
    lines = []
    for c in rep.checks:
        mark = "✓" if c.ok else ("✗" if c.level == "required" else "·")
        line = f"{mark} {c.name}"
        if c.detail:
            line += f"  —— {c.detail}"
        lines.append(line)
    lines.append("")
    lines.append("整体: " + ("健康，可以启动执行端" if rep.healthy else "有必检项未过，先解决 ✗ 项"))
    return "\n".join(lines)

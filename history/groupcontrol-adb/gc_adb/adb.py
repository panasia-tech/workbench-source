"""ADB 封装:枚举设备 + 跑 shell。基于 adbutils,mac/win 通用。"""
from __future__ import annotations

import logging
import subprocess
import sys
import time
from dataclasses import dataclass

try:
    import adbutils
except ImportError:  # pragma: no cover
    adbutils = None

log = logging.getLogger("gc_adb.adb")


@dataclass
class Device:
    serial: str
    model: str = ""


class Adb:
    def __init__(self, adb_path: str | None = None) -> None:
        if adbutils is None:
            raise RuntimeError("请先安装 adbutils: pip install adbutils")
        self._adb_path = adb_path or "adb"
        self._last_recover = 0.0
        # exe 分发时带了 adb.exe:先用它拉起 adb server,adbutils 再连这个 server。
        # 留空则依赖系统 PATH 里的 adb(或已在跑的 server)。
        if not self._start_server():
            self.recover_server("首次启动失败")
        # 连接本机 adb server(未起会自动拉起)
        self._client = adbutils.AdbClient()

    def _start_server(self) -> bool:
        try:
            r = subprocess.run(
                [self._adb_path, "start-server"], timeout=25,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            return r.returncode == 0
        except Exception as e:
            log.warning("用 %s 启动 adb server 失败: %s", self._adb_path, e)
            return False

    def recover_server(self, reason: str = "") -> bool:
        """adb server 卡死/端口被占时的自愈:kill 残留进程后重启 server。

        30 秒内防抖,避免每轮扫描都触发。返回是否恢复成功。"""
        if time.monotonic() - self._last_recover < 30:
            return False
        self._last_recover = time.monotonic()
        log.warning("adb server 异常(%s),尝试自动恢复…", reason)
        subprocess.run([self._adb_path, "kill-server"], timeout=10,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if sys.platform == "win32":
            # 清掉卡死/残留的 adb 进程(含被其它工具带起后僵死的)
            subprocess.run(["taskkill", "/F", "/IM", "adb.exe"], timeout=10,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.2)
        ok = self._start_server()
        if ok:
            log.info("adb server 已恢复")
        else:
            log.error("adb 恢复失败;若是 5037 端口被占用,请退出应用宝/360/华为/小米手机助手等软件后重试")
        return ok

    def devices(self) -> list[Device]:
        """当前 state=device 的设备(unauthorized/offline 会被 adbutils 过滤在外)。"""
        out: list[Device] = []
        for d in self._client.device_list():
            model = ""
            try:
                model = d.prop.model or ""
            except Exception:  # 个别机型取 prop 会抛,别让它中断整轮
                pass
            out.append(Device(serial=d.serial, model=model))
        return out

    def shell(self, serial: str, cmd: str, timeout: float = 15.0) -> str:
        """在指定设备跑 shell,返回 stdout 文本;失败抛异常由调用方兜。"""
        d = self._client.device(serial)
        return d.shell(cmd, timeout=timeout)

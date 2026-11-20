"""主循环:枚举设备 → 保活 → 检测 → 掉前台/服务停则拉活 →(可选)投屏/上报。"""
from __future__ import annotations

import logging
import subprocess
import threading

from . import keepalive, monitor
from .adb import Adb

log = logging.getLogger("gc_adb.daemon")


class Daemon:
    def __init__(self, cfg: dict) -> None:
        self.cfg = cfg
        self.adb = Adb(cfg.get("adb_path"))
        self.pkg = cfg["package"]
        self.main_activity = cfg["main_activity"]
        self._scrcpy: dict[str, subprocess.Popen] = {}
        self._stop = threading.Event()

    def stop(self) -> None:
        """请求停止主循环(GUI/外部调用);run() 会在本轮结束后退出并关掉投屏。"""
        self._stop.set()

    def _handle(self, serial: str) -> None:
        ka = self.cfg.get("keepalive", {})
        keepalive.apply_screen_keepalive(self.adb, serial, ka)
        keepalive.apply_background_grants(self.adb, serial, self.pkg, ka)

        h = monitor.health(self.adb, serial, self.pkg)
        # 只在 GcService 没跑时才拉活。GcService 是前台服务(带常驻通知),不会被 MIUI 冻结;
        # 它在跑时前台是闲鱼(com.taobao.idlefish)恰恰说明正在执行任务——此时绝不能 am start
        # 把 app 切到前台,否则会打断正在进行的闲鱼操作。
        if not h["gc_service"]:
            log.warning("拉活 %s (前台=%s gc服务=False)", serial, h["foreground"] or "-")
            keepalive.revive(self.adb, serial, self.pkg, self.main_activity, ka)
        else:
            log.info("正常 %s (gc服务在跑,当前前台=%s)", serial, h["foreground"] or "-")

        rep = self.cfg.get("report", {})
        if rep.get("enabled"):
            monitor.report(rep["base_url"], serial, h)

        sc = self.cfg.get("scrcpy", {})
        if sc.get("enabled"):
            self._ensure_scrcpy(serial, sc)

    def _ensure_scrcpy(self, serial: str, sc: dict) -> None:
        p = self._scrcpy.get(serial)
        if p and p.poll() is None:
            return  # 已在投屏
        args = [sc.get("bin", "scrcpy"), "-s", serial]
        for a in sc.get("extra_args", []):
            args.append(str(a).replace("{serial}", serial))
        log.info("启动投屏: %s", " ".join(args))
        try:
            self._scrcpy[serial] = subprocess.Popen(args)
        except FileNotFoundError:
            log.error("找不到 scrcpy 可执行文件(scrcpy.bin=%s)", sc.get("bin"))

    def _once(self) -> None:
        devices = self.adb.devices()
        log.info("本轮设备: %d 台 %s", len(devices), [d.serial for d in devices])
        for d in devices:
            try:
                self._handle(d.serial)
            except Exception:
                log.exception("处理设备 %s 出错", d.serial)

    def run(self) -> None:
        interval = self.cfg.get("scan_interval", 15)
        log.info("守护启动;每 %ds 一轮;包名=%s", interval, self.pkg)
        try:
            while not self._stop.is_set():
                try:
                    self._once()
                except Exception as e:
                    log.exception("扫描轮出错")
                    # 多数是 adb server 挂了/端口被抢,尝试自愈(30s 防抖,不影响正常循环)
                    self.adb.recover_server(str(e)[:80])
                self._stop.wait(interval)
        finally:
            for serial, p in self._scrcpy.items():
                if p.poll() is None:
                    log.info("停止投屏: %s", serial)
                    p.terminate()
            log.info("守护已停止")

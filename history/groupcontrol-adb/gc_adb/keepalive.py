"""保活:防息屏 + 电池白名单 + 后台权限 + 前台检测/拉活。

所有 ADB 指令都幂等,每轮重复执行无副作用(设置类是覆盖写,授权类是置位)。
"""
from __future__ import annotations

import logging

from .adb import Adb

log = logging.getLogger("gc_adb.keepalive")

# 息屏超时拉满(约 24.8 天,int32 上限),等效"永不自动息屏"
NEVER_SLEEP_MS = 2147483647


def apply_screen_keepalive(adb: Adb, serial: str, cfg: dict) -> None:
    if cfg.get("disable_screen_off", True):
        adb.shell(serial, f"settings put system screen_off_timeout {NEVER_SLEEP_MS}")
    if cfg.get("stay_on_while_charging", True):
        # true = 任意充电方式(USB/AC/无线)都保持屏幕常亮
        adb.shell(serial, "svc power stayon true")


def wake(adb: Adb, serial: str) -> None:
    """亮屏(息屏状态下拉活前先唤醒)。KEYCODE_WAKEUP 只唤醒不会误锁。"""
    adb.shell(serial, "input keyevent KEYCODE_WAKEUP")


def apply_background_grants(adb: Adb, serial: str, pkg: str, cfg: dict) -> None:
    if cfg.get("battery_whitelist", True):
        adb.shell(serial, f"dumpsys deviceidle whitelist +{pkg}")
    if cfg.get("allow_background", True):
        adb.shell(serial, f"cmd appops set {pkg} RUN_IN_BACKGROUND allow")
        adb.shell(serial, f"cmd appops set {pkg} WAKE_LOCK allow")


def foreground_package(adb: Adb, serial: str) -> str:
    """当前前台(Resumed)app 的包名。兼容不同 ROM 的 dumpsys 字段名。"""
    out = adb.shell(
        serial,
        "dumpsys activity activities | grep -E 'mResumedActivity|ResumedActivity|topResumedActivity' | head -1",
    )
    # 典型片段: ...{... com.erp.groupcontrol/.ui.MainActivity ...}
    for tok in out.replace("{", " ").replace("}", " ").split():
        if "/" in tok and "." in tok.split("/")[0]:
            return tok.split("/")[0]
    return ""


def service_running(adb: Adb, serial: str, pkg: str, service_suffix: str = "GcService") -> bool:
    out = adb.shell(serial, f"dumpsys activity services {pkg}")
    return service_suffix in out


def revive(adb: Adb, serial: str, pkg: str, main_activity: str, cfg: dict) -> None:
    """唤醒 + 把 app 拉到前台。autostart_extra 让 app 自动启动 GcService(需 app 读 extra)。"""
    wake(adb, serial)
    extra = " --ez autostart true" if cfg.get("autostart_extra", True) else ""
    adb.shell(serial, f"am start -n {pkg}/{main_activity}{extra}")

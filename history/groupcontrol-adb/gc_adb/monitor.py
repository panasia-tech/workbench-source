"""设备健康检测 + 可选上报 server。"""
from __future__ import annotations

import logging

import requests

from . import keepalive
from .adb import Adb

log = logging.getLogger("gc_adb.monitor")


def health(adb: Adb, serial: str, pkg: str) -> dict:
    """一台设备的健康快照。"""
    fg = keepalive.foreground_package(adb, serial)
    return {
        "serial": serial,
        "foreground": fg,
        "app_foreground": fg == pkg,
        "gc_service": keepalive.service_running(adb, serial, pkg),
    }


def report(base_url: str, serial: str, h: dict) -> None:
    """把 ADB 物理状态报给 server。

    注:复用 /api/gc/devices/{id}/heartbeat 需要 app token(且 device_id≠adb serial),
    所以这里打到一个物理层端点 /api/gc/adb/health(需 server 侧新增)。
    端点没上线也不影响保活——失败仅记 debug。
    """
    try:
        requests.post(f"{base_url}/api/gc/adb/health", json=h, timeout=5)
    except Exception as e:  # 上报是锦上添花,绝不能拖垮守护
        log.debug("上报失败(可忽略): %s", e)

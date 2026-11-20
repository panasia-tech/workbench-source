"""设备注册与心跳，协议对齐 groupcontrol-server `api.py`。

base_url 已含 gc 前缀（对齐群控 App 的 API_BASE 约定）：
- dev 直连后端:  http://127.0.0.1:8100/api/gc
- prod 经 nginx: http://127.0.0.1:8000

- POST {base_url}/enroll                 首启注册，hw_id 幂等，签发 {device_id, token}
- POST {base_url}/devices/{id}/heartbeat 每 5s，带 token 校验

与 Android 端的差异：hw_id 用 AdsPower user_id（环境 ID 天然唯一且稳定），
并上报 device.kind = "browser"（需服务端配套支持，见 README §五）。

身份文件按环境隔离：device_identity_<user_id>.json（多环境共用一份代码时互不覆盖）；
兼容旧的单环境 device_identity.json（hw_id 匹配即迁移复用）。
"""
from __future__ import annotations

import json
from pathlib import Path

import httpx

from .config import Config
from . import __version__

_LEGACY_IDENTITY_FILE = Path("device_identity.json")


def _identity_file(user_id: str) -> Path:
    return Path(f"device_identity_{user_id}.json")


class EnrollClient:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.device_id: str = ""
        self.token: str = ""

    def load_or_enroll(self) -> None:
        """本地已有身份则复用，否则走 enroll。hw_id = adspower.user_id。"""
        ident = _identity_file(self.cfg.adspower.user_id)
        for f in (ident, _LEGACY_IDENTITY_FILE):
            if not f.exists():
                continue
            data = json.loads(f.read_text(encoding="utf-8"))
            if data.get("hw_id") == self.cfg.adspower.user_id:
                self.device_id, self.token = data["device_id"], data["token"]
                if f is _LEGACY_IDENTITY_FILE and f != ident:
                    ident.write_text(f.read_text(encoding="utf-8"), encoding="utf-8")
                return
        self._enroll()

    def _enroll(self) -> None:
        resp = httpx.post(
            f"{self.cfg.server.base_url}/enroll",
            json={
                "hw_id": self.cfg.adspower.user_id,
                "brand": "adspower",
                "model": "browser",
                "app_version": __version__,
                "enroll_secret": self.cfg.server.enroll_secret,
                "kind": "browser",
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        self.device_id, self.token = data["device_id"], data["token"]
        _identity_file(self.cfg.adspower.user_id).write_text(
            json.dumps({
                "hw_id": self.cfg.adspower.user_id,
                "device_id": self.device_id,
                "token": self.token,
            }),
            encoding="utf-8",
        )

    def heartbeat(self, *, mqtt_connected: bool, page_ready: bool,
                  blocking: str = "", busy: bool = False) -> None:
        """对应 App 的 5s 心跳；字段名与 api.py 保持一致。"""
        resp = httpx.post(
            f"{self.cfg.server.base_url}/devices/{self.device_id}/heartbeat",
            json={
                "token": self.token,
                "mqtt_connected": mqtt_connected,
                "a11y_ready": page_ready,   # 浏览器侧语义：页面可用（登录态+可达）
                "blocking": blocking,
                "busy": busy,
                "app_version": __version__,
            },
            timeout=10,
        )
        resp.raise_for_status()
        return resp.json()

    def upload_logs(self, request_id: str, blob: bytes) -> dict:
        """把日志包交回服务端（多表单）。失败抛异常，由调方决定重试。"""
        resp = httpx.post(
            f"{self.cfg.server.base_url}/logs/upload",
            data={"request_id": request_id},
            files={"file": (f"{request_id}.zip", blob, "application/zip")},
            timeout=120,
        )
        resp.raise_for_status()
        return resp.json()

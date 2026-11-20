"""MQTT 客户端：topic 与帧格式对齐 groupcontrol-server `mqtt_bridge.py`。

订阅：
  gc/{device_id}/rpc        原语 RPC 请求 {req_id, op, args}
  gc/{device_id}/cmd        控制类指令 {task_id, task_type, payload}
                            （restart = 重建浏览器连接;update_code = 下载新代码后退出进程、
                            由 supervisor 拉起换新。未知 task_type 静默忽略——老执行端
                            对新指令天然安全）
发布：
  gc/{device_id}/rpc_resp   原语响应 {req_id, ok, data, err, ts}
  gc/{device_id}/report     任务状态 / identity / event / exit_info 帧
  gc/{device_id}/status     retained 在线态（LWT 遗嘱 offline）
  gc/{device_id}/log        纯文本日志（QoS0）

鉴权：username = device_id，password = token（EMQX HTTP 钩子校验）。
"""
from __future__ import annotations

import asyncio
import json
from typing import Awaitable, Callable

import paho.mqtt.client as mqtt

from .config import Config
from .primitives import PrimitiveExecutor


class GcMqttClient:
    def __init__(self, cfg: Config, device_id: str, token: str,
                 executor: PrimitiveExecutor,
                 on_restart: Callable[[], Awaitable[None]] | None = None,
                 on_update_code: Callable[[], Awaitable[None]] | None = None):
        self.cfg = cfg
        self.device_id = device_id
        self.executor = executor
        self.on_restart = on_restart
        self.on_update_code = on_update_code
        self.connected = False
        self.client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=device_id,
            protocol=mqtt.MQTTv5,
        )
        self.client.username_pw_set(device_id, token)
        self.client.will_set(
            f"gc/{device_id}/status",
            payload=json.dumps({"online": False}),
            qos=1, retain=True,
        )
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.on_message = self._on_message
        self._loop: asyncio.AbstractEventLoop | None = None

    def start(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        if self.cfg.server.mqtt_tls:
            # 显式用 certifi 根证书:macOS/Windows 的 Python 往往没接系统根证书
            # (mac python.org 包没跑 Install Certificates.command 时 ssl 默认上下文凭证为空)
            import certifi
            self.client.tls_set(ca_certs=certifi.where())
        self.client.connect(self.cfg.server.mqtt_host, self.cfg.server.mqtt_port)
        self.client.loop_start()

    def _on_connect(self, client, userdata, flags, reason_code, properties):
        self.connected = True
        prefix = f"gc/{self.device_id}"
        client.subscribe(f"{prefix}/rpc", qos=1)
        client.subscribe(f"{prefix}/cmd", qos=1)
        client.publish(f"{prefix}/status",
                       payload=json.dumps({"online": True}), qos=1, retain=True)

    def _on_disconnect(self, client, userdata, disconnect_flags, reason_code, properties):
        self.connected = False

    def _on_message(self, client, userdata, msg):
        try:
            frame = json.loads(msg.payload)
        except (ValueError, TypeError):
            return
        if msg.topic.endswith("/rpc") and self._loop:
            asyncio.run_coroutine_threadsafe(self._handle_rpc(frame), self._loop)
        elif msg.topic.endswith("/cmd") and self._loop:
            task_type = frame.get("task_type") or (frame.get("payload") or {}).get("task_type")
            if task_type == "restart" and self.on_restart is not None:
                asyncio.run_coroutine_threadsafe(self._safe_restart(), self._loop)
            elif task_type == "update_code" and self.on_update_code is not None:
                asyncio.run_coroutine_threadsafe(self._safe_update_code(), self._loop)

    async def _safe_restart(self) -> None:
        """cmd restart：重建浏览器连接。任何失败只记日志，不影响 MQTT 链路。"""
        try:
            await self.on_restart()
            self.log("restart ok: browser reconnected")
        except Exception as exc:
            self.log(f"restart failed: {type(exc).__name__}: {exc}")

    async def _safe_update_code(self) -> None:
        """cmd update_code：下载新代码后退出进程，由 supervisor 拉起换新。
        任何失败只记日志，不影响 MQTT 链路；回调缺失(老版本接线)时指令在
        _on_message 层就被忽略，不会走到这里。"""
        try:
            await self.on_update_code()
            self.log("update_code ok: exiting for supervisor restart")
        except Exception as exc:
            self.log(f"update_code failed: {type(exc).__name__}: {exc}")

    async def _handle_rpc(self, frame: dict) -> None:
        resp = await self.executor.execute(
            frame["req_id"], frame["op"], frame.get("args") or {})
        self.client.publish(
            f"gc/{self.device_id}/rpc_resp",
            payload=json.dumps(resp, ensure_ascii=False), qos=1)

    def stop(self) -> None:
        prefix = f"gc/{self.device_id}"
        try:
            self.client.publish(f"{prefix}/status",
                                payload=json.dumps({"online": False}), qos=1, retain=True)
            self.client.disconnect()
        finally:
            self.client.loop_stop()

    def report(self, payload: dict) -> None:
        self.client.publish(
            f"gc/{self.device_id}/report",
            payload=json.dumps(payload, ensure_ascii=False), qos=1)

    def log(self, text: str) -> None:
        self.client.publish(f"gc/{self.device_id}/log", payload=text, qos=0)

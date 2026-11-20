"""真机发布流程 dry-run(经 MqttRpcTransport,confirm_publish=false 只填不发)。

首次让服务端流程引擎(engine + publish_flow)经生产传输(MQTT 原语 RPC)驱动真机,
验证 brain↔hand 全链路:OCR 锚点 / scroll / keypad / 节点选图。**绝不点「发布」**。

自带一个最小 RPC 桥(独立 clientId,避免与常驻 uvicorn 的 gc-backend 桥抢会话);
username 仍用 gc-backend,故 EMQX /mqtt/auth 照样授超级用户。uvicorn 需在跑
(EMQX 的鉴权 HTTP 钩子指向 :8100,停了它设备也连不上)。

用法:.venv/bin/python scripts/publish_dryrun.py <device_id> [image_url ...]
"""

import asyncio
import json
import sys
from uuid import uuid4

import aiomqtt

sys.path.insert(0, ".")
from app.config import settings  # noqa: E402
from app.flow.transport import MqttRpcTransport  # noqa: E402
from app.flow.publish_flow import run_publish  # noqa: E402

SC = "/Users/boxinhui/.claude/tmp/claude-501/-Users-boxinhui-Desktop-------erp---/9230d8f2-57c6-444d-b759-164f7fb913e4/scratchpad"


class ProbeBridge:
    """MqttRpcTransport 只用到 .rpc / .connected;这里用独立 clientId 实现一份。"""

    def __init__(self):
        self._client = None
        self._ready = asyncio.Event()
        self._pending = {}
        self._loop = None
        self._task = None
        self._stop = False

    async def start(self):
        self._loop = asyncio.get_running_loop()
        self._task = asyncio.create_task(self._run())

    async def stop(self):
        self._stop = True
        if self._task:
            self._task.cancel()

    @property
    def connected(self):
        return self._ready.is_set()

    async def _run(self):
        while not self._stop:
            try:
                async with aiomqtt.Client(
                    hostname=settings.mqtt_host, port=settings.mqtt_port,
                    username=settings.mqtt_backend_username,
                    password=settings.mqtt_backend_password,
                    identifier="gc-backend-dryrun",  # ★ 独立 clientId,不与常驻桥抢
                ) as client:
                    self._client = client
                    await client.subscribe("gc/+/rpc_resp", qos=1)
                    self._ready.set()
                    async for m in client.messages:
                        try:
                            d = json.loads(m.payload)
                        except Exception:
                            continue
                        fut = self._pending.get(d.get("req_id"))
                        if fut and not fut.done():
                            fut.set_result(d)
            except aiomqtt.MqttError:
                self._ready.clear()
                for f in self._pending.values():
                    if not f.done():
                        f.set_exception(RuntimeError("MQTT 断开"))
                self._pending.clear()
                await asyncio.sleep(2)
            except asyncio.CancelledError:
                break

    async def rpc(self, device_id, op, args=None, timeout=15.0):
        await asyncio.wait_for(self._ready.wait(), timeout=8)
        req_id = uuid4().hex
        fut = self._loop.create_future()
        self._pending[req_id] = fut
        frame = {"req_id": req_id, "op": op, "args": args or {}}
        try:
            await self._client.publish(f"gc/{device_id}/rpc", json.dumps(frame), qos=1)
            resp = await asyncio.wait_for(fut, timeout=timeout)
        finally:
            self._pending.pop(req_id, None)
        if not resp.get("ok"):
            from app.mqtt_bridge import RpcError
            raise RpcError(f"原语 {op} 失败:{resp.get('err')}")
        return resp.get("data") or {}


async def main():
    device_id = sys.argv[1]
    images = sys.argv[2:]
    # 环境变量 GC_SKIP_DESC=1 时把 description 置空,跳过描述步(隔离验证 price/shipping)
    import os as _os
    _desc = "" if _os.getenv("GC_SKIP_DESC") == "1" else "AOC 24G2"
    spec = {
        "images": images,
        "description": _desc,
        "ai_rewrite": True,
        "price": 460,
        "shipping": {"mode": "fixed_fee", "fixed_fee": 12, "self_pickup": True},
        "location": None,
        "worry_free_sell": True,
        "confirm_publish": False,   # ★ 硬保持 false:只填不发
    }

    bridge = ProbeBridge()
    await bridge.start()
    for _ in range(30):
        if bridge.connected:
            break
        await asyncio.sleep(0.3)
    print("bridge connected:", bridge.connected, flush=True)

    loop = asyncio.get_running_loop()
    t = MqttRpcTransport(bridge, device_id, loop, rpc_timeout=15)
    result = await asyncio.to_thread(run_publish, t, spec)
    print("RESULT:", result, flush=True)

    try:
        png = await asyncio.to_thread(t.screencap)
        with open(f"{SC}/publish_final.jpg", "wb") as f:
            f.write(png)
        print(f"末态截图 saved bytes={len(png)}", flush=True)
    except Exception as e:
        print("末态截图失败:", e, flush=True)

    await bridge.stop()


if __name__ == "__main__":
    asyncio.run(main())

"""真机发布流程「真发」(经 MqttRpcTransport,confirm_publish=TRUE)。

⚠️ 会在该设备登录的闲鱼账号上**真实发布一条商品**(老板已于 2026-07-14 授权真发一条)。
发布后自动探察:发布成功页 → 我的-我发布的-在卖 列表 → 商品详情页,
全程截图+dump_nodes 存证,供校准:无忧卖弹窗 / 成功锚点 / item_id 回读 / 下架-改价定位。

用法:.venv/bin/python scripts/publish_real.py <device_id> <image_url ...>
产物:$GC_RUN_DIR(默认 ./shots/real_<ts>)下的 *.png / *_nodes.json / run.log
"""

import asyncio
import json
import os
import sys
import time
from uuid import uuid4

import aiomqtt

sys.path.insert(0, ".")
from app.config import settings  # noqa: E402
from app.flow.engine import Engine  # noqa: E402
from app.flow.transport import MqttRpcTransport  # noqa: E402
from app.flow.publish_flow import run_publish, reset_to_clean  # noqa: E402

RUN_DIR = os.environ.get("GC_RUN_DIR") or os.path.join("shots", f"real_{int(time.time())}")
os.makedirs(RUN_DIR, exist_ok=True)
os.environ["GC_PUBLISH_EXPLORE_DIR"] = RUN_DIR  # step_publish 捕获模式


def sink(name: str, data: bytes) -> str:
    path = os.path.join(RUN_DIR, f"{int(time.time())}_{name}.png")
    with open(path, "wb") as f:
        f.write(data)
    print(f"[shot] {path}", flush=True)
    return path


def dump_json(e: Engine, name: str):
    try:
        nodes = e.dump_nodes()
        path = os.path.join(RUN_DIR, f"{int(time.time())}_{name}_nodes.json")
        with open(path, "w") as f:
            json.dump(nodes, f, ensure_ascii=False, indent=1)
        print(f"[nodes] {path} ({len(nodes)} nodes)", flush=True)
    except Exception as ex:
        print(f"[nodes] {name} 失败: {ex}", flush=True)


class ProbeBridge:
    """同 publish_dryrun.ProbeBridge,独立 clientId 免与常驻 gc-backend 桥抢会话。"""

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
                    identifier="gc-backend-realpub",
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


def explore_aftermath(t: MqttRpcTransport):
    """发布后的探察(只读式:进列表/详情看一眼就退,不点任何会改状态的东西)。"""
    from app.flow.delist_flow import step_open_my_listings
    e = Engine(t, shot_sink=sink)
    try:
        step_open_my_listings(e, {})
        e.save_shot("aftermath_mylist")
        dump_json(e, "aftermath_mylist")
        # 点进第一条(刚发的)看详情页长相;锚点按显示器/价格找,找不到就点列表首行位置
        hit = e.find_any(["AOC", "显示器", "460"], timeout=6)
        if hit:
            e.tap_xy(*hit[1]["center"], settle=2.5)
        else:
            e.tap_xy(e.width // 2, int(e.height * 0.30), settle=2.5)
        e.save_shot("aftermath_detail")
        dump_json(e, "aftermath_detail")
        # 详情页里找「分享」入口位置(只记录,不点)
        share = e.find_any(["分享", "更多"], timeout=3)
        print(f"[aftermath] 详情页分享入口: {share}", flush=True)
        e.t.key("BACK")
        time.sleep(1.2)
        e.save_shot("aftermath_back_list")
        dump_json(e, "aftermath_back_list")
    except Exception as ex:
        print(f"[aftermath] 探察异常: {ex}", flush=True)
        try:
            e.save_shot("aftermath_error")
        except Exception:
            pass
    finally:
        reset_to_clean(e)


async def main():
    device_id = sys.argv[1]
    images = sys.argv[2:]
    if not images:
        print("需至少一张 sku/product/ 前缀的 OSS 签名图 URL", flush=True)
        sys.exit(2)
    spec = {
        "images": images,
        "description": "",
        "ai_rewrite": True,
        "price": 460,
        "shipping": {"mode": "fixed_fee", "fixed_fee": 12, "self_pickup": True},
        "location": None,
        "worry_free_sell": True,
        "confirm_publish": True,   # ★★ 真发(老板 2026-07-14 授权一条)
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
    result = await asyncio.to_thread(run_publish, t, spec, sink)
    print("RESULT:", result, flush=True)

    # 无论成败都探察一遍(失败也可能其实发出去了=UNCERTAIN,列表见真章)
    await asyncio.to_thread(explore_aftermath, t)

    await bridge.stop()
    print("RUN_DIR:", RUN_DIR, flush=True)


if __name__ == "__main__":
    asyncio.run(main())

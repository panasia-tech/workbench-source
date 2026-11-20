"""邮费键盘实验②:带时长的手势(触摸滤波旁路测试)。
前置:发货方式面板 + 固定邮费选中 + 键盘弹起(同 kp_probe)。
"""

import asyncio
import base64
import json
import sys
import time
from uuid import uuid4

import aiomqtt

sys.path.insert(0, ".")
from app.config import settings  # noqa: E402

DEV = "4d7c382f537f4d78b12b72911676bb6a"


async def main():
    pending = {}

    async with aiomqtt.Client(
        hostname=settings.mqtt_host, port=settings.mqtt_port,
        username=settings.mqtt_backend_username, password=settings.mqtt_backend_password,
        identifier="gc-kp-probe2",
    ) as client:
        await client.subscribe(f"gc/{DEV}/rpc_resp", qos=1)

        async def reader():
            async for m in client.messages:
                try:
                    d = json.loads(m.payload)
                except Exception:
                    continue
                f = pending.get(d.get("req_id"))
                if f and not f.done():
                    f.set_result(d)

        rt = asyncio.create_task(reader())
        await asyncio.sleep(1.0)

        async def rpc(op, args=None, timeout=15.0):
            req = uuid4().hex
            fut = asyncio.get_running_loop().create_future()
            pending[req] = fut
            await client.publish(f"gc/{DEV}/rpc", json.dumps({"req_id": req, "op": op, "args": args or {}}), qos=1)
            try:
                return await asyncio.wait_for(fut, timeout)
            except asyncio.TimeoutError:
                return {"ok": False, "err": "TIMEOUT"}
            finally:
                pending.pop(req, None)

        async def shot(name):
            r = await rpc("screencap")
            d = r.get("data") or {}
            b64 = d.get("image_b64", "")
            if b64:
                p = f"/tmp/kq_{name}.png"
                with open(p, "wb") as f:
                    f.write(base64.b64decode(b64))
                print(f"[shot] {p}", flush=True)
            else:
                print(f"[shot] {name} FAILED {r.get('err')}", flush=True)

        r = await rpc("dump_nodes")
        nodes = (r.get("data") or {}).get("nodes") or []
        d1 = next((n for n in nodes if n.get("desc") == "1"), None)
        d2 = next((n for n in nodes if n.get("desc") == "2"), None)
        d3 = next((n for n in nodes if n.get("desc") == "3"), None)
        print("digits:", d1, d2, d3, flush=True)

        # A. tap 带 100ms 时长
        if d1:
            r = await rpc("tap", {"x": d1["cx"], "y": d1["cy"], "duration_ms": 100})
            print("[tap 1 dur100]", r.get("ok"), r.get("err"), flush=True)
            time.sleep(1.0)
            await shot("a_tap_dur100")

        # B. tap 带 300ms 时长
        if d2:
            r = await rpc("tap", {"x": d2["cx"], "y": d2["cy"], "duration_ms": 300})
            print("[tap 2 dur300]", r.get("ok"), r.get("err"), flush=True)
            time.sleep(1.0)
            await shot("b_tap_dur300")

        # C. 数字 3 上做小位移 swipe(150ms, 6px)
        if d3:
            r = await rpc("swipe", {"x1": d3["cx"], "y1": d3["cy"], "x2": d3["cx"] + 6, "y2": d3["cy"], "duration_ms": 150})
            print("[swipe 3 tiny]", r.get("ok"), r.get("err"), flush=True)
            time.sleep(1.0)
            await shot("c_swipe_tiny")

        rt.cancel()


if __name__ == "__main__":
    asyncio.run(main())

"""邮费键盘原语实验探针(一次性):验证 闲鱼7.25.80 发货面板数字键盘各原语的真实效果。

前置:手机上闲鱼已处于「发货方式面板 + 固定邮费选中 + 数字键盘弹起」状态(草稿恢复)。
每步:执行一个原语 → 截图存 /tmp/kp_*.png → 人工比对邮费框内容。
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
OUT = "/tmp"


async def main():
    pending = {}

    async with aiomqtt.Client(
        hostname=settings.mqtt_host, port=settings.mqtt_port,
        username=settings.mqtt_backend_username, password=settings.mqtt_backend_password,
        identifier="gc-kp-probe",
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
                p = f"{OUT}/kp_{name}.png"
                with open(p, "wb") as f:
                    f.write(base64.b64decode(b64))
                print(f"[shot] {p} bytes={d.get('bytes')}", flush=True)
            else:
                print(f"[shot] {name} FAILED: {r.get('err')}", flush=True)

        # 0. 初始状态
        await shot("0_initial")

        # 1. dump_nodes:看数字键节点的 clickable 与坐标
        r = await rpc("dump_nodes")
        nodes = (r.get("data") or {}).get("nodes") or []
        print(f"[nodes] total={len(nodes)}", flush=True)
        for n in nodes:
            if n.get("desc") in ("1", "2", "3", "确定", "删除", "收起键盘"):
                print("  KEY:", json.dumps(n, ensure_ascii=False), flush=True)
        digit2 = next((n for n in nodes if n.get("desc") == "2"), None)

        # 2. node_click("1") → 邮费框应变 ¥1
        r = await rpc("node_click", {"desc": "1"})
        print("[node_click 1]", r.get("ok"), r.get("err"), flush=True)
        time.sleep(1.0)
        await shot("1_nodeclick_1")

        # 3. tap(dispatchGesture) 点数字 2 的中心 → 邮费框若变 ¥12 说明合成触摸有效
        if digit2:
            r = await rpc("tap", {"x": digit2["cx"], "y": digit2["cy"]})
            print(f"[tap 2 @({digit2['cx']},{digit2['cy']})]", r.get("ok"), r.get("err"), flush=True)
            time.sleep(1.0)
            await shot("2_dispatch_tap_2")

        # 4. set_text("12") → 邮费框若变 ¥12 说明字段是原生可写
        r = await rpc("set_text", {"text": "12"})
        print("[set_text 12]", r.get("ok"), r.get("err"), flush=True)
        time.sleep(1.0)
        await shot("3_set_text")

        # 5. node_click("确定") → 键盘应收
        r = await rpc("node_click", {"desc": "确定"})
        print("[node_click 确定]", r.get("ok"), r.get("err"), flush=True)
        time.sleep(1.2)
        await shot("4_nodeclick_confirm")

        rt.cancel()


if __name__ == "__main__":
    asyncio.run(main())

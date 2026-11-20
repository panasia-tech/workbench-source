"""邮费键盘修复验证探针③:重建发货面板 → 新版 set_text(全窗口) 写邮费 → 截图验证。

流程:launch 闲鱼 → 卖闲置 → 发闲置 → (有草稿框则放弃) → 滚到「发货方式」→ 点开
→ 点「不包邮-固定邮费」(键盘弹起) → set_text("12") → 截图看邮费框。
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

DEV = "48fa1317a8f143399ad7e8d24835197d"


async def main():
    pending = {}

    async with aiomqtt.Client(
        hostname=settings.mqtt_host, port=settings.mqtt_port,
        username=settings.mqtt_backend_username, password=settings.mqtt_backend_password,
        identifier="gc-kp-probe3",
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

        async def rpc(op, args=None, timeout=20.0):
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
                p = f"/tmp/kr_{name}.png"
                with open(p, "wb") as f:
                    f.write(base64.b64decode(b64))
                print(f"[shot] {p}", flush=True)
            else:
                print(f"[shot] {name} FAILED {r.get('err')}", flush=True)

        async def nodes():
            r = await rpc("dump_nodes")
            return (r.get("data") or {}).get("nodes") or []

        # 1. 拉起闲鱼
        print("[launch]", (await rpc("launch_app", {"pkg": "com.taobao.idlefish"})).get("ok"), flush=True)
        time.sleep(5)
        await shot("1_launched")

        # 2. 找「卖闲置」tab 点它(底部中央)
        ns = await nodes()
        sell = next((n for n in ns if "卖闲置" in (n.get("desc") or "")), None)
        if sell:
            print("[tap 卖闲置]", (await rpc("tap", {"x": sell["cx"], "y": sell["cy"]})).get("ok"), flush=True)
            time.sleep(2.5)
        else:
            print("[warn] 没找到卖闲置,先看图", flush=True)
        await shot("2_sell_panel")

        # 3. 点「发闲置」
        ns = await nodes()
        fa = next((n for n in ns if "发闲置" in (n.get("desc") or "") or "发闲置" in (n.get("cls") or "")), None)
        if not fa:
            # 文字节点未必有 desc,用 tap 面板左上区域(发闲置在面板第一个)
            fa = None
            print("[warn] 发闲置节点未找到,按坐标点(250,1320)", flush=True)
            await rpc("tap", {"x": 250, "y": 1320})
        else:
            await rpc("tap", {"x": fa["cx"], "y": fa["cy"]})
        time.sleep(3)
        await shot("3_editor")

        # 4. 草稿弹框?有「放弃/不保存」则点
        ns = await nodes()
        abandon = next((n for n in ns if n.get("desc") in ("放弃", "不保存", "重新发布")), None)
        if abandon:
            print("[草稿] 放弃", flush=True)
            await rpc("tap", {"x": abandon["cx"], "y": abandon["cy"]})
            time.sleep(2)

        # 5. 下滑两次找「发货方式」并点开
        for _ in range(3):
            ns = await nodes()
            ship = next((n for n in ns if "发货方式" in (n.get("desc") or "")), None)
            if ship:
                print("[tap 发货方式]", flush=True)
                await rpc("tap", {"x": ship["cx"], "y": ship["cy"]})
                break
            await rpc("swipe", {"x1": 540, "y1": 1900, "x2": 540, "y2": 1200, "duration_ms": 300})
            time.sleep(1.2)
        time.sleep(2.5)
        await shot("4_ship_panel")

        # 6. 点「不包邮-固定邮费」
        ns = await nodes()
        anc = next((n for n in ns if "固定邮费" in (n.get("desc") or "")), None)
        if anc:
            await rpc("tap", {"x": anc["cx"], "y": anc["cy"]})
            print("[tap 固定邮费] ok", flush=True)
        else:
            print("[warn] 固定邮费锚点未找到", flush=True)
        time.sleep(2)
        await shot("5_fee_focused")

        # 7. ★ 新版 set_text("12") —— 全窗口查找可编辑节点
        r = await rpc("set_text", {"text": "12"})
        print("[set_text 12]", r.get("ok"), r.get("err"), flush=True)
        time.sleep(1.5)
        await shot("6_after_set_text")

        rt.cancel()


if __name__ == "__main__":
    asyncio.run(main())

"""真机原语 RPC 探针:以后端超级用户身份连 EMQX,对指定设备逐个下发原语,打印结果。

用途:V2「手」(PrimitiveExecutor)真机端到端验收。等价于流程引擎会发的 bridge.rpc(),
但独立于调度器,便于单独观察每个原语的 ok/err/data。

用法:
  .venv/bin/python scripts/rpc_probe.py <device_id> [op ...]
  不带 op 时跑一套默认冒烟序列。
"""

import asyncio
import base64
import json
import sys
from uuid import uuid4

import aiomqtt

sys.path.insert(0, ".")
from app.config import settings  # noqa: E402

SHOT_DIR = "/Users/boxinhui/.claude/tmp/claude-501/-Users-boxinhui-Desktop-------erp---/9230d8f2-57c6-444d-b759-164f7fb913e4/scratchpad"


async def rpc(client, pending, device_id, op, args=None, timeout=15.0):
    req_id = uuid4().hex
    fut = asyncio.get_running_loop().create_future()
    pending[req_id] = fut
    frame = {"req_id": req_id, "op": op, "args": args or {}}
    await client.publish(f"gc/{device_id}/rpc", json.dumps(frame), qos=1)
    try:
        resp = await asyncio.wait_for(fut, timeout=timeout)
    except asyncio.TimeoutError:
        return {"ok": False, "err": f"TIMEOUT {timeout}s"}
    finally:
        pending.pop(req_id, None)
    return resp


def brief(op, resp):
    ok = resp.get("ok")
    data = resp.get("data") or {}
    if not ok:
        return f"❌ {op:12} err={resp.get('err')}"
    if op == "screencap":
        b64 = data.get("image_b64", "")
        raw = base64.b64decode(b64) if b64 else b""
        path = f"{SHOT_DIR}/rpc_screencap.jpg"
        with open(path, "wb") as f:
            f.write(raw)
        return f"✅ {op:12} bytes={data.get('bytes')} saved={path}"
    if op == "dump_nodes":
        nodes = data.get("nodes") or []
        sample = [n.get("desc") or n.get("cls") for n in nodes[:5]]
        return f"✅ {op:12} nodes={len(nodes)} sample={sample}"
    return f"✅ {op:12} data={json.dumps(data, ensure_ascii=False)[:120]}"


async def main():
    if len(sys.argv) < 2:
        print("用法: rpc_probe.py <device_id> [op ...]")
        return
    device_id = sys.argv[1]
    ops = sys.argv[2:]
    pending: dict = {}

    async with aiomqtt.Client(
        hostname=settings.mqtt_host,
        port=settings.mqtt_port,
        username=settings.mqtt_backend_username,
        password=settings.mqtt_backend_password,
        identifier="gc-rpc-probe",
    ) as client:
        await client.subscribe(f"gc/{device_id}/rpc_resp", qos=1)

        async def reader():
            async for m in client.messages:
                try:
                    d = json.loads(m.payload)
                except Exception:
                    continue
                rid = d.get("req_id")
                fut = pending.get(rid)
                if fut and not fut.done():
                    fut.set_result(d)

        reader_task = asyncio.create_task(reader())
        await asyncio.sleep(0.5)

        # 先 WAKEUP,避免息屏截图全黑
        await rpc(client, pending, device_id, "key", {"code": "WAKEUP"})
        await asyncio.sleep(0.6)

        if ops:
            seq = [(op, {}) for op in ops]
        else:
            # 默认冒烟:不含破坏性操作(不点发布);tap/swipe 用屏幕中部安全坐标
            sz = await rpc(client, pending, device_id, "screen_size")
            w = (sz.get("data") or {}).get("w", 1080)
            h = (sz.get("data") or {}).get("h", 2400)
            print(brief("screen_size", sz))
            seq = [
                ("screencap", {"quality": 60}),
                ("dump_nodes", {}),
                ("tap", {"x": w // 2, "y": h // 2}),
                ("swipe", {"x1": w // 2, "y1": int(h * 0.6), "x2": w // 2, "y2": int(h * 0.4), "ms": 400}),
                ("key", {"code": "BACK"}),
            ]

        for op, args in seq:
            resp = await rpc(client, pending, device_id, op, args)
            print(brief(op, resp))
            await asyncio.sleep(0.8)

        reader_task.cancel()


if __name__ == "__main__":
    asyncio.run(main())

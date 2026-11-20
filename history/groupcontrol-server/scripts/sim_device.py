"""设备模拟器：无真机时验证链路。

用法：
  python scripts/sim_device.py <device_id> <token> [host] [port]

行为：连 EMQX → retained 发 online →
- 订 gc/{id}/cmd:收控制类指令回 run→end（set_phone_info 带机型）。
- 订 gc/{id}/rpc:收原语请求回 rpc_resp,用桩数据打通 RPC 往返(req_id 关联/超时)。
  注意:screencap 只回 1x1 占位图,真实流程 OCR 需真机;本模拟器只验通信管道。
"""

import asyncio
import base64
import json
import sys
import time

import aiomqtt

# 1x1 透明 PNG(占位,验管道用)
_TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMCAWXPMS9lAAAAAElFTkSuQmCC"
)


def _rpc_stub(op: str, args: dict) -> dict:
    """给每个原语返回桩数据。真机由 PrimitiveExecutor 实现。"""
    if op == "screencap":
        return {"image_b64": base64.b64encode(_TINY_PNG).decode(), "bytes": len(_TINY_PNG)}
    if op == "dump_nodes":
        return {"nodes": []}
    if op == "screen_size":
        return {"w": 1080, "h": 2400}
    # tap/swipe/key/set_text/launch_app/force_stop/push_media 无返回数据
    return {}


async def main():
    device_id = sys.argv[1]
    token = sys.argv[2]
    host = sys.argv[3] if len(sys.argv) > 3 else "127.0.0.1"
    port = int(sys.argv[4]) if len(sys.argv) > 4 else 1883

    will = aiomqtt.Will(
        topic=f"gc/{device_id}/status",
        payload=json.dumps({"online": False}),
        qos=1,
        retain=True,
    )
    async with aiomqtt.Client(
        hostname=host, port=port, username=device_id, password=token,
        identifier=device_id, will=will,
    ) as client:
        await client.publish(
            f"gc/{device_id}/status",
            json.dumps({"online": True, "app_version": "sim-1.0"}),
            qos=1, retain=True,
        )
        await client.subscribe(f"gc/{device_id}/cmd", qos=1)
        await client.subscribe(f"gc/{device_id}/rpc", qos=1)
        await client.subscribe("gc/broadcast/cmd", qos=1)
        print(f"[sim] {device_id} 已上线，等待指令/原语…")
        async for msg in client.messages:
            topic = str(msg.topic)
            payload = json.loads(msg.payload)

            if topic.endswith("/rpc"):
                op = payload.get("op")
                req_id = payload.get("req_id")
                print(f"[sim] 收到原语 {op} req={req_id}")
                await client.publish(
                    f"gc/{device_id}/rpc_resp",
                    json.dumps({"req_id": req_id, "ok": True,
                                "data": _rpc_stub(op, payload.get("args") or {}),
                                "ts": int(time.time())}),
                    qos=1,
                )
                continue

            # 控制类 cmd
            task_id = payload.get("task_id")
            ttype = payload.get("task_type")
            print(f"[sim] 收到指令 {ttype} task={task_id}")
            await client.publish(f"gc/{device_id}/report",
                                 json.dumps({"task_id": task_id, "status": "run", "ts": int(time.time())}), qos=1)
            await asyncio.sleep(0.3)
            result = {"brand": "SIM", "model": "Pixel-Sim", "android": "14"} if ttype == "set_phone_info" else None
            await client.publish(f"gc/{device_id}/report",
                                 json.dumps({"task_id": task_id, "status": "end",
                                             "mark": "模拟执行完成", "result": result,
                                             "ts": int(time.time())}), qos=1)
            print(f"[sim] 已回传 end task={task_id}")


if __name__ == "__main__":
    asyncio.run(main())

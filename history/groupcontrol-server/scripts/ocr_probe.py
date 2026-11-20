"""OCR 探针:对当前手机屏幕做一次 screencap+服务端 OCR,打印全部识别项。
用法: venv/bin/python scripts/ocr_probe.py
"""
import asyncio
import base64
import json
import sys
from uuid import uuid4

import aiomqtt

sys.path.insert(0, ".")
from app.config import settings  # noqa: E402
from app.flow import ocr as O  # noqa: E402

DEV = "48fa1317a8f143399ad7e8d24835197d"


async def main():
    pending = {}

    async with aiomqtt.Client(
        hostname=settings.mqtt_host, port=settings.mqtt_port,
        username=settings.mqtt_backend_username, password=settings.mqtt_backend_password,
        identifier="gc-ocr-probe",
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
        req = uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        pending[req] = fut
        await client.publish(f"gc/{DEV}/rpc", json.dumps({"req_id": req, "op": "screencap", "args": {}}), qos=1)
        resp = await asyncio.wait_for(fut, 25)
        data = (resp.get("data") or {})
        raw = base64.b64decode(data.get("image_b64", ""))
        open("/tmp/ocr_probe.png", "wb").write(raw)
        items = O.ocr(raw)
        print(f"items: {len(items)}")
        for it in items:
            print(f"  ({it['center'][0]:4},{it['center'][1]:4}) {it['score']:.2f} {it['text']}")
        rt.cancel()


if __name__ == "__main__":
    asyncio.run(main())

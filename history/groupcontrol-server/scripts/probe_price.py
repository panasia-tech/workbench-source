"""定点探针:开到编辑页→打开定价面板→点推荐价数字→键盘输 460→读回价格行验证。
用法:.venv/bin/python scripts/probe_price.py <device_id> <image_url>
"""
import asyncio
import os
import re
import sys
import time

sys.path.insert(0, ".")
from app.flow.engine import Engine  # noqa: E402
from app.flow.transport import MqttRpcTransport  # noqa: E402
from app.flow import publish_flow as PF  # noqa: E402
from scripts.publish_real import ProbeBridge  # noqa: E402

OUT = os.environ.get("GC_RUN_DIR", "./shots/probe_price")
os.makedirs(OUT, exist_ok=True)
NUM_RE = re.compile(r"^[¥￥]?\s*\d[\d,]*(\.\d+)?$")


def sink(name, data):
    p = os.path.join(OUT, f"{int(time.time())}_{name}.png")
    open(p, "wb").write(data)
    print("[shot]", p, flush=True)
    return p


async def main():
    device_id, url = sys.argv[1], sys.argv[2]
    spec = {"images": [url], "description": "", "ai_rewrite": True}
    bridge = ProbeBridge()
    await bridge.start()
    for _ in range(30):
        if bridge.connected:
            break
        await asyncio.sleep(0.3)
    loop = asyncio.get_running_loop()
    t = MqttRpcTransport(bridge, device_id, loop, rpc_timeout=15)

    def work():
        e = Engine(t, shot_sink=sink)
        PF.step_open_editor(e, spec)
        PF.step_images(e, spec)
        PF.step_ai_rewrite(e, spec)
        PF._dismiss_ime(e)
        PF.step_price(e, {"price": 460})
        sink("after_price", e.screencap())
        row = PF._find_price_value(e)
        print("[verify] 价格行 =", row, flush=True)
        PF._leave_editor_to_home(e)

    await asyncio.to_thread(work)
    await bridge.stop()
    print("OUT:", OUT, flush=True)


if __name__ == "__main__":
    asyncio.run(main())

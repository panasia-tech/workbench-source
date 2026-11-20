"""验证 wait_new_tab / activate_tab / current_url 三个新 op。

模拟 goods_flows_web 的真实序列：goto /personal → dump 找在售卡片 → tap 卡片上部
（点开详情页新 tab）→ wait_new_tab(contains="/item") → current_url 校验 id= →
screencap 存证 → activate_tab(contains="/im") 切回原 tab → close 测试 tab。
"""
from __future__ import annotations

import base64
import json
import time
from pathlib import Path

import paho.mqtt.client as mqtt

device_id = json.loads(Path("device_identity.json").read_text(encoding="utf-8"))["device_id"]
RESP: dict[str, dict] = {}
LOGS: list[str] = []


def rpc(client, op: str, args: dict | None = None, wait: float = 40.0) -> dict:
    req_id = f"nt{int(time.time() * 1000)}"
    client.publish(f"gc/{device_id}/rpc",
                   payload=json.dumps({"req_id": req_id, "op": op, "args": args or {}}), qos=1)
    deadline = time.time() + wait
    while req_id not in RESP and time.time() < deadline:
        time.sleep(0.1)
    if req_id not in RESP:
        raise TimeoutError(f"{op} 超时")
    r = RESP.pop(req_id)
    if not r.get("ok"):
        raise RuntimeError(f"{op} 失败: {r.get('err')}")
    return r.get("data") or {}


client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                     client_id=f"newtab-test-{time.time()}", protocol=mqtt.MQTTv5)


def on_connect(c, u, f, rc, p):
    c.subscribe(f"gc/{device_id}/rpc_resp", qos=1)


def on_message(c, u, msg):
    r = json.loads(msg.payload)
    if r.get("req_id"):
        RESP[r["req_id"]] = r


client.on_connect = on_connect
client.on_message = on_message
client.connect("127.0.0.1", 1883)
client.loop_start()
time.sleep(1)

try:
    rpc(client, "launch_app", {"pkg": "https://www.goofish.com/personal"})
    time.sleep(8)
    print("current_url:", rpc(client, "current_url"))

    nodes = rpc(client, "dump_nodes")["nodes"]
    card = next(n for n in nodes if "cardWarp--" in (n.get("cls") or ""))
    print(f"card: center={card['center']} size={card['size']}")
    tap_x = card["center"][0]
    tap_y = card["center"][1] - card["size"][1] // 2 + 120  # 对齐 goods_flows_web：点图片区
    print(f"tap card @({tap_x},{tap_y})")
    rpc(client, "tap", {"x": tap_x, "y": tap_y})

    data = rpc(client, "wait_new_tab", {"contains": "/item", "timeout": 20})
    print("wait_new_tab ->", data)
    url = rpc(client, "current_url")["url"]
    print("current_url  ->", url)
    assert "id=" in url, "新 tab URL 未出现 id= 参数"

    shot = rpc(client, "screencap")["image_b64"]
    out = Path("scripts/shots")
    out.mkdir(parents=True, exist_ok=True)
    p = out / f"new_tab_item_{int(time.time())}.jpg"
    p.write_bytes(base64.b64decode(shot))
    print(f"screencap -> {p} ({len(shot) * 3 // 4} bytes b64)")

    # 切回 /personal 原 tab（executor 原 tab 此刻在 /personal），再切回 item tab
    back = rpc(client, "activate_tab", {"contains": "/personal"})
    print("activate_tab /personal ->", back)
    again = rpc(client, "activate_tab", {"contains": "/item"})
    print("activate_tab /item ->", again)

    # 关测试产生的 item tab，回 /personal，保持环境干净
    closed = rpc(client, "activate_tab", {"contains": "/personal"})
    print("activate_tab /personal ->", closed)
    print("close_tab /item ->", rpc(client, "close_tab", {"contains": "/item"}))
    print("current_url:", rpc(client, "current_url"))
    print("VERIFIED: wait_new_tab/activate_tab/current_url/close_tab 全部工作")
finally:
    client.loop_stop()

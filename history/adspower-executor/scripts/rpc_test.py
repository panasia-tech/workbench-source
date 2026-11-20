"""MQTT 原语 RPC 联调测试：向浏览器执行端发 op，订阅 rpc_resp 打印摘要。

用法：
    .venv/bin/python scripts/rpc_test.py <op> [key=value ...]

示例：
    .venv/bin/python scripts/rpc_test.py screencap
    .venv/bin/python scripts/rpc_test.py dump_nodes
    .venv/bin/python scripts/rpc_test.py screen_size
    .venv/bin/python scripts/rpc_test.py node_click desc=首页
    .venv/bin/python scripts/rpc_test.py self_check
    .venv/bin/python scripts/rpc_test.py key key=HOME
    .venv/bin/python scripts/rpc_test.py launch_app pkg=https://www.goofish.com/im

device_id 从 device_identity.json 读（main.py 首次启动后生成）。
"""

from __future__ import annotations

import base64
import json
import sys
import time
from pathlib import Path

import paho.mqtt.client as mqtt

BROKER = "127.0.0.1"
PORT = 1883


def parse_args(argv: list[str]) -> dict:
    args: dict = {}
    for item in argv:
        if "=" not in item:
            print(f"忽略无 = 的参数: {item}")
            continue
        k, v = item.split("=", 1)
        # 简单类型推断：整数/纯数字转 int
        if v.isdigit():
            v = int(v)  # type: ignore[assignment]
        args[k] = v
    return args


def summarize(op: str, resp: dict) -> str:
    if not resp.get("ok"):
        return f"FAIL err={resp.get('err')}"
    data = resp.get("data") or {}
    if op == "screencap":
        raw = base64.b64decode(data["image_b64"])
        out = Path("scripts/shots")
        out.mkdir(parents=True, exist_ok=True)
        p = out / f"rpc_screencap_{int(time.time())}.jpg"
        p.write_bytes(raw)
        return f"ok image {len(raw)} bytes -> {p}"
    if op == "dump_nodes":
        nodes = data.get("nodes", [])
        lines = [f"ok count={data.get('count')}"]
        conv = [n for n in nodes if "conversation-item--" in (n.get("cls") or "")]
        badge = [n for n in nodes if "ant-badge" in (n.get("cls") or "")]
        links = [n for n in nodes if isinstance(n.get("desc"), str) and n["desc"].startswith(("http", "/"))]
        lines.append(f"  会话项={len(conv)} 未读角标={len(badge)} a链接={len(links)}")
        for n in conv[:5]:
            lines.append(f"  conv: desc={n['desc']!r} center={n['center']}")
        for n in badge[:5]:
            lines.append(f"  badge: desc={n['desc']!r} center={n['center']}")
        for n in links[:5]:
            lines.append(f"  link: {n['desc']!r}")
        return "\n".join(lines)
    return f"ok {json.dumps(data, ensure_ascii=False)[:500]}"


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    op = sys.argv[1]
    args = parse_args(sys.argv[2:])

    ident = json.loads(Path("device_identity.json").read_text(encoding="utf-8"))
    device_id = ident["device_id"]
    req_id = f"t{int(time.time() * 1000)}"

    done = False

    def on_connect(client, userdata, flags, reason_code, properties):
        client.subscribe(f"gc/{device_id}/rpc_resp", qos=1)
        client.subscribe(f"gc/{device_id}/log", qos=1)
        client.publish(f"gc/{device_id}/rpc",
                       payload=json.dumps({"req_id": req_id, "op": op, "args": args}),
                       qos=1)
        print(f">> gc/{device_id}/rpc req_id={req_id} op={op} args={args}")

    def on_message(client, userdata, msg):
        nonlocal done
        if msg.topic.endswith("/log"):
            print(f"[device log] {msg.payload.decode()[:300]}")
            return
        resp = json.loads(msg.payload)
        if resp.get("req_id") != req_id:
            return
        done = True
        print(f"<< rpc_resp: {summarize(op, resp)}")

    client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
                         client_id=f"rpc-test-{int(time.time())}",
                         protocol=mqtt.MQTTv5)
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(BROKER, PORT)
    client.loop_start()

    deadline = time.time() + 30
    while not done and time.time() < deadline:
        time.sleep(0.2)
    client.loop_stop()
    if not done:
        print("TIMEOUT: 30s 内没收到 rpc_resp")
        sys.exit(2)


if __name__ == "__main__":
    main()

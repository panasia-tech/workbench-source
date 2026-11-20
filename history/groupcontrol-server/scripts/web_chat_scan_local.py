"""网页版 chat_scan 本地联调:LocalPlaywrightTransport 直连 AdsPower 浏览器跑 run_read_chats_web。

用法(用 adspower-executor 的 venv,里面有 playwright):
  ./demo scripts/web_chat_scan_local.py [max_convs]

只读不操作:读消息会把闲鱼侧未读「已读化」(与手机版同),但不会点任何按钮。
"""
import json
import sys
import time

sys.path.insert(0, ".")
from app.flow.web.local_transport import LocalPlaywrightTransport  # noqa: E402
from app.flow.web.read_chats_web import run_read_chats_web  # noqa: E402


def main():
    max_convs = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    t = LocalPlaywrightTransport()
    try:
        started = time.time()
        result = run_read_chats_web(t, {"max_convs": max_convs})
    finally:
        t.close()

    convs = result.get("conversations", [])
    msgs = result.get("messages", {})
    summary = {
        "ok": result.get("ok"),
        "done": result.get("done"),
        "failed_step": result.get("failed_step"),
        "reason": result.get("reason"),
        "risk": result.get("risk"),
        "login": result.get("login"),
        "elapsed_sec": round(time.time() - started, 1),
        "n_conversations": len(convs),
        "n_messages": sum(len(v) for v in msgs.values()),
        "conversations": [
            {
                "peer_key": c.get("peer_key"),
                "peer_nick": c.get("peer_nick"),
                "unread": c.get("unread"),
                "order_status": c.get("order_status"),
                "item_title": c.get("item_title"),
                "last_message": c.get("last_message"),
                "n_messages": len(msgs.get(c.get("peer_key"), [])),
                "messages_sample": msgs.get(c.get("peer_key"), [])[:4],
            }
            for c in convs
        ],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

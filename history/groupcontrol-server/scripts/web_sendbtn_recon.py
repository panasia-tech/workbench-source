"""网页版聊天发送按钮侦察(M5):进目标会话 → dump 输入区节点 → set_text 填入文本 → 再 dump 看发送按钮结构。

用法(用 adspower-executor 的 venv):
  ./demo scripts/web_sendbtn_recon.py [peer_key]

不点发送(只 dry 填文本,侦察完清空输入框)。截图存 shots/。
"""
import json
import os
import sys
import time

sys.path.insert(0, ".")
from app.flow.web.local_transport import LocalPlaywrightTransport  # noqa: E402
from app.flow.web.parse import CLS_TEXTAREA, parse_chat_page_web, parse_conversation_list_web  # noqa: E402

PROBE_TEXT = "侦察测试文本待清空"


def flat(nodes):
    out = []
    for n in nodes:
        c = n.get("center") or (0, 0)
        s = n.get("size") or (0, 0)
        out.append({"desc": n.get("desc", ""), "cls": n.get("cls", ""),
                    "clickable": bool(n.get("clickable")),
                    "cx": int(c[0]), "cy": int(c[1]), "w": int(s[0]), "h": int(s[1])})
    return out


def dump_bottom(nodes, h, tag):
    print(f"\n===== {tag}(cy > {int(h*0.72)} 的节点)=====")
    for n in sorted(nodes, key=lambda n: (n["cy"], n["cx"])):
        if n["cy"] <= h * 0.72:
            continue
        print(json.dumps({k: n[k] for k in ("desc", "cls", "clickable", "cx", "cy", "w", "h")},
                         ensure_ascii=False))


def main():
    peer_key = sys.argv[1] if len(sys.argv) > 1 else "811892395"
    t = LocalPlaywrightTransport()
    try:
        t.launch_app("https://www.goofish.com/im")
        time.sleep(4)
        w, h = t.screen_size()
        print(f"viewport {w}x{h}")
        nodes = flat(t.dump_nodes())
        rows = parse_conversation_list_web(nodes, w, h)
        print(f"会话列表 {len(rows)} 行:", [(r["nick"], r.get("last_message")) for r in rows[:10]])

        entered = False
        for row in rows[:20]:
            t.tap(row["row_cx"], row["row_cy"])
            time.sleep(2.5)
            page = parse_chat_page_web(flat(t.dump_nodes()), w, h)
            print(f"  进 {row['nick']!r} → peer_key={page.get('peer_key')} peer_nick={page.get('peer_nick')}")
            if page.get("peer_key") == peer_key:
                entered = True
                break
            time.sleep(1.5)
        if not entered:
            print("未找到目标会话")
            return

        nodes = flat(t.dump_nodes())
        with open("shots/recon_sendbtn_empty.json", "w") as f:
            json.dump(nodes, f, ensure_ascii=False, indent=1)
        dump_bottom(nodes, h, "输入前")

        tas = [n for n in nodes if any(k in n["cls"] for k in CLS_TEXTAREA)]
        print("\ntextarea 节点:", json.dumps(tas, ensure_ascii=False))
        if tas:
            t.tap(tas[0]["cx"], tas[0]["cy"])
            time.sleep(1.5)
            t.set_text(PROBE_TEXT)
            time.sleep(1.5)
            nodes2 = flat(t.dump_nodes())
            with open("shots/recon_sendbtn_filled.json", "w") as f:
                json.dump(nodes2, f, ensure_ascii=False, indent=1)
            dump_bottom(nodes2, h, f"填入「{PROBE_TEXT}」后")

            # 清空输入框,不留下脏数据
            t.set_text("")
            time.sleep(0.8)
            print("\n已清空输入框(未点发送)")

        os.makedirs("shots", exist_ok=True)
        with open("shots/recon_sendbtn.png", "wb") as f:
            f.write(t.screencap())
        print("\n截图: shots/recon_sendbtn.png")
    finally:
        t.close()


if __name__ == "__main__":
    main()

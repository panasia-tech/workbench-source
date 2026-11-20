"""收尾:清理我们开的孤儿 item tab + 终态校验(测试商品仍在售)。

只关 URL 含 spm=a21ybx.personal.feeds 的 tab(点个人中心卡片开的,必为我们所开);
用户自有 tab(gemini/kimi/chatgpt/publish/首页/im 等)一律不动。
"""
import asyncio
import json
import sys
import time

sys.path.insert(0, ".")
from app.flow.web.goods_flows_web import _flat, parse_goods_cards  # noqa: E402
from app.flow.web.local_transport import LocalPlaywrightTransport  # noqa: E402

OUT = "scripts/m3_recon_out"
OURS = "spm=a21ybx.personal.feeds"
CHECK_TITLES = [("松能 白色款", 99), ("顺睿吹风机", 9), ("高配台式主机", 1)]


def main():
    t = LocalPlaywrightTransport()
    try:
        async def list_tabs():
            out = []
            for p in t.page.context.pages:
                if p.is_closed():
                    continue
                out.append((p.url, await p.title()))
            return out

        tabs = t._submit(list_tabs())
        print(f"--- 现存 tab {len(tabs)} 个 ---", flush=True)
        ours = []
        for url, title in tabs:
            mark = "OURS" if OURS in url else "keep"
            print(f"  [{mark}] {title[:30]!r} {url[:90]}", flush=True)
            if OURS in url:
                ours.append(url)

        async def close_ours():
            ctx = t.page.context
            for p in ctx.pages:
                if p.is_closed():
                    continue
                if OURS in p.url:
                    await p.close()
        if ours:
            t._submit(close_ours())
            time.sleep(1)
            print(f"closed {len(ours)} orphan tabs", flush=True)
        else:
            print("无孤儿 tab", flush=True)

        # 终态校验:回 /personal,确认测试商品仍在售列表
        t.launch_app("https://www.goofish.com/personal")
        time.sleep(4)
        w, h = t.screen_size()
        seen = {}

        def collect():
            for c in parse_goods_cards(_flat(t.dump_nodes())):
                seen.setdefault((c["title"], c.get("price")), c)

        collect()
        for _ in range(8):
            before = len(seen)
            t.swipe(int(w * 0.6), int(h * 0.25), int(w * 0.6), int(h * 0.25) + 500)
            time.sleep(1.5)
            collect()
            if len(seen) == before:
                break

        print("--- 终态校验(应全部 True)---", flush=True)
        final = {}
        for key, price in CHECK_TITLES:
            hit = any(key[:8] in t_ and p == price for (t_, p) in seen)
            final[key] = hit
            print(f"  {key} ¥{price} 仍在售: {hit}", flush=True)
        with open(f"{OUT}/final_check.json", "w", encoding="utf-8") as f:
            json.dump({"cards_seen": len(seen), "checks": final,
                       "closed_orphans": len(ours)}, f, ensure_ascii=False, indent=1)
        with open(f"{OUT}/final_personal.jpg", "wb") as f:
            f.write(t.screencap())
        print("→ final_check.json / final_personal.jpg", flush=True)
    finally:
        t.close()


if __name__ == "__main__":
    main()

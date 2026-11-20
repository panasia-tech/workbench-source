"""侦察:①关闭电竞桌子下架弹窗 ②/personal 在售卡片全量+卡片内徽标文本 ③无忧卖标记特征。

目的:找一个非无忧卖的测试商品(无忧卖商品网页版下架被拦截,沙发/电竞桌子均中招)。
"""
import json
import sys
import time

sys.path.insert(0, ".")
from app.flow.web.goods_flows_web import _flat, parse_goods_cards  # noqa: E402
from app.flow.web.local_transport import LocalPlaywrightTransport  # noqa: E402

OUT = "scripts/m3_recon_out"
DESK_ID = "1082054456277"


def activate_tab(t, contains):
    import asyncio

    async def op():
        ctx = t.page.context
        for p in ctx.pages:
            if p.is_closed():
                continue
            if contains in p.url:
                t._page = p
                await p.bring_to_front()
                return p.url
        raise RuntimeError(f"no tab containing {contains}")

    return t._submit(op())


def main():
    t = LocalPlaywrightTransport()
    try:
        # ① 关弹窗(点「取消」);tab 已不在则跳过
        try:
            url = activate_tab(t, DESK_ID)
        except RuntimeError:
            url = None
            print("desk tab 已关闭(用户可能关了),跳过取消弹窗", flush=True)
        if url:
            print("desk tab:", url, flush=True)
            nodes = t.dump_nodes()
            cancel = [n for n in nodes if n["desc"] == "取消" and "btnChildren" in n["cls"]]
            if cancel:
                t.tap(*cancel[0]["center"])
                time.sleep(2)
                print("取消 clicked, dialog nodes now:",
                      [n["desc"] for n in t.dump_nodes() if "confirmTitle" in n["cls"]], flush=True)
            # 详情页「无忧卖」相关文本(确认该 item 是无忧卖)
            nodes = t.dump_nodes()
            wy = [n for n in nodes if any(k in (n["desc"] or "") for k in ("无忧卖", "活动价", "验货"))]
            print("--- 电竞桌子详情页 无忧卖/活动价 相关 ---", flush=True)
            for n in wy:
                print(f"  [{n['center']}] cls={n['cls'][:50]!r} desc={n['desc'][:60]!r}", flush=True)

        # ② 个人中心全量卡片 + 卡片内徽标
        t.launch_app("https://www.goofish.com/personal")
        time.sleep(4)
        w, h = t.screen_size()
        seen = {}

        def collect():
            ns = _flat(t.dump_nodes())
            for c in parse_goods_cards(ns):
                key = (c["title"], c.get("price"))
                if key in seen:
                    continue
                x1, y1 = c["cx"] - c["w"] / 2, c["cy"] - c["h"] / 2
                x2, y2 = c["cx"] + c["w"] / 2, c["cy"] + c["h"] / 2
                badges = sorted({(n["desc"] or "").strip() for n in ns
                                 if n["desc"] and n["desc"].strip()
                                 and n["desc"].strip() != c["title"]
                                 and x1 - 2 <= n["cx"] <= x2 + 2
                                 and y1 - 2 <= n["cy"] <= y2 + 2
                                 and len(n["desc"].strip()) <= 20})
                c["badges"] = badges
                seen[key] = c

        collect()
        for _ in range(8):
            before = len(seen)
            t.swipe(int(w * 0.6), int(h * 0.25), int(w * 0.6), int(h * 0.25) + 500)
            time.sleep(1.5)
            collect()
            if len(seen) == before:
                break

        cards = sorted(seen.values(), key=lambda c: c["cy"])
        print(f"\n--- 在售卡片 {len(cards)} 个 ---", flush=True)
        for c in cards:
            print(f"  ¥{c.get('price')}  {c['title'][:30]!r}  badges={c['badges']}", flush=True)
        with open(f"{OUT}/personal_cards_full.json", "w", encoding="utf-8") as f:
            json.dump(cards, f, ensure_ascii=False, indent=1)

        # 全页文本里有没有「无忧卖」字样
        alltext = sorted({(n["desc"] or "").strip() for n in t.dump_nodes() if n["desc"]})
        wy2 = [x for x in alltext if "无忧" in x]
        print("\n/personal 页面含「无忧」文本:", wy2, flush=True)
        with open(f"{OUT}/personal_alltext.json", "w", encoding="utf-8") as f:
            json.dump(alltext, f, ensure_ascii=False, indent=1)
    finally:
        t.close()


if __name__ == "__main__":
    main()

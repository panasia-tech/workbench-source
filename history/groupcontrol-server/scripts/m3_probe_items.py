"""探测候选测试商品:点开详情页 → 读 item_id → 查「活动价/无忧卖」标记 → 关探测 tab。

无忧卖商品网页版下架被拦截(沙发/电竞桌子实测),测试商品必须非无忧卖。
详情页「活动价」tag(cls fans--)疑似无忧卖标记(两个被拦商品都有),需验证。
候选:松能 白色款 ¥99 / 顺睿吹风机 ¥9 / 高配台式主机 ¥1。
"""
import asyncio
import json
import re
import sys
import time

sys.path.insert(0, ".")
from app.flow.web.goods_flows_web import (_flat, _item_id_from_url,  # noqa: E402
                                          parse_goods_cards)
from app.flow.web.local_transport import LocalPlaywrightTransport  # noqa: E402

OUT = "scripts/m3_recon_out"
CANDIDATES = [
    ("松能 白色款", 99),
    ("顺睿吹风机", 9),
    ("高配台式主机", 1),
]


def submit(t, coro, timeout=30):
    return t._submit(coro, timeout=timeout)


def close_page(t, page):
    async def op():
        await page.close()
    submit(t, op())


def main():
    t = LocalPlaywrightTransport()
    report = []
    try:
        base = t.page  # 记录 /personal 将使用的 tab
        t.launch_app("https://www.goofish.com/personal")
        time.sleep(4)
        w, h = t.screen_size()

        for title_key, price in CANDIDATES:
            print(f"\n===== 候选 {title_key} ¥{price} =====", flush=True)
            # 收集当前可见卡片找目标
            target = None
            for _ in range(10):
                nodes = _flat(t.dump_nodes())
                cards = parse_goods_cards(nodes)
                hits = [c for c in cards
                        if title_key[:8] in c["title"] and c.get("price") == price]
                in_view = [c for c in hits if h * 0.15 <= c["cy"] <= h * 0.9]
                if in_view:
                    target = in_view[0]
                    break
                t.swipe(int(w * 0.6), int(h * 0.25), int(w * 0.6), int(h * 0.25) + 500)
                time.sleep(1.5)
            if not target:
                print("  !! 没找到卡片", flush=True)
                report.append({"title": title_key, "error": "card not found"})
                continue

            t.tap(target["cx"], int(target["cy"] - target["h"] / 2 + 120))
            try:
                url = t.wait_new_tab(contains="/item", timeout=12)
            except RuntimeError as ex:
                print("  !! 未开新 tab:", ex, flush=True)
                report.append({"title": title_key, "error": "no new tab"})
                time.sleep(2)
                continue
            # 等 URL 跳到 id= 形态
            item_id = None
            for _ in range(20):
                item_id = _item_id_from_url(t.page.url)
                if item_id:
                    break
                time.sleep(0.5)
            time.sleep(2)
            nodes = _flat(t.dump_nodes())
            acts = sorted({(n["desc"] or "").strip() for n in nodes
                           if "fans--" in (n.get("cls") or "") and n["desc"]})
            seller = sorted({(n["desc"] or "").strip() for n in nodes
                             if "sellerButton--" in (n.get("cls") or "") and n["desc"]})
            wym = sorted({(n["desc"] or "").strip() for n in nodes
                          if any(k in (n["desc"] or "") for k in ("无忧卖", "无忧"))})
            print(f"  item_id={item_id} 活动价tag={acts} 卖家按钮={seller} 无忧卖文本={wym}", flush=True)
            shot = t.screencap()
            fn = f"{OUT}/probe_{item_id or 'x'}.jpg"
            with open(fn, "wb") as f:
                f.write(shot)
            report.append({"title": title_key, "item_id": item_id,
                           "acts": acts, "seller": seller, "wym": wym, "shot": fn})
            # 关探测 tab,回到 /personal tab
            probe_page = t.page
            close_page(t, probe_page)
            t._page = base
            submit(t, base.bring_to_front())
            time.sleep(2)

        with open(f"{OUT}/probe_report.json", "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=1)
        print("\nreport → probe_report.json", flush=True)
    finally:
        t.close()


if __name__ == "__main__":
    main()

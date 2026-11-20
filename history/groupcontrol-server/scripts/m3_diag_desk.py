"""诊断:电竞桌子(1082054456277)下架弹窗重试点击「确定」。

背景:上次手动探测点了「确定」但弹窗未关闭(v5_desk_after_confirm.jpg)。
本脚本:重连 → 按 URL 定位该 item tab → dump 弹窗/按钮/toast → 点「确定」→ 再 dump+截图观察。
"""
import json
import sys
import time

sys.path.insert(0, ".")
from app.flow.web.local_transport import LocalPlaywrightTransport  # noqa: E402

ITEM_ID = "1082054456277"
OUT = "scripts/m3_recon_out"


def activate_item_tab(t: LocalPlaywrightTransport) -> str:
    """按 URL 含 item id 激活对应 tab(不依赖 pages 顺序)。"""
    import asyncio

    async def op():
        ctx = t.page.context
        for p in ctx.pages:
            if p.is_closed():
                continue
            if ITEM_ID in p.url:
                t._page = p
                await p.bring_to_front()
                return p.url
        raise RuntimeError(f"未找到 URL 含 {ITEM_ID} 的 tab:"
                           + json.dumps([p.url for p in ctx.pages if not p.is_closed()]))

    return t._submit(op())


def interesting(nodes):
    """筛弹窗/卖家按钮/toast/标题相关节点。"""
    keep = []
    for n in nodes:
        d = n["desc"] or ""
        c = n["cls"] or ""
        if any(k in d for k in ("确定要下架", "确定", "取消", "下架", "删除", "重新上架",
                                "无忧卖", "toast", "请前往")) \
                or any(k in c for k in ("confirmTitle", "btnChildren", "toast", "dialog")):
            keep.append(n)
    return keep


def main():
    t = LocalPlaywrightTransport()
    try:
        url = activate_item_tab(t)
        print("tab url:", url, flush=True)
        print("screen:", t.screen_size(), flush=True)
        time.sleep(2)

        nodes = t.dump_nodes()
        with open(f"{OUT}/diag1_nodes.json", "w", encoding="utf-8") as f:
            json.dump(nodes, f, ensure_ascii=False, indent=1)
        print("--- 点击前 关键节点 ---", flush=True)
        for n in interesting(nodes):
            print(f"  [{n['center']}] clickable={n['clickable']} cls={n['cls'][:60]!r} desc={n['desc'][:80]!r}",
                  flush=True)

        # 找弹窗内「确定」按钮(dump_nodes 已含视口内外全部节点,弹窗在视口内)
        confirm = [n for n in nodes
                   if n["desc"] == "确定" and "btnChildren" in n["cls"]]
        if not confirm:
            confirm = [n for n in nodes if n["desc"] == "确定" and n["clickable"]]
        if not confirm:
            print("!!! 没找到「确定」按钮——弹窗可能已不在,看 dump", flush=True)
            return
        btn = sorted(confirm, key=lambda n: (n["center"][1], n["center"][0]))[-1]
        x, y = btn["center"]
        print(f">>> 点击「确定」@ ({x},{y}) size={btn['size']} ...", flush=True)
        t.tap(x, y)
        time.sleep(3)

        nodes2 = t.dump_nodes()
        with open(f"{OUT}/diag2_nodes.json", "w", encoding="utf-8") as f:
            json.dump(nodes2, f, ensure_ascii=False, indent=1)
        print("--- 点击后 关键节点 ---", flush=True)
        for n in interesting(nodes2):
            print(f"  [{n['center']}] clickable={n['clickable']} cls={n['cls'][:60]!r} desc={n['desc'][:80]!r}",
                  flush=True)

        # 全部含「无忧卖/toast/请前往」文本(风控/拦截证据)
        blockers = [n for n in nodes2
                    if any(k in (n["desc"] or "") for k in ("无忧卖", "请前往", "拦截", "失败"))]
        if blockers:
            print("--- 可能的拦截提示 ---", flush=True)
            for n in blockers:
                print(f"  [{n['center']}] cls={n['cls'][:60]!r} desc={n['desc'][:120]!r}", flush=True)

        with open(f"{OUT}/diag2_shot.jpg", "wb") as f:
            f.write(t.screencap())
        print("shot → diag2_shot.jpg", flush=True)

        # 判定:卖家按钮区是否出现「重新上架」/消失「下架」
        seller = [n["desc"] for n in nodes2
                  if n["desc"] in ("下架", "删除", "重新上架", "立即上架", "上架")]
        print("seller btns:", seller, flush=True)
    finally:
        t.close()


if __name__ == "__main__":
    main()

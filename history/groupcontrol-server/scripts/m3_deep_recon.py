"""M3 深挖侦察 v2(2026-09-09):下架确认弹窗结构 / 改价入口候选 / 已下架宝贝列表位置。

v1 发现(recon-notes 补充):
- 个人中心宝贝卡片容器 = div[class*="cardWarp--"];标题 = span[class*="main-title--"];
  价格 = span[class*="number--"](在 price-wrap-- 内);卡片**不是 <a>**,点击开新 tab,itemId 从新 tab URL 读。
- tab 区:综合 / 在售31 / 已售出35 / 筛选(无「已下架」tab,「已下架」疑似藏在 筛选/综合 下拉)。
- 在售 31 件,首屏只渲染 ~20 卡(虚拟滚动,定位要滚动收集)。

纪律:
- 复用已有 tab;页面跳转间隔 ≥2s;动作间 ≥1.5s。
- 点「下架」后**若弹确认框 → 只截图+记录结构,点「取消」恢复**;
  若没有确认框(直接下架)→ 记录该事实,并当场点「重新上架」类按钮恢复,再记录恢复路径。
- 滑块风控弹窗(「请拖动下方滑块完成验证」「请按住滑块」)命中即中止,不自动过。

用法:
  ./demo scripts/m3_deep_recon.py
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, ".")
from app.flow.web.local_transport import LocalPlaywrightTransport  # noqa: E402

OUT_DIR = "scripts/m3_recon_out"
PERSONAL_URL = "https://www.goofish.com/personal"
GAP = 2.0
SETTLE = 1.5
RISK_TEXTS = ("请拖动下方滑块完成验证", "请按住滑块", "安全验证", "账号异常", "人机验证")

os.makedirs(OUT_DIR, exist_ok=True)
FINDINGS: dict = {}


def log(section: str, **kv):
    FINDINGS.setdefault(section, {}).update(kv)
    print(f"\n===== {section} =====")
    print(json.dumps(kv, ensure_ascii=False, indent=2, default=str)[:3000])


def save_dump(t, name):
    nodes = t.dump_nodes()
    path = os.path.join(OUT_DIR, f"{int(time.time())}_{name}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(nodes, f, ensure_ascii=False, indent=1)
    return path, nodes


def save_shot(t, name):
    path = os.path.join(OUT_DIR, f"{int(time.time())}_{name}.jpg")
    with open(path, "wb") as f:
        f.write(t.screencap())
    return path


def check_risk(nodes):
    for n in nodes:
        d = n.get("desc") or ""
        for a in RISK_TEXTS:
            if a in d:
                raise SystemExit(f"命中风控锚点 {a!r},中止侦察(需人工过滑块)")


def flat(nodes):
    out = []
    for n in nodes:
        c = n.get("center") or (0, 0)
        s = n.get("size") or (0, 0)
        out.append({"desc": n.get("desc", ""), "cls": n.get("cls", ""),
                    "clickable": bool(n.get("clickable")),
                    "cx": int(c[0]), "cy": int(c[1]), "w": int(s[0]), "h": int(s[1])})
    return out


def parse_cards(f):
    """v2 结构:卡片=cardWarp--;标题=main-title--;价格=number--(price-wrap-- 内)。"""
    cards = []
    for cw in [n for n in f if "cardWarp--" in n["cls"]]:
        x1, y1 = cw["cx"] - cw["w"] / 2, cw["cy"] - cw["h"] / 2
        x2, y2 = cw["cx"] + cw["w"] / 2, cw["cy"] + cw["h"] / 2
        members = [n for n in f if x1 - 2 <= n["cx"] <= x2 + 2 and y1 - 2 <= n["cy"] <= y2 + 2
                   and n is not cw]
        title = next((n["desc"] for n in members if "main-title--" in n["cls"]
                      and n["desc"].strip()), None)
        price = None
        for n in members:
            if "number--" in n["cls"] and n["desc"].strip().replace(",", "").replace(".", "").isdigit():
                try:
                    price = int(round(float(n["desc"].strip().replace(",", ""))))
                except ValueError:
                    pass
        if title:
            cards.append({"title": title.strip(), "price": price,
                          "cx": cw["cx"], "cy": cw["cy"], "w": cw["w"], "h": cw["h"]})
    cards.sort(key=lambda c: c["cy"])
    return cards


# ---------------------------------------------------------------- personal 页
def recon_personal(t):
    t.launch_app(PERSONAL_URL)
    time.sleep(4)
    _, nodes = save_dump(t, "personal")
    check_risk(nodes)
    shot = save_shot(t, "personal")
    f = flat(nodes)

    tabs = [{"desc": n["desc"], "cls": n["cls"], "clickable": n["clickable"],
             "cx": n["cx"], "cy": n["cy"], "w": n["w"], "h": n["h"]}
            for n in f if any(k in n["desc"] for k in ("综合", "在售", "已售出", "筛选", "已下架", "宝贝管理"))]
    cards = parse_cards(f)
    log("personal", shot=shot, tabs=tabs, n_cards=len(cards),
        cards=[{k: c[k] for k in ("title", "price", "cy")} for c in cards])

    target = next((c for c in cards if c["price"] == 99
                   and any(k in c["title"] for k in ("沙发", "电竞", "桌"))), None)
    log("target_candidate", target=target)
    return f, target


def recon_offshelf_list(t, f):
    """已下架宝贝列表在哪:侦察「筛选」与「综合」下拉里的选项。"""
    for label in ("筛选", "综合"):
        cands = [n for n in f if n["desc"].strip() == label and n["clickable"]]
        if not cands:
            continue
        n = min(cands, key=lambda x: x["w"] * x["h"])
        t.tap(n["cx"], n["cy"])
        time.sleep(SETTLE)
        _, nodes = save_dump(t, f"dropdown_{label}")
        check_risk(nodes)
        shot = save_shot(t, f"dropdown_{label}")
        opts = [{"desc": x["desc"], "cls": x["cls"][:50], "clickable": x["clickable"],
                 "cx": x["cx"], "cy": x["cy"]} for x in flat(nodes) if x["desc"].strip()]
        log(f"dropdown_{label}", shot=shot, options=opts[:25])
        t.key("BACK")
        time.sleep(1.0)
        _, nodes = save_dump(t, f"dropdown_{label}_closed")
        check_risk(nodes)
        f = flat(nodes)
    return f


# ---------------------------------------------------------------- 详情页
def recon_item_page(t, target):
    """点目标卡片(新 tab)→ activate_latest_tab → 记录 itemId 与卖家按钮。"""
    t.tap(target["cx"], target["cy"])
    time.sleep(3)
    url = t.activate_latest_tab()
    time.sleep(2)
    _, nodes = save_dump(t, "item_detail")
    check_risk(nodes)
    f = flat(nodes)
    shot = save_shot(t, "item_detail")

    item_id = (re.search(r"[?&]id=(\d+)", url) or [None, None])[1]
    seller_btns = [{"desc": n["desc"], "cls": n["cls"], "cx": n["cx"], "cy": n["cy"],
                    "w": n["w"], "h": n["h"]}
                   for n in f if "sellerButton--" in n["cls"]]
    log("item_detail", url=url, item_id=item_id, shot=shot, buttons=seller_btns)
    return f, item_id, url


def recon_delist_dialog(t, f):
    """点「下架」→ 记录确认弹窗结构 → 点「取消」恢复。若直接下架则记录并立即恢复。"""
    btn = next((n for n in f if n["desc"].strip() == "下架" and n["clickable"]), None)
    if not btn:
        log("delist_dialog", error="详情页找不到「下架」按钮")
        return f, False
    t.tap(btn["cx"], btn["cy"])
    time.sleep(2.5)
    _, nodes = save_dump(t, "after_delist_click")
    check_risk(nodes)
    f = flat(nodes)
    shot = save_shot(t, "after_delist_click")

    dialog_texts = [{"desc": n["desc"], "cls": n["cls"][:60], "clickable": n["clickable"],
                     "cx": n["cx"], "cy": n["cy"], "w": n["w"], "h": n["h"]}
                    for n in f if any(k in n["desc"] for k in
                    ("确认", "确定", "取消", "再想想", "继续", "下架"))]
    restore_btns = [{"desc": n["desc"], "cls": n["cls"][:60], "cx": n["cx"], "cy": n["cy"]}
                    for n in f if n["desc"].strip() in ("重新上架", "上架", "编辑", "改价", "删除")]
    log("delist_dialog", shot=shot, dialog_texts=dialog_texts, restore_btns=restore_btns)

    cancel = next((n for n in f if n["desc"].strip() in ("取消", "再想想", "暂不", "关闭")
                   and n["clickable"]), None)
    if cancel:
        t.tap(cancel["cx"], cancel["cy"])
        time.sleep(SETTLE)
        _, nodes = save_dump(t, "after_cancel")
        check_risk(nodes)
        f2 = flat(nodes)
        still = any(n["desc"].strip() == "下架" for n in f2)
        log("delist_dialog", canceled_with=cancel["desc"], still_on_sale=still)
        return f2, False

    # 没有取消按钮:疑似直接下架 → 找「重新上架」恢复并记录恢复路径(relist 流程的侦察!)
    log("delist_dialog", note="未出现确认弹窗/取消按钮——疑似直接下架,尝试恢复")
    rb = next((n for n in f if n["desc"].strip() in ("重新上架", "上架") and n["clickable"]), None)
    if rb:
        t.tap(rb["cx"], rb["cy"])
        time.sleep(3)
        _, nodes = save_dump(t, "after_restore_click")
        check_risk(nodes)
        f3 = flat(nodes)
        log("delist_dialog", restore_button=rb["desc"],
            after_restore=[n["desc"] for n in f3
                           if any(k in n["desc"] for k in ("上架", "成功", "发布"))][:10])
        return f3, True
    log("delist_dialog", error="无取消也无恢复按钮,需人工检查账号状态!")
    return f, True


# ---------------------------------------------------------------- 改价入口候选
def recon_reprice_entries(t, item_id):
    """候选① /publish?id=<itemId> 是否进编辑模式(只看不发)。"""
    url = f"https://www.goofish.com/publish?id={item_id}"
    t.launch_app(url)
    time.sleep(4)
    _, nodes = save_dump(t, "publish_edit_mode")
    check_risk(nodes)
    f = flat(nodes)
    shot = save_shot(t, "publish_edit_mode")
    inputs = [{"desc": n["desc"][:80], "cls": n["cls"][:60], "cx": n["cx"], "cy": n["cy"]}
              for n in f if "input" in n["cls"] or "textarea" in n["cls"]][:20]
    btns = [n["desc"] for n in f if n["desc"] in ("发布", "保存", "取消") and n["clickable"]]
    editor_texts = [n["desc"][:60] for n in f if n["desc"] and len(n["desc"]) >= 6][:15]
    log("reprice_entry_publish_edit", url=url, shot=shot, inputs=inputs,
        buttons=btns, editor_texts=editor_texts)


def main():
    t = LocalPlaywrightTransport()
    out_path = os.path.join(OUT_DIR, f"{int(time.time())}_findings.json")
    try:
        f, target = recon_personal(t)
        time.sleep(GAP)
        f = recon_offshelf_list(t, f)
        if not target:
            raise SystemExit("没找到 ¥99 沙发/电竞桌测试卡,无法继续详情页侦察")

        time.sleep(GAP)
        f, item_id, url = recon_item_page(t, target)
        time.sleep(GAP)
        f, delisted = recon_delist_dialog(t, f)
        log("delist_dialog", summary_delisted=delisted)

        if item_id:
            time.sleep(GAP)
            recon_reprice_entries(t, item_id)
    finally:
        t.close()
        with open(out_path, "w", encoding="utf-8") as fp:
            json.dump(FINDINGS, fp, ensure_ascii=False, indent=2, default=str)
        print(f"\nfindings → {out_path}")


if __name__ == "__main__":
    main()

"""闲鱼「下架」流程:我的 → 我发布的 → 在卖 tab → 定位商品 → 「…」菜单 → 下架。

2026-07-16 真机重探(见 spec):我发布的是 Flutter(FishFlutterBoostActivity),
tab 与商品行文字**可 OCR**;但每条商品行是合并语义节点,行内按钮拿不到独立节点,
故 tab / 行按钮 / 菜单项一律走 OCR 锚点 + 坐标点击。「…」是图标(无文字),按行标题
坐标偏移点;「下架」「重新上架」「一键擦亮」是文字,直接 OCR。

DelistSpec: {item_id, listing_id, title_hint}
结果:{ok, done, failed_step, reason, shot, risk}
"""

import logging
import re
import time

from app.flow.engine import Engine, StepError

logger = logging.getLogger("gc.flow.delist")

XIANYU_PKG = "com.taobao.idlefish"

# —— 真机校准常量(1080x2400 基准,按屏幕比例;见 plan Task 8)——
MORE_ICON_X_FRAC = 0.069        # 「…」图标横向(行左下)
MORE_ICON_DY_FRAC = 0.035       # 「…」相对行标题中心的纵向下偏移


def _find_home_tab(e: Engine, name: str) -> dict | None:
    """在底部导航栏找某个 tab 的可点节点。

    闲鱼首页是**原生**页(MainActivity),底部 tab 的 content-desc 形如「我的，未选中状态」/
    「我的，未读消息数0，选中状态」——按子串 + 底部区域(cy>0.9h) + clickable 命中,取最小面积者。
    节点中心 y≈2287 落在系统手势区之上,直接点安全:不必再靠「OCR 文字中心 -50px」的魔法偏移
    (那是因为 OCR 取 tab 文字中心 y≈2337,已进手势区、触摸被吞还不报错)。
    """
    cands = [n for n in e.dump_nodes()
             if name in (n.get("desc") or "")
             and n.get("clickable")
             and n["center"][1] > e.height * 0.9]
    return min(cands, key=lambda n: (n["size"][0] * n["size"][1]) or 1 << 30) if cands else None


def open_my_published(e: Engine) -> None:
    """唤醒并进入卖家「我发布的」管理页。

    导航节点化(2026-07-22 真机复盘):底部「我的」tab 改**节点定位**,根治两个老坑——
    ①OCR 点 tab 文字中心落进系统手势区被吞、不报错;②OCR find('我的') 会同时命中
    「我的关注/我的收藏」等,叠加 -50px 盲点偏移,曾把导航漂到「关注的人」页。
    个人主页的「我发布的」是原生 TextView(只有 text=、content-desc 为空,节点树读不到),
    故这步仍走 OCR——但它居中、无手势区风险,且进主页/落管理页前后都校验,不会再静默漂移。
    """
    from app.flow.publish_flow import _leave_editor_to_home
    e.t.key("WAKEUP")
    e.t.force_stop(XIANYU_PKG)
    time.sleep(1)
    e.t.launch_app(XIANYU_PKG)
    time.sleep(3)
    e.dismiss_nuisance()

    # ① 先确保停在带底部栏的页(首页/上海/消息/我的 都有「我的」tab 节点)。force_stop 只回主页、
    #    launch 会恢复上次页面(可能是编辑页/子页,无底部栏)——逐级兜底退到能看见底部栏为止。
    me_tab = _find_home_tab(e, "我的")
    if not me_tab:
        _leave_editor_to_home(e)
        time.sleep(1)
        e.dismiss_nuisance()
        me_tab = _find_home_tab(e, "我的")
    for _ in range(3):
        if me_tab:
            break
        e.t.key("BACK")
        time.sleep(1)
        me_tab = _find_home_tab(e, "我的")
    if not me_tab:
        from app.flow.ready import ensure_logged_in
        ensure_logged_in(e, "delist")   # 到不了带底部栏的页:先判是否掉登录
        raise StepError("open_my_published", "未找到底部「我的」tab 节点", e.save_shot("miss_me_tab"))

    # ② 点「我的」tab 节点中心(手势区之上,安全)→ 个人主页
    e.tap_xy(*me_tab["center"], settle=1.5)

    # ③ 确认已进个人主页,再 OCR 点「我发布的」
    if not e.find_any(["我发布的", "我的交易"], timeout=4):
        raise StepError("open_my_published", "点「我的」后未进入个人主页", e.save_shot("miss_profile"))
    e.tap_text("我发布的", "open_my_published", settle=2.0)

    # ④ 校验落到「我发布的」管理页(在卖/已下架 tab),把静默漂移变成明确失败
    if not e.find_any(["在卖", "已下架", "草稿"], timeout=5):
        raise StepError("open_my_published", "未进入「我发布的」管理页", e.save_shot("miss_mylistings"))


def _find_tab_node(e: Engine, tab: str) -> dict | None:
    """在顶部 tab 条里找某个 tab 的可点节点(在卖 / 草稿 / 已下架)。

    tab 条在 cy≈0.48h,每个 tab 是**小**可点节点,desc 形如「在卖」/「1\\n在卖」/「已下架」。
    限定「tab 条区域(cy<0.55h)+ clickable + 最小面积」三重命中:既忽略角标数字(「1\\n在卖」照样命中
    「在卖」),又不会误点卡片里含「下架/主动下架」的长文案(卡片是整屏大节点,最小面积天然排它)。
    """
    cands = [n for n in e.dump_nodes()
             if tab in (n.get("desc") or "") and n.get("clickable")
             and n["center"][1] < e.height * 0.55]
    return min(cands, key=lambda n: (n["size"][0] * n["size"][1]) or 1 << 30) if cands else None


def select_tab(e: Engine, tab: str, step: str) -> None:
    """点顶部 tab(在卖 / 草稿 / 已下架):**节点优先**,读不到节点再退回 OCR。

    节点定位不受 OCR 置信度排序、角标数字干扰;tab 是否真切换由下游步骤兜底校验
    (在卖→list_cards 有卡片;已下架→找得到「重新上架」)。
    """
    node = _find_tab_node(e, tab)
    if node:
        e.tap_xy(*node["center"], settle=1.2)
    else:
        e.tap_text(tab, step, settle=1.2)


def _count_exact(e: Engine, text: str) -> int:
    """当前屏 OCR 中文本恰为 text 的条目数(数商品行按钮判断列表商品数)。"""
    return sum(1 for it in e.read() if it["text"].strip() == text)


BUTTON_NOISE = {"降价", "编辑", "托管", "分享", "删除", "重新上架", "主动下架", "擦亮"}


def extract_title(desc: str) -> str | None:
    """从商品卡片节点的 desc 里抽出标题。

    Flutter semantics 是**扁平聚合**的：整张卡片的文字挤在一个 desc 里，形如
    「降价\\n编辑\\n恭喜可托管无忧卖…\\n托管\\n【泰坦军团P2510G显示器】24.5寸直屏」。

    真标题在行内按钮(降价/编辑/重新上架/主动下架/删除…)**之后**。坑(2026-07-22 真机):
    卡片顶部/按钮区常混入闲鱼注入的营销横幅——「设置佣金，获取官方流量扶持」「做任务，得超级
    擦亮红包或闲鱼皮肤!」「爆款热销ing…」——它们和真标题一样长甚至更长,直接「取最长段」会误选横幅
    (实测「设置佣金，获取官方流量扶持」与真标题同为 13 字,被当成标题回读/记账,污染 title 强锚,
    连带下架按 title 定位也会失准)。故:先切到「最后一个按钮之后」把按钮之前的横幅排除,
    再在余下段里取最长的非统计段(排掉「曝光/浏览/想要/¥」这类统计行)。
    """
    parts = [p.strip() for p in (desc or "").split("\n") if p.strip()]
    btn_idxs = [i for i, p in enumerate(parts) if p in BUTTON_NOISE]
    if btn_idxs:
        parts = parts[btn_idxs[-1] + 1:]
    stat_prefixes = ("曝光", "浏览", "想要", "¥", "￥")
    cands = [p for p in parts
             if p not in BUTTON_NOISE and len(p) >= 6 and not p.startswith(stat_prefixes)]
    return max(cands, key=len) if cands else None


# 卡片售价:desc 里「¥」后的数字(闲鱼卡片价形如「…想要119\n¥\n100」;\s 含 \n 故能跨段)。
# 用 search 取第一处 ¥——卡片正常只显示现价一处 ¥(原价另有「原价:」前缀,不裸带 ¥)。
_CARD_PRICE_RE = re.compile(r"[¥￥]\s*(\d[\d,]*(?:\.\d+)?)")


def extract_price(desc: str) -> int | None:
    """从商品卡片 desc 抽当前售价(整数元,与 Listing.price 同单位)。读不到返回 None。

    名称+价格匹配的「价格」半边:闲鱼允许同标题多发,价格作第二锚点消歧(见 locate_row_y)。
    """
    m = _CARD_PRICE_RE.search(desc or "")
    if not m:
        return None
    try:
        return int(round(float(m.group(1).replace(",", ""))))
    except ValueError:
        return None


def list_cards(e: Engine) -> list[dict]:
    """列出当前 tab 的商品卡片节点(按屏幕从上到下)。

    卡片特征：desc 里带「编辑」(在卖) 或「重新上架」(已下架) 这类行内按钮，且高度可观。
    """
    out = []
    for n in e.dump_nodes():
        d = n.get("desc") or ""
        if not any(k in d for k in ("编辑", "重新上架")):
            continue
        if n["size"][1] < 150:          # 排掉纯按钮/小图标
            continue
        title = extract_title(d)
        if not title:
            continue
        out.append({"node": n, "title": title, "y": n["center"][1], "price": extract_price(d)})
    out.sort(key=lambda c: c["y"])
    return out


def live_count(e: Engine) -> int | None:
    """读「在卖」tab 角标数字(desc 形如 '1\\n在卖')——**仅作日志/弱提示,不可作下架校验依据**。

    2026-07-22 真机实测这个角标不可靠:同样 1 件在卖,首次进页 desc='1\\n在卖',
    重新上架后再看却只剩纯「在卖」(无数字)。即「无数字」既可能是 0 件、也可能是角标没渲染,
    二者无法区分。故这里读到数字返回数字、读不到返回 None(**不猜 0**);
    下架是否生效一律以 `list_cards`(渲染出的商品卡片)为准——那才是真值。
    """
    n = e.find_node("在卖")
    if not n:
        return None
    m = re.search(r"(\d+)", n.get("desc") or "")
    return int(m.group(1)) if m else None


def delist_confirmed(before_titles: list[str], titles: list[str], target: str) -> bool:
    """下架是否生效的判定(纯函数,可单测)。以 list_cards 渲染卡片为准,不看 tab 角标:
      - 有 target(Listing.title):目标商品已离开在卖列表即成功(多商品最准);
      - 无 target(单商品兜底):在卖卡片数比操作前少即成功(通常降到 0)。
    """
    if target:
        key = target[:12]
        return not any(t == target or (key and key in t) for t in titles)
    return len(titles) < len(before_titles)


def find_more_icon(e: Engine, row_y: int) -> tuple[int, int] | None:
    """在商品卡片内找「…」菜单图标的节点坐标。

    实测(1080x2400)它是个约 55x55、无 desc 的小节点，贴卡片左侧：cx=77 cy=1455，
    而按比例算是 (0.069w, row_y+0.035h)=(74,1511)——横向准、纵向差 56px，正好点空。
    故按「卡片范围内、靠左、小方块」找节点，找不到再回退比例坐标。
    """
    best = None
    for n in e.dump_nodes():
        w, h = n["size"]
        cx, cy = n["center"]
        if not (35 <= w <= 85 and 35 <= h <= 85):
            continue
        if cx > e.width * 0.25:              # 「…」在卡片左侧
            continue
        if abs(cy - row_y) > 220:            # 必须属于这张卡片
            continue
        if best is None or abs(cy - row_y) < abs(best[1] - row_y):
            best = (cx, cy)
    return best


# 行内文字按钮(重新上架 / 编辑)离卡片中心的最大纵向距离。卡片高约 340~440px,按钮在卡片里离中心
# 不过半高(≤220),留点余量取 260——沿用重新上架 07-25 真机(已下架 4 件)跑通时的值;再远就是相邻卡片的了。
ROW_BUTTON_MAX_DY = 260


def row_button(items: list[dict], texts: tuple[str, ...], row_y: int) -> dict | None:
    """在 OCR 结果里挑**目标那一行**的行内文字按钮:文字恰为 texts 之一、离 row_y 最近,
    且不超过 ROW_BUTTON_MAX_DY。挑不到返回 None。

    卡片是合并语义节点,行内按钮拿不到独立节点只能 OCR,而每张卡片都有自己的一份
    (在卖:降价/编辑;已下架:删除/重新上架)——不按行挑、随便取一个(find_any 取的是置信度
    最高的),多件时未必在目标行,点下去操作的就是别的商品。
    """
    cands = [it for it in items
             if it["text"].strip() in texts and abs(it["center"][1] - row_y) <= ROW_BUTTON_MAX_DY]
    return min(cands, key=lambda it: abs(it["center"][1] - row_y)) if cands else None


def locate_row_y(e: Engine, spec: dict, tab: str = "在卖", action: str | None = None) -> int:
    """返回目标商品行的屏幕 y。tab / action 只用来把失败原因说清:在哪个列表里找、没做成什么。

    定位优先级(**名称+价格,节点优先,对不上就不点**)：
      ① Listing.title 精确/子串匹配卡片节点;同名多件时再用 **spec["price"]** 消歧
         (闲鱼允许同标题多发,价格是第二锚点)——名称+价格锁定唯一即命中;
      ② title_hint(通常是 SKU 条码)——闲鱼卡片不显示 SKU，基本不命中，留作兼容；
      ③ 都对不上就硬失败,**不点任何一张卡**。以前在卖恰好 1 件时退回那张唯一卡片,可那一件
         未必是要下的(要下的已经被人手动下了、或标题回读错了),点下去就是下错商品——宁可不下也不下错。
    改价(reprice_flow)也走这一步定位,同样对不上就不改;重新上架(relist_flow)在已下架列表里
    走这一步(tab="已下架"),对不上就不上。
    """
    cards = list_cards(e)
    want = (spec.get("title") or "").strip()
    want_price = spec.get("price")

    if want and cards:
        exact = [c for c in cards if c["title"] == want]
        loose = exact or [c for c in cards if want[:12] and want[:12] in c["title"]]
        # 名称+价格:同名多件时用价格消歧(卡片价 == Listing.price 才认)。价格缺失(任一侧 None)
        # 则不据此裁剪,退回纯标题判定,免把「读不到价」误当「价不符」而漏选。
        if len(loose) > 1 and want_price is not None:
            priced = [c for c in loose if c.get("price") == int(want_price)]
            if len(priced) == 1:
                return priced[0]["y"]
            if priced:
                loose = priced
        if len(loose) == 1:
            return loose[0]["y"]
        if len(loose) > 1:
            raise StepError("locate_item",
                            f"标题「{want[:20]}」+价格{want_price} 仍匹配到 {len(loose)} 个商品，拒绝盲选",
                            e.save_shot("delist_ambiguous"))

    hint = spec.get("title_hint")
    if hint:
        hit = e.find(hint, contains=True, timeout=2)
        if hit:
            return hit["center"][1]

    what = action or ("改价" if spec.get("new_price") is not None else "下架")
    looking = f"找的是「{want[:20]}」" if want else "这条链接没记下标题"
    raise StepError("locate_item",
                    f"{tab}列表里没对上这件商品，没有{what}（{looking}，列表里有 {len(cards)} 件）",
                    e.save_shot("delist_locate_fail"))


def step_open_my_listings(e: Engine, spec: dict) -> None:
    """保名(delist/reprice 复用):打开我发布的 + 选「在卖」tab。"""
    open_my_published(e)
    select_tab(e, "在卖", "open_my_listings")


def step_locate_item(e: Engine, spec: dict) -> None:
    """保名:定位目标行,把行 y 存进 spec 供下架/改价用。"""
    spec["_row_y"] = locate_row_y(e, spec)


def step_delist(e: Engine, spec: dict) -> None:
    """点该行「…」→ 菜单「下架」→ 确认层。

    2026-07-16 真机校准(1080x2400):「…」坐标(0.069w, 0.57h+0.035h)命中;点「下架」后弹
    确认框「确定要下架这个宝贝吗?」按钮「确定」——该弹层不进无障碍节点树,但 OCR 可见,故走
    find_any(OCR)。确认后商品即从「在卖」移入「已下架」。
    """
    # 下架前在卖商品(渲染真值)。tab 角标不可靠(见 live_count),一律以 list_cards 为基准。
    before_titles = [c["title"] for c in list_cards(e)]

    row_y = spec.get("_row_y")
    if not row_y:
        # 没经 locate_item 定位就不点:以前这里退回「第一行」的比例坐标盲点,点中的未必是要下的那件
        raise StepError("delist", "没定位到要下架的商品，没有下架", e.save_shot("delist_no_row"))
    # 「…」优先用节点定位：比例坐标会偏——实测卡片 row_y=1427 时算出 y=1511，
    # 而「…」节点实际在 y=1455，差 56px，点空且不报错(旧代码就此把点空判成成功)。
    icon = find_more_icon(e, row_y)
    if icon:
        mx, my = icon
    else:
        mx = int(e.width * MORE_ICON_X_FRAC)
        my = row_y + int(e.height * MORE_ICON_DY_FRAC)
        logger.warning("「…」节点未命中，回退比例坐标(%s,%s)——留意是否又在盲点", mx, my)
    e.tap_xy(mx, my, settle=1.2)                       # 打开「…」底部菜单
    hit = e.find_any(["下架", "放入仓库"], timeout=6)
    if not hit:
        raise StepError("delist", "「…」菜单未出现下架项", e.save_shot("miss_delist_menu"))
    e.tap_xy(*hit[1]["center"], settle=1.2)
    # 确认弹层不进节点树(实测)，只能 OCR。找不到就是没弹出来 → 必须失败，不能静默跳过：
    # 旧代码这里是 `if ok:`，没弹出也照样往下走，于是「点空」被判成成功。
    ok = e.find_any(["确定", "确认", "放入仓库", "确认下架"], timeout=6)
    if not ok:
        raise StepError("delist", "未出现下架确认框", e.save_shot("miss_delist_confirm"))
    e.tap_xy(*ok[1]["center"], settle=2.0)

    # ---- 结果校验:不做这一步,点空也会报成功(2026-07-21 真机就出过:任务 SUCCESS、
    #      账本记 DELISTED,商品其实还在卖)。校验**以 list_cards 渲染卡片为准**,不看 tab 角标——
    #      2026-07-22 真机复盘:角标不可靠(1 件在卖也可能不显示数字),曾据此把成功下架误判失败。
    # 成功信号:①有 title 时,目标商品已离开在卖(多商品最准);②无 title(单商品)时,在卖卡片数减少。
    target = (spec.get("title") or "").strip()
    deadline = time.time() + 12
    while time.time() < deadline:
        titles = [c["title"] for c in list_cards(e)]
        if delist_confirmed(before_titles, titles, target):
            return
        time.sleep(1.5)
    raise StepError(
        "delist",
        f"下架未生效(在卖卡片 {len(before_titles)}→{len(list_cards(e))}，target={target!r})",
        e.save_shot("delist_not_effective"),
    )


STEPS = [
    ("open_my_listings", step_open_my_listings),
    ("locate_item", step_locate_item),
    ("delist", step_delist),
]


def run_delist(transport, spec: dict, shot_sink=None) -> dict:
    from app.flow.publish_flow import reset_to_clean
    e = Engine(transport, shot_sink=shot_sink)
    result = e.run(STEPS, spec)
    reset_to_clean(e)
    return result

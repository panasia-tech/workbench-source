"""闲鱼网页版「下架 / 重新上架 / 删除 / 改价」流程:个人中心双锚定位 → 详情页操作 → 结构化返回。

与 read_chats_web 同构(同一 Transport 原语、同一 result schema:{ok, done, failed_step,
reason, shot, risk},login=True 表掉登录),业务语义对齐手机版 delist_flow/relist_flow
(名称+价格双锚定位、结果校验、绝不在多商品时盲点)。

2026-09-09 AdsPower 实测侦察结论(recon-notes.md §3/§4 + scripts/m3_deep_recon*.py):
- 个人中心 /personal 在售列表:卡片=div[class*="cardWarp--"],标题=span[class*="main-title--"],
  价格=span[class*="number--"](在 price-wrap-- 内,整数元)。卡片**不是 <a>**,点击开新 tab,
  新 tab URL 先 spm 形态后跳 item?id=<itemId>,itemId 从激活后 URL 读。
- **dump_nodes 含视口外节点**(isVisible 只查 display/visibility)——点击前必须先把目标卡片
  滚进视口(swipe 正 deltaY=向下)再重新 dump 取坐标,否则点空且不报错。
- 自己的详情页卖家操作组 [class*="sellerButtonGroup--"] > [class*="sellerButton--"]:
  在售=「下架/删除」;点「下架」弹确认框 confirmTitle--「确定要下架这个宝贝吗?」+
  btnChildren--「取消/确定」。**网页版下架=详情页路径,不走列表行内菜单**(对齐手机版语义,
  校验用手机版同款「列表卡片消失」+ 详情页按钮态双重校验)。
- 已下架列表:**网页版没有**。个人中心 tab 只有 综合/在售N/已售出N(宝贝总数=在售+已售出),
  「筛选」下拉只有包邮/验货宝,「宝贝管理」是 APP 扫码弹窗。故 relist 走**详情页直开**:
  /item?id=<itemId>(spec.item_id)→ 详情页身份校验(title+price)→ 点「重新上架」。
- **无忧卖商品网页版下架被平台拦截**(2026-09-09 实测:沙发/电竞桌子点「确定」后弹窗不关,
  toast「为保障无忧卖流量推广效果,请前往『无忧卖-售卖中』修改价格和库存」)。详情页「活动价」
  tag 不是无忧卖判据(普通商品也有)。run_delist_web 检出该 toast → 明确失败+自动点「取消」
  收弹窗保持页面干净,reason 带完整拦截文案。
- **改价:网页版无此能力**(详情页无编辑/改价按钮;/publish?id=<itemId> 是空白新发
  表单而非编辑模式,图片/描述/价格全空;无其它入口)。run_reprice_web 直接明确失败,
  改价请走手机版 goods_reprice。

风控:engine.RISK_ANCHORS + 网页版滑块锚点(「请拖动下方滑块」「请按住滑块」),命中即
RiskHit 返回(熔断,不过滑块)。操作纪律:复用 tab、动作间隔 ≥1.5s、页面跳转 ≥2s。

⚠️ 生产化注意:LocalPlaywrightTransport 的 wait_new_tab/activate_tab 是本地联调扩展;
MQTT 执行端(adspower-executor)要支持 goods_* web 流程,需给 RPC 原语补「等新 tab/按
URL 切 tab」能力(当前 executor 只有单 page 句柄)。
"""
import logging
import os
import re
import time

from app.flow.engine import LoginRequired, RiskHit, RISK_ANCHORS
from app.flow.transport import FlowTimeout

logger = logging.getLogger("gc.goods_flows_web")

PERSONAL_URL = "https://www.goofish.com/personal"
ITEM_URL = "https://www.goofish.com/item?id={}"

# ---- 选择器常量(2026-09-09 实测,类名带 hash 后缀,一律前缀匹配)----
CLS_CARD_WARP = "cardWarp--"        # 个人中心宝贝卡片容器
CLS_CARD_TITLE = "main-title--"     # 卡片标题
CLS_CARD_PRICE = "number--"         # 卡片价格(在 price-wrap-- 内)
CLS_TAB_ONSALE = "tabItem--"        # tab 条(在售/已售出)
# 登录态判定统一走 parse.find_login_nick(未登录时页头也有 nick-- 元素,文本是「登录」)
from app.flow.web.login import recover_login  # noqa: E402
from app.flow.web.parse import find_login_nick  # noqa: E402
CLS_SELLER_BTN = "sellerButton--"   # 详情页卖家操作按钮(下架/删除/重新上架)
CLS_CONFIRM_TITLE = "confirmTitle--"  # 确认弹窗标题(「确定要下架这个宝贝吗?」)
CLS_DLG_BTN = "btnChildren--"       # 弹窗按钮(取消/确定)
CLS_PRICE_SYMBOL = "symbol--"       # 详情页价格符(「活动价 ¥」区)

# 网页版滑块文案(「请拖动下方滑块」「请按住滑块」,2026-09-09 实测踩中)2026-09-16 起
# 已并入共用判据 risk_anchors.json,所以这里就是 RISK_ANCHORS 本身——手机流程现在
# 也认得出滑块,反过来本流程也认得出「访问受限/请求频繁」这些原来只有桌面端知道的。
# 名字留着不改:本文件里十几处引用它，改名只是制造 diff。
WEB_RISK_ANCHORS = tuple(RISK_ANCHORS)

_GAP = 2.0        # 页面跳转最小间隔(风控纪律)
_SETTLE = 1.5     # 动作后 settle
_MAX_SWIPES = 8   # 列表滚动收集上限


class StepFail(Exception):
    """单步失败:携带 step/reason/shot,由 run_* 统一收成 result。"""

    def __init__(self, step: str, reason: str, shot: str | None = None):
        super().__init__(reason)
        self.step = step
        self.reason = reason
        self.shot = shot


def _flat(nodes) -> list[dict]:
    """transport.dump_nodes() 的 {center,size} 元组 → 扁平 {cx,cy,w,h}(与手机版一致)。"""
    out = []
    for n in nodes:
        c = n.get("center") or (n.get("cx", 0), n.get("cy", 0))
        s = n.get("size") or (n.get("w", 0), n.get("h", 0))
        out.append({
            "desc": n.get("desc", ""), "cls": n.get("cls", ""),
            "clickable": bool(n.get("clickable")),
            "cx": int(c[0]), "cy": int(c[1]), "w": int(s[0]), "h": int(s[1]),
        })
    return out


def _local_shot_sink(name: str, data: bytes) -> str:
    os.makedirs("shots", exist_ok=True)
    path = os.path.join("shots", f"{int(time.time())}_{name}.png")
    with open(path, "wb") as f:
        f.write(data)
    return path


def _mk_save_shot(t, shot_sink):
    """shot_sink 约定是 (name, data) 双参(storage.save_shot);流程内统一用 save_shot(name)。"""
    sink = shot_sink or _local_shot_sink

    def save_shot(name: str) -> str | None:
        try:
            return sink(name, t.screencap())
        except Exception:
            return None
    return save_shot


# 页面下半截的推荐流是一整片别人的商品,标题随机——法律服务类的标题里就有「申诉」「违规」,
# 文本风控锚点会把它当成风控、熔断冻号(09-09 清理测试品时日志里真出现过一次「命中风控:申诉」)。
# 详情页底下是「为你推荐」(2026-10-17 已售详情页实测:cy≈987 起 30 张推荐卡);
# 首页是「猜你喜欢」那排 tab(2026-10-18 实测:cy=580,下面 20 张推荐卡,保活每 10 分钟开一次首页)。
FEED_HEADERS = ("为你推荐", "猜你喜欢")


def above_feed(nodes) -> list:
    """推荐流以上的节点;页上没有推荐流就原样返回。

    真的风控页(滑块/拦截)整页换掉,不会有推荐流,截掉不漏判;滑块 iframe 另由 risk_punish_active 查。
    弹窗按视口定位,流程不往下滚这些页,弹窗里的字在推荐流分界线上面。
    """
    feed = min((n["cy"] for n in nodes if (n.get("desc") or "").strip() in FEED_HEADERS), default=None)
    return nodes if feed is None else [n for n in nodes if n["cy"] < feed]


def _check_risk(nodes) -> None:
    """dump 文本命中风控锚点 → RiskHit(对齐手机版,网页版另加滑块锚点)。推荐流里的字不算(above_feed)。"""
    for n in above_feed(nodes):
        t = n.get("desc") or ""
        if not t:
            continue
        for anchor in WEB_RISK_ANCHORS:
            if anchor in t:
                raise RiskHit(anchor)


# 2026-09-09 实测(shots/e2e_delete_confirmed.jpg、cleanup_done.png):点「删除」→ 确认弹窗「确定」后
# toast「删除成功」,详情页当场变成「糟糕！宝贝被删掉了」,之后再打开这个 id 也是这句。
_DELETED_MARKS = ("宝贝被删掉了",)
# 2026-11-11 实测(货号 513211540240):参加了无忧卖的链接点「确定」后不删,顶部 toast
# 「为保障无忧卖流量推广效果,请前往「无忧卖-售卖中」修改价格和库存」(用 _wym_blocker 认)。
WUYOUMAI_REASON = "这条链接参加了无忧卖,网页上删不掉(无忧卖先不焕新)"


def _page_deleted(nodes) -> bool:
    return any(mark in (n.get("desc") or "") for n in nodes for mark in _DELETED_MARKS)


def _check_risk_unless_deleted(nodes) -> bool:
    """详情页查风控;「被删掉了」页返回 True 且**不查**。

    这一页是什么我们清楚,真正的风控页(滑块/拦截)不会出现「宝贝被删掉了」。
    下架/重新上架直开详情页也走它:链接焕新删掉的商品,别的流程再打开就是这一页。
    """
    if _page_deleted(nodes):
        return True
    _check_risk(nodes)
    return False


def _ensure_login(t, nodes, h: int, save_shot) -> list:
    """页头有**真实昵称** → 已登录;否则先试快速进入(web/login.py),还没有才 LoginRequired。
    返回最新节点(自救时页面重开过)。

    判定收口在 parse.find_login_nick:未登录时闲鱼**也会**在页头渲染 nick-- 元素,
    文本是「登录」两个字、位置也在页头,光看「元素在且文本非空」会把未登录页判成
    已登录——读聊天于是静默返回 0 个会话(假成功),发消息/上下架则在后面某处报一个
    看不懂的错,而不是那句能直接行动的「未登录」。
    """
    if find_login_nick(nodes, h):
        return nodes
    again = recover_login(t, PERSONAL_URL, _flat, _check_risk)
    if again is not None and find_login_nick(again, h):
        return again
    raise LoginRequired("网页版未登录(/personal 无账号昵称)", save_shot("login_goods"))


def parse_goods_cards(nodes) -> list[dict]:
    """个人中心在售列表卡片 → [{title, price, cx, cy, w, h}](按 cy 升序)。

    2026-09-09 实测结构:卡片=cardWarp--;标题=main-title--;价格=number--(price-wrap-- 内)。
    注意 dump 含视口外节点,调用方点击前须自行把卡片滚进视口并重取坐标。
    """
    cards = []
    for cw in [n for n in nodes if CLS_CARD_WARP in (n.get("cls") or "")]:
        x1, y1 = cw["cx"] - cw["w"] / 2, cw["cy"] - cw["h"] / 2
        x2, y2 = cw["cx"] + cw["w"] / 2, cw["cy"] + cw["h"] / 2
        members = [n for n in nodes if x1 - 2 <= n["cx"] <= x2 + 2
                   and y1 - 2 <= n["cy"] <= y2 + 2 and n is not cw]
        title = next((n["desc"] for n in members
                      if CLS_CARD_TITLE in (n.get("cls") or "") and n["desc"].strip()), None)
        price = None
        for n in members:
            d = n["desc"].strip().replace(",", "")
            if CLS_CARD_PRICE in (n.get("cls") or "") and d.replace(".", "").isdigit():
                try:
                    price = int(round(float(d)))
                except ValueError:
                    pass
        if title:
            cards.append({"title": title.strip(), "price": price, "cx": cw["cx"],
                          "cy": cw["cy"], "w": cw["w"], "h": cw["h"]})
    cards.sort(key=lambda c: c["cy"])
    return cards


def _match_card(cards: list[dict], spec: dict) -> dict:
    """title+price 双锚定位(对齐手机版 locate_row_y):title 精确→前12字包含;
    同名多件用 price 消歧;唯一命中才返回,否则 StepFail——绝不在多商品时盲点。"""
    want = (spec.get("title") or "").strip()
    want_price = spec.get("price")
    if not want:
        raise StepFail("locate_item",
                       "缺 title,网页版列表不支持多商品账号定位,拒绝盲点第一行")
    exact = [c for c in cards if c["title"] == want]
    loose = exact or [c for c in cards if want[:12] and want[:12] in c["title"]]
    if len(loose) > 1 and want_price is not None:
        priced = [c for c in loose if c.get("price") == int(want_price)]
        if len(priced) == 1:
            return priced[0]
        if priced:
            loose = priced
    if len(loose) == 1:
        return loose[0]
    if len(loose) > 1:
        raise StepFail("locate_item",
                       f"标题「{want[:20]}」+价格{want_price} 仍匹配到 {len(loose)} 个商品,拒绝盲选")
    raise StepFail("locate_item",
                   f"在售列表未找到 title={want!r} price={want_price}(已收集卡片 {len(cards)} 个)")


def _scroll_card_into_view(t, card: dict, w: int, h: int) -> dict:
    """把目标卡片滚进视口中部并重取新鲜坐标(dump 坐标随滚动失效,且视口外点击静默无效)。

    返回视口内的新卡片坐标;滚不到(到底了)→ StepFail。
    """
    for _ in range(_MAX_SWIPES):
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes)
        fresh = next((c for c in parse_goods_cards(nodes)
                      if c["title"] == card["title"] and c.get("price") == card.get("price")), None)
        if fresh and h * 0.15 <= fresh["cy"] <= h * 0.9:
            return fresh
        t.swipe(int(w * 0.6), int(h * 0.25), int(w * 0.6), int(h * 0.25) + 500)  # 向下滚
        time.sleep(_SETTLE)
    raise StepFail("locate_item", f"卡片「{card['title'][:16]}」滚 {_MAX_SWIPES} 轮仍未进视口")


def _collect_all_cards(t, w, h) -> list[dict]:
    """滚动收集整个在售列表(虚拟滚动,按 (title, price) 去重合并)。"""
    merged: dict = {}

    def add(nodes):
        for c in parse_goods_cards(nodes):
            merged.setdefault((c["title"], c.get("price")), c)

    add(_flat(t.dump_nodes()))
    for _ in range(_MAX_SWIPES):
        before = len(merged)
        t.swipe(int(w * 0.6), int(h * 0.25), int(w * 0.6), int(h * 0.25) + 500)
        time.sleep(_SETTLE)
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes)
        add(nodes)
        if len(merged) == before:
            break
    return list(merged.values())


def _seller_button(nodes, *texts: str) -> dict | None:
    """详情页卖家按钮:sellerButton-- 且 desc 恰为 texts 之一。"""
    for n in nodes:
        if CLS_SELLER_BTN in (n.get("cls") or "") and (n.get("desc") or "").strip() in texts:
            return n
    return None


def _delisted_state(nodes) -> bool:
    """详情页已下架终态:无「下架」钮,且有「重新上架/上架」钮或「已下架」标记。

    2026-10-15 网页版改版:下架成功后按钮区变「已下架(灰)+删除」、商品图盖「已下架」章,
    不再出现「重新上架」。旧校验只认「重新上架/上架」,下架实际成功也判 FAILED
    (盛色 g4青春版 4 店下架全误判)。「已下架」钮不一定带 sellerButton 类(可能是图章节点),
    故放宽到任意节点文本精确匹配。
    """
    if _seller_button(nodes, "下架"):
        return False
    if _seller_button(nodes, "重新上架", "上架"):
        return True
    return any((n.get("desc") or "").strip() == "已下架" for n in nodes)


def _wym_blocker(nodes) -> str | None:
    """无忧卖拦截 toast(2026-09-09 实测:无忧卖商品网页版下架被平台拦截)。

    文案示例:「为保障无忧卖流量推广效果,请前往『无忧卖-售卖中』修改价格和库存」。
    """
    for n in nodes:
        d = (n.get("desc") or "").strip()
        if "无忧卖" in d and ("前往" in d or "修改" in d):
            return d
    return None


def _dismiss_dialog(t, nodes) -> None:
    """拦截/失败时点弹窗「取消」收起,保持页面干净(绝不对商品做进一步盲点操作)。"""
    cancel = next((n for n in nodes if CLS_DLG_BTN in (n.get("cls") or "")
                   and (n.get("desc") or "").strip() == "取消"), None)
    if cancel:
        try:
            t.tap(cancel["cx"], cancel["cy"])
            time.sleep(1.0)
        except Exception:
            pass


def _click_dialog_confirm(t, nodes, save_shot, step: str) -> None:
    """确认弹窗点「确定」(btnChildren--)。弹窗/确定按钮缺失 → StepFail,绝不盲点。"""
    dlg = [n for n in nodes if CLS_CONFIRM_TITLE in (n.get("cls") or "")]
    if not dlg:
        raise StepFail(step, "点操作后未出现确认弹窗", save_shot(f"{step}_no_dialog"))
    d = dlg[0]
    x1, y1 = d["cx"] - 400, d["cy"] - 120
    x2, y2 = d["cx"] + 400, d["cy"] + 200
    ok = [n for n in nodes if CLS_DLG_BTN in (n.get("cls") or "")
          and (n.get("desc") or "").strip() in ("确定", "确认", "继续")
          and x1 <= n["cx"] <= x2 and y1 <= n["cy"] <= y2]
    if not ok:
        raise StepFail(step, "确认弹窗内未找到「确定」按钮", save_shot(f"{step}_no_ok_btn"))
    t.tap(ok[0]["cx"], ok[0]["cy"])
    time.sleep(2.0)


def _item_id_from_url(url: str) -> str | None:
    m = re.search(r"[?&]id=(\d+)", url or "")
    return m.group(1) if m else None


def _wait_item_url(t, timeout: float = 20.0) -> str:
    """新 tab URL 从 spm 形态跳 item?id= 形态(2026-09-09 实测),轮询等到 id= 出现。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        url = t.page.url
        if _item_id_from_url(url):
            return url
        time.sleep(0.5)
    raise StepFail("open_item", f"新 tab URL 未出现 id= 参数:{t.page.url}")


_DETAIL_TITLE_BAD = re.compile(
    r"http|userId|闲鱼号|¥|￥|人想要|浏览|活动价|自提|^\d"
    r"|发闲置|商品码|反馈|客服|^消息$|^APP$|搜索|订单"
    # 平台服务徽标:整节点就是这几个字才算噪声,**不能用包含**——真实标题里
    # 完全可能带「包邮」(如「HKC显示器 包邮」),包含匹配会把正经标题也滤掉。
    # 2026-09-10 生产:下架时详情页标题解析成「包邮」,身份校验不过被拒。
    r"|^包邮$|^免运费$|^验货宝$|^运费险$")


def _detail_identity(nodes) -> tuple[str | None, int | None]:
    """详情页身份 → (title, price)。价格区=symbol--(「活动价 ¥」)同行 ±100px 分带:
    价格=¥ 旁纯数字节点(¥ 与数字是兄弟节点,2026-09-09 实测);
    标题=带内排除价/统计/链接/卖家信息噪声后离价格行最近的文本。
    2026-09-09 实测:网页版详情页无独立标题节点,正文在 desc-- 节点(标题首行+「感兴趣
    的话点我想要」尾行,总长可超 40 字);±100px 分带同时罩住顶部卖家信息条
    (item-user-info-- 的昵称/城市/信用标签,如「杭州」「刚刚擦亮」),不排除会误当标题。"""
    sym = next((n for n in nodes if CLS_PRICE_SYMBOL in (n.get("cls") or "")), None)
    if not sym:
        return None, None
    band = [n for n in nodes if abs(n["cy"] - sym["cy"]) < 100]
    price = None
    nums = [n for n in band if n["cx"] > sym["cx"] - 60
            and re.fullmatch(r"\d[\d,]*(\.\d{1,2})?", (n.get("desc") or "").strip())]
    if nums:
        nums.sort(key=lambda n: abs(n["cx"] - sym["cx"]))
        price = int(round(float(nums[0]["desc"].strip().replace(",", ""))))
    cands = [n for n in band if (n.get("desc") or "").strip()
             and not _DETAIL_TITLE_BAD.search(n["desc"])
             and "item-user-info" not in (n.get("cls") or "")
             and "sidebar" not in (n.get("cls") or "")
             and 1 <= len(n["desc"].strip()) <= 80]
    title = None
    if cands:
        cands.sort(key=lambda n: (abs(n["cy"] - sym["cy"]), len(n["desc"])))
        title = cands[0]["desc"].strip()
    return title, price


def _open_personal(t, save_shot) -> tuple[int, int, list[dict]]:
    """goto 个人中心 → 登录态/风控检查 → (w, h, nodes)。"""
    t.launch_app(PERSONAL_URL)
    time.sleep(4)
    w, h = t.screen_size()
    nodes = _flat(t.dump_nodes())
    _check_risk(nodes)
    nodes = _ensure_login(t, nodes, h, save_shot)
    return w, h, nodes


def _refresh_personal_cards(t, w, h) -> list[dict]:
    """当前 tab goto 个人中心并刷新,收集在售卡片(结果校验用:卡片消失/复现是真值)。

    直接复用流程自己的 tab(列表校验前详情页已不用再看了);SPA 内状态不自动更新,须强制 goto。
    """
    t.launch_app(PERSONAL_URL)
    time.sleep(4)
    nodes = _flat(t.dump_nodes())
    _check_risk(nodes)
    return _collect_all_cards(t, w, h)


# ---------------------------------------------------------------- 下架
def run_delist_web(transport, spec: dict, shot_sink=None) -> dict:
    """网页版下架:item_id 直开详情页(退化到卡片定位)→「下架」→ 确认弹窗「确定」
    → 校验(详情页按钮态 + 复核)。"""
    t = transport
    save_shot = _mk_save_shot(t, shot_sink)
    result = {"ok": True, "done": ["delist"], "failed_step": None,
              "reason": None, "shot": None, "risk": None}
    try:
        spec = spec or {}
        w, h, nodes = _open_personal(t, save_shot)   # 先过登录态检查

        # 定位:有 item_id 一律直开详情页——item_id 是平台主键,比 title 强得多。
        # 卡片路径靠 title+price 猜,而 spec.title 来自 Listing.title(存的是描述前缀),
        # 发布时开了 ai_rewrite,跟闲鱼上的真实标题根本对不上;同标同价的多件还会被
        # _collect_all_cards 按 (title,price) 去重合并成一张卡,另一件直接消失。
        # 2026-09-10 生产:两条下架,一条点开了另一件(被 itemId 闸拦下,未误删)。
        # relist 早就是详情页直开(网页版没有已下架列表),这里对齐它。
        card = None
        if spec.get("item_id"):
            time.sleep(_GAP)
            t.launch_app(ITEM_URL.format(spec["item_id"]))
            time.sleep(4)
            item_id = _item_id_from_url(t.page.url)
            if item_id != str(spec["item_id"]):
                raise StepFail("open_item",
                               f"详情页直开未落到目标商品(url itemId={item_id},"
                               f"want={spec['item_id']}),拒绝操作",
                               save_shot("delist_open"))
            nodes = _flat(t.dump_nodes())
            if _check_risk_unless_deleted(nodes):
                raise StepFail("open_item", f"商品 {item_id} 已经被删掉了(链接焕新删的或有人手工删过),不用再下架",
                               save_shot("delist_deleted"))
            logger.info("下架目标(直开):item_id=%s", item_id)
        else:
            cards = _collect_all_cards(t, w, h)
            card = _match_card(cards, spec)
            logger.info("下架目标卡片:「%s」¥%s @(%s,%s)", card["title"], card.get("price"),
                        card["cx"], card["cy"])
            time.sleep(_GAP)

            # 点卡片(滚进视口后取新鲜坐标;点图片区=卡片上部,2026-09-09 实测可开新 tab)
            fresh = _scroll_card_into_view(t, card, w, h)
            t.tap(fresh["cx"], int(fresh["cy"] - fresh["h"] / 2 + 120))
            t.wait_new_tab(contains="/item")
            url = _wait_item_url(t)
            time.sleep(2)
            item_id = _item_id_from_url(url)
            nodes = _flat(t.dump_nodes())
            _check_risk(nodes)
            dt, dp = _detail_identity(nodes)
            logger.info("详情页:「%s」¥%s (id=%s)", dt, dp, item_id)

            # 卡片路径没有可信主键,详情页身份必须校验
            # (title 模糊包含,详情页标题可能截断,取 spec.title[:12] 反向包含)
            want = (spec.get("title") or "").strip()
            if want and dt and want[:12] not in dt and dt[:12] not in want:
                raise StepFail("open_item",
                               f"详情页标题「{dt}」与 spec.title「{want[:20]}」不符,拒绝操作",
                               save_shot("delist_identity"))
        btn = _seller_button(nodes, "下架")
        if not btn:
            # 幂等:已在下架终态(上次下架其实成功了但旧校验误判 FAILED,重试会直接落到这)
            if _delisted_state(nodes):
                logger.info("详情页已是下架终态,视作已下架:item_id=%s", item_id)
                result["item_id"] = item_id
                result["shot"] = save_shot("delist_already")
                return result
            raise StepFail("delist", "详情页未找到「下架」按钮(可能已下架/已售出)",
                           save_shot("miss_delist_btn"))
        t.tap(btn["cx"], btn["cy"])
        time.sleep(2.5)
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes)
        _click_dialog_confirm(t, nodes, save_shot, "delist")
        shot_ok = save_shot("delist_confirmed")

        # 结果校验①:详情页按钮态(下架消失/出现重新上架),轮询 12s;
        # 无忧卖拦截 toast 检出即失败(平台拦,非点击问题),点「取消」收弹窗保持干净
        deadline = time.time() + 12
        detail_ok = False
        blocked = None
        while time.time() < deadline:
            nodes = _flat(t.dump_nodes())
            _check_risk(nodes)
            blocked = _wym_blocker(nodes)
            if blocked:
                break
            if _delisted_state(nodes):
                detail_ok = True
                break
            time.sleep(1.5)
        if blocked:
            _dismiss_dialog(t, nodes)
            raise StepFail("delist", f"下架被平台拦截(无忧卖商品):{blocked}",
                           save_shot("delist_blocked"))

        # 结果校验②:确认状态是持久的,不是一次性 UI 反馈
        time.sleep(_GAP)
        if card is not None:
            # 卡片路径:回个人中心列表,目标卡片消失(对齐手机版 list_cards 真值校验)
            cards_after = _refresh_personal_cards(t, w, h)
            gone = not any(c["title"] == card["title"] and c.get("price") == card.get("price")
                           for c in cards_after)
        else:
            # 直开路径:重新载入该 item 详情页看按钮态。**不用「列表卡片消失」**——
            # 那个按 (title,price) 比对,同标同价的两件分不开:下架掉其中一件后,
            # 去重后的卡片集合毫无变化,会误判成没生效。
            t.launch_app(ITEM_URL.format(spec["item_id"]))
            time.sleep(4)
            nodes_after = _flat(t.dump_nodes())
            _check_risk(nodes_after)
            gone = _delisted_state(nodes_after)
        if not (detail_ok and gone):
            raise StepFail("delist",
                           f"下架未生效(详情页按钮态={detail_ok},复核={gone})",
                           shot_ok)
        result["shot"] = shot_ok
        result["item_id"] = item_id
    except RiskHit as ex:
        result = {"ok": False, "done": [], "failed_step": "delist",
                  "reason": str(ex), "shot": ex.shot, "risk": ex.anchor}
    except LoginRequired as ex:
        result = {"ok": False, "done": [], "failed_step": "delist",
                  "reason": ex.reason, "shot": ex.shot, "risk": None, "login": True}
    except FlowTimeout as ex:
        result = {"ok": False, "done": [], "failed_step": "delist",
                  "reason": str(ex), "shot": None, "risk": None}
    except StepFail as ex:
        result = {"ok": False, "done": [], "failed_step": ex.step,
                  "reason": ex.reason, "shot": ex.shot, "risk": None}
    except Exception as ex:
        logger.warning("delist_web 未预期异常: %s", ex)
        result = {"ok": False, "done": [], "failed_step": "delist",
                  "reason": str(ex), "shot": None, "risk": None}
    return result


# ---------------------------------------------------------------- 重新上架
def run_relist_web(transport, spec: dict, shot_sink=None) -> dict:
    """网页版重新上架:网页版**没有已下架列表**(2026-09-09 实测,见模块 docstring),
    故走详情页直开:/item?id=<spec.item_id> → 详情页身份校验(title+price)→「重新上架」
    → 若有确认弹窗点确定 → 校验(详情页出现「下架」按钮 = 回到在售 + 列表卡片复现)。"""
    t = transport
    save_shot = _mk_save_shot(t, shot_sink)
    result = {"ok": True, "done": ["relist"], "failed_step": None,
              "reason": None, "shot": None, "risk": None}
    try:
        spec = spec or {}
        if not spec.get("item_id"):
            raise StepFail("open_item", "网页版无已下架列表,relist 必须给 item_id 直开详情页")
        w, h, _ = _open_personal(t, save_shot)   # 先过登录态检查
        time.sleep(_GAP)

        t.launch_app(ITEM_URL.format(spec["item_id"]))
        time.sleep(4)
        nodes = _flat(t.dump_nodes())
        if _check_risk_unless_deleted(nodes):
            raise StepFail("open_item", f"商品 {spec['item_id']} 已经被删掉了,没法重新上架",
                           save_shot("relist_deleted"))
        if not _item_id_from_url(t.page.url):
            raise StepFail("open_item", f"详情页未加载(item_id={spec['item_id']})",
                           save_shot("relist_open"))

        # 详情页身份校验(title+price 双锚,防对错误商品上架)
        dt, dp = _detail_identity(nodes)
        want = (spec.get("title") or "").strip()
        if want and dt and want[:12] not in dt and dt[:12] not in want:
            raise StepFail("open_item", f"详情页标题「{dt}」与 spec.title「{want[:20]}」不符,拒绝操作",
                           save_shot("relist_identity"))
        if spec.get("price") is not None and dp is not None and dp != int(spec["price"]):
            raise StepFail("open_item",
                           f"详情页价格 ¥{dp} 与 spec.price={spec['price']} 不符,拒绝操作",
                           save_shot("relist_identity"))
        btn = _seller_button(nodes, "重新上架", "上架")
        if not btn:
            raise StepFail("relist", "详情页未找到「重新上架」按钮(可能已在售或页面结构变化)",
                           save_shot("miss_relist_btn"))
        t.tap(btn["cx"], btn["cy"])
        time.sleep(2.5)
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes)
        # 重新上架可能直接生效或再弹确认框(未侦察到的分支):有弹窗才点确定,没有不盲点
        if any(CLS_CONFIRM_TITLE in (n.get("cls") or "") for n in nodes):
            _click_dialog_confirm(t, nodes, save_shot, "relist")
        shot_ok = save_shot("relist_submitted")

        # 结果校验①:详情页出现「下架」按钮(回到在售态),轮询 15s
        deadline = time.time() + 15
        detail_ok = False
        while time.time() < deadline:
            nodes = _flat(t.dump_nodes())
            _check_risk(nodes)
            if _seller_button(nodes, "下架"):
                detail_ok = True
                break
            time.sleep(1.5)

        # 结果校验②:回个人中心在售列表,目标卡片复现
        time.sleep(_GAP)
        want_price = spec.get("price")
        cards_after = _refresh_personal_cards(t, w, h)
        back = any(c["title"] == want or (want[:12] and want[:12] in c["title"])
                   for c in cards_after
                   if want_price is None or c.get("price") == int(want_price))
        if not (detail_ok and back):
            raise StepFail("relist",
                           f"重新上架未生效(详情页回在售={detail_ok},列表卡片复现={back})",
                           shot_ok)
        result["shot"] = shot_ok
        result["item_id"] = str(spec["item_id"])
    except RiskHit as ex:
        result = {"ok": False, "done": [], "failed_step": "relist",
                  "reason": str(ex), "shot": ex.shot, "risk": ex.anchor}
    except LoginRequired as ex:
        result = {"ok": False, "done": [], "failed_step": "relist",
                  "reason": ex.reason, "shot": ex.shot, "risk": None, "login": True}
    except FlowTimeout as ex:
        result = {"ok": False, "done": [], "failed_step": "relist",
                  "reason": str(ex), "shot": None, "risk": None}
    except StepFail as ex:
        result = {"ok": False, "done": [], "failed_step": ex.step,
                  "reason": ex.reason, "shot": ex.shot, "risk": None}
    except Exception as ex:
        logger.warning("relist_web 未预期异常: %s", ex)
        result = {"ok": False, "done": [], "failed_step": "relist",
                  "reason": str(ex), "shot": None, "risk": None}
    return result


# ---------------------------------------------------------------- 删除(链接焕新)
def run_delete_web(transport, spec: dict, shot_sink=None) -> dict:
    """网页版删除链接(链接焕新的第一段,见 jobs.create_refresh_listing):
    item_id 直开详情页 →「删除」→ 确认弹窗「确定」→ 重开详情页见「宝贝被删掉了」才算数。

    - 只认 item_id:删了撤不回来,下架那种按标题+价格认卡片的路子这里不走。
    - 打开就已经是「被删掉了」(上一轮删成了却没等到确认就超时、或有人手工删过)→ 算成功,
      否则这条链接会一直卡着、永远轮不到重发。但先回在售列表确认没有同标题同价的链接还挂着:
      账本里的 item_id 万一不是这件货,「已删」就是假的,接着重发会让一件货挂两条链接。
    - 参加了无忧卖的删不掉(2026-11-11 实测,09-09 时还删得掉):点「确定」后 toast 提示去
      「无忧卖-售卖中」改,认出来就回 wuyoumai=True,焕新那边把这条链接排掉。
    """
    t = transport
    save_shot = _mk_save_shot(t, shot_sink)
    result = {"ok": True, "done": ["delete"], "failed_step": None,
              "reason": None, "shot": None, "risk": None}
    try:
        spec = spec or {}
        item_id = str(spec.get("item_id") or "")
        if not item_id:
            raise StepFail("open_item", "删除必须给 item_id(删了撤不回来,不按标题猜)")
        w, h, _ = _open_personal(t, save_shot)   # 先过登录态检查
        time.sleep(_GAP)

        t.launch_app(ITEM_URL.format(item_id))
        time.sleep(4)
        got = _item_id_from_url(t.page.url)
        if got != item_id:
            raise StepFail("open_item",
                           f"详情页直开未落到目标商品(url itemId={got},want={item_id}),拒绝操作",
                           save_shot("delete_open"))
        nodes = _flat(t.dump_nodes())
        if _check_risk_unless_deleted(nodes):
            want = (spec.get("title") or "").strip()
            if want:
                time.sleep(_GAP)
                cards = _refresh_personal_cards(t, w, h)
                twins = [c for c in cards if c["title"] == want
                         and (spec.get("price") is None or c.get("price") == int(spec["price"]))]
                if twins:
                    raise StepFail("delete",
                                   f"item_id={item_id} 已是「被删掉了」,但在售列表里还有同标题同价的"
                                   f"「{want[:16]}」,账本 id 可能不对,交人工核对",
                                   save_shot("delete_twin"))
            logger.info("删除:item_id=%s 打开就是「被删掉了」,当作已删", item_id)
            result["already_deleted"] = True
            result["item_id"] = item_id
            return result

        btn = _seller_button(nodes, "删除")
        if not btn:
            raise StepFail("delete", "详情页没有「删除」按钮(可能已卖出/交易中,或不是本账号的商品)",
                           save_shot("miss_delete_btn"))
        t.tap(btn["cx"], btn["cy"])
        time.sleep(2.5)
        nodes = _flat(t.dump_nodes())
        _check_risk(nodes)
        _click_dialog_confirm(t, nodes, save_shot, "delete")
        shot_ok = save_shot("delete_confirmed")
        # 只认拦截 toast(「…请前往『无忧卖-售卖中』修改…」):页面上本来就可能有带「无忧卖」三个字的角标/入口,
        # 原来整页任何节点含这三个字就判删不掉、不再核实,误判时链接其实删了、账本还在架又标成不焕新
        if _wym_blocker(_flat(t.dump_nodes())):
            return {"ok": False, "done": [], "failed_step": "delete", "reason": WUYOUMAI_REASON,
                    "shot": shot_ok, "risk": None, "wuyoumai": True, "item_id": item_id}

        # 校验:重开详情页见「被删掉了」。删完当前页会自己刷成那句,但只认重开后的——
        # 持久状态才算数,别把还没来得及变的旧页面当结果。
        gone = False
        for _ in range(3):
            time.sleep(_GAP)
            t.launch_app(ITEM_URL.format(item_id))
            time.sleep(4)
            if _check_risk_unless_deleted(_flat(t.dump_nodes())):
                gone = True
                break
        if not gone:
            raise StepFail("delete", "点了删除并确认,重开详情页仍不是「宝贝被删掉了」", shot_ok)
        result["shot"] = shot_ok
        result["item_id"] = item_id
    except RiskHit as ex:
        result = {"ok": False, "done": [], "failed_step": "delete",
                  "reason": str(ex), "shot": ex.shot, "risk": ex.anchor}
    except LoginRequired as ex:
        result = {"ok": False, "done": [], "failed_step": "delete",
                  "reason": ex.reason, "shot": ex.shot, "risk": None, "login": True}
    except FlowTimeout as ex:
        result = {"ok": False, "done": [], "failed_step": "delete",
                  "reason": str(ex), "shot": None, "risk": None}
    except StepFail as ex:
        result = {"ok": False, "done": [], "failed_step": ex.step,
                  "reason": ex.reason, "shot": ex.shot, "risk": None}
    except Exception as ex:
        logger.warning("delete_web 未预期异常: %s", ex)
        result = {"ok": False, "done": [], "failed_step": "delete",
                  "reason": str(ex), "shot": None, "risk": None}
    return result


# ---------------------------------------------------------------- 改价
def run_reprice_web(transport, spec: dict, shot_sink=None) -> dict:
    """网页版改价:**无能力,明确失败**(2026-09-09 实测排查,结论写进模块 docstring):
    ① 自己的详情页卖家按钮只有「下架/删除」,无「编辑/改价」;
    ② /publish?id=<itemId> 是空白新发表单(图片/描述/价格全空),**不是**编辑模式;
    ③ 个人中心无「已下架」tab,「筛选」下拉只有包邮/验货宝,「宝贝管理」是 APP 扫码弹窗。
    改价请走手机版 goods_reprice(reprice_flow.py)。"""
    logger.info("goods_reprice web 版无改价入口(2026-09-09 实测),明确失败")
    return {"ok": False, "done": [], "failed_step": "reprice",
            "reason": "闲鱼网页版无改价入口(详情页无编辑按钮;/publish?id= 为空白新发表单;"
                       "无其它管理入口,2026-09-09 实测),改价请走手机版 goods_reprice",
            "shot": None, "risk": None}

"""闲鱼网页版(goofish.com/im)dump_nodes 纯解析。输入与 chat_parse 同构:{desc,cls,clickable,cx,cy,w,h}。

cls 约定(2026-09-09 AdsPower 指纹浏览器 + 闲鱼网页版实测,dump 由执行端/LocalPlaywrightTransport 产出):
- cls 带 tag 前缀(如 "div conversation-item--xxx"/"textarea ant-input"),无 className 的元素只有 tag。
- <a> 的 href 追加进 desc(如 "闲鱼号 https://www.goofish.com/personal?userId=811892395")。
- 未读角标 sup.ant-badge-count 的数字放 desc(title 属性值)。
- <img> 节点额外带 src 字段(2026-10-10 起,取 currentSrc||src,截 500;协议相对 URL 原样,
  由 _parse_item_image 归一化)——其余节点没有该字段,保持结构稳定。老执行端 dump 无 src。

DOM 来源(2026-09-09 实测):
- 会话列表:左侧栏 .rc-virtual-list(虚拟滚动,视口外行不渲染,未读会话可能要滚列表才出现)。
  行=div[class*="conversation-item--"](行高 68);昵称/最后消息/时间是无特征 class 的裸 div,**按行内 cy 分带取**;
  未读数=sup.ant-badge-count(title="N");订单状态=div[class*="order-wait--"](如「等待买家收货」)。
- 聊天页:顶栏 div[class*="message-topbar--"],昵称 span[class*="text1--"],掩码会员名 span[class*="text2--"],
  「闲鱼号」a[href*="personal?userId="];商品卡在顶栏下方(图+价,标题常缺省,取最长非按钮文本兜底)。
  消息行 div[class*="message-row--"](in 行含 message-text-left--,out 卡含 msg-text-right--);
  气泡文本=裸 span(在 message-text--/message-content-- 容器内);卡片消息=msg-dx-title--+msg-dx-desc-- 拼接;
  系统提示行 div[class*="msg-tips--"](如「卖家已发货」,跳过);时间分隔=整宽(h≈39)裸 div「昨天 02:02」。
  注意:message-list-reverse 只是倒序渲染的实现,屏幕上和普通聊天一样**最新在底部,cy 越大消息越新**
  (2026-09-09 侦察 dump:分隔行「昨天 02:02」「昨天 02:07」「02:02」cy 依次变大);按 cy 升序 = 老→新。
  时间分隔行在它那组消息上方,时间戳附给 cy 更大的后续消息。dump 带全部已渲染的行,视口外的 cy 可为负。
"""
import re
from datetime import datetime, timedelta

# ==================== 会话列表(/im 左侧栏) ====================
CLS_CONV_ITEM = "conversation-item--"       # 会话行容器(行高~68)
CLS_BADGE = ("ant-badge-count", "ant-scroll-number")  # 未读角标(desc=数字)
CLS_ORDER_WAIT = "order-wait--"             # 订单状态(「等待买家收货」…)
CLS_LOGIN_NICK = "nick--"                   # 页头登录昵称(判登录态用)
# ⚠️ 未登录时闲鱼**也会**渲染这个元素,文本是「登录」两个字,位置同样在页头
# (实测 class=nick--RyNYtDXM, text=登录, top=26)。所以「元素在且文本非空」并不
# 等于已登录——必须把登录入口自身的文案排掉,否则未登录页会被判成已登录:
# 读聊天静默返回 0 个会话(假成功),发消息/上下架则在后面某处报一个看不懂的错,
# 而不是那句能直接行动的「未登录」。
LOGIN_ENTRY_TEXTS = {"登录", "登录/注册", "注册/登录", "请登录", "立即登录",
                     "登录注册", "sign in", "signin", "login"}


def is_logged_in_nick(desc: str | None) -> bool:
    """页头 nick-- 元素的文本是不是一个真实昵称(而非登录入口文案)。"""
    text = (desc or "").strip()
    return bool(text) and text.lower() not in LOGIN_ENTRY_TEXTS


def find_login_nick(nodes, h: int) -> str | None:
    """在页头区域找已登录昵称;没有返回 None。三条流程共用,避免各自复制一份。"""
    for n in nodes:
        if CLS_LOGIN_NICK in (n.get("cls") or "") and n.get("cy", 0) < h * 0.15 \
                and is_logged_in_nick(n.get("desc")):
            return (n.get("desc") or "").strip()
    return None

# ==================== 聊天页 ====================
CLS_TOPBAR = "message-topbar--"             # 聊天页顶栏(进会话校验锚)
CLS_PEER_NICK = "text1--"                   # 顶栏对方昵称
CLS_PEER_MASK = "text2--"                   # 顶栏掩码会员名 (t***2)
CLS_MSG_ROW = "message-row--"               # 消息行
CLS_MSG_WRAPPER = ("message-text--", "message-content--")  # 气泡文本容器
CLS_MSG_IN = "message-text-left--"          # in(买家)气泡
CLS_MSG_OUT = ("msg-text-right--", "message-text-right--")  # out(卖家/自己)
CLS_MSG_DX_TITLE = "msg-dx-title--"         # 卡片消息标题
CLS_MSG_DX_DESC = "msg-dx-desc--"           # 卡片消息副文案
CLS_MSG_TIPS = "msg-tips--"                 # 系统提示行(「卖家已发货」,非消息)
CLS_TEXTAREA = ("textarea", "ant-input")    # 聊天输入框(进会话校验锚)
CLS_MSG_LIST = "message-list-reverse--"     # 消息列表容器(倒序渲染,屏幕上最新在底部:cy 大=消息新)

_RE_USER_ID = re.compile(r"userId=(\d+)")
# 时间分隔行:「02:02」「昨天 02:02」「前天 02:02」「9月7日 02:02」「2026-09-07 02:02」「09-07 02:02」
_TS_TIME = r"(\d{1,2}):(\d{2})"
RE_TS = re.compile(
    rf"^(今天\s*)?{_TS_TIME}$"
    rf"|^昨天\s*{_TS_TIME}$"
    rf"|^前天\s*{_TS_TIME}$"
    rf"|^(\d{{1,2}})月(\d{{1,2}})日\s*{_TS_TIME}$"
    rf"|^(\d{{4}})-(\d{{1,2}})-(\d{{1,2}})\s*{_TS_TIME}$"
    rf"|^(\d{{1,2}})-(\d{{1,2}})\s*{_TS_TIME}$"
)
# 会话行时间(「40分钟前」「3小时前」「昨天」…)——最后消息分带排除用
_RE_LIST_TIME = re.compile(r"^\d+\s*分钟前$|^\d+\s*小时前$|^昨天$|^前天$|^\d+天前$|^" + _TS_TIME + r"$")
# 商品卡区域里不是标题的文本(2026-09-09 实测:虚拟商品卡只有图+价,无标题)
_RE_ITEM_NOISE = re.compile(r"^¥|含运费|交易中$|元$")
# 商品卡价格文本:「¥1588.00」→ 数字串(千分位逗号在取组后去掉)
_RE_ITEM_PRICE_TXT = re.compile(r"^¥\s*([\d,]+\.?\d*)")

_LIST_EXCLUDE_TEXT = {"消息", "清除未读", "设置提示音", "reminder"}
_ORDER_STATUS = {
    "等待买家收货", "等待你发货", "等待付款", "等待卖家发货", "待发货", "待收货",
    "交易成功", "已发货", "等待见面交易", "退款中", "退款成功", "已关闭",
    "卖家发送站外信息", "买家发送站外信息",
}


def _text(n):
    return (n.get("desc") or "").strip()


def _has_cls(n, *pats) -> bool:
    cls = n.get("cls") or ""
    return any(p in cls for p in pats)


def _is_img_node(n) -> bool:
    """img 节点:cls 首段是 tag 名 img(local_transport 带 tag 前缀),或 cls 含 img--(执行端
    css-modules className,无 class 时兜底 cls="img")。与消息行过滤(:263)同一判据。"""
    cls = (n.get("cls") or "").strip()
    return cls.split(" ")[0] == "img" or "img--" in cls


def _rect(n):
    cx, cy = n["cx"], n["cy"]
    w, h = n["w"], n["h"]
    return cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2


def _contains(outer, n) -> bool:
    x1, y1, x2, y2 = _rect(outer)
    return x1 <= n["cx"] <= x2 and y1 <= n["cy"] <= y2


def parse_ts(text: str, now: datetime | None = None) -> str | None:
    """时间分隔行文本 → ISO 字符串(YYYY-MM-DDTHH:MM:00)。解析不了返回 None(不阻塞)。"""
    t = (text or "").strip()
    now = now or datetime.now()
    day = now.date()
    hm = r"(\d{1,2}):(\d{2})"
    m = re.match(rf"^(?:今天\s*)?{hm}$", t)
    if m:
        hh, mm = int(m.group(1)), int(m.group(2))
    elif (m := re.match(rf"^昨天\s*{hm}$", t)):
        hh, mm = int(m.group(1)), int(m.group(2))
        day -= timedelta(days=1)
    elif (m := re.match(rf"^前天\s*{hm}$", t)):
        hh, mm = int(m.group(1)), int(m.group(2))
        day -= timedelta(days=2)
    elif (m := re.match(rf"^(\d{{1,2}})月(\d{{1,2}})日\s*{hm}$", t)):
        mon, dom, hh, mm = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4))
        day = day.replace(month=mon, day=dom)
        if day > now.date():                   # 跨年(1 月看去年 12 月)
            day = day.replace(year=day.year - 1)
    elif (m := re.match(rf"^(\d{{4}})-(\d{{1,2}})-(\d{{1,2}})\s*{hm}$", t)):
        return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}T{int(m.group(4)):02d}:{int(m.group(5)):02d}:00"
    elif (m := re.match(rf"^(\d{{1,2}})-(\d{{1,2}})\s*{hm}$", t)):
        mon, dom, hh, mm = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4))
        day = day.replace(month=mon, day=dom)
        if day > now.date():
            day = day.replace(year=day.year - 1)
    else:
        return None
    return f"{day.isoformat()}T{hh:02d}:{mm:02d}:00"


# ==================== 会话列表 ====================
def parse_conversation_list_web(nodes, w, h):
    """→ [{row_cx, row_cy, nick, unread, order_status, last_message}](按 cy 升序)。

    行=conversation-item 容器;昵称/最后消息/时间是无特征裸 div,按行内 cy 分带:
    昵称带=行顶~+26px,消息带=+26~+48px,时间带=+48px 以下(2026-09-09 实测行高 68)。
    未读数=行带内的 ant-badge-count(desc=纯数字)。skeleton 行(无昵称)跳过。
    """
    items = [n for n in nodes if _has_cls(n, CLS_CONV_ITEM)]
    if not items:
        return []
    out = []
    for it in sorted(items, key=lambda n: n["cy"]):
        x1, y1, x2, y2 = _rect(it)
        members = [n for n in nodes if y1 - 2 <= n["cy"] <= y2 + 2 and x1 - 2 <= n["cx"] <= x2 + 2
                   and n is not it]
        # skeleton 占位行:无文本成员
        if not any(_text(m) for m in members):
            continue
        nick = last_message = order_status = None
        unread = 0
        for m in members:
            t = _text(m)
            if not t:
                continue
            if _has_cls(m, CLS_ORDER_WAIT) or t in _ORDER_STATUS:
                order_status = order_status or t
                continue
            if any(b in (m.get("cls") or "") for b in CLS_BADGE) and t.isdigit():
                unread = int(t)
                continue
            if t in _LIST_EXCLUDE_TEXT or _RE_LIST_TIME.match(t):
                continue
            dy = m["cy"] - y1
            if dy < 26:                        # 昵称带
                if nick is None and len(t) <= 30 and m["w"] >= 20:
                    nick = t
            elif dy < 48:                      # 最后消息带
                if last_message is None:
                    last_message = t
        if not nick:
            continue
        out.append({
            "row_cx": it["cx"], "row_cy": it["cy"],
            "nick": nick, "unread": unread,
            "order_status": order_status, "last_message": last_message,
        })
    return out


# ==================== 聊天页 ====================
def _find(nodes, cls_pat):
    return [n for n in nodes if cls_pat in (n.get("cls") or "")]


def parse_chat_page_web(nodes, w, h):
    """→ {peer_key, peer_nick, item_title, item_price, messages:[{direction, text, msg_at}]}。

    peer_key 优先 personal?userId=<数字>(最稳定),取不到用顶栏掩码会员名(对齐手机版),
    都没有返回 peer_key=None(调用方跳过该会话,防幻影会话裂变)。
    """
    peer_nick = peer_key = item_title = item_price = item_image = item_id = None
    topbar = _find(nodes, CLS_TOPBAR)
    if topbar:
        tb = min(topbar, key=lambda n: n["w"] * n["h"])
        for n in _find(nodes, CLS_PEER_NICK):
            if _contains(tb, n) and _text(n):
                peer_nick = _text(n)
                break
        for n in _find(nodes, CLS_PEER_MASK):
            if _contains(tb, n) and _text(n):
                peer_key = _text(n).strip("()（）") or None
                break
    for n in nodes:
        m = _RE_USER_ID.search(n.get("desc") or "")
        if m:
            peer_key = m.group(1)              # userId 最稳,覆盖掩码
            break

    rows = sorted(_find(nodes, CLS_MSG_ROW), key=lambda n: n["cy"])
    msgs = []
    now = datetime.now()
    if rows:
        chat_left = min(_rect(r)[0] for r in rows)
        chat_right = max(_rect(r)[2] for r in rows)
        # 时间分隔行:整宽(~消息区宽)裸 div,文本命中时间格式
        ts_list = []
        for n in nodes:
            t = _text(n)
            if not t or not RE_TS.match(t):
                continue
            nw = n["w"]
            if nw >= (chat_right - chat_left) * 0.8 and n["h"] <= 50:
                ts_list.append((n["cy"], parse_ts(t, now)))
        ts_list.sort()
        item_title = _parse_item_title(nodes, rows, chat_left, chat_right)
        item_price = _parse_item_price(nodes, rows, chat_left, chat_right)
        item_image = _parse_item_image(nodes, rows, chat_left, chat_right)
        item_id = _parse_item_id(nodes, rows, chat_left, chat_right)

        for r in rows:
            band = [n for n in nodes if _rect(r)[1] - 2 <= n["cy"] <= _rect(r)[3] + 2
                    and chat_left - 5 <= n["cx"] <= chat_right + 5 and n is not r]
            if any(_has_cls(n, CLS_MSG_TIPS) for n in band):
                continue                       # 系统提示行(「卖家已发货」)非消息
            if any(CLS_MSG_IN in (n.get("cls") or "") for n in band):
                direction = "in"
            elif any(p in (n.get("cls") or "") for n in band for p in CLS_MSG_OUT):
                direction = "out"
            else:
                continue                       # 判不了方向的行(异常卡)跳过
            # 卡片消息:title+desc 拼接
            title = next((_text(n) for n in band if CLS_MSG_DX_TITLE in (n.get("cls") or "")), None)
            sub = next((_text(n) for n in band if CLS_MSG_DX_DESC in (n.get("cls") or "")), None)
            if title:
                text = " ".join(x for x in (title, sub) if x)
            else:
                # 普通气泡:取包裹在 message-text--/message-content-- 容器内的裸文本。
                # 排除订单卡价格/运费/已读/头像等噪声(它们几何上也落在容器内,2026-09-09 实测)。
                wrappers = [n for n in band if _has_cls(n, *CLS_MSG_WRAPPER)]
                parts = [_text(n) for n in band
                         if _text(n) and not _has_cls(n, *CLS_MSG_WRAPPER)
                         and any(_contains(wp, n) for wp in wrappers)
                         and (n.get("cls") or "").split(" ")[0] != "img"  # 懒加载图 alt(如「闲鱼站点Logo」)噪声
                         and not any(k in (n.get("cls") or "") for k in (
                             "money--", "delivery--", "price", "read-status",
                             "avatar", "msg-dx-", "btnChildren--"))]
                text = " ".join(p for p in parts if p)
            if not text:
                continue
            # 时间戳:最新在底部,分隔行在它那组消息上方 → 生效的是上方(cy 更小)最近的一个分隔行
            msg_at = None
            for ts_cy, ts_val in ts_list:
                if ts_cy < r["cy"] and ts_val:
                    msg_at = ts_val
                else:
                    break
            msgs.append({"direction": direction, "text": text, "msg_at": msg_at})
    return {"peer_key": peer_key, "peer_nick": peer_nick,
            "item_title": item_title, "item_price": item_price, "item_image": item_image,
            "item_id": item_id, "messages": msgs}


def _parse_item_title(nodes, rows, chat_left, chat_right):
    """商品卡:顶栏下方、首条消息以上的区域,取最长非按钮文本(2026-09-09 实测卡常无标题→None)。

    注意排除时间分隔行(整宽裸 div「昨天 02:02」,cy 也落在该区域)。
    2026-10-10 修:加顶栏下界——原来只卡「首条消息以上」,无商品卡时顶栏里的
    买家昵称会当选,81 个存量会话 item_title 全是昵称就是这么来的。
    2026-10-17 实测截图:网页版商品卡**根本没有标题**(图、价、「含运费」、交易状态、按钮),
    这里正常就该是 None。浏览器号的售出别指望它,走售出巡检(flow/web/sold_scan_web.py)。
    """
    top = min(_rect(r)[1] for r in rows)
    bars = _find(nodes, CLS_TOPBAR)
    bar_bottom = max((_rect(b)[3] for b in bars), default=None)
    cands = []
    for n in nodes:
        t = _text(n)
        if not t or len(t) < 4 or n["clickable"]:
            continue
        if RE_TS.match(t):
            continue
        if not (chat_left <= n["cx"] <= chat_right and n["cy"] < top - 5):
            continue
        if bar_bottom is not None and n["cy"] <= bar_bottom:
            continue
        cls = n.get("cls") or ""
        if _has_cls(n, *CLS_MSG_WRAPPER) or any(k in cls for k in
                   ("money--", "delivery--", "price", "btnChildren--", "img--")):
            continue
        if _RE_ITEM_NOISE.search(t):
            continue
        cands.append(t)
    return max(cands, key=len) if cands else None


def _parse_item_price(nodes, rows, chat_left, chat_right):
    """商品卡价格:与 _parse_item_title 同区域(顶栏下、首条消息行上),
    cls 含 money--/price 且文本以 ¥ 开头的节点,取数字串(千分位逗号去掉)。
    无消息行(区域界定不了)或无卡 → None。"""
    if not rows:
        return None
    top = min(_rect(r)[1] for r in rows)
    bars = _find(nodes, CLS_TOPBAR)
    bar_bottom = max((_rect(b)[3] for b in bars), default=None)
    for n in nodes:
        m = _RE_ITEM_PRICE_TXT.match(_text(n))
        if not m:
            continue
        if not (chat_left <= n["cx"] <= chat_right and n["cy"] < top - 5):
            continue
        if bar_bottom is not None and n["cy"] <= bar_bottom:
            continue
        if not any(k in (n.get("cls") or "") for k in ("money--", "price")):
            continue
        return m.group(1).replace(",", "")
    return None


_RE_ITEM_HREF = re.compile(r"(?:goofish\.com|2\.taobao\.com|idle\.)[^\s]*?[?&](?:id|itemId)=(\d{6,})")


def _parse_item_id(nodes, rows, chat_left, chat_right):
    """商品卡里的闲鱼商品 id:卡片区(顶栏下、首条消息上)有指向商品页的链接就取它的 id。

    dump 会把 a[href] 的 href 放进 desc。网页版商品卡是不是链接还没在真号上核实过——
    拿不到就是 None,认货退回按标题 / 价格(jobs._link_listings)。"""
    if not rows:
        return None
    top = min(_rect(r)[1] for r in rows)
    bars = _find(nodes, CLS_TOPBAR)
    bar_bottom = max((_rect(b)[3] for b in bars), default=None)
    for n in nodes:
        m = _RE_ITEM_HREF.search(n.get("desc") or "")
        if not m:
            continue
        if not (chat_left <= n["cx"] <= chat_right and n["cy"] < top - 5):
            continue
        if bar_bottom is not None and n["cy"] <= bar_bottom:
            continue
        return m.group(1)
    return None


def _parse_item_image(nodes, rows, chat_left, chat_right):
    """商品卡缩略图:顶栏**下方**、首条消息行上方的卡片区里带 src 的 img 节点(通常就
    商品图一张;顶栏头像/消息区头像不在这个带里,天然排除)。协议相对 URL
    (//img.alicdn.com/...)补 https:。老执行端 dump 无 src 字段 → None,
    由 jobs._resolve_item_images 按标题反猜兜底。无消息行(区域界定不了)→ None。"""
    if not rows:
        return None
    top = min(_rect(r)[1] for r in rows)
    bars = _find(nodes, CLS_TOPBAR)
    bar_bottom = max((_rect(b)[3] for b in bars), default=None)
    cands = [n for n in nodes
             if (n.get("src") or "").strip() and _is_img_node(n)
             and chat_left <= n["cx"] <= chat_right and n["cy"] < top - 5
             and (bar_bottom is None or n["cy"] > bar_bottom)]
    if not cands:
        return None
    src = min(cands, key=lambda n: n["cy"])["src"].strip()
    if src.startswith("//"):
        src = "https:" + src
    return src[:500]

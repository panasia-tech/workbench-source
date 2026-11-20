"""闲鱼聊天页/会话列表 dump_nodes 纯解析。dump_nodes 项:{desc,cls,clickable,cx,cy,w,h}。"""
import re

# 聊天页 chrome:desc 命中即非消息气泡
_CHAT_CHROME = (
    "闲鱼私聊", "送Ta", "送给Ta", "去兑换", "去领取", "蚂蚁森林", "小红花", "投缘优惠",
    "已读", "未读", "头像", "返回", "更多", "会员名", "商品图片", "商品信息", "确认收货",
    "想跟TA说", "语音按钮", "表情按钮", "更多选择", "查看大图", "脱离闲鱼平台",
)
_TS = re.compile(r"(\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})|(\d+\s*天前)")
# 商品卡片价格:卡片 desc(剔除零宽空格后)里 ¥ 后的数字串,千分位逗号在取组后去掉
_RE_ITEM_PRICE = re.compile(r"¥\s*([\d,]+\.?\d*)")


def _parse_item_price(nodes):
    """商品卡价格(2026-10-09 实测):desc 以「商品信息」开头的卡片节点,
    Flutter 字间带零宽空格(\\u200b)先剔除,再正则取 ¥ 后数字;解析不到返回 None。"""
    for n in nodes:
        t = _text(n).replace("\u200b", "")
        if not t.startswith("商品信息"):
            continue
        m = _RE_ITEM_PRICE.search(t)
        if m:
            return m.group(1).replace(",", "")
    return None


def _text(n):
    return (n.get("desc") or "").strip()


def parse_chat_page(nodes, w, h):
    item_title = peer_key = item_price = None
    # 顶栏:含「会员名」的节点 → 「<商品标题> 会员名:<掩码>」
    for n in nodes:
        t = _text(n)
        if "会员名" in t and n["cy"] < h * 0.12:
            m = re.split(r"会员名[:：]", t, maxsplit=1)
            item_title = m[0].strip() or None
            peer_key = (m[1].strip() if len(m) > 1 else None) or None
            break
    item_price = _parse_item_price(nodes)
    msgs = []
    last_ts = None
    top = int(h * 0.10)      # 顶栏下
    bottom = int(h * 0.90)   # 输入栏上
    for n in sorted(nodes, key=lambda x: x["cy"]):
        t = _text(n)
        if len(t) < 2 or not (top < n["cy"] < bottom):
            continue
        if _TS.search(t):
            last_ts = None  # msg_at 1a 先不解析绝对时间,占位
            continue
        if any(c in t for c in _CHAT_CHROME):
            continue
        x1 = n["cx"] - n["w"] // 2
        x2 = n["cx"] + n["w"] // 2
        # 方向判定:in 块左对齐(x1≈0.166w),out 块右对齐(x2≈0.834w),与气泡长短无关。
        # 旧规则「x1<0.35w → in」把横跨中线的长 out 气泡(x1≈0.13w)误判成 in(2026-07-29
        # 实测:群控发出的长回复全被记成 in);长 in 气泡的 x1 恒≈0.166w,边对齐判定更稳。
        tol = w * 0.03
        if abs(x1 - w * 0.166) <= tol:
            direction = "in"
        elif abs(x2 - w * 0.834) <= tol:
            direction = "out"
        elif x1 < w * 0.35:
            direction = "in"
        elif x2 > w * 0.65 and x1 > w * 0.35:
            direction = "out"
        else:
            continue  # 居中系统卡(如「卖家已发货」)1a 跳过
        msgs.append({"direction": direction, "text": t, "msg_at": last_ts})
    return {"item_title": item_title, "item_price": item_price,
            "peer_key": peer_key, "messages": msgs}


_SYS_LABELS = {"通知消息", "互动消息", "闲鱼精选", "还没有新通知~"}
_LIST_EXCLUDE = {"消息", "清除未读", "设置", "搜索聊天记录/联系人/服务号", "卖闲置", "红点提醒", "图片"}
# 新版消息页 chrome(2026-07 实测混入):Tab 描述「第 N 个标签，共 M 个」、展开/折叠 Tab 按钮、顶 banner
_TAB_DESC = re.compile(r"^第\s*\d+\s*个标签，共\s*\d+\s*个$")
_LIST_CHROME = {"展开Tab", "折叠Tab", "淘宝闲鱼买的都能换钱"}
# 会话头像未读角标「未读数N」。Flutter 渲染不稳(可能不出现),故"在场即用、缺失不猜"。
# 系统行(通知消息/互动消息…)也可能带此角标,但系统行在下方整簇排除,其角标不会挂到买家行。
_UNREAD_BADGE = re.compile(r"^未读数\s*(\d+)$")
_ORDER_STATUS = {
    "等待买家收货", "等待你发货", "等待付款", "等待卖家发货", "待发货", "待收货",
    "交易成功", "已发货", "等待见面交易", "退款中", "退款成功", "已关闭",
}


def _is_list_chrome(t: str) -> bool:
    return t in _LIST_CHROME or bool(_TAB_DESC.search(t))


def parse_conversation_list(nodes, w, h):
    # 未读角标「未读数N」按 cy 挂到对应买家会话行(系统行整簇排除,角标不外溢)。
    unread_badges = [(n["cy"], int(m.group(1)))
                     for n in nodes if (m := _UNREAD_BADGE.match(_text(n)))]
    cand = []
    for n in nodes:
        t = _text(n)
        if len(t) < 2 or "\n" in t:                       # \n 多为推荐人昵称块
            continue
        if not (h * 0.14 < n["cy"] < h * 0.90):            # 搜索栏下、底tab上
            continue
        if t in _LIST_EXCLUDE or _is_list_chrome(t) or "未选中" in t or "选中状态" in t or "未读数" in t:
            continue
        if "可能感兴趣" in t:
            continue
        cand.append(n)
    # 系统会话簇的 cy:命中系统标签的节点附近整簇排除
    sys_cy = [n["cy"] for n in cand if _text(n) in _SYS_LABELS]
    body = [n for n in cand if _text(n) not in _SYS_LABELS
            and not any(abs(n["cy"] - s) < 120 for s in sys_cy)]
    # 按 cy 聚簇成行(相邻 <140 同一会话行)
    body.sort(key=lambda n: n["cy"])
    rows, cur = [], []
    for n in body:
        if cur and n["cy"] - cur[-1]["cy"] > 140:
            rows.append(cur); cur = []
        cur.append(n)
    if cur:
        rows.append(cur)
    out = []
    for grp in rows:
        texts = [_text(g) for g in grp]
        status = next((t for t in texts if t in _ORDER_STATUS), None)
        msgs = [t for t in texts if t not in _ORDER_STATUS and not _TS.search(t)]
        cys = [g["cy"] for g in grp]
        lo, hi = min(cys) - 80, max(cys) + 80
        unread = next((c for (bcy, c) in unread_badges if lo <= bcy <= hi), 0)
        out.append({
            "row_cy": sum(g["cy"] for g in grp) // len(grp),
            "last_message": max(msgs, key=len) if msgs else None,
            "order_status": status,
            "unread": unread,
            "has_unread": unread > 0,
        })
    return out

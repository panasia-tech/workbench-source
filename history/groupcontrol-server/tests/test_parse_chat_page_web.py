"""网页版聊天页商品卡价格/缩略图解析(parse_chat_page_web → item_price / item_image)。

合成最小节点集(2026-09-09 AdsPower 实测 DOM 结构):顶栏 + 商品卡(图+价)
+ 首条消息行。价格节点 cls 含 money--/price、文本以 ¥ 开头,落在顶栏下、
首条消息行以上的卡片区才取;缩略图取卡片区里带 src 的 img(2026-10-10 起
执行端/local dump 给 IMG 节点带 src 字段)。
"""

from app.flow.web.parse import parse_chat_page_web


def _n(desc, cls, cx, cy, w=100, h=40, clickable=False, src=None):
    n = {"desc": desc, "cls": cls, "clickable": clickable,
         "cx": cx, "cy": cy, "w": w, "h": h}
    if src:
        n["src"] = src
    return n


CARD_IMG_SRC = "//img.alicdn.com/tfs/TB1prod.jpg"


def _page_nodes(with_card=True):
    w, h = 1920, 1080
    nodes = [
        _n("", "div message-topbar--x", 960, 40, 1920, 80),
        _n("买家昵称", "span text1--x", 200, 40),
        _n("(t***7)", "span text2--x", 400, 40),
        # 首条消息行(top=380,卡片区须在其上)
        _n("", "div message-row--x", 960, 410, 1200, 60),
        _n("在吗", "span message-text-left--x", 300, 410),
    ]
    if with_card:
        nodes.insert(3, _n("¥1588.00", "span money--a price--b", 420, 150))
        nodes.insert(4, _n("含运费0.00元", "div delivery--x", 420, 190))
        # 商品卡缩略图:顶栏底(80)以下、首条消息行顶(380)以上的卡片区内
        nodes.insert(5, _n("", "img--prod", 420, 280, 160, 160, src=CARD_IMG_SRC))
    return w, h, nodes


def test_item_price_from_card():
    w, h, nodes = _page_nodes()
    r = parse_chat_page_web(nodes, w, h)
    assert r["peer_key"] == "t***7"
    assert r["item_price"] == "1588.00"


def test_item_price_strips_thousands_sep():
    w, h, nodes = _page_nodes()
    for n in nodes:
        if n["desc"] == "¥1588.00":
            n["desc"] = "¥1,588.00"
    r = parse_chat_page_web(nodes, w, h)
    assert r["item_price"] == "1588.00"


def test_item_price_none_without_card():
    w, h, nodes = _page_nodes(with_card=False)
    r = parse_chat_page_web(nodes, w, h)
    assert r["item_price"] is None


def test_item_price_ignores_price_like_message_text():
    """消息气泡里的 ¥ 文本(非 money--/price 类、且不在卡片区)不得被当成商品价格。"""
    w, h, nodes = _page_nodes(with_card=False)
    nodes.append(_n("¥100 出吗", "span message-text-left--x", 300, 600))
    r = parse_chat_page_web(nodes, w, h)
    assert r["item_price"] is None


def test_item_image_from_card_img_protocol_relative():
    """卡片区 img 的 src 直取;协议相对 URL(//img.alicdn.com/...)补 https:。"""
    w, h, nodes = _page_nodes()
    r = parse_chat_page_web(nodes, w, h)
    assert r["item_image"] == "https://img.alicdn.com/tfs/TB1prod.jpg"


def test_item_image_https_kept():
    w, h, nodes = _page_nodes()
    for n in nodes:
        if n.get("src"):
            n["src"] = "https://img.alicdn.com/a.png"
    r = parse_chat_page_web(nodes, w, h)
    assert r["item_image"] == "https://img.alicdn.com/a.png"


def test_item_image_none_without_src():
    """老执行端 dump 没有 src 字段 → None(交给 jobs 标题反猜兜底,向后兼容)。"""
    w, h, nodes = _page_nodes()
    for n in nodes:
        n.pop("src", None)
    r = parse_chat_page_web(nodes, w, h)
    assert r["item_image"] is None


def test_item_image_none_without_card():
    w, h, nodes = _page_nodes(with_card=False)
    r = parse_chat_page_web(nodes, w, h)
    assert r["item_image"] is None


def test_item_image_ignores_topbar_avatar():
    """顶栏头像(img 但在顶栏带里,不在商品卡区)不得被当成商品图。"""
    w, h, nodes = _page_nodes(with_card=False)
    nodes.insert(1, _n("", "img--avatar", 120, 40, 56, 56,
                       src="https://img.alicdn.com/avatar.jpg"))
    r = parse_chat_page_web(nodes, w, h)
    assert r["item_image"] is None


def test_item_image_ignores_message_avatar():
    """消息区头像(首条消息行以下)不得被当成商品图。"""
    w, h, nodes = _page_nodes(with_card=False)
    nodes.append(_n("", "img--avatar", 300, 410, 56, 56,
                    src="https://img.alicdn.com/avatar.jpg"))
    r = parse_chat_page_web(nodes, w, h)
    assert r["item_image"] is None


def test_item_image_local_transport_cls_shape():
    """local_transport 的 cls 带 tag 前缀("img img--x"),判据首段即 tag,两种形态都要中。"""
    w, h, nodes = _page_nodes()
    for n in nodes:
        if (n.get("cls") or "").startswith("img--"):
            n["cls"] = "img " + n["cls"]
    r = parse_chat_page_web(nodes, w, h)
    assert r["item_image"] == "https://img.alicdn.com/tfs/TB1prod.jpg"


def test_item_title_ignores_topbar_nick():
    """2026-10-10 回归:无商品卡时顶栏买家昵称不得当选 item_title(顶栏下界缺失,
    81 个存量会话标题全是昵称)。修复后无卡 → None。"""
    w, h, nodes = _page_nodes(with_card=False)
    r = parse_chat_page_web(nodes, w, h)
    assert r["item_title"] is None


def test_item_title_from_card():
    w, h, nodes = _page_nodes()
    nodes.insert(3, _n("【HKC G24H3S】成色如图，功能正常", "div title--x", 500, 120))
    r = parse_chat_page_web(nodes, w, h)
    assert r["item_title"] == "【HKC G24H3S】成色如图，功能正常"


# ---------- 消息顺序与时间戳:最新在底部 ----------
# 2026-09-09 侦察 dump:分隔行「昨天 02:02」「昨天 02:07」「02:02」cy 依次变大,每条分隔行在它那组
# 消息上方——message-list-reverse 只是倒序渲染,屏幕上和普通聊天一样最新在底部。
# 代码里曾写「cy 越大越老」,回复核对因此拿最早一条当最新一条(2026-10-18 修)。

def _msg(direction, text, cy):
    """一条消息行:行容器 + 气泡容器(左 in / 右 out)+ 裸文本(执行端 dump 无 class 的 span)。"""
    if direction == "in":
        return [_n("", "message-row--r", 595, cy, 364, 60),
                _n("", "message-text--t message-text-left--l", 627, cy, 300, 40),
                _n(text, "span", 627, cy, 120, 20)]
    return [_n("", "message-row--r", 1177, cy, 364, 60),
            _n("", "message-text--t message-text-right--o", 1145, cy, 300, 40),
            _n(text, "span", 1145, cy, 120, 20)]


def _ts(text, cy):
    return _n(text, "div", 886, cy, 946, 39)     # 整宽裸 div


def test_messages_old_to_new_and_timestamp_from_separator_above():
    from datetime import datetime
    from app.flow.web.parse import parse_ts

    nodes = [_n("", "message-topbar--x", 888, 40, 950, 80), _n("(t***7)", "text2--x", 509, 40)]
    nodes += _msg("in", "更早一句", 130)          # 上方没有分隔行
    nodes += [_ts("昨天 02:02", 200)]
    nodes += _msg("in", "在吗", 260) + _msg("out", "在的", 340)
    nodes += [_ts("10:30", 410)]
    nodes += _msg("in", "多少钱", 470) + _msg("out", "1588", 550)
    now = datetime.now()
    r = parse_chat_page_web(nodes, 1446, 815)
    assert [(m["direction"], m["text"]) for m in r["messages"]] == [
        ("in", "更早一句"), ("in", "在吗"), ("out", "在的"), ("in", "多少钱"), ("out", "1588")]
    at = [m["msg_at"] for m in r["messages"]]
    yday, today = parse_ts("昨天 02:02", now), parse_ts("10:30", now)
    assert at == [None, yday, yday, today, today]

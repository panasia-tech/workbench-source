import json, pathlib
from app.chat_parse import parse_chat_page

FX = pathlib.Path(__file__).parent / "fixtures" / "chat_page_dump.json"


def test_parse_chat_page_real_dump():
    d = json.loads(FX.read_text(encoding="utf-8"))
    w, h = d["screen"]
    r = parse_chat_page(d["nodes"], w, h)
    # 顶栏「半卖半送了 会员名:t***7」
    assert r["item_title"] == "半卖半送了"
    assert r["peer_key"] == "t***7"
    # 商品卡价格(cy≈337 的「商品信息」卡,fixture 价 ¥0.00)
    assert r["item_price"] == "0.00"
    texts = [m["text"] for m in r["messages"]]
    # 两条真实买家消息在
    assert any("我已付款" in t for t in texts)
    assert any("网盘" in t or "温馨提示" in t for t in texts)
    # 都判为 in(买家在左)
    assert all(m["direction"] in ("in", "out") for m in r["messages"])
    assert any(m["direction"] == "in" for m in r["messages"])
    # chrome 被排除
    joined = " ".join(texts)
    for bad in ["想跟TA说", "确认收货", "商品信息", "语音按钮", "会员名", "已读", "闲鱼私聊"]:
        assert bad not in joined


def _n(desc, cx, cy, w=100, h=60):
    return {"desc": desc, "cls": "android.widget.TextView", "clickable": False,
            "cx": cx, "cy": cy, "w": w, "h": h}


def test_direction_long_out_bubble():
    """回归(2026-07-29):长 out 气泡横跨 0.35w 中线(x1≈141/1080),旧规则误判成 in。
    真机几何:in 块 x1≈179, out 块 x2≈901(与长短无关)。"""
    w, h = 1080, 2400
    nodes = [
        _n("你好", 256, 274, 154),                 # 短 in:x1=179
        _n("这是一个买家发来的比较长的消息内容", 322, 472, 286),  # 长 in:x1=179
        _n("在的亲,这是自动回复链路测试,打扰了", 521, 1448, 759),  # 长 out:x1=141,x2=901
        _n("不卖的", 802, 1099, 198),              # 短 out:x2=901
        _n("引导您脱离闲鱼平台并且联系客服缴费的都是诈骗行为！", 514, 494, 866),  # 系统横幅:chrome 过滤
        _n("未读", 540, 2006, 1080),               # 状态行:chrome 过滤
    ]
    r = parse_chat_page(nodes, w, h)
    by_text = {m["text"]: m["direction"] for m in r["messages"]}
    assert by_text["你好"] == "in"
    assert by_text["这是一个买家发来的比较长的消息内容"] == "in"
    assert by_text["在的亲,这是自动回复链路测试,打扰了"] == "out"
    assert by_text["不卖的"] == "out"
    assert "引导您脱离闲鱼平台并且联系客服缴费的都是诈骗行为！" not in by_text
    assert "未读" not in by_text


def test_item_price_strips_zero_width_and_thousands_sep():
    """商品卡 desc 字间带零宽空格(\\u200b),价格可能带千分位逗号——都剥掉。"""
    w, h = 1080, 2400
    card = ("商品信息, ¥\u200b1\u200b,\u200b5\u200b8\u200b8\u200b.\u200b0\u200b0\u200b\n"
            "含\u200b运\u200b费\u200b0\u200b.\u200b0\u200b0\u200b元\u200b\n等待见面交易")
    nodes = [
        _n("半卖半送了\n会员名：t***7", 540, 166, 800, 100),   # 顶栏
        _n(card, 628, 337, 838, 154),                          # 商品卡
        _n("你好", 256, 800, 154),                             # 普通消息(in:x1≈0.166w)
    ]
    r = parse_chat_page(nodes, w, h)
    assert r["item_price"] == "1588.00"
    # 卡片节点本身不进消息流(含「商品信息」chrome)
    assert all("商品信息" not in m["text"] for m in r["messages"])


def test_item_price_none_without_card():
    """无商品卡 → None,不影响其余解析(回退语义)。"""
    w, h = 1080, 2400
    nodes = [
        _n("半卖半送了\n会员名：t***7", 540, 166, 800, 100),
        _n("你好", 256, 800, 154),
    ]
    r = parse_chat_page(nodes, w, h)
    assert r["item_price"] is None
    assert r["item_title"] == "半卖半送了"

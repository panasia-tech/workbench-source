import json, pathlib
from app.chat_parse import parse_conversation_list

FX = pathlib.Path(__file__).parent / "fixtures" / "conversation_list_dump.json"


def test_parse_conversation_list_real_dump():
    d = json.loads(FX.read_text(encoding="utf-8"))
    w, h = d["screen"]
    rows = parse_conversation_list(d["nodes"], w, h)
    assert len(rows) >= 1
    # 真买家会话:订单状态「等待买家收货」+ 最新消息含「半卖半送」或「卖家已发货」
    buyer = [r for r in rows if r["order_status"] == "等待买家收货"]
    assert len(buyer) == 1
    assert buyer[0]["last_message"] and ("半卖半送" in buyer[0]["last_message"] or "卖家已发货" in buyer[0]["last_message"])
    assert 800 < buyer[0]["row_cy"] < 1050
    # 系统区被排除
    joined = " ".join((r["last_message"] or "") for r in rows)
    for bad in ["通知消息", "互动消息", "闲鱼精选", "可能感兴趣", "还没有新通知"]:
        assert bad not in joined


def _n(desc, cy, cx=540):
    return {"desc": desc, "cls": "android.widget.TextView", "clickable": False,
            "cx": cx, "cy": cy, "w": 400, "h": 60}


def test_parse_conversation_list_drops_new_ui_chrome():
    """回归(2026-07-29):新版消息页的 Tab 描述/展开Tab/顶 banner 曾自成会话行混进 last_message。"""
    w, h = 1080, 2400
    nodes = [
        _n("第 1 个标签，共 3 个", 420),
        _n("展开Tab", 500),
        _n("淘宝闲鱼买的都能换钱", 600),
        _n("半卖半送了", 900, cx=326),
        _n("[卖家已发货]", 970, cx=523),
        _n("等待买家收货", 900, cx=478),
    ]
    rows = parse_conversation_list(nodes, w, h)
    joined = " ".join((r["last_message"] or "") for r in rows)
    assert "第 1 个标签" not in joined
    assert "展开Tab" not in joined
    assert "都能换钱" not in joined
    # 真买家会话行仍在
    assert any(r["order_status"] == "等待买家收货" for r in rows)


def test_unread_badge_stays_on_system_row_not_buyer():
    """真机 dump:唯一「未读数2」在系统「通知消息」行(cy≈414),买家会话(cy≈900)无角标 → unread=0。
    验证系统行的未读角标不会外溢误挂到买家行。"""
    d = json.loads(FX.read_text(encoding="utf-8"))
    w, h = d["screen"]
    rows = parse_conversation_list(d["nodes"], w, h)
    buyer = [r for r in rows if r["order_status"] == "等待买家收货"][0]
    assert buyer["unread"] == 0 and buyer["has_unread"] is False


def test_unread_badge_attaches_to_buyer_row():
    """买家会话行带「未读数3」→ 该行 unread=3、has_unread=True(未读驱动的进会话依据)。"""
    w, h = 1080, 2400
    nodes = [
        _n("未读数3", 900, cx=165),        # 头像红点角标(会被行文本聚类排除,单独作 badge)
        _n("买家昵称x", 880, cx=326),
        _n("在吗在吗", 940, cx=400),
        _n("等待买家收货", 900, cx=800),
    ]
    rows = parse_conversation_list(nodes, w, h)
    r = [r for r in rows if r["order_status"] == "等待买家收货"][0]
    assert r["unread"] == 3 and r["has_unread"] is True

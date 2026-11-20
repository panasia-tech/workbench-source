"""网页版回消息:发送按钮怎么认、发出去怎么核对(2026-10-18 生产 12 单回复核实)。

生产 12 单 chat_reply 全是浏览器号:8 成 4 败,败的全在 reply_verify(「发送后未回读到该消息」)。
病根是核对拿 outs[0] 当最新一条——/im 最新在底部,parse 按 cy 升序,outs[0] 是**最早**那条:
会话里只要发过消息,新发的就必判失败、不落库(10-15 同一会话 3 句全判失败,后来的会话扫描
又把这 3 句都读了回来)。同一会话连发两次同一句,第二次「成功」也只是因为最早那条恰好同文。

假页面照执行端 dump 的格式(cls 是原样 className、不带标签名前缀,center/size 元组),
几何取自 2026-09-09 侦察 dump(viewport 1446x815)。
"""
from app.flow.web import reply_chat_web as rcw

PEER = "811892395"
ROW = (248, 202, 330, 68)               # 会话行 cx, cy, w, h
SEND_BTN = (1315, 765, 80, 32)          # sendbox-bottom 里的 button.ant-btn
BTN_CLS = "ant-btn css-apn68 ant-btn-default ant-btn-color-default ant-btn-variant-outlined"


def _n(desc, cls, cx, cy, w=100, h=20, clickable=False):
    return {"desc": desc, "cls": cls, "clickable": clickable, "center": (cx, cy), "size": (w, h)}


def _inside(box, x, y):
    cx, cy, w, h = box
    return abs(x - cx) <= w / 2 and abs(y - cy) <= h / 2


def _sendbox(btn_cls=BTN_CLS):
    """输入区下沿:按钮 80x32,里头的 span「发 送」h=280(几何毛刺,中心和按钮一样)。"""
    return [
        _n("", "sendbox-bottom--O2c5fyIe", 888, 764, 934, 34),
        _n("", btn_cls, *SEND_BTN, clickable=True),
        _n("发 送", "span", 1315, 765, 29, 280, clickable=True),
    ]


class FakeImPage:
    """/im 页面:会话列表常驻;点会话行进聊天页;set_text 写进输入框;点中发送按钮,
    输入框里的字作为一条 out 气泡上屏(lands=False:点了但没发出去)。"""

    W, H = 1446, 815

    def __init__(self, history, lands=True):
        self.history = list(history)    # [(direction, text)] 老→新
        self.lands = lands
        self.in_chat = False
        self.draft = ""
        self.taps = []

    def launch_app(self, url):
        self.in_chat = False

    def screen_size(self):
        return self.W, self.H

    def screencap(self):
        return b"png"

    def swipe(self, *a, **k):
        pass

    def key(self, k):
        pass

    def set_text(self, text):
        self.draft = text

    def tap(self, x, y):
        self.taps.append((x, y))
        if _inside(ROW, x, y):
            self.in_chat = True
        elif self.in_chat and self.draft and _inside(SEND_BTN, x, y):
            if self.lands:
                self.history.append(("out", self.draft))
            self.draft = ""

    def dump_nodes(self):
        nodes = [
            _n("测试卖家", "nick--RyNYtDXM", 1227, 36, 96, 20, clickable=True),
            _n("", "conversation-item--JReyg97P", *ROW, clickable=True),
            _n("买家甲", "div", 170, 185, 41, 18, clickable=True),
            _n("在吗", "div", 232, 204, 165, 16, clickable=True),
        ]
        if not self.in_chat:
            return nodes
        nodes += [
            _n("", "message-topbar--uzL8Czfo", 888, 138, 950, 60),
            _n("买家甲", "text1--DZXvZYq5", 455, 138, 53, 28),
            _n("(t***7)", "text2--S10AsTZt", 509, 140, 38, 16),
            # 执行端 dump:<a> 的 desc 就是 href
            _n(f"https://www.goofish.com/personal?userId={PEER}", "a", 1263, 138, 97, 32, clickable=True),
        ]
        # 最新在底部:最后一条在 cy=600,越老越往上(视口外的 cy 为负,dump 里照样有)
        n = len(self.history)
        for i, (direction, text) in enumerate(self.history):
            cy = 600 - (n - 1 - i) * 80
            if direction == "in":
                nodes += [_n("", "message-row--pIWaXNhZ", 595, cy, 364, 60),
                          _n("", "message-text--zV88pB7N message-text-left--Wvuv8NsL", 627, cy, 300, 40),
                          _n(text, "span", 627, cy, 120, 20)]
            else:
                nodes += [_n("", "message-row--pIWaXNhZ", 1177, cy, 364, 60),
                          _n("", "message-text--zV88pB7N message-text-right--Kq2x", 1145, cy, 300, 40),
                          _n(text, "span", 1145, cy, 120, 20)]
        nodes.append(_n(self.draft or "请输入消息", "ant-input css-apn68 ant-input-outlined textarea-no-border--cIId06_i",
                        888, 710, 950, 62, clickable=True))
        return nodes + _sendbox()


def _run(monkeypatch, page, text):
    monkeypatch.setattr(rcw.time, "sleep", lambda *_: None)
    return rcw.run_reply_chat_web(page, {"peer_key": PEER, "text": text},
                                  shot_sink=lambda name, data: f"shots/{name}.png")


# ---------- 核对 ----------

def test_new_text_after_earlier_out_is_verified(monkeypatch):
    """会话里已经有我们发过的一条,再发不同的一句 → 成功(原来 outs[0] 是那条老的,必判失败)。"""
    page = FakeImPage([("in", "在吗"), ("out", "在的"), ("in", "今天能发货吗")])
    r = _run(monkeypatch, page, "能,下午就发")
    assert r["ok"] is True and r["done"] == ["reply_chat"], r
    assert page.history[-1] == ("out", "能,下午就发")


def test_same_text_again_is_verified(monkeypatch):
    """同一句话再发一次 → 成功:同文 out 从 1 条变 2 条。"""
    page = FakeImPage([("in", "在吗"), ("out", "您好，消息已收到"), ("in", "多少钱")])
    r = _run(monkeypatch, page, "您好，消息已收到")
    assert r["ok"] is True, r
    assert [t for d, t in page.history if d == "out"] == ["您好，消息已收到"] * 2


def test_not_sent_fails_verify(monkeypatch):
    """点了发送但气泡没上屏 → reply_verify(可能已发出,交人工,不重发)。"""
    page = FakeImPage([("in", "在吗"), ("out", "在的")], lands=False)
    r = _run(monkeypatch, page, "今天就发")
    assert r["ok"] is False and r["failed_step"] == "reply_verify", r


def test_same_text_not_sent_fails_verify(monkeypatch):
    """同一句话第二次发没发出去 → 也要判失败。只看最新一条的话,上一条同文,会误判成功。"""
    page = FakeImPage([("in", "在吗"), ("out", "在的")], lands=False)
    r = _run(monkeypatch, page, "在的")
    assert r["ok"] is False and r["failed_step"] == "reply_verify", r


def test_first_reply_in_conversation(monkeypatch):
    page = FakeImPage([("in", "在吗")])
    r = _run(monkeypatch, page, "在的")
    assert r["ok"] is True, r


# ---------- 发送按钮 ----------

def test_send_button_executor_dump_format():
    """执行端 dump 的 cls 不带标签名(只有 "ant-btn …"):要认出 80x32 的按钮,不退到 h=280 的 span。"""
    btn = rcw._find_send_button(rcw._flat(_sendbox()), 815)
    assert btn and (btn["w"], btn["h"]) == (80, 32) and "ant-btn" in btn["cls"]


def test_send_button_local_transport_format():
    """local_transport 的 cls 带标签名前缀("button ant-btn …")照样认。"""
    btn = rcw._find_send_button(rcw._flat(_sendbox(btn_cls="button " + BTN_CLS)), 815)
    assert btn and (btn["w"], btn["h"]) == (80, 32)


def test_send_button_without_class_falls_back_to_tag():
    """执行端:元素没 class 时 cls 退成标签名 "button"。"""
    btn = rcw._find_send_button(rcw._flat(_sendbox(btn_cls="button")), 815)
    assert btn and (btn["w"], btn["h"]) == (80, 32)


def test_send_button_span_fallback_kept():
    """认不出按钮(改版了)时,兜底仍按「发送」二字去点 span。"""
    btn = rcw._find_send_button(rcw._flat(_sendbox(btn_cls="sendBtn--x")), 815)
    assert btn and btn["desc"] == "发 送"


def test_is_button_matches_words_not_substrings():
    assert rcw._is_button({"cls": "ant-btn css-x ant-btn-primary"})
    assert rcw._is_button({"cls": "button ant-btn css-x"})
    assert not rcw._is_button({"cls": "ant-btn-icon"})
    assert not rcw._is_button({"cls": "span"})
    assert not rcw._is_button({"cls": ""})

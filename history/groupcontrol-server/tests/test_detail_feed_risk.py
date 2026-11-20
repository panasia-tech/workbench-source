"""推荐流里的风控词不算风控:下架 / 重新上架 / 删除 / 发布 / 保活。

推荐流是一整片别人的商品,标题随机,「申诉」「违规」「验证码」并不稀奇,扫进去就熔断冻号。
以前只有「宝贝被删掉了」页跳过了。详情页底下是「为你推荐」(2026-10-17 已售详情页实测:cy≈987,
下面 30 张推荐卡,视口约 800 高);首页是「猜你喜欢」那排 tab(2026-10-18 实测:cy=580,下面 20 张卡)。
"""
import pytest

from app.flow.engine import RiskHit
from app.flow.web import goods_flows_web as gfw
from app.flow.web import keepalive_web, login
from app.flow.web import publish_flow_web as pw

FEED = ("专业申诉代写 账号违规解封", "短信验证码接码平台", "身份验证代办")
SPEC = {"item_id": "1001", "title": "【AOC】成色如图", "price": 520}


class FakeDetailT:
    """详情页三态(在售 / 已下架 / 被删掉了)+ 确认弹窗 + 底部推荐区;个人中心只在在售时有这张卡。"""

    DELIST_OR_RELIST = (1300, 462)
    DELETE_BTN = (1580, 462)
    OK_BTN = (1020, 480)

    def __init__(self, state="onsale", feed=FEED, risk_text=None):
        self.state = state
        self.feed = feed
        self.risk_text = risk_text
        self.url = ""
        self.dialog = None

    @property
    def page(self):
        return self

    def launch_app(self, url):
        self.url = url
        self.dialog = None

    def screen_size(self):
        return 1707, 799

    def screencap(self):
        return b"png"

    def swipe(self, *a, **k):
        pass

    @staticmethod
    def _n(desc, cls, x, y, w=80, h=30):
        return {"desc": desc, "cls": cls, "center": (x, y), "size": (w, h)}

    def dump_nodes(self):
        nodes = [self._n("土星耐心的黑水母", "nick--RyNYtDXM", 1472, 36)]
        if "/personal" in self.url:
            if self.state == "onsale":
                nodes += [self._n("", "cardWarp--x", 500, 400, 300, 400),
                          self._n(SPEC["title"], "main-title--x", 500, 500),
                          self._n(str(SPEC["price"]), "number--x", 450, 550)]
            return nodes
        if self.state == "deleted":
            nodes.append(self._n("糟糕！宝贝被删掉了", "title--x", 850, 300))
        else:
            nodes += [self._n("¥", "symbol--DK_64UaK", 1079, 269, 20, 30),
                      self._n(str(SPEC["price"]), "number--x", 1120, 269),
                      self._n(SPEC["title"], "desc--x", 1344, 330, 500, 40)]
            first = "下架" if self.state == "onsale" else "重新上架"
            nodes += [self._n(first, "sellerButton--x", *self.DELIST_OR_RELIST),
                      self._n("删除", "sellerButton--x", *self.DELETE_BTN)]
        if self.risk_text:
            nodes.append(self._n(self.risk_text, "x", 850, 400, 300, 40))
        if self.dialog:
            verb = "下架" if self.dialog == "delist" else "删除"
            nodes += [self._n(f"确定要{verb}这个宝贝吗？", "confirmTitle--x", 960, 400),
                      self._n("取消", "btnChildren--x", 900, 480),
                      self._n("确定", "btnChildren--x", *self.OK_BTN)]
        if self.feed:
            nodes.append(self._n("为你推荐", "title--rec", 300, 987, 120, 30))
            nodes += [self._n(title, "main-title--rec", 400 + 250 * i, 1285, 230, 40)
                      for i, title in enumerate(self.feed)]
        return nodes

    def tap(self, x, y):
        if self.dialog and (x, y) == self.OK_BTN:
            self.state = "delisted" if self.dialog == "delist" else "deleted"
            self.dialog = None
        elif (x, y) == self.DELIST_OR_RELIST and self.state == "onsale":
            self.dialog = "delist"
        elif (x, y) == self.DELIST_OR_RELIST and self.state == "delisted":
            self.state = "onsale"
        elif (x, y) == self.DELETE_BTN and self.state != "deleted":
            self.dialog = "delete"


@pytest.fixture
def no_sleep(monkeypatch):
    monkeypatch.setattr(gfw.time, "sleep", lambda *_: None)


def _shot(name, data):
    return f"shots/{name}.png"


def _item_nodes(t):
    t.launch_app(gfw.ITEM_URL.format(SPEC["item_id"]))
    return gfw._flat(t.dump_nodes())


def test_above_feed_cuts_only_the_recommendations():
    kept = gfw.above_feed(_item_nodes(FakeDetailT()))
    assert not any(word in n["desc"] for n in kept for word in ("申诉", "违规", "验证码"))
    assert any(n["desc"] == "下架" for n in kept) and any(n["desc"] == "土星耐心的黑水母" for n in kept)
    no_feed = _item_nodes(FakeDetailT(feed=()))
    assert gfw.above_feed(no_feed) == no_feed


def test_page_without_feed_is_scanned_whole():
    """拦截页本身没有推荐区:整页照扫,页面靠下的风控字也认。"""
    nodes = gfw._flat([{"desc": "访问受限", "cls": "x", "center": (850, 1285), "size": (200, 40)}])
    with pytest.raises(RiskHit):
        gfw._check_risk(nodes)


@pytest.mark.parametrize("flow,state,after", [
    (gfw.run_delist_web, "onsale", "delisted"),
    (gfw.run_relist_web, "delisted", "onsale"),
    (gfw.run_delete_web, "onsale", "deleted"),
])
def test_risk_words_in_recommendations_do_not_freeze(no_sleep, flow, state, after):
    t = FakeDetailT(state=state)
    res = flow(t, dict(SPEC), shot_sink=_shot)
    assert res["ok"], res
    assert res["risk"] is None and t.state == after


@pytest.mark.parametrize("flow,state", [
    (gfw.run_delist_web, "onsale"),
    (gfw.run_relist_web, "delisted"),
    (gfw.run_delete_web, "onsale"),
])
def test_real_risk_above_the_feed_still_stops(no_sleep, flow, state):
    t = FakeDetailT(state=state, risk_text="请拖动下方滑块完成验证")
    res = flow(t, dict(SPEC), shot_sink=_shot)
    assert not res["ok"] and res["risk"]
    assert t.state == state and t.dialog is None, "风控页上什么都不点"


def test_personal_page_feed_is_ignored_too():
    """个人中心底下要是也挂推荐流,同一条规则。"""
    n = FakeDetailT._n
    nodes = gfw._flat([n("土星耐心的黑水母", "nick--RyNYtDXM", 1472, 36),
                       n("猜你喜欢", "span", 158, 1500), n("专业申诉代写", "main-title--x", 400, 1700)])
    gfw._check_risk(nodes)


# ---------- 保活:首页下半截就是「猜你喜欢」推荐流 ----------

class FakeHomeT:
    """首页:页头昵称 + 公告 +「猜你喜欢」tab(cy=580)+ 推荐卡标题(真实 dump 的类名)。"""

    def __init__(self, modal_text=None):
        self.modal_text = modal_text
        self.urls = []

    def launch_app(self, url):
        self.urls.append(url)

    def screen_size(self):
        return 1707, 799

    def screencap(self):
        return b"png"

    def risk_punish_active(self):
        return None

    def dump_nodes(self):
        n = FakeDetailT._n
        nodes = [n("土星耐心的黑水母", "nick--RyNYtDXM", 1340, 44),
                 n("网页版发闲置功能又升级啦！", "text--nX1", 220, 124, 300, 20),
                 n("猜你喜欢", "span", 158, 580), n("个人闲置", "span", 266, 580)]
        nodes += [n(title, "main-title--sMrtWSJa", 240 + 300 * i, 1030, 230, 40) for i, title in enumerate(FEED)]
        if self.modal_text:
            nodes.append(n(self.modal_text, "ant-modal-title", 850, 380, 300, 30))
        return nodes


def test_keepalive_ignores_risk_words_in_the_home_feed(monkeypatch):
    monkeypatch.setattr(login.time, "sleep", lambda *_: None)
    res = keepalive_web.run_keepalive_web(FakeHomeT(), {}, shot_sink=_shot)
    assert res["ok"] and res["risk"] is None, res


def test_keepalive_still_sees_a_real_verify_dialog(monkeypatch):
    monkeypatch.setattr(login.time, "sleep", lambda *_: None)
    res = keepalive_web.run_keepalive_web(FakeHomeT(modal_text="请完成安全验证"), {}, shot_sink=_shot)
    assert not res["ok"] and res["risk"]


# ---------- 发布:点完「发布」落到新商品详情页,底下是「为你推荐」 ----------

def test_publish_outcome_on_new_detail_page_is_not_a_risk(monkeypatch):
    monkeypatch.setattr(pw.time, "sleep", lambda *_: None)
    t = FakeDetailT(state="onsale")
    t.launch_app("https://www.goofish.com/item?id=777&spm=a21ybx.publish")
    t.risk_punish_active = lambda: None
    item_id, outcome = pw._wait_publish_outcome(t, {}, lambda name: f"shots/{name}.png", timeout=5)
    assert (item_id, outcome) == ("777", "SUBMITTED")

"""浏览器号售出巡检:个人中心「已售出」里的商品链接 → 按 item_id 对本号在架账本 → 详情页见「卖掉了」→ 标 SOLD。

起因(2026-10-17 生产核实):网页版聊天页的商品卡没有标题,chat_scan 那条在浏览器号上一单都没
对上,gc_listing 一条 SOLD 都没有;卖掉的货还挂在另外 3 个号上。夹具照当天真实页面的 dump 写
(东南亚泡菜味的蓝鲸,视口 1707x799,类名 hash 后缀照抄)。
"""
from datetime import datetime, timedelta
from types import SimpleNamespace
from uuid import uuid4

from sqlalchemy.orm import sessionmaker

import app.scheduler as sched_mod
from app import jobs
from app.flow import runner
from app.flow.web import sold_scan_web
from app.flow.web.sold_scan_web import detail_sold_state, feed_item_ids, find_sold_tab
from app.models import (Account, AccountStatus, Device, DeviceStatus, Listing, ListingStatus,
                        RiskState, Task, TaskStatus)
from app.scheduler import Scheduler

W, H = 1707, 799


def _n(desc, cls, cx, cy, w=100, h=20, clickable=False):
    return {"desc": desc, "cls": cls, "center": (cx, cy), "size": (w, h), "clickable": clickable}


def _flat(nodes):
    return sold_scan_web._flat(nodes)


NICK = _n("东南亚泡菜味的蓝鲸", "nick--RyNYtDXM", 1472, 36, 120, 20, True)
SOLD_TAB_AT = (532, 425)
ACTIVE = " tabItem-active--cum7K756"


def _tabs(onsale, sold, active):
    return [_n("综合", "tabItem--HiFOTMcp tabItemGroupSortList--_O1o7wXa" + (ACTIVE if active == "all" else ""),
               376, 425, 60, 34, True),
            _n(f"在售{onsale}", "tabItem--HiFOTMcp" + (ACTIVE if active == "onsale" else ""), 452, 425, 60, 34, True),
            _n(f"已售出{sold}", "tabItem--HiFOTMcp" + (ACTIVE if active == "sold" else ""), *SOLD_TAB_AT, 70, 34, True)]


def _card(item_id, title, i):
    """卡片:a.feeds-item-wrap--(href 进 desc)> cardWarp-- > main-title--。"""
    cx = 462 + 256 * (i % 5)
    cy = 675 + 420 * (i // 5)
    return [_n(f"https://www.goofish.com/item?id={item_id}&categoryId=50025387", "feeds-item-wrap--rGdH_KoF",
               cx, cy, 252, 412, True),
            _n("", "cardWarp--dZodM57A", cx, cy, 252, 412),
            _n(title, "main-title--sMrtWSJa", cx, cy + 72, 230, 40)]


def _detail(title, buttons, feed_titles=()):
    """详情页:价格区 + 正文 + 卖家按钮;下半截「为你推荐」是别人的商品。"""
    nodes = [_n("东南亚泡菜味的蓝鲸", "item-user-info-nick--rtpDhkmQ", 218, 169, 140, 24, True),
             _n("¥", "symbol--DK_64UaK windows--oJroL99y", 1079, 269, 20, 30),
             _n("339", "number--NKh1vXWM", 1120, 269, 60, 30),
             _n(title, "desc--GaIUKUQY", 1344, 330, 500, 50)]
    nodes += [_n(b, "sellerButton--BSIPdVcG", 1205 + 278 * i, 462, 240, 44, b != "卖掉了")
              for i, b in enumerate(buttons)]
    if feed_titles:
        nodes.append(_n("为你推荐", "title--rec", 300, 987, 120, 30))
        nodes += [_n(t, "main-title--sMrtWSJa", 400 + 250 * i, 1285, 230, 40) for i, t in enumerate(feed_titles)]
    return nodes


SOLD_PAGE = ("卖掉了", "删除")
ON_SALE = ("下架", "删除")


class FakeSellerT:
    """网页版原语最小集:/personal 默认停在「综合」,点「已售出」才切过去;详情页按 id 给。"""

    def __init__(self, *, onsale=(), sold=(), details=None, tab_count=None, has_tab=True,
                 tab_switches=True, sold_links=True, page_size=None, swipes_per_page=3):
        self.onsale, self.sold = list(onsale), list(sold)
        self.details = details or {}
        self.tab_count = len(self.sold) if tab_count is None else tab_count
        self.has_tab, self.tab_switches, self.sold_links = has_tab, tab_switches, sold_links
        # 懒加载:一页 page_size 件,往下滚 swipes_per_page 下到底才出下一页(None = 一次全给)
        self.page_size, self.swipes_per_page = page_size, swipes_per_page
        self.url, self.tab = "about:blank", "all"
        self.urls, self.taps, self.swipes = [], [], 0

    @property
    def page(self):
        return SimpleNamespace(url=self.url)

    def launch_app(self, url):
        self.url = url
        self.urls.append(url)
        if "/personal" in url:
            self.tab = "all"

    def screen_size(self):
        return W, H

    def screencap(self):
        return b"png"

    def swipe(self, *a, **k):
        self.swipes += 1

    def tap(self, x, y):
        self.taps.append((x, y))
        if "/personal" in self.url and (x, y) == SOLD_TAB_AT and self.tab_switches:
            self.tab = "sold"

    def _rendered_sold(self):
        if not self.page_size:
            return self.sold
        pages = 1 + self.swipes // self.swipes_per_page
        return self.sold[:self.page_size * pages]

    def dump_nodes(self):
        if "/personal" in self.url:
            nodes = [NICK]
            if self.has_tab:
                nodes += _tabs(len(self.onsale), self.tab_count, self.tab)
            cards = self._rendered_sold() if self.tab == "sold" else self.onsale + self.sold
            for i, (item_id, title) in enumerate(cards):
                card = _card(item_id, title, i)
                nodes += card if self.sold_links or self.tab != "sold" else card[1:]
            return nodes
        if "/item" in self.url:
            return self.details.get(self.url.split("id=")[1].split("&")[0], [])
        return [NICK]


def _no_sleep(monkeypatch):
    monkeypatch.setattr(sold_scan_web.time, "sleep", lambda *_: None)


def _shots(name, data):
    return f"shots/{name}.png"


def _lst(item_id, title="【hkc g24h3max】成色如图，功能正常，实物拍摄，喜"):
    return {"listing_id": f"L{item_id}", "item_id": item_id, "title": title}


HKC = ("1092380505010", "【hkc g24h3max】成色如图，功能正常，实物拍摄，喜")
SS_SOLD = ("1092909328306", "【盛色 N50PRO6】成色如图，功能正常，实物拍摄，喜欢直")
SS_TWIN = ("1090734350090", "【盛色 N50PRO6】成色如图，功能正常，实物拍摄，喜欢直")   # 另一个 SKU,同标题同价,还在售


# ---------- 纯解析 ----------

def test_sold_tab_real_page():
    tab, count = find_sold_tab(_flat(_tabs(42, 2, "all")))
    assert tab["desc"] == "已售出2" and count == 2 and "active" not in tab["cls"]
    tab, _ = find_sold_tab(_flat(_tabs(42, 2, "sold")))
    assert "tabItem-active--" in tab["cls"]


def test_sold_tab_count_in_sibling_node_and_missing():
    nodes = _flat([_n("已售出", "tabItem--HiFOTMcp", 532, 425), _n("12", "span count--c", 572, 426)])
    assert find_sold_tab(nodes)[1] == 12
    assert find_sold_tab(_flat([_n("已售出", "tabItem--HiFOTMcp", 532, 425)]))[1] is None
    assert find_sold_tab(_flat([_n("在售42", "tabItem--HiFOTMcp", 452, 425)])) == (None, None)


def test_feed_item_ids_in_page_order_deduped():
    nodes = _flat(_card(*HKC, 0) + _card(*SS_SOLD, 1) + _card(*HKC, 2))
    assert feed_item_ids(nodes) == [HKC[0], SS_SOLD[0]]


def test_detail_sold_needs_the_sold_button():
    assert detail_sold_state(_flat(_detail(HKC[1], SOLD_PAGE))) == (True, "卖掉了")
    assert detail_sold_state(_flat(_detail(HKC[1], ON_SALE))) == (False, "在售")
    assert detail_sold_state(_flat(_detail(HKC[1], ("已下架", "删除"))))[0] is False
    assert detail_sold_state(_flat([_n("糟糕！宝贝被删掉了", "div x", 700, 300)])) == (False, "已删除")


def test_detail_without_seller_buttons_is_not_sold():
    """没有卖家按钮 = 掉登录了 / 不是本号的货:页上再像卖掉了也不算。"""
    page = _detail(HKC[1], ()) + [_n("我想要", "buy--btn", 1300, 462, 200, 44, True)]
    sold, why = detail_sold_state(_flat(page))
    assert not sold and "卖家按钮" in why
    sold, why = detail_sold_state(_flat(_detail(HKC[1], ("编辑", "删除"))))
    assert not sold and "不认识" in why


# ---------- 整条流程 ----------

def test_flow_marks_the_sold_one_of_two_identical_titles(monkeypatch):
    """同一个号两件不同 SKU、标题价格一字不差:按 item_id 只记卖掉的那件(10-17 生产原样)。"""
    _no_sleep(monkeypatch)
    t = FakeSellerT(onsale=[SS_TWIN], sold=[HKC, SS_SOLD],
                    details={HKC[0]: _detail(HKC[1], SOLD_PAGE), SS_SOLD[0]: _detail(SS_SOLD[1], SOLD_PAGE),
                             SS_TWIN[0]: _detail(SS_TWIN[1], ON_SALE)})
    spec = {"listings": [_lst(*HKC), _lst(*SS_SOLD), _lst(*SS_TWIN), _lst("555", "别的货")], "max_confirm": 5}
    r = sold_scan_web.run_sold_scan_web(t, spec, shot_sink=_shots)
    assert r["ok"], r
    assert [s["item_id"] for s in r["sold"]] == [HKC[0], SS_SOLD[0]]
    assert r["sold_count"] == 2 and r["sold_ids"] == 2 and r["candidates"] == 2
    assert not any(SS_TWIN[0] in u or "id=555" in u for u in t.urls), "不在已售出里的在架货不开详情页"


def test_flow_skips_sold_links_not_in_ledger_and_caps(monkeypatch):
    _no_sleep(monkeypatch)
    sold = [(str(1000 + i), f"货{i}") for i in range(6)]
    t = FakeSellerT(sold=sold, details={i: _detail(title, SOLD_PAGE) for i, title in sold})
    spec = {"listings": [_lst(i, title) for i, title in sold[:4]], "max_confirm": 3}
    r = sold_scan_web.run_sold_scan_web(t, spec, shot_sink=_shots)
    assert r["ok"] and r["sold_ids"] == 6
    assert [s["item_id"] for s in r["sold"]] == ["1000", "1001", "1002"], "账本里没有的不管;一轮最多确认 3 个"


def test_flow_scrolls_past_the_first_page_of_sold_items(monkeypatch):
    """一页 20 件、滚到底才出下一页:第二页上的漏单也要找得到(洞穴Q弹的荆芥已售出 191 件)。"""
    _no_sleep(monkeypatch)
    sold = [(str(4000 + i), f"货{i}") for i in range(45)]
    t = FakeSellerT(sold=sold, page_size=20, details={i: _detail(title, SOLD_PAGE) for i, title in sold})
    r = sold_scan_web.run_sold_scan_web(t, {"listings": [_lst("4030", "货30")]}, shot_sink=_shots)
    assert r["ok"] and r["sold_ids"] == 45
    assert [s["item_id"] for s in r["sold"]] == ["4030"]


def test_flow_does_not_scroll_once_tab_count_is_read(monkeypatch):
    _no_sleep(monkeypatch)
    t = FakeSellerT(sold=[HKC, SS_SOLD], details={HKC[0]: _detail(HKC[1], SOLD_PAGE)})
    sold_scan_web.run_sold_scan_web(t, {"listings": [_lst(*HKC)]}, shot_sink=_shots)
    assert t.swipes == 0


def test_flow_gives_up_after_three_swipes_without_new_links(monkeypatch):
    """tab 写 191 件、滚了也不出下一页:滚 3 下没新链接就停,不把 8 下都耗完。"""
    _no_sleep(monkeypatch)
    sold = [(str(5000 + i), f"货{i}") for i in range(20)]
    t = FakeSellerT(sold=sold, tab_count=191, page_size=20, swipes_per_page=99)
    r = sold_scan_web.run_sold_scan_web(t, {"listings": [_lst("9", "别的")]}, shot_sink=_shots)
    assert r["ok"] and r["sold_ids"] == 20 and t.swipes == 3


def test_catch_up_run_can_scroll_deeper(monkeypatch):
    _no_sleep(monkeypatch)
    sold = [(str(6000 + i), f"货{i}") for i in range(191)]
    t = FakeSellerT(sold=sold, page_size=20, details={"6185": _detail("货185", SOLD_PAGE)})
    spec = {"listings": [_lst("6185", "货185")], "max_swipes": 60}
    r = sold_scan_web.run_sold_scan_web(t, spec, shot_sink=_shots)
    assert r["ok"] and r["sold_ids"] == 191 and [s["item_id"] for s in r["sold"]] == ["6185"]
    t2 = FakeSellerT(sold=sold, page_size=20)
    r2 = sold_scan_web.run_sold_scan_web(t2, {"listings": [_lst("6185", "货185")]}, shot_sink=_shots)
    assert r2["ok"] and r2["sold_ids"] < 191 and r2["sold"] == [], "平时只滚 8 下,老成交留给补查"


def test_flow_in_sold_list_but_detail_not_sold_is_not_reported(monkeypatch):
    _no_sleep(monkeypatch)
    t = FakeSellerT(sold=[HKC], details={HKC[0]: _detail(HKC[1], ON_SALE)})
    r = sold_scan_web.run_sold_scan_web(t, {"listings": [_lst(*HKC)]}, shot_sink=_shots)
    assert r["ok"] and r["sold"] == []
    assert r["checked"] == [{"item_id": HKC[0], "sold": False, "why": "在售"}]


def test_flow_refuses_when_tab_did_not_switch(monkeypatch):
    """点了「已售出」还停在「综合」:读到的是在售链接,整轮不报、一个详情页都不开。"""
    _no_sleep(monkeypatch)
    onsale = [(str(2000 + i), f"在售货{i}") for i in range(20)]
    t = FakeSellerT(onsale=onsale, sold=[HKC], tab_switches=False,
                    details={i: _detail(title, SOLD_PAGE) for i, title in onsale})
    r = sold_scan_web.run_sold_scan_web(t, {"listings": [_lst(i, title) for i, title in onsale]}, shot_sink=_shots)
    assert not r["ok"] and r["failed_step"] == "sold_tab" and not r.get("sold")
    assert not any("/item" in u for u in t.urls)


def test_flow_refuses_when_cards_have_no_links(monkeypatch):
    """卡片又不是 <a> 了(页面改版):有卡片读不到链接 → 失败,不悄悄当没卖。"""
    _no_sleep(monkeypatch)
    t = FakeSellerT(sold=[HKC], sold_links=False, details={HKC[0]: _detail(HKC[1], SOLD_PAGE)})
    r = sold_scan_web.run_sold_scan_web(t, {"listings": [_lst(*HKC)]}, shot_sink=_shots)
    assert not r["ok"] and r["failed_step"] == "sold_list"


def test_flow_refuses_when_more_links_than_tab_count(monkeypatch):
    _no_sleep(monkeypatch)
    sold = [(str(3000 + i), f"货{i}") for i in range(8)]
    t = FakeSellerT(sold=sold, tab_count=2, details={i: _detail(title, SOLD_PAGE) for i, title in sold})
    r = sold_scan_web.run_sold_scan_web(t, {"listings": [_lst(i, title) for i, title in sold]}, shot_sink=_shots)
    assert not r["ok"] and r["failed_step"] == "sold_list"


def test_flow_without_sold_tab_fails_clearly(monkeypatch):
    _no_sleep(monkeypatch)
    t = FakeSellerT(has_tab=False)
    r = sold_scan_web.run_sold_scan_web(t, {"listings": [_lst(*HKC)]}, shot_sink=_shots)
    assert not r["ok"] and r["failed_step"] == "sold_tab" and "已售出" in r["reason"]


def test_flow_nothing_sold_yet_does_not_click(monkeypatch):
    _no_sleep(monkeypatch)
    t = FakeSellerT(onsale=[HKC], sold=[])
    r = sold_scan_web.run_sold_scan_web(t, {"listings": [_lst(*HKC)]}, shot_sink=_shots)
    assert r["ok"] and r["sold"] == [] and r["sold_count"] == 0 and t.taps == []


def test_flow_detail_page_has_no_header_nick_and_that_is_fine(monkeypatch):
    """详情页页头只有搜索框没有登录昵称(卖家昵称在内容区 item-user-info-nick--):别当掉登录。"""
    _no_sleep(monkeypatch)
    t = FakeSellerT(sold=[HKC], details={HKC[0]: _detail(HKC[1], SOLD_PAGE)})
    r = sold_scan_web.run_sold_scan_web(t, {"listings": [_lst(*HKC)]}, shot_sink=_shots)
    assert r["ok"] and not r.get("login") and [s["item_id"] for s in r["sold"]] == [HKC[0]]


def test_flow_ignores_risk_words_in_recommendations(monkeypatch):
    """「为你推荐」是别人的商品,标题里有「违规」「申诉」不是风控,不能熔断冻号。"""
    _no_sleep(monkeypatch)
    page = _detail(HKC[1], SOLD_PAGE, feed_titles=("违规车辆查询代办", "账号申诉代写"))
    t = FakeSellerT(sold=[HKC], details={HKC[0]: page})
    r = sold_scan_web.run_sold_scan_web(t, {"listings": [_lst(*HKC)]}, shot_sink=_shots)
    assert r["ok"] and not r.get("risk") and [s["item_id"] for s in r["sold"]] == [HKC[0]]


def test_flow_risk_page_on_detail_still_stops(monkeypatch):
    _no_sleep(monkeypatch)
    t = FakeSellerT(sold=[HKC], details={HKC[0]: [_n("请拖动下方滑块完成验证", "x", 800, 400, 300, 40)]})
    r = sold_scan_web.run_sold_scan_web(t, {"listings": [_lst(*HKC)]}, shot_sink=_shots)
    assert not r["ok"] and r.get("risk") and not r.get("sold")


def test_flow_logged_out_on_personal_reports_login(monkeypatch):
    _no_sleep(monkeypatch)
    t = FakeSellerT(sold=[HKC])
    t.dump_nodes = lambda: [_n("登录", "nick--RyNYtDXM", 1472, 36)]
    t.login_assist = lambda: None
    t.reconnect_assist = lambda: {"dialog": False, "clicked": None}
    r = sold_scan_web.run_sold_scan_web(t, {"listings": [_lst(*HKC)]}, shot_sink=_shots)
    assert not r["ok"] and r.get("login") is True


def test_sold_scan_is_a_browser_flow_the_scheduler_dispatches():
    assert runner._pick_flow("sold_scan", "browser") is sold_scan_web.run_sold_scan_web
    assert "sold_scan" in runner.DISPATCHABLE_TYPES
    assert runner._pick_flow("sold_scan", "android") is None


# ---------- 记账 ----------

def _account(db, *, kind="browser", online=True, status=AccountStatus.ACTIVE, risk=RiskState.NORMAL):
    dev = Device(name="adspower browser", kind=kind,
                 status=DeviceStatus.ONLINE if online else DeviceStatus.OFFLINE)
    db.add(dev)
    db.flush()
    acc = Account(nick=f"n-{uuid4().hex[:8]}", device_id=dev.id, status=status, risk_state=risk,
                  last_op_at=datetime.utcnow() - timedelta(hours=1))
    db.add(acc)
    db.commit()
    return acc


def _listing(db, acc, item_id, title="【hkc g24h3max】成色如图", status=ListingStatus.LIVE, sku="SK1"):
    lst = Listing(sku=sku, account_id=acc.id, item_id=item_id, title=title, status=status, price=339)
    db.add(lst)
    db.commit()
    return lst


def test_sold_scan_ok_marks_only_this_accounts_live_listing_by_item_id(db):
    acc = _account(db)
    other = _account(db)
    hit = _listing(db, acc, "111")
    twin = _listing(db, acc, "999", sku="SK9")                 # 同标题另一件:不碰
    delisted = _listing(db, acc, "222", status=ListingStatus.DELISTED, sku="SK2")
    others = _listing(db, other, "111")
    task = Task(task_type="sold_scan", account_id=acc.id, status=TaskStatus.SUCCESS, spec={},
                result={"ok": True, "sold": [{"item_id": "111"}, {"item_id": "222"}, {"item_id": ""}]})
    db.add(task)
    db.commit()

    jobs._on_sold_scan_ok(db, task)
    jobs._on_sold_scan_ok(db, task)                            # 幂等
    db.commit()
    db.expire_all()
    assert db.get(Listing, hit.id).status == ListingStatus.SOLD
    assert db.get(Listing, hit.id).last_synced_at is not None
    assert db.get(Listing, twin.id).status == ListingStatus.LIVE
    assert db.get(Listing, delisted.id).status == ListingStatus.DELISTED
    assert db.get(Listing, others.id).status == ListingStatus.LIVE


def test_on_task_result_routes_sold_scan(db, monkeypatch):
    monkeypatch.setattr(jobs, "SessionLocal", sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False))
    acc = _account(db)
    lst = _listing(db, acc, "111")
    task = Task(task_type="sold_scan", account_id=acc.id, status=TaskStatus.SUCCESS, spec={},
                result={"ok": True, "sold": [{"item_id": "111"}]})
    db.add(task)
    db.commit()
    jobs.on_task_result(task.id, True)
    db.expire_all()
    assert db.get(Listing, lst.id).status == ListingStatus.SOLD


def test_create_sold_scan_spec_dedupe_and_nothing_to_check(db, monkeypatch):
    monkeypatch.setattr(jobs.settings, "sold_scan_max_confirm", 4)
    acc = _account(db)
    _listing(db, acc, "111")
    _listing(db, acc, None, sku="SK0")                         # 没 item_id:没法直开详情页
    _listing(db, acc, "333", status=ListingStatus.SOLD, sku="SK3")
    assert jobs.create_sold_scan(db, acc.id) is not None
    assert jobs.create_sold_scan(db, acc.id) is None           # 在途去重
    tasks = db.query(Task).filter(Task.account_id == acc.id, Task.task_type == "sold_scan").all()
    assert len(tasks) == 1
    assert tasks[0].spec["max_confirm"] == 4
    assert [x["item_id"] for x in tasks[0].spec["listings"]] == ["111"]
    empty = _account(db)
    _listing(db, empty, "444", status=ListingStatus.SOLD)
    assert jobs.create_sold_scan(db, empty.id) is None         # 没有可对的在架链接
    deep = _account(db)
    _listing(db, deep, "555")
    jobs.create_sold_scan(db, deep.id, source="MANUAL", max_confirm=20, max_swipes=60)
    spec = db.query(Task).filter(Task.account_id == deep.id).one().spec
    assert spec["max_confirm"] == 20 and spec["max_swipes"] == 60


# ---------- 门铃:会话出现成交状态就提前查 ----------

def _chat_scan_task(db, acc, status="等待卖家发货"):
    task = Task(task_type="chat_scan", account_id=acc.id, status=TaskStatus.SUCCESS, spec={},
                device_id=acc.device_id,
                result={"conversations": [{"peer_key": "b1", "peer_nick": "买家", "item_title": None,
                                           "order_status": status, "last_message": "已付款", "unread": 1}],
                        "messages": {"b1": [{"direction": "in", "text": "已付款"}]}})
    db.add(task)
    db.commit()
    return task


def _sold_scans(db, acc):
    return db.query(Task).filter(Task.account_id == acc.id, Task.task_type == "sold_scan").all()


def test_paid_conversation_on_browser_account_rings_sold_scan(db, monkeypatch):
    monkeypatch.setattr(jobs, "maybe_notify_new_messages", lambda *a, **k: None)
    monkeypatch.setattr(jobs.settings, "sold_scan_enabled", True)
    acc = _account(db)
    _listing(db, acc, "111")
    jobs._on_chat_scan_ok(db, _chat_scan_task(db, acc))
    jobs._on_chat_scan_ok(db, _chat_scan_task(db, acc))       # 10 分钟内再响:不重复建
    assert len(_sold_scans(db, acc)) == 1
    assert _sold_scans(db, acc)[0].source == "CHAT"


def test_no_ring_for_unpaid_phone_or_switched_off(db, monkeypatch):
    monkeypatch.setattr(jobs, "maybe_notify_new_messages", lambda *a, **k: None)
    monkeypatch.setattr(jobs.settings, "sold_scan_enabled", True)
    unpaid = _account(db)
    _listing(db, unpaid, "111")
    jobs._on_chat_scan_ok(db, _chat_scan_task(db, unpaid, status="等待买家付款"))
    phone = _account(db, kind="android")
    _listing(db, phone, "222")
    jobs._on_chat_scan_ok(db, _chat_scan_task(db, phone))
    assert _sold_scans(db, unpaid) == [] and _sold_scans(db, phone) == []
    monkeypatch.setattr(jobs.settings, "sold_scan_enabled", False)
    off = _account(db)
    _listing(db, off, "333")
    jobs._on_chat_scan_ok(db, _chat_scan_task(db, off))
    assert _sold_scans(db, off) == []


# ---------- 调度 ----------

def _bind(db, monkeypatch):
    monkeypatch.setattr(sched_mod, "SessionLocal",
                        sessionmaker(bind=db.get_bind(), autoflush=False, autocommit=False))


def test_sold_scan_pass_only_for_online_active_browser_accounts_with_live_links(db, monkeypatch):
    _bind(db, monkeypatch)
    monkeypatch.setattr(sched_mod.settings, "sold_scan_enabled", True)
    ok = _account(db)
    _listing(db, ok, "111")
    no_item_id = _account(db)
    _listing(db, no_item_id, None)
    nothing_live = _account(db)
    _listing(db, nothing_live, "222", status=ListingStatus.SOLD)
    phone = _account(db, kind="android")
    _listing(db, phone, "333")
    offline = _account(db, online=False)
    _listing(db, offline, "444")
    frozen = _account(db, status=AccountStatus.FROZEN, risk=RiskState.FROZEN)
    _listing(db, frozen, "555")

    Scheduler(bridge=None)._sold_scan_pass()
    Scheduler(bridge=None)._sold_scan_pass()                   # 再扫一轮:在途去重
    db.expire_all()
    assert len(_sold_scans(db, ok)) == 1
    for acc in (no_item_id, nothing_live, phone, offline, frozen):
        assert _sold_scans(db, acc) == [], acc.nick


def test_sold_scan_pass_respects_switch(db, monkeypatch):
    _bind(db, monkeypatch)
    monkeypatch.setattr(sched_mod.settings, "sold_scan_enabled", False)
    acc = _account(db)
    _listing(db, acc, "111")
    Scheduler(bridge=None)._sold_scan_pass()
    assert _sold_scans(db, acc) == []

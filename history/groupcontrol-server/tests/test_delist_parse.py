"""下架/重新上架(及共用定位的改价)节点解析的真机 fixture 回归。

fixture 来自 2026-07-22 生产账号 xy327135390876 真机往返(下架→重新上架闭环)的
uiautomator dump:在卖(1件)、在卖(空)、已下架(多件)。这些是节点优先改造能不能
在真机上命中的定海神针——盲点坐标/角标读数都在这条链路上真实翻过车(见
docs/2026-07-21-节点优先定位-OCR盲点改造调研.md)。
"""
import json
import pathlib

import pytest

from app.flow import delist_flow as D
from app.flow import ocr as O
from app.flow import relist_flow as R
from app.flow import reprice_flow as P

FX = pathlib.Path(__file__).parent / "fixtures"


class FakeEngine:
    """只实现 list_cards / live_count / find_more_icon 需要的面:dump_nodes/find_node/宽高;
    行内按钮只有 OCR 读得到,另给 read/find_any(读 ocr 参数),点击记进 taps。"""

    width, height = 1080, 2400

    def __init__(self, nodes, ocr=()):
        self._nodes = nodes
        self._ocr = list(ocr)
        self.taps = []

    def dump_nodes(self):
        return self._nodes

    def read(self):
        return self._ocr

    def find_any(self, targets, timeout=0):   # 同 Engine.find_any,只是不轮询
        for t in targets:
            hit = O.find(self._ocr, t)
            if hit:
                return t, hit
        return None

    def tap_xy(self, x, y, settle=0.4):
        self.taps.append((x, y))

    def find_node(self, contains, clickable_only=False):
        cands = [n for n in self._nodes
                 if contains in (n.get("desc") or "")
                 and (not clickable_only or n.get("clickable"))]
        if not cands:
            return None
        return min(cands, key=lambda n: (n["size"][0] * n["size"][1]) or 1 << 30)

    def save_shot(self, name):   # locate_row_y 歧义失败会截图存证
        return None

    def find(self, text, contains=False, timeout=0):   # title_hint 走 OCR:卡片不显示 SKU,当它没命中
        return None


def _engine(name):
    d = json.loads((FX / name).read_text(encoding="utf-8"))
    return FakeEngine(d["nodes"])


# ---------------- list_cards / extract_title ----------------

def test_list_cards_on_sale_one_item():
    e = _engine("delist_live_1item.json")
    cards = D.list_cards(e)
    assert len(cards) == 1
    assert "泰坦军团P2510H PLUS" in cards[0]["title"]


def test_list_cards_empty_on_sale():
    e = _engine("delist_live_empty.json")
    assert D.list_cards(e) == []


def test_list_cards_offshelf_multi_titles():
    e = _engine("delist_offshelf_multi.json")
    titles = [c["title"] for c in D.list_cards(e)]
    # 已下架多件:P2510H PLUS 与 P2510G 是两个不同型号,标题必须各自抽出、可区分
    assert any("P2510H PLUS" in t for t in titles)
    assert any("P2510G" in t for t in titles)
    assert len([t for t in titles if "P2510H PLUS" in t]) == 1


def test_extract_title_skips_buttons_picks_title():
    desc = "降价\n编辑\n补充细节图，宝贝曝光蹭蹭涨\n【泰坦军团P2510H PLUS显示器】25寸\n曝光397\n浏览13"
    assert D.extract_title(desc) == "【泰坦军团P2510H PLUS显示器】25寸"


def test_extract_title_skips_top_promo_banner_tied_length():
    # 卡片顶部营销横幅(按钮之前)与真标题同长,「取最长」会误选横幅 → 结构上排除按钮之前的段
    desc = "设置佣金，获取官方流量扶持\n降价\n编辑\n全栈软件开发，前端后端均可\n曝光1.8万\n浏览660\n想要119\n¥\n100"
    assert D.extract_title(desc) == "全栈软件开发，前端后端均可"


def test_extract_title_skips_long_task_banner():
    # 「做任务，得超级擦亮红包…」比真标题还长,更要靠结构位置(按钮后)而非长度取标题
    desc = "做任务，得超级擦亮红包或闲鱼皮肤！\n降价\n编辑\n全栈软件开发，前端后端均可\n曝光1.8万\n¥\n100"
    assert D.extract_title(desc) == "全栈软件开发，前端后端均可"


# ---------------- extract_price:名称+价格匹配的价格半边 ----------------

def test_extract_price_after_yen():
    assert D.extract_price("降价\n编辑\n全栈软件开发，前端后端均可\n曝光1.8万\n¥\n100") == 100


def test_extract_price_none_when_absent():
    assert D.extract_price("降价\n编辑\nAOC 24G2 显示器\n曝光10\n浏览3") is None


def _card_node(title, price, y):
    return {"desc": f"降价\n编辑\n{title}\n曝光10\n¥\n{price}", "cls": "android.view.View",
            "clickable": True, "center": (540, y), "size": (1080, 480)}


def test_locate_row_y_name_plus_price_disambiguates_same_title():
    # 同标题两件、价不同:名称+价格锁定唯一(430→上面那件,460→下面那件)
    e = FakeEngine([_card_node("AOC 24G2 显示器", 430, 1200),
                    _card_node("AOC 24G2 显示器", 460, 1700)])
    assert D.locate_row_y(e, {"title": "AOC 24G2 显示器", "price": 430}) == 1200
    assert D.locate_row_y(e, {"title": "AOC 24G2 显示器", "price": 460}) == 1700


def test_locate_row_y_same_title_no_price_still_ambiguous():
    # 同标题两件、未给价:退回纯标题判定,多件仍拒绝盲选(不能瞎点第一行下架错商品)
    import pytest
    e = FakeEngine([_card_node("AOC 24G2 显示器", 430, 1200),
                    _card_node("AOC 24G2 显示器", 460, 1700)])
    with pytest.raises(D.StepError):
        D.locate_row_y(e, {"title": "AOC 24G2 显示器"})


# ---------------- locate_row_y:对不上就不点(宁可不下也不下错) ----------------

def test_locate_row_y_single_card_not_matching_refuses():
    # 在卖只剩 1 件、却不是要下的那件(要下的已被人手动下了 / 标题回读错了):以前退回这张唯一卡片,
    # 下错商品;现在标题、提示词都对不上就失败,不点
    e = _engine("delist_live_1item.json")
    with pytest.raises(D.StepError) as ei:
        D.locate_row_y(e, {"title": "AOC 24G2 显示器", "price": 430, "title_hint": "SKU1"})
    assert ei.value.step == "locate_item"
    assert "在卖列表里没对上这件商品，没有下架" in ei.value.reason


def test_locate_row_y_single_card_without_title_refuses():
    # 链接没记下标题:哪怕在卖只有 1 件也不猜
    e = _engine("delist_live_1item.json")
    with pytest.raises(D.StepError) as ei:
        D.locate_row_y(e, {"title_hint": "SKU1"})
    assert "没有下架" in ei.value.reason and "没记下标题" in ei.value.reason


def test_locate_row_y_reprice_says_not_repriced():
    # 改价也走这一步定位:对不上同样不点,原因说「没有改价」
    e = _engine("delist_live_1item.json")
    with pytest.raises(D.StepError) as ei:
        D.locate_row_y(e, {"title": "AOC 24G2 显示器", "new_price": 400})
    assert "没有改价" in ei.value.reason


def test_locate_row_y_single_card_matching_title_still_found():
    # 对照:标题对得上,1 件照常定位
    e = _engine("delist_live_1item.json")
    card = D.list_cards(e)[0]
    assert D.locate_row_y(e, {"title": card["title"]}) == card["y"]


def test_step_delist_without_located_row_refuses():
    # 没经 locate_item 定位(spec 里没有 _row_y)就不点:以前退回「第一行」的比例坐标盲点
    e = _engine("delist_live_1item.json")
    with pytest.raises(D.StepError) as ei:
        D.step_delist(e, {"title": "AOC 24G2 显示器"})
    assert ei.value.step == "delist"


# ---------------- 重新上架:先在已下架列表里对上这件商品,再点它那一行的「重新上架」 ----------------
# 行内按钮 dump 里没有(卡片是合并节点),只有 OCR 读得到——用例里按卡片位置合成(卡片中心下 80px)

P2510G = "【泰坦军团P2510G显示器】24.5寸直屏，HDMI接口，"   # 真机已下架 dump 里第二张卡片的标题


def _ocr_hit(text, y, score=0.99):
    return {"text": text, "center": (930, y), "score": score}


def _offshelf_card(title, price, y):
    return {"desc": f"主动下架\n删除\n重新上架\n{title}\n浏览6\n¥\n{price}", "cls": "android.view.View",
            "clickable": False, "center": (540, y), "size": (1080, 380)}


def _offshelf_multi(skip_row=None):
    """真机已下架多件 dump;每张露出来的卡片上各一个「重新上架」(skip_row 那张没认出来)。"""
    nodes = _engine("delist_offshelf_multi.json").dump_nodes()
    rows = [n["center"][1] for n in nodes if "重新上架" in n["desc"] and n["size"][1] >= 150]
    return FakeEngine(nodes, ocr=[_ocr_hit("重新上架", y + 80) for y in rows if y != skip_row])


def test_relist_single_item_matching_title_taps_it():
    e = FakeEngine([_offshelf_card(P2510G, 460, 1400)], ocr=[_ocr_hit("重新上架", 1480)])
    R.step_relist_open_editor(e, {"title": P2510G, "price": 460, "title_hint": "SKU1"})
    assert e.taps == [(930, 1480)]


def test_relist_single_button_not_matching_refuses():
    # 已下架只剩 1 件、却不是要上的那件(要上的已被人手动上架/删了、或标题回读错了):以前只有一个
    # 「重新上架」就直接点,把别的商品重新上架了;现在对不上就失败,不点
    e = FakeEngine([_offshelf_card(P2510G, 460, 1400)], ocr=[_ocr_hit("重新上架", 1480)])
    with pytest.raises(D.StepError) as ei:
        R.step_relist_open_editor(e, {"title": "【AOC显示器】24寸", "price": 200, "title_hint": "SKU1"})
    assert e.taps == []
    assert ei.value.step == "locate_item"
    assert ei.value.reason == "已下架列表里没对上这件商品，没有重新上架（找的是「【AOC显示器】24寸」，列表里有 1 件）"


def test_relist_multi_taps_only_the_matching_row():
    # 已下架 3 件露在屏上、各有一个「重新上架」:只点对上的那件(第二张),不是最上面那件
    e = _offshelf_multi()
    assert len(e.read()) == 3
    R.step_relist_open_editor(e, {"title": P2510G, "price": 460, "title_hint": "SKU1"})
    assert e.taps == [(930, 1761 + 80)]


def test_relist_without_title_refuses_even_single_item():
    # 链接没记下标题:哪怕已下架只有 1 件也不猜
    e = FakeEngine([_offshelf_card(P2510G, 460, 1400)], ocr=[_ocr_hit("重新上架", 1480)])
    with pytest.raises(D.StepError) as ei:
        R.step_relist_open_editor(e, {"title": None, "price": 460, "title_hint": "SKU1"})
    assert e.taps == []
    assert "没有重新上架" in ei.value.reason and "没记下标题" in ei.value.reason


def test_relist_same_title_picks_by_price():
    # 同标题两件、价不同:和下架一样用名称+价格锁定(以前重新上架只认标题,同名两件直接拒绝)
    e = FakeEngine([_offshelf_card(P2510G, 460, 1400), _offshelf_card(P2510G, 420, 1800)],
                   ocr=[_ocr_hit("重新上架", 1480), _ocr_hit("重新上架", 1880)])
    R.step_relist_open_editor(e, {"title": P2510G, "price": 420})
    assert e.taps == [(930, 1880)]


def test_relist_does_not_borrow_neighbor_rows_button():
    # 对上了第二张卡片,可它那一行的「重新上架」没认出来:不拿相邻卡片的按钮凑数
    e = _offshelf_multi(skip_row=1761)
    with pytest.raises(D.StepError) as ei:
        R.step_relist_open_editor(e, {"title": P2510G, "price": 460})
    assert e.taps == []
    assert ei.value.step == "relist" and "没有重新上架" in ei.value.reason


# ---------------- 改价:点定位到的那一行的「编辑」 ----------------

def test_reprice_open_edit_taps_located_rows_edit():
    # 在卖两件、各有一个「编辑」:点定位到的那件(下面那张)的,不是 OCR 置信度最高的那个
    e = FakeEngine([_card_node("AOC 24G2 显示器", 430, 1200), _card_node("泰坦军团 P2510G", 460, 1700)],
                   ocr=[_ocr_hit("编辑", 1230, score=0.99), _ocr_hit("编辑", 1730, score=0.80)])
    spec = {"title": "泰坦军团 P2510G", "price": 460, "new_price": 400}
    D.step_locate_item(e, spec)
    P.step_open_edit(e, spec)
    assert e.taps == [(930, 1730)]


def test_reprice_open_edit_single_item_still_taps():
    # 对照:真机在卖 1 件,标题对上就点它的「编辑」
    e = FakeEngine(_engine("delist_live_1item.json").dump_nodes(), ocr=[_ocr_hit("编辑", 1455)])
    spec = {"title": D.list_cards(e)[0]["title"], "price": 460, "new_price": 400}
    D.step_locate_item(e, spec)
    P.step_open_edit(e, spec)
    assert e.taps == [(930, 1455)]


def test_reprice_open_edit_without_located_row_refuses():
    # 没经 locate_item 定位就不点(以前屏上有「编辑」就点)
    e = FakeEngine([_card_node("AOC 24G2 显示器", 430, 1200)], ocr=[_ocr_hit("编辑", 1230)])
    with pytest.raises(D.StepError) as ei:
        P.step_open_edit(e, {"title": "AOC 24G2 显示器", "new_price": 400})
    assert e.taps == []
    assert ei.value.step == "open_edit" and "没有改价" in ei.value.reason


# ---------------- live_count:角标不可靠,只作弱提示 ----------------

def test_live_count_reads_badge_number():
    assert D.live_count(_engine("delist_live_1item.json")) == 1


def test_live_count_empty_badge_is_none_not_zero():
    # 空在卖角标退化成纯「在卖」——返回 None(不可猜 0,1 件在卖时也可能不显示数字)
    assert D.live_count(_engine("delist_live_empty.json")) is None


# ---------------- find_more_icon:节点比盲点比例坐标准 ----------------

def test_find_more_icon_beats_blind_ratio():
    e = _engine("delist_live_1item.json")
    row_y = D.list_cards(e)[0]["y"]
    icon = D.find_more_icon(e, row_y)
    assert icon is not None
    ratio_y = row_y + int(e.height * D.MORE_ICON_DY_FRAC)
    # 节点定位(cy≈1455)与盲点比例(≈1511)差 ~56px——正是旧代码「点空→假成功」的病根
    assert abs(icon[1] - ratio_y) >= 40


# ---------------- delist_confirmed:下架生效判定(纯函数) ----------------

def test_delist_confirmed_single_item_dropped_to_zero():
    # 单商品、无 title:在卖卡片 1→0 即成功
    assert D.delist_confirmed(["泰坦军团显示器"], [], "") is True


def test_delist_confirmed_single_item_still_there_fails():
    assert D.delist_confirmed(["泰坦军团显示器"], ["泰坦军团显示器"], "") is False


def test_delist_confirmed_target_left_multi():
    target = "【泰坦军团P2510H PLUS显示器】25寸，HDMI接口"
    remaining = ["【泰坦军团P2510G显示器】24.5寸直屏，HDMI接口，"]
    assert D.delist_confirmed([target] + remaining, remaining, target) is True


def test_delist_confirmed_target_still_present_multi():
    target = "【泰坦军团P2510H PLUS显示器】25寸，HDMI接口"
    still = [target, "【泰坦军团P2510G显示器】24.5寸直屏"]
    assert D.delist_confirmed(still, still, target) is False


# ---------------- 导航:底部「我的」tab 节点定位 ----------------

def test_find_home_tab_locates_me_tab():
    e = _engine("nav_home.json")
    tab = D._find_home_tab(e, "我的")
    assert tab is not None
    assert tuple(tab["center"]) == (959, 2287)


def test_find_home_tab_center_above_gesture_zone():
    # 节点中心 y 必须在系统手势区之上(OCR 文字中心 y≈2337 会被吞——这正是要绕开的坑)
    e = _engine("nav_home.json")
    tab = D._find_home_tab(e, "我的")
    assert tab["center"][1] < 2320


def test_find_home_tab_absent_when_no_bottom_bar():
    # 管理页(无底部栏)找不到「我的」tab 节点 → 返回 None,触发上层兜底退子页
    e = _engine("delist_live_1item.json")
    assert D._find_home_tab(e, "我的") is None


# ---------------- 导航:顶部 在卖/已下架 tab 节点定位 ----------------

def test_find_tab_node_on_sale_ignores_badge_number():
    # 「在卖」角标是「1\n在卖」,子串匹配照样命中,取 tab 条里的小节点
    e = _engine("delist_live_1item.json")
    n = D._find_tab_node(e, "在卖")
    assert tuple(n["center"]) == (84, 1142)


def test_find_tab_node_offshelf():
    e = _engine("delist_offshelf_multi.json")
    n = D._find_tab_node(e, "已下架")
    assert n is not None
    cx, cy = n["center"]
    assert cy < 2400 * 0.55                      # 落在 tab 条,不是下面的卡片
    assert n["size"][0] * n["size"][1] < 30000   # 是小 tab 节点,不是整屏卡片


def test_find_tab_node_not_fooled_by_card_text():
    # 已下架页卡片 desc 含「主动下架」;选「已下架」tab 绝不能点到卡片上
    e = _engine("delist_offshelf_multi.json")
    n = D._find_tab_node(e, "已下架")
    assert n["center"][1] < 1300                 # tab 条(≈1142),远在卡片(≈1400+)之上

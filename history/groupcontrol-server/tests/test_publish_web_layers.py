"""点「发布」前收弹层:不再点到屏幕外(2026-10-06 回放里每次都有一下 (520,-391)/(846,-351))。

收弹层靠点页面标题「发闲置」。表单填到后面页面已经往下滚了,标题在视口上方、cy 是负的,
原来照样去点——点到屏幕外等于没点,残留的属性下拉没收掉。
"""
import pytest

from app.flow.web import publish_flow_web as pw

W, H = 1707, 799
TITLE_Y = 40          # 标题在页面里的位置(页面坐标)


class _Page:
    """会滚动的假页面:swipe 的 y2-y1 就是滚动量(同执行端 op_swipe 的 wheel deltaY),顶到 0 为止。"""

    def __init__(self, scroll_y, title=True, stuck=False):
        self.scroll_y = scroll_y
        self.title = title
        self.stuck = stuck
        self.taps = []
        self.swipes = []

    def dump_nodes(self):
        nodes = [{"desc": "发布", "cls": "", "center": (846, 755), "size": (280, 56)}]
        if self.title:
            nodes.append({"desc": "发闲置", "cls": "", "center": (520, TITLE_Y - self.scroll_y), "size": (120, 40)})
        return nodes

    def swipe(self, x1, y1, x2, y2, ms=None):
        self.swipes.append(y2 - y1)
        if not self.stuck:
            self.scroll_y = max(0, self.scroll_y + (y2 - y1))

    def tap(self, x, y):
        self.taps.append((x, y))


@pytest.fixture(autouse=True)
def _no_sleep(monkeypatch):
    monkeypatch.setattr(pw.time, "sleep", lambda *_: None)


def _assert_on_screen(page):
    assert page.taps, "总得点一下"
    for x, y in page.taps:
        assert 0 < x < W and 0 < y < H, f"点到屏幕外了: {(x, y)}"


def test_title_scrolled_away_is_brought_back_then_tapped():
    page = _Page(scroll_y=431)                      # 标题 cy = -391,就是现场那个位置
    pw._close_stray_layers(page, W, H)
    assert page.swipes and all(d < 0 for d in page.swipes), "要往上滚,不是往下"
    assert page.taps == [(520, TITLE_Y)], "滚回来之后点的是标题本身"
    _assert_on_screen(page)


def test_title_already_visible_is_tapped_without_scrolling():
    page = _Page(scroll_y=0)
    pw._close_stray_layers(page, W, H)
    assert page.swipes == []
    assert page.taps == [(520, TITLE_Y)]


def test_no_title_falls_back_to_blank_corner():
    page = _Page(scroll_y=0, title=False)
    pw._close_stray_layers(page, W, H)
    assert page.swipes == []
    assert page.taps == [(int(W * 0.85), int(H * 0.12))]


def test_page_that_will_not_scroll_still_never_taps_off_screen():
    page = _Page(scroll_y=431, stuck=True)
    pw._close_stray_layers(page, W, H)
    assert len(page.swipes) == 4, "滚几次就停,不死循环"
    assert page.taps == [(int(W * 0.85), int(H * 0.12))]
    _assert_on_screen(page)


def test_title_low_on_screen_keeps_old_fallback():
    page = _Page(scroll_y=-500)                     # 标题在视口偏下(不在上 30%):同原来,点空白兜底
    pw._close_stray_layers(page, W, H)
    assert page.swipes == []
    assert page.taps == [(int(W * 0.85), int(H * 0.12))]

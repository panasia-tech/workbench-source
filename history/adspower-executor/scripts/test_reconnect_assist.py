"""「连接中断，请重连」弹窗自救（reconnect_assist）回归（纯离线，不碰真浏览器）。

钉死四条语义：
  1. 页面 body 里有「连接中断」→ 刷新 + 走 login_assist 点「快速进入」，
     返回 {dialog: True, clicked: 按钮文字}；
  2. 没弹窗 → 什么都不动（不刷新、不点），返回 {dialog: False, clicked: None}；
  3. evaluate 炸了（页面正导航/关闭）→ 容忍，当没弹窗返回，不抛；
  4. RPC 形态 op_reconnect_assist 走 ensure_page()，原样返回上面的 dict。

跑法：.venv/bin/python scripts/test_reconnect_assist.py
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gc_ads import login_assist  # noqa: E402
from gc_ads.login_assist import assist_login, reconnect_assist  # noqa: E402
from gc_ads.primitives import PrimitiveExecutor  # noqa: E402


class FakeElement:
    """找到的按钮。hit=False 模拟真鼠标落在挡住它的层上(要退回代码点)。"""

    def __init__(self, hit=True):
        self.hit = hit
        self.js_clicks = 0

    async def evaluate(self, js, _arg=None):
        if js == login_assist._HIT_JS:
            return self.hit
        if js == login_assist._JS_CLICK:
            self.js_clicks += 1
        return None

    async def bounding_box(self):
        return {"x": 400, "y": 300, "width": 300, "height": 44}


class FakeHandle:
    def __init__(self, element=None):
        self._el = element

    def as_element(self):
        return self._el

    async def json_value(self):
        return None


class FakeFrame:
    """login_assist 逐 frame 找按钮：这里预设页面上是「快速进入」「保持登录状态」按钮，或什么都没有。"""

    def __init__(self, result: str, hit=True):
        self.url = "https://passport.goofish.com/mini_login.htm"
        self._result = result
        self.element = FakeElement(hit)
        self.calls = 0   # 找「快速进入」的次数 = 这个 frame 被过了几遍

    def is_detached(self):
        return False

    async def evaluate_handle(self, _js, arg):
        _labels, keep_mode = arg
        if not keep_mode:
            self.calls += 1
        want = "保持登录状态" if keep_mode else "快速进入"
        return FakeHandle(self.element if self._result == want else None)


class FakeMouse:
    def __init__(self):
        self.clicks = []

    async def click(self, x, y):
        self.clicks.append((x, y))


class FakePage:
    def __init__(self, url="https://www.goofish.com/im", *, detect=False,
                 broken=False, reload_error=False, frame_result="", hit=True):
        self.url = url
        self.detect = detect          # 探测 JS 的返回（True = 弹了「连接中断」）
        self.broken = broken          # evaluate 直接抛异常
        self.reload_error = reload_error
        self.reload_calls = 0
        self.evaluated = 0
        self.reload_kwargs = None
        self.frames = [FakeFrame(frame_result, hit)]
        self.mouse = FakeMouse()

    def is_closed(self):
        return False

    async def evaluate(self, _js, _arg=None):
        self.evaluated += 1
        if self.broken:
            raise RuntimeError("Target page, context or browser has been closed")
        return self.detect

    async def reload(self, **kwargs):
        self.reload_kwargs = kwargs
        if self.reload_error:
            raise RuntimeError("net::ERR_ABORTED")
        self.reload_calls += 1

    async def wait_for_timeout(self, _ms):
        pass


class FakeDriver:
    """PrimitiveExecutor 只用到 ensure_page / note_failure / current_nick。"""

    def __init__(self, page, nick=""):
        self._page = page
        self.failures = []
        self.nick = nick
        self.notes = []

    async def current_nick(self):
        return self.nick

    def _notify(self, text):
        self.notes.append(text)

    async def ensure_page(self):
        return self._page

    def note_failure(self, exc):
        self.failures.append(exc)


def _run(coro):
    return asyncio.run(coro)


def test_dialog_triggers_reload_and_quick_entry():
    page = FakePage(detect=True, frame_result="快速进入")
    got = _run(reconnect_assist(page))
    assert got == {"dialog": True, "clicked": "快速进入"}, got
    assert page.evaluated == 1
    assert page.reload_calls == 1, "弹了「连接中断」就必须刷新"
    assert page.reload_kwargs.get("wait_until") == "domcontentloaded"
    assert page.frames[0].calls >= 1, "刷新后要再点一遍「快速进入」"


def test_clean_page_not_touched():
    page = FakePage(detect=False)
    got = _run(reconnect_assist(page))
    assert got == {"dialog": False, "clicked": None}, got
    assert page.reload_calls == 0
    assert page.frames[0].calls == 0, "没弹窗不许碰登录按钮"


def test_evaluate_failure_is_tolerated():
    """页面正在导航/关闭时探测会炸：容忍，当没弹窗，让调用方继续往下判。"""
    page = FakePage(broken=True)
    got = _run(reconnect_assist(page))
    assert got == {"dialog": False, "clicked": None}, got
    assert page.reload_calls == 0


def test_dialog_but_no_button_after_reload():
    """弹窗在、刷新后登录卡片没出来：如实报 dialog True + clicked None，调用方按
    「没点到」处理（不能当成救回来了）。"""
    page = FakePage(detect=True, frame_result="")
    got = _run(reconnect_assist(page))
    assert got == {"dialog": True, "clicked": None}, got
    assert page.reload_calls == 1


def test_reload_failure_reported():
    page = FakePage(detect=True, reload_error=True)
    got = _run(reconnect_assist(page))
    assert got == {"dialog": True, "clicked": None}, got
    assert page.frames[0].calls == 0, "没刷成不许硬点"


def test_op_reconnect_assist_returns_dict_as_is():
    page = FakePage(detect=True, frame_result="快速进入")
    driver = FakeDriver(page)
    ex = PrimitiveExecutor(driver)
    res = _run(ex.execute("r1", "reconnect_assist", {}))
    assert res["ok"] is True and res["err"] is None, res
    assert res["data"] == {"dialog": True, "clicked": "快速进入"}, res
    assert driver.failures == []


def test_op_failure_reported_via_rpc_frame():
    """ensure_page 炸了（浏览器断线）：原语如实回 ok=False 的响应帧，由服务端决策。"""
    class BoomDriver(FakeDriver):
        async def ensure_page(self):
            raise RuntimeError("browser dead")

    driver = BoomDriver(None)
    ex = PrimitiveExecutor(driver)
    res = _run(ex.execute("r3", "reconnect_assist", {}))
    assert res["ok"] is False and "browser dead" in res["err"], res
    assert len(driver.failures) == 1, "失败要记给 driver 做自愈判定"


# ---- assist_login:login_assist 原语的完整一趟(2026-10-14 南方举重雪白海胆现场) ----

def _nick_after(seq):
    """read_nick 依次返回 seq 里的值(模拟点完后第几次读到昵称)。"""
    it = iter(seq)
    async def read():
        return next(it, "")
    return read


def test_assist_quick_entry_logs_back_no_reload():
    page = FakePage(detect=False, frame_result="快速进入")
    got = _run(assist_login(page, _nick_after(["南方举重雪白海胆"])))
    assert got == "快速进入"
    assert page.reload_calls == 0, "登回去了就别刷新"
    assert page.frames[0].calls == 1
    assert len(page.mouse.clicks) == 1, "要用真鼠标点"
    assert page.frames[0].element.js_clicks == 0, "真点中了就不该再用代码点"


def test_assist_waits_for_slow_login_before_reloading():
    """点完登录要过几秒才回来:每半秒看一眼,回来了就不刷新(以前固定等 4 秒就刷新,会把正在进行的登录打断)。"""
    page = FakePage(detect=False, frame_result="快速进入")
    got = _run(assist_login(page, _nick_after(["", "", "", "", "", "", "", "", "土星耐心的黑水母"])))
    assert got == "快速进入"
    assert page.reload_calls == 0, "第 4.5 秒登回来了,不该刷新"


def test_assist_real_click_missed_falls_back_to_code_click():
    """真鼠标落在挡住按钮的层上(按钮没收到 click):退回老办法代码点,并如实报出来。"""
    page = FakePage(detect=False, frame_result="快速进入", hit=False)
    notes = []
    got = _run(assist_login(page, _nick_after(["x"]), notes.append))
    assert got == "快速进入"
    assert len(page.mouse.clicks) == 1 and page.frames[0].element.js_clicks == 1
    assert len(notes) == 1 and "代码点" in notes[0], notes


def test_assist_quick_entry_not_back_reloads_and_clicks_again():
    """点了「快速进入」还没登回去:刷新页面再点一次(人工手法)。"""
    page = FakePage(detect=False, frame_result="快速进入")
    got = _run(assist_login(page, _nick_after([""])))
    assert got == "快速进入"
    assert page.reload_calls == 1, "没登回去要刷新"
    assert page.frames[0].calls == 2, "刷新后要再点一次"


def test_assist_dialog_reloads_first():
    """挂着「连接中断」:先刷新再点,不在弹窗底下白点一次。"""
    page = FakePage(detect=True, frame_result="快速进入")
    got = _run(assist_login(page, _nick_after(["x"])))
    assert got == "快速进入"
    assert page.reload_calls == 1 and page.frames[0].calls == 1


def test_assist_nothing_to_click_leaves_page_alone():
    page = FakePage(detect=False, frame_result="")
    assert _run(assist_login(page, _nick_after([""]))) is None
    assert page.reload_calls == 0, "没登录卡片(真要扫码)就别乱刷新"


def test_assist_keep_login_only_no_reload():
    page = FakePage(detect=False, frame_result="保持登录状态")
    assert _run(assist_login(page, _nick_after([""]))) == "保持登录状态"
    assert page.reload_calls == 0


def test_assist_reload_failure_still_reports_click():
    page = FakePage(detect=False, frame_result="快速进入", reload_error=True)
    assert _run(assist_login(page, _nick_after([""]))) == "快速进入"


def test_op_login_assist_uses_full_assist():
    page = FakePage(detect=False, frame_result="快速进入")
    driver = FakeDriver(page, nick="")
    ex = PrimitiveExecutor(driver)
    res = _run(ex.execute("r9", "login_assist", {}))
    assert res["ok"] is True and res["data"] == {"clicked": "快速进入"}, res
    assert page.reload_calls == 1, "原语要走完整一趟:点了没登回去就刷新再点"
    assert len(driver.notes) == 1, driver.notes
    assert "真鼠标点「快速进入」" in driver.notes[0] and "还没登回" in driver.notes[0], driver.notes
    assert driver.notes[0].endswith("https://www.goofish.com/im"), "报给服务端的那行要带上当时的页面"


def main():
    test_assist_quick_entry_logs_back_no_reload()
    test_assist_waits_for_slow_login_before_reloading()
    test_assist_real_click_missed_falls_back_to_code_click()
    test_assist_quick_entry_not_back_reloads_and_clicks_again()
    test_assist_dialog_reloads_first()
    test_assist_nothing_to_click_leaves_page_alone()
    test_assist_keep_login_only_no_reload()
    test_assist_reload_failure_still_reports_click()
    test_op_login_assist_uses_full_assist()
    test_dialog_triggers_reload_and_quick_entry()
    test_clean_page_not_touched()
    test_evaluate_failure_is_tolerated()
    test_dialog_but_no_button_after_reload()
    test_reload_failure_reported()
    test_op_reconnect_assist_returns_dict_as_is()
    test_op_failure_reported_via_rpc_frame()
    print("test_reconnect_assist: PASS")


if __name__ == "__main__":
    main()

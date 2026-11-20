"""Playwright 连接死了 / 工作页成空壳时,下一单先自救;挑工作页不抢卖家工作台(伪造 playwright 层)。

跑法：`.venv/bin/python scripts/test_dead_connection.py`，全过打印「全部通过」。

背景(2026-10-08 生产,洞穴那台):浏览器断线重开后,执行端挑中了恢复出来的卖家工作台空壳页
(网址带 goofish.com 就挑),一导航就「Frame was detached」;接着 Playwright 驱动连接也断了,
之后每个原语都「Connection closed while reading from the driver」——可 connected() 还说
连着,自愈从没触发,连挂 5 单,直到远程发重连才好。
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import gc_ads.driver as drv
from gc_ads.primitives import PrimitiveExecutor

SELLER = "https://seller.goofish.com/?site=COMMONPRO#/seller-data/data"


class FakePage:
    def __init__(self, url):
        self.url = url; self._closed = False; self.zombie = False; self.goto_calls = []
    def is_closed(self): return self._closed
    async def goto(self, url):
        if self.zombie:
            raise Exception("Page.goto: Frame was detached")
        self.goto_calls.append(url); self.url = url
    async def evaluate(self, *a): return 1600   # 视口够宽,不去最大化


class FakeCtx:
    def __init__(self, pages): self.pages = pages
    async def new_page(self):
        p = FakePage("about:blank"); self.pages.append(p); return p


class FakeBrowser:
    def __init__(self, pages): self._ctx = FakeCtx(pages); self.driver_dead = False
    @property
    def contexts(self): return [self._ctx]
    def is_connected(self): return True          # 驱动死了它也照样说 True(现场就是这样)
    async def close(self): pass


tabs_on_reopen: list = []
browsers: list = []


class FakePw:
    chromium = None
    def __init__(self): self.chromium = self
    async def connect_over_cdp(self, ws):
        b = FakeBrowser(tabs_on_reopen.pop(0)() if tabs_on_reopen else [FakePage("about:blank")])
        browsers.append(b); return b
    async def stop(self): pass


def fake_async_playwright():
    class _S:
        async def start(self): return FakePw()
    return _S()


drv.async_playwright = fake_async_playwright


class Cfg:
    class xianyu: home_url = "https://www.goofish.com"


async def main():
    reopens = []
    async def reopen():
        reopens.append(1); return f"ws://{len(reopens)}"

    # 1. 挑工作页:有主站页挑主站页;只有卖家工作台和空白页 → 挑空白页;只有卖家工作台 → 新开一张
    for tabs, expect in (
        (lambda: [FakePage(SELLER), FakePage("https://www.goofish.com/personal")], "https://www.goofish.com/personal"),
        (lambda: [FakePage(SELLER), FakePage("about:blank")], "about:blank"),
        (lambda: [FakePage(SELLER)], "about:blank"),
    ):
        tabs_on_reopen.append(tabs)
        d = drv.BrowserDriver(Cfg(), reopen=reopen)
        await d.connect("ws://first")
        assert d.page.url == expect, (d.page.url, expect)
        assert all(p.url != SELLER or not p.goto_calls for p in browsers[-1].contexts[0].pages)
    print("1. 挑工作页:主站优先、不抢卖家工作台 OK")

    # 2. 工作页成空壳:第一单报 Frame was detached,第二单换一张页接着干
    zombie = FakePage("https://www.goofish.com/")
    zombie.zombie = True
    tabs_on_reopen.append(lambda: [zombie, FakePage("https://www.goofish.com/im")])
    d = drv.BrowserDriver(Cfg(), reopen=reopen)
    await d.connect("ws://first")
    ex = PrimitiveExecutor(d)
    r1 = await ex.execute("r1", "launch_app", {"pkg": "https://www.goofish.com/publish"})
    assert not r1["ok"] and "Frame was detached" in r1["err"], r1
    r2 = await ex.execute("r2", "launch_app", {"pkg": "https://www.goofish.com/publish"})
    assert r2["ok"], r2
    assert d.page is not zombie and d.page.url == "https://www.goofish.com/publish"
    print("2. 空壳页 -> 下一单换页 OK")

    # 3. 驱动连接死了(connected() 还说 True):下一单先重开环境、换新连接
    tabs_on_reopen.append(lambda: [FakePage("https://www.goofish.com/")])
    tabs_on_reopen.append(lambda: [FakePage("https://www.goofish.com/")])
    d = drv.BrowserDriver(Cfg(), reopen=reopen)
    await d.connect("ws://first")
    ex = PrimitiveExecutor(d)
    old_browser = d.browser

    async def dead_goto(url):
        raise Exception("Page.goto: Connection closed while reading from the driver")
    d.page.goto = dead_goto
    n_reopen = len(reopens)
    r1 = await ex.execute("r1", "launch_app", {"pkg": "https://www.goofish.com/publish"})
    assert not r1["ok"] and "Connection closed" in r1["err"]
    r2 = await ex.execute("r2", "launch_app", {"pkg": "https://www.goofish.com/publish"})
    assert r2["ok"], r2
    assert len(reopens) == n_reopen + 1 and d.browser is not old_browser
    print("3. 驱动连接死了 -> 下一单先重连 OK")

    # 4. 普通失败(元素没找到之类)不触发重连、不换页
    tabs_on_reopen.append(lambda: [FakePage("https://www.goofish.com/")])
    d = drv.BrowserDriver(Cfg(), reopen=reopen)
    await d.connect("ws://first")
    page_before, n_reopen = d.page, len(reopens)
    d.note_failure(RuntimeError("set_text: 当前无聚焦的 INPUT/TEXTAREA/contenteditable"))
    await d.ensure_page()
    assert d.page is page_before and len(reopens) == n_reopen
    print("4. 普通失败 -> 不重连不换页 OK")

    print("全部通过")


asyncio.run(main())

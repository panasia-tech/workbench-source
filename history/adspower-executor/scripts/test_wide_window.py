"""导航前窗口不够宽就最大化(伪造 playwright 层,不需要真浏览器)。

跑法：`.venv/bin/python scripts/test_wide_window.py`，全过打印「全部通过」。

背景(2026-10-06 现场):AdsPower 开出来的窗口视口只有 824 宽(Windows 150% 缩放),
闲鱼发布页按 PC 宽度排版,右半边被裁、出横向滚动条,上架点「发布」点不动,
用户看着像「移动端的样式」。真 Chrome 走 CDP 的验证见提交说明。
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import gc_ads.driver as drv


class FakeCdp:
    def __init__(self, page): self.page = page; self.sent = []; self.detached = False
    async def send(self, method, params=None):
        self.sent.append((method, params))
        if self.page.cdp_fails:
            raise Exception("Browser.setWindowBounds: not supported")
        if method == "Browser.getWindowForTarget":
            return {"windowId": 7}
        if method == "Browser.setWindowBounds":
            self.page.width = self.page.screen_width
        return {}
    async def detach(self): self.detached = True


class FakeCtx:
    def __init__(self): self.sessions = []; self.pages = []
    async def new_cdp_session(self, page):
        s = FakeCdp(page); self.sessions.append(s); return s


class FakePage:
    def __init__(self, ctx, width, screen_width, cdp_fails=False):
        self.context = ctx; self.width = width; self.screen_width = screen_width
        self.cdp_fails = cdp_fails; self.url = "about:blank"; self.goto_calls = []
    def is_closed(self): return False
    async def evaluate(self, js): return self.width
    async def goto(self, url): self.goto_calls.append(url); self.url = url


class FakeBrowser:
    def __init__(self, page): self._ctx = page.context; self._ctx.pages.append(page)
    @property
    def contexts(self): return [self._ctx]
    def is_connected(self): return True


class Cfg:
    class xianyu: home_url = "https://www.goofish.com"


def driver_with(width, screen_width, cdp_fails=False):
    ctx = FakeCtx()
    page = FakePage(ctx, width, screen_width, cdp_fails)
    d = drv.BrowserDriver(Cfg())
    d.browser = FakeBrowser(page)
    d.page = page
    notes = []
    d.notify = notes.append
    return d, page, ctx, notes


async def main():
    # 1. 窄窗(现场 824):导航前最大化,再跳
    d, page, ctx, notes = driver_with(824, 1706)
    await d.goto("https://www.goofish.com/publish")
    [s] = ctx.sessions
    assert [m for m, _ in s.sent] == ["Browser.getWindowForTarget", "Browser.setWindowBounds"], s.sent
    assert s.sent[1][1] == {"windowId": 7, "bounds": {"windowState": "maximized"}}, s.sent[1]
    assert s.detached and page.width == 1706 and page.goto_calls == ["https://www.goofish.com/publish"]
    assert not notes
    print("1. 窄窗 -> 最大化后再导航 OK")

    # 2. 本来就够宽:不碰窗口(人调成别的大小,排得开就不抢)
    d, page, ctx, notes = driver_with(1500, 1920)
    await d.goto("https://www.goofish.com/publish")
    assert not ctx.sessions and page.goto_calls == ["https://www.goofish.com/publish"]
    print("2. 够宽 -> 不动窗口 OK")

    # 3. 屏幕本身就小:最大化也不够,上报一次就够,不每条任务刷一遍
    d, page, ctx, notes = driver_with(824, 1100)
    await d.goto("https://www.goofish.com/publish")
    await d.goto("https://www.goofish.com/personal")
    assert len(notes) == 1 and "1100" in notes[0], notes
    print("3. 屏幕太小 -> 只上报一次 OK")

    # 4. 改不了窗口(CDP 不支持/报错):照样导航,不让任务死在这
    d, page, ctx, notes = driver_with(824, 1920, cdp_fails=True)
    await d.goto("https://www.goofish.com/publish")
    assert page.goto_calls == ["https://www.goofish.com/publish"] and ctx.sessions[0].detached
    print("4. 改窗失败 -> 照常导航 OK")

    print("全部通过")


asyncio.run(main())

"""BrowserDriver 浏览器自愈的回归验证（伪造 playwright 层，不需要真浏览器）。

跑法：`.venv/bin/python scripts/test_driver_heal.py`，全过打印「全部通过」。

背景（2026-09-10 生产）：PC 那台的 AdsPower 浏览器被关掉后，执行端心跳照常（心跳只打
HTTP、不碰浏览器），服务端设备一直显示 ONLINE，两条上架任务派过去都在第一步 launch_app
秒挂 `TargetClosedError: Target page, context or browser has been closed`，非人工重开
浏览器不可恢复。这里覆盖那个形态（场景 3）及其边界。
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import gc_ads.driver as drv

class FakePage:
    def __init__(self, url="https://www.goofish.com/"):
        self.url = url; self._closed = False; self.goto_calls = []
    def is_closed(self): return self._closed
    async def goto(self, url):
        if self._closed: raise Exception("Page.goto: Target page, context or browser has been closed")
        self.goto_calls.append(url); self.url = url

class FakeCtx:
    def __init__(self, pages): self.pages = pages
    async def new_page(self):
        p = FakePage("about:blank"); self.pages.append(p); return p

class FakeBrowser:
    def __init__(self, tag): self.tag = tag; self._alive = True; self._ctx = FakeCtx([FakePage()])
    @property
    def contexts(self):
        if not self._alive: raise Exception("TargetClosedError: browser has been closed")
        return [self._ctx]
    def is_connected(self): return self._alive
    async def close(self): self._alive = False

class FakePw:
    def __init__(self, sink): self.sink = sink; self.chromium = self
    async def connect_over_cdp(self, ws):
        b = FakeBrowser(ws); self.sink.append(b); return b
    async def stop(self): pass

browsers = []
def fake_async_playwright():
    class _S:
        async def start(self): return FakePw(browsers)
    return _S()

drv.async_playwright = fake_async_playwright

class Cfg:
    class xianyu: home_url = "https://www.goofish.com"

async def main():
    reopens = []
    notes = []
    async def reopen():
        reopens.append(1); return f"ws://new-{len(reopens)}"

    d = drv.BrowserDriver(Cfg(), reopen=reopen)
    d.notify = notes.append
    await d.connect("ws://first")
    assert d.connected(), "首连后应为 connected"
    print("1. 首连 OK, browser =", d.browser.tag)

    # 场景 A：只是那张 tab 被关了 —— 不该触发重开环境
    d.page._closed = True
    page = await d.ensure_page()
    assert not page.is_closed() and len(reopens) == 0, (page.is_closed(), reopens)
    print("2. tab 被关 -> 换页面,未重开环境 (reopen 次数=0) OK")

    # 场景 B：整个浏览器被关掉（本次生产事故的形态）
    await d.browser.close()
    assert not d.connected()
    await d.goto("https://www.goofish.com/publish")
    assert len(reopens) == 1, reopens
    assert d.connected() and d.browser.tag == "ws://new-1", d.browser.tag
    assert d.page.goto_calls == ["https://www.goofish.com/publish"], d.page.goto_calls
    print("3. 浏览器被关 -> 自动重开+重连+跳转成功, browser =", d.browser.tag)
    print("   上报给服务端:", notes)

    # 场景 C：并发多个 op 同时撞上死浏览器，只该重连一次
    await d.browser.close()
    before = len(reopens)
    await asyncio.gather(*[d.ensure_page() for _ in range(5)])
    assert len(reopens) - before == 1, f"并发重连了 {len(reopens)-before} 次"
    print("4. 5 个 op 并发撞死浏览器 -> 只重连 1 次 OK")

    # 场景 D：没有 reopen 回调时如实报错，不静默
    d2 = drv.BrowserDriver(Cfg(), reopen=None)
    await d2.connect("ws://x")
    await d2.browser.close()
    try:
        await d2.ensure_page(); raise AssertionError("本应抛错")
    except RuntimeError as e:
        print("5. 无 reopen -> 如实报错:", e)

    print("\n全部通过")

asyncio.run(main())

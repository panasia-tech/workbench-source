"""Playwright 浏览器驱动：CDP 接管 AdsPower 环境，页面导航与登录态检查。"""
from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable
from urllib.parse import urlparse

from playwright.async_api import Browser, Page, async_playwright

from .config import Config
from .selectors import NICK_ANCHOR

log = logging.getLogger("gc.executor")

_NICK_JS = "(sel) => { const el = document.querySelector(sel); return el ? (el.textContent || '').trim() : ''; }"

# 闲鱼网页版按 PC 宽度排版(发布页的属性栏、底部发布条都按这个宽度摆)。窗口窄了,
# 页面右边被裁掉、出横向滚动条,流程照 DOM 坐标点下去落在看不见的地方——2026-10-06
# 现场:视口 824×773(Windows 150% 缩放),上架点「发布」点不动,用户看着像「移动端的
# 样式」。AdsPower 开多大的窗由环境指纹和客户端决定,这里不去改环境,每次导航前看一眼:
# 不够宽就把窗口最大化。
MIN_VIEWPORT_WIDTH = 1200

# 未登录时昵称锚点命中的是「登录」入口文案(2026-09-09 实测:未登录态 header 右上角
# 是登录链接,class 同样含 nick--),占位文案一律归一为空串 = 未登录
_LOGGED_OUT_TEXTS = {"登录", "登录/注册", "注册", "立即登录"}


def normalize_nick(raw: str | None) -> str:
    """昵称锚点原文 → 有效昵称;未登录占位文案/空 → ""。"""
    n = (raw or "").strip()
    return "" if n in _LOGGED_OUT_TEXTS else n


# 闲鱼主站。卖家工作台 seller.goofish.com 网址里也带 goofish.com,但页头没有昵称锚点,
# 也不是流程要用的页面,往往是人开着在看的(2026-10-08 现场,见 identity.py)。
_MAIN_SITE_HOSTS = frozenset({"www.goofish.com", "goofish.com"})


def on_main_site(url: str | None) -> bool:
    return (urlparse(url or "").hostname or "") in _MAIN_SITE_HOSTS


def _other_goofish_site(url: str | None) -> bool:
    """闲鱼的别的子站(卖家工作台之类):人开着在用,别抢来当工作页。"""
    host = urlparse(url or "").hostname or ""
    return host.endswith("goofish.com") and host not in _MAIN_SITE_HOSTS


# Playwright 驱动连接死了,可 connected() 还说 True——它读的是缓存的状态位,驱动进程没了
# 没人去翻它。2026-10-08 现场:洞穴那台连挂 5 单,一律这句,自愈从没触发,直到远程发重连才好。
# 「Target page, context or browser has been closed」不算:关一张标签页也报它,原有逻辑
# (页关了换一张、浏览器断了 connected() 变 False)已经接得住,算进来会动不动整套重连。
_DEAD_CONNECTION_ERRORS = ("Connection closed while reading from the driver",)
# 页面成了空壳:浏览器断线重开时恢复出来、从没真正加载过的标签页,视口宽 0,一导航主 frame
# 就 detach(同一现场的第一单)。换一张页,别在它身上反复撞。
_DEAD_PAGE_ERRORS = ("Frame was detached",)


class BrowserDriver:
    """一个实例对应一个 AdsPower 环境内的一张闲鱼页面。

    ``reopen``:「把 AdsPower 环境重新拉起来并给回 ws 端点」的回调(见 main.py)。
    有它 ensure_page 才能在 CDP 整个断掉(用户手动关了浏览器/浏览器崩了)时自愈重连;
    没有就只能如实报错。2026-09-10 生产实例:PC 那台浏览器被关后心跳照常(心跳只打
    HTTP,不碰浏览器),设备一直显示 ONLINE,任务派过去每条都秒挂在
    `TargetClosedError: Target page, context or browser has been closed`,
    直到人工重开浏览器为止——自愈就是补这个洞。
    """

    def __init__(self, cfg: Config,
                 reopen: Callable[[], Awaitable[str]] | None = None):
        self.cfg = cfg
        self._pw = None
        self._reopen = reopen
        self._heal_lock = asyncio.Lock()
        # 自愈事件的上报口(main.py 在 MQTT 起来后挂上 mqtt_client.log)。
        # 浏览器被关这种事只在本机日志里出现的话,服务端排查时是瞎的。
        self.notify: Callable[[str], None] | None = None
        self.browser: Browser | None = None
        self.page: Page | None = None
        # op_wait_new_tab 的识别基线:点击类 op 在动作前快照存活 tab 集合(Page 对象身份,
        # 进程内稳定)。背景:浏览器里可能已有同 URL 的旧详情 tab(用户/历史测试留下),
        # 纯按 URL 去重会把真正的新 tab 误判为「已见过」而永远跳过(2026-09-09 实测:
        # 下架点卡片后弹出的详情 tab URL 与既有 tab 完全相同,wait_new_tab 超时)。
        self.tab_baseline: set = set()
        self.tab_baseline_at: float = 0.0
        # 业务原语不许碰的页面(当前只有 im_watch 的常驻 /im 监听页)。
        # 没有这道登记,一次浏览器自愈就可能把监听页挑去当业务页,接着被 goto 走——
        # 监听于是静悄悄地没了,而症状只是「消息不再实时」,没人会立刻发现。
        self.reserved_pages: set = set()
        self._narrow_reported = False
        # 原语撞上「连接已死」后置位:下一个 ensure_page 不管 connected() 怎么说都先自愈。
        self._needs_heal = False
        # 撞上「Frame was detached」的空壳页:挑工作页时跳过。
        self._bad_pages: set = set()

    def reserve_page(self, page) -> None:
        """登记一张「业务原语不许碰」的页(见 reserved_pages)。"""
        self.reserved_pages.add(page)

    def release_page(self, page) -> None:
        self.reserved_pages.discard(page)

    def snapshot_tabs(self) -> None:
        """由点击类 op 在动作前调用:记录当前存活 tab 集合作为新 tab 识别基线。"""
        import time as _t
        if self.browser is None:
            return
        try:
            ctx = self.browser.contexts[0]
            self.tab_baseline = {p for p in ctx.pages if not p.is_closed()}
            self.tab_baseline_at = _t.monotonic()
        except Exception:
            self.tab_baseline = set()

    # ---- 连接与自愈 ----

    def connected(self) -> bool:
        """CDP 连接是否还活着。浏览器被关/崩了会变 False,且**不抛异常**——
        用它做判断,别拿 contexts[0] 去试探(那个会直接抛 TargetClosedError)。"""
        return self.browser is not None and self.browser.is_connected()

    async def _connect(self, ws_endpoint: str) -> None:
        self._pw = await async_playwright().start()
        self.browser = await self._pw.chromium.connect_over_cdp(ws_endpoint)
        await self._attach_page()

    async def connect(self, ws_endpoint: str) -> None:
        await self._connect(ws_endpoint)

    async def reconnect(self, ws_endpoint: str) -> None:
        """重建 CDP 连接（MQTT cmd restart 用）。失败保留旧句柄由上层重试。"""
        await self.close()
        await self._connect(ws_endpoint)

    async def _heal(self, stale: Browser | None) -> None:
        """CDP 断了/句柄已不可用:重开 AdsPower 环境并重连。

        ``stale`` 是调用方手上那个坏掉的 browser 句柄。等锁期间若 self.browser 已被
        别的协程换成活的,说明有人救过了,直接返回——避免并发 op 各自重连一遍。
        """
        async with self._heal_lock:
            if self.browser is not stale and self.connected():
                return
            if self._reopen is None:
                raise RuntimeError("浏览器连接已断开,且未配置 reopen 回调")
            log.warning("CDP 连接已断开,重开 AdsPower 环境并重连 ...")
            self._notify("浏览器连接已断开,正在重开 AdsPower 环境并重连")
            ws = await self._reopen()
            await self.close()
            await self._connect(ws)
            log.info("浏览器已重连,page=%s", self.page.url if self.page else None)
            self._notify(f"浏览器已重连,page={self.page.url if self.page else None}")

    def note_failure(self, exc: BaseException) -> None:
        """原语失败后看一眼是不是连接/页面已经坏了,是就让下一个原语先换掉它。
        原语自己照样把错如实报给服务端;这里只管别让下一单再撞同一堵墙。"""
        msg = str(exc)
        if any(m in msg for m in _DEAD_CONNECTION_ERRORS):
            log.warning("Playwright 连接已死(%s),下一个原语先重连", msg[:80])
            self._needs_heal = True
        elif any(m in msg for m in _DEAD_PAGE_ERRORS) and self.page is not None:
            log.warning("工作页成了空壳(%s),换一张", msg[:80])
            self._bad_pages.add(self.page)
            self.page = None

    def _notify(self, text: str) -> None:
        """上报一行给服务端;上报链路自身出问题绝不能影响自愈。"""
        if self.notify is None:
            return
        try:
            self.notify(text)
        except Exception:
            log.debug("notify 失败,忽略", exc_info=True)

    async def _attach_page(self) -> Page:
        """在当前 browser 上挑一张可用页面。**不做自愈**(自愈在 ensure_page),
        否则 _heal → _connect → _attach_page 会绕回自己。"""
        assert self.browser
        if self.page is not None and not self.page.is_closed():
            return self.page
        ctx = self.browser.contexts[0]
        live = [p for p in ctx.pages
                if not p.is_closed() and p not in self.reserved_pages and p not in self._bad_pages]
        # 先挑闲鱼主站页;没有就复用空白/起始页;闲鱼别的子站(卖家工作台)是人开着在看的,不抢,
        # 宁可新开一张。以前按网址「含 goofish.com」挑,浏览器重开后挑中了恢复出来的卖家工作台空壳页。
        self.page = (next((p for p in live if on_main_site(p.url)), None)
                     or next((p for p in live if not _other_goofish_site(p.url)), None)
                     or await ctx.new_page())
        return self.page

    async def ensure_page(self) -> Page:
        """恢复一张可用页面:CDP 整个断了先重连,再挑页面。

        当前页还活着就直接复用（wait_new_tab 切到详情 tab 后,后续 goto 必须作用在
        当前 tab 上,对齐 local_transport 的「复用 tab」纪律,不跳回旧 tab);
        否则优先复用 goofish 页面，最后才 new_page。"""
        if not self.connected() or self._needs_heal:
            self._needs_heal = False
            await self._heal(self.browser)
        try:
            return await self._attach_page()
        except Exception:
            # is_connected() 说活着但 contexts[0]/new_page 还是炸了:多半正撞上浏览器
            # 退出的瞬间(句柄半死)。按坏句柄再自愈一次,还不行就如实抛给上层。
            await self._heal(self.browser)
            return await self._attach_page()

    async def open_xianyu(self) -> None:
        """等价 Android 原语 launch_app(pkg)。确保页面存活后导航到闲鱼首页。"""
        await self.goto(self.cfg.xianyu.home_url)

    async def goto(self, url: str) -> None:
        """导航到 url。页面/浏览器死了先 ensure_page 自愈,再跳。"""
        page = await self.ensure_page()
        await self.ensure_wide_window()
        await page.goto(url)

    async def ensure_wide_window(self) -> None:
        """视口不够宽(见 MIN_VIEWPORT_WIDTH)就把浏览器窗口最大化。

        够宽就什么都不做——人把窗口调成别的大小,只要排得开就不跟人抢。做不到只记日志:
        窗口大小影响的是点不点得中,不该让导航本身失败。"""
        page = self.page
        if page is None or page.is_closed():
            return
        try:
            width = await page.evaluate("() => window.innerWidth")
            if width >= MIN_VIEWPORT_WIDTH:
                return
            cdp = await page.context.new_cdp_session(page)
            try:
                win = await cdp.send("Browser.getWindowForTarget")
                await cdp.send("Browser.setWindowBounds",
                               {"windowId": win["windowId"], "bounds": {"windowState": "maximized"}})
            finally:
                await cdp.detach()
            after = await page.evaluate("() => window.innerWidth")
            log.info("浏览器视口宽 %s 不够,已最大化窗口 -> %s", width, after)
            if after < MIN_VIEWPORT_WIDTH and not self._narrow_reported:
                # 屏幕本身就小或缩放太大:最大化也排不开,只能人去调,说一次就够
                self._narrow_reported = True
                self._notify(f"浏览器窗口最大化后视口宽仍只有 {after}(要 {MIN_VIEWPORT_WIDTH}),"
                             "闲鱼网页版会排不开;调低这台电脑的显示缩放或换大屏")
        except Exception as exc:
            log.warning("放大浏览器窗口失败(继续导航): %s", exc)

    async def check_login(self) -> bool:
        """登录态检查：header 昵称锚点存在且为有效昵称（未登录占位文案不算）。"""
        return bool(await self.current_nick())

    async def current_nick(self) -> str:
        """读当前登录昵称，未登录/读不到返回 ""。"""
        if not self.page or self.page.is_closed():
            return ""
        try:
            return normalize_nick(await self.page.evaluate(_NICK_JS, NICK_ANCHOR))
        except Exception:
            return ""

    async def close(self) -> None:
        self.page = None
        self._bad_pages.clear()   # 重连后是新的 Page 对象,旧黑名单作废
        if self.browser:
            try:
                await self.browser.close()
            except Exception:
                pass
            self.browser = None
        if self._pw:
            try:
                await self._pw.stop()
            except Exception:
                pass
            self._pw = None

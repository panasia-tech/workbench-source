"""本地 Playwright Transport:connect_over_cdp 直连本机 AdsPower 指纹浏览器,开发联调用。

实现 app.flow.transport.Transport 抽象方法全集(同步签名)。内部结构:
- 后台线程跑一个 asyncio 事件循环;所有 Playwright 协程经 run_coroutine_threadsafe 投递,
  同步方法阻塞取结果——与 MqttRpcTransport 同一姿势(流程代码保持同步、零改动)。
- dump_nodes 在页面内执行 JS 拍扁 DOM,输出与 App 端一致的扁平结构:
  [{desc, cls, clickable, center:[x,y], size:[w,h]}](cls 前缀带 tag 名,供流程按 tag/类名识别)。

web 场景语义映射(与 adspower-executor 的 MQTT 端约定对齐):
- launch_app(pkg)  → page.goto(pkg):pkg 当作 URL(如 https://www.goofish.com/im)
- key("BACK")      → page.go_back();key("HOME") → 回闲鱼首页
- swipe(x1,y1,x2,y2) → 鼠标移到 (x1,y1) 后滚轮 deltaY=(y2-y1)(负=向上滚,幅度=|y2-y1|)
- dump_nodes 的 desc 约定:
  * <a> 元素把 href 追加进 desc(流程用正则 userId=(数字) 提取 peer_key)
  * ant-badge-count 元素把 title(未读数)放进 desc
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import urllib.request

from app.flow.transport import Transport

ADSPOWER_ACTIVE_API = "http://127.0.0.1:50325/api/v1/browser/local-active"
GOOFISH_HOME = "https://www.goofish.com"


def discover_ws_endpoint(api: str = ADSPOWER_ACTIVE_API) -> str:
    """从 AdsPower local-active 接口取第一个在跑环境的 CDP ws 端点。"""
    with urllib.request.urlopen(api, timeout=10) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    lst = (data.get("data") or {}).get("list") or []
    if not lst:
        raise RuntimeError(f"AdsPower 无在跑浏览器环境:{data}")
    ws = ((lst[0].get("ws") or {}).get("puppeteer"))
    if not ws:
        raise RuntimeError(f"AdsPower 环境无 puppeteer ws:{lst[0]}")
    return ws


_DUMP_JS = r"""
() => {
  const DESC_MAX = 200;
  const INTERACTIVE = new Set(["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT", "OPTION"]);
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = window.getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";
  };
  const ownText = (el) => {
    let t = "";
    for (const ch of el.childNodes) {
      if (ch.nodeType === Node.TEXT_NODE) t += ch.nodeValue;
    }
    return t.trim();
  };
  const classOf = (el) => {
    const c = el.className;
    if (typeof c === "string") return c;
    return (c && c.baseVal) || "";  // SVGAnimatedString(SVG 元素)
  };
  const descOf = (el) => {
    let d = ownText(el);
    const aria = el.getAttribute("aria-label");
    const alt = el.getAttribute("alt");
    const ph = el.getAttribute("placeholder");
    const cls = classOf(el);
    // INPUT/TEXTAREA 的正文在 value 里(placeholder 只是兜底)——发布页价格/邮费/搜索框
    // 回读校验要靠真实值;聊天 textarea 含草稿时 desc 也变草稿文本(解析只认 cls,无影响)。
    if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.value) {
      d = el.value.trim();
    }
    // 未读角标:ant-badge-count 的文本常为空,title 才是数字(流程约定:title 值进 desc)
    if (cls.includes("ant-badge-count") || cls.includes("ant-scroll-number")) {
      const title = el.getAttribute("title") || el.textContent.trim();
      d = title || d;
    }
    if (!d && aria) d = aria.trim();
    if (!d && alt) d = alt.trim();
    if (!d && ph) d = ph.trim();
    if (el.tagName === "A") {
      const href = el.getAttribute("href") || "";
      if (href) d = (d + " " + href).trim();  // 流程约定:a[href] 原样进 desc
    }
    if (d.length > DESC_MAX) d = d.slice(0, DESC_MAX);
    return d;
  };
  const clickableOf = (el) => {
    if (INTERACTIVE.has(el.tagName)) return true;
    if (el.getAttribute("role") === "button") return true;
    if (el.onclick) return true;
    if (window.getComputedStyle(el).cursor === "pointer") return true;
    return false;
  };
  const out = [];
  const all = document.querySelectorAll("*");
  for (const el of all) {
    if (!isVisible(el)) continue;
    const cls = classOf(el).trim();
    const desc = descOf(el);
    const clickable = clickableOf(el);
    // 跳过无文本且不可交互且无任何 class 的纯容器(如 rc-virtual-list 撑高层)
    if (!desc && !clickable && !cls) continue;
    const r = el.getBoundingClientRect();
    const node = {
      desc, cls: (el.tagName.toLowerCase() + " " + cls).trim(), clickable,
      cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2),
      w: Math.round(r.width), h: Math.round(r.height),
    };
    // IMG 带 src——聊天页商品卡缩略图直取用;协议相对 URL(//img.alicdn.com/...)原样保留
    if (el.tagName === "IMG") {
      const src = (el.currentSrc || el.src || "").trim();
      if (src) node.src = src.slice(0, 500);
    }
    // 嵌套去重:子元素已输出同文本 → 父容器不重复输出
    const dup = out.some(p => p.desc && p.desc === node.desc
      && p.cx >= r.left && p.cx <= r.right && p.cy >= r.top && p.cy <= r.bottom
      && (p.w * p.h) < (node.w * node.h));
    if (dup) continue;
    out.push(node);
  }
  return out;
}
"""

_SET_TEXT_JS = r"""
(text) => {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable) {           // 发布页描述编辑器(contenteditable div)
    el.textContent = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  if (!/^(INPUT|TEXTAREA)$/.test(el.tagName)) return false;
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}
"""


class LocalPlaywrightTransport(Transport):
    """开发联调:同步 Transport 接口包一层后台 asyncio 线程 + Playwright CDP。"""

    def __init__(self, ws_endpoint: str | None = None, default_timeout: float = 60.0):
        self._ws_endpoint = ws_endpoint or discover_ws_endpoint()
        self._default_timeout = default_timeout
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(target=self._run_loop, name="pw-transport-loop",
                                        daemon=True)
        self._thread.start()
        self._pw = None
        self._browser = None
        self._page = None
        self._media_dir: str | None = None
        self._media_cache: list[str] = []
        self._submit(self._connect(), timeout=default_timeout)

    # ---------- 事件循环骨架 ----------
    def _run_loop(self):
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def _submit(self, coro, timeout: float | None = None):
        fut = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return fut.result(timeout=timeout or self._default_timeout)

    async def _connect(self):
        from playwright.async_api import async_playwright

        self._pw = await async_playwright().start()
        self._browser = await self._pw.chromium.connect_over_cdp(self._ws_endpoint)
        ctx = self._browser.contexts[0] if self._browser.contexts else await self._browser.new_context()
        self._page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        self._page.set_default_timeout(self._default_timeout * 1000)

    def close(self):
        try:
            self._submit(self._disconnect(), timeout=15)
        finally:
            self._loop.call_soon_threadsafe(self._loop.stop)

    async def _disconnect(self):
        try:
            if self._browser:
                await self._browser.close()
        finally:
            if self._pw:
                await self._pw.stop()

    @property
    def page(self):
        if self._page is None or self._page.is_closed():
            raise RuntimeError("Playwright 页面未连接/已关闭")
        return self._page

    def activate_latest_tab(self) -> str:
        """切换到上下文里最新打开的 tab(goods_flows_web 点卡片开详情页新 tab 用)。

        chat_scan 全是 /im 页内跳转、不开新 tab,本方法不影响其已验证行为。
        返回激活 tab 的 URL(流程用它校验 id=<itemId> 是否匹配,防操作错商品)。
        """
        async def op():
            ctx = self.page.context
            pages = [p for p in ctx.pages if not p.is_closed()]
            if not pages:
                raise RuntimeError("浏览器上下文无可用 tab")
            self._page = pages[-1]
            await self._page.bring_to_front()
            return self._page.url
        return self._submit(op())

    def wait_new_tab(self, contains: str | None = None, timeout: float = 15.0) -> str:
        """等待并激活点击后新开的 tab(按「URL 含 contains」识别,不靠 pages 顺序——
        上下文里可能混有用户其它 tab,pages[-1] 不一定是新开的,2026-09-09 实测踩过)。

        返回新 tab URL。超时未等到 → RuntimeError(调用方按「点击未开新 tab」处理)。
        """
        async def op():
            ctx = self.page.context
            seen = {p.url for p in ctx.pages if not p.is_closed()}
            deadline = asyncio.get_event_loop().time() + timeout
            while asyncio.get_event_loop().time() < deadline:
                for p in ctx.pages:
                    if p.is_closed() or p.url in seen:
                        continue
                    if contains and contains not in p.url:
                        continue
                    self._page = p
                    await p.bring_to_front()
                    # SPA 页面 URL 先于内容就绪,多等一拍再交回
                    await p.wait_for_load_state("domcontentloaded")
                    return p.url
                await asyncio.sleep(0.5)
            raise RuntimeError(f"等待新 tab 超时(contains={contains!r})")
        return self._submit(op(), timeout=timeout + 20)

    # ---------- Transport 原语 ----------
    def screencap(self) -> bytes:
        return self._submit(self.page.screenshot(type="jpeg", quality=60), timeout=30)

    def tap(self, x: int, y: int) -> None:
        async def op():
            await self.page.mouse.click(x, y)
        self._submit(op())

    def swipe(self, x1: int, y1: int, x2: int, y2: int, ms: int = 300) -> None:
        # web 语义:在 (x1,y1) 处滚轮。deltaY=(y2-y1):负=向上滚(读历史),正=向下滚。
        # 部分页面(2026-09-09 实测 /personal)对 CDP synthetic wheel 不响应,
        # 兜底 window.scrollBy——语义仍是「内容滚动 (y2-y1) px」。
        delta = y2 - y1
        async def op():
            before = await self.page.evaluate("() => window.scrollY")
            await self.page.mouse.move(x1, y1)
            await self.page.mouse.wheel(0, delta)
            await asyncio.sleep(0.6)
            after = await self.page.evaluate("() => window.scrollY")
            if abs(after - before) < abs(delta) * 0.3:
                await self.page.evaluate("(d) => window.scrollBy(0, d)", delta)
        self._submit(op())

    def key(self, code: str) -> None:
        async def op():
            if code == "BACK":
                # 会话是 /im 页内打开(URL 不变),此时 go_back 会跳出 /im——no-op;
                # 只有真的跳转过页面(如点到商品页)才回退。
                if "/im" not in self.page.url:
                    await self.page.go_back()
            elif code == "HOME":
                await self.page.goto(GOOFISH_HOME, wait_until="domcontentloaded")
            # 其余系统键(WAKEUP 等)web 无对应物,no-op
        self._submit(op())

    def dump_nodes(self) -> list[dict]:
        data = self._submit(self.page.evaluate(_DUMP_JS), timeout=30)
        out = []
        for n in data or []:
            node = {
                "desc": n.get("desc", ""), "cls": n.get("cls", ""),
                "clickable": bool(n.get("clickable")),
                "center": (int(n.get("cx", 0)), int(n.get("cy", 0))),
                "size": (int(n.get("w", 0)), int(n.get("h", 0))),
            }
            if n.get("src"):                    # img src(商品卡缩略图直取,对齐 RPC 通道)
                node["src"] = n["src"]
            out.append(node)
        return out

    def set_text(self, text: str) -> None:
        ok = self._submit(self.page.evaluate(_SET_TEXT_JS, text))
        if not ok:
            raise RuntimeError("set_text:当前无聚焦的 INPUT/TEXTAREA")

    def set_clipboard(self, text: str) -> None:
        raise NotImplementedError("LocalPlaywrightTransport 不支持 set_clipboard")

    def ime_picker(self) -> None:
        pass  # web 无 IME 概念

    def ime_commit(self, text: str) -> None:
        self.set_text(text)

    def ime_prefix(self, text: str) -> None:
        raise NotImplementedError("LocalPlaywrightTransport 不支持 ime_prefix")

    def launch_app(self, pkg: str) -> None:
        # web 语义:pkg 即 URL(如 https://www.goofish.com/im)
        self._submit(self.page.goto(pkg, wait_until="domcontentloaded", timeout=60000),
                     timeout=70)

    def force_stop(self, pkg: str) -> None:
        pass  # web 无进程可杀;流程需要「干净起点」时应 goto 目标页

    def screen_size(self) -> tuple[int, int]:
        size = self.page.viewport_size
        if size:
            return int(size["width"]), int(size["height"])
        # CDP attach 的既有 tab viewport_size 为 None,回退读真实布局视口
        # (2026-09-09 实测 AdsPower 窗口 1446x839,勿用 1280x800 默认值——鼠标点击按真实视口坐标)
        size = self._submit(self.page.evaluate("() => ({w: window.innerWidth, h: window.innerHeight})"))
        return int(size["w"]), int(size["h"])

    def node_click(self, desc: str, index: int = 0) -> bool:
        nodes = [n for n in self.dump_nodes() if n["desc"] == desc]
        nodes.sort(key=lambda n: (n["center"][1], n["center"][0]))
        if len(nodes) <= index:
            return False
        self.tap(*nodes[index]["center"])
        return True

    def node_long_click(self, desc: str, index: int = 0) -> bool:
        nodes = [n for n in self.dump_nodes() if n["desc"] == desc]
        nodes.sort(key=lambda n: (n["center"][1], n["center"][0]))
        if len(nodes) <= index:
            return False
        x, y = nodes[index]["center"]
        self._submit(self.page.mouse.click(x, y, delay=800))
        return True

    def push_media(self, url: str) -> str | None:
        """下载 url 到本地临时目录,返回本地文件路径(发布页 set_input_files 用)。

        返回路径必须记账(流程收尾 clear_media 删),否则 /tmp 堆积、且残留会被下一张误用。
        文件名保留 url 的扩展名(闲鱼 accept 按扩展名/内容校验)。
        """
        import tempfile

        if not self._media_dir:
            self._media_dir = tempfile.mkdtemp(prefix="gc_media_")
        ext = ".jpg"
        if "." in (url.split("?")[0].rsplit("/", 1)[-1] or ""):
            ext = "." + url.split("?")[0].rsplit(".", 1)[-1].lower()
            if ext not in (".jpg", ".jpeg", ".png", ".webp", ".heic"):
                ext = ".jpg"
        path = os.path.join(self._media_dir, f"gc_{int(time.time() * 1000)}_{len(self._media_cache)}{ext}")
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as resp, open(path, "wb") as f:
            f.write(resp.read())
        self._media_cache.append(path)
        return path

    def clear_media(self, uris: list[str] | None = None) -> int:
        """删除 push_media 下载的本地图。传 uris 精确删;不传则清本端整个媒体目录。返回删除条数。"""
        paths = [p for p in (uris if uris is not None else list(self._media_cache)) if p]
        n = 0
        for p in paths:
            try:
                os.remove(p)
                n += 1
            except OSError:
                pass
        self._media_cache = [p for p in self._media_cache if p not in set(paths)]
        return n

    # ---- web 发布流程扩展:图片直喂隐藏 file input ----
    # ⚠️ 非 Transport 基类原语(MQTT 执行端要支持 goods_publish web 流程,需补 upload_files 原语)。
    def set_input_files(self, paths: list[str], selector: str = "input[type=file]") -> int:
        """把本地文件列表喂给页面的隐藏 file input(ant-upload 直接触发上传)。

        返回实际设置的文件数。input 不带 multiple 时只接受单文件(调用方需逐张喂)。
        """
        async def op():
            handle = await self.page.query_selector(selector)
            if not handle:
                raise RuntimeError(f"未找到 file input:{selector}")
            multiple = await handle.get_attribute("multiple")
            files = list(paths) if multiple else list(paths[:1])
            await handle.set_input_files(files)
            return len(files)
        return self._submit(op())

    def input_has_multiple(self, selector: str = "input[type=file]") -> bool:
        async def op():
            handle = await self.page.query_selector(selector)
            return bool(handle and await handle.get_attribute("multiple"))
        return self._submit(op())

    def fill_text(self, selector: str, text: str) -> None:
        """Playwright fill 直写输入框(自动处理焦点与 React controlled input)。
        用于 ant-select 搜索框这类「tap 坐标打不中真实 input」的场景。"""

        async def op():
            await self.page.fill(selector, text, timeout=10000)

        self._submit(op())

    def js_click_selector(self, selector: str) -> int:
        """JS el.click() 点击 selector 命中的第一个元素。用于「需要点容器本身」的场景。
        注意:ant Select 开下拉靠 mousedown,仅 click 无效(用 js_mouse_click)。"""

        async def op():
            return await self.page.evaluate(
                """(sel) => {
                    const el = document.querySelector(sel);
                    if (!el) return 0;
                    el.click();
                    return 1;
                }""", selector)

        return self._submit(op())

    def js_mouse_click(self, selector: str) -> int:
        """JS 派发完整 mousedown/mouseup/click 事件序列。ant Select 靠 mousedown 开下拉,
        仅 el.click() 不触发;物理 tap 又可能被 tips-- 浮层拦截,此扩展两头兜底。"""

        async def op():
            return await self.page.evaluate(
                """(sel) => {
                    const el = document.querySelector(sel);
                    if (!el) return 0;
                    for (const type of ['mousedown', 'mouseup', 'click']) {
                        el.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true, view: window}));
                    }
                    return 1;
                }""", selector)

        return self._submit(op())

    # ---- 风控探测扩展:阿里 punish 滑块 iframe ----
    # 2026-09-09 实测:punish 滑块渲染在跨域 iframe(_____tmd_____/punish),dump_nodes
    # 完全看不到弹窗文本,_check_risk 的锚点扫描会漏报——必须查 iframe src。
    def risk_punish_active(self) -> str | None:
        """页面存在阿里 punish 滑块 iframe 时返回其 src 片段,否则 None。"""

        async def op():
            return await self.page.evaluate(
                """() => {
                    for (const f of document.querySelectorAll('iframe')) {
                        const s = f.src || '';
                        if (s.includes('_____tmd_____') || s.includes('/punish')) return s.slice(0, 80);
                    }
                    return null;
                }""")

        return self._submit(op())

    # ---- web 发布流程扩展:JS click 兜底 ----
    # ⚠️ 非 Transport 基类原语。2026-09-09 实测:发布页「分类」下拉的选项被 tips-- 橙色
    # 提示浮层盖住,CDP 合成鼠标事件点不到(elementFromPoint 命中浮层),JS el.click() 可穿透。
    def js_click_text(self, text: str, cls: str = "") -> int:
        """JS el.click() 点击第一个 textContent 精确等于 text 的可视元素(cls 非空时限定
        class 含 cls 的元素)。返回点击成功的元素数(0=没找到)。"""

        async def op():
            return await self.page.evaluate(
                """([text, cls]) => {
                    const els = [...document.querySelectorAll('*')].filter(e => {
                        if (cls && !(e.className && String(e.className).includes(cls))) return false;
                        return (e.textContent || '').trim() === text
                            && e.children.length === 0;
                    });
                    if (!els.length) return 0;
                    els[0].click();
                    return 1;
                }""", [text, cls])

        return self._submit(op())

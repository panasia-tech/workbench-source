"""原语执行器：op 分发，payload schema 对齐 Android 端 PrimitiveExecutor。

服务端流程引擎只认识这套 op + 响应结构，浏览器端在内部映射成
Playwright 调用（对照表见 README §二）。只做手，不做脑。

响应帧：{"req_id": ..., "ok": bool, "data": {...}, "err": str|None, "ts": ms}
"""
from __future__ import annotations

import asyncio
import base64
import os
import time
from pathlib import Path
from typing import Any

import httpx

from .driver import BrowserDriver, normalize_nick
from .login_assist import assist_login, page_snapshot, reconnect_assist
from .selectors import NICK_ANCHOR

DEFAULT_TIMEOUT_SEC = 15

MAX_DUMP_NODES = 2000
DESC_MAX_LEN = 200

# ---- dump_nodes：DOM 拍扁（在浏览器侧跑，逐元素计算 desc/clickable/center/size）----
_DUMP_JS = r"""
() => {
  const INTERACTIVE = new Set(["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT"]);
  const MAX_NODES = %d;
  const DESC_MAX = %d;
  const nodes = [];
  const seen = new Set();

  const directText = (el) => {
    let t = "";
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
    }
    return t.trim();
  };

  // display:contents 等元素自身无盒（getClientRects 为空），用后代包围盒兜底
  // （实测 2026-09-09：闲鱼会话项 conversation-item--* 即 display:contents 包装）
  const childRect = (el) => {
    let top = Infinity, left = Infinity, right = -Infinity, bottom = -Infinity, found = false;
    for (const c of el.querySelectorAll("*")) {
      const r = c.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      found = true;
      if (r.top < top) top = r.top;
      if (r.left < left) left = r.left;
      if (r.right > right) right = r.right;
      if (r.bottom > bottom) bottom = r.bottom;
      if (found && bottom - top > 4000) break;  // 够用了，防超大子树
    }
    return found ? {top, left, width: right - left, height: bottom - top} : null;
  };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let el;
  while ((el = walker.nextNode())) {
    if (nodes.length >= MAX_NODES) break;
    let rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      rect = childRect(el);
      if (!rect) continue;
    }
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;

    let desc = directText(el)
      || (el.getAttribute("aria-label") || "").trim()
      || (el.getAttribute("alt") || "").trim()
      || (el.getAttribute("placeholder") || "").trim();

    // INPUT/TEXTAREA 的正文在 value 里(placeholder 只是兜底)——发布页价格/邮费/搜索框
    // 回读校验要靠真实值(对齐 local_transport._DUMP_JS 规则)
    if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.value) {
      desc = String(el.value).trim();
    }

    const tag = el.tagName;
    // 特殊：a[href] 的 desc 直接放 URL（服务端流程用它识别跳转目标）
    if (tag === "A") {
      const href = el.getAttribute("href");
      if (href) desc = href.trim();
    }
    // 特殊：未读角标的 title 属性 = 未读数
    if (tag === "SUP" && el.classList.contains("ant-badge-count")) {
      const t = el.getAttribute("title");
      if (t) desc = t.trim();
    }

    // 可交互判定：原生交互标签 / role / onclick / cursor:pointer /
    // React 合成事件 onClick（闲鱼整站 React：很多点击目标无 onclick 属性也无 pointer 光标，
    // 2026-09-09 实测会话项 conversation-item--* 即靠 __reactProps$.onClick 接收点击）
    const rk = Object.keys(el).find((k) => k.startsWith("__reactProps"));
    const reactClickable = !!(rk && el[rk] && typeof el[rk].onClick === "function");
    const clickable = INTERACTIVE.has(tag)
      || el.getAttribute("role") === "button"
      || el.hasAttribute("onclick")
      || style.cursor === "pointer"
      || reactClickable;

    // 跳过无文本且不可交互且无 class 的纯容器(如 rc-virtual-list 撑高层);
    // 有 class 的保留——css-modules 站点的业务卡片(cardWarp--/conversation-item-- 等)
    // 靠 cls 供流程识别,即使 desc 空(对齐 local_transport._DUMP_JS 规则)
    const cls0 = (typeof el.className === "string" && el.className)
      ? el.className.slice(0, 120) : "";
    if (!desc && !clickable && !cls0) continue;
    if (desc.length > DESC_MAX) desc = desc.slice(0, DESC_MAX);

    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);
    const cls = cls0 || tag.toLowerCase();
    const key = (desc || cls) + "@" + cx + "," + cy;   // 祖先与后代同 desc/cls 同中心 → 去重
    if (seen.has(key)) continue;
    seen.add(key);

    const node = {desc, cls, clickable, center: [cx, cy], size: [Math.round(rect.width), Math.round(rect.height)]};
    // 特殊:IMG 带 src——聊天页商品卡缩略图直取用(对齐 local_transport._DUMP_JS 规则)。
    // 协议相对 URL(//img.alicdn.com/...)原样保留,服务端归一化。
    if (tag === "IMG") {
      const src = (el.currentSrc || el.src || "").trim();
      if (src) node.src = src.slice(0, 500);
    }
    nodes.push(node);
  }
  return nodes;
}
""" % (MAX_DUMP_NODES, DESC_MAX_LEN)

# ---- node_click：按 desc 精确匹配，上→下、左→右排序取第 index 个 ----
_NODE_CLICK_JS = r"""
({desc, index}) => {
  const INTERACTIVE = new Set(["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT"]);
  const computeDesc = (el) => {
    let t = "";
    for (const n of el.childNodes) {
      if (n.nodeType === Node.TEXT_NODE) t += n.textContent;
    }
    t = t.trim();
    const tag = el.tagName;
    let d = t
      || (el.getAttribute("aria-label") || "").trim()
      || (el.getAttribute("alt") || "").trim()
      || (el.getAttribute("placeholder") || "").trim();
    if (tag === "A") {
      const href = el.getAttribute("href");
      if (href) d = href.trim();
    }
    if (tag === "SUP" && el.classList.contains("ant-badge-count")) {
      const tt = el.getAttribute("title");
      if (tt) d = tt.trim();
    }
    return d;
  };
  const childRect = (el) => {
    let top = Infinity, left = Infinity, right = -Infinity, bottom = -Infinity, found = false;
    for (const c of el.querySelectorAll("*")) {
      const r = c.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      found = true;
      if (r.top < top) top = r.top;
      if (r.left < left) left = r.left;
      if (r.right > right) right = r.right;
      if (r.bottom > bottom) bottom = r.bottom;
      if (found && bottom - top > 4000) break;
    }
    return found ? {top, left} : null;
  };
  const matches = [];
  for (const el of document.body.querySelectorAll("*")) {
    let rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      const cr = childRect(el);
      if (!cr) continue;
      rect = cr;
    }
    if (computeDesc(el) !== desc) continue;
    matches.push({el, top: rect.top, left: rect.left});
  }
  matches.sort((a, b) => (a.top - b.top) || (a.left - b.left));
  const target = matches[index];
  if (!target) return false;
  target.el.setAttribute("data-gc-click-target", "1");
  return true;
}
"""

# ---- self_check / check_login 公共：读登录昵称锚点 ----
_NICK_JS = r"""
(sel) => {
  const el = document.querySelector(sel);
  return el ? (el.textContent || "").trim() : "";
}
"""


class PrimitiveExecutor:
    def __init__(self, driver: BrowserDriver):
        self.driver = driver

    async def execute(self, req_id: str, op: str, args: dict[str, Any]) -> dict[str, Any]:
        try:
            handler = getattr(self, f"op_{op}", None)
            if handler is None:
                raise ValueError(f"unsupported op: {op}")
            data = await handler(**args)
            return {"req_id": req_id, "ok": True, "data": data,
                    "err": None, "ts": int(time.time() * 1000)}
        except Exception as exc:  # 原语失败如实上报，由服务端流程决策重试/熔断
            self.driver.note_failure(exc)   # 连接已死/页面成空壳：下一个原语先换掉它
            return {"req_id": req_id, "ok": False, "data": None,
                    "err": f"{type(exc).__name__}: {exc}", "ts": int(time.time() * 1000)}

    # ---- 基础操作 ----

    async def op_screencap(self) -> dict:
        """→ data.image_b64（JPEG）"""
        assert self.driver.page
        buf = await self.driver.page.screenshot(type="jpeg", quality=60)
        return {"image_b64": base64.b64encode(buf).decode()}

    async def op_tap(self, x: int, y: int) -> dict:
        """点击类 op 动作前快照 tab 基线,供 op_wait_new_tab 识别「真正的新 tab」
        (纯按 URL 去重会被浏览器里已有的同 URL 旧 tab 骗过)。"""
        self.driver.snapshot_tabs()
        assert self.driver.page
        await self.driver.page.mouse.click(x, y)
        return {}

    async def op_swipe(self, x1: int, y1: int, x2: int, y2: int, ms: int | None = None,
                       duration_ms: int = 300) -> dict:
        """浏览器侧映射为滚轮：在 (x1,y1) 上滚 (y2-y1) 像素（y2<y1 即向上滚）。
        部分页面对 CDP synthetic wheel 不响应（2026-09-09 实测 /personal），
        兜底 window.scrollBy——语义仍是「内容滚动 (y2-y1) px」（对齐 local_transport.swipe）。"""
        assert self.driver.page
        delta = y2 - y1
        page = self.driver.page
        await page.mouse.move(x1, y1)
        before = await page.evaluate("() => window.scrollY")
        await page.mouse.wheel(0, delta)
        await asyncio.sleep(0.6)
        after = await page.evaluate("() => window.scrollY")
        if abs(after - before) < abs(delta) * 0.3:
            await page.evaluate("(d) => window.scrollBy(0, d)", delta)
        return {}

    async def op_long_press(self, x: int, y: int, duration_ms: int = 800) -> dict:
        assert self.driver.page
        await self.driver.page.mouse.move(x, y)
        await self.driver.page.mouse.down()
        await asyncio.sleep(duration_ms / 1000)
        await self.driver.page.mouse.up()
        return {}

    async def op_key(self, code: str | None = None, key: str | None = None) -> dict:
        """BACK → go_back（无历史则 no-op）；HOME → 回闲鱼首页；WAKEUP → no-op。
        参数名 code 对齐服务端 MqttRpcTransport.key(code=...)。"""
        assert self.driver.page
        k = code or key or ""
        if k == "BACK":
            # 会话是 /im 页内打开(URL 不变),此时 go_back 会跳出 /im——no-op;
            # 只有真的跳转过页面(如点卡片进了详情页新 tab)才回退(对齐 local_transport.key)
            if "/im" not in (self.driver.page.url or ""):
                await self.driver.page.go_back()  # 无历史时返回 None，天然 no-op
        elif k == "HOME":
            await self.driver.open_xianyu()
        elif k == "WAKEUP":
            pass
        return {}

    async def op_set_clipboard(self, text: str) -> dict:
        """浏览器无系统剪贴板原语；留空实现保持 op 全集对齐（流程里输入走 set_text）。"""
        return {}

    async def op_ime_picker(self) -> dict:
        """无 IME 概念，no-op。"""
        return {}

    async def op_set_text(self, text: str, x: int | None = None, y: int | None = None) -> dict:
        """有点位先点击聚焦，再写值。写值用 native setter + input/change 事件
        （对齐服务端 local_transport._SET_TEXT_JS）：React/antd controlled input
        只认这套事件，keyboard.insert_text 会被 antd 数字输入框吞掉（2026-09-09
        实测发布页价格框 insert_text 后回读仍是 0.00）。contenteditable 同JS覆盖。"""
        assert self.driver.page
        if x is not None and y is not None:
            await self.driver.page.mouse.click(x, y)
            await asyncio.sleep(0.2)
        ok = await self.driver.page.evaluate(
            """(text) => {
                const el = document.activeElement;
                if (!el) return false;
                if (el.isContentEditable) {
                    el.textContent = text;
                    el.dispatchEvent(new Event("input", { bubbles: true }));
                    return true;
                }
                if (!/^(INPUT|TEXTAREA)$/.test(el.tagName)) return false;
                const proto = el.tagName === "TEXTAREA"
                    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
                setter.call(el, text);
                el.dispatchEvent(new Event("input", { bubbles: true }));
                el.dispatchEvent(new Event("change", { bubbles: true }));
                return true;
            }""", text)
        if not ok:
            raise RuntimeError("set_text: 当前无聚焦的 INPUT/TEXTAREA/contenteditable")
        return {}

    # ---- 结构感知 ----

    async def op_dump_nodes(self) -> dict:
        """拍扁 DOM → data.nodes[{desc,cls,clickable,center,size}]。

        输出 schema 与 Android 端一致，服务端 chat_parse / 流程锚点才能复用。
        """
        assert self.driver.page
        nodes = await self.driver.page.evaluate(_DUMP_JS)
        return {"nodes": nodes, "count": len(nodes)}

    async def op_node_click(self, desc: str, index: int = 0) -> dict:
        """按 desc 精确匹配可交互元素（上→下、左→右取第 index 个），
        用 elementHandle.click()（真实鼠标事件，等价无障碍语义点击）。"""
        assert self.driver.page
        found = await self.driver.page.evaluate(
            _NODE_CLICK_JS, {"desc": desc, "index": index})
        if not found:
            return {"clicked": False}
        try:
            handle = await self.driver.page.query_selector("[data-gc-click-target]")
            if handle is None:
                return {"clicked": False}
            await handle.click(timeout=5000)
            return {"clicked": True}
        finally:
            await self.driver.page.evaluate(
                "() => document.querySelectorAll('[data-gc-click-target]')"
                ".forEach(e => e.removeAttribute('data-gc-click-target'))")

    # ---- web 发布流程(publish_flow_web)扩展:JS 点击/填值/punish 探测 ----
    # 协议对齐 groupcontrol-server MqttRpcTransport 同名方法(local_transport 语义一致)。
    # 背景:发布页分类下拉被 tips-- 橙色浮层盖住,CDP 合成鼠标事件点不到
    # (elementFromPoint 命中浮层),JS el.click() 可穿透;punish 滑块在跨域 iframe,
    # dump_nodes 完全看不到,必须查 iframe src。

    async def op_fill_text(self, selector: str, text: str) -> dict:
        """整体填值:聚焦元素 → 全选 → insert_text(CDP 插入,React controlled input 安全,
        中文/emoji 不走按键映射)。input/textarea 用 select(),contenteditable 用 Range 全选。"""
        assert self.driver.page
        await self.driver.page.evaluate(
            """(sel) => {
                const el = document.querySelector(sel);
                if (!el) throw new Error('fill_text 未找到元素: ' + sel);
                el.focus();
                try {
                    if (typeof el.select === 'function') { el.select(); return; }
                } catch (e) { /* contenteditable 无 select */ }
                const r = document.createRange();
                r.selectNodeContents(el);
                const s = getSelection();
                s.removeAllRanges();
                s.addRange(r);
            }""", selector)
        await self.driver.page.keyboard.insert_text(text)
        return {}

    async def op_js_click_selector(self, selector: str) -> dict:
        """JS el.click() 点 selector 命中的第一个元素。返回 {clicked: 0/1}。"""
        assert self.driver.page
        clicked = await self.driver.page.evaluate(
            """(sel) => {
                const el = document.querySelector(sel);
                if (!el) return 0;
                el.click();
                return 1;
            }""", selector)
        return {"clicked": clicked}

    async def op_js_mouse_click(self, selector: str) -> dict:
        """JS 派发 mousedown/mouseup/click 事件序列(ant Select 靠 mousedown 开下拉,
        仅 el.click() 无效;物理 tap 又可能被 tips-- 浮层拦截)。返回 {clicked: 0/1}。"""
        assert self.driver.page
        clicked = await self.driver.page.evaluate(
            """(sel) => {
                const el = document.querySelector(sel);
                if (!el) return 0;
                for (const type of ['mousedown', 'mouseup', 'click']) {
                    el.dispatchEvent(new MouseEvent(type,
                        {bubbles: true, cancelable: true, view: window}));
                }
                return 1;
            }""", selector)
        return {"clicked": clicked}

    async def op_js_click_text(self, text: str, cls: str = "") -> dict:
        """JS el.click() 点第一个 textContent 精确等于 text 的无子元素(cls 非空时限定
        class 含 cls)。穿透浮层选中下拉选项用。返回 {clicked: 0/1}。"""
        assert self.driver.page
        clicked = await self.driver.page.evaluate(
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
        return {"clicked": clicked}

    async def op_risk_punish_active(self) -> dict:
        """探测阿里 punish 滑块 iframe:页面存在 src 含 _____tmd_____ 或 /punish 的
        iframe 时返回 {src: 片段},否则 {src: null}。跨域 iframe dump_nodes 看不到,
        风控锚点扫描会漏报,必须查 iframe src(2026-09-09 实测)。"""
        assert self.driver.page
        src = await self.driver.page.evaluate(
            """() => {
                for (const f of document.querySelectorAll('iframe')) {
                    const s = f.src || '';
                    if (s.includes('_____tmd_____') || s.includes('/punish')) return s.slice(0, 80);
                }
                return null;
            }""")
        return {"src": src}

    async def op_login_assist(self) -> dict:
        """在工作页每个 frame（含跨域登录 iframe）里点「保持登录状态」「快速进入」。
        返回 {clicked: 按钮文字|null}。服务端在判掉登录之前调（见 login_assist.py）。"""
        page = await self.driver.ensure_page()
        # 点了没登回去就刷新再点；「连接中断」弹窗先刷新再点（见 assist_login）；
        # 这一趟点没点中、几秒登回来，一行报给服务端
        return {"clicked": await assist_login(page, self.driver.current_nick, self.driver._notify)}

    async def op_reconnect_assist(self) -> dict:
        """检测「连接中断，请重连」弹窗：有则刷新页面再点「快速进入」。
        返回 {dialog: bool, clicked: 按钮文字|null}。服务端在 login_assist 点空之后调
        （groupcontrol-server app/flow/web/login.py）——弹窗把登录按钮压在底下时
        login_assist 什么都点不到，这里刷新一次再点。比 login_assist 慢（含整页刷新），
        服务端超时给 40s。"""
        page = await self.driver.ensure_page()
        return await reconnect_assist(page)

    async def op_page_snapshot(self) -> dict:
        """工作页每个 frame 的 HTML，服务端在自救失败时留档（见 login_assist.page_snapshot）。"""
        return await page_snapshot(await self.driver.ensure_page())

    # ---- tab 管理（web 商品流程：点卡片开详情页新 tab，协议对齐 MqttRpcTransport）----

    async def op_current_url(self) -> dict:
        """当前激活 tab 的 URL（服务端 page.url shim 每次走这个 op）。
        注意不能用 ensure_page()——它会重新挑选 goofish 首页 tab，
        wait_new_tab 切到详情 tab 后必须保持当前选择。"""
        page = self.driver.page
        if page is None or page.is_closed():
            page = await self.driver.ensure_page()
        return {"url": page.url or ""}

    async def op_wait_new_tab(self, contains: str | None = None,
                              url_contains: str | None = None,
                              timeout: float | None = None,
                              timeout_sec: float | None = None) -> dict:
        """等待点击后新开的 tab（按「URL 含特征」识别，不靠 pages 顺序——上下文里
        可能混有用户其它 tab），激活并成为 driver 当前页。返回 {url}，超时 → err。

        参数名兼容：contains/url_contains、timeout/timeout_sec。"""
        want = contains or url_contains
        deadline = time.monotonic() + (timeout or timeout_sec or 15.0)
        assert self.driver.browser
        ctx = self.driver.browser.contexts[0]
        # 识别基线:优先用点击类 op 在动作前留下的快照(Page 对象身份),60s 内有效;
        # 否则退回调用时刻的 URL 集合。不能纯按 URL——浏览器里可能已有同 URL 旧 tab,
        # 新弹出的详情 tab 会被误判「已见过」而永远跳过(2026-09-09 下架链路实测)。
        baseline = self.driver.tab_baseline
        if time.monotonic() - self.driver.tab_baseline_at > 60:
            baseline = {p for p in ctx.pages if not p.is_closed()}
        while time.monotonic() < deadline:
            for p in ctx.pages:
                if p.is_closed() or p in baseline or p in self.driver.reserved_pages:
                    continue
                if want and want not in p.url:
                    continue
                self.driver.page = p
                await p.bring_to_front()
                # SPA 页面 URL 先于内容就绪，多等一拍再交回
                try:
                    await p.wait_for_load_state("domcontentloaded", timeout=5000)
                except Exception:
                    pass
                return {"url": p.url or ""}
            await asyncio.sleep(0.5)
        raise RuntimeError(f"等待新 tab 超时(contains={want!r})")

    async def op_activate_tab(self, contains: str | None = None,
                              url_contains: str | None = None) -> dict:
        """按 URL 特征激活已存在的 tab（找不到 → err）。返回 {url}。"""
        want = contains or url_contains
        if not want:
            raise ValueError("activate_tab 需要 contains/url_contains")
        assert self.driver.browser
        ctx = self.driver.browser.contexts[0]
        for p in ctx.pages:
            if p in self.driver.reserved_pages:
                continue
            if not p.is_closed() and want in (p.url or ""):
                self.driver.page = p
                await p.bring_to_front()
                return {"url": p.url or ""}
        raise RuntimeError(f"没有 URL 含 {want!r} 的 tab")

    async def op_close_tab(self, contains: str | None = None,
                           url_contains: str | None = None) -> dict:
        """关闭 URL 含特征的 tab（默认关当前页之外的匹配页；关当前页则自动切到剩余 goofish 页）。
        返回 {closed: url|None}。"""
        want = contains or url_contains
        if not want:
            raise ValueError("close_tab 需要 contains/url_contains")
        assert self.driver.browser
        ctx = self.driver.browser.contexts[0]
        for p in list(ctx.pages):
            # 常驻监听页(im_watch 的 /im)不参与 tab 操作:contains="goofish.com"
            # 这种宽匹配会把它一起关掉/切走,消息实时链路就断在一个谁也想不到的地方。
            if p in self.driver.reserved_pages:
                continue
            if p.is_closed() or want not in (p.url or ""):
                continue
            url = p.url
            await p.close()
            if self.driver.page is p or (self.driver.page and self.driver.page.is_closed()):
                self.driver.page = None
                await self.driver.ensure_page()
            return {"closed": url}
        return {"closed": None}

    # ---- 应用/导航 ----

    async def op_launch_app(self, pkg: str) -> dict:
        """pkg 语义映射：http(s) 开头直接 goto；com.taobao.idlefish → 闲鱼首页。

        两个分支都走 driver.goto → ensure_page:launch_app 是每条流程的第一步,
        页面/浏览器在两次任务之间死掉是常态(用户关了 AdsPower 窗口就够了),
        这里不自愈,后面每个 op 都白跑(2026-09-10 生产:两条上架任务都秒挂在这)。
        """
        if pkg.startswith(("http://", "https://")):
            await self.driver.goto(pkg)
        elif pkg == "com.taobao.idlefish":
            await self.driver.open_xianyu()
        else:
            raise ValueError(f"unknown pkg: {pkg}")
        return {}

    async def op_force_stop(self, pkg: str | None = None) -> dict:
        """浏览器语义：回闲鱼首页。参数名 pkg 对齐服务端 MqttRpcTransport.force_stop(pkg=...)。"""
        await self.driver.open_xianyu()
        return {"degraded": True}

    async def op_screen_size(self) -> dict:
        """服务端 MqttRpcTransport 读 w/h 键，必须叫 w 和 h。
        CDP 接管的页面 viewport_size 可能为 None，用 JS innerWidth/innerHeight 兜底。"""
        assert self.driver.page
        vp = self.driver.page.viewport_size
        if not vp or not vp.get("width"):
            vp = await self.driver.page.evaluate(
                "() => ({width: window.innerWidth, height: window.innerHeight})")
        return {"w": vp["width"], "h": vp["height"]}

    async def op_self_check(self) -> dict:
        """浏览器存活 + 当前页可达 goofish.com + 登录态（昵称锚点,占位文案归一为未登录）。"""
        page_ok = False
        nick = None
        browser_alive = self.driver.page is not None and self.driver.browser is not None
        if browser_alive:
            try:
                # evaluate 走一次 CDP 往返，本身即浏览器存活探测
                nick = await asyncio.wait_for(
                    self.driver.page.evaluate(_NICK_JS, NICK_ANCHOR), 5)
                nick = normalize_nick(nick)
                page_ok = "goofish.com" in (self.driver.page.url or "")
            except Exception:
                browser_alive = False
                page_ok = False
                nick = None
        logged_in = bool(nick)
        return {"browser_alive": browser_alive, "page_ok": page_ok,
                "logged_in": logged_in, "nick": nick}

    # ---- 媒体（上架链路用：网页版无需相册，下载到本地 tmp，set_input_files 直接喂）----

    async def op_push_media(self, url: str) -> dict:
        """下载图片到 media_tmp_dir → data.uri（本地绝对路径）。文件名带毫秒时间戳防冲突。"""
        tmp_dir = Path(self.driver.cfg.executor.media_tmp_dir)
        tmp_dir.mkdir(parents=True, exist_ok=True)
        suffix = os.path.splitext(url.split("?")[0])[1] or ".jpg"
        path = tmp_dir / f"{int(time.time() * 1000)}{suffix}"
        content = await asyncio.to_thread(self._download, url)
        path.write_bytes(content)
        return {"uri": str(path.resolve())}

    async def op_clear_media(self, uris: list[str] | None = None) -> dict:
        """删除指定文件（uris 为 push_media 返回的本地路径）；uris 为空则清空整个临时目录。"""
        tmp_dir = Path(self.driver.cfg.executor.media_tmp_dir)
        deleted = 0
        if uris:
            for u in uris:
                p = Path(u)
                try:
                    if p.is_file() and p.parent.resolve() == tmp_dir.resolve():
                        p.unlink()
                        deleted += 1
                except OSError:
                    pass
        elif tmp_dir.is_dir():
            for p in tmp_dir.iterdir():
                if p.is_file():
                    try:
                        p.unlink()
                        deleted += 1
                    except OSError:
                        pass
        return {"deleted": deleted}

    async def op_upload_files(self, paths: list[str],
                              selector: str = "input[type=file]") -> dict:
        """把本地文件列表喂给页面隐藏 file input（ant-upload 直接触发上传）。
        paths 必须是本机路径（op_push_media 下载返回的 uri）。input 不带 multiple
        时只吃第一张（对齐服务端 local_transport.set_input_files 语义）。
        → data.count = 实际设置的文件数。"""
        assert self.driver.page
        handle = await self.driver.page.query_selector(selector)
        if not handle:
            raise RuntimeError(f"未找到 file input: {selector}")
        multiple = await handle.get_attribute("multiple")
        files = list(paths) if multiple is not None else list(paths[:1])
        await handle.set_input_files(files)
        return {"count": len(files)}

    # 网络抖一下（握手被断、连不上、超时）或图床 5xx 就再试；403/404 这种再试也没用。
    # 11-11 焕新重发撞上一次 SSL EOF：旧链接已删、只试一次，货就空到第二天
    DOWNLOAD_WAITS = (2.0, 5.0)

    @staticmethod
    def _download(url: str) -> bytes:
        for wait in (*PrimitiveExecutor.DOWNLOAD_WAITS, None):
            try:
                resp = httpx.get(url, timeout=30, follow_redirects=True)
                if resp.status_code < 500 or wait is None:
                    resp.raise_for_status()
                    return resp.content
            except httpx.TransportError:
                if wait is None:
                    raise
            time.sleep(wait)
        raise AssertionError("unreachable")

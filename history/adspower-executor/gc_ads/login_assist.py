"""登录自救：在页面每个 frame 里找「保持登录状态」「快速进入」点一下（B4.1 同款）。

会话过期但浏览器还记着这个号时，闲鱼弹的登录框是「快速进入 t**2」，点一下就回来，
不用人（2026-10-08 现场：洞穴Q弹的荆芥 就卡在这，被判掉登录、冻号）。

登录框在跨域的 passport iframe 里，主文档的 querySelector / dump_nodes 都看不到，
所以逐个 frame（Playwright 的 page.frames 含跨域子 frame）进去找。只点这两种按钮，
「其他账号登录」「短信登录」一概不碰；什么都没找到就什么都不做。
服务端流程在判掉登录之前调它（groupcontrol-server app/flow/web/login.py）。

按钮用真鼠标点：CDP 鼠标事件落在按钮正中，和人手点一样（isTrusted=true）。以前是代码
el.click()，2026-10-25 查生产：10-19 以来点「快速进入」550 次只登回去 1 次。真点没落到
按钮上（被别的层挡住、拿不到位置）才退回代码点。每趟结果一行报给服务端（driver.notify →
gc-api 日志「设备 … log: 登录自救…」），下次掉登录直接看是点没点中、几秒登回来的。

还有一种点不到的形态：页面上挂着「连接中断，请重连」的弹窗（IM 长连接被掐断），
登录卡片被压在底下，逐 frame 也什么都点不到——不处置就直接被判掉登录
（2026-10-10 现场，/im 页）。reconnect_assist 管这个：刷新页面 → 登录卡片冒出来
→ 点「快速进入」，手法与人工一致。
"""
from __future__ import annotations

import asyncio
import base64
import gzip
import json
import logging
import re
from typing import Awaitable, Callable
from urllib.parse import urlparse

log = logging.getLogger("gc.executor")

QUICK_ENTRY = "快速进入"
KEEP_LOGIN = "保持登录状态"
_KEEP_LABELS = [KEEP_LOGIN, "保持登录"]

# 只在闲鱼/淘宝系的 frame 里找（登录框是 passport.goofish.com / login.taobao.com 一类）；
# about:blank / srcdoc 这类没有域名的同源 frame 也看。
_LOGIN_HOST_SUFFIXES = ("goofish.com", "taobao.com", "alibaba.com", "alicdn.com", "tmall.com")

# 在一个 frame 里找按钮（只找不点），返回要点的元素，没有返回 null。
# - 文字整句等于按钮名才算（「快速进入」不接受「快速进入其他…」之类的长串）；
# - 先找 button / a / role=button / 带 btn 样式的元素，找不到再找最里层文字恰好是它的元素；
# - 「保持登录状态」若是勾选框：没勾就在这里勾上、返回 'checked'，勾着返回 null——
#   切换勾选状态代码点就够，不涉及提交登录。
_FIND_JS = r"""
([labels, keepMode]) => {
  const visible = (el) => {
    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.pointerEvents === 'none') return false;
    if (parseFloat(st.opacity || '1') === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  const textOf = (el) => (el.tagName === 'INPUT' ? (el.value || '') : (el.innerText || el.textContent || ''))
      .replace(/\s+/g, ' ').trim();
  const PREFERRED = 'button, a, [role="button"], input[type="button"], input[type="submit"], [class*="btn"], [class*="Btn"]';
  const find = () => {
    for (const el of document.querySelectorAll(PREFERRED)) {
      if (labels.includes(textOf(el)) && visible(el)) return el;
    }
    // 退一步：最里层文字恰好是按钮名的元素（子元素里没有同样文字的）
    for (const el of document.querySelectorAll('div, span, label')) {
      if (!labels.includes(textOf(el)) || !visible(el)) continue;
      const inner = [...el.children].some((c) => labels.includes(textOf(c)));
      if (!inner) return el;
    }
    return null;
  };
  const checkboxFor = (el) =>
    (el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'checkbox' && el)
    || el.querySelector('input[type="checkbox"]')
    || (el.htmlFor && document.getElementById(el.htmlFor))
    || (el.closest('label') && el.closest('label').querySelector('input[type="checkbox"]'))
    || null;

  const el = find();
  if (!el) return null;
  if (keepMode) {
    const box = checkboxFor(el);
    if (box) {
      if (box.checked) return null;
      box.click();
      return 'checked';
    }
  }
  return el;
}
"""

# 真点之前在按钮上挂一个只响一次的 click 监听：点完读回来，就知道这下落没落到按钮上
# （落在挡住它的层上就收不到）。按钮不在视口里先滚进来。
_ARM_JS = r"""
(el) => {
  el.__gcHit = null;
  el.addEventListener('click', (ev) => { el.__gcHit = ev.isTrusted; }, {capture: true, once: true});
  const r = el.getBoundingClientRect();
  if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) {
    el.scrollIntoView({block: 'center', inline: 'center'});
  }
}
"""
_HIT_JS = "(el) => el.__gcHit"
_JS_CLICK = "(el) => el.click()"

_FRAME_TIMEOUT_SEC = 3.0   # 空壳/卡死的 frame 不许把整个原语拖住


def _frame_worth_checking(url: str | None) -> bool:
    host = urlparse(url or "").hostname or ""
    return not host or host.endswith(_LOGIN_HOST_SUFFIXES)


async def _find(frame, labels: list[str], keep_mode: bool):
    """→ (要点的元素 | None, 勾选框已在 JS 里勾上时为 'checked')。"""
    handle = await asyncio.wait_for(frame.evaluate_handle(_FIND_JS, [labels, keep_mode]),
                                    timeout=_FRAME_TIMEOUT_SEC)
    el = handle.as_element()
    if el is not None:
        return el, None
    return None, await handle.json_value()


async def _real_click(page, el) -> None:
    await el.evaluate(_ARM_JS)
    # 主页面视口坐标：跨域 iframe 在页面里的偏移 Playwright 已经算进去了
    box = await el.bounding_box()
    if not box or box["width"] <= 2 or box["height"] <= 2:
        raise RuntimeError(f"拿不到按钮位置: {box}")
    await page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)


async def _hit(el) -> bool:
    """刚才那下真点落到按钮上没有。点完 frame 就跳走了（登录提交、页面刷新）读不回来，算落上了。"""
    try:
        return bool(await asyncio.wait_for(el.evaluate(_HIT_JS), timeout=_FRAME_TIMEOUT_SEC))
    except Exception:
        return True


async def _mouse_click(page, el) -> str:
    """真鼠标点 el 正中，返回「真鼠标」；没落到按钮上就退回代码点，返回「代码」；都不成返回 ""。"""
    try:
        await asyncio.wait_for(_real_click(page, el), timeout=_FRAME_TIMEOUT_SEC)
        if await _hit(el):
            return "真鼠标"
        log.info("真鼠标没点中按钮（被别的层挡住了？），改用代码点")
    except Exception as exc:
        log.info("真鼠标点不了（%s），改用代码点", exc)
    try:
        await asyncio.wait_for(el.evaluate(_JS_CLICK), timeout=_FRAME_TIMEOUT_SEC)
        return "代码"
    except Exception as exc:
        log.debug("代码点也失败: %s", exc)
        return ""


async def _click_login_buttons(page) -> tuple[str | None, str]:
    """在 page 的每个 frame 里点「保持登录状态」「快速进入」。返回（点到的按钮文字, 怎么点的）：
    两个都点了报「快速进入」——它才是把人带回去的那个；什么都没点到返回 (None, "")。"""
    clicked: str | None = None
    how = ""
    for frame in list(page.frames):
        try:
            if frame.is_detached() or not _frame_worth_checking(frame.url):
                continue
            el, done = await _find(frame, _KEEP_LABELS, True)
            if done == "checked" and clicked is None:
                clicked, how = KEEP_LOGIN, "勾选"
            elif el is not None:
                got = await _mouse_click(page, el)
                if got and clicked is None:
                    clicked, how = KEEP_LOGIN, got
            el, _ = await _find(frame, [QUICK_ENTRY], False)
            if el is not None:
                got = await _mouse_click(page, el)
                if got:
                    clicked, how = QUICK_ENTRY, got
                    break   # 带人回去的那一下已经点了，别的 frame 不再碰
        except Exception as exc:   # frame 中途没了、跨域拿不到、超时：跳过这一个
            log.debug("login_assist 跳过 frame %s: %s", getattr(frame, "url", "?"), exc)
            continue
    if clicked:
        log.info("登录弹窗里点了「%s」（%s）", clicked, how)
    return clicked, how


async def click_login_buttons(page) -> str | None:
    """在 page 的每个 frame 里点「保持登录状态」「快速进入」。返回点到的按钮文字，什么都没点到返回 None。"""
    return (await _click_login_buttons(page))[0]


# ---- 「连接中断，请重连」弹窗：刷新 + 再点（reconnect_assist 原语用的那半） ----

_DETECT_JS = "() => !!(document.body && (document.body.innerText || '').includes('连接中断'))"

# 刷新后登录卡片是异步渲染出来的，等一下再点；太短了按钮还没冒出来。
_POST_RELOAD_WAIT_MS = 3_500
_RELOAD_TIMEOUT_MS = 30_000


# 点完「快速进入」每半秒看一眼昵称，登回来就走，最多等 6 秒；还没回来就刷新页面再点一次，
# 再看 1.5 秒就交回服务端（服务端还会等 4 秒、重开页面再判）。整趟压在服务端 login_assist
# 的 RPC 超时（20s）以内：6 + 5 + 2.5 + 1.5 + 两次找按钮点按钮 ≈ 17s。
_POLL_MS = 500
_AFTER_CLICK_MAX_SEC = 6.0
_RETRY_RELOAD_TIMEOUT_MS = 5_000
_RETRY_POST_RELOAD_WAIT_MS = 2_500
_FINAL_MAX_SEC = 1.5


async def _wait_nick(page, read_nick, max_sec: float) -> float | None:
    """每半秒读一次昵称，读到返回用了几秒；max_sec 内都没读到返回 None。"""
    loop = asyncio.get_running_loop()
    t0 = loop.time()
    for _ in range(max(1, int(max_sec * 1000 / _POLL_MS))):
        await page.wait_for_timeout(_POLL_MS)
        if await read_nick():
            return loop.time() - t0
    return None


def _report(report: Callable[[str], None] | None, text: str, page) -> None:
    log.info(text)
    if report is not None:
        url = (getattr(page, "url", "") or "")[:80]
        report(f"{text} · {url}" if url else text)


async def assist_login(page, read_nick: Callable[[], Awaitable[str]],
                       report: Callable[[str], None] | None = None) -> str | None:
    """login_assist 原语的完整一趟，手法照人工：

    - 页面挂着「连接中断，请重连」：先刷新，登录卡片冒出来再点「快速进入」；
    - 否则直接点；点了「快速进入」等它登回去，等不到就刷新页面再点一次。

    2026-10-14 现场（南方举重雪白海胆）：点了「快速进入」没登回去，服务端重开页面再看
    还是登录卡片，直接判掉登录冻号——人工处置就是刷新再点。read_nick 读当前页昵称；
    report 收这一趟的结果（一行字，报给服务端）。
    返回点到的按钮文字，什么都没点到返回 None。
    """
    if await _has_reconnect_dialog(page):
        return (await reconnect_assist(page))["clicked"]
    clicked, how = await _click_login_buttons(page)
    if clicked != QUICK_ENTRY:
        _report(report, "登录自救:只勾了「保持登录状态」" if clicked
                else "登录自救:没找到能点的「快速进入」(要扫码)", page)
        return clicked
    took = await _wait_nick(page, read_nick, _AFTER_CLICK_MAX_SEC)
    if took is not None:
        _report(report, f"登录自救:用{how}点「快速进入」,{took:.1f} 秒登回来了", page)
        return clicked
    note = f"登录自救:用{how}点「快速进入」,{_AFTER_CLICK_MAX_SEC:.0f} 秒没登回;"
    try:
        await page.reload(wait_until="domcontentloaded", timeout=_RETRY_RELOAD_TIMEOUT_MS)
    except Exception as exc:
        log.warning("刷新失败: %s", exc)
        _report(report, f"{note}刷新失败({exc})", page)
        return clicked
    await page.wait_for_timeout(_RETRY_POST_RELOAD_WAIT_MS)
    again, how2 = await _click_login_buttons(page)
    if again == QUICK_ENTRY:
        back = await _wait_nick(page, read_nick, _FINAL_MAX_SEC) is not None
        _report(report, f"{note}刷新后用{how2}再点,{'登回来了' if back else '还没登回'}", page)
    else:
        _report(report, f"{note}刷新后没再看到「快速进入」", page)
    return again or clicked


async def _has_reconnect_dialog(page) -> bool:
    try:
        return bool(await asyncio.wait_for(page.evaluate(_DETECT_JS), timeout=_FRAME_TIMEOUT_SEC))
    except Exception:   # 页面正导航/关闭/卡死：当没弹窗
        return False


async def reconnect_assist(page) -> dict:
    """检测并处置「连接中断，请重连」弹窗，返回 ``{"dialog": bool, "clicked": str|None}``。

    弹窗挂着时登录卡片的「快速进入」被压在底下，click_login_buttons 什么都点不到，
    不处置就是一路 FAILED(网页版未登录)。处置手法 = 人工手法：刷新页面 → 登录卡片
    冒出来 → 点「快速进入」（复用上面的 click_login_buttons）。

    - dialog False：页面没弹窗（或探测不到），什么都没做；
    - dialog True 且 clicked 有值：刷新后点到了登录按钮，调用方按「点到了」处理；
    - dialog True 且 clicked None：弹窗在，但刷新后登录卡片没出来/没点到。
    """
    try:
        dialog = await asyncio.wait_for(page.evaluate(_DETECT_JS),
                                        timeout=_FRAME_TIMEOUT_SEC)
    except Exception:   # 页面正导航/关闭/卡死：当没弹窗，不碍调用方继续判
        return {"dialog": False, "clicked": None}
    if not dialog:
        return {"dialog": False, "clicked": None}
    url = (getattr(page, "url", "") or "")[:80]
    log.info("检测到「连接中断」弹窗，刷新页面再点「快速进入」: %s", url)
    try:
        await page.reload(wait_until="domcontentloaded", timeout=_RELOAD_TIMEOUT_MS)
    except Exception as exc:
        log.warning("刷新失败 %s: %s", url, exc)
        return {"dialog": True, "clicked": None}   # 没刷成别硬点：如实上报，交给调用方
    await page.wait_for_timeout(_POST_RELOAD_WAIT_MS)
    clicked = await click_login_buttons(page)
    if clicked:
        log.info("刷新后已点「%s」，页面恢复", clicked)
    else:
        log.info("刷新后未出现可点的登录按钮: %s", url)
    return {"dialog": True, "clicked": clicked}


# ---- 自救失败留档：每个 frame 的 HTML（page_snapshot 原语用） ----
#
# 「快速进入」在跨域登录 iframe 里，dump_nodes 看不到，截图也说不清按钮在不在 DOM 里，
# 所以要逐 frame 留 HTML。去掉内联脚本、样式和输入框的值：排查用不上，里面可能有令牌和手机号。

_SNAPSHOT_FRAME_MAX = 300_000
_SNAPSHOT_TOTAL_MAX = 700_000   # 压缩后，MQTT 单包有上限，超了从大到小丢 frame 的 HTML
_INLINE_SCRIPT = re.compile(r"<script\b(?![^>]*\bsrc=)[^>]*>.*?</script>", re.I | re.S)
_STYLE = re.compile(r"<style\b[^>]*>.*?</style>", re.I | re.S)
_INPUT_TAG = re.compile(r"<input\b[^>]*>", re.I)
_VALUE_ATTR = re.compile(r"""\svalue\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)""", re.I)


def sanitize_html(html: str) -> str:
    html = _STYLE.sub("<style></style>", _INLINE_SCRIPT.sub("<script></script>", html))
    return _INPUT_TAG.sub(lambda m: _VALUE_ATTR.sub("", m.group(0)), html)


def _pack_frames(frames: list[dict]) -> str:
    return base64.b64encode(gzip.compress(json.dumps(frames, ensure_ascii=False).encode())).decode()


async def page_snapshot(page) -> dict:
    """→ {url, frames: N, gz_b64: gzip 后的 [{url, name, html, truncated?, error?}]}。url 去掉查询串。"""
    frames = []
    for frame in page.frames:
        item = {"url": (getattr(frame, "url", "") or "").split("?")[0][:300], "name": frame.name or ""}
        try:
            html = sanitize_html(await asyncio.wait_for(frame.content(), timeout=_FRAME_TIMEOUT_SEC))
            item["html"] = html[:_SNAPSHOT_FRAME_MAX]
            if len(html) > _SNAPSHOT_FRAME_MAX:
                item["truncated"] = True
        except Exception as exc:   # 空壳/卡死/正跳转的 frame 不许拖住留档
            item["error"] = f"{type(exc).__name__}: {exc}"[:200]
        frames.append(item)
    packed = _pack_frames(frames)
    while len(packed) > _SNAPSHOT_TOTAL_MAX:
        biggest = max(frames, key=lambda f: len(f.get("html") or ""))
        if not biggest.get("html"):
            break
        biggest["html"], biggest["truncated"] = "", True
        packed = _pack_frames(frames)
    return {"url": (getattr(page, "url", "") or "").split("?")[0][:300], "frames": len(frames), "gz_b64": packed}

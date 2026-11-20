"""常驻 /im 标签页的消息门铃：**WS 帧当门铃，DOM 会话列表当信源，帧本身不解析**。

# 为什么要有它

会话此前只靠 `chat_scan` 每 5 分钟一轮拉取。采购要跟卖家谈价抢单，五分钟才知道
对面回了话，该抢的早没了——**这条服务的是采购账号**（AdsPower 这批浏览器环境是
采购端；销售留在安卓 App 群控，2026-09-13 老板当面定的划分）。转网页版后页面
握在自己手里，可以挂监听拿实时信号，把「知道」压到秒级。

# 为什么不解析帧

2026-09-13 实测（k1gnuq4m，已登录）：/im 打开后建两条长连接
（`wss://wss-goofish.dingtalk.com/` 与 `wss://msgacs.m.taobao.com/accs/auth`），
帧是**明文 JSON**，形如 `{"headers":{…},"code":200,"body":{…}}`。看着能解析，但：

- 页面加载瞬间就会下来 130KB+ 的初始 sync 大帧，「大帧 = 有新消息」是假信号
  （45 秒观察窗内没有任何新消息，照样收到 6 条大帧）；
- 帧 schema 是闲鱼内部协议，改版即失效，而真出问题时症状是「消息不再实时」这种
  静默失效，没人会立刻发现。

所以帧只当门铃用：**有帧来 → 立刻去看一眼 DOM**。判据全部落在会话列表的未读角标上，
那是页面自己渲染出来、`read_chats_web` 也在用的同一个语义。协议改版打不着我们，
也完全不需要碰 IM token（B4.1 的经验：取 token 的 x5sec 绑本机出口 IP，能不碰就不碰）。

# 为什么可以常驻

同一次实测确认：打开 /im **不会**自动选中首个会话（右侧无消息面板、无输入框），
40 秒内未读角标零变化。所以常驻这张页不会把未读读掉，`chat_scan` 的未读驱动不受影响。

# 纪律

**只读**。本模块不存在任何 click / fill / type / 发送调用，只有 `page.goto` 与
`page.evaluate` 取数（`scripts/test_im_watch.py` 用源码扫描把这条钉死）。
日志只记帧长度与条数，**绝不打印帧内容**——帧里有 sid / token。
"""
from __future__ import annotations

import asyncio
import json
import logging
import time

from .selectors import CHAT_URL, CONV_ITEM, NICK_ANCHOR, UNREAD_BADGE

log = logging.getLogger("gc.im_watch")

# 超过这个长度的帧不做解析:初始 sync 帧 130KB+,解析它纯属浪费,而且我们要的
# 只是「有动静」这一个比特。
_MAX_PARSE_BYTES = 4096

# 会话列表快照。行内三段文本按 DOM 顺序 = 昵称 / 最后一条摘要 / 时间(2026-09-13 实测),
# 这里只取昵称做行 key,摘要与时间不取——摘要是买家消息正文,没必要出本机。
_SNAPSHOT_JS = """(sel) => {
  const rows = [...document.querySelectorAll(sel.item)].map(r => {
    let nick = '';
    for (const el of r.querySelectorAll('*')) {
      let own = '';
      for (const n of el.childNodes) if (n.nodeType === 3) own += n.nodeValue;
      own = own.trim();
      if (own) { nick = own; break; }
    }
    const sup = r.querySelector(sel.badge);
    const raw = sup ? (sup.getAttribute('title') || sup.textContent || '').trim() : '';
    return {nick: nick.slice(0, 40), unread: /^\\d+$/.test(raw) ? Number(raw) : 0};
  });
  return rows.filter(r => r.nick);
}"""

# 登录态判定与生产路径同源:页头昵称锚点,排掉未登录时的登录入口文案。
_LOGIN_JS = """(sel) => {
  const ENTRY = ['登录','登录/注册','注册/登录','请登录','立即登录','登录注册','sign in','signin','login'];
  const el = [...document.querySelectorAll(sel)].find(e => {
    const t = (e.textContent || '').trim();
    if (!t || ENTRY.includes(t.toLowerCase())) return false;
    return e.getBoundingClientRect().top < window.innerHeight * 0.15;
  });
  return el ? el.textContent.trim().slice(0, 40) : '';
}"""


def is_heartbeat_frame(payload) -> bool:
    """心跳帧(不值得去看 DOM)= 小帧 + 合法 JSON + 没有 body。

    实测稳定期每 ~15s 一条 86B:`{"headers":{"mid":…,"server-timestamp":…},"code":200}`。
    有业务发生时帧里一定带 body。**拿不准一律当成有动静**(返回 False):
    多看一眼 DOM 的代价是一次 evaluate,漏看一条消息的代价是兜底不触发。
    """
    if not isinstance(payload, str):
        return False                      # 二进制帧:不解析,当成有动静
    if len(payload) > _MAX_PARSE_BYTES:
        return False                      # 初始 sync 之类的大帧:必然有 body
    try:
        frame = json.loads(payload)
    except (ValueError, TypeError):
        return False
    if not isinstance(frame, dict):
        return False
    return "body" not in frame


def diff_unread(prev: list[dict] | None, cur: list[dict],
                ignore_nicks: frozenset[str] = frozenset()) -> list[dict]:
    """两次快照之间**未读上涨**的会话(含 0/不存在 → ≥1)。没有上涨返回空表。

    只认上涨,不认下跌:未读清零是「我们自己刚把它读掉了」(chat_scan 进会话)或人工
    点开了会话——那不是新消息。认下跌会让 scan 清零这个动作本身再触发一次 scan,
    转成死循环。

    ``prev`` 为 None = 首次快照,只建基线不报:执行端刚起来时列表里的存量未读交给
    周期 chat_scan 收,不然每次重启都会把所有历史未读会话重扫一遍。
    """
    if prev is None:
        return []
    before = {r["nick"]: int(r.get("unread") or 0) for r in prev}
    out = []
    for row in cur:
        nick = row["nick"]
        if nick in ignore_nicks:
            continue
        now = int(row.get("unread") or 0)
        was = before.get(nick, 0)
        if now > was:
            out.append({"nick": nick, "from": was, "to": now})
    return out


def _merge_rises(pending: list[dict] | None, risen: list[dict]) -> list[dict]:
    """压着没报的上涨 + 这一拍的上涨,按昵称合并:from 取最早的,to 取最新的。"""
    merged = {c["nick"]: dict(c) for c in (pending or [])}
    for c in risen:
        if c["nick"] in merged:
            merged[c["nick"]]["to"] = c["to"]
        else:
            merged[c["nick"]] = dict(c)
    return list(merged.values())


class ImWatcher:
    """一个 AdsPower 环境一张常驻 /im 页;未读上涨就喊一嗓子(``on_hint``)。

    与 ``BrowserDriver.page`` 是两张页:业务原语照常在自己那张页上导航,互不干扰。
    本页登记进 ``driver.reserved_pages``,driver 挑页时会跳过它——否则一次浏览器自愈
    就可能把监听页挑去当业务页,接着被 goto 走,监听静悄悄地没了。
    """

    def __init__(self, driver, on_hint, *, chat_url: str = CHAT_URL,
                 poll_sec: float = 3.0, min_hint_interval_sec: float = 15.0,
                 relogin_retry_sec: float = 60.0,
                 ignore_nicks: frozenset[str] = frozenset({"通知消息"})):
        self.driver = driver
        self.on_hint = on_hint
        self.chat_url = chat_url or CHAT_URL
        self.poll_sec = poll_sec
        self.min_hint_interval_sec = min_hint_interval_sec
        self.relogin_retry_sec = relogin_retry_sec
        self.ignore_nicks = ignore_nicks
        self.page = None
        self._bell = asyncio.Event()
        self._prev: list[dict] | None = None
        self._last_hint_at: float = 0.0
        # 最小间隔内压下的上涨:基线已经跟进,下一拍不会再「涨」,所以要记着、间隔到了补报
        self._pending: list[dict] | None = None
        self._frames = 0        # 只计数,不记内容(帧里有 sid/token)

    # ---- 页面 ----

    async def _open_page(self):
        """新开一张页 → 挂帧监听 → goto /im。监听必须在 goto 之前挂,
        `page.on("websocket")` 只报挂载之后新建的连接,先跳再挂就什么都收不到。"""
        browser = self.driver.browser
        if browser is None or not browser.is_connected():
            raise RuntimeError("CDP 未连接")
        ctx = browser.contexts[0]
        page = await ctx.new_page()
        self.driver.reserve_page(page)
        page.on("websocket", self._on_websocket)
        await page.goto(self.chat_url)
        self.page = page
        return page

    def _on_websocket(self, ws) -> None:
        ws.on("framereceived", self._on_frame)

    def _on_frame(self, payload) -> None:
        self._frames += 1
        if is_heartbeat_frame(payload):
            return
        self._bell.set()

    async def _close_page(self) -> None:
        page, self.page = self.page, None
        if page is None:
            return
        self.driver.release_page(page)
        try:
            if not page.is_closed():
                await page.close()
        except Exception:
            log.debug("关监听页失败,忽略", exc_info=True)

    # ---- 主循环 ----

    async def run_forever(self) -> None:
        """挂了就重来。监听是尽力而为的加速通道,周期 chat_scan 始终是兜底,
        所以这里任何异常都只退避重试,绝不把执行端带崩。"""
        while True:
            try:
                await self._watch_once()
            except asyncio.CancelledError:
                await self._close_page()
                raise
            except Exception as exc:
                log.warning("im_watch 异常,%.0fs 后重来: %s: %s",
                            self.relogin_retry_sec, type(exc).__name__, exc)
                await self._close_page()
                self._prev = None
                self._pending = None
                await asyncio.sleep(self.relogin_retry_sec)

    async def _watch_once(self) -> None:
        page = await self._open_page()
        await page.wait_for_timeout(5_000)
        nick = await page.evaluate(_LOGIN_JS, NICK_ANCHOR)
        if not nick:
            # 没登录的环境(行情号就是这种)常驻一张 /im 没有意义,关掉待会儿再看。
            log.info("im_watch:环境未登录闲鱼,%.0fs 后重试", self.relogin_retry_sec)
            await self._close_page()
            await asyncio.sleep(self.relogin_retry_sec)
            return
        log.info("im_watch:常驻 /im 已就位(账号 %s)", nick)
        self._prev = None
        self._pending = None
        while True:
            try:
                await asyncio.wait_for(self._bell.wait(), timeout=self.poll_sec)
            except asyncio.TimeoutError:
                pass                       # 帧没来也定期看一眼:长连接断了不至于瞎
            self._bell.clear()
            if page.is_closed() or not self.driver.connected():
                raise RuntimeError("监听页或 CDP 已关闭")
            await self._tick(page)

    async def _tick(self, page) -> None:
        rows = await page.evaluate(_SNAPSHOT_JS, {"item": CONV_ITEM, "badge": UNREAD_BADGE})
        if not rows:
            # 空快照几乎总是「虚拟列表正在重渲染」而不是「真没有会话」。拿它当基线的话,
            # 下一拍列表回来就会被整列当成未读上涨,白扫一轮。跳过,基线保持不动。
            return
        risen = diff_unread(self._prev, rows, self.ignore_nicks)
        self._prev = rows
        if risen:
            self._pending = _merge_rises(self._pending, risen)
        if not self._pending:
            return
        now = time.monotonic()
        if now - self._last_hint_at < self.min_hint_interval_sec:
            # 服务端对同账号在途 chat_scan 本就去重,这里再压一道只是别把 MQTT 刷满。
            # 压下的不能丢:基线已经跟进,这条消息不会再「涨」一次——记着,间隔一到(下一拍,
            # 最多 poll_sec 秒)就补报。原来直接 return,间隔内来的那条要等下一轮周期扫描才进库。
            log.debug("im_watch:%d 个会话未读上涨,距上次提示不足 %.0fs,间隔到了再报",
                      len(self._pending), self.min_hint_interval_sec)
            return
        risen, self._pending = self._pending, None
        self._last_hint_at = now
        payload = {
            "kind": "chat_hint",
            "reason": "unread_up",
            "convs": risen,                                   # 只带昵称与计数,不带消息正文
            "unread_total": sum(int(r.get("unread") or 0) for r in rows),
            "ts": int(time.time() * 1000),
        }
        log.info("im_watch:未读上涨 %s → 提示服务端立刻扫一轮",
                 ",".join(f"{c['nick']}({c['from']}→{c['to']})" for c in risen))
        try:
            self.on_hint(payload)
        except Exception:
            log.warning("im_watch:提示上报失败,忽略", exc_info=True)

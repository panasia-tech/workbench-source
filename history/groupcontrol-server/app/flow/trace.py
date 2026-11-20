"""动作逐帧留痕:包装 Transport,每个动作原语执行后截一帧 + 记一条动作日志。

缘起(08-30):发布步「点了没反应/点错了」没有任何现场证据,只能靠事后猜。
开启后(gc_trace_actions)每个 tap/swipe/key/set_text/ime_*/node_click/launch_app
等动作都会:
  ① 动作执行后 screencap 一帧,存 OSS gc/shots/trace/<task>/NNN_<action>.png;
  ② 追加一条 {seq, ts, action, args, ms, shot} 记录;
任务结束 flush() 把全部记录写成 actions.json(同目录),配合截图可逐帧回放整单。

只包动作原语;screencap/dump_nodes/screen_size 等只读原语直透(追踪自身也要用 screencap,
包它会无限递归)。注意截图有约 1/s 节流(SHOT_MIN_INTERVAL_SEC),开留痕每动作约 +1~1.5s,
全流程慢 1~2 分钟——排查期开,稳定后把 gc_trace_actions 关掉即可。
"""

from __future__ import annotations

import json
import logging
import time
from urllib.parse import unquote, urlparse

from app import storage
from app.flow.transport import Transport

logger = logging.getLogger("gc.trace")

# 动作原语执行后、截图前的等待:给 UI 一点响应时间,截到的才是「动作的结果」
_SETTLE_BEFORE_SHOT = 0.5

# 正在跑的任务的留痕(task.id → TraceTransport),后台「回放」靠它看实时走到哪一步。
# runner 在线程池里跑流程、API 在事件循环线程里读:records 只追加,读的人拷一份快照就行。
_live: dict[str, "TraceTransport"] = {}


def track_live(tracer: "TraceTransport") -> None:
    _live[tracer.label] = tracer


def untrack_live(label: str) -> None:
    _live.pop(label, None)


def live_records(label: str) -> list[dict] | None:
    """任务还在跑就返回它到目前为止的动作记录(拷贝),否则 None。"""
    tracer = _live.get(label)
    return list(tracer.records) if tracer is not None else None


def _media_name(url: str) -> str:
    """图片链接只记对象路径。以前记链接末尾 60 个字符,截到的恰好全是签名参数(Expires/Signature)。"""
    path = unquote(urlparse(url).path)
    return (path or url.split("?", 1)[0])[-60:]


class TraceTransport(Transport):
    """Transport 装饰器:逐动作截图 + 记账。label 一般用 task.id。"""

    def __init__(self, inner: Transport, sink, label: str):
        self._inner = inner
        self._sink = sink            # storage.save_shot(name, bytes) -> key
        self._label = label
        self._seq = 0
        self.records: list[dict] = []

    @property
    def label(self) -> str:
        return self._label

    # ---------- 只读原语:直透,不留痕 ----------
    def screencap(self) -> bytes:
        return self._inner.screencap()

    def dump_nodes(self) -> list[dict]:
        return self._inner.dump_nodes()

    def screen_size(self) -> tuple[int, int]:
        return self._inner.screen_size()

    def page_snapshot(self) -> dict:
        return self._inner.page_snapshot()

    @property
    def device_id(self) -> str | None:
        return getattr(self._inner, "device_id", None)

    # ---------- 留痕核心 ----------
    def _trace(self, action: str, args: str, fn):
        self._seq += 1
        seq = self._seq
        t0 = time.time()
        err = None
        try:
            return fn()
        except Exception as ex:
            err = str(ex)[:200]
            raise
        finally:
            rec = {"seq": seq, "ts": round(t0, 3), "action": action, "args": args,
                   "ms": int((time.time() - t0) * 1000)}
            if err:
                rec["error"] = err
            try:
                time.sleep(_SETTLE_BEFORE_SHOT)
                rec["shot"] = self._sink(f"trace/{self._label}/{seq:03d}_{action}",
                                         self._inner.screencap())
            except Exception as sex:
                rec["shot_error"] = str(sex)[:120]
            self.records.append(rec)
            logger.info("trace[%s] #%03d %s %s%s", self._label, seq, action, args,
                        f" ERR={err}" if err else "")

    # ---------- 动作原语 ----------
    def tap(self, x: int, y: int) -> None:
        self._trace("tap", f"({x},{y})", lambda: self._inner.tap(x, y))

    def swipe(self, x1: int, y1: int, x2: int, y2: int, ms: int = 300) -> None:
        self._trace("swipe", f"({x1},{y1})->({x2},{y2}) {ms}ms",
                    lambda: self._inner.swipe(x1, y1, x2, y2, ms))

    def key(self, code: str) -> None:
        self._trace("key", code, lambda: self._inner.key(code))

    def set_text(self, text: str) -> None:
        self._trace("set_text", repr(text[:40]), lambda: self._inner.set_text(text))

    def set_clipboard(self, text: str) -> None:
        self._trace("set_clipboard", repr(text[:40]), lambda: self._inner.set_clipboard(text))

    def ime_picker(self) -> None:
        self._trace("ime_picker", "", lambda: self._inner.ime_picker())

    def ime_commit(self, text: str) -> None:
        self._trace("ime_commit", repr(text[:40]), lambda: self._inner.ime_commit(text))

    def ime_prefix(self, text: str) -> None:
        self._trace("ime_prefix", repr(text[:40]), lambda: self._inner.ime_prefix(text))

    def launch_app(self, pkg: str) -> None:
        self._trace("launch_app", pkg, lambda: self._inner.launch_app(pkg))

    def force_stop(self, pkg: str) -> None:
        self._trace("force_stop", pkg, lambda: self._inner.force_stop(pkg))

    def node_click(self, desc: str, index: int = 0) -> bool:
        return self._trace("node_click", f"{desc!r}[{index}]",
                           lambda: self._inner.node_click(desc, index))

    def node_long_click(self, desc: str, index: int = 0) -> bool:
        return self._trace("node_long_click", f"{desc!r}[{index}]",
                           lambda: self._inner.node_long_click(desc, index))

    def push_media(self, url: str) -> str | None:
        return self._trace("push_media", _media_name(url), lambda: self._inner.push_media(url))

    def clear_media(self, uris: list[str] | None = None) -> int:
        return self._trace("clear_media", f"{len(uris or [])}uris",
                           lambda: self._inner.clear_media(uris))

    def login_assist(self) -> str | None:
        # 会点按钮(快速进入/保持登录状态),算动作,留痕带截图
        return self._trace("login_assist", "", lambda: self._inner.login_assist())

    def reconnect_assist(self) -> dict:
        # 刷新页面 + 点「快速进入」,同样算动作。没有这一层透传,生产上(动作留痕默认开)
        # web/login.py 的 getattr 拿不到它,「连接中断」自救从来没跑过(2026-10-14 查日志 0 次)。
        return self._trace("reconnect_assist", "", lambda: self._inner.reconnect_assist())

    def set_input_files(self, paths: list[str], selector: str = "input[type=file]") -> int:
        return self._inner.set_input_files(paths, selector)

    # ---------- web 流程扩展原语(tab 管理 / JS 点击填值 / punish 探测):直透不留痕 ----
    # 这些是流程步级辅助(wait_new_tab 可能阻塞十几秒、risk_punish_active 是只读探测),
    # 与 dump_nodes 同级,不做动作留痕。web 流程(runner 包装 TraceTransport 后)靠这层
    # 透传才能访问 MqttRpcTransport 的扩展(goods_flows_web 用 wait_new_tab/page.url 等)。
    def wait_new_tab(self, contains: str | None = None, timeout: float = 15.0) -> str:
        return self._inner.wait_new_tab(contains=contains, timeout=timeout)

    def activate_tab(self, contains: str) -> str:
        return self._inner.activate_tab(contains)

    def current_url(self) -> str:
        return self._inner.current_url()

    @property
    def page(self):
        return self._inner.page

    def fill_text(self, selector: str, text: str) -> None:
        return self._inner.fill_text(selector, text)

    def js_click_selector(self, selector: str) -> int:
        return self._inner.js_click_selector(selector)

    def js_mouse_click(self, selector: str) -> int:
        return self._inner.js_mouse_click(selector)

    def js_click_text(self, text: str, cls: str = "") -> int:
        return self._inner.js_click_text(text, cls)

    def risk_punish_active(self) -> str | None:
        return self._inner.risk_punish_active()

    # ---------- 收尾 ----------
    def flush(self) -> str | None:
        """把动作记录写成 actions.json 落 OSS,返回 key;无记录返回 None。"""
        if not self.records:
            return None
        data = json.dumps({"label": self._label, "records": self.records},
                          ensure_ascii=False, indent=1).encode()
        key = storage.save_blob(f"trace/{self._label}/actions", data, "json")
        logger.info("trace[%s] 共 %d 个动作,索引=%s", self._label, len(self.records), key)
        return key

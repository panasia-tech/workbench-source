"""步骤引擎:OCR 锚点定位 + 重试/超时 + 异常兜底(截图) + 风控熔断。

与旧 automation/xy_engine.py 同一套方法面(find/require/tap_text/scroll_to/
dump_nodes/tap_node_by_desc/keypad_type/run),但底层操作全走 Transport,
不再直接 adb;OCR 走 app.flow.ocr。dev/prod 用同一 Engine,只换 Transport。
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import time

from app.flow import ocr as O
from app.flow.transport import Transport


class StepError(Exception):
    def __init__(self, step: str, reason: str, shot: str | None = None):
        super().__init__(f"[{step}] {reason}")
        self.step = step
        self.reason = reason
        self.shot = shot


class RiskHit(Exception):
    """命中风控锚点(验证码/异常/申诉)。上层应熔断该账号,绝不重试。"""

    def __init__(self, anchor: str, shot: str | None = None):
        super().__init__(f"命中风控:{anchor}")
        self.anchor = anchor
        self.shot = shot


class LoginRequired(Exception):
    """账号在闲鱼掉登录(开场到不了已知起点、且命中登录页锚点)。
    上层应冻结账号 + 通知人工重新登录(闲鱼登录须人工,无法自动),勿重试。"""

    def __init__(self, reason: str = "账号未登录", shot: str | None = None):
        super().__init__(reason)
        self.reason = reason
        self.shot = shot


# 已知打扰弹窗:出现即点掉(保守白名单,不含「允许/取消」语义敏感项)
NUISANCE_DISMISS = ["以后再说", "我知道了", "知道了", "跳过", "暂不"]

# 风控锚点:命中即熔断账号(不重试,重试风控页=往枪口撞)。
#
# 判据本身在 risk_anchors.json——**全系统唯一一份**，桌面端行情采集读的也是它。
# 2026-09-16 合并前三处各写各的，而且内容真的不一样：两边只共享「验证码」和
# 「安全验证」两个词，这边认不出「访问受限/请求频繁/非法访问/风控拦截」，
# 那边认不出「账号异常/申诉/违规/人机验证」。不是重复，是各学各的教训。
_RISK_FILE = Path(__file__).with_name("risk_anchors.json")


def _load_risk_signals() -> dict[str, list[str]]:
    """读共用判据。读不到就抛——**不给兜底默认值**。

    静默退回一份内置列表，等于让「文件没打包进去」这种事变成「风控判据悄悄
    少了一半」，而症状要等到有账号被封才看得见。宁可起不来。
    """
    data = json.loads(_RISK_FILE.read_text(encoding="utf-8"))
    signals = data.get("signals") or {}
    if not signals:
        raise RuntimeError(f"{_RISK_FILE} 里没有 signals，风控判据不能为空")
    return {k: list(v) for k, v in signals.items()}


RISK_SIGNALS = _load_risk_signals()
#: 扁平化的锚点列表。命中任意一条即熔断。
RISK_ANCHORS = [text for texts in RISK_SIGNALS.values() for text in texts]


def risk_signal_for(text: str) -> str:
    """这段文本命中了哪一类风控（没命中返回空串）。给要区分类型的调方用。"""
    haystack = str(text or "")
    for name, texts in RISK_SIGNALS.items():
        if any(t in haystack for t in texts):
            return name
    return ""


def _local_shot_sink(name: str, data: bytes) -> str:
    os.makedirs("shots", exist_ok=True)
    path = os.path.join("shots", f"{int(time.time())}_{name}.png")
    with open(path, "wb") as f:
        f.write(data)
    return path


class Engine:
    def __init__(self, transport: Transport, shot_sink=None, risk_guard: bool = True):
        """shot_sink(name, bytes)->str:落异常截图,返回可回传的 key/path。
        生产传一个上传 OSS 的实现;默认写本地 ./shots。"""
        self.t = transport
        self.shot_sink = shot_sink or _local_shot_sink
        self.risk_guard = risk_guard
        self.width, self.height = transport.screen_size()

    # ---------- 底层 ----------
    def screencap(self) -> bytes:
        return self.t.screencap()

    def read(self) -> list[dict]:
        items = O.ocr(self.screencap())
        if self.risk_guard:
            for anchor in RISK_ANCHORS:
                if O.find(items, anchor):
                    raise RiskHit(anchor, self.save_shot(f"risk_{anchor}"))
        return items

    def save_shot(self, name: str) -> str:
        return self.shot_sink(name, self.screencap())

    # ---------- 锚点 ----------
    def find(self, target: str, contains: bool = True, timeout: float = 8) -> dict | None:
        deadline = time.time() + timeout
        while True:
            hit = O.find(self.read(), target, contains=contains)
            if hit:
                return hit
            if time.time() >= deadline:
                return None
            time.sleep(0.7)

    def require(self, target: str, step: str, contains: bool = True, timeout: float = 8) -> dict:
        hit = self.find(target, contains=contains, timeout=timeout)
        if not hit:
            raise StepError(step, f"未找到锚点「{target}」", self.save_shot(f"miss_{step}"))
        return hit

    def tap_text(self, target: str, step: str, timeout: float = 8, settle: float = 1.0):
        hit = self.require(target, step, timeout=timeout)
        self.t.tap(*hit["center"])
        time.sleep(settle)
        return hit

    def tap_xy(self, x: int, y: int, settle: float = 0.4):
        self.t.tap(x, y)
        time.sleep(settle)

    def find_any(self, targets: list[str], timeout: float = 8) -> tuple[str, dict] | None:
        deadline = time.time() + timeout
        while True:
            items = self.read()
            for t in targets:
                hit = O.find(items, t)
                if hit:
                    return t, hit
            if time.time() >= deadline:
                return None
            time.sleep(0.7)

    def require_any(self, targets: list[str], step: str, timeout: float = 8) -> tuple[str, dict]:
        r = self.find_any(targets, timeout=timeout)
        if not r:
            raise StepError(step, f"未找到任一锚点 {targets}", self.save_shot(f"miss_{step}"))
        return r

    def wait_any(self, targets: list[str], timeout: float = 8) -> str | None:
        deadline = time.time() + timeout
        while True:
            items = self.read()
            for t in targets:
                if O.find(items, t):
                    return t
            if time.time() >= deadline:
                return None
            time.sleep(0.7)

    def scroll_to(self, target: str, step: str, max_swipes: int = 5, contains: bool = True) -> dict:
        """向下滚动找锚点。小幅滑(不从屏幕底缘起,免触发系统返回手势)。"""
        hit = self.find(target, contains=contains, timeout=2)
        if hit:
            return hit
        for _ in range(max_swipes):
            self.t.swipe(600, 1700, 600, 1150, 400)
            time.sleep(1.0)
            hit = self.find(target, contains=contains, timeout=1.5)
            if hit:
                return hit
        raise StepError(step, f"滚动后仍未找到「{target}」", self.save_shot(f"scroll_{step}"))

    def dismiss_nuisance(self):
        items = self.read()
        for t in NUISANCE_DISMISS:
            hit = O.find(items, t)
            if hit:
                self.t.tap(*hit["center"])
                time.sleep(0.6)

    def input_text(self, text: str):
        """写入当前聚焦框(无障碍 setText / ADBKeyboard,中文空格安全)。"""
        self.t.set_text(text)
        time.sleep(0.6)

    # ---------- 控件树节点(选图器等原生页,比 OCR 稳)----------
    def dump_nodes(self) -> list[dict]:
        return self.t.dump_nodes()

    def find_node(self, contains: str, clickable_only: bool = False) -> dict | None:
        """按 desc **子串**找节点，返回面积最小的那个匹配。

        Flutter 的 semantics 树是扁平聚合的：整张商品卡片的文字("降价|编辑|标题…")会挤在
        一个 desc 里，所以同一个关键词往往既命中「精确的小控件」也命中「包住半屏的大容器」。
        取面积最小者，才是真正想点的东西。
        """
        cands = []
        for n in self.dump_nodes():
            if contains not in (n.get("desc") or ""):
                continue
            if clickable_only and not n.get("clickable"):
                continue
            cands.append(n)
        if not cands:
            return None
        return min(cands, key=lambda n: (n["size"][0] * n["size"][1]) or 1 << 30)

    def tap_smart(self, target: str, step: str, timeout: float = 8, settle: float = 1.0) -> dict:
        """点击目标：**先节点、后 OCR**。

        节点自带精确 bounds，不受 OCR 置信度排序、文字中心偏移这些问题影响——
        这两样都真实坑过：①「定价」被长句「…帮你智能定价」按置信度抢走；
        ②底部 tab 点 OCR 文字中心会落进系统手势区被吞、还不报错。
        OCR 只用于读不到节点的地方(如闲鱼的确认弹层)。
        """
        node = self.find_node(target, clickable_only=True) or self.find_node(target)
        if node:
            self.tap_xy(*node["center"], settle=settle)
            return node
        return self.tap_text(target, step, timeout=timeout, settle=settle)

    def tap_node_by_desc(self, desc: str, step: str, index: int = 0, timeout: float = 8) -> dict:
        deadline = time.time() + timeout
        while True:
            nodes = [n for n in self.dump_nodes() if n["desc"] == desc and n["size"][0] > 10]
            nodes.sort(key=lambda n: (n["center"][1], n["center"][0]))
            if len(nodes) > index:
                self.tap_xy(*nodes[index]["center"], settle=1.0)
                return nodes[index]
            if time.time() >= deadline:
                raise StepError(step, f"未找到第{index}个 desc=「{desc}」节点", self.save_shot(f"nonode_{step}"))
            time.sleep(0.7)

    # ---------- 应用内数字键盘(node_click 语义点击,绕过合成触摸过滤)----------
    def keypad_type(self, digits, step: str, timeout: float = 6, clear: bool = True):
        """闲鱼定价/邮费的应用内自定义数字键盘。弹起后**优先 set_text 整段覆盖**输入框
        (2026-07-15 真机定论:键盘弹起时输入框是原生 EditText,ACTION_SET_TEXT 可整段替换,
        免清空、天然精确)。set_text 没写进(读不到期望值)再退回逐位 node_click 数字键
        (数字键是 clickable Button,ACTION_CLICK 可入;但「删除」不是真 Button、清空不可靠,
        逐位方案遇预填会拼出鬼价——故 set_text 为主)。键盘弹起判断用节点树里有没有数字键,
        不能用 OCR「确定」(智能定价面板自带取消/确定会误判)。"""
        deadline = time.time() + timeout
        while True:
            descs = {n["desc"] for n in self.t.dump_nodes()}
            if {"1", "2", "3"} <= descs:
                break
            if time.time() >= deadline:
                raise StepError(step, "数字键盘未弹起(节点树无数字键)", self.save_shot(f"kp_{step}"))
            time.sleep(0.7)
        target = str(int(digits)) if not isinstance(digits, str) else digits
        # set_text 整段覆盖(键盘弹起时输入框是原生 EditText)。不逐位 node_click:
        # 「删除」不是真 Button 清空不可靠,逐位方案遇预填会拼出鬼价(realpub5=364600)。
        try:
            self.t.set_text(target)
            time.sleep(0.5)
        except Exception as ex:
            raise StepError(step, f"set_text 写入失败:{ex}", self.save_shot(f"kp_{step}"))
        self.t.node_click("确定")
        time.sleep(1.0)

    # ---------- 编排 ----------
    def run(self, steps: list[tuple], spec: dict) -> dict:
        """顺序执行 [(name, fn), ...]。fn(engine, spec)。

        返回 {ok, done, failed_step, reason, shot, risk}。
        - StepError:普通失败(可重试),带步骤名+原因+截图。
        - RiskHit:命中风控,risk=锚点,上层须熔断账号,勿重试。
        """
        done = []
        for name, fn in steps:
            try:
                fn(self, spec)
                done.append(name)
            except RiskHit as e:
                return {"ok": False, "done": done, "failed_step": name,
                        "reason": str(e), "shot": e.shot, "risk": e.anchor}
            except LoginRequired as e:
                return {"ok": False, "done": done, "failed_step": name,
                        "reason": e.reason, "shot": e.shot, "risk": None, "login": True}
            except StepError as e:
                return {"ok": False, "done": done, "failed_step": e.step,
                        "reason": e.reason, "shot": e.shot, "risk": None}
            except Exception as e:
                shot = self.save_shot(f"err_{name}")
                return {"ok": False, "done": done, "failed_step": name,
                        "reason": f"未预期异常:{e}", "shot": shot, "risk": None}
        return {"ok": True, "done": done, "failed_step": None, "reason": None, "shot": None, "risk": None}

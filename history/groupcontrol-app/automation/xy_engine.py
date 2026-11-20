"""闲鱼自动化步骤引擎:OCR 锚点定位 + 重试/超时 + 异常兜底 + 失败截图。

设计目标(对齐需求「异常自动重试 + 异常队列(步骤/原因/截图)」):
- 每个操作都先确认锚点在场,找不到就带**步骤名+原因+截图**抛 StepError,而不是盲点坐标。
- 数字键盘(闲鱼应用内自定义键盘)**锚定到 OCR 可识别的「确定」按钮**动态推算网格,
  不硬编码坐标,跨机型/跨面板(价格/邮费)都稳。
- run() 顺序执行步骤,任一步失败即中止并返回结构化结果,供上层映射到 MQTT report(status=error)。
"""

import os
import re
import subprocess
import time
import xml.etree.ElementTree as ET

import ocr_tap as O


class StepError(Exception):
    def __init__(self, step: str, reason: str, shot: str | None = None):
        super().__init__(f"[{step}] {reason}")
        self.step = step
        self.reason = reason
        self.shot = shot


# 已知打扰弹窗:出现即点掉(保守白名单,不含「允许/取消」这类语义敏感项)
NUISANCE_DISMISS = ["以后再说", "我知道了", "知道了", "跳过", "暂不"]


class Engine:
    def __init__(self, serial: str | None = None, shot_dir: str = "shots"):
        self.serial = serial
        self.shot_dir = shot_dir
        os.makedirs(shot_dir, exist_ok=True)

    # ---------- 底层 ----------
    def _adb(self, *args):
        subprocess.run(["adb"] + (["-s", self.serial] if self.serial else []) + list(args), check=False)

    def screencap(self) -> bytes:
        return O.screencap(self.serial)

    def read(self) -> list[dict]:
        return O.ocr(self.screencap())

    def save_shot(self, name: str) -> str:
        path = os.path.join(self.shot_dir, f"{int(time.time())}_{name}.png")
        with open(path, "wb") as f:
            f.write(self.screencap())
        return path

    # ---------- 锚点 ----------
    def find(self, target: str, contains: bool = True, timeout: float = 8) -> dict | None:
        """轮询截图直到出现文字锚点,返回命中项(带 center);超时 None。"""
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
        O.tap(*hit["center"], serial=self.serial)
        time.sleep(settle)
        return hit

    def tap_xy(self, x: int, y: int, settle: float = 0.4):
        O.tap(x, y, serial=self.serial)
        time.sleep(settle)

    def find_any(self, targets: list[str], timeout: float = 8) -> tuple[str, dict] | None:
        """多锚点任一命中即返回 (target, hit)。用于文案 OCR 不稳时给候选。"""
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
        """等多个锚点里任一出现,返回先命中的那个 target。"""
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
        """内容变长时向下滚动找锚点。用小幅滑(不从屏幕底缘起,免触发系统返回手势)。"""
        hit = self.find(target, contains=contains, timeout=2)
        if hit:
            return hit
        for _ in range(max_swipes):
            self._adb("shell", "input", "swipe", "600", "1700", "600", "1150", "400")
            time.sleep(1.0)
            hit = self.find(target, contains=contains, timeout=1.5)
            if hit:
                return hit
        raise StepError(step, f"滚动后仍未找到「{target}」", self.save_shot(f"scroll_{step}"))

    def dismiss_nuisance(self):
        """点掉已知打扰弹窗(best-effort,不报错)。"""
        items = self.read()
        for t in NUISANCE_DISMISS:
            hit = O.find(items, t)
            if hit:
                O.tap(*hit["center"], serial=self.serial)
                time.sleep(0.6)

    # ---------- 控件树节点(无 OCR 文字锚点时,如选图器缩略图)----------
    def dump_nodes(self) -> list[dict]:
        """uiautomator dump 控件树(=无障碍读的同一棵树),返回节点列表。
        用于选图器这种无文字、纯缩略图的界面:靠 content-desc(如「选择」)精准定位。"""
        remote = "/sdcard/ui_dump.xml"
        self._adb("shell", "uiautomator", "dump", remote)
        subprocess.run(["adb"] + (["-s", self.serial] if self.serial else []) +
                       ["pull", remote, "/tmp/ui_dump.xml"], capture_output=True)
        nodes = []
        try:
            for n in ET.parse("/tmp/ui_dump.xml").getroot().iter("node"):
                m = re.findall(r"\d+", n.get("bounds", ""))
                if len(m) != 4:
                    continue
                x1, y1, x2, y2 = map(int, m)
                nodes.append({
                    "desc": n.get("content-desc", "") or "",
                    "cls": n.get("class", ""),
                    "clickable": n.get("clickable") == "true",
                    "center": ((x1 + x2) // 2, (y1 + y2) // 2),
                    "size": (x2 - x1, y2 - y1),
                })
        except ET.ParseError:
            pass
        return nodes

    def tap_node_by_desc(self, desc: str, step: str, index: int = 0, timeout: float = 8) -> dict:
        """点第 index 个 content-desc==desc 的节点(按 y,x 排序)。用于选图器「选择」框。"""
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

    # ---------- 应用内数字键盘(锚定「确定」)----------
    def keypad_type(self, digits: str, step: str, timeout: float = 6):
        """在闲鱼应用内自定义数字键盘上逐位点数字,最后点确定。

        网格由 OCR 识别到的「确定」黄键锚定推算:列固定 150/450/750(第4列即确定所在),
        行相对确定中心偏移(实测校准)。跨面板/机型只要能 OCR 到确定即自适应。
        """
        ok = self.require("确定", step, timeout=timeout)
        cx, cy = ok["center"]
        c1, c2, c3 = cx - 899, cx - 599, cx - 299        # ≈150/450/750
        r123, r456, r789, r0 = cy - 421, cy - 276, cy - 131, cy + 159
        grid = {
            "1": (c1, r123), "2": (c2, r123), "3": (c3, r123),
            "4": (c1, r456), "5": (c2, r456), "6": (c3, r456),
            "7": (c1, r789), "8": (c2, r789), "9": (c3, r789),
            "0": (c2, r0),
        }
        for d in str(digits):
            if d not in grid:
                raise StepError(step, f"键盘不支持字符「{d}」")
            self.tap_xy(*grid[d], settle=0.3)
        self.tap_xy(cx, cy, settle=1.0)  # 确定

    # ---------- 编排 ----------
    def run(self, steps: list[tuple], spec: dict) -> dict:
        """顺序执行 [(name, fn), ...]。fn(engine, spec)。任一步 StepError 即中止。

        返回 {ok, done:[已完成步骤], failed_step, reason, shot}。
        """
        done = []
        for name, fn in steps:
            try:
                fn(self, spec)
                done.append(name)
            except StepError as e:
                return {"ok": False, "done": done, "failed_step": e.step,
                        "reason": e.reason, "shot": e.shot}
            except Exception as e:  # 兜底,避免脚本崩
                shot = self.save_shot(f"err_{name}")
                return {"ok": False, "done": done, "failed_step": name,
                        "reason": f"未预期异常:{e}", "shot": shot}
        return {"ok": True, "done": done, "failed_step": None, "reason": None, "shot": None}

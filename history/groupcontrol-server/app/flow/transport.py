"""设备原语传输层:把「怎么操作手机」抽象成一组原语,给两种实现。

Engine 只依赖这个接口,不关心底下是本地 ADB 还是远端 MQTT。
- AdbTransport:本地 adb subprocess,开发/调试真机用(等价旧 ocr_tap + xy_engine._adb)。
- MqttRpcTransport:经 app.mqtt_bridge 的原语 RPC 驱动远端手机,生产用。

原语清单(与 App 端 PrimitiveExecutor / docs/01 协议对齐):
  screencap / tap / swipe / key / dump_nodes / set_text / set_clipboard / launch_app / force_stop / screen_size
"""

from __future__ import annotations

import asyncio
import base64
import gzip
import json
import os
import re
import subprocess
import time
import xml.etree.ElementTree as ET

# 截图专用超时(秒)。见 MqttRpcTransport.screencap 注释：端上重试最坏 20s+，
# 必须大于端侧硬超时才不会把「正在重试」误判成「设备失联」。
SCREENCAP_TIMEOUT = 30.0
from abc import ABC, abstractmethod

# 对齐 APK 侧无障碍 takeScreenshot 的频率限制(约 1/s):开发用 adb 也强制同样节流,
# 免得流程偷偷依赖了 adb「随便截图」的能力,拖到正式包才暴露。见 docs/01。
SHOT_MIN_INTERVAL_SEC = 1.1


class Transport(ABC):
    """一台设备的原语通道。坐标单位=像素,原点左上。"""

    @abstractmethod
    def screencap(self) -> bytes:
        """当前屏 PNG/JPEG 字节。"""

    @abstractmethod
    def tap(self, x: int, y: int) -> None: ...

    @abstractmethod
    def swipe(self, x1: int, y1: int, x2: int, y2: int, ms: int = 300) -> None: ...

    @abstractmethod
    def key(self, code: str) -> None:
        """系统按键,如 WAKEUP / BACK。"""

    @abstractmethod
    def dump_nodes(self) -> list[dict]:
        """控件树节点:[{desc, cls, clickable, center:(x,y), size:(w,h)}]。"""

    @abstractmethod
    def set_text(self, text: str) -> None:
        """把 text 写入当前聚焦输入框(无障碍 setText,中文/空格安全)。"""

    @abstractmethod
    def set_clipboard(self, text: str) -> None:
        """写系统剪贴板。注:剪贴板+长按粘贴路线 2026-07-28 实测被 Flutter 手势识别封堵,
        仅留作通用能力;输入框注入请用 ime_input。"""

    @abstractmethod
    def ime_picker(self) -> None:
        """弹系统输入法选择器。切换/切回内置微型 IME 用——MIUI 对三方应用的
        WRITE_SECURE_SETTINGS 授权不生效(2026-07-29 实测),选择器无需权限,
        条目点击由流程引擎 OCR 完成(原生对话框)。"""

    @abstractmethod
    def ime_commit(self, text: str) -> None:
        """等 InputConnection 就绪后向聚焦输入框 commitText(需已切到内置微型 IME)。

        Flutter 聊天输入框 ACTION_SET_TEXT 无可写节点、手势/语义长按均不弹「粘贴」
        (2026-07-28 实测);IME commitText 与 adb input text 同原理,Flutter 照单全收。"""

    @abstractmethod
    def ime_prefix(self, text: str) -> None:
        """把 text 插入聚焦输入框内容开头(setSelection(0,0)+commitText)。
        发布流程在 AI 生成的标题/描述前注入 4 位上架编码用(首行即闲鱼标题)。"""

    @abstractmethod
    def launch_app(self, pkg: str) -> None: ...

    @abstractmethod
    def force_stop(self, pkg: str) -> None: ...

    @abstractmethod
    def screen_size(self) -> tuple[int, int]:
        """(width, height) 像素。"""

    @abstractmethod
    def node_click(self, desc: str, index: int = 0) -> bool:
        """对 content-desc==desc 的可点击节点执行 ACTION_CLICK(语义点击,非合成触摸)。
        闲鱼定价/邮费自定义数字键盘过滤无障碍合成触摸(tap 点不动),但键位是 clickable Button 节点,
        performAction(CLICK) 可入。返回是否点成功。同 desc 多节点用 index 选第几个(上→下、左→右)。"""

    @abstractmethod
    def node_long_click(self, desc: str, index: int = 0) -> bool:
        """对 content-desc==desc 的节点执行 ACTION_LONG_CLICK(语义长按)。
        Flutter 输入框弹「粘贴」菜单用:dispatchGesture 的定点长滑/长触在 Flutter 手势识别里
        不触发 onLongPress(2026-07-28 小米12 实测),语义 LONG_CLICK 才有效。"""

    @abstractmethod
    def push_media(self, url: str) -> str | None:
        """下载 url 图片/视频入设备相册并触发媒体扫描(发布选图用)，返回 MediaStore uri。

        生产:App 拿 OSS 签名 URL 自己下载 + MediaScanner(绕开微信压缩图)。
        硬禁 asset/*_order_*(买家隐私成交截图)与 sku/location/(库位图)——由调用方保证只传 sku/product/。
        **返回的 uri 必须记账**，发布结束用 clear_media 删掉，否则见 clear_media 的说明。"""

    def clear_media(self, uris: list[str] | None = None) -> int:
        """删除本端推入相册的商品图，返回删除条数。

        不清理会出两种事：①图无限堆积(单机数百 MB 且永不回收)；
        ②step_images 靠「点最新的 N 张」选图，残留一多就会**把上一个商品的图发到这个商品上**。
        传 uris 精确删；不传则清掉本端写入 DCIM/gc 的全部图片。"""
        return 0


_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _parse_ui_dump(xml_bytes: bytes) -> list[dict]:
    """uiautomator dump 的 XML → 统一节点结构。App 端 dump_nodes 也返回同结构。"""
    nodes: list[dict] = []
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError:
        return nodes
    for n in root.iter("node"):
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
    return nodes


class AdbTransport(Transport):
    """本地 ADB 直连(开发用)。需要 ADBKeyboard 支持中文输入(set_text 走它)。"""

    def __init__(self, serial: str | None = None):
        self.serial = serial
        self._last_shot = 0.0

    def _base(self) -> list[str]:
        return ["adb"] + (["-s", self.serial] if self.serial else [])

    def _adb(self, *args) -> subprocess.CompletedProcess:
        return subprocess.run(self._base() + list(args), capture_output=True)

    def screencap(self) -> bytes:
        # 强制与 APK takeScreenshot 同样的最小间隔,保持开发/正式行为一致
        gap = SHOT_MIN_INTERVAL_SEC - (time.time() - self._last_shot)
        if gap > 0:
            time.sleep(gap)
        raw = subprocess.run(self._base() + ["exec-out", "screencap", "-p"],
                             capture_output=True, check=True).stdout
        self._last_shot = time.time()
        idx = raw.find(_PNG_MAGIC)  # 小米 HyperOS 会在前面注入 warning,切齐 PNG 头
        return raw[idx:] if idx > 0 else raw

    def tap(self, x: int, y: int) -> None:
        self._adb("shell", "input", "tap", str(x), str(y))

    def swipe(self, x1, y1, x2, y2, ms=300) -> None:
        self._adb("shell", "input", "swipe", str(x1), str(y1), str(x2), str(y2), str(ms))

    def key(self, code: str) -> None:
        self._adb("shell", "input", "keyevent", f"KEYCODE_{code}")

    def dump_nodes(self) -> list[dict]:
        remote = "/sdcard/ui_dump.xml"
        self._adb("shell", "uiautomator", "dump", remote)
        out = subprocess.run(self._base() + ["exec-out", "cat", remote], capture_output=True).stdout
        return _parse_ui_dump(out)

    def set_text(self, text: str) -> None:
        # 开发机走 ADBKeyboard base64 广播(中文/空格安全);生产由 App 无障碍 setText
        self._adb("shell", "ime", "set", "com.android.adbkeyboard/.AdbIME")
        b64 = base64.b64encode(text.encode("utf-8")).decode("ascii")
        self._adb("shell", "am", "broadcast", "-a", "ADB_INPUT_B64", "--es", "msg", b64)

    def set_clipboard(self, text: str) -> None:
        # dev 链路用不到:ADBKeyboard 的 set_text 对 Flutter 同样可写,不走剪贴板兜底
        raise NotImplementedError("AdbTransport 不支持 set_clipboard(dev 用 set_text 即可)")

    def ime_picker(self) -> None:
        pass  # dev:ADBKeyboard 已是 IME 注入,set_text 直写,无需切 IME

    def ime_commit(self, text: str) -> None:
        # dev:ADBKeyboard 本身就是 IME 注入,直接复用 set_text
        self.set_text(text)

    def ime_prefix(self, text: str) -> None:
        # dev:光标归行首后走 ADBKeyboard 插入
        self._adb("shell", "input", "keyevent", "KEYCODE_MOVE_HOME")
        self.set_text(text)

    def launch_app(self, pkg: str) -> None:
        self._adb("shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1")

    def force_stop(self, pkg: str) -> None:
        # 对齐 APK:正式包非 root 杀不了他应用,只能回主页降级。开发也不真 force-stop,
        # 否则流程会偷偷依赖「干净启动」,到正式包就靠不住(应改由「放弃草稿」分支兜底)。
        self._adb("shell", "input", "keyevent", "KEYCODE_HOME")

    def screen_size(self) -> tuple[int, int]:
        out = self._adb("shell", "wm", "size").stdout.decode("utf-8", "ignore")
        try:
            w, h = out.split(":")[-1].strip().split("x")
            return int(w), int(h)
        except Exception:
            return 1080, 2400

    def node_click(self, desc: str, index: int = 0) -> bool:
        # 开发机无 performAction:改用 uiautomator dump 按 content-desc 找节点、adb input tap 其中心。
        # (adb 的 input tap 是真实注入,闲鱼键盘接受;正式 APK 走无障碍 ACTION_CLICK。)
        remote = "/sdcard/ui_dump.xml"
        self._adb("shell", "uiautomator", "dump", remote)
        out = subprocess.run(self._base() + ["exec-out", "cat", remote], capture_output=True).stdout
        try:
            root = ET.fromstring(out)
        except ET.ParseError:
            return False
        hits = []
        for n in root.iter("node"):
            if n.get("content-desc", "") == desc and n.get("clickable") == "true":
                m = re.findall(r"\d+", n.get("bounds", ""))
                if len(m) == 4:
                    x1, y1, x2, y2 = map(int, m)
                    hits.append(((x1 + x2) // 2, (y1 + y2) // 2))
        hits.sort(key=lambda c: (c[1], c[0]))
        if len(hits) <= index:
            return False
        self.tap(*hits[index])
        return True

    def node_long_click(self, desc: str, index: int = 0) -> bool:
        # dev:adb input 的原地长滑是真实注入,Flutter 认这个长按(生产必须用语义 LONG_CLICK)
        nodes = [n for n in self.dump_nodes() if n.get("desc") == desc]
        nodes.sort(key=lambda n: (n["center"][1], n["center"][0]))
        if len(nodes) <= index:
            return False
        x, y = nodes[index]["center"]
        self.swipe(x, y, x, y, 800)
        return True

    # 开发机商品图落地目录(与 APK 的 DCIM/gc 对齐,便于 clear_media 按目录清)。
    _DEV_MEDIA_DIR = "/sdcard/DCIM/gc"

    def push_media(self, url: str) -> str | None:
        # 开发机:下载到本地再 adb push + 媒体扫描(生产由 App 直接下 OSS URL)。
        # 返回远端文件路径当 uri:供流程 _pushed_media 记账,收尾 clear_media 精确删。
        import tempfile
        import urllib.request
        fd, local = tempfile.mkstemp(suffix=".jpg")
        os.close(fd)
        try:
            urllib.request.urlretrieve(url, local)
            remote = f"{self._DEV_MEDIA_DIR}/gc_{int(time.time() * 1000)}_{os.path.basename(local)}"
            self._adb("shell", "mkdir", "-p", self._DEV_MEDIA_DIR)
            subprocess.run(self._base() + ["push", local, remote], capture_output=True)
            self._adb("shell", "am", "broadcast", "-a",
                      "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", f"file://{remote}")
            return remote
        finally:
            try:
                os.remove(local)
            except OSError:
                pass

    def clear_media(self, uris: list[str] | None = None) -> int:
        """删除开发机推入 DCIM/gc 的商品图(对齐 APK clear_media 语义,dev 路径也不串图)。
        传 uris(push_media 返回的远端路径)精确删;不传则清整个 DCIM/gc 目录。
        删后触发媒体库重扫,免相册残留缩略图仍被「选最新 N 张」选到。返回删除条数。"""
        paths = [u for u in (uris or self._list_dev_media()) if u]
        n = 0
        for p in paths:
            if self._adb("shell", "rm", "-f", p).returncode == 0:
                n += 1
        # 目录级重扫:删文件后让 MediaStore 同步,否则选图器可能仍显示已删项
        self._adb("shell", "am", "broadcast", "-a",
                  "android.intent.action.MEDIA_SCANNER_SCAN_FILE",
                  "-d", f"file://{self._DEV_MEDIA_DIR}")
        return n

    def _list_dev_media(self) -> list[str]:
        out = subprocess.run(self._base() + ["shell", "ls", self._DEV_MEDIA_DIR],
                             capture_output=True).stdout.decode("utf-8", "ignore")
        return [f"{self._DEV_MEDIA_DIR}/{ln.strip()}"
                for ln in out.splitlines()
                if ln.strip() and "No such file" not in ln]


class FlowTimeout(Exception):
    """流程级硬超时:流程线程超过 flow_hard_timeout_sec 仍在跑,强制退出。

    与 watchdog 收尸(DB 标记)互补:那个改状态杀不掉线程,这个让线程自己死。
    """


class MqttRpcTransport(Transport):
    """经 MQTT 原语 RPC 驱动远端手机(生产用)。

    Engine 在 worker 线程里同步调用;bridge.rpc 是 asyncio 协程,跑在主事件循环。
    用 run_coroutine_threadsafe 把协程投给主循环并阻塞取结果——线程边界干净,
    Engine/步骤代码保持同步、零改动(见 [[erp-async-task-pattern]] 有界线程池范式)。
    """

    def __init__(self, bridge, device_id: str, loop: asyncio.AbstractEventLoop, rpc_timeout: float = 15.0,
                 deadline: float | None = None):
        self.bridge = bridge
        self.device_id = device_id
        self.loop = loop
        self.rpc_timeout = rpc_timeout
        # monotonic 截止时间:每次发 RPC 前检查,超期抛 FlowTimeout。
        # 挂死设备上的流程会无限重试 RPC,这是让线程必然退出的兜底。
        self._deadline = deadline

    def _check_deadline(self, op: str) -> None:
        if self._deadline is not None and time.monotonic() > self._deadline:
            raise FlowTimeout(f"流程硬超时,于 {op} 处强制退出 device={self.device_id}")

    def _call(self, op: str, args: dict | None = None, timeout: float | None = None) -> dict:
        self._check_deadline(op)
        t = timeout or self.rpc_timeout
        fut = asyncio.run_coroutine_threadsafe(
            self.bridge.rpc(self.device_id, op, args, timeout=t), self.loop
        )
        return fut.result(timeout=t + 5)

    def screencap(self) -> bytes:
        # 截图是最重的原语：端上 takeScreenshot 撞系统频率限制时会退避重试(最坏 20s+)，
        # 目标 App 刚被 launch 起来那几秒尤其容易失败重试。默认 15s 预算不够，
        # 会把「端上正在重试」误判成「设备失联」，并且错误还会掩盖真正的失败步骤。
        data = self._call("screencap", timeout=SCREENCAP_TIMEOUT)
        return base64.b64decode(data["image_b64"])

    def tap(self, x: int, y: int) -> None:
        self._call("tap", {"x": x, "y": y})

    def swipe(self, x1, y1, x2, y2, ms=300) -> None:
        self._call("swipe", {"x1": x1, "y1": y1, "x2": x2, "y2": y2, "ms": ms})

    def key(self, code: str) -> None:
        self._call("key", {"code": code})

    def dump_nodes(self) -> list[dict]:
        data = self._call("dump_nodes")
        # App 端已返回统一结构(center/size 为二元组或 [x,y]);规整成元组
        out = []
        for n in data.get("nodes", []):
            c = n.get("center") or [n.get("cx", 0), n.get("cy", 0)]
            s = n.get("size") or [n.get("w", 0), n.get("h", 0)]
            node = {
                "desc": n.get("desc", ""), "cls": n.get("cls", ""),
                "clickable": bool(n.get("clickable")),
                "center": (int(c[0]), int(c[1])), "size": (int(s[0]), int(s[1])),
            }
            if n.get("src"):                    # 网页版 dump 的 img src(商品卡缩略图直取)
                node["src"] = n["src"]
            out.append(node)
        return out

    def set_text(self, text: str) -> None:
        self._call("set_text", {"text": text})

    def set_clipboard(self, text: str) -> None:
        self._call("set_clipboard", {"text": text})

    def ime_picker(self) -> None:
        self._call("ime_picker")

    def ime_commit(self, text: str) -> None:
        self._call("ime_commit", {"text": text}, timeout=20)  # 端内含等待 InputConnection 轮询

    def ime_prefix(self, text: str) -> None:
        self._call("ime_prefix", {"text": text}, timeout=20)

    def launch_app(self, pkg: str) -> None:
        self._call("launch_app", {"pkg": pkg})

    def force_stop(self, pkg: str) -> None:
        self._call("force_stop", {"pkg": pkg})

    def screen_size(self) -> tuple[int, int]:
        data = self._call("screen_size")
        return int(data.get("w", 1080)), int(data.get("h", 2400))

    def node_click(self, desc: str, index: int = 0) -> bool:
        try:
            self._call("node_click", {"desc": desc, "index": index})
            return True
        except Exception:
            return False

    def node_long_click(self, desc: str, index: int = 0) -> bool:
        try:
            self._call("node_long_click", {"desc": desc, "index": index})
            return True
        except Exception:
            return False

    def push_media(self, url: str) -> str | None:
        # 下载可能慢,给足超时
        data = self._call("push_media", {"url": url}, timeout=60)
        return (data or {}).get("uri")

    def clear_media(self, uris: list[str] | None = None) -> int:
        data = self._call("clear_media", {"uris": uris or []}, timeout=30)
        return int((data or {}).get("deleted") or 0)

    def set_input_files(self, paths: list[str], selector: str = "input[type=file]") -> int:
        """web 发布喂图:paths 是 push_media 在执行端下载的本地路径,透传给执行端
        upload_files 原语(对齐 LocalPlaywrightTransport.set_input_files 语义)。"""
        data = self._call("upload_files",
                          {"paths": list(paths), "selector": selector}, timeout=60)
        return int((data or {}).get("count") or 0)

    # ---- web 流程(tab 管理)扩展:goods_flows_web 点卡片开详情页新 tab 用 ----
    # 协议对齐 adspower-executor 的 op_wait_new_tab / op_activate_tab / op_current_url。
    def wait_new_tab(self, contains: str | None = None, timeout: float = 15.0) -> str:
        """等待点击后新开的 tab(按「URL 含 contains」识别,不靠 pages 顺序——
        上下文里可能混有用户其它 tab),激活并返回新 tab URL。超时 → RpcError。"""
        data = self._call("wait_new_tab",
                          {"contains": contains, "timeout": timeout},
                          timeout=timeout + 30)
        return (data or {}).get("url") or ""

    def activate_tab(self, contains: str) -> str:
        """按 URL 特征激活已存在的 tab,返回其 URL(不存在 → RpcError)。"""
        data = self._call("activate_tab", {"contains": contains}, timeout=30)
        return (data or {}).get("url") or ""

    def current_url(self) -> str:
        """当前激活 tab 的 URL(goods_flows_web 的身份/结果校验用)。"""
        data = self._call("current_url", timeout=15)
        return (data or {}).get("url") or ""

    @property
    def page(self):
        """goods_flows_web 用 t.page.url 读当前地址:shim 成属性访问即 RPC 取 current_url。

        只做 .url 一个属性(LocalPlaywrightTransport 的 page 是 Playwright Page;
        web 流程经 MQTT 只读 URL,不碰其它 Page 能力)。
        """
        transport = self

        class _PageShim:
            @property
            def url(self) -> str:
                return transport.current_url()

        return _PageShim()

    # ---- web 发布流程(publish_flow_web)扩展:JS 点击/填值/punish 探测 ----
    # 协议对齐 adspower-executor 的 op_fill_text / op_js_click_selector /
    # op_js_mouse_click / op_risk_punish_active / op_js_click_text。语义与
    # local_transport.LocalPlaywrightTransport 同名方法一致。
    def fill_text(self, selector: str, text: str) -> None:
        """整体填值(聚焦 + 全选替换,含 contenteditable)。端上走 CDP fill。"""
        self._call("fill_text", {"selector": selector, "text": text}, timeout=20)

    def js_click_selector(self, selector: str) -> int:
        """JS el.click() 点 selector 命中的第一个元素(穿透 tips-- 浮层)。返回 0/1。"""
        data = self._call("js_click_selector", {"selector": selector}, timeout=15)
        return int((data or {}).get("clicked") or 0)

    def js_mouse_click(self, selector: str) -> int:
        """JS 派发 mousedown/mouseup/click 序列(ant Select 靠 mousedown 开下拉)。返回 0/1。"""
        data = self._call("js_mouse_click", {"selector": selector}, timeout=15)
        return int((data or {}).get("clicked") or 0)

    def js_click_text(self, text: str, cls: str = "") -> int:
        """JS el.click() 点第一个 textContent 精确等于 text 的可视元素(cls 限定 class)。
        返回点击成功的元素数(0=没找到)。"""
        data = self._call("js_click_text", {"text": text, "cls": cls}, timeout=15)
        return int((data or {}).get("clicked") or 0)

    def risk_punish_active(self) -> str | None:
        """页面存在阿里 punish 滑块 iframe(URL 含 _____tmd_____ 或 /punish)时返回其
        src 片段,否则 None。publish_flow_web._check_risk 传 t 时额外探测。"""
        data = self._call("risk_punish_active", timeout=15)
        return (data or {}).get("src") or None

    def login_assist(self) -> str | None:
        """在页面每个 frame(含跨域登录 iframe)里找「保持登录状态」「快速进入」点一下。
        返回点到的按钮文字,没点到 None。老执行端没有这个原语时 RPC 报错(见 web/login.py)。"""
        data = self._call("login_assist", timeout=20)
        return (data or {}).get("clicked") or None

    def page_snapshot(self) -> dict:
        """工作页每个 frame 的 HTML:{url, frames: [{url, name, html, truncated?, error?}]}。
        老执行端没有这个原语时 RPC 报错(见 web/login.py)。"""
        data = self._call("page_snapshot", timeout=20) or {}
        frames = json.loads(gzip.decompress(base64.b64decode(data["gz_b64"])))
        return {"url": data.get("url") or "", "frames": frames}

    def reconnect_assist(self) -> dict:
        """检测「连接中断，请重连」弹窗：有则刷新页面再点「快速进入」。
        返回 {dialog: 是否检测到弹窗, clicked: 点到的按钮文字|null}。
        比 login_assist 慢(含整页刷新 + 等待渲染)，超时给足。老执行端没有这个
        原语时 RPC 报错(见 web/login.py)，由调用方当没救到处理。"""
        data = self._call("reconnect_assist", timeout=40)
        return data or {}

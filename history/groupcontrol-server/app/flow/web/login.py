"""网页版登录自救:页头读不到昵称时,先点闲鱼登录弹窗里的「保持登录状态」「快速进入」。

会话过期但浏览器还记着这个号时,闲鱼弹的登录框是「快速进入 t**2」,点一下就回来,不用人。
2026-10-08 现场:「洞穴Q弹的荆芥」就是这样被判掉登录、冻号,当天的上架全卡住。
B4.1 每次导航后都自动点这两个按钮;我们在判掉登录之前点:点到了就重开起始页再看,
还没有昵称才真判掉登录。

按钮在跨域的登录 iframe 里,dump_nodes 看不到,由执行端 login_assist 原语逐个 frame 去找。
老执行端没有这个原语,RPC 报错 → 当没点到,退回原来的判法。

还有一种点不到的形态(2026-10-10 现场,erp-txy gc-api 日志):/im 页挂着「连接中断，请重连」
弹窗(IM 长连接被掐断),登录卡片的「快速进入」被压在底下,login_assist 逐 frame 也什么都
点不到,直接 FAILED(网页版未登录(/im 无账号昵称))。reconnect_assist 原语刷新页面再点一次;
救回来就走与「快速进入」相同的重开 url → 重读节点 → 风控路径。
"""
from __future__ import annotations

import json
import logging
import time

from app import storage
from app.flow.transport import FlowTimeout
from app.flow.web.parse import find_login_nick

logger = logging.getLogger("gc.flow.web.login")

SETTLE_SEC = 4.0   # 点完等登录回跳、重开起始页后等渲染,和各流程开场的等待一致
RECOVER_ROUNDS = 3   # 点一次 + 刷新 + 再看,判掉登录前最多来几趟
DIAG_MIN_INTERVAL_SEC = 1800   # 同一台设备多久留一份失败现场:没救回来的号每几分钟就试一次
DIAG_MAX_NODES = 200

_diag_saved_at: dict[str, float] = {}


def login_assist(t) -> str | None:
    """让执行端点一次「保持登录状态」「快速进入」,返回点到的按钮文字;没点到/不支持返回 None。"""
    fn = getattr(t, "login_assist", None)
    if fn is None:
        return None
    try:
        return fn()
    except FlowTimeout:
        raise   # 整单超时照常收尸,别被自救吞掉
    except Exception as ex:
        logger.info("login_assist 不可用(执行端还是旧版?):%s", ex)
        return None


def reconnect_assist(t) -> dict | None:
    """让执行端检测并处置「连接中断，请重连」弹窗(刷新 + 点「快速进入」)。
    返回 {dialog, clicked};没弹窗/没点到/老执行端不支持返回 None(当没救到处理)。"""
    fn = getattr(t, "reconnect_assist", None)
    if fn is None:
        return None
    try:
        return fn()
    except FlowTimeout:
        raise   # 整单超时照常收尸,别被自救吞掉
    except Exception as ex:
        logger.info("reconnect_assist 不可用(执行端还是旧版?):%s", ex)
        return None


def _click_buttons(t) -> str | None:
    """点一次登录按钮。login_assist 点空不一定是真掉登录:可能是「连接中断，请重连」弹窗挂着
    把按钮压在底下(见模块 docstring),这时再让执行端刷新页面点一次。"""
    clicked = login_assist(t)
    if clicked:
        return clicked
    rescued = reconnect_assist(t)
    if rescued and rescued.get("dialog") and rescued.get("clicked"):
        logger.info("检测到「连接中断」弹窗，已刷新并点了「%s」", rescued["clicked"])
        return rescued["clicked"]
    return None


class _FailureDiag:
    """自救失败的现场:每趟的截图、每个 frame 的 HTML、点到了什么。救回来就丢掉,没救回来才上传,
    清单的 key 记到 t.login_diag(runner 写进 task.result)。"""

    def __init__(self, t):
        self.t = t
        self.device_id = getattr(t, "device_id", None)
        last = _diag_saved_at.get(self.device_id or "")
        self.enabled = bool(self.device_id) and (not last or time.time() - last >= DIAG_MIN_INTERVAL_SEC)
        self.rounds: list[dict] = []

    def capture(self, stage: str, nodes: list[dict]) -> None:
        if not self.enabled:
            return
        item: dict = {"stage": stage, "at": int(time.time())}
        try:
            item["shot"] = self.t.screencap()
        except FlowTimeout:
            raise
        except Exception as ex:
            item["shot_error"] = str(ex)[:200]
        try:
            item["snapshot"] = self.t.page_snapshot()
        except FlowTimeout:
            raise
        except Exception as ex:   # 老执行端没有这个原语:至少留节点
            item["html_error"] = str(ex)[:200]
            item["nodes"] = [{k: n.get(k) for k in ("desc", "cls", "cy")} for n in nodes[:DIAG_MAX_NODES]]
        self.rounds.append(item)

    def clicked(self, button: str | None) -> None:
        if self.enabled and self.rounds:
            self.rounds[-1]["clicked"] = button

    def save(self, url: str) -> None:
        if not self.enabled or not self.rounds:
            return
        try:
            tag = f"login_diag_{self.device_id[:8]}"
            manifest = {"device_id": self.device_id, "url": url, "rounds": []}
            for i, item in enumerate(self.rounds, 1):
                row = {k: v for k, v in item.items() if k not in ("shot", "snapshot")}
                if item.get("shot"):
                    row["shot"] = storage.save_blob(f"{tag}_{i}", item["shot"], "jpg")
                snap = item.get("snapshot")
                if snap:
                    row["page_url"] = snap.get("url")
                    row["frames"] = [{k: f.get(k) for k in ("url", "name", "truncated", "error")}
                                     for f in snap.get("frames") or []]
                    row["html"] = storage.save_blob(f"{tag}_{i}", _bundle_html(snap).encode(), "html")
                manifest["rounds"].append(row)
            key = storage.save_blob(tag, json.dumps(manifest, ensure_ascii=False, indent=1).encode(), "json")
            self.t.login_diag = key
            _diag_saved_at[self.device_id] = time.time()
            logger.warning("登录自救失败,现场已留档 device=%s %s", self.device_id, key)
        except Exception:
            logger.exception("登录自救失败现场留档出错 device=%s", self.device_id)


def _bundle_html(snap: dict) -> str:
    parts = []
    for f in snap.get("frames") or []:
        note = f.get("error") or ("已截断" if f.get("truncated") else "")
        parts.append(f"<!-- ===== frame {f.get('url')} name={f.get('name')!r} {note} ===== -->\n{f.get('html') or ''}")
    return "\n".join(parts)


def recover_login(t, url: str, flat, check_risk) -> list[dict] | None:
    """页头没昵称时的自救,手法照人工:再看一眼 → 点「快速进入」→ 刷新 → 再看,来回最多
    RECOVER_ROUNDS 趟。读到昵称返回新节点;全程都没读到才返回 None,调用方判掉登录。

    2026-10-30 现场:杨梅、藿香被判掉登录时,截图里页头昵称就在——一次 dump 没读到、又没按钮
    可点就判了。所以先等一下原地重读;没点到按钮也要刷新再看(登录卡片可能还没出来)。

    flat / check_risk 用调用方流程自己的那一份(各流程的节点扁平化与风控判据略有不同)。
    """
    _, h = t.screen_size()

    def read():
        nodes = flat(t.dump_nodes())
        check_risk(nodes)
        return nodes

    time.sleep(SETTLE_SEC)
    nodes = read()
    if find_login_nick(nodes, h):
        logger.info("页头昵称晚到,没掉登录: %s", url)
        return nodes
    diag = _FailureDiag(t)
    for attempt in range(1, RECOVER_ROUNDS + 1):
        diag.capture(f"第{attempt}趟点之前", nodes)
        clicked = _click_buttons(t)
        diag.clicked(clicked)
        logger.info("登录自救第 %d 趟:点到「%s」,重开 %s 再看", attempt, clicked or "无", url)
        time.sleep(SETTLE_SEC)
        t.launch_app(url)
        for _ in range(2):   # 页面慢的时候昵称要晚几秒才出来
            time.sleep(SETTLE_SEC)
            nodes = read()
            if find_login_nick(nodes, h):
                return nodes
    diag.capture("全部趟数之后", nodes)
    diag.save(url)
    return None

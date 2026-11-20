"""任务回放:把动作留痕(每个动作 + 动作后的截图)整理成后台能逐步看的样子。

留痕由 flow/trace.py 写:每个动作原语一条 {seq, ts, action, args, ms, shot[, error, shot_error]},
截图在动作执行完**当场**传 OSS;任务结束再把整份记录写成 actions.json(key 在 result.trace_key)。
所以跑着的任务读内存里的记录——走到哪一步就看到哪一步,截图也已经在了;跑完的读 actions.json。
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone

from app import storage
from app.flow.trace import live_records
from app.models import Task, TaskStatus

logger = logging.getLogger("gc.replay")

SHOT_URL_TTL = 1800   # 截图直链 30 分钟;过期了重新打开回放就是新链接
THUMB_WIDTH = 360     # 步骤列表里的缩略图宽,点开看原图

# 以前 push_media 记的是链接末尾 60 个字符,截到的恰好全是签名参数——不能原样吐给前端
_SIGNED_ARGS = re.compile(r"(Signature|OSSAccessKeyId|xpires|security-token)=", re.I)


def _epoch(dt: datetime | None) -> float | None:
    # 库里的时间都是 datetime.utcnow() 写的(无时区)
    return dt.replace(tzinfo=timezone.utc).timestamp() if dt else None


def _clean_args(args) -> str:
    text = "" if args is None else str(args)
    return "(图片链接)" if _SIGNED_ARGS.search(text) else text


def _step(rec: dict, t0: float | None) -> dict:
    shot = rec.get("shot")
    ts = rec.get("ts")
    at = round(ts - t0, 1) if isinstance(ts, (int, float)) and t0 is not None else None
    return {
        "seq": rec.get("seq"),
        "at": at,
        "action": rec.get("action") or "",
        "args": _clean_args(rec.get("args")),
        "ms": rec.get("ms"),
        "error": rec.get("error"),
        "shot_url": storage.signed_url(shot, SHOT_URL_TTL),
        "thumb_url": storage.signed_url(shot, SHOT_URL_TTL, width=THUMB_WIDTH),
        "shot_error": rec.get("shot_error"),
    }


def _stored_records(task: Task) -> tuple[list[dict] | None, str | None]:
    key = (task.result or {}).get("trace_key")
    if not key:
        return None, None
    raw = storage.load_blob(key)
    try:
        records = json.loads(raw.decode("utf-8")).get("records") if raw else None
    except Exception:
        logger.warning("留痕文件解析失败 task=%s key=%s", task.id, key, exc_info=True)
        records = None
    return (records, None) if isinstance(records, list) else (None, "留痕文件读不到了")


def build_replay(task: Task) -> dict:
    live = live_records(task.id) if task.status == TaskStatus.RUNNING else None
    if live is not None:
        records, note = live, None
    else:
        records, note = _stored_records(task)
        if records is None and note is None:
            note = ("还没开始跑" if task.status in (TaskStatus.PENDING, TaskStatus.DISPATCHED)
                    else "这单没有留痕")
    records = sorted(records or [], key=lambda r: r.get("seq") or 0)
    # 时间从任务开跑算;老数据没有 started_at 就从第一个动作算
    t0 = _epoch(task.started_at) or _epoch(task.dispatched_at)
    if t0 is None and records and isinstance(records[0].get("ts"), (int, float)):
        t0 = records[0]["ts"]
    return {
        "task_id": task.id,
        "status": task.status,
        "live": live is not None,
        "steps": [_step(r, t0) for r in records],
        "result_shot_url": storage.signed_url(task.shot_key, SHOT_URL_TTL),
        "result_thumb_url": storage.signed_url(task.shot_key, SHOT_URL_TTL, width=THUMB_WIDTH),
        "note": note,
    }

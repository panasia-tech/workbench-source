"""闲鱼消息响应考核：新买家消息推给负责人，超时没看提醒本人，超时没回通知管理员，按人统计响应时长。

一轮 = ChatSla：买家发了、我们还没回就开一轮（扫描入库后看会话最后一条是不是买家的），回了就结束。
- 推送和考核对象是闲鱼号的负责员工（AccountOwner，后台指定）；没指定负责人的号只在超时时通知管理员。
- 通知经 ERP 的本机内部接口发（/api/internal/staff-notify：钉钉优先、企微兜底，按员工发）。
- 计时扣掉夜间不考核时段（默认 23:00–09:00，北京时间）；这段时间里也不推送，早上 9 点接着算。
- 闲鱼端「已读」是机器人造成的，不算员工看过；兜底自动回复不算员工处理。
"""
from __future__ import annotations

import json
import logging
import urllib.request
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.chat_autoreply import last_message
from app.config import settings
from app.models import Account, AccountOwner, ChatSla, Conversation, GcSetting

logger = logging.getLogger(__name__)

CN = timedelta(hours=8)
# 买家消息入库超过这么久才扫到的不开轮：上线/停机重启时库里几百个历史会话最后一条是买家的，不能一下全推给管理员
FRESH_WINDOW = timedelta(minutes=30)

DEFAULTS = {
    "chat_sla_enabled": "1",
    "chat_sla_read_min": "5",       # 几分钟没看提醒负责人
    "chat_sla_reply_min": "15",     # 几分钟没回通知管理员
    "chat_sla_quiet": "23-9",       # 夜间不考核、不推送（北京时间，起-止点钟）
}
CHAT_URL = "http://127.0.0.1:8000"


# ---------------------------------------------------------------- 设置

def get_conf(db: Session) -> dict:
    rows = {r.key: r.value for r in db.query(GcSetting).filter(GcSetting.key.in_(DEFAULTS)).all()}
    raw = {k: rows.get(k, v) for k, v in DEFAULTS.items()}
    try:
        qs, qe = (int(x) for x in raw["chat_sla_quiet"].split("-"))
    except ValueError:
        qs, qe = 23, 9
    return {
        "enabled": raw["chat_sla_enabled"] == "1",
        "read_min": max(1, int(raw["chat_sla_read_min"] or 5)),
        "reply_min": max(1, int(raw["chat_sla_reply_min"] or 15)),
        "quiet_start": qs % 24,
        "quiet_end": qe % 24,
    }


def set_conf(db: Session, data: dict, by: str | None) -> dict:
    if "read_min" in data and "reply_min" in data and int(data["read_min"]) > int(data["reply_min"]):
        raise ValueError("提醒负责人的时限要早于通知管理员的时限")
    values = {
        "chat_sla_enabled": ("1" if data["enabled"] else "0") if "enabled" in data else None,
        "chat_sla_read_min": str(int(data["read_min"])) if "read_min" in data else None,
        "chat_sla_reply_min": str(int(data["reply_min"])) if "reply_min" in data else None,
        "chat_sla_quiet": f"{int(data['quiet_start']) % 24}-{int(data['quiet_end']) % 24}"
        if "quiet_start" in data and "quiet_end" in data else None,
    }
    for key, value in values.items():
        if value is None:
            continue
        row = db.get(GcSetting, key)
        if row is None:
            db.add(GcSetting(key=key, value=value, updated_by=by))
        else:
            row.value, row.updated_by = value, by
    db.commit()
    return get_conf(db)


# ---------------------------------------------------------------- 计时

def _quiet(hour: int, conf: dict) -> bool:
    s, e = conf["quiet_start"], conf["quiet_end"]
    if s == e:
        return False
    return s <= hour or hour < e if s > e else s <= hour < e


def in_quiet(now: datetime, conf: dict) -> bool:
    return _quiet((now + CN).hour, conf)


def effective_seconds(start: datetime, end: datetime, conf: dict) -> float:
    """start→end 之间扣掉夜间不考核时段后的秒数（按北京时间整点分段算）。"""
    if end <= start:
        return 0.0
    total = 0.0
    t = start
    while t < end:
        nxt = min(end, (t + CN).replace(minute=0, second=0, microsecond=0) - CN + timedelta(hours=1))
        if not _quiet((t + CN).hour, conf):
            total += (nxt - t).total_seconds()
        t = nxt
    return total


# ---------------------------------------------------------------- 开轮 / 看 / 回

def open_cycle(db: Session, conversation_id: str) -> ChatSla | None:
    return (
        db.query(ChatSla)
        .filter(ChatSla.conversation_id == conversation_id, ChatSla.closed_at.is_(None))
        .first()
    )


def track_after_scan(db: Session, conversations: list[Conversation], now: datetime | None = None) -> None:
    """扫描入库后：最后一条是买家的（且是最近 30 分钟内的）、又没有在计的轮次 → 开一轮；最后一条是我们的 → 结束（闲鱼端回的）。"""
    now = now or datetime.utcnow()
    for conv in conversations:
        last = last_message(db, conv.id)
        if last is None:
            continue
        cycle = open_cycle(db, conv.id)
        if last.direction == "in" and cycle is None:
            if last.created_at and last.created_at < now - FRESH_WINDOW:
                continue
            db.add(ChatSla(conversation_id=conv.id, account_id=conv.account_id, await_since=now))
        elif last.direction == "out" and cycle is not None:
            cycle.replied_at = cycle.replied_at or now
            cycle.replied_via = cycle.replied_via or "XIANYU"
            cycle.closed_at = now
    db.flush()  # 会话可能关了 autoflush，接着的看/回要查得到这一轮


def on_staff_reply(db: Session, conversation_id: str, staff_id: str | None, staff_name: str | None,
                   now: datetime | None = None) -> None:
    """员工从我们的系统回复发出成功（兜底自动回复不调这里）。"""
    cycle = open_cycle(db, conversation_id)
    if cycle is None:
        return
    now = now or datetime.utcnow()
    cycle.replied_at, cycle.replied_by, cycle.replied_by_name, cycle.replied_via = now, staff_id, staff_name, "APP"
    cycle.closed_at = now
    # 回了自然算看过
    if cycle.read_at is None:
        cycle.read_at, cycle.read_by, cycle.read_by_name = now, staff_id, staff_name


def on_staff_read(db: Session, conversation_id: str, staff_id: str | None, staff_name: str | None,
                  now: datetime | None = None) -> None:
    cycle = open_cycle(db, conversation_id)
    if cycle is not None and cycle.read_at is None:
        cycle.read_at, cycle.read_by, cycle.read_by_name = now or datetime.utcnow(), staff_id, staff_name


# ---------------------------------------------------------------- 推送 / 提醒 / 升级

def owners_of(db: Session, account_id: str) -> list[AccountOwner]:
    return db.query(AccountOwner).filter(AccountOwner.account_id == account_id).all()


def erp_notify(payload: dict) -> tuple[bool, str]:
    """经 ERP 本机内部接口发通知。ERP 不可达只记日志，不影响考核记账。"""
    url = settings.erp_internal_base.rstrip("/") + "/api/internal/staff-notify"
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read().decode("utf-8") or "{}")
        return True, json.dumps(body.get("results") or body, ensure_ascii=False)[:200]
    except Exception as exc:  # noqa: BLE001
        logger.warning("ERP 通知接口调不通：%s", exc)
        return False, str(exc)[:200]


def _describe(db: Session, cycle: ChatSla) -> tuple[str, str]:
    conv = db.get(Conversation, cycle.conversation_id)
    acc = db.get(Account, cycle.account_id) if cycle.account_id else None
    acc_label = (acc.nick if acc else None) or (cycle.account_id or "")[:8]
    buyer = (conv.peer_nick or conv.peer_key) if conv else "买家"
    item = f"\n商品：{conv.item_title}" + (f"（¥{conv.item_price}）" if conv.item_price else "") if conv and conv.item_title else ""
    text = (conv.last_message or "").replace("\n", " ")[:60] if conv else ""
    return acc_label, f"号：{acc_label}　买家：{buyer}{item}\n「{text}」"


def run_pass(db: Session, now: datetime | None = None, notify=None) -> dict:
    """每 30 秒一轮。每轮次的推送、提醒、升级各只发一次。"""
    now = now or datetime.utcnow()
    conf = get_conf(db)
    stats = {"notified": 0, "reminded": 0, "escalated": 0}
    if not conf["enabled"] or in_quiet(now, conf):
        return stats
    notify = notify or erp_notify
    for cycle in db.query(ChatSla).filter(ChatSla.closed_at.is_(None)).order_by(ChatSla.await_since).limit(500).all():
        owners = owners_of(db, cycle.account_id)
        staff_ids = [o.staff_id for o in owners]
        acc_label, desc = _describe(db, cycle)
        url = CHAT_URL.format(id=cycle.conversation_id)
        elapsed = effective_seconds(cycle.await_since, now, conf)
        if cycle.notified_at is None:
            if staff_ids:
                notify({"staff_ids": staff_ids, "title": f"闲鱼新消息 · {acc_label}", "body": desc, "url": url, "button": "去回复"})
                stats["notified"] += 1
            cycle.notified_at = now
        if cycle.read_at is None and cycle.reminded_at is None and elapsed >= conf["read_min"] * 60:
            if staff_ids:
                notify({"staff_ids": staff_ids, "title": f"买家消息 {conf['read_min']} 分钟没人看",
                        "body": desc, "url": url, "button": "去回复"})
                stats["reminded"] += 1
            cycle.reminded_at = now
        if cycle.escalated_at is None and elapsed >= conf["reply_min"] * 60:
            names = "、".join(o.staff_name or o.staff_id[:6] for o in owners) or "这个号还没指定负责人"
            notify({"admins": True, "title": f"买家消息 {conf['reply_min']} 分钟没回",
                    "body": f"{desc}\n负责人：{names}" + ("（已看未回）" if cycle.read_at else "（没人看）"), "url": url, "button": "去看看"})
            cycle.escalated_at = now
            stats["escalated"] += 1
    db.commit()
    return stats


# ---------------------------------------------------------------- 统计

def staff_stats(db: Session, start: datetime, end: datetime) -> dict:
    """[start, end) 内开始等待的轮次，按负责人统计：收到几轮、平均多久看、多久回、超时几次。"""
    conf = get_conf(db)
    cycles = db.query(ChatSla).filter(ChatSla.await_since >= start, ChatSla.await_since < end).all()
    owners: dict[str, list[AccountOwner]] = {}
    for o in db.query(AccountOwner).all():
        owners.setdefault(o.account_id, []).append(o)
    per: dict[str, dict] = {}

    def bucket(key: str, name: str) -> dict:
        return per.setdefault(key, {"staff_id": key, "name": name, "cycles": 0, "read": 0, "replied": 0,
                                    "read_secs": [], "reply_secs": [], "late_read": 0, "late_reply": 0, "open": 0})

    for c in cycles:
        targets = owners.get(c.account_id) or []
        keys = [(o.staff_id, o.staff_name or o.staff_id[:6]) for o in targets] or [("", "未指定负责人")]
        for key, name in keys:
            b = bucket(key, name)
            b["cycles"] += 1
            if c.read_at:
                b["read"] += 1
                b["read_secs"].append(effective_seconds(c.await_since, c.read_at, conf))
            if c.replied_at:
                b["replied"] += 1
                b["reply_secs"].append(effective_seconds(c.await_since, c.replied_at, conf))
            if c.reminded_at:
                b["late_read"] += 1
            if c.escalated_at:
                b["late_reply"] += 1
            if c.closed_at is None:
                b["open"] += 1
    out = []
    for b in per.values():
        avg = lambda xs: round(sum(xs) / len(xs)) if xs else None  # noqa: E731
        out.append({k: v for k, v in b.items() if not k.endswith("_secs")}
                   | {"avg_read_sec": avg(b["read_secs"]), "avg_reply_sec": avg(b["reply_secs"])})
    out.sort(key=lambda x: (-x["cycles"], x["name"]))
    return {"conf": conf, "items": out, "total_cycles": len(cycles)}

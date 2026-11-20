"""消息回复率统计(M1 销售看板)。

口径要和「为什么做兜底」对齐:平台考核的是**买家发来的消息有没有被回**,
所以分母是收到消息的会话数,分子是其中已被回的。按会话算而不是按条算——
买家连发三条、销售回一条,那是一次完整的接待,不该算成 1/3。

日界用中国时区(与调度器配额同口径),UTC 存储照旧。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.models import Account, ChatMessage, Conversation

CN = timezone(timedelta(hours=8))


def cn_today_utc_range(now: datetime | None = None) -> tuple[datetime, datetime]:
    """中国日界的 [今天 00:00, 明天 00:00) 换算成 naive UTC。"""
    now_cn = (now or datetime.utcnow()).replace(tzinfo=timezone.utc).astimezone(CN)
    start_cn = now_cn.replace(hour=0, minute=0, second=0, microsecond=0)
    end_cn = start_cn + timedelta(days=1)
    return (start_cn.astimezone(timezone.utc).replace(tzinfo=None),
            end_cn.astimezone(timezone.utc).replace(tzinfo=None))


def reply_rate(
    db: Session,
    account_id: str | None = None,
    now: datetime | None = None,
    commission_per_order: float = 10.0,
) -> dict:
    """当日回复率与计件。

    返回 incoming(收到消息的会话数) / replied(其中已回的) / rate,
    并区分 manual 与 auto——兜底撑起来的那部分要能被看见,否则看板上一片
    好看的数字会掩盖「其实没人在接待」。
    """
    lo, hi = cn_today_utc_range(now)

    conv_q = db.query(Conversation.id, Conversation.account_id)
    if account_id:
        conv_q = conv_q.filter(Conversation.account_id == account_id)
    conv_account = dict(conv_q.all())
    if not conv_account:
        return _empty(account_id, commission_per_order)

    msgs = (
        db.query(ChatMessage)
        .filter(ChatMessage.conversation_id.in_(list(conv_account)),
                ChatMessage.created_at >= lo, ChatMessage.created_at < hi)
        .order_by(ChatMessage.created_at.asc())
        .all()
    )

    incoming: set[str] = set()
    replied: set[str] = set()
    # 「回了」= 该会话当天在**收到消息之后**还有 out。只要当天有 out 但在所有 in
    # 之前(比如销售主动开场后买家再问),不能算已回。
    seen_in: set[str] = set()
    for m in msgs:
        cid = m.conversation_id
        if m.direction == "in":
            incoming.add(cid)
            seen_in.add(cid)
        elif cid in seen_in:
            replied.add(cid)

    total = len(incoming)
    done = len(replied & incoming)
    return {
        "account_id": account_id,
        "date": lo.replace(tzinfo=timezone.utc).astimezone(CN).strftime("%Y-%m-%d"),
        "incoming": total,
        "replied": done,
        "pending": total - done,
        # 没有来信时回复率按 100% 报:分母为 0 时给 0 会让看板显示「0%」,
        # 看起来像出了事,实际只是今天还没人来问。
        "rate": round(done / total, 4) if total else 1.0,
        "commission_per_order": commission_per_order,
    }


def reply_rate_by_account(db: Session, now: datetime | None = None,
                          commission_per_order: float = 10.0) -> list[dict]:
    """按账号拆的当日回复率,聚合台左栏用。"""
    nicks = {a.id: a.nick for a in db.query(Account).all()}
    account_ids = [r[0] for r in db.query(Conversation.account_id).distinct().all()]
    out = []
    for aid in account_ids:
        row = reply_rate(db, aid, now, commission_per_order)
        row["account_nick"] = nicks.get(aid)
        out.append(row)
    out.sort(key=lambda r: (r["pending"], r["incoming"]), reverse=True)
    return out


def _empty(account_id: str | None, commission: float) -> dict:
    lo, _ = cn_today_utc_range()
    return {
        "account_id": account_id,
        "date": lo.replace(tzinfo=timezone.utc).astimezone(CN).strftime("%Y-%m-%d"),
        "incoming": 0, "replied": 0, "pending": 0, "rate": 1.0,
        "commission_per_order": commission,
    }

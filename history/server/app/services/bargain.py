"""采购议价状态机（W07 / PC-088 / PC-091）。

状态：IDENTIFY → QUOTE → COUNTER → DEAL；暂停请求 PAUSING → 确认后 PAUSED / CLOSED。
动作：identify / quote / counter / deal / pause_request / pause_confirm / resume / close
（pause 兼容别名：活跃态=请求，PAUSING=确认）
"""
from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.bargain import BARGAIN_STATES, CHECK_STATUSES, BargainSession

# PC-090 开聊时种下的必要问题（二手数码采购通用）
DEFAULT_CHECKS: list[dict] = [
    {"key": "model", "title": "型号/配置是否与页面一致", "required": True},
    {"key": "condition", "title": "成色与使用痕迹", "required": True},
    {"key": "accessories", "title": "配件是否齐全", "required": True},
    {"key": "function", "title": "功能是否正常", "required": True},
    {"key": "repair", "title": "有无维修/进水/换件", "required": True},
    {"key": "shipping", "title": "运费谁出、能否包邮", "required": False},
    {"key": "price_basis", "title": "价格含什么（保修/发票）", "required": False},
]


def seed_checks() -> list[dict]:
    return [
        {
            "key": c["key"],
            "title": c["title"],
            "required": bool(c["required"]),
            "status": "PENDING",
            "note": None,
            "updated_at": None,
            "by": None,
        }
        for c in DEFAULT_CHECKS
    ]


def checks_of(row: BargainSession) -> list[dict]:
    """只读：有则返回，无则给默认清单（不落库）。"""
    return list(row.checks) if row.checks else seed_checks()


def ensure_checks(row: BargainSession) -> list[dict]:
    """写路径：老会话没有 checks 时补种一份。

    每项都拷一份新的：直接改原来那个 dict，SQLAlchemy 比新旧值时两边是同一个对象，判成没变就不写这一列。
    """
    if not row.checks:
        row.checks = seed_checks()
    return [dict(c) for c in row.checks]


def pending_required(row: BargainSession) -> list[dict]:
    return [c for c in checks_of(row) if c.get("required") and c.get("status") == "PENDING"]


def askable_checks(row: BargainSession) -> list[dict]:
    """还可追问的问题：待核；已声明/已核/跳过的不再问（PC-089）。"""
    return [c for c in checks_of(row) if c.get("status") == "PENDING"]


def update_check(
    row: BargainSession,
    *,
    key: str,
    status: str,
    note: str | None = None,
    user_id: str | None = None,
) -> BargainSession:
    status = (status or "").strip().upper()
    if status not in CHECK_STATUSES:
        raise HTTPException(status_code=400, detail=f"状态「{status}」不支持")
    if row.state in ("DEAL", "CLOSED"):
        raise HTTPException(status_code=400, detail=f"「{row.state}」不能再改必要问题")
    key = (key or "").strip()
    checks = ensure_checks(row)
    found = None
    for c in checks:
        if c.get("key") == key:
            found = c
            break
    if found is None:
        raise HTTPException(status_code=404, detail=f"没有这个问题「{key}」")
    found["status"] = status
    found["note"] = (note or "").strip() or None
    found["updated_at"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    found["by"] = user_id
    row.checks = checks
    _append_event(
        row, action=f"check:{status.lower()}", from_state=row.state, to_state=row.state,
        price=None, user_id=user_id, note=f"{found.get('title')}: {found.get('note') or status}",
    )
    return row


# from_state → allowed actions
_TRANSITIONS: dict[str, set[str]] = {
    # 识别后可直接谈妥（线下已谈好、建单时确认）
    "IDENTIFY": {"identify", "quote", "deal", "pause_request", "pause", "close"},
    "QUOTE": {"quote", "counter", "deal", "pause_request", "pause", "close"},
    "COUNTER": {"quote", "counter", "deal", "pause_request", "pause", "close"},
    "DEAL": set(),  # 谈妥后冻结；绑采购单另走 bind
    "PAUSING": {"pause_confirm", "pause", "resume", "close"},
    "PAUSED": {"resume", "close"},
    "CLOSED": set(),
}

_ACTION_TO_STATE = {
    "identify": "IDENTIFY",
    "quote": "QUOTE",
    "counter": "COUNTER",
    "deal": "DEAL",
    "pause_request": "PAUSING",
    "pause_confirm": "PAUSED",
    "pause": "PAUSED",  # 实际目标由 transition 按当前态改写
    "close": "CLOSED",
}


def _money(v) -> Decimal | None:
    if v is None or v == "":
        return None
    try:
        return Decimal(str(v)).quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError) as exc:
        raise HTTPException(status_code=400, detail="价格格式不正确") from exc


def _append_event(row: BargainSession, *, action: str, from_state: str, to_state: str,
                  price: Decimal | None, user_id: str | None, note: str | None) -> None:
    events = list(row.events or [])
    events.append({
        "at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "action": action,
        "from": from_state,
        "to": to_state,
        "price": str(price) if price is not None else None,
        "by": user_id,
        "note": (note or "").strip() or None,
        "round": row.round_no,
    })
    row.events = events[-100:]  # 防无限胀


def open_session(
    db: Session,
    *,
    user_id: str | None,
    platform: str = "xianyu",
    platform_item_id: str | None = None,
    source_url: str | None = None,
    purchase_account: str | None = None,
    seller_name: str | None = None,
    gc_conversation_id: str | None = None,
    snapshot_id: str | None = None,
    listed_price=None,
    title: str | None = None,
    note: str | None = None,
) -> BargainSession:
    """开聊：同一账号+商品若有未结束会话则复用。"""
    item = (platform_item_id or "").strip() or None
    account = (purchase_account or "").strip() or None
    gc_id = (gc_conversation_id or "").strip()[:36] or None
    if item:
        # 列表页「开聊」只填商品 ID、不带账号：原来要商品和账号都有才复用，同一件商品每点一次就新建一条
        existing = (
            db.query(BargainSession)
            .filter(
                BargainSession.platform_item_id == item,
                (BargainSession.purchase_account == account) if account else BargainSession.purchase_account.is_(None),
                BargainSession.state.notin_(("DEAL", "CLOSED")),
            )
            .order_by(BargainSession.created_at.desc())
            .first()
        )
        if existing:
            # 群控回绑 / 补全缺字段（不覆盖已有值）
            if gc_id and not existing.gc_conversation_id:
                existing.gc_conversation_id = gc_id
            if source_url and not existing.source_url:
                existing.source_url = (source_url or "").strip()[:1024] or None
            if seller_name and not existing.seller_name:
                existing.seller_name = (seller_name or "").strip()[:128] or None
            if title and not existing.title:
                existing.title = (title or "").strip()[:512] or None
            if listed_price is not None and existing.listed_price is None:
                existing.listed_price = _money(listed_price)
            if snapshot_id and not existing.snapshot_id:
                existing.snapshot_id = snapshot_id
            return existing
    # 仅有群控会话时：复用同会话未结束议价
    if gc_id:
        by_gc = (
            db.query(BargainSession)
            .filter(
                BargainSession.gc_conversation_id == gc_id,
                BargainSession.state.notin_(("DEAL", "CLOSED")),
            )
            .order_by(BargainSession.created_at.desc())
            .first()
        )
        if by_gc:
            if item and not by_gc.platform_item_id:
                by_gc.platform_item_id = item[:64]
            if account and not by_gc.purchase_account:
                by_gc.purchase_account = account[:64]
            if source_url and not by_gc.source_url:
                by_gc.source_url = (source_url or "").strip()[:1024] or None
            if seller_name and not by_gc.seller_name:
                by_gc.seller_name = (seller_name or "").strip()[:128] or None
            if title and not by_gc.title:
                by_gc.title = (title or "").strip()[:512] or None
            if listed_price is not None and by_gc.listed_price is None:
                by_gc.listed_price = _money(listed_price)
            return by_gc
    now = datetime.utcnow()
    row = BargainSession(
        platform=(platform or "xianyu")[:32],
        platform_item_id=item[:64] if item else None,
        source_url=(source_url or "").strip()[:1024] or None,
        purchase_account=account[:64] if account else None,
        seller_name=(seller_name or "").strip()[:128] or None,
        gc_conversation_id=gc_id,
        snapshot_id=snapshot_id,
        state="IDENTIFY",
        listed_price=_money(listed_price),
        title=(title or "").strip()[:512] or None,
        note=(note or "").strip() or None,
        events=[],
        checks=seed_checks(),
        identified_at=now,
        created_by_id=user_id,
        assignee_id=user_id,
    )
    db.add(row)
    db.flush()
    _append_event(row, action="identify", from_state="IDENTIFY", to_state="IDENTIFY",
                  price=row.listed_price, user_id=user_id, note=note)
    return row


def transition(
    db: Session,
    row: BargainSession,
    *,
    action: str,
    price=None,
    note: str | None = None,
    user_id: str | None = None,
) -> BargainSession:
    action = (action or "").strip().lower()
    if action not in _ACTION_TO_STATE and action != "resume":
        raise HTTPException(status_code=400, detail=f"动作「{action}」不支持")
    if row.state not in BARGAIN_STATES:
        raise HTTPException(status_code=400, detail=f"状态「{row.state}」异常")
    allowed = _TRANSITIONS.get(row.state, set())
    if action not in allowed:
        raise HTTPException(status_code=400, detail=f"「{row.state}」不能「{action}」")

    from_state = row.state
    amount = _money(price)
    now = datetime.utcnow()

    if action == "resume":
        if not row.paused_from:
            raise HTTPException(status_code=400, detail="没有可恢复的状态")
        to_state = row.paused_from
        row.state = to_state
        row.paused_from = None
        row.paused_at = None
        _append_event(row, action=action, from_state=from_state, to_state=to_state,
                      price=None, user_id=user_id, note=note)
        return row

    # PC-091：pause 别名——活跃态=请求暂停，PAUSING=确认暂停
    if action == "pause":
        action = "pause_confirm" if from_state == "PAUSING" else "pause_request"

    to_state = _ACTION_TO_STATE[action]
    if action in ("quote", "counter", "deal") and amount is None:
        raise HTTPException(status_code=400, detail="报价/还价/谈妥要带价格")

    if action == "quote":
        row.our_price = amount
        row.quoted_at = now
        row.round_no = (row.round_no or 0) + 1
    elif action == "counter":
        row.their_price = amount
        row.round_no = (row.round_no or 0) + 1
    elif action == "deal":
        # PC-090：必核问题还是 PENDING 不能谈妥
        pending = pending_required(row)
        if pending:
            titles = "、".join(c.get("title") or c.get("key") for c in pending[:4])
            more = f"等 {len(pending)} 项" if len(pending) > 4 else ""
            raise HTTPException(status_code=400, detail=f"还有必要问题待核：{titles}{more}")
        row.deal_price = amount
        row.dealt_at = now
    elif action == "pause_request":
        row.paused_from = from_state
        # 请求阶段不写 paused_at，确认后才记
    elif action == "pause_confirm":
        if not row.paused_from:
            row.paused_from = from_state if from_state not in ("PAUSING", "PAUSED") else None
        row.paused_at = now
    elif action == "close":
        row.closed_at = now
    elif action == "identify":
        row.identified_at = row.identified_at or now

    row.state = to_state
    if note:
        row.note = (note or "").strip() or row.note
    if user_id:
        row.assignee_id = user_id
    _append_event(row, action=action, from_state=from_state, to_state=to_state,
                  price=amount, user_id=user_id, note=note)
    return row


def bind_purchase(db: Session, row: BargainSession, purchase_order_id: str, *, strict: bool = True) -> BargainSession:
    """一个会话只绑一张采购单。已绑过别的单：strict 报错；建单顺带绑（多件同会话、页面没清会话号接着录下一单）不改绑、照常建单。"""
    if row.state != "DEAL":
        raise HTTPException(status_code=400, detail="只有谈妥后才能绑采购单")
    if row.purchase_order_id and row.purchase_order_id != purchase_order_id:
        if strict:
            raise HTTPException(status_code=400, detail="这个议价会话已经绑了别的采购单")
        return row
    row.purchase_order_id = purchase_order_id
    return row


def session_out(row: BargainSession) -> dict:
    return {
        "id": row.id,
        "platform": row.platform,
        "platform_item_id": row.platform_item_id,
        "source_url": row.source_url,
        "purchase_account": row.purchase_account,
        "seller_name": row.seller_name,
        "gc_conversation_id": row.gc_conversation_id,
        "snapshot_id": row.snapshot_id,
        "purchase_order_id": row.purchase_order_id,
        "state": row.state,
        "paused_from": row.paused_from,
        "our_price": row.our_price,
        "their_price": row.their_price,
        "deal_price": row.deal_price,
        "listed_price": row.listed_price,
        "title": row.title,
        "note": row.note,
        "round_no": row.round_no,
        "events": row.events or [],
        "checks": checks_of(row),
        "pending_required": len(pending_required(row)),
        "askable": [c["key"] for c in askable_checks(row)],
        "identified_at": row.identified_at,
        "quoted_at": row.quoted_at,
        "dealt_at": row.dealt_at,
        "paused_at": row.paused_at,
        "closed_at": row.closed_at,
        "created_by_id": row.created_by_id,
        "assignee_id": row.assignee_id,
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }

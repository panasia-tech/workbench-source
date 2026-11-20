"""采购工作台 W10：执行端抓回来的平台订单入库、对上采购单、状态变化留痕。

规矩（禅道 #47）：
  - 一条平台订单 = 平台 + 买家账号 + 平台订单号；同一单重复报、并发报都只更新这一条；
  - 交易、付款、退款、物流四种状态分开存，平台原文留着；看不懂的原文标「要人看」，不瞎猜；
  - 新旧判断：报上来的平台更新时间比已有的旧，就不改状态；没有时间时，已关闭 / 已取消不会被迟到的「已付款」改回去；
  - 只读平台：这里只记事实，不替人下单、付款、取消采购单；采购单还在等收货但平台已经关单的，标「要人看」；
  - 对采购单：订单号一样、采购号对得上（或采购单没填采购号 / 填的是「默认账户」）才自动挂上；
    对上了但采购号不一样的不挂，标「要人看」；一个都对不上的进「待建单」，采购员一键建单。
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation

from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.enums import OrderStatus
from app.schemas._tz import utc_to_cn_iso
from app.models import PurchaseAccount, PurchaseOrder, PurchasePlatformEvent, PurchasePlatformOrder, Staff

_CN = timezone(timedelta(hours=8))
PLATFORMS = {"xianyu": "闲鱼"}
TRADE = {"pending_pay": "等付款", "paid": "已付款", "shipped": "卖家已发货", "received": "已收货", "done": "交易成功",
         "cancelled": "已取消", "closed": "交易关闭", "unknown": "看不懂"}
PAY = {"unpaid": "没付款", "paid": "已付款", "unknown": "不清楚"}
REFUND = {"none": "没退款", "requested": "申请退款", "refunding": "退款中", "partial": "部分退款", "refunded": "已退款",
          "denied": "退款被拒", "unknown": "不清楚"}
SHIP = {"unshipped": "没发货", "shipped": "已发货", "signed": "已签收", "unknown": "不清楚"}
# 走到这些就算结束了，迟到的「已付款」「已发货」不能把它改回去
TERMINAL = {"cancelled", "closed", "done"}
# 状态先后，没有平台时间时拿来判断谁新
TRADE_RANK = {"unknown": 0, "pending_pay": 1, "paid": 2, "shipped": 3, "received": 4, "done": 5, "cancelled": 5, "closed": 5}
# 采购单上这些采购号写法等于「没说是哪个号」
LOOSE_ACCOUNTS = {"", "默认账户"}

# 闲鱼买家订单页上的状态原文 → (交易, 付款, 退款, 物流)。看不懂的不在这里，按 unknown 处理并标要人看。
RAW_MAP = {
    "等待买家付款": ("pending_pay", "unpaid", "none", "unshipped"),
    "待付款": ("pending_pay", "unpaid", "none", "unshipped"),
    "等待卖家发货": ("paid", "paid", "none", "unshipped"),
    "买家已付款": ("paid", "paid", "none", "unshipped"),
    "待发货": ("paid", "paid", "none", "unshipped"),
    "卖家已发货": ("shipped", "paid", "none", "shipped"),
    "待收货": ("shipped", "paid", "none", "shipped"),
    "交易成功": ("done", "paid", "none", "signed"),
    "已收货": ("received", "paid", "none", "signed"),
    "退款中": (None, "paid", "refunding", None),
    "申请退款中": (None, "paid", "requested", None),
    "退款成功": ("closed", "paid", "refunded", None),
    "交易关闭": ("closed", None, None, None),
    "已取消": ("cancelled", None, None, None),
}

_MONEY_FIELDS = ("order_amount", "paid_amount", "freight", "refunded_amount")
_PLAIN_FIELDS = ("item_id", "item_title", "item_image", "seller_name", "seller_id", "tracking_no", "logistics_company")


def _money(v) -> Decimal | None:
    if v is None or v == "":
        return None
    try:
        return Decimal(str(v)).quantize(Decimal("0.01"))
    except InvalidOperation:
        return None


def _when(v) -> datetime | None:
    """执行端报的时间 → 库里的 UTC。带时区的照换；不带的是闲鱼页面上的北京时间。"""
    if not v:
        return None
    try:
        t = v if isinstance(v, datetime) else datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=_CN)
    return t.astimezone(timezone.utc).replace(tzinfo=None)


def map_status(raw: str | None, given: dict) -> tuple[dict, bool]:
    """平台原文 + 执行端已经判好的字段 → 四种状态。返回 (状态, 看不看得懂)。执行端给了的优先。"""
    trade, pay, refund, ship = RAW_MAP.get((raw or "").strip(), (None, None, None, None))
    out = {
        "trade_status": given.get("trade_status") or trade,
        "pay_status": given.get("pay_status") or pay,
        "refund_status": given.get("refund_status") or refund,
        "ship_status": given.get("ship_status") or ship,
    }
    known = bool(out["trade_status"] or out["refund_status"] not in (None, "none"))
    for k, allowed in (("trade_status", TRADE), ("pay_status", PAY), ("refund_status", REFUND), ("ship_status", SHIP)):
        if out[k] is not None and out[k] not in allowed:
            out[k] = None
            known = False
    return {k: v for k, v in out.items() if v is not None}, known


def resolve_account(db: Session, buyer_account: str) -> str | None:
    """执行端报的账号（昵称或登录名）对上 ERP 的采购号，对上回 code。"""
    a = (db.query(PurchaseAccount)
         .filter(or_(PurchaseAccount.code == buyer_account, PurchaseAccount.label == buyer_account)).first())
    return a.code if a else None


def _accounts_match(po_account: str | None, row: PurchasePlatformOrder) -> bool | None:
    """True 对得上；None 采购单没说是哪个号；False 明确是别的号。"""
    v = (po_account or "").strip()
    if v in LOOSE_ACCOUNTS:
        return None
    return v in {row.purchase_account, row.buyer_account}


def _event(db: Session, row: PurchasePlatformOrder, kind: str, text: str, *, key: str, data: dict | None = None,
           source: str = "rpa", staff: Staff | None = None, occurred_at: datetime | None = None) -> bool:
    """记一条事件；同一个 key 记过就不再记（重复报、重试不重复）。返回这次有没有新记。"""
    event_key = hashlib.sha256(f"{row.id}|{key}".encode()).hexdigest()[:64]
    if db.query(PurchasePlatformEvent.id).filter(PurchasePlatformEvent.event_key == event_key).first():
        return False
    db.add(PurchasePlatformEvent(order_id=row.id, event_key=event_key, kind=kind, text=text, data=data, source=source,
                                 staff_id=staff.id if staff else None, occurred_at=occurred_at))
    return True


def _flag(row: PurchasePlatformOrder, reason: str) -> None:
    row.needs_review = True
    if reason not in (row.review_reason or ""):
        row.review_reason = ((row.review_reason + "；") if row.review_reason else "") + reason
        row.review_reason = row.review_reason[:255]


def _is_newer(row: PurchasePlatformOrder, incoming: dict, updated_at: datetime | None) -> bool:
    """这次报上来的状态比已有的新不新。"""
    if row.platform_updated_at and updated_at:
        return updated_at >= row.platform_updated_at
    new = incoming.get("trade_status")
    if row.trade_status in TERMINAL and new and new not in TERMINAL:
        return False  # 没有时间可比：关了的单不让迟到的消息改回去
    return True


def _apply_status(db: Session, row: PurchasePlatformOrder, status: dict, raw: str | None,
                  updated_at: datetime | None) -> None:
    if not _is_newer(row, status, updated_at):
        _event(db, row, "stale", f"收到比现在旧的状态「{raw or status}」，没改", key=f"stale|{raw}|{json.dumps(status, sort_keys=True)}|{updated_at}",
               data={"raw": raw, **status}, occurred_at=updated_at)
        return
    changed = {k: (getattr(row, k), v) for k, v in status.items() if getattr(row, k) != v}
    if raw and raw != row.raw_status:
        changed["raw_status"] = (row.raw_status, raw)
    for k, (_, v) in changed.items():
        setattr(row, k, v)
    if updated_at and (not row.platform_updated_at or updated_at > row.platform_updated_at):
        row.platform_updated_at = updated_at
    if changed:
        words = "，".join(f"{_FIELD_WORD[k]}{_label(k, v)}" for k, (_, v) in changed.items() if k != "raw_status")
        _event(db, row, "status", f"平台状态变成「{raw}」" if raw else f"平台状态：{words}",
               key=f"status|{json.dumps({k: v for k, (_, v) in changed.items()}, sort_keys=True)}|{updated_at}",
               data={k: {"from": a, "to": b} for k, (a, b) in changed.items()}, occurred_at=updated_at)


_FIELD_WORD = {"trade_status": "交易", "pay_status": "付款", "refund_status": "退款", "ship_status": "物流"}


def _label(field: str, value: str) -> str:
    table = {"trade_status": TRADE, "pay_status": PAY, "refund_status": REFUND, "ship_status": SHIP}.get(field)
    return table.get(value, value) if table else value


def _bind_by_order_no(db: Session, row: PurchasePlatformOrder) -> None:
    """按订单号找采购单挂上。一单多件会挂好几张。"""
    pos = (db.query(PurchaseOrder)
           .filter(PurchaseOrder.external_order_no == row.platform_order_no, PurchaseOrder.platform_order_id.is_(None))
           .all())
    if not pos:
        return
    other = [p for p in pos if _accounts_match(p.purchase_account, row) is False]
    if other:
        _flag(row, f"采购单 {other[0].order_no} 订单号一样但采购号是「{other[0].purchase_account}」，没自动挂")
        pos = [p for p in pos if p not in other]
    for p in pos:
        p.platform_order_id = row.id
        _event(db, row, "bind", f"自动挂上采购单 {p.order_no}", key=f"bind|{p.id}", data={"purchase_order_id": p.id})


def _downstream(db: Session, row: PurchasePlatformOrder) -> None:
    """平台关单 / 退款了，挂着的采购单还在等收货：标要人看（不自动取消采购单）。"""
    if row.trade_status not in ("cancelled", "closed") and row.refund_status not in ("refunded", "partial"):
        return
    waiting = [p for p in bound_orders(db, row) if p.status == OrderStatus.PENDING_INSPECT]
    if waiting:
        _flag(row, f"平台{TRADE.get(row.trade_status, '')}{'、' + REFUND[row.refund_status] if row.refund_status in REFUND and row.refund_status != 'none' else ''}，"
                   f"采购单 {waiting[0].order_no} 还在等收货")


def _snapshot(db: Session, row: PurchasePlatformOrder, s: dict) -> None:
    """执行端顺手抓的商品页 → 挂在这单上的快照。执行端是下单后才抓的，算「下单后补抓」，不能说成下单时的页面。"""
    from app.services import purchase_snapshot as snap

    captured = _when(s.get("captured_at")) or datetime.utcnow()
    live = row.ordered_at is not None and captured <= row.ordered_at
    try:
        snap.create_version(
            db, purchase_order_id=None, platform_order_id=row.id, user_id=None,
            platform_item_id=s.get("item_id") or row.item_id, source_url=s.get("source_url"),
            title=s.get("title") or row.item_title, description=s.get("description"),
            declared_model=s.get("declared_model"), specs=s.get("specs"),
            condition_text=s.get("condition_text"), accessories_text=s.get("accessories_text"),
            listed_price=_money(s.get("listed_price")), seller_name=s.get("seller_name") or row.seller_name,
            images=s.get("images"), videos=s.get("videos"), reports=s.get("reports"),
            capture_kind="live" if live else "late", captured_at=captured,
            capture_status=s.get("capture_status") or "OK", capture_error=s.get("capture_error"), raw_payload=s.get("raw"),
        )
    except HTTPException as e:  # 快照出问题不拦订单入库，记下来
        _flag(row, f"商品页快照没存上：{e.detail}")


def bound_orders(db: Session, row: PurchasePlatformOrder) -> list[PurchaseOrder]:
    return db.query(PurchaseOrder).filter(PurchaseOrder.platform_order_id == row.id).order_by(PurchaseOrder.created_at).all()


def ingest_one(db: Session, platform: str, buyer_account: str, d: dict) -> PurchasePlatformOrder:
    """执行端报上来的一单。重复报、并发报都落到同一条。"""
    if platform not in PLATFORMS:
        raise HTTPException(status_code=400, detail="平台不对")
    order_no = str(d.get("platform_order_no") or "").strip()
    if not order_no:
        raise HTTPException(status_code=400, detail="没有平台订单号的不收（先在执行端记采集异常）")
    row = (db.query(PurchasePlatformOrder)
           .filter_by(platform=platform, buyer_account=buyer_account, platform_order_no=order_no).first())
    now = datetime.utcnow()
    is_new = row is None
    if is_new:
        row = PurchasePlatformOrder(platform=platform, buyer_account=buyer_account, platform_order_no=order_no,
                                    purchase_account=resolve_account(db, buyer_account))
        db.add(row)
        db.flush()
        _event(db, row, "created", "执行端第一次抓到这单", key="created", occurred_at=_when(d.get("ordered_at")))
        if row.purchase_account is None:
            _flag(row, f"账号「{buyer_account}」在 ERP 采购号里找不到")
    # 平台字段：报了就更新，没报的不动（部分采集失败不清掉已有的）
    for f in _PLAIN_FIELDS:
        v = d.get(f)
        if v not in (None, ""):
            setattr(row, f, str(v)[:1024] if f == "item_image" else str(v))
    for f in _MONEY_FIELDS:
        v = _money(d.get(f))
        if v is not None:
            setattr(row, f, v)
    if d.get("quantity"):
        row.quantity = int(d["quantity"])
    for f in ("ordered_at", "paid_at"):
        v = _when(d.get(f))
        if v and not getattr(row, f):
            setattr(row, f, v)
    raw = (d.get("raw_status") or "").strip() or None
    status, known = map_status(raw, d)
    if status:
        _apply_status(db, row, status, raw, _when(d.get("platform_updated_at")))
    if not known and raw:
        _flag(row, f"看不懂平台状态「{raw}」")
    missing = [w for f, w in (("item_title", "标题"), ("item_image", "商品图"), ("paid_amount", "实付")) if getattr(row, f) in (None, "")]
    row.sync_status = "partial" if (missing or d.get("sync_error")) else "ok"
    row.sync_error = (d.get("sync_error") or (f"缺{'、'.join(missing)}" if missing else None))
    row.last_synced_at = now
    if d.get("raw"):
        row.raw = d["raw"]
    if isinstance(d.get("snapshot"), dict):
        _snapshot(db, row, d["snapshot"])
    _bind_by_order_no(db, row)
    _downstream(db, row)
    return row


def ingest(db: Session, platform: str, buyer_account: str, orders: list[dict]) -> dict:
    out = {"created": 0, "updated": 0, "review": 0, "errors": []}
    for d in orders:
        try:
            with db.begin_nested():
                existed = db.query(PurchasePlatformOrder.id).filter_by(
                    platform=platform, buyer_account=buyer_account,
                    platform_order_no=str(d.get("platform_order_no") or "").strip()).first()
                row = ingest_one(db, platform, buyer_account, d)
            out["updated" if existed else "created"] += 1
            out["review"] += int(row.needs_review)
        except HTTPException as e:
            out["errors"].append({"platform_order_no": d.get("platform_order_no"), "error": e.detail})
    return out


# ---------------------------------------------------------------- 人工

def bind(db: Session, staff: Staff, row: PurchasePlatformOrder, po: PurchaseOrder, *, note: str | None = None) -> None:
    """采购员手动把一张采购单挂到这单上（建单时、或核对后）。"""
    if po.platform_order_id and po.platform_order_id != row.id:
        raise HTTPException(status_code=400, detail=f"采购单 {po.order_no} 已经挂在别的平台订单上了")
    if po.external_order_no and po.external_order_no != row.platform_order_no:
        raise HTTPException(status_code=400, detail=f"采购单 {po.order_no} 填的订单号是 {po.external_order_no}，和这单对不上")
    if _accounts_match(po.purchase_account, row) is False:
        raise HTTPException(status_code=400, detail=f"采购单 {po.order_no} 是采购号「{po.purchase_account}」的，和这单的号对不上")
    po.platform_order_id = row.id
    if not po.external_order_no:
        po.external_order_no = row.platform_order_no
    _event(db, row, "bind", f"{staff.name or staff.username} 挂上采购单 {po.order_no}" + (f"：{note}" if note else ""),
           key=f"bind|{po.id}", source="manual", staff=staff, data={"purchase_order_id": po.id})


def unbind(db: Session, staff: Staff, row: PurchasePlatformOrder, po: PurchaseOrder, *, note: str) -> None:
    if po.platform_order_id != row.id:
        raise HTTPException(status_code=400, detail="这张采购单没挂在这单上")
    if not (note or "").strip():
        raise HTTPException(status_code=400, detail="摘掉要写原因")
    po.platform_order_id = None
    _event(db, row, "unbind", f"{staff.name or staff.username} 摘掉采购单 {po.order_no}：{note}",
           key=f"unbind|{po.id}|{datetime.utcnow().isoformat()}", source="manual", staff=staff)


def review_done(db: Session, staff: Staff, row: PurchasePlatformOrder, note: str) -> None:
    if not (note or "").strip():
        raise HTTPException(status_code=400, detail="写一句怎么处理的")
    row.needs_review = False
    _event(db, row, "review", f"{staff.name or staff.username} 看过了：{note}（原因：{row.review_reason or '—'}）",
           key=f"review|{datetime.utcnow().isoformat()}", source="manual", staff=staff)
    row.review_reason = None


def draft(row: PurchasePlatformOrder) -> dict:
    """「一键建单」：采购单表单里能从这单带过去的字段。图要采购员自己确认（实拍或商品图）。"""
    return {
        "platform_order_id": row.id, "external_order_no": row.platform_order_no, "purchase_account": row.purchase_account,
        "product_name": row.item_title, "unit_price": str(row.paid_amount or row.order_amount or "") or None,
        "quantity": row.quantity or 1, "seller_name": row.seller_name, "tracking_no": row.tracking_no,
        "order_time": utc_to_cn_iso(row.ordered_at), "paid_at": utc_to_cn_iso(row.paid_at),
        "platform_item_id": row.item_id, "product_images": [row.item_image] if row.item_image else [],
    }


def bind_new_order(db: Session, staff: Staff, po: PurchaseOrder, platform_order_id: str | None) -> None:
    """建采购单时：带了平台订单就挂上；没带的按订单号 + 采购号找抓回来的那单，唯一一条才挂。"""
    if platform_order_id:
        row = db.get(PurchasePlatformOrder, platform_order_id)
        if row is None:
            raise HTTPException(status_code=400, detail="平台订单不存在")
        bind(db, staff, row, po, note="一键建单")
        return
    if not po.external_order_no:
        return
    rows = [r for r in db.query(PurchasePlatformOrder).filter(
        PurchasePlatformOrder.platform_order_no == po.external_order_no).all() if _accounts_match(po.purchase_account, r) is not False]
    if len(rows) == 1:
        po.platform_order_id = rows[0].id
        _event(db, rows[0], "bind", f"建采购单 {po.order_no} 时按订单号自动挂上", key=f"bind|{po.id}",
               source="manual", staff=staff, data={"purchase_order_id": po.id})

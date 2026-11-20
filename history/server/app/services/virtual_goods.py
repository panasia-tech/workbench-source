"""虚拟商品线（卡券、数字权益）：产品卡 8 步、卡券库存、从聊天认订单、发码（11-14 按销售工作台交付包做）。

一张产品卡从研究走到在售：
  1 领线索 → 2 看三个榜 → 3 查取得路径 → 4 算账 → 5 小额实测 → 6 他人复现 → 7 申请上架（主管批） → 8 在售、每周复盘
  有同行在卖的是「跟卖型」，免做 5、6；没有的是「路测型」，8 步全走。每步要交证据，缺的写「待核」，不能空、不能填 0。

订单怎么来：虚拟商品是人在闲鱼上自己发的链接，不走群控上架账本；产品卡上填闲鱼商品 id，
群控聊天里这几条商品的会话每出现一条买家的「我已付款」，就记一单（/api/gc/virtual/paid）。
发码：从库存里拿一张可用的码，拼上话术和使用指引，经群控发进会话（和人工回复同一条链路）；
看明文、发出去、作废都记 virtual_reveal。自动发货要总开关（app_setting virtual_auto_delivery）和产品卡开关都开，
默认关——没人点就不会给买家发任何东西。

库存用完（可用 ≤ 停售线）在「今天」里标红，要人去闲鱼下架或补货；我们动不了人自己发的链接。
"""
from __future__ import annotations

import hashlib
import logging
import re
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.enums import StaffRole, StaffStatus
from app.models import Staff
from app.models.virtual import (
    VirtualBuyerFlag, VirtualCode, VirtualCodeBatch, VirtualEvidence, VirtualOrder, VirtualProduct, VirtualReveal,
)
from app.services.ledger_crypto import seal, unseal

logger = logging.getLogger(__name__)

CN = timedelta(hours=8)
AUTO_SETTING = "virtual_auto_delivery"
# 付款后多久没发就红（交付包：虚拟付款 1 分钟内发）
SEND_WITHIN = timedelta(minutes=1)
# 码快过期的提醒
EXPIRE_WARN_DAYS = 7

DELIVERY = {
    "card": "有卡券（每单发不同的码）",
    "nocard": "无卡券（人人发同一份内容）",
    "topup": "代充（来一单去充一单）",
    "manual": "人工交付",
}
STATE_LABEL = {"research": "研究中", "pending": "等批上架", "on_sale": "在售", "paused": "暂停", "exited": "已退出"}
DECISIONS = ("继续", "扩大", "调整", "暂停", "退出")
LAWYER = {"unsubmitted": "没送审", "pending": "审核中", "passed": "通过", "rejected": "没通过"}
# 分类先给几个交付包里出现过的，其它的人自己写，写过的就出现在下拉里
DEFAULT_PATHS = [
    ["A 码券类", "A1 餐饮券"],
    ["A 码券类", "A5 门票"],
    ["A 码券类", "A8 地方活动券"],
    ["B 数字权益类", "B1 AI 会员"],
    ["D 游戏", "D2 游戏卡"],
]
DEFAULT_CHECKS = {"refund_limit": 2, "blacklist": True, "prev_unconfirmed": True}

# 每一步：标题、要交什么、做到什么算完、必填项（key, 名字, 提示）
STEPS = [
    (1, "领线索，挂节点", "线索从哪来、挂到哪个分类", "查过没有重复的产品卡",
     [("source", "线索来源", "榜单 / 同行 / 群里 / 客户问的，写具体"), ("dedup", "查重", "在虚拟选品里搜过，写搜了什么")]),
    (2, "看三个榜", "闲鱼、淘宝、京东的销量、价格带、卖家数", "三个平台都有一句；没有这类商品的写「无」",
     [("闲鱼", "闲鱼", "销量 / 价格带 / 卖家数"), ("淘宝", "淘宝", "没有写「无」"), ("京东", "京东", "没有写「无」")]),
    (3, "查取得路径", "主路径、备路径、进价、资格、额度", "每条路径有来源",
     [("main", "主路径", "从哪拿货，写到能照着做"), ("backup", "备路径", "没有写「无」"),
      ("cost", "进价", "数字，单位元"), ("qualify", "资格要求", "没有写「无」"), ("quota", "额度频次", "比如每周最多 100 张")]),
    (4, "算账", "售价、进价", "单笔毛利 = 售价 − 进价 − 平台费 − 售后预留",
     [("price", "售价", "数字，单位元"), ("cost", "进价", "数字，单位元")]),
    (5, "小额实测", "买 1 份、交付、核销的经过", "买家那边真能用（要截图）",
     [("how", "实测经过", "怎么买的、怎么交付、核销了没有"), ("result", "结果", "能用 / 不能用，写原因")]),
    (6, "他人复现", "另一个人照产品卡再做一遍", "不问原作者也能做成（要换人交）",
     [("result", "复现结果", "照哪几步做的、卡在哪")]),
    (7, "申请上架", "上架文案和交付话术", "主管批了才算在售",
     [("listing", "上架文案", "闲鱼标题和描述"), ("script", "交付话术", "发码时跟买家说的话"),
      ("guide", "使用指引", "买家怎么用"), ("refund", "退改规则", "比如未发码可退、已发码不退"),
      ("stop", "停止条件", "什么情况马上下架")]),
    (8, "周复盘", "销量、退款、成本变化", "结论：继续 / 扩大 / 调整 / 暂停 / 退出",
     [("summary", "这周怎么样", "销量、退款、成本有没有变"), ("decision", "结论", "继续 / 扩大 / 调整 / 暂停 / 退出")]),
]
STEP = {s[0]: s for s in STEPS}
NUMERIC = {(3, "cost"), (4, "price"), (4, "cost")}
_ITEM_ID = re.compile(r"(?:[?&](?:id|itemId|item_id)=|/item/)?(\d{9,})")


# ---------------------------------------------------------------- 小工具

def _is_admin(user: Staff) -> bool:
    return user.role == StaffRole.ADMIN


def _cn(dt: datetime | None) -> str:
    return (dt + CN).strftime("%m-%d %H:%M") if dt else ""


def _num(v) -> float | None:
    return float(v) if v is not None else None


def _dec(v, label: str) -> Decimal:
    try:
        d = Decimal(str(v).strip())
    except (InvalidOperation, ValueError):
        raise HTTPException(400, f"「{label}」要写数字")
    if d <= 0:
        raise HTTPException(400, f"「{label}」要大于 0")
    return d.quantize(Decimal("0.01"))


def profit(p: VirtualProduct) -> float | None:
    if p.price is None or p.cost is None:
        return None
    fee = p.price * (p.platform_fee_rate or 0)
    return float((p.price - p.cost - fee - (p.after_sale_reserve or 0)).quantize(Decimal("0.01")))


def _code_hash(product_id: str, code: str) -> str:
    return hashlib.sha256(f"{product_id}:{code}".encode()).hexdigest()


def parse_item_ids(text: str | list | None) -> list[str]:
    """粘贴的闲鱼链接或商品 id（一行一个、逗号空格都行）→ 商品 id 列表，去重保序。"""
    if isinstance(text, list):
        text = "\n".join(str(x) for x in text)
    out: list[str] = []
    for m in _ITEM_ID.finditer(text or ""):
        if m.group(1) not in out:
            out.append(m.group(1))
    return out


def _get(db: Session, pid: str) -> VirtualProduct:
    p = db.get(VirtualProduct, pid)
    if not p:
        raise HTTPException(404, "没有这张产品卡")
    return p


def _can_edit(user: Staff, p: VirtualProduct) -> bool:
    return _is_admin(user) or p.owner_id == user.id


def _need_edit(user: Staff, p: VirtualProduct) -> None:
    if not _can_edit(user, p):
        raise HTTPException(403, "这张产品卡不是你负责的，找负责人或主管")


def _names(db: Session, ids) -> dict[str, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return {s.id: s.name or s.username for s in db.query(Staff).filter(Staff.id.in_(ids))}


def auto_on(db: Session) -> bool:
    from app.services.app_settings import get_setting

    return get_setting(db, AUTO_SETTING) == "1"


# ---------------------------------------------------------------- 库存

def stock_of(db: Session, pids: list[str]) -> dict[str, dict]:
    out = {pid: {"avail": 0, "sold": 0, "void": 0} for pid in pids}
    if not pids:
        return out
    for pid, status, n in (db.query(VirtualCode.product_id, VirtualCode.status, func.count())
                           .filter(VirtualCode.product_id.in_(pids))
                           .group_by(VirtualCode.product_id, VirtualCode.status)):
        out[pid][status] = n
    return out


def _expiring(db: Session, pid: str, today: str) -> int:
    """可用的码里，几天内就过期的有几张（批次上写的有效期）。"""
    soon = (datetime.fromisoformat(today) + timedelta(days=EXPIRE_WARN_DAYS)).date().isoformat()
    return (db.query(func.count(VirtualCode.id))
            .join(VirtualCodeBatch, VirtualCodeBatch.id == VirtualCode.batch_id)
            .filter(VirtualCode.product_id == pid, VirtualCode.status == "avail",
                    VirtualCodeBatch.expire_on.isnot(None), VirtualCodeBatch.expire_on <= soon)
            .scalar() or 0)


def restock(db: Session, user: Staff, pid: str, body: dict) -> dict:
    p = _get(db, pid)
    _need_edit(user, p)
    if p.delivery != "card":
        raise HTTPException(400, "这张卡不是「每单发不同的码」，不用补码")
    lines = [x.strip() for x in str(body.get("codes") or "").splitlines() if x.strip()]
    if not lines:
        raise HTTPException(400, "把码贴进来，一行一张")
    if any(len(x) > 500 for x in lines):
        raise HTTPException(400, "有一行超过 500 字，不像一张码，检查是不是没换行")
    seen, fresh = set(), []
    for x in lines:
        h = _code_hash(p.id, x)
        if h not in seen:
            seen.add(h)
            fresh.append((x, h))
    have = {h for (h,) in db.query(VirtualCode.code_hash).filter(VirtualCode.product_id == p.id,
                                                                  VirtualCode.code_hash.in_(list(seen)))}
    fresh = [(x, h) for x, h in fresh if h not in have]
    dup = len(lines) - len(fresh)
    if not fresh:
        raise HTTPException(400, f"这 {len(lines)} 张都已经在库里了，没有新码")
    cost = _dec(body["cost"], "进价") if body.get("cost") not in (None, "") else p.cost
    expire = str(body.get("expire_on") or "").strip() or None
    if expire and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", expire):
        raise HTTPException(400, "有效期写成 2026-12-31 这样")
    no = (db.query(func.max(VirtualCodeBatch.no)).filter(VirtualCodeBatch.product_id == p.id).scalar() or 0) + 1
    b = VirtualCodeBatch(product_id=p.id, no=no, supplier=(body.get("supplier") or "").strip()[:128] or None,
                         cost=cost, qty=len(fresh), expire_on=expire, staff_id=user.id)
    db.add(b)
    db.flush()
    db.add_all(VirtualCode(product_id=p.id, batch_id=b.id, code_enc=seal(x), code_hash=h) for x, h in fresh)
    db.flush()
    _wake_waiting(db, p)
    db.commit()
    return {"added": len(fresh), "dup": dup, "product": detail(db, user, pid)}


def _wake_waiting(db: Session, p: VirtualProduct) -> None:
    """补了码：没码可发等着的单变成可以发（自动发货开着的话下一轮同步就发）。"""
    avail = db.query(func.count(VirtualCode.id)).filter(VirtualCode.product_id == p.id,
                                                        VirtualCode.status == "avail").scalar() or 0
    for o in (db.query(VirtualOrder).filter(VirtualOrder.product_id == p.id, VirtualOrder.status == "waiting")
              .order_by(VirtualOrder.paid_at)):
        if avail <= 0:
            break
        o.status = "ready"
        avail -= 1


# ---------------------------------------------------------------- 产品卡

def _issues(p: VirtualProduct, st: dict, orders: list[VirtualOrder], now: datetime, expiring: int = 0) -> list[dict]:
    """这张卡现在要看的事，红的在前。"""
    out = []
    for o in orders:
        if o.status in ("ready", "held", "waiting"):
            late = now - o.paid_at > SEND_WITHIN
            why = {"ready": f"上次没发出去（{o.send_error}）" if o.send_error else "可以发码",
                   "held": "被检查拦住：" + "；".join(o.hits or []), "waiting": "没码可发"}[o.status]
            out.append({"level": "red" if late or o.send_error else "yellow", "go": "orders",
                        "text": f"{o.buyer_name or '买家'} 付款 {_ago(o.paid_at, now)}还没发：{why}"})
        elif o.status == "refund":
            out.append({"level": "yellow", "go": "orders", "text": f"{o.buyer_name or '买家'} 申请退款，去闲鱼处理"})
    if p.state == "on_sale":
        if p.delivery == "card":
            if st["avail"] <= p.stop_at:
                out.append({"level": "red", "go": "stock", "text": f"卡券只剩 {st['avail']} 张：去闲鱼下架或马上补货"})
            elif st["avail"] <= p.warn_at:
                out.append({"level": "yellow", "go": "stock", "text": f"卡券只剩 {st['avail']} 张，低于提醒线 {p.warn_at}"})
            if expiring:
                out.append({"level": "yellow", "go": "stock", "text": f"{expiring} 张码 {EXPIRE_WARN_DAYS} 天内过期"})
        if not p.item_ids:
            out.append({"level": "yellow", "go": "settings", "text": "没填闲鱼链接，卖出去也认不出订单"})
        if p.price is not None and p.cost is not None and p.price < p.cost:
            out.append({"level": "red", "go": "money", "text": f"售价 ¥{p.price} 低于进价 ¥{p.cost}，卖一单亏一单"})
    if p.state == "pending":
        out.append({"level": "yellow", "go": "steps", "text": "等主管批上架"})
    if p.reject_note and p.state == "research" and p.step == 7:
        out.append({"level": "yellow", "go": "steps", "text": f"主管退回：{p.reject_note}"})
    if (p.compliance or {}).get("lawyer") == "rejected":
        out.append({"level": "red", "go": "law", "text": "律师没通过，不能上架"})
    return sorted(out, key=lambda x: 0 if x["level"] == "red" else 1)


def _ago(t: datetime, now: datetime) -> str:
    m = int((now - t).total_seconds() // 60)
    if m < 1:
        return "不到 1 分钟"
    if m < 60:
        return f"{m} 分钟"
    if m < 1440:
        return f"{m // 60} 小时"
    return f"{m // 1440} 天"


def _level(issues: list[dict]) -> str:
    if any(i["level"] == "red" for i in issues):
        return "red"
    return "yellow" if issues else "green"


def _steps(p: VirtualProduct) -> list[dict]:
    out = []
    for n, title, give, done_when, fields in STEPS:
        if p.listing_type == "follow" and n in (5, 6):
            state = "skip"
        elif n < p.step:
            state = "done"
        elif n == p.step:
            state = "cur"
        else:
            state = "todo"
        out.append({"n": n, "title": title, "give": give, "done_when": done_when, "state": state,
                    "fields": [{"key": k, "label": lb, "hint": h} for k, lb, h in fields]})
    return out


def _card(p: VirtualProduct, st: dict, issues: list[dict], names: dict) -> dict:
    return {
        "id": p.id, "code": p.code, "name": p.name, "brand": p.brand, "face": p.face, "path": p.path or [],
        "delivery": p.delivery, "delivery_label": DELIVERY.get(p.delivery, p.delivery),
        "listing_type": p.listing_type, "step": p.step, "state": p.state, "state_label": STATE_LABEL.get(p.state, p.state),
        "price": _num(p.price), "cost": _num(p.cost), "profit": profit(p),
        "stock": st if p.delivery == "card" else None, "warn_at": p.warn_at, "stop_at": p.stop_at,
        "owner": names.get(p.owner_id, ""), "level": _level(issues), "issues": issues[:3],
    }


def _open_orders(db: Session, pids: list[str]) -> dict[str, list[VirtualOrder]]:
    out: dict[str, list[VirtualOrder]] = {pid: [] for pid in pids}
    if pids:
        for o in (db.query(VirtualOrder)
                  .filter(VirtualOrder.product_id.in_(pids),
                          VirtualOrder.status.in_(("ready", "held", "waiting", "refund")))
                  .order_by(VirtualOrder.paid_at)):
            out[o.product_id].append(o)
    return out


def gallery(db: Session, user: Staff, *, q: str | None = None, state: str | None = None,
            mine: bool = False, now: datetime | None = None) -> dict:
    """虚拟选品：所有产品卡 + 分类树（按卡上的路径数出来）。"""
    now = now or datetime.utcnow()
    query = db.query(VirtualProduct)
    if state:
        query = query.filter(VirtualProduct.state == state)
    if mine:
        query = query.filter(VirtualProduct.owner_id == user.id)
    rows = query.order_by(VirtualProduct.updated_at.desc()).all()
    if q:
        k = q.strip().lower()
        rows = [p for p in rows if k in f"{p.code} {p.name} {p.brand or ''} {' '.join(p.path or [])}".lower()]
    pids = [p.id for p in rows]
    stock = stock_of(db, pids)
    orders = _open_orders(db, pids)
    names = _names(db, [p.owner_id for p in rows])
    today = (now + CN).date().isoformat()
    cards = []
    for p in rows:
        exp = _expiring(db, p.id, today) if p.delivery == "card" and p.state == "on_sale" else 0
        cards.append(_card(p, stock[p.id], _issues(p, stock[p.id], orders[p.id], now, exp), names))
    cards.sort(key=lambda c: {"red": 0, "yellow": 1, "green": 2}[c["level"]])
    return {
        "items": cards,
        "tree": _tree(db),
        "counts": {lv: sum(c["level"] == lv for c in cards) for lv in ("red", "yellow", "green")},
        "auto_delivery": auto_on(db),
        "is_admin": _is_admin(user),
        "sop": [{"n": s[0], "title": s[1]} for s in STEPS],
    }


def _tree(db: Session) -> list[dict]:
    """分类树：默认几类 + 卡上用过的，逐层数有几张卡。"""
    root: dict = {}

    def add(path, count=True):
        node = root
        for name in path:
            node = node.setdefault(name, {"n": 0, "kids": {}})
            if count:
                node["n"] += 1
            node = node["kids"]

    for path in DEFAULT_PATHS:
        add(path, count=False)
    for (path,) in db.query(VirtualProduct.path):
        add(path or [])

    def out(d):
        return [{"name": k, "n": v["n"], "kids": out(v["kids"])} for k, v in d.items()]

    return out(root)


def _clean_path(path) -> list[str]:
    if isinstance(path, str):
        path = re.split(r"\s*[›>/]\s*", path)
    path = [str(x).strip()[:40] for x in (path or []) if str(x).strip()]
    if not path:
        raise HTTPException(400, "选一个分类（至少一层）")
    return path[:4]


def create(db: Session, user: Staff, body: dict) -> dict:
    name = str(body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "写一下这是什么商品")
    delivery = body.get("delivery") or "card"
    if delivery not in DELIVERY:
        raise HTTPException(400, "交付方式不对")
    for _ in range(3):
        n = (db.query(func.count(VirtualProduct.id)).scalar() or 0) + 1
        code = f"VC{n:04d}"
        if not db.query(VirtualProduct.id).filter(VirtualProduct.code == code).first():
            break
    else:
        code = f"VC{datetime.utcnow():%y%m%d%H%M%S}"
    p = VirtualProduct(
        code=code, name=name[:128], brand=(body.get("brand") or "").strip()[:64] or None,
        face=(body.get("face") or "").strip()[:256] or None, path=_clean_path(body.get("path")),
        delivery=delivery, listing_type="test", step=1, state="research",
        region=(body.get("region") or "").strip()[:64] or None, valid=(body.get("valid") or "").strip()[:64] or None,
        signals={}, peers=[], sourcing={}, notes={}, compliance={"level": "B", "lawyer": "unsubmitted", "note": ""},
        item_ids=[], checks=dict(DEFAULT_CHECKS), warn_at=10, stop_at=0,
        owner_id=user.id, created_by_id=user.id,
    )
    db.add(p)
    db.commit()
    return detail(db, user, p.id)


def update(db: Session, user: Staff, pid: str, body: dict) -> dict:
    """改产品卡上的设置：基本信息、闲鱼链接、提醒线、发货检查、自动发货；合规只有主管能改。"""
    p = _get(db, pid)
    _need_edit(user, p)
    for k, n in (("name", 128), ("brand", 64), ("face", 256), ("region", 64), ("valid", 64)):
        if k in body:
            v = str(body[k] or "").strip()[:n]
            if k == "name" and not v:
                raise HTTPException(400, "名字不能空")
            setattr(p, k, v or None)
    if "path" in body:
        p.path = _clean_path(body["path"])
    if "item_ids" in body:
        ids = parse_item_ids(body["item_ids"])
        if body["item_ids"] and not ids:
            raise HTTPException(400, "没认出闲鱼商品 id：贴商品页链接或一串数字的 id")
        clash = [x.code for x in db.query(VirtualProduct).filter(VirtualProduct.id != p.id)
                 if set(x.item_ids or []) & set(ids)]
        if clash:
            raise HTTPException(409, f"这条闲鱼链接已经填在 {clash[0]} 上了，一条链接只能算一张产品卡")
        p.item_ids = ids
    for k in ("warn_at", "stop_at"):
        if k in body:
            try:
                v = int(body[k])
            except (TypeError, ValueError):
                raise HTTPException(400, "提醒线、停售线写整数")
            if v < 0:
                raise HTTPException(400, "提醒线、停售线不能小于 0")
            setattr(p, k, v)
    if "checks" in body:
        c = dict(p.checks or DEFAULT_CHECKS)
        b = body["checks"] or {}
        if "refund_limit" in b:
            c["refund_limit"] = max(0, int(b["refund_limit"] or 0))
        for k in ("blacklist", "prev_unconfirmed"):
            if k in b:
                c[k] = bool(b[k])
        p.checks = c
    if "auto_delivery" in body:
        on = bool(body["auto_delivery"])
        if on and p.delivery not in ("card", "nocard"):
            raise HTTPException(400, "只有发码、发固定内容的能自动发；代充和人工交付要人来做")
        if on and p.state != "on_sale":
            raise HTTPException(400, "批准上架之后才能开自动发货")
        p.auto_delivery = on
    if "shared_content" in body:
        if p.delivery != "nocard":
            raise HTTPException(400, "只有「人人发同一份内容」的卡要填这个")
        v = str(body["shared_content"] or "").strip()
        if len(v) > 400:
            raise HTTPException(400, "内容太长：闲鱼一条消息最多 500 字，还要留给话术")
        p.shared_content_enc = seal(v) if v else None
    if "compliance" in body:
        if not _is_admin(user):
            raise HTTPException(403, "合规和律师结论只有主管能改")
        c = dict(p.compliance or {})
        b = body["compliance"] or {}
        if b.get("level") in ("A", "B", "C"):
            c["level"] = b["level"]
        if b.get("lawyer") in LAWYER:
            c["lawyer"] = b["lawyer"]
        if "note" in b:
            c["note"] = str(b["note"] or "")[:500]
        p.compliance = c
    if "price" in body and p.step >= 4:
        p.price = _dec(body["price"], "售价")
    if "decision" in body and _is_admin(user) and body["decision"] in DECISIONS:
        _apply_decision(p, body["decision"])
    db.commit()
    return detail(db, user, pid)


def _apply_decision(p: VirtualProduct, decision: str) -> None:
    p.decision = decision
    if decision == "暂停" and p.state == "on_sale":
        p.state, p.auto_delivery = "paused", False
    elif decision == "退出":
        p.state, p.auto_delivery = "exited", False
    elif decision in ("继续", "扩大", "调整") and p.state == "paused":
        p.state = "on_sale"


def advance(db: Session, user: Staff, pid: str, body: dict) -> dict:
    """交这一步的证据，走到下一步。服务端和页面同一套校验：缺的写「待核」，不能空、不能填 0。"""
    p = _get(db, pid)
    n = p.step
    if p.state == "pending":
        raise HTTPException(400, "已经申请上架，等主管批")
    if p.state == "exited":
        raise HTTPException(400, "这张卡已经退出，不再往下走")
    if n == 6:
        if p.owner_id == user.id:
            raise HTTPException(403, "他人复现要换一个人来做：不看原作者也能做成才算")
    else:
        _need_edit(user, p)
    data = body.get("evidence") or {}
    images = [str(u) for u in (body.get("images") or []) if u][:9]
    fields = STEP[n][4]
    clean: dict[str, str] = {}
    missing, zero = [], []
    for key, label, _hint in fields:
        v = str(data.get(key) or "").strip()
        if not v:
            missing.append(label)
        elif v in ("0", "0.0", "0.00"):
            zero.append(label)
        clean[key] = v[:2000]
    if missing:
        raise HTTPException(400, "还缺：" + "、".join(missing) + "。不知道的写「待核」，不要空着")
    if zero:
        raise HTTPException(400, "「" + "、".join(zero) + "」填了 0：没数据写「待核」，不要填 0")
    if n == 5 and not images:
        raise HTTPException(400, "小额实测要附截图：买家那边能用的凭证")
    if n == 8 and clean["decision"] not in DECISIONS:
        raise HTTPException(400, "结论只能选：" + " / ".join(DECISIONS))
    for (sn, key) in NUMERIC:
        if sn == n and clean.get(key) != "待核":
            clean[key] = str(_dec(clean[key], dict((k, lb) for k, lb, _ in fields)[key]))
    if n == 4 and "待核" in (clean["price"], clean["cost"]):
        raise HTTPException(400, "算账这一步售价、进价都要是数字，不能待核")

    if n == 2:
        p.signals = {k: clean[k] for k in ("闲鱼", "淘宝", "京东")}
        peers = parse_item_ids(body.get("peers") or "")
        p.peers = [{"platform": "闲鱼", "item_id": x, "url": f"https://www.goofish.com/item?id={x}"} for x in peers]
        p.listing_type = "follow" if peers else "test"
    elif n == 3:
        p.sourcing = clean
        if clean["cost"] != "待核":
            p.cost = Decimal(clean["cost"])
    elif n == 4:
        p.price, p.cost = Decimal(clean["price"]), Decimal(clean["cost"])
    elif n == 7:
        p.notes = clean
        if (p.compliance or {}).get("lawyer") == "rejected":
            raise HTTPException(400, "律师没通过，不能申请上架")

    db.add(VirtualEvidence(product_id=p.id, step=n, action="review" if n == 8 else "submit",
                           data=clean, images=images, staff_id=user.id))
    if n == 8:
        _apply_decision(p, clean["decision"])
    elif n == 7:
        p.state, p.reject_note = "pending", None
        _notify_admins(db, p, user)
    else:
        nxt = n + 1
        if p.listing_type == "follow" and nxt in (5, 6):
            nxt = 7
        p.step = nxt
    db.commit()
    return detail(db, user, pid)


def _notify_admins(db: Session, p: VirtualProduct, by: Staff) -> None:
    from app.services import staff_notify

    url = f"/pages/virtual/item/index?id={p.id}"
    for admin in db.query(Staff).filter(Staff.role == StaffRole.ADMIN, Staff.status == StaffStatus.ACTIVE):
        if admin.id == by.id:
            continue
        try:
            staff_notify.send(admin, "虚拟商品申请上架", f"{by.name or by.username} 申请上架 {p.code} {p.name}", url=url)
        except Exception:  # noqa: BLE001
            logger.exception("申请上架通知没发出去")


def review(db: Session, user: Staff, pid: str, body: dict) -> dict:
    """主管批 / 退回上架申请。自己交的自己不能批；律师没通过、C 级没过律师的不能批。"""
    if not _is_admin(user):
        raise HTTPException(403, "只有主管能批上架")
    p = _get(db, pid)
    if p.state != "pending":
        raise HTTPException(400, "这张卡没有在等批")
    last = (db.query(VirtualEvidence).filter(VirtualEvidence.product_id == p.id, VirtualEvidence.step == 7,
                                             VirtualEvidence.action == "submit")
            .order_by(VirtualEvidence.created_at.desc()).first())
    if last and last.staff_id == user.id:
        raise HTTPException(403, "自己交的上架申请不能自己批，找另一位主管")
    ok = bool(body.get("ok"))
    note = str(body.get("note") or "").strip()
    if ok:
        comp = p.compliance or {}
        if comp.get("lawyer") == "rejected":
            raise HTTPException(400, "律师没通过，不能批")
        if comp.get("level") == "C" and comp.get("lawyer") != "passed":
            raise HTTPException(400, "C 级要律师通过才能批：先把律师结论改成「通过」")
        if p.price is None or p.cost is None:
            raise HTTPException(400, "还没算账（售价、进价），不能批")
        p.state, p.step, p.approved_by_id, p.approved_at = "on_sale", 8, user.id, datetime.utcnow()
    else:
        if len(note) < 4:
            raise HTTPException(400, "退回要写清楚缺哪项、怎么改（至少 4 个字）")
        p.state, p.reject_note = "research", note
    db.add(VirtualEvidence(product_id=p.id, step=7, action="approve" if ok else "reject",
                           data={"note": note}, images=[], staff_id=user.id))
    db.commit()
    return detail(db, user, pid)


def detail(db: Session, user: Staff, pid: str, now: datetime | None = None) -> dict:
    now = now or datetime.utcnow()
    p = _get(db, pid)
    st = stock_of(db, [p.id])[p.id]
    orders = (db.query(VirtualOrder).filter(VirtualOrder.product_id == p.id)
              .order_by(VirtualOrder.paid_at.desc()).limit(100).all())
    open_ = sorted([o for o in orders if o.status in ("ready", "held", "waiting", "refund")], key=lambda o: o.paid_at)
    exp = _expiring(db, p.id, (now + CN).date().isoformat()) if p.delivery == "card" and p.state == "on_sale" else 0
    issues = _issues(p, st, open_, now, exp)
    ev = (db.query(VirtualEvidence).filter(VirtualEvidence.product_id == p.id)
          .order_by(VirtualEvidence.created_at.desc()).limit(60).all())
    batches = (db.query(VirtualCodeBatch).filter(VirtualCodeBatch.product_id == p.id)
               .order_by(VirtualCodeBatch.no.desc()).all())
    left = dict(db.query(VirtualCode.batch_id, func.count()).filter(VirtualCode.product_id == p.id,
                                                                    VirtualCode.status == "avail")
                .group_by(VirtualCode.batch_id).all())
    names = _names(db, [p.owner_id, p.approved_by_id, *[e.staff_id for e in ev], *[b.staff_id for b in batches],
                        *[o.sent_by_id for o in orders]])
    week = now - timedelta(days=7)
    month = [o for o in orders if o.paid_at >= now - timedelta(days=30)]
    refunds = sum(o.status in ("refund", "closed") for o in month)
    pr = profit(p)
    flags = _buyer_flags(db, [o.buyer_key for o in orders])
    return {
        **_card(p, st, issues, names),
        "issues": issues,
        "region": p.region, "valid": p.valid, "item_ids": p.item_ids or [],
        "item_urls": [f"https://www.goofish.com/item?id={x}" for x in p.item_ids or []],
        "signals": p.signals or {}, "peers": p.peers or [], "sourcing": p.sourcing or {}, "notes": p.notes or {},
        "compliance": {**{"level": "B", "lawyer": "unsubmitted", "note": ""}, **(p.compliance or {})},
        "lawyer_label": LAWYER.get((p.compliance or {}).get("lawyer") or "unsubmitted"),
        "has_shared_content": bool(p.shared_content_enc),
        "auto_delivery": p.auto_delivery, "auto_global": auto_on(db),
        "checks": {**DEFAULT_CHECKS, **(p.checks or {})},
        "platform_fee_rate": float(p.platform_fee_rate or 0), "after_sale_reserve": float(p.after_sale_reserve or 0),
        "decision": p.decision, "reject_note": p.reject_note,
        "approved_by": names.get(p.approved_by_id or ""), "approved_at": _cn(p.approved_at),
        "steps": _steps(p),
        "evidence": [{"step": e.step, "action": e.action, "data": e.data, "images": e.images,
                      "who": names.get(e.staff_id, ""), "at": _cn(e.created_at)} for e in ev],
        "batches": [{"no": b.no, "supplier": b.supplier, "cost": _num(b.cost), "qty": b.qty, "left": left.get(b.id, 0),
                     "expire_on": b.expire_on, "who": names.get(b.staff_id, ""), "at": _cn(b.created_at)}
                    for b in batches],
        "orders": [_order_out(o, now, names, flags) for o in orders],
        "week_sales": sum(o.paid_at >= week and o.status != "closed" for o in orders),
        "refund_rate": round(refunds / len(month), 3) if month else 0,
        # 提成按交付包的口径估一下（没接进提成结算）：交付人 10%，建卡人上架后半年 5%
        "commission": None if pr is None else {"deliver": round(pr * 0.10, 2), "creator": round(pr * 0.05, 2)},
        "can_edit": _can_edit(user, p),
        "can_step": p.state not in ("pending", "exited") and (
            (p.step == 6 and p.owner_id != user.id) or (p.step != 6 and _can_edit(user, p))),
        "can_review": _is_admin(user) and p.state == "pending",
        "is_admin": _is_admin(user),
    }


ORDER_LABEL = {"ready": "可以发", "held": "检查拦住", "waiting": "没码可发", "sending": "发出中", "sent": "已发码",
               "done": "买家确认了", "refund": "申请退款", "closed": "已关闭"}


def _order_out(o: VirtualOrder, now: datetime, names: dict, flags: dict) -> dict:
    late = o.status in ("ready", "held", "waiting") and now - o.paid_at > SEND_WITHIN
    f = flags.get(o.buyer_key or "")
    return {
        "id": o.id, "buyer": o.buyer_name or "买家", "buyer_key": o.buyer_key, "amount": _num(o.amount),
        "paid_at": _cn(o.paid_at), "ago": _ago(o.paid_at, now), "status": o.status,
        "status_label": ORDER_LABEL.get(o.status, o.status), "late": late, "hits": o.hits or [],
        "platform_status": o.platform_status, "has_code": bool(o.code_id), "send_error": o.send_error,
        "sent_by": names.get(o.sent_by_id or ""), "sent_at": _cn(o.sent_at), "note": o.note,
        "conversation_id": o.conversation_id,
        "buyer_flag": {"refunds": f.refunds, "blacklisted": f.blacklisted, "note": f.note} if f else None,
    }


def _buyer_flags(db: Session, keys) -> dict[str, VirtualBuyerFlag]:
    keys = {k for k in keys if k}
    if not keys:
        return {}
    return {f.buyer_key: f for f in db.query(VirtualBuyerFlag).filter(VirtualBuyerFlag.buyer_key.in_(keys))}


# ---------------------------------------------------------------- 订单：从聊天认、检查、发码

PAID_WAIT = "等待卖家发货"
DONE_STATUSES = ("交易成功",)
REFUND_HINT = "退款"
PREV_WINDOW = timedelta(days=7)
CLOSED_HINT = ("关闭", "退款成功")


def _checks(db: Session, p: VirtualProduct, buyer_key: str | None, exclude_id: str | None = None) -> list[str]:
    c = {**DEFAULT_CHECKS, **(p.checks or {})}
    hits = []
    f = db.query(VirtualBuyerFlag).filter(VirtualBuyerFlag.buyer_key == buyer_key).first() if buyer_key else None
    if f and c.get("blacklist") and f.blacklisted:
        hits.append("买家在退款名单里" + (f"：{f.note}" if f.note else ""))
    if f and c.get("refund_limit") and f.refunds >= int(c["refund_limit"]):
        hits.append(f"这个买家退过 {f.refunds} 次款")
    if buyer_key and c.get("prev_unconfirmed"):
        # 只看 7 天内发的：闲鱼过几天会自动确认，聊天里不一定读得到，老单不能一直拦着
        prev = (db.query(VirtualOrder.id).filter(VirtualOrder.buyer_key == buyer_key, VirtualOrder.status == "sent",
                                                 VirtualOrder.sent_at >= datetime.utcnow() - PREV_WINDOW,
                                                 VirtualOrder.id != (exclude_id or "")).first())
        if prev:
            hits.append("买家上一单还没确认收货")
    return hits


def _initial_status(db: Session, p: VirtualProduct, o: VirtualOrder) -> None:
    o.hits = _checks(db, p, o.buyer_key, o.id)
    if o.hits:
        o.status = "held"
        return
    if p.delivery == "card":
        avail = db.query(VirtualCode.id).filter(VirtualCode.product_id == p.id, VirtualCode.status == "avail").first()
        o.status = "ready" if avail else "waiting"
    else:
        o.status = "ready"


def _money(v) -> Decimal | None:
    try:
        return Decimal(str(v).replace("¥", "").replace(",", "").strip()).quantize(Decimal("0.01")) if v else None
    except (InvalidOperation, ValueError):
        return None


def _parse_dt(v) -> datetime:
    if isinstance(v, datetime):
        return v
    return datetime.fromisoformat(str(v).replace("Z", "")) if v else datetime.utcnow()


def apply_paid(db: Session, rows: list[dict]) -> dict:
    """群控给的会话 + 付款消息 → 记新单、按会话当前状态更新最近那单。返回 {new, updated}。"""
    by_item: dict[str, VirtualProduct] = {}
    for p in db.query(VirtualProduct).filter(VirtualProduct.state.in_(("on_sale", "paused"))):
        for x in p.item_ids or []:
            by_item[x] = p
    new = updated = 0
    for r in rows:
        p = by_item.get(str(r.get("item_id") or ""))
        if not p:
            continue
        for m in r.get("paid") or []:
            if db.query(VirtualOrder.id).filter(VirtualOrder.paid_msg_id == m["id"]).first():
                continue
            o = VirtualOrder(product_id=p.id, paid_msg_id=m["id"], conversation_id=r["conversation_id"],
                             account_id=r.get("account_id"), item_id=r.get("item_id"), buyer_key=r.get("peer_key"),
                             buyer_name=r.get("peer_nick"), amount=_money(r.get("item_price")) or p.price,
                             paid_at=_parse_dt(m.get("at")), hits=[], platform_status=r.get("order_status"))
            db.add(o)
            db.flush()
            _initial_status(db, p, o)
            new += 1
        last = (db.query(VirtualOrder).filter(VirtualOrder.conversation_id == r["conversation_id"])
                .order_by(VirtualOrder.paid_at.desc()).first())
        ps = r.get("order_status")
        if last and ps and ps != last.platform_status:
            last.platform_status = ps
            _follow_platform(db, last, ps)
            updated += 1
    db.commit()
    return {"new": new, "updated": updated}


def _follow_platform(db: Session, o: VirtualOrder, ps: str) -> None:
    """闲鱼那边的订单状态变了：确认收货 → 完成；申请退款 → 退款（记进退款名单）；关了 → 关闭。"""
    if ps in DONE_STATUSES and o.status in ("sent", "sending"):
        o.status = "done"
    elif any(h in ps for h in CLOSED_HINT):
        if o.status != "closed":
            o.status = "closed"
    elif REFUND_HINT in ps and o.status not in ("refund", "closed"):
        o.status = "refund"
        if o.buyer_key:
            f = db.query(VirtualBuyerFlag).filter(VirtualBuyerFlag.buyer_key == o.buyer_key).first()
            if not f:
                f = VirtualBuyerFlag(buyer_key=o.buyer_key, buyer_name=o.buyer_name, refunds=0)
                db.add(f)
            f.refunds = (f.refunds or 0) + 1


def _message(p: VirtualProduct, payload: str) -> str:
    notes = p.notes or {}
    label = "卡券" if p.delivery == "card" else "内容"
    parts = [notes.get("script") or "", f"{label}：{payload}", notes.get("guide") or ""]
    text = "\n".join(x.strip() for x in parts if x and x.strip())
    if len(text) > 500:
        # 话术和指引太长就只发码，别让闲鱼截断把码截掉
        text = f"{label}：{payload}"
    return text


def _take_code(db: Session, p: VirtualProduct, o: VirtualOrder) -> VirtualCode:
    if o.code_id:
        c = db.get(VirtualCode, o.code_id)
        if c and c.status == "sold":
            return c
    c = (db.query(VirtualCode).join(VirtualCodeBatch, VirtualCodeBatch.id == VirtualCode.batch_id)
         .filter(VirtualCode.product_id == p.id, VirtualCode.status == "avail")
         # 先发快过期的，再按入库先后
         .order_by(func.coalesce(VirtualCodeBatch.expire_on, "9999-12-31"), VirtualCode.created_at)
         .with_for_update().first())
    if not c:
        o.status = "waiting"
        db.commit()
        raise HTTPException(409, "没有可用的码了：先补货")
    c.status, c.order_id, c.used_at = "sold", o.id, datetime.utcnow()
    o.code_id = c.id
    return c


def _order(db: Session, oid: str) -> tuple[VirtualOrder, VirtualProduct]:
    o = db.get(VirtualOrder, oid)
    if not o:
        raise HTTPException(404, "没有这笔订单")
    return o, db.get(VirtualProduct, o.product_id)


async def send(db: Session, user: Staff | None, oid: str, *, auto: bool = False) -> dict:
    """发码：拿一张码（重发用同一张）、拼话术，经群控发进会话。user=None 是自动发货。"""
    from app.services.gc_bridge import client as gc

    o, p = _order(db, oid)
    if o.status == "held":
        raise HTTPException(400, "这单被检查拦住了：先看清原因，确认没问题点「放行」")
    if o.status not in ("ready", "waiting"):
        raise HTTPException(400, f"这单现在是「{ORDER_LABEL.get(o.status, o.status)}」，不用再发")
    if p.delivery in ("topup", "manual"):
        raise HTTPException(400, "代充、人工交付的单要人去做，做完点「已交付」")
    if p.delivery == "card":
        payload = unseal(_take_code(db, p, o).code_enc)
    else:
        payload = unseal(p.shared_content_enc)
        if not payload:
            raise HTTPException(400, "产品卡上还没填要发的内容")
    text = _message(p, payload)
    try:
        res = await gc.virtual_send(o.conversation_id, text, by_name=(user.name if user else "自动发货"))
    except Exception as exc:  # noqa: BLE001
        o.status, o.send_error = "ready", f"群控没接住：{str(exc)[:120]}"
        db.commit()
        raise HTTPException(502, "发送没成功：群控连不上，码没丢，稍后再点发送")
    o.status, o.send_task_id, o.send_error = "sending", res.get("task_id"), None
    o.sent_by_id, o.sent_at = (user.id if user else None), datetime.utcnow()
    db.add(VirtualReveal(code_id=o.code_id, product_id=p.id, order_id=o.id, action="auto" if auto else "send",
                         staff_id=user.id if user else None))
    db.commit()
    return {"ok": True, "status": o.status}


def mark_delivered(db: Session, user: Staff, oid: str, body: dict) -> dict:
    """代充 / 人工交付做完了，或者码是在别处发的：人点一下记成已交付。"""
    o, p = _order(db, oid)
    if o.status not in ("ready", "waiting", "held"):
        raise HTTPException(400, f"这单现在是「{ORDER_LABEL.get(o.status, o.status)}」")
    note = str(body.get("note") or "").strip()
    if len(note) < 2:
        raise HTTPException(400, "写一句怎么交付的（比如：已代充到 138****0000）")
    o.status, o.note, o.sent_by_id, o.sent_at = "sent", note[:500], user.id, datetime.utcnow()
    db.commit()
    return {"ok": True}


def release(db: Session, user: Staff, oid: str) -> dict:
    o, p = _order(db, oid)
    if o.status != "held":
        raise HTTPException(400, "这单没有被拦")
    o.status, o.released_by_id = "ready", user.id
    o.note = f"{user.name or user.username} 放行：" + "；".join(o.hits or [])
    if p.delivery == "card" and not db.query(VirtualCode.id).filter(
            VirtualCode.product_id == p.id, VirtualCode.status == "avail").first() and not o.code_id:
        o.status = "waiting"
    db.commit()
    return {"ok": True, "status": o.status}


def reveal(db: Session, user: Staff, oid: str) -> dict:
    """看这单发出去的码（买家说没收到、要手动补发时用）。每看一次记一笔。"""
    o, p = _order(db, oid)
    if p.delivery == "nocard":
        db.add(VirtualReveal(product_id=p.id, order_id=o.id, action="reveal", staff_id=user.id))
        db.commit()
        return {"code": unseal(p.shared_content_enc) or ""}
    if not o.code_id:
        raise HTTPException(400, "这单还没分到码")
    c = db.get(VirtualCode, o.code_id)
    db.add(VirtualReveal(code_id=c.id, product_id=p.id, order_id=o.id, action="reveal", staff_id=user.id))
    db.commit()
    return {"code": unseal(c.code_enc)}


def void_code(db: Session, user: Staff, oid: str, body: dict) -> dict:
    """买家说码用不了：这张作废，单子回到「可以发」，再点发送会换一张新的。"""
    o, p = _order(db, oid)
    if not o.code_id:
        raise HTTPException(400, "这单还没分到码")
    note = str(body.get("note") or "").strip()
    if len(note) < 2:
        raise HTTPException(400, "写一下为什么作废（比如：买家说已被使用）")
    c = db.get(VirtualCode, o.code_id)
    c.status, c.void_note = "void", note[:256]
    o.code_id, o.status, o.send_task_id = None, "ready", None
    db.add(VirtualReveal(code_id=c.id, product_id=p.id, order_id=o.id, action="void", staff_id=user.id))
    db.commit()
    return {"ok": True}


def flag_buyer(db: Session, user: Staff, body: dict) -> dict:
    key = str(body.get("buyer_key") or "").strip()
    if not key:
        raise HTTPException(400, "缺买家")
    f = db.query(VirtualBuyerFlag).filter(VirtualBuyerFlag.buyer_key == key).first()
    if not f:
        f = VirtualBuyerFlag(buyer_key=key, buyer_name=(body.get("buyer_name") or "")[:128] or None, refunds=0)
        db.add(f)
    f.blacklisted = bool(body.get("blacklisted"))
    f.note = str(body.get("note") or "").strip()[:256] or f.note
    f.staff_id = user.id
    db.commit()
    return {"ok": True}


def buyer_flags(db: Session) -> list[dict]:
    return [{"buyer_key": f.buyer_key, "buyer_name": f.buyer_name, "refunds": f.refunds,
             "blacklisted": f.blacklisted, "note": f.note, "at": _cn(f.updated_at)}
            for f in db.query(VirtualBuyerFlag).order_by(VirtualBuyerFlag.updated_at.desc()).limit(200)]


async def check_sending(db: Session) -> int:
    """发出中的单：问群控那条任务发出去没有。成了 → 已发码；失败 → 回到可以发，码留着重发用。"""
    from app.services.gc_bridge import client as gc

    n = 0
    for o in db.query(VirtualOrder).filter(VirtualOrder.status == "sending", VirtualOrder.send_task_id.isnot(None)):
        try:
            t = await gc.get_task(o.send_task_id)
        except Exception:  # noqa: BLE001
            continue
        st = (t or {}).get("status")
        if st == "SUCCESS":
            o.status = "sent"
            n += 1
        elif st in ("FAILED", "CANCELLED"):
            o.status, o.send_error = "ready", (t.get("error") or "群控没发出去")[:256]
            n += 1
    db.commit()
    return n


async def sync(db: Session) -> dict:
    """一轮：拉付款 → 记单 → 查发出中的 → 自动发货（总开关和卡上开关都开才发）。"""
    from app.services.gc_bridge import client as gc

    ids = sorted({x for (ids_,) in db.query(VirtualProduct.item_ids)
                  .filter(VirtualProduct.state.in_(("on_sale", "paused"))) for x in (ids_ or [])})
    res = {"new": 0, "updated": 0, "checked": 0, "auto_sent": 0}
    if ids:
        rows = await gc.virtual_paid(ids)
        res.update(apply_paid(db, rows if isinstance(rows, list) else []))
    res["checked"] = await check_sending(db)
    if auto_on(db):
        for o in (db.query(VirtualOrder).join(VirtualProduct, VirtualProduct.id == VirtualOrder.product_id)
                  .filter(VirtualOrder.status == "ready", VirtualOrder.send_error.is_(None),
                          VirtualProduct.auto_delivery.is_(True), VirtualProduct.state == "on_sale")
                  .order_by(VirtualOrder.paid_at).limit(20).all()):
            try:
                await send(db, None, o.id, auto=True)
                res["auto_sent"] += 1
            except HTTPException as exc:
                logger.info("虚拟商品自动发货跳过 %s：%s", o.id, exc.detail)
    return res


def set_auto(db: Session, user: Staff, on: bool) -> dict:
    from app.services.app_settings import set_setting

    if not _is_admin(user):
        raise HTTPException(403, "自动发货总开关只有主管能动")
    set_setting(db, AUTO_SETTING, "1" if on else "", user.id)
    db.commit()
    return {"auto_delivery": on}


# ---------------------------------------------------------------- 「今天」里的虚拟单和缺货

def today_tasks(db: Session, user: Staff, now: datetime | None = None) -> list[dict]:
    now = now or datetime.utcnow()
    q = db.query(VirtualProduct).filter(VirtualProduct.state.in_(("on_sale", "pending", "paused")))
    if not _is_admin(user):
        q = q.filter(VirtualProduct.owner_id == user.id)
    prods = {p.id: p for p in q}
    if not prods:
        return []
    out = []
    url = "/pages/virtual/item/index?id={id}"
    for o in (db.query(VirtualOrder).filter(VirtualOrder.product_id.in_(list(prods)),
                                            VirtualOrder.status.in_(("ready", "held", "waiting", "refund")))
              .order_by(VirtualOrder.paid_at)):
        p = prods[o.product_id]
        if o.status == "refund":
            level, sub, btn = "yellow", f"{o.buyer_name or '买家'} 申请退款：去闲鱼处理", "去看"
        else:
            level = "red" if now - o.paid_at > SEND_WITHIN else "yellow"
            why = {"ready": o.send_error and f"上次没发出去：{o.send_error}" or "可以发",
                   "held": "被拦住：" + "；".join(o.hits or []), "waiting": "没码可发，先补货"}[o.status]
            sub, btn = f"{o.buyer_name or '买家'} 付款 {_ago(o.paid_at, now)} · {why}", "去发码"
        out.append({"key": f"virtual:{o.id}", "kind": "virtual", "level": level, "tag": "虚拟",
                    "title": f"发码：{p.name}", "sub": sub, "thumb": None, "url": url.format(id=p.id),
                    "button": btn, "at": o.paid_at.isoformat()})
    stock = stock_of(db, [p.id for p in prods.values() if p.delivery == "card" and p.state == "on_sale"])
    for pid, st in stock.items():
        p = prods[pid]
        if st["avail"] <= p.warn_at:
            red = st["avail"] <= p.stop_at
            out.append({"key": f"virtual-stock:{pid}", "kind": "virtual", "level": "red" if red else "yellow",
                        "tag": "虚拟", "title": f"补货：{p.name}",
                        "sub": f"卡券只剩 {st['avail']} 张" + ("，去闲鱼下架或马上补" if red else ""),
                        "thumb": None, "url": url.format(id=pid), "button": "去补货", "at": ""})
    if _is_admin(user):
        for p in prods.values():
            if p.state == "pending":
                out.append({"key": f"virtual-review:{p.id}", "kind": "virtual", "level": "yellow", "tag": "虚拟",
                            "title": f"批上架：{p.name}", "sub": f"{p.code} 申请上架，看完证据批或退回",
                            "thumb": None, "url": url.format(id=p.id), "button": "去批", "at": ""})
    return out

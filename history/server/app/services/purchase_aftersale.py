"""采购工作台 W12：到货有问题先在平台申请退货退款，等卖家主动提留货（禅道 #58）。

挂在验货异常单（inspection_exception）上：拒签、退回物流、退款到账那几栏原来就有，这里补平台售后这一段。
规矩：
  - 平台申请分开记：准备材料 → 已提交（要有平台回执才算）→ 平台受理；撤销、平台介入也单独记；
  - 平台期限记来源（平台页面上写的 / 自己估的），不能只靠估；
  - 卖家主动提留货补差：记谁先提的、原话、金额和时间；我们提的也记，但分开；
  - 提交了、快到期限卖家还没提留货：提示按规则评估 Plan B，不无限等；
  - 撤销申请不等于留货成交；平台介入没结果不能结案；钱和货两头都结了才能结（原有结案条件）。
"""
from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models import InspectionException, Staff
from app.schemas._tz import utc_to_cn, utc_to_cn_iso

STATUSES = {"none": "还没申请", "preparing": "准备材料", "submitted": "已在平台提交", "accepted": "平台已受理",
            "withdrawn": "已撤销申请", "disputed": "平台介入中", "resolved": "平台已处理完"}
DEADLINE_SOURCES = {"platform": "平台页面上写的", "estimate": "自己估的"}
OFFER_BY = {"seller": "卖家", "us": "我们"}
PLAN_B_HOURS = 24  # 离平台期限不到一天、卖家还没提留货，就提示评估 Plan B


def _money(v) -> Decimal | None:
    if v in (None, ""):
        return None
    try:
        d = Decimal(str(v)).quantize(Decimal("0.01"))
    except InvalidOperation as exc:
        raise HTTPException(status_code=400, detail="金额要填数字") from exc
    if d <= 0:
        raise HTTPException(status_code=400, detail="金额要大于 0")
    return d


def update(row: InspectionException, staff: Staff, *, status: str | None, deadline: datetime | None,
           deadline_source: str | None, receipt: list[str] | None, note: str | None) -> list[str]:
    """改平台售后进度。返回这次改了什么（记留痕用）。"""
    if row.status != "OPEN":
        raise HTTPException(status_code=400, detail="已结束的异常不能再改")
    changes = []
    if receipt:
        row.aftersale_receipt = list(dict.fromkeys((row.aftersale_receipt or []) + receipt))
        changes.append(f"补了 {len(receipt)} 张平台回执")
    if deadline is not None:
        if deadline_source not in DEADLINE_SOURCES:
            raise HTTPException(status_code=400, detail="期限要说清是平台页面上写的还是自己估的")
        row.aftersale_deadline, row.deadline_source = deadline, deadline_source
        changes.append(f"平台期限 {utc_to_cn(deadline):%m-%d %H:%M}（{DEADLINE_SOURCES[deadline_source]}）")
    if status is not None and status != row.aftersale_status:
        if status not in STATUSES:
            raise HTTPException(status_code=400, detail="售后状态不对")
        if status in ("submitted", "accepted") and not row.aftersale_receipt:
            raise HTTPException(status_code=400, detail="没拿到平台回执不能标已提交：先上传申请成功的截图")
        if status in ("withdrawn", "disputed", "resolved") and not (note or "").strip():
            raise HTTPException(status_code=400, detail=f"标「{STATUSES[status]}」要写一句为什么")
        if status == "submitted" and row.aftersale_submitted_at is None:
            row.aftersale_submitted_at = datetime.utcnow()
        row.aftersale_status = status
        changes.append(f"平台售后：{STATUSES[status]}")
    if not changes:
        raise HTTPException(status_code=400, detail="没有要更新的内容")
    return changes


def add_offer(row: InspectionException, staff: Staff, *, by: str, text: str, amount=None) -> str:
    """记一次留货 / 补差的提议：谁提的、原话、金额。"""
    if row.status != "OPEN":
        raise HTTPException(status_code=400, detail="已结束的异常不能再改")
    if by not in OFFER_BY:
        raise HTTPException(status_code=400, detail="谁提的只能是卖家或我们")
    text = (text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="把对方原话贴上")
    amt = _money(amount)
    offers = list(row.keep_offers or [])
    offers.append({"by": by, "text": text[:500], "amount": str(amt) if amt is not None else None,
                   "at": datetime.utcnow().isoformat(timespec="seconds"), "staff_id": staff.id,
                   "first": not offers})
    row.keep_offers = offers
    return f"{OFFER_BY[by]}提留货{f' 补差 {amt} 元' if amt else ''}：{text[:100]}"


def first_offer_by(row: InspectionException) -> str | None:
    offers = row.keep_offers or []
    return offers[0]["by"] if offers else None


def hints(row: InspectionException, now: datetime | None = None) -> list[str]:
    if row.status != "OPEN":
        return []
    now = now or datetime.utcnow()
    out = []
    st = row.aftersale_status or "none"
    if st in ("submitted", "accepted") and row.aftersale_deadline:
        left = row.aftersale_deadline - now
        seller_offered = any(o["by"] == "seller" for o in row.keep_offers or [])
        if left <= timedelta(0):
            out.append("平台期限已经过了，赶紧看平台上的实际状态")
        elif left <= timedelta(hours=PLAN_B_HOURS) and not seller_offered:
            out.append("快到平台期限了，卖家还没提留货：按规则评估 Plan B（留货补差），别干等")
    if st in ("submitted", "accepted") and row.deadline_source == "estimate":
        out.append("期限是自己估的，去平台页面上核一下实际截止时间")
    if st == "withdrawn" and row.refund_status not in ("PARTIAL", "RECEIVED"):
        out.append("申请撤销了不等于留货谈成：补差的钱到没到账要另外记")
    return out


def close_blockers(row: InspectionException) -> list[str]:
    if row.aftersale_status == "disputed":
        return ["平台介入还没结果，不能结束"]
    if row.aftersale_status == "preparing":
        return ["平台售后还在准备材料：提交了、撤销了或不用申请了再结"]
    return []


def out(row: InspectionException) -> dict:
    return {
        "aftersale_status": row.aftersale_status or "none",
        "aftersale_label": STATUSES.get(row.aftersale_status or "none"),
        "aftersale_deadline": utc_to_cn_iso(row.aftersale_deadline),
        "deadline_source": row.deadline_source, "deadline_source_label": DEADLINE_SOURCES.get(row.deadline_source or ""),
        "aftersale_receipt": row.aftersale_receipt or [],
        "aftersale_submitted_at": utc_to_cn_iso(row.aftersale_submitted_at),
        "keep_offers": [{**o, "by_label": OFFER_BY.get(o["by"], o["by"]),
                         "at": utc_to_cn_iso(datetime.fromisoformat(o["at"])) if o.get("at") else None}
                        for o in row.keep_offers or []],
        "first_offer_by": first_offer_by(row),
        "aftersale_hints": hints(row),
    }

"""采购工作台 W11：验货时把卖家原话（商品快照）和实物并排对照（禅道 #57）。

规矩：
  - 检查项按 型号 / 外观 / 功能 / 配件 / 包装 分栏；外观好不掩盖功能坏，缺件单独记；
  - 对照的是下单时的那一版快照：采购冻结的优先，其次下单前抓的，再次下单后最早补抓的（标明是补抓的）；
  - 卖家原来说过的问题勾「已披露」，不算新问题、不进差异工单；
  - 原因不明（运输还是卖家）先标「待判」，不默认卖家负责；
  - 卖家写了全新 / 几乎全新的，提醒按原文和实物逐项细查，不自动套折扣；
  - 差异工单带上是哪几项、对照的哪版快照；不自动建，仓管点一下建（建了会通知业务员和采购）。
"""
from __future__ import annotations

import re

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models import Inspection, InspectionCheckItem, InspectionException, PurchaseOrder
from app.services import inspection_ops as ops
from app.services import purchase_snapshot as snap

DIMENSIONS = {"identity": "型号", "appearance": "外观", "function": "功能", "accessory": "配件", "packaging": "包装"}
CAUSES = {"seller": "卖家没说清", "transport": "运输造成", "unknown": "待判（原因不明）"}
# 示例规范里的 key → 分栏；别的检查项都是功能测试
_KEY_DIMENSION = {"package": "packaging", "packaging": "packaging", "identity": "identity", "accessories": "accessory",
                  "accessory": "accessory", "appearance": "appearance", "screen_look": "appearance"}
_NEW_WORDS = re.compile(r"几乎全新|99新|准新|全新|未拆封|未使用")


def dimension_of(item_key: str, given: str | None = None) -> str:
    if given in DIMENSIONS:
        return given
    return _KEY_DIMENSION.get(item_key, "function")


def pick_snapshot(db: Session, order: PurchaseOrder):
    """对照用哪一版：采购冻结的 → 下单前抓的 → 下单后最早补抓的。"""
    rows = snap.for_order(db, order)
    frozen = [r for r in rows if r.frozen_at is not None]
    if frozen:
        return frozen[0]
    live = [r for r in rows if r.capture_kind == "live"]
    if live:
        return live[0]
    return min(rows, key=lambda r: (r.captured_at or r.created_at, r.version)) if rows else None


def _claims(s) -> dict[str, str]:
    """每一栏卖家原来怎么说的（给仓管对照、预填「卖家说」）。"""
    if s is None:
        return {}
    model = " ".join(x for x in (s.declared_model, s.specs) if x)
    return {k: v for k, v in {
        "identity": model or s.title,
        "appearance": s.condition_text,
        "accessory": s.accessories_text,
        "function": s.description,
        "packaging": s.accessories_text,
    }.items() if v}


def risks(order: PurchaseOrder, s) -> list[str]:
    out = []
    text = " ".join(x for x in ((s.title, s.description, s.condition_text) if s else ()) if x)
    m = _NEW_WORDS.search(text)
    if m:
        out.append(f"卖家写了「{m.group(0)}」：按原文和实物逐项细查，不自动打折")
    elif order.condition_warning:
        out.append(f"采购截图里有「{order.condition_warning_text or '全新'}」：按原文和实物逐项细查，不自动打折")
    if s is not None and s.capture_kind == "late":
        out.append("对照的是下单后补抓的商品页，卖家可能改过，以采购截图为准")
    return out


def compare(db: Session, order: PurchaseOrder, items: list[InspectionCheckItem]) -> dict:
    s = pick_snapshot(db, order)
    groups = []
    for dim, label in DIMENSIONS.items():
        mine = [i for i in items if dimension_of(i.item_key, i.dimension) == dim]
        if mine:
            groups.append({"dimension": dim, "label": label, "keys": [i.item_key for i in mine],
                           "fail": sum(1 for i in mine if i.result == "FAIL"),
                           "disclosed": sum(1 for i in mine if i.result == "FAIL" and i.disclosed)})
    raised = set()
    if items:
        for keys, in db.query(InspectionException.check_item_keys).filter(
                InspectionException.inspection_id == items[0].inspection_id).all():
            raised.update(keys or [])
    return {
        "snapshot": snap.snapshot_out(s) if s else None,
        "claims": _claims(s),
        "risks": risks(order, s),
        "groups": groups,
        # 卖家没说过、还没进差异工单的不通过项
        "new_problems": [i.item_key for i in items if i.result == "FAIL" and not i.disclosed and i.item_key not in raised],
        "raised": sorted(raised),
        "pending_cause": [i.item_key for i in items if i.result == "FAIL" and not i.disclosed and (i.cause or "unknown") == "unknown"],
    }


def raise_from_items(db: Session, task: Inspection, order: PurchaseOrder, keys: list[str], user_id: str):
    """把选中的、卖家没说过的不通过项建成差异工单（这张单已有没结的就追加上去）。"""
    items = {i.item_key: i for i in ops.check_items(db, task.id)}
    picked = [items[k] for k in keys if k in items]
    if not picked:
        raise HTTPException(status_code=400, detail="选几个不通过的检查项")
    bad = [i.title for i in picked if i.result != "FAIL"]
    if bad:
        raise HTTPException(status_code=400, detail=f"「{bad[0]}」不是不通过，不能建差异工单")
    told = [i.title for i in picked if i.disclosed]
    if told:
        raise HTTPException(status_code=400, detail=f"「{told[0]}」卖家原来说过，不算新问题")
    lines = []
    for i in picked:
        cause = CAUSES.get(i.cause or "unknown")
        lines.append(f"【{DIMENSIONS[dimension_of(i.item_key, i.dimension)]}】{i.title}"
                     + (f"：{i.defect_part}" if i.defect_part else "") + (f"，{i.note}" if i.note else "")
                     + (f"（卖家说：{i.seller_claim}）" if i.seller_claim else "") + f"；原因：{cause}")
    kinds = {i.cause for i in picked}
    exc_type = "DAMAGED" if kinds == {"transport"} else "MISMATCH"
    exc = ops.raise_exception(db, task, order, exception_type=exc_type, description="\n".join(lines), user_id=user_id)
    exc.check_item_keys = list(dict.fromkeys((exc.check_item_keys or []) + [i.item_key for i in picked]))
    s = pick_snapshot(db, order)
    if s is not None and not exc.snapshot_id:
        exc.snapshot_id = s.id
    return exc

"""客户退回的货重新验一遍，并把这件货历次的照片视频按时间排在一起（禅道 WH10-07/08/10）。

检查项照搬原验货单的（同一套标准才能对照），原单没逐项验过就用当前匹配的规范，再没有就用通用四项。
开了「退货入库前必须复验」：没做完复验不能收货入库；复验发现问题只能标异常挂起，等管理员裁决恢复在库或报损。
复验发现问题这一条不看开关一律拦（和出库复核「发现新问题」一样）。
"""
from __future__ import annotations

from datetime import datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models import (
    Inspection,
    InspectionCheckItem,
    InspectionEvidence,
    OutboundReview,
    PurchaseOrder,
    ReturnOrder,
    ReturnRecheck,
    SalesOutbound,
    Sku,
)
from app.services import inspection_ops as ops
from app.services.oss_media import is_video_url, sign_media_payload

RETURN_RECHECK_REQUIRED = "return_recheck_required"
RESULTS = ("OK", "PROBLEM")

_GENERIC_STEPS = [
    {"key": "identity", "title": "型号与序列号", "guide": "核对是不是我们发出去的那件：拍铭牌或序列号。", "need_photo": True},
    {"key": "accessories", "title": "配件清点", "guide": "对照发货时的配件逐件清点，缺什么写明。", "need_photo": False},
    {"key": "appearance", "title": "外观", "guide": "和入库照片比，有没有新的磕碰划痕，新瑕疵逐处拍照。", "need_photo": True},
    {"key": "function", "title": "功能", "guide": "通电把主要功能试一遍，客户说的问题重点测。", "need_photo": False},
]

_EVIDENCE_LABELS = {"UNBOX_VIDEO": "开箱视频", "PRODUCT_PHOTO": "商品照", "DEFECT_PHOTO": "瑕疵照"}


def _inspection_of(db: Session, sku: Sku) -> Inspection | None:
    # 按这件货自己的验货单找：一单多件时同一采购单有好几张
    return db.get(Inspection, sku.inspection_id) if sku.inspection_id else None


def build_items(db: Session, sku: Sku) -> tuple[Inspection | None, list[dict]]:
    task = _inspection_of(db, sku)
    before = ops.check_items(db, task.id) if task else []
    if before:
        steps = [
            {"key": i.item_key, "title": i.title, "guide": i.guide, "need_photo": bool(i.need_photo),
             "before_result": i.result, "before_note": i.note}
            for i in before
        ]
    else:
        order = db.get(PurchaseOrder, sku.purchase_order_id)
        template = ops.match_template(db, order) if order else None
        steps = [
            {"key": s["key"], "title": s["title"], "guide": s.get("guide"), "need_photo": bool(s.get("need_photo")),
             "standard": s.get("standard")}
            for s in (template.steps if template else _GENERIC_STEPS)
        ]
    for s in steps:
        s.update({"result": None, "note": None, "evidence": [], "checked_at": None})
    return task, steps


def get(db: Session, return_id: str) -> ReturnRecheck | None:
    return db.query(ReturnRecheck).filter(ReturnRecheck.return_order_id == return_id).first()


def start(db: Session, ret: ReturnOrder, sku: Sku, user_id: str) -> ReturnRecheck:
    row = get(db, ret.id)
    if row:
        return row
    task, items = build_items(db, sku)
    row = ReturnRecheck(
        return_order_id=ret.id, sku_id=sku.id, inspection_id=task.id if task else None,
        items=items, media=[], created_by=user_id,
    )
    db.add(row)
    db.flush()
    return row


def record_item(row: ReturnRecheck, key: str, *, result: str, note: str | None, evidence: list, user_id: str) -> None:
    if row.finished_at:
        raise HTTPException(status_code=400, detail="复验已经做完，不能再改")
    items = [dict(i) for i in row.items or []]
    item = next((i for i in items if i["key"] == key), None)
    if not item:
        raise HTTPException(status_code=404, detail="没有这一项")
    ops.validate_item(result, note, evidence, item.get("need_photo", False))
    item.update({"result": result, "note": (note or "").strip() or None, "evidence": evidence,
                 "checked_by": user_id, "checked_at": datetime.utcnow().isoformat(timespec="seconds")})
    row.items = items  # 整列换掉，JSON 原地改 SQLAlchemy 看不出来


def finish(row: ReturnRecheck, *, result: str, note: str | None, media: list, user_id: str) -> None:
    if row.finished_at:
        raise HTTPException(status_code=400, detail="复验已经做完")
    if result not in RESULTS:
        raise HTTPException(status_code=400, detail="结论要选「和入库时一致」或「发现问题」")
    left = [i["title"] for i in row.items or [] if not i.get("result")]
    if left:
        raise HTTPException(status_code=400, detail=f"还有 {len(left)} 项没验：{'、'.join(left[:5])}")
    failed = [i["title"] for i in row.items or [] if i.get("result") == "FAIL"]
    if result == "OK" and failed:
        raise HTTPException(status_code=400, detail=f"有不通过的项（{'、'.join(failed[:3])}），结论要选「发现问题」")
    note = (note or "").strip() or None
    if result == "PROBLEM" and not note:
        raise HTTPException(status_code=400, detail="发现问题要写明是什么问题")
    row.result, row.note, row.media = result, note, media
    row.finished_by, row.finished_at = user_id, datetime.utcnow()


def assert_receivable(db: Session, ret: ReturnOrder, mark_abnormal: bool) -> None:
    """收货入库前的门槛。标异常挂起的不拦（挂起不恢复库存，管理员裁决时能看到复验）。"""
    if mark_abnormal:
        return
    row = get(db, ret.id)
    if row and row.finished_at and row.result == "PROBLEM":
        raise HTTPException(status_code=400, detail=f"复验发现问题（{row.note}），只能标记异常挂起，等管理员裁决")
    if ops.setting_on(db, RETURN_RECHECK_REQUIRED) and not (row and row.finished_at):
        raise HTTPException(status_code=400, detail="退回的货要先在 H5「退回复验」验完才能入库")


def media_history(db: Session, sku: Sku) -> list[dict]:
    """这件货从入库到退回的照片视频，按时间排（禅道 WH10-08）。只读汇总，不另存。"""
    out: list[dict] = []

    def add(at, stage, url, label=None, note=None):
        if url:
            out.append({"at": at, "stage": stage, "label": label, "url": url, "is_video": is_video_url(url), "note": note})

    task = _inspection_of(db, sku)
    ev_q = db.query(InspectionEvidence).filter(
        (InspectionEvidence.sku_id == sku.id) | (InspectionEvidence.inspection_id == (task.id if task else ""))
    )
    for ev in ev_q.all():
        add(ev.started_at or ev.created_at, "入库验货", ev.url, _EVIDENCE_LABELS.get(ev.kind, ev.kind),
            ev.gap_note if ev.interrupted else None)
    if task:
        for item in db.query(InspectionCheckItem).filter(InspectionCheckItem.inspection_id == task.id).all():
            for url in item.evidence or []:
                add(item.checked_at, "入库验货", url, item.title, item.note)
    for rv in db.query(OutboundReview).filter(OutboundReview.sku_id == sku.id).all():
        for url in rv.media or []:
            add(rv.created_at, "发货前复核", url, "发现问题" if rv.result == "PROBLEM" else "当前货况", rv.remark)
    for ob in db.query(SalesOutbound).filter(SalesOutbound.sku_id == sku.id).all():
        for url in ob.evidence_urls or []:
            add(ob.created_at, "出库", url, "出库凭证")
    returns = db.query(ReturnOrder).filter(ReturnOrder.sku_id == sku.id).all()
    for ret in returns:
        for url in ret.received_media or []:
            add(ret.received_at or ret.created_at, "退回收货", url, ret.return_no, ret.received_remark)
    for rc in db.query(ReturnRecheck).filter(ReturnRecheck.sku_id == sku.id).all():
        for item in rc.items or []:
            at = datetime.fromisoformat(item["checked_at"]) if item.get("checked_at") else rc.created_at
            for url in item.get("evidence") or []:
                add(at, "退回复验", url, item.get("title"), item.get("note"))
        for url in rc.media or []:
            add(rc.finished_at or rc.created_at, "退回复验", url, "复验结论", rc.note)
    out.sort(key=lambda r: r["at"] or datetime.min)
    for r in out:
        r["url"] = sign_media_payload(r["url"])
    return out

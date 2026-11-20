from datetime import datetime, timezone

from pydantic import BaseModel, Field
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user, require_roles
from app.enums import InspectionStatus, SkuStatus, StaffRole
from app.models import (
    Inspection,
    InspectionCheckItem,
    InspectionCheckItemLog,
    InspectionEvidence,
    InspectionException,
    InspectionExceptionEvent,
    InspectionTemplate,
    OutboundReview,
    PurchaseOrder,
    ReturnOrder,
    Sku,
    Staff,
)
from app.schemas._tz import utc_to_cn_iso
from app.schemas.inspection_ops import (
    CheckItemUpdate,
    CheckStart,
    EvidenceIn,
    ExceptionClose,
    ExceptionIn,
    ExceptionProgress,
    PurchaserEvidenceIn,
    RecheckFinishIn,
    RecheckItemIn,
    ReviewIn,
    SettingsIn,
    TemplateIn,
)
from app.services import inspection_ops as ops
from app.services import inspection_compare as cmp
from app.services import purchase_aftersale as aftersale
from app.services.purchase_platform import _when as cn_to_utc
from app.services import purchase_pieces
from app.services import return_recheck
from app.services.app_settings import set_setting
from app.services.inspection_templates_demo import DEMO_TEMPLATES
from app.services.oss_media import is_video_url, sign_media_payload, strip_oss_signature
from app.services.staff_lookup import map_staff_names

router = APIRouter(prefix="/api/inspection-ops", tags=["inspection-ops"])

_WAREHOUSE = (StaffRole.WAREHOUSE, StaffRole.ADMIN)
# 看凭证的人：采购议价、销售发货
_EVIDENCE_READERS = (StaffRole.WAREHOUSE, StaffRole.PURCHASER, StaffRole.NEGOTIATOR, StaffRole.BUSINESS, StaffRole.SALES)
# 看得到所有异常的角色；采购员只看自己的单
_EXCEPTION_READERS = (StaffRole.ADMIN, StaffRole.WAREHOUSE, StaffRole.BUSINESS)


def _urls(values: list[str] | None) -> list[str]:
    return [strip_oss_signature(u) or u for u in (values or []) if u]


def _load_task(db: Session, task_id: str) -> tuple[Inspection, PurchaseOrder]:
    task = db.get(Inspection, task_id)
    if not task or task.deleted_at:
        raise HTTPException(status_code=404, detail="验货任务不存在")
    order = db.get(PurchaseOrder, task.purchase_order_id)
    if not order:
        raise HTTPException(status_code=400, detail="采购订单不存在")
    return task, order


def _template_out(row: InspectionTemplate) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "category": row.category,
        "brand": row.brand,
        "model": row.model,
        "keywords": row.keywords or [],
        "steps": [{**st, "video_play": sign_media_payload(st.get("video_url")) if st.get("video_url") else None} for st in row.steps or []],
        "version": row.version,
        "enabled": row.enabled,
    }


def _tutorials(db: Session, items: list[InspectionCheckItem]) -> dict[str, dict]:
    """检查项对应的教程视频和判定标准：读规范上现在的那份（换了视频在办的单子也看得到新的）。"""
    out: dict[str, dict] = {}
    for tid in {i.template_id for i in items if i.template_id}:
        tpl = db.get(InspectionTemplate, tid)
        for step in (tpl.steps or []) if tpl else []:
            if step.get("video_url") or step.get("standard"):
                out[step["key"]] = {"video_url": sign_media_payload(step.get("video_url")), "standard": step.get("standard")}
    return out


def _item_out(row: InspectionCheckItem, hints: dict[str, str] | None = None, changes: dict[str, int] | None = None,
              tutorials: dict[str, dict] | None = None) -> dict:
    tut = (tutorials or {}).get(row.item_key) or {}
    return {
        "video_url": tut.get("video_url"),
        "standard": tut.get("standard"),
        "review_hint": (hints or {}).get(row.item_key),
        "changed_times": (changes or {}).get(row.item_key, 0),
        "item_key": row.item_key,
        "title": row.title,
        "guide": row.guide,
        "need_photo": row.need_photo,
        "result": row.result,
        "note": row.note,
        "defect_part": row.defect_part,
        "seller_claim": row.seller_claim,
        "dimension": cmp.dimension_of(row.item_key, row.dimension),
        "dimension_label": cmp.DIMENSIONS[cmp.dimension_of(row.item_key, row.dimension)],
        "disclosed": bool(row.disclosed),
        "cause": row.cause,
        "cause_label": cmp.CAUSES.get(row.cause) if row.cause else None,
        "evidence": sign_media_payload(row.evidence or []),
        "checked_at": utc_to_cn_iso(row.checked_at),
    }


def _change_counts(db: Session, inspection_id: str) -> dict[str, int]:
    rows = (
        db.query(InspectionCheckItemLog.item_key, func.count(InspectionCheckItemLog.id))
        .filter(InspectionCheckItemLog.inspection_id == inspection_id, InspectionCheckItemLog.action != "FILL")
        .group_by(InspectionCheckItemLog.item_key)
        .all()
    )
    return dict(rows)


_ACTION_LABEL = {"FILL": "填写", "CHANGE": "改答案", "RETEST": "补测"}
_RESULT_LABEL = {"PASS": "通过", "FAIL": "不通过", "UNTESTABLE": "无法测试", None: "空"}


def _item_history(db: Session, inspection_id: str, items: list[InspectionCheckItem]) -> list[dict]:
    """改答案和补测的记录（第一次填写不列，太多）。"""
    logs = (
        db.query(InspectionCheckItemLog)
        .filter(InspectionCheckItemLog.inspection_id == inspection_id, InspectionCheckItemLog.action != "FILL")
        .order_by(InspectionCheckItemLog.created_at.desc())
        .all()
    )
    titles = {i.item_key: i.title for i in items}
    names = map_staff_names(db, {lg.operator_id for lg in logs if lg.operator_id})
    return [
        {
            "item": titles.get(lg.item_key, lg.item_key),
            "action": _ACTION_LABEL.get(lg.action, lg.action),
            "from": _RESULT_LABEL.get(lg.old_result, lg.old_result),
            "to": _RESULT_LABEL.get(lg.new_result, lg.new_result),
            "old_note": lg.old_note,
            "operator": names.get(lg.operator_id),
            "at": utc_to_cn_iso(lg.created_at),
        }
        for lg in logs
    ]


def _evidence_out(row: InspectionEvidence, names: dict[str, str]) -> dict:
    return {
        "id": row.id,
        "inspection_id": row.inspection_id,
        "sku_id": row.sku_id,
        "kind": row.kind,
        "url": sign_media_payload(row.url),
        "is_video": is_video_url(row.url),
        "item_key": row.item_key,
        "duration_seconds": row.duration_seconds,
        "size_bytes": row.size_bytes,
        "device_label": row.device_label,
        "started_at": utc_to_cn_iso(row.started_at),
        "interrupted": bool(row.interrupted),
        "gap_note": row.gap_note,
        "recorded_by_name": names.get(row.recorded_by),
        "created_at": utc_to_cn_iso(row.created_at),
    }


def _exception_out(
    row: InspectionException,
    names: dict[str, str],
    order: PurchaseOrder | None = None,
    notices: dict[str, str | None] | None = None,
) -> dict:
    return {
        "id": row.id,
        "inspection_id": row.inspection_id,
        "order_no": order.order_no if order else None,
        "product_name": order.product_name if order else None,
        "exception_type": row.exception_type,
        "description": row.description,
        "status": row.status,
        "raised_at": utc_to_cn_iso(row.raised_at),
        "raised_by_name": names.get(row.raised_by),
        "handler_id": row.handler_id,
        "handler_name": names.get(row.handler_id),
        "purchaser_id": row.purchaser_id,
        "purchaser_name": names.get(row.purchaser_id),
        "due_at": utc_to_cn_iso(row.due_at),
        "overdue": row.status == "OPEN" and bool(ops.overdue_parts(row)) and row.due_at <= datetime.utcnow(),
        "overdue_parts": ops.overdue_parts(row) if row.status == "OPEN" else [],
        "handler_ack_at": utc_to_cn_iso(row.handler_ack_at),
        "purchaser_evidence_at": utc_to_cn_iso(row.purchaser_evidence_at),
        "purchaser_evidence": sign_media_payload(row.purchaser_evidence or []),
        "escalated_at": utc_to_cn_iso(row.escalated_at),
        "reject_status": row.reject_status,
        "return_tracking_no": row.return_tracking_no,
        "return_carrier": row.return_carrier,
        "return_station": row.return_station,
        "return_logistics": row.return_logistics,
        "return_sign_evidence": sign_media_payload(row.return_sign_evidence or []),
        "refund_status": row.refund_status,
        "refund_amount": str(row.refund_amount) if row.refund_amount is not None else None,
        "refund_fee": str(row.refund_fee) if row.refund_fee is not None else None,
        "refund_shortfall_reason": row.refund_shortfall_reason,
        "purchase_amount": str(order.unit_price) if order is not None and order.unit_price is not None else None,
        "needs_takeover": row.status == "OPEN" and (row.return_logistics == "ABNORMAL" or row.refund_status == "DENIED"),
        "final_result": row.final_result,
        "check_item_keys": row.check_item_keys or [],
        "snapshot_id": row.snapshot_id,
        **aftersale.out(row),
        "closed_at": utc_to_cn_iso(row.closed_at),
        # 通知实际送到没有，一句话；页面不能凭空写「已通知」
        "notice": (notices or {}).get(row.id),
    }


def _exception_notices(db: Session, rows: list[InspectionException]) -> dict[str, str | None]:
    ids = [r.id for r in rows]
    if not ids:
        return {}
    events = db.query(InspectionExceptionEvent).filter(InspectionExceptionEvent.exception_id.in_(ids)).all()
    grouped: dict[str, list] = {}
    for e in events:
        grouped.setdefault(e.exception_id, []).append(e)
    return {i: ops.notice_summary(grouped.get(i, [])) for i in ids}


def _exception_names(db: Session, rows: list[InspectionException]) -> dict[str, str]:
    ids = {x for r in rows for x in (r.raised_by, r.handler_id, r.purchaser_id) if x}
    return map_staff_names(db, ids)


def _load_exception(db: Session, exception_id: str, user: Staff) -> InspectionException:
    row = db.get(InspectionException, exception_id)
    # 看不到的也回 404：后台页面收到 403 会把人踢回登录页
    if not row or not _can_see(row, user):
        raise HTTPException(status_code=404, detail="异常记录不存在")
    return row


def _can_see(row: InspectionException, user: Staff) -> bool:
    return user.role in _EXCEPTION_READERS or user.id == row.purchaser_id


# ---------- 开关 ----------


@router.get("/settings", summary="验货与出库复核开关")
def read_settings(db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    return {
        "full_check_required": ops.setting_on(db, ops.FULL_CHECK_REQUIRED),
        "outbound_review_required": ops.setting_on(db, ops.OUTBOUND_REVIEW_REQUIRED),
        "return_recheck_required": ops.setting_on(db, return_recheck.RETURN_RECHECK_REQUIRED),
        "can_edit": user.role == StaffRole.ADMIN,
        "my_id": user.id,
        "my_role": user.role,
    }


@router.put("/settings", summary="修改验货与出库复核开关")
def write_settings(
    body: SettingsIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    set_setting(db, ops.FULL_CHECK_REQUIRED, "1" if body.full_check_required else "0", user.id)
    set_setting(db, ops.OUTBOUND_REVIEW_REQUIRED, "1" if body.outbound_review_required else "0", user.id)
    set_setting(db, return_recheck.RETURN_RECHECK_REQUIRED, "1" if body.return_recheck_required else "0", user.id)
    return read_settings(db, user)


# ---------- 验货规范 ----------


def _clean_template(body: TemplateIn) -> dict:
    data = body.model_dump()
    if not data["name"].strip() or not data["category"].strip():
        raise HTTPException(status_code=400, detail="名称和品类不能为空")
    keys = [s["key"].strip() for s in data["steps"]]
    if not keys or not all(keys) or not all(s["title"].strip() for s in data["steps"]):
        raise HTTPException(status_code=400, detail="至少一个检查项，且名称不能为空")
    if len(set(keys)) != len(keys):
        raise HTTPException(status_code=400, detail="检查项标识不能重复")
    data["brand"] = (data["brand"] or "").strip() or None
    data["model"] = (data["model"] or "").strip() or None
    for step in data["steps"]:
        # 教程视频存干净地址（页面上拿到的是带签名的），判定标准空串当没有
        step["video_url"] = strip_oss_signature(step.get("video_url")) or None if step.get("video_url") else None
        step["standard"] = (step.get("standard") or "").strip() or None
    return data


@router.get("/templates", summary="验货规范列表")
def list_templates(db: Session = Depends(get_db), _: Staff = Depends(get_current_user)):
    rows = db.query(InspectionTemplate).order_by(InspectionTemplate.category, InspectionTemplate.name).all()
    return [_template_out(r) for r in rows]


@router.post("/templates", summary="新建验货规范")
def create_template(
    body: TemplateIn,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    row = InspectionTemplate(**_clean_template(body), version=1)
    db.add(row)
    db.commit()
    return _template_out(row)


@router.put("/templates/{template_id}", summary="修改验货规范（版本加一，已开始的验货单不受影响）")
def update_template(
    template_id: str,
    body: TemplateIn,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    row = db.get(InspectionTemplate, template_id)
    if not row:
        raise HTTPException(status_code=404, detail="规范不存在")
    for key, value in _clean_template(body).items():
        setattr(row, key, value)
    row.version += 1
    db.commit()
    return _template_out(row)


@router.post("/templates/seed-demo", summary="补上缺的示例规范（按名字，已有的不动）")
def seed_demo_templates(db: Session = Depends(get_db), _: Staff = Depends(require_roles(StaffRole.ADMIN))):
    have = {name for (name,) in db.query(InspectionTemplate.name).all()}
    added = [data for data in DEMO_TEMPLATES if data["name"] not in have]
    for data in added:
        db.add(InspectionTemplate(**data, version=1, enabled=True))
    db.commit()
    return {"count": len(added), "names": [d["name"] for d in added]}


# ---------- 逐项验货 ----------


@router.get("/tasks/{task_id}/check", summary="验货单的规范、检查项、凭证、异常")
def read_check(
    task_id: str,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(*_WAREHOUSE)),
):
    task, order = _load_task(db, task_id)
    items = ops.check_items(db, task.id)
    evidence = (
        db.query(InspectionEvidence)
        .filter(InspectionEvidence.inspection_id == task.id)
        .order_by(InspectionEvidence.created_at)
        .all()
    )
    exceptions = db.query(InspectionException).filter(InspectionException.inspection_id == task.id).all()
    matched = ops.match_template(db, order) if not items else None
    names = {**map_staff_names(db, {e.recorded_by for e in evidence}), **_exception_names(db, exceptions)}
    notices = _exception_notices(db, exceptions)
    return {
        "task": {
            "id": task.id,
            "inspect_no": task.inspect_no,
            "status": task.status,
            "order_no": order.order_no,
            "product_name": order.product_name,
            "brand": order.brand,
            "model": order.model,
            "spec": order.spec,
            "piece_label": purchase_pieces.piece_label(order, task),
        },
        "matched_template": _template_out(matched) if matched else None,
        "items": [_item_out(i, ops.review_hints(db, task.id, items), _change_counts(db, task.id), _tutorials(db, items)) for i in items],
        "full_check": ops.full_check_state(items),
        "unbox_gap": ops.unbox_gap(db, task.id) if items else None,
        "evidence": [_evidence_out(e, names) for e in evidence],
        "exceptions": [_exception_out(e, names, order, notices) for e in exceptions],
        "history": _item_history(db, task.id, items),
        # W11：卖家原话（下单时那版快照）和实物对照、分栏、风险提醒
        "compare": cmp.compare(db, order, items),
    }


@router.post("/tasks/{task_id}/check/start", summary="按规范开始逐项验货")
def start_check(
    task_id: str,
    body: CheckStart,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(*_WAREHOUSE)),
):
    task, order = _load_task(db, task_id)
    if task.status != InspectionStatus.PENDING:
        raise HTTPException(status_code=400, detail="这张验货单已经完成")
    if ops.check_items(db, task.id):
        raise HTTPException(status_code=400, detail="已经开始了")
    template = db.get(InspectionTemplate, body.template_id) if body.template_id else ops.match_template(db, order)
    if not template or not template.enabled:
        raise HTTPException(status_code=400, detail="没有对应的验货规范，请先选一个")
    ops.start_check(db, task, order, template)
    try:
        db.commit()
    except IntegrityError:  # 两个人同时点开始
        db.rollback()
        raise HTTPException(status_code=400, detail="已经开始了") from None
    return [_item_out(i) for i in ops.check_items(db, task.id)]


@router.put("/tasks/{task_id}/check/{item_key}", summary="记录一个检查项的结果")
def update_check_item(
    task_id: str,
    item_key: str,
    body: CheckItemUpdate,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_WAREHOUSE)),
):
    task, _order = _load_task(db, task_id)
    item = (
        db.query(InspectionCheckItem)
        .filter(InspectionCheckItem.inspection_id == task.id, InspectionCheckItem.item_key == item_key)
        .first()
    )
    if not item:
        raise HTTPException(status_code=404, detail="检查项不存在")
    evidence = _urls(body.evidence)
    ops.record_item(db, task, item, result=body.result, note=body.note, evidence=evidence, user_id=user.id,
                    defect_part=body.defect_part, seller_claim=body.seller_claim,
                    disclosed=body.disclosed, cause=body.cause)
    db.commit()
    items = ops.check_items(db, task.id)
    return _item_out(item, ops.review_hints(db, task.id, items), _change_counts(db, task.id))


@router.get("/retests", summary="补测待办：已提交但有「无法测试」项目的验货单")
def list_retests(db: Session = Depends(get_db), _: Staff = Depends(require_roles(*_WAREHOUSE))):
    rows = (
        db.query(InspectionCheckItem)
        .filter(InspectionCheckItem.result == "UNTESTABLE")
        .order_by(InspectionCheckItem.checked_at)
        .all()
    )
    by_task: dict[str, list[InspectionCheckItem]] = {}
    for r in rows:
        by_task.setdefault(r.inspection_id, []).append(r)
    out = []
    for task_id, items in by_task.items():
        task = db.get(Inspection, task_id)
        # 补测待办只看已提交的单；验货中的「无法测试」还在逐项页里做。删了的单点进去 404、留在列表里删不掉
        if task is None or task.status == InspectionStatus.PENDING or task.deleted_at is not None:
            continue
        sku = db.query(Sku).filter(Sku.inspection_id == task.id).first()
        # 拒签 / 没到货（没入库就没有货）、已经出库 / 报损的，货不在手上，补测不了
        if sku is None or sku.status not in (SkuStatus.IN_STOCK, SkuStatus.RESERVED):
            continue
        order = db.get(PurchaseOrder, task.purchase_order_id)
        out.append({
            "task_id": task.id,
            "inspect_no": task.inspect_no,
            "submitted": task.status != InspectionStatus.PENDING,
            "order_no": order.order_no if order else None,
            "product_name": order.product_name if order else None,
            "sku_code": sku.sku_code if sku else None,
            "sku_status": sku.status if sku else None,
            "items": [{"item_key": i.item_key, "title": i.title, "note": i.note} for i in items],
            "since": utc_to_cn_iso(items[0].checked_at),
        })
    return {"items": out, "total": len(out)}


# ---------- 凭证 ----------


@router.post("/tasks/{task_id}/evidence", summary="登记开箱视频或照片")
def add_evidence(
    task_id: str,
    body: EvidenceIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_WAREHOUSE)),
):
    task, order = _load_task(db, task_id)
    if body.kind not in ops.EVIDENCE_KINDS:
        raise HTTPException(status_code=400, detail="凭证类型不正确")
    if not body.url.startswith("http"):
        raise HTTPException(status_code=400, detail="凭证地址不正确")
    url = strip_oss_signature(body.url) or body.url
    # 重试上传沿用同一个文件名：同一个地址只登记一次，不重复归档
    dup = db.query(InspectionEvidence).filter(InspectionEvidence.inspection_id == task.id, InspectionEvidence.url == url).first()
    if dup is not None:
        return _evidence_out(dup, map_staff_names(db, {dup.recorded_by}))
    # 确认文件真的传上去了、大小对得上，才算凭证（禅道 WH04-15）
    problem = ops.check_uploaded(url, body.size_bytes)
    if problem:
        raise HTTPException(status_code=400, detail=problem)
    started = None
    if body.started_at:
        try:
            started = datetime.fromisoformat(body.started_at.replace("Z", "+00:00"))
            started = started.astimezone(timezone.utc).replace(tzinfo=None) if started.tzinfo else started
        except ValueError:
            started = None
    sku = db.query(Sku).filter(Sku.inspection_id == task.id).first()
    row = InspectionEvidence(
        inspection_id=task.id,
        purchase_order_id=order.id,
        sku_id=sku.id if sku else None,
        kind=body.kind,
        url=url,
        item_key=body.item_key,
        duration_seconds=body.duration_seconds,
        size_bytes=body.size_bytes,
        device_label=(body.device_label or "")[:128] or None,
        started_at=started,
        interrupted=body.interrupted,
        gap_note=(body.gap_note or "").strip()[:255] or None,
        recorded_by=user.id,
    )
    db.add(row)
    db.commit()
    return _evidence_out(row, {user.id: user.name})


@router.get("/evidence", summary="按货号、采购单号、验货单号查凭证")
def search_evidence(
    q: str = Query(min_length=1),
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(*_EVIDENCE_READERS)),
):
    q = q.strip()
    query = db.query(InspectionEvidence)
    sku = db.query(Sku).filter(Sku.sku_code == q).first()
    order = db.query(PurchaseOrder).filter(PurchaseOrder.order_no == q).first()
    task = db.query(Inspection).filter(Inspection.inspect_no == q).first()
    if sku:
        query = query.filter(InspectionEvidence.sku_id == sku.id)
    elif order:
        query = query.filter(InspectionEvidence.purchase_order_id == order.id)
    elif task:
        query = query.filter(InspectionEvidence.inspection_id == task.id)
    else:
        return []
    rows = query.order_by(InspectionEvidence.created_at).all()
    names = map_staff_names(db, {r.recorded_by for r in rows})
    return [_evidence_out(r, names) for r in rows]


@router.get("/orders/{order_no}/inspection", summary="采购单的验货结果：不通过项（部位、卖家描述 vs 实测）、凭证、异常")
def order_inspection(
    order_no: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_EVIDENCE_READERS)),
    piece: int | None = None,  # 一单多件时看第几件，默认第 1 件
):
    order = db.query(PurchaseOrder).filter(PurchaseOrder.order_no == order_no).first()
    if not order:
        raise HTTPException(status_code=404, detail="采购单不存在")
    tasks = purchase_pieces.tasks_of(db, order)
    task = next((t for t in tasks if t.piece_no == piece), None) if piece else (tasks[0] if tasks else None)
    # 一单多件：凭证按件分开，页面上切换看哪一件
    pieces = [
        {"piece_no": t.piece_no, "label": purchase_pieces.piece_label(order, t), "status": t.status, "action_type": t.action_type}
        for t in tasks
    ] if (order.quantity or 1) > 1 else []
    if not task:
        return {"order_no": order.order_no, "product_name": order.product_name, "task": None, "items": [], "evidence": [],
                "exceptions": [], "pieces": pieces, "piece_no": None}
    items = ops.check_items(db, task.id)
    evidence = db.query(InspectionEvidence).filter(InspectionEvidence.inspection_id == task.id).order_by(InspectionEvidence.created_at).all()
    exceptions = db.query(InspectionException).filter(InspectionException.inspection_id == task.id).all()
    names = {**map_staff_names(db, {e.recorded_by for e in evidence}), **_exception_names(db, exceptions)}
    sku = db.query(Sku).filter(Sku.inspection_id == task.id).first()
    return {
        "order_no": order.order_no,
        "product_name": order.product_name,
        "unit_price": str(order.unit_price) if order.unit_price is not None else None,
        "piece_cost": str(purchase_pieces.piece_cost(order, task.piece_no)),
        "pieces": pieces,
        "piece_no": task.piece_no,
        "sku_code": sku.sku_code if sku else None,
        "task": {"inspect_no": task.inspect_no, "status": task.status, "inspection_result": task.inspection_result,
                 "mismatch_remark": task.mismatch_remark,
                 "defect_images": sign_media_payload(task.defect_images or []),
                 "defect_videos": sign_media_payload(task.defect_videos or [])},
        "full_check": ops.full_check_state(items),
        # 采购议价只看有问题的项
        "items": [_item_out(i) for i in items if i.result in ("FAIL", "UNTESTABLE")],
        "evidence": [_evidence_out(e, names) for e in evidence],
        # can_edit：H5 上能不能改平台售后、记留货提议（和接口的 _can_see 一个口径）
        "exceptions": [{**_exception_out(e, names, order, _exception_notices(db, exceptions)),
                        "can_edit": e.status == "OPEN" and _can_see(e, user)} for e in exceptions],
    }


# ---------- 异常 ----------


@router.post("/tasks/{task_id}/exceptions", summary="登记异常并通知业务员、采购员（验货继续）")
def raise_exception(
    task_id: str,
    body: ExceptionIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_WAREHOUSE)),
    background: BackgroundTasks = None,
):
    if body.exception_type not in ops.EXCEPTION_TYPES:
        raise HTTPException(status_code=400, detail="异常类型不正确")
    task, order = _load_task(db, task_id)
    row = ops.raise_exception(
        db, task, order, exception_type=body.exception_type, description=body.description, user_id=user.id
    )
    db.commit()
    if background is not None:  # 直接调函数（单测）时没有
        background.add_task(ops.deliver_in_background)
    return _exception_out(row, _exception_names(db, [row]), order, _exception_notices(db, [row]))


class FromItemsIn(BaseModel):
    item_keys: list[str] = Field(min_length=1, max_length=50)


@router.post("/tasks/{task_id}/exceptions/from-items", summary="把卖家没说过的不通过项建成差异工单（带上是哪几项、对照的哪版快照）")
def raise_from_items(
    task_id: str,
    body: FromItemsIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_WAREHOUSE)),
    background: BackgroundTasks = None,
):
    task, order = _load_task(db, task_id)
    row = cmp.raise_from_items(db, task, order, body.item_keys, user.id)
    db.commit()
    if background is not None:
        background.add_task(ops.deliver_in_background)
    return _exception_out(row, _exception_names(db, [row]), order, _exception_notices(db, [row]))


@router.get("/exceptions", summary="异常列表")
def list_exceptions(
    status: str | None = None,
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    query = db.query(InspectionException)
    if status:
        query = query.filter(InspectionException.status == status)
    if user.role not in _EXCEPTION_READERS:
        query = query.filter(InspectionException.purchaser_id == user.id)
    rows = query.order_by(InspectionException.raised_at.desc()).limit(200).all()
    names = _exception_names(db, rows)
    notices = _exception_notices(db, rows)
    orders = {o.id: o for o in db.query(PurchaseOrder).filter(PurchaseOrder.id.in_({r.purchase_order_id for r in rows}))}
    return [_exception_out(r, names, orders.get(r.purchase_order_id), notices) for r in rows]


@router.get("/exceptions/{exception_id}/events", summary="异常处理留痕")
def exception_events(
    exception_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    row = _load_exception(db, exception_id, user)
    events = (
        db.query(InspectionExceptionEvent)
        .filter(InspectionExceptionEvent.exception_id == row.id)
        .order_by(InspectionExceptionEvent.created_at)
        .all()
    )
    names = map_staff_names(db, {x for e in events for x in (e.operator_id, e.target_staff_id) if x})
    return [
        {
            "action": e.action,
            "detail": e.detail,
            "operator_name": names.get(e.operator_id),
            "target_name": names.get(e.target_staff_id),
            "read_at": utc_to_cn_iso(e.read_at),
            "channel_status": e.channel_status,
            "channel_detail": e.channel_detail,
            "created_at": utc_to_cn_iso(e.created_at),
        }
        for e in events
    ]


@router.post("/exceptions/{exception_id}/ack", summary="业务员接单")
def ack_exception(
    exception_id: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    row = _load_exception(db, exception_id, user)
    if user.role not in (StaffRole.ADMIN, StaffRole.BUSINESS):
        raise HTTPException(status_code=400, detail="只有业务员或管理员能接单")
    if not row.handler_ack_at:
        row.handler_ack_at = datetime.utcnow()
        row.handler_id = user.id
        ops._log(db, row, "ACK", operator_id=user.id)
        db.commit()
    return _exception_out(row, _exception_names(db, [row]))


@router.post("/exceptions/{exception_id}/purchaser-evidence", summary="采购员提交首轮凭证")
def submit_purchaser_evidence(
    exception_id: str,
    body: PurchaserEvidenceIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    row = _load_exception(db, exception_id, user)
    if user.role != StaffRole.ADMIN and user.id != row.purchaser_id:
        raise HTTPException(status_code=400, detail="只有这单的采购员或管理员能提交")
    evidence = _urls(body.evidence)
    if not evidence:
        raise HTTPException(status_code=400, detail="请上传凭证")
    # 追加不覆盖：首轮先交手上有的，后面的证据接着补，之前交的不能丢
    known = set(row.purchaser_evidence or [])
    row.purchaser_evidence = list(row.purchaser_evidence or []) + [u for u in evidence if u not in known]
    if not row.purchaser_evidence_at:
        row.purchaser_evidence_at = datetime.utcnow()
    ops._log(db, row, "PURCHASER_EVIDENCE", operator_id=user.id, detail=(body.note or "").strip() or None)
    db.commit()
    return _exception_out(row, _exception_names(db, [row]))


@router.patch("/exceptions/{exception_id}", summary="更新拒签、退回物流、退款进度")
def update_progress(
    exception_id: str,
    body: ExceptionProgress,
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    row = _load_exception(db, exception_id, user)
    if row.status != "OPEN":
        raise HTTPException(status_code=400, detail="已结束的异常不能再改")
    changes = []
    if body.reject_status is not None:
        if body.reject_status not in ops.REJECT_STATUSES:
            raise HTTPException(status_code=400, detail="拒签状态不正确")
        row.reject_status = body.reject_status
        changes.append(f"拒签 {body.reject_status}")
    if body.return_tracking_no is not None:
        row.return_tracking_no = body.return_tracking_no.strip() or None
        changes.append(f"退回单号 {row.return_tracking_no or '已清空'}")
    if body.return_carrier is not None:
        row.return_carrier = body.return_carrier.strip() or None
        changes.append(f"承运方 {row.return_carrier or '已清空'}")
    if body.return_station is not None:
        row.return_station = body.return_station.strip() or None
        changes.append(f"退回网点 {row.return_station or '已清空'}")
    if body.return_sign_evidence:
        # 签收凭证只追加不覆盖
        row.return_sign_evidence = list(row.return_sign_evidence or []) + _urls(body.return_sign_evidence)
        changes.append(f"签收凭证 +{len(body.return_sign_evidence)}")
    if body.return_logistics is not None:
        if body.return_logistics not in ops.RETURN_LOGISTICS:
            raise HTTPException(status_code=400, detail="退回运输状态不正确")
        if not row.return_tracking_no or not row.return_carrier:
            raise HTTPException(status_code=400, detail="先填退回运单号和承运方，才能跟踪运输")
        row.return_logistics = body.return_logistics
        changes.append({"IN_TRANSIT": "退回在途", "ABNORMAL": "退回异常", "SIGNED": "网点已签收"}[body.return_logistics])
    if body.refund_fee is not None:
        if body.refund_fee < 0:
            raise HTTPException(status_code=400, detail="扣费不能为负")
        row.refund_fee = body.refund_fee
        changes.append(f"扣费 {body.refund_fee}")
    if body.refund_shortfall_reason is not None:
        row.refund_shortfall_reason = body.refund_shortfall_reason.strip() or None
        changes.append("差额原因已填写")
    if body.refund_amount is not None:
        if body.refund_amount <= 0:
            raise HTTPException(status_code=400, detail="退款金额须大于 0")
        row.refund_amount = body.refund_amount
        changes.append(f"退款金额 {body.refund_amount}")
    if body.refund_status is not None:
        if body.refund_status not in ops.REFUND_STATUSES:
            raise HTTPException(status_code=400, detail="退款状态不正确")
        # 申请不等于到账：标到账必须有实际金额
        if body.refund_status in ("RECEIVED", "PARTIAL") and row.refund_amount is None:
            raise HTTPException(status_code=400, detail="退款到账要填实际到账金额")
        row.refund_status = body.refund_status
        changes.append(f"退款 {body.refund_status}")
    note = (body.note or "").strip()
    if not changes and not note:
        raise HTTPException(status_code=400, detail="没有要更新的内容")
    ops._log(db, row, "PROGRESS", operator_id=user.id, detail="；".join(changes + ([note] if note else [])))
    db.commit()
    # 物流异常、退款被驳回：要有人接管，通知管理员（发不出去不影响记账）
    if body.return_logistics == "ABNORMAL" or body.refund_status == "DENIED":
        _notify_takeover(db, row, user, "退回物流异常" if body.return_logistics == "ABNORMAL" else "退款被驳回", note)
    return _exception_out(row, _exception_names(db, [row]))


def _notify_takeover(db: Session, row: InspectionException, user: Staff, what: str, note: str) -> None:
    from app.services import staff_notify

    order = db.get(PurchaseOrder, row.purchase_order_id)
    for admin in db.query(Staff).filter(Staff.role == StaffRole.ADMIN, Staff.status == "ACTIVE", Staff.deleted_at.is_(None)):
        try:
            staff_notify.send(admin, f"{what}，需要接管",
                              f"{order.order_no if order else ''} {order.product_name if order else ''}\n{user.name or user.username}：{note or what}",
                              url=ops.EXCEPTIONS_URL)
        except Exception:  # noqa: BLE001
            pass


@router.post("/exceptions/{exception_id}/close", summary="结束异常")
def close_exception(
    exception_id: str,
    body: ExceptionClose,
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    row = _load_exception(db, exception_id, user)
    if row.status != "OPEN":
        raise HTTPException(status_code=400, detail="已经结束了")
    result = body.final_result.strip()
    if not result:
        raise HTTPException(status_code=400, detail="请写最终结果")
    for why in close_blockers(db, row):
        raise HTTPException(status_code=400, detail=why)
    row.status = "CLOSED"
    row.final_result = result
    row.closed_at = datetime.utcnow()
    ops._log(db, row, "CLOSED", operator_id=user.id, detail=result)
    db.commit()
    return _exception_out(row, _exception_names(db, [row]))


def close_blockers(db: Session, row: InspectionException) -> list[str]:
    """结案条件：全检做完、货的去向有凭证、钱有结果且对得上账（禅道 WH08-15）。返回还差什么，空=可以结。"""
    out = aftersale.close_blockers(row)
    items = ops.check_items(db, row.inspection_id)
    state = ops.full_check_state(items)["state"]
    if state in ("IN_PROGRESS", "RETEST"):
        out.append("全检还没完成（还有没验或待补测的项目），不能结束")
    if row.reject_status not in ("RETURNED", "NOT_NEEDED"):
        out.append("货还没退回，不能结束")
    elif row.reject_status == "RETURNED" and not row.return_sign_evidence:
        out.append("货标了已退回，要上传网点签收或接收凭证")
    if row.refund_status not in ("RECEIVED", "PARTIAL", "DENIED", "NOT_NEEDED"):
        out.append("退款还没有结果，不能结束")
    if row.refund_status in ("PARTIAL", "DENIED") and not row.refund_shortfall_reason:
        out.append("部分退款或被驳回，要写清差额原因和复核结果")
    if row.refund_status in ("RECEIVED", "PARTIAL") and row.refund_amount is not None:
        order = db.get(PurchaseOrder, row.purchase_order_id)
        if order is not None and order.unit_price is not None:
            gap = order.unit_price - row.refund_amount - (row.refund_fee or 0)
            if gap > 0 and not row.refund_shortfall_reason:
                out.append(f"退款加扣费比采购金额少 {gap} 元，要写差额原因")
    return out


class AftersaleIn(BaseModel):
    status: str | None = Field(default=None, description="preparing / submitted / accepted / withdrawn / disputed / resolved")
    deadline: str | None = Field(default=None, description="平台售后截止时间（北京时间，如 2026-11-18T20:00）")
    deadline_source: str | None = Field(default=None, description="platform 平台页面上写的 / estimate 自己估的")
    receipt: list[str] = Field(default_factory=list, description="平台申请成功的截图（追加）")
    note: str | None = Field(default=None, max_length=300)


@router.post("/exceptions/{exception_id}/aftersale", summary="平台售后进度：准备 / 已提交（要回执）/ 受理 / 撤销 / 介入")
def update_aftersale(exception_id: str, body: AftersaleIn, db: Session = Depends(get_db),
                     user: Staff = Depends(get_current_user)):
    row = _load_exception(db, exception_id, user)
    deadline = cn_to_utc(body.deadline)
    if body.deadline and deadline is None:
        raise HTTPException(status_code=400, detail="期限的时间格式不对")
    changes = aftersale.update(row, user, status=body.status, deadline=deadline, deadline_source=body.deadline_source,
                               receipt=_urls(body.receipt), note=body.note)
    note = (body.note or "").strip()
    ops._log(db, row, "AFTERSALE", operator_id=user.id, detail="；".join(changes + ([note] if note else [])))
    db.commit()
    order = db.get(PurchaseOrder, row.purchase_order_id)
    return _exception_out(row, _exception_names(db, [row]), order, _exception_notices(db, [row]))


class OfferIn(BaseModel):
    by: str = Field(description="seller 卖家提的 / us 我们提的")
    text: str = Field(min_length=1, max_length=500, description="对方原话")
    amount: str | None = Field(default=None, description="补差金额")


@router.post("/exceptions/{exception_id}/keep-offer", summary="记一次留货 / 补差提议：谁提的、原话、金额")
def add_keep_offer(exception_id: str, body: OfferIn, db: Session = Depends(get_db),
                   user: Staff = Depends(get_current_user)):
    row = _load_exception(db, exception_id, user)
    detail = aftersale.add_offer(row, user, by=body.by, text=body.text, amount=body.amount)
    ops._log(db, row, "KEEP_OFFER", operator_id=user.id, detail=detail)
    db.commit()
    order = db.get(PurchaseOrder, row.purchase_order_id)
    return _exception_out(row, _exception_names(db, [row]), order, _exception_notices(db, [row]))


@router.get("/notices", summary="我的未读通知")
def my_notices(db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    rows = (
        db.query(InspectionExceptionEvent)
        .filter(InspectionExceptionEvent.target_staff_id == user.id, InspectionExceptionEvent.read_at.is_(None))
        .order_by(InspectionExceptionEvent.created_at.desc())
        .limit(50)
        .all()
    )
    return [
        {"id": r.id, "exception_id": r.exception_id, "action": r.action, "detail": r.detail, "created_at": utc_to_cn_iso(r.created_at)}
        for r in rows
    ]


@router.post("/notices/{notice_id}/read", summary="通知标记已读")
def read_notice(notice_id: str, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    row = db.get(InspectionExceptionEvent, notice_id)
    if not row or row.target_staff_id != user.id:
        raise HTTPException(status_code=404, detail="通知不存在")
    if not row.read_at:
        row.read_at = datetime.utcnow()
        db.commit()
    return {"ok": True}


# ---------- 出库复核 ----------


def _review_history(db: Session, sku_id: str) -> list[dict]:
    rows = db.query(OutboundReview).filter(OutboundReview.sku_id == sku_id).order_by(OutboundReview.created_at.desc()).all()
    names = map_staff_names(db, {r.reviewer_id for r in rows})
    return [
        {
            "result": r.result,
            "remark": r.remark,
            "identity_code": r.identity_code,
            "media": sign_media_payload(r.media or []),
            "reviewer_name": names.get(r.reviewer_id),
            "created_at": utc_to_cn_iso(r.created_at),
            "state": "已出库" if r.consumed_at else ("已处理" if r.closed_at else ("待处理" if r.result == "PROBLEM" else "待出库")),
        }
        for r in rows
    ]


def _dossier(db: Session, sku: Sku) -> dict:
    task = db.get(Inspection, sku.inspection_id) if sku.inspection_id else None
    evidence = (
        db.query(InspectionEvidence)
        .filter(InspectionEvidence.sku_id == sku.id)
        .order_by(InspectionEvidence.created_at)
        .all()
    )
    items = ops.check_items(db, task.id) if task else []
    exceptions = (
        db.query(InspectionException).filter(InspectionException.inspection_id == task.id).all() if task else []
    )
    pending = (
        db.query(OutboundReview)
        .filter(OutboundReview.sku_id == sku.id, OutboundReview.consumed_at.is_(None))
        .order_by(OutboundReview.created_at.desc())
        .first()
    )
    ids = {e.recorded_by for e in evidence} | ({pending.reviewer_id} if pending else set())
    names = {**map_staff_names(db, ids), **_exception_names(db, exceptions)}
    return {
        "sku": {
            "id": sku.id,
            "sku_code": sku.sku_code,
            "serial_number": sku.serial_number,
            "product_name": sku.product_name,
            "brand": sku.brand,
            "model": sku.model,
            "spec": sku.spec,
            "condition_grade": sku.condition_grade,
            "status": sku.status,
            "location_code": sku.location_code,
            "cover_url": sign_media_payload(sku.cover_url),
        },
        "inspection": {
            "inspect_no": task.inspect_no,
            "inspection_result": task.inspection_result,
            "mismatch_remark": task.mismatch_remark,
            "remark": task.remark,
            # 老验货单的照片和视频在验货单字段里，没进凭证表
            "defect_images": sign_media_payload(task.defect_images or []),
            "defect_videos": sign_media_payload(task.defect_videos or []),
            "listing_images": sign_media_payload(task.listing_images or []),
        }
        if task
        else None,
        "items": [_item_out(i) for i in items],
        "full_check": ops.full_check_state(items),
        "unbox_gap": ops.unbox_gap(db, task.id) if task and items else None,
        "evidence": [_evidence_out(e, names) for e in evidence],
        "exceptions": [_exception_out(e, names, None, _exception_notices(db, exceptions)) for e in exceptions],
        "pending_review": {
            "reviewer_name": names.get(pending.reviewer_id),
            "created_at": utc_to_cn_iso(pending.created_at),
            "remark": pending.remark,
            "result": pending.result,
        }
        if pending
        else None,
        # 历次出库复核（入库、发货、退回的影像按次序可查），最新在前
        "reviews": _review_history(db, sku.id),
    }


@router.get("/skus/{sku_code}/dossier", summary="商品的验货结果、瑕疵照片、开箱视频")
def sku_dossier(
    sku_code: str,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(*_EVIDENCE_READERS)),
):
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    return _dossier(db, sku)


_ITEM_CHECK_STATUSES = {"SAME", "WORSE", "FIXED", "NEW"}


@router.post("/skus/{sku_code}/review", summary="销售确认出库复核")
def review_sku(
    sku_code: str,
    body: ReviewIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN)),
):
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    dossier = _dossier(db, sku)
    remark = (body.remark or "").strip() or None
    if body.result not in ("OK", "PROBLEM"):
        raise HTTPException(status_code=400, detail="复核结果不正确")
    code = (body.identity_code or "").strip()
    # 核对实物身份：扫到的货号或序列号要对得上这件货，对不上多半是拿错件（WH10-02）
    if not code:
        raise HTTPException(status_code=400, detail="请先扫货号或序列号核对实物身份")
    if code.lower() not in {(sku.sku_code or "").lower(), (sku.serial_number or "").lower()}:
        raise HTTPException(status_code=400, detail=f"扫到的「{code}」和这件货的货号、序列号都对不上，确认是不是拿错了")
    media = _urls(body.media)
    if body.result == "PROBLEM" and not remark:
        raise HTTPException(status_code=400, detail="发现新问题要写清是什么问题、在哪个部位")
    # 入库瑕疵逐项比对（WH10-03）：不通过/无法测试的项都要勾
    problem_items = [i for i in dossier["items"] if i.get("result") in ("FAIL", "UNTESTABLE")]
    checks = {c.item_key: c.status for c in (body.item_checks or [])}
    for c in body.item_checks or []:
        if c.status not in _ITEM_CHECK_STATUSES:
            raise HTTPException(status_code=400, detail=f"比对结果「{c.status}」不正确")
    if problem_items:
        missing = [i["title"] for i in problem_items if i["item_key"] not in checks]
        if missing:
            raise HTTPException(status_code=400, detail=f"请逐项比对入库瑕疵：{'、'.join(missing[:5])}")
    worse = [i["title"] for i in problem_items if checks.get(i["item_key"]) in ("WORSE", "NEW")]
    open_problems = db.query(OutboundReview).filter(
        OutboundReview.sku_id == sku.id, OutboundReview.result == "PROBLEM",
        OutboundReview.consumed_at.is_(None), OutboundReview.closed_at.is_(None),
    ).all()
    # 更差 / 新问题先报「发现新问题」拦住、通知管理员和采购；报过之后处理好了（比如买家知情同意）再放行，
    # 比对照实填——原来只能改选「一样 / 已修好」才发得出去，等于逼人填假结果
    if worse and body.result != "PROBLEM" and not open_problems:
        raise HTTPException(status_code=400, detail=f"「{'、'.join(worse[:3])}」比入库时更差或是新问题，请选「发现新问题」并拦住出库")
    # 放行之前报过的问题要写清怎么处理的，放行后告诉管理员（原来随便一个销售点一次「核对无误」就关掉、不留话）
    if body.result == "OK" and open_problems and len(remark or "") < 4:
        raise HTTPException(status_code=400, detail="之前复核发现了问题，放行要写明怎么处理的（至少 4 个字，如：已和买家说明磕痕，买家同意）")
    has_unbox = any(e["kind"] == "UNBOX_VIDEO" for e in dossier["evidence"])
    open_exceptions = [e for e in dossier["exceptions"] if e["status"] == "OPEN"]
    # 没视频或异常没结束可以放行（老货没有开箱视频），但销售要写明为什么
    if body.result == "OK" and (not has_unbox or open_exceptions) and not remark:
        raise HTTPException(status_code=400, detail="没有开箱视频或还有未结束的异常，要写明复核说明")
    now = datetime.utcnow()
    if body.result == "OK":
        # 之前发现的问题由这次复核接过去（已处理）
        for old in open_problems:
            old.closed_at = now
    row = OutboundReview(
        sku_id=sku.id,
        reviewer_id=user.id,
        remark=remark,
        result=body.result,
        identity_code=code or None,
        media=media or None,
        snapshot={
            "inspection_result": (dossier["inspection"] or {}).get("inspection_result"),
            "failed_items": [i["title"] for i in dossier["items"] if i["result"] == "FAIL"],
            "untestable_items": [i["title"] for i in dossier["items"] if i["result"] == "UNTESTABLE"],
            "evidence_ids": [e["id"] for e in dossier["evidence"]],
            "has_unbox_video": has_unbox,
            "open_exception_ids": [e["id"] for e in open_exceptions],
            "full_check": dossier.get("full_check", {}).get("state"),
            "identity_checked": bool(code),
            "item_checks": [{"item_key": k, "status": v, "title": next((i["title"] for i in problem_items if i["item_key"] == k), k)} for k, v in checks.items()],
            "released_problems": [p.remark for p in open_problems] if body.result == "OK" else [],
        },
    )
    db.add(row)
    db.commit()
    if body.result == "PROBLEM":
        _notify_outbound_problem(db, sku, user, remark)
    elif open_problems:
        _notify_outbound_problem(db, sku, user, remark, released=[p.remark or "" for p in open_problems])
    return _dossier(db, sku)


def _notify_outbound_problem(db: Session, sku: Sku, user: Staff, remark: str,
                             released: list[str] | None = None) -> None:
    """出库复核发现新问题 / 之前的问题被放行：通知管理员 + 原采购员（WH10-06）。发不出去不影响复核本身。"""
    from app.models import PurchaseOrder
    from app.services import staff_notify

    if released is not None:
        title = "出库复核的问题已放行"
        body = (
            f"{sku.sku_code} {sku.product_name}\n之前发现：{'；'.join(r for r in released if r) or '—'}\n"
            f"{user.name or user.username} 放行：{remark}"
        )
    else:
        title = "出库复核发现新问题"
        body = (
            f"{sku.sku_code} {sku.product_name}\n"
            f"{user.name or user.username}：{remark}\n"
            f"已拦住出库，处理后重新复核才能发。"
        )
    targets: dict[str, Staff] = {}
    for admin in db.query(Staff).filter(
        Staff.role == StaffRole.ADMIN, Staff.status == "ACTIVE", Staff.deleted_at.is_(None),
    ):
        targets[admin.id] = admin
    # 回到原采购员：按采购单建单人
    order = db.get(PurchaseOrder, sku.purchase_order_id) if sku.purchase_order_id else None
    if order and order.created_by_id:
        buyer = db.get(Staff, order.created_by_id)
        if buyer is not None and buyer.status == "ACTIVE" and not getattr(buyer, "deleted_at", None):
            targets[buyer.id] = buyer
    for staff in targets.values():
        try:
            staff_notify.send(
                staff, title, body,
                url="http://127.0.0.1:8000",
            )
        except Exception:  # noqa: BLE001
            pass


@router.get("/outbound-problems", summary="出库复核发现新问题、还没处理的货")
def outbound_problems(db: Session = Depends(get_db), _: Staff = Depends(require_roles(*_EVIDENCE_READERS))):
    rows = (
        db.query(OutboundReview)
        .filter(OutboundReview.result == "PROBLEM", OutboundReview.consumed_at.is_(None), OutboundReview.closed_at.is_(None))
        .order_by(OutboundReview.created_at.desc())
        .all()
    )
    names = map_staff_names(db, {r.reviewer_id for r in rows})
    out = []
    for r in rows:
        sku = db.get(Sku, r.sku_id)
        out.append({
            "sku_code": sku.sku_code if sku else None,
            "product_name": sku.product_name if sku else None,
            "remark": r.remark,
            "media": sign_media_payload(r.media or []),
            "reviewer_name": names.get(r.reviewer_id),
            "created_at": utc_to_cn_iso(r.created_at),
        })
    return {"items": out, "total": len(out)}



# ---------- 退回复验与历次影像（禅道 WH10-07/08/10） ----------

_RECHECK_STATUSES = ("RETURNING", "PENDING_INBOUND", "ABNORMAL")


def _load_return(db: Session, return_id: str) -> tuple[ReturnOrder, Sku]:
    ret = db.get(ReturnOrder, return_id)
    if not ret:
        raise HTTPException(status_code=404, detail="退货单不存在")
    sku = db.get(Sku, ret.sku_id)
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    return ret, sku


def _history_out(rows: list[dict]) -> list[dict]:
    return [{**r, "at": utc_to_cn_iso(r["at"])} for r in rows]


def _recheck_out(db: Session, ret: ReturnOrder, sku: Sku) -> dict:
    row = return_recheck.get(db, ret.id)
    names = map_staff_names(db, {x for x in ([row.created_by, row.finished_by] if row else []) if x})
    items = row.items if row else return_recheck.build_items(db, sku)[1]
    return {
        "return": {"id": ret.id, "return_no": ret.return_no, "status": ret.status, "reason": ret.reason,
                   "reason_code": ret.reason_code},
        "sku": {"id": sku.id, "sku_code": sku.sku_code, "product_name": sku.product_name,
                "serial_number": sku.serial_number},
        "required": ops.setting_on(db, return_recheck.RETURN_RECHECK_REQUIRED),
        "started": bool(row),
        "items": [{**i, "evidence": sign_media_payload(i.get("evidence") or [])} for i in items],
        "result": row.result if row else None,
        "note": row.note if row else None,
        "media": sign_media_payload(row.media or []) if row else [],
        "finished_at": utc_to_cn_iso(row.finished_at) if row else None,
        "finished_by_name": names.get(row.finished_by) if row and row.finished_by else None,
        "history": _history_out(return_recheck.media_history(db, sku)),
    }


@router.get("/returns/{return_id}/recheck", summary="退回复验：检查项（对照入库结果）与这件货的历次影像")
def read_recheck(return_id: str, db: Session = Depends(get_db), _: Staff = Depends(require_roles(*_WAREHOUSE))):
    ret, sku = _load_return(db, return_id)
    return _recheck_out(db, ret, sku)


@router.post("/returns/{return_id}/recheck", summary="开始退回复验")
def start_recheck(return_id: str, db: Session = Depends(get_db), user: Staff = Depends(require_roles(*_WAREHOUSE))):
    ret, sku = _load_return(db, return_id)
    if ret.status not in _RECHECK_STATUSES:
        raise HTTPException(status_code=400, detail="这张退货单已经处理完了")
    return_recheck.start(db, ret, sku, user.id)
    db.commit()
    return _recheck_out(db, ret, sku)


@router.put("/returns/{return_id}/recheck/items/{key}", summary="填一项复验结果")
def save_recheck_item(
    return_id: str, key: str, body: RecheckItemIn,
    db: Session = Depends(get_db), user: Staff = Depends(require_roles(*_WAREHOUSE)),
):
    ret, sku = _load_return(db, return_id)
    row = return_recheck.get(db, ret.id)
    if not row:
        raise HTTPException(status_code=400, detail="先点开始复验")
    evidence = [strip_oss_signature(u) for u in body.evidence]
    return_recheck.record_item(row, key, result=body.result, note=body.note, evidence=evidence, user_id=user.id)
    db.commit()
    return _recheck_out(db, ret, sku)


@router.post("/returns/{return_id}/recheck/finish", summary="复验结论：和入库时一致 / 发现问题")
def finish_recheck(
    return_id: str, body: RecheckFinishIn,
    db: Session = Depends(get_db), user: Staff = Depends(require_roles(*_WAREHOUSE)),
):
    ret, sku = _load_return(db, return_id)
    row = return_recheck.get(db, ret.id)
    if not row:
        raise HTTPException(status_code=400, detail="先点开始复验")
    media = [strip_oss_signature(u) for u in body.media]
    return_recheck.finish(row, result=body.result, note=body.note, media=media, user_id=user.id)
    db.commit()
    return _recheck_out(db, ret, sku)


@router.get("/skus/{sku_code}/history", summary="这件货历次的照片视频（入库、复核、出库、退回、复验）按时间排")
def sku_history(
    sku_code: str, db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.ADMIN, *_EVIDENCE_READERS)),
):
    sku = db.query(Sku).filter(Sku.sku_code == sku_code.strip()).first()
    if not sku:
        raise HTTPException(status_code=404, detail="货号不存在")
    return {"items": _history_out(return_recheck.media_history(db, sku))}

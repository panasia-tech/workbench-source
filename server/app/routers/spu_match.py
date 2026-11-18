"""员工匹配商品（小程序 / H5「商品匹配」）：待匹配清单、匹配页、提交、报找不到、验收。规则见 services/spu_match.py。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.enums import SkuStatus, StaffRole
from app.models import Sku, SkuSpuMatch, SkuSpuMatchLog, Staff, WarehouseSpu
from app.services import spu_match as sm
from app.services.oss_media import sign_oss_url

router = APIRouter(prefix="/api/spu-match", tags=["商品匹配"])

_EDITORS = (StaffRole.WAREHOUSE, StaffRole.PURCHASER, StaffRole.ADMIN)
_IN_STOCK = (SkuStatus.IN_STOCK, SkuStatus.RESERVED)
# 清单分页签：todo 待匹配（没提交过或还在核实）/ waiting 待验收 / returned 退回待补正 / done 已确认
_TABS = {
    "todo": (None, SkuSpuMatch.CHECKING),
    "waiting": SkuSpuMatch.WAITING_REVIEW,
    "returned": (SkuSpuMatch.RETURNED,),
    "done": (SkuSpuMatch.CONFIRMED,),
}
STATUS_LABEL = {
    None: "待匹配",
    SkuSpuMatch.CHECKING: "待核实",
    SkuSpuMatch.SUBMITTED: "待验收",
    SkuSpuMatch.NO_MATCH: "报了找不到",
    SkuSpuMatch.RETURNED: "退回待补正",
    SkuSpuMatch.CONFIRMED: "已确认",
}
ACTION_LABEL = {"SUBMIT": "提交匹配", "CHANGE": "改挂", "REPORT": "报告找不到", "APPROVE": "验收通过", "RETURN": "退回"}


class SubmitIn(BaseModel):
    spu_id: str
    note: str | None = Field(default=None, max_length=1000)
    media: list[str] = Field(default_factory=list, max_length=9)
    confirm_change: bool = False


class ReportIn(BaseModel):
    note: str = Field(max_length=1000)
    media: list[str] = Field(default_factory=list, max_length=9)
    confirm_change: bool = False


class ReviewIn(BaseModel):
    approve: bool
    reason: str | None = Field(default=None, max_length=1000)
    media: list[str] = Field(default_factory=list, max_length=9)


def _sku(db: Session, code: str) -> Sku:
    sku = db.query(Sku).filter(Sku.sku_code == code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="商品不存在")
    return sku


def _names(db: Session, ids) -> dict[str, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return {s.id: s.name or s.username for s in db.query(Staff).filter(Staff.id.in_(ids)).all()}


def _spu_label(spu: WarehouseSpu | None) -> str | None:
    if spu is None:
        return None
    return spu.brand_model + (f"（{spu.spec}）" if spu.spec else "")


def _signed(urls) -> list[dict]:
    """OSS 图要签名才看得到；raw 是存库的原地址，提交时回传 raw。"""
    return [{"raw": u, "url": sign_oss_url(u) or u} for u in urls or [] if u]


def _sku_out(sku: Sku) -> dict:
    return {
        "sku_code": sku.sku_code,
        "product_name": sku.product_name,
        "brand": sku.brand,
        "model": sku.model,
        "spec": sku.spec,
        "barcode": sku.barcode,
        "serial_number": sku.serial_number,
        "location_code": sku.location_code,
        "status": sku.status,
        "cover_url": sign_oss_url(sku.cover_url or ((sku.images or [None])[0])),
        "images": _signed(list(sku.images or [])[:9]),
    }


@router.get("/items", summary="商品匹配清单")
def list_items(
    tab: str = Query("todo"),
    q: str = Query(""),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=50),
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(*_EDITORS)),
):
    if tab not in _TABS:
        raise HTTPException(status_code=400, detail="未知分页")
    query = db.query(Sku, SkuSpuMatch).outerjoin(SkuSpuMatch, SkuSpuMatch.sku_id == Sku.id).filter(Sku.status.in_(_IN_STOCK))
    statuses = _TABS[tab]
    if None in statuses:
        query = query.filter(or_(SkuSpuMatch.id.is_(None), SkuSpuMatch.status.in_([s for s in statuses if s])))
    else:
        query = query.filter(SkuSpuMatch.status.in_(statuses))
    q = q.strip()
    if q:
        like = f"%{q}%"
        query = query.filter(or_(Sku.sku_code.ilike(like), Sku.product_name.ilike(like), Sku.model.ilike(like),
                                 Sku.barcode.ilike(like), Sku.location_code.ilike(like)))
    total = query.count()
    rows = query.order_by(Sku.inbound_at.desc(), Sku.sku_code.desc()).offset((page - 1) * size).limit(size).all()
    spus = {s.id: s for s in db.query(WarehouseSpu).filter(WarehouseSpu.id.in_({m.spu_id for _, m in rows if m and m.spu_id})).all()}
    items = []
    for sku, m in rows:
        item = _sku_out(sku)
        item["match_status"] = m.status if m else None
        item["match_label"] = STATUS_LABEL.get(m.status if m else None)
        item["spu"] = _spu_label(spus.get(m.spu_id)) if m and m.spu_id else None
        item["return_reason"] = m.return_reason if m else None
        if tab == "todo":
            a = sm.assess(db, sku)
            item["state"] = a.state
            item["state_title"] = a.title
        items.append(item)
    return {"items": items, "total": total, "page": page, "size": size}


@router.get("/skus/{sku_code}", summary="一件货的匹配页：现状判断、候选、已提交的匹配、退回原因、经办记录")
def read_sku(sku_code: str, db: Session = Depends(get_db), user: Staff = Depends(require_roles(*_EDITORS))):
    sku = _sku(db, sku_code)
    row = sm.current(db, sku)
    logs = db.query(SkuSpuMatchLog).filter(SkuSpuMatchLog.sku_id == sku.id).order_by(SkuSpuMatchLog.seq.desc()).all()
    spu_ids = {x for lg in logs for x in (lg.from_spu_id, lg.to_spu_id)} | {row.spu_id if row else None}
    spus = {s.id: s for s in db.query(WarehouseSpu).filter(WarehouseSpu.id.in_({i for i in spu_ids if i})).all()}
    names = _names(db, [lg.staff_id for lg in logs] + ([row.submitted_by, row.reviewed_by] if row else []))
    match = None
    if row is not None:
        spu = spus.get(row.spu_id)
        match = {
            "status": row.status,
            "label": STATUS_LABEL.get(row.status),
            "spu_id": row.spu_id,
            "spu": _spu_label(spu),
            "spu_code": spu.spu_code if spu else None,
            "note": row.note,
            "media": _signed(row.media),
            "submitted_by": names.get(row.submitted_by),
            "submitted_at": row.submitted_at,
            "reviewed_by": names.get(row.reviewed_by),
            "reviewed_at": row.reviewed_at,
            "return_reason": row.return_reason,
            "return_media": _signed(row.return_media),
            "version": row.version,
        }
    is_admin = user.role == StaffRole.ADMIN
    return {
        "sku": _sku_out(sku),
        "assessment": sm.assess(db, sku).out(),
        "match": match,
        "logs": [
            {
                "action": lg.action,
                "label": ACTION_LABEL.get(lg.action, lg.action),
                "from_spu": _spu_label(spus.get(lg.from_spu_id)),
                "to_spu": _spu_label(spus.get(lg.to_spu_id)),
                "from_status": STATUS_LABEL.get(lg.from_status) if lg.from_status else None,
                "to_status": STATUS_LABEL.get(lg.to_status) if lg.to_status else None,
                "note": lg.note,
                "media": _signed(lg.media),
                "staff": names.get(lg.staff_id),
                "at": lg.created_at,
            }
            for lg in logs
        ],
        "can_review": bool(is_admin and row and row.status in SkuSpuMatch.WAITING_REVIEW and row.submitted_by != user.id),
    }


@router.get("/search", summary="在 SPU 目录里搜（型号、品牌、编码、配置）")
def search(q: str = Query(""), db: Session = Depends(get_db), _: Staff = Depends(require_roles(*_EDITORS))):
    return {"items": sm.search(db, q)}


@router.post("/skus/{sku_code}/submit", summary="确认匹配，提交验收")
def submit(sku_code: str, body: SubmitIn, db: Session = Depends(get_db), user: Staff = Depends(require_roles(*_EDITORS))):
    sku = _sku(db, sku_code)
    try:
        sm.submit(db, sku, body.spu_id, note=body.note, media=body.media, user_id=user.id, confirm_change=body.confirm_change)
    except HTTPException as exc:
        return _need_confirm(db, exc)
    db.commit()
    return read_sku(sku_code, db, user)


@router.post("/skus/{sku_code}/report", summary="报告找不到对应商品")
def report(sku_code: str, body: ReportIn, db: Session = Depends(get_db), user: Staff = Depends(require_roles(*_EDITORS))):
    sku = _sku(db, sku_code)
    try:
        sm.report_none(db, sku, note=body.note, media=body.media, user_id=user.id, confirm_change=body.confirm_change)
    except HTTPException as exc:
        return _need_confirm(db, exc)
    db.commit()
    _notify_report(db, sku, user, body.note)
    return read_sku(sku_code, db, user)


@router.post("/skus/{sku_code}/review", summary="管理员验收：通过或退回（原因必填，可附截图）")
def review(sku_code: str, body: ReviewIn, db: Session = Depends(get_db), user: Staff = Depends(require_roles(StaffRole.ADMIN))):
    sku = _sku(db, sku_code)
    sm.review(db, sku, approve=body.approve, reason=body.reason, media=body.media, user_id=user.id)
    db.commit()
    return read_sku(sku_code, db, user)


def _need_confirm(db: Session, exc: HTTPException):
    """改已有匹配要先确认：409 带上影响清单，放在 detail 外面（前端会把 detail 改写成人话）。其它错误照常抛。"""
    db.rollback()
    if exc.status_code == 409 and isinstance(exc.detail, dict):
        return JSONResponse(status_code=409, content={"detail": exc.detail["message"], "impact": exc.detail["impact"]})
    raise exc


def _notify_report(db: Session, sku: Sku, user: Staff, note: str) -> None:
    """报了找不到：钉钉通知管理员来补目录。没配钉钉就只留在待验收清单里。"""
    from app.config import settings
    from app.services import dingtalk

    to = [u.strip() for u in (settings.dingtalk_notify_userids or "").split(",") if u.strip()]
    if to and dingtalk.configured():
        dingtalk.send_text(to, f"{user.name or user.username} 报告商品匹配找不到：{sku.sku_code} {sku.product_name}\n实物：{note}\n请到「商品匹配 → 待验收」处理。")

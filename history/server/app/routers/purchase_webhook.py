"""采购入站 webhook：外部采购服务 → 本 ERP。

对外收件（无登录态）：
- POST /hook/purchase                   无鉴权公开接口（主推，对接方直接 POST JSON）
- POST /api/purchase-webhook/ingest     HMAC 头验签（保留兼容，需要更强安全时可用）
管理端查询/重试/标记（ADMIN / PURCHASER，走登录态）。

设计为 inbox 模式：幂等 → 原样落库 → 回 200，不在请求内做业务解析。
详见 app/services/purchase_webhook/ 与 app/models/purchase_webhook.py。

注意：/hook/purchase 无任何鉴权，任何人知道地址即可写入 inbox（已与业务方确认可接受
该风险）。落库仅进 purchase_webhook_event 收件表，不直接改采购业务数据。
"""

import json
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import require_roles
from app.enums import PurchaseWebhookStatus, StaffRole
from app.models import PurchaseWebhookEvent, Staff
from app.schemas.purchase_webhook import PurchaseWebhookEventOut
from app.services.purchase_webhook import ingest_event, verify_signature

logger = logging.getLogger(__name__)
# 管理端 + HMAC 收件端
router = APIRouter(prefix="/api/purchase-webhook", tags=["purchase-webhook"])
# 对外 token-URL 收件端（token 放 URL 路径即凭证）
public_router = APIRouter(prefix="/hook", tags=["purchase-webhook"])


def _process(db: Session, raw: bytes, headers):
    """来者不拒：任何 body 都收，不强制字段、不做分类，原样落库。总是回 200。

    - 合法 JSON 对象 → 原样存 payload；带 event_id 则去重。
    - JSON 数组/标量 → 包一层 {"_raw": ...} 存下。
    - 非法 JSON / 空 body → 存原始文本 {"_raw_text": ...}，绝不丢。
    """
    body = None
    if raw:
        try:
            body = json.loads(raw)
        except (ValueError, TypeError):
            body = None

    if isinstance(body, dict):
        payload = body
        eid = body.get("event_id")
        event_id = str(eid)[:128] if (eid is not None and str(eid).strip()) else None
    elif body is not None:
        payload = {"_raw": body}  # 数组/标量
        event_id = None
    else:
        payload = {"_raw_text": raw.decode("utf-8", "replace")} if raw else {}
        event_id = None

    rec, created = ingest_event(db, event_id, payload, headers)
    if not created:
        return {"code": 0, "msg": "duplicate", "id": rec.id}
    logger.info("purchase webhook 收件 %s type=%s", rec.event_id, rec.event_type)
    return {"code": 0, "msg": "ok", "id": rec.id}


# ============ 对外收件（一）：无鉴权公开接口，对接方直接 POST JSON ============
# 完整路径：POST /hook/purchase
@public_router.post("/purchase", summary="接收采购 webhook（公开）")
async def ingest_public(request: Request, db: Session = Depends(get_db)):
    if not settings.purchase_webhook_enabled:
        return JSONResponse({"code": 503, "msg": "disabled"}, status_code=503)
    raw = await request.body()
    return _process(db, raw, request.headers)


# ============ 对外收件（二）：HMAC 头验签（保留兼容）============
@router.post("/ingest", summary="验签接收采购 webhook")
async def ingest(request: Request, db: Session = Depends(get_db)):
    if not settings.purchase_webhook_enabled:
        return JSONResponse({"code": 503, "msg": "disabled"}, status_code=503)

    raw = await request.body()  # 原始字节，用于验签（不能用解析后的 body）
    ok, reason = verify_signature(
        raw,
        request.headers.get("X-Webhook-Timestamp"),
        request.headers.get("X-Webhook-Signature"),
        [settings.purchase_webhook_secret, settings.purchase_webhook_secret_prev],
        settings.purchase_webhook_tolerance_seconds,
    )
    if not ok:
        logger.warning("purchase webhook 验签失败: %s", reason)
        return JSONResponse({"code": 401, "msg": reason}, status_code=401)

    return _process(db, raw, request.headers)


# ==================== 管理端：查看 / 重试 / 标记（登录态）====================
@router.get("/events", response_model=list[PurchaseWebhookEventOut], summary="webhook 事件列表")
def list_events(
    status: str | None = Query(None, description="按处理状态过滤"),
    event_type: str | None = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    _: Staff = Depends(require_roles(StaffRole.ADMIN, StaffRole.PURCHASER)),
    db: Session = Depends(get_db),
):
    query = db.query(PurchaseWebhookEvent)
    if status:
        query = query.filter(PurchaseWebhookEvent.status == status)
    if event_type:
        query = query.filter(PurchaseWebhookEvent.event_type == event_type)
    return (
        query.order_by(PurchaseWebhookEvent.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )


@router.get("/events/{event_id}", response_model=PurchaseWebhookEventOut, summary="webhook 事件详情")
def get_event(
    event_id: str,
    _: Staff = Depends(require_roles(StaffRole.ADMIN, StaffRole.PURCHASER)),
    db: Session = Depends(get_db),
):
    rec = db.get(PurchaseWebhookEvent, event_id)
    if not rec:
        raise HTTPException(status_code=404, detail="事件不存在")
    return rec


@router.post("/events/{event_id}/retry", response_model=PurchaseWebhookEventOut, summary="重试 webhook 事件")
def retry_event(
    event_id: str,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    """把 FAILED/IGNORED 事件重新置回 PENDING，供下游重新解析。"""
    rec = db.get(PurchaseWebhookEvent, event_id)
    if not rec:
        raise HTTPException(status_code=404, detail="事件不存在")
    rec.status = PurchaseWebhookStatus.PENDING
    rec.error = None
    rec.retry_count = (rec.retry_count or 0) + 1
    rec.processed_at = None
    db.commit()
    db.refresh(rec)
    return rec


@router.post("/events/{event_id}/ignore", response_model=PurchaseWebhookEventOut, summary="忽略 webhook 事件")
def ignore_event(
    event_id: str,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    """人工标记为无需处理。"""
    rec = db.get(PurchaseWebhookEvent, event_id)
    if not rec:
        raise HTTPException(status_code=404, detail="事件不存在")
    rec.status = PurchaseWebhookStatus.IGNORED
    rec.processed_at = datetime.utcnow()
    db.commit()
    db.refresh(rec)
    return rec

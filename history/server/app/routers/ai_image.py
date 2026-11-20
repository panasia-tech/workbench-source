"""AI 图像处理路由。gpt-image-2 异步重绘 + 服务端轮询。

并发约束：
- 后台 worker 用受控线程池（max_workers=4），不会随请求暴增
- DB 会话不跨 HTTP 等待，避免连接池被长任务占满
- 单 SKU 同时在飞的 PENDING/RUNNING 任务上限 INFLIGHT_PER_SKU_MAX
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import get_current_user
from app.models import AiRedrawJob, Staff, WarehouseTag
from app.schemas._tz import utc_to_cn_iso
from app.services import redraw_worker

router = APIRouter(prefix="/api/ai", tags=["ai-image"])

INFLIGHT_PER_SKU_MAX = 3


class RedrawSubmitRequest(BaseModel):
    sku_code: str = Field(description="SKU编码")
    image_url: str = Field(default="", description="参考图URL(可选,不传则走文生图,仅 apinebula 供应商支持)")
    tag_name: str = Field(default="", description="仓库标签名称(决定AI提示词/尺寸);填了自定义提示词时可不传")
    prompt: str = Field(default="", description="自定义提示词(可选;文生图时填,覆盖标签提示词)")


class RedrawJobOut(BaseModel):
    id: str = Field(description="重绘任务ID")
    sku_code: str = Field(description="SKU编码")
    source_image_url: str = Field(description="原始参考图URL")
    tag_name: str | None = Field(description="仓库标签名称")
    status: str = Field(description="任务状态 PENDING=待处理/RUNNING=处理中/SUCCEEDED=成功/FAILED=失败")
    result_url: str | None = Field(description="重绘结果图URL")
    prompt: str | None = Field(description="AI提示词")
    ai_size: str | None = Field(description="AI出图尺寸")
    ai_resolution: str | None = Field(description="AI出图分辨率")
    error_message: str | None = Field(description="错误信息")
    created_at: str = Field(description="创建时间(北京时间ISO)")
    completed_at: str | None = Field(description="完成时间(北京时间ISO)")

    model_config = {"from_attributes": True}


def _job_out(row: AiRedrawJob) -> RedrawJobOut:
    return RedrawJobOut(
        id=row.id,
        sku_code=row.sku_code,
        source_image_url=row.source_image_url,
        tag_name=row.tag_name,
        status=row.status,
        result_url=row.result_url,
        prompt=row.prompt,
        ai_size=row.ai_size,
        ai_resolution=row.ai_resolution,
        error_message=row.error_message,
        created_at=utc_to_cn_iso(row.created_at) or "",
        completed_at=utc_to_cn_iso(row.completed_at),
    )


def _resolve_tag(db: Session, name: str) -> WarehouseTag:
    tag = (
        db.query(WarehouseTag)
        .filter(WarehouseTag.name == (name or "").strip(), WarehouseTag.enabled.is_(True))
        .first()
    )
    if not tag:
        raise HTTPException(status_code=400, detail=f"标签「{name}」不存在或未启用")
    if not (tag.prompt or "").strip():
        raise HTTPException(status_code=400, detail=f"标签「{name}」未配置 AI 提示词")
    return tag


@router.post("/redraw", summary="提交 AI 图片重绘", response_model=RedrawJobOut)
def submit_redraw(
    body: RedrawSubmitRequest,
    db: Session = Depends(get_db),
    user: Staff = Depends(get_current_user),
):
    sku_code = (body.sku_code or "").strip()
    image_url = (body.image_url or "").strip()
    tag_name = (body.tag_name or "").strip()
    custom_prompt = (body.prompt or "").strip()
    if not sku_code:
        raise HTTPException(status_code=400, detail="SKU 编码为空")
    # 不传参考图 = 文生图（仅提示词出图）。只有 apinebula 供应商支持；
    # alapi 走异步任务必须有参考图，缺图直接拦下，避免入库后 worker 才失败。
    if not image_url and (settings.redraw_provider or "").strip().lower() != "apinebula":
        raise HTTPException(status_code=400, detail="当前重绘供应商不支持文生图，请上传参考图")

    # 提示词/尺寸来源：优先自定义提示词（文生图），否则取仓库标签（重绘）。
    tag = _resolve_tag(db, tag_name) if tag_name else None
    prompt = custom_prompt or (tag.prompt.strip() if tag else "")
    if not prompt:
        raise HTTPException(status_code=400, detail="请选择重绘标签或填写提示词")

    inflight = (
        db.query(AiRedrawJob)
        .filter(
            AiRedrawJob.sku_code == sku_code,
            AiRedrawJob.status.in_(("PENDING", "RUNNING")),
        )
        .count()
    )
    if inflight >= INFLIGHT_PER_SKU_MAX:
        raise HTTPException(status_code=429, detail=f"该 SKU 已有 {inflight} 个进行中的重绘任务，请稍后再试")

    job = AiRedrawJob(
        sku_code=sku_code,
        source_image_url=image_url,
        tag_name=(tag.name if tag else None),
        prompt=prompt,
        ai_size=(tag.ai_size if tag else None),
        ai_resolution=(tag.ai_resolution if tag else None),
        status="PENDING",
        operator_id=user.id,
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    redraw_worker.enqueue(job.id)
    return _job_out(job)


@router.get("/redraw/jobs", summary="查询重绘任务列表", response_model=list[RedrawJobOut])
def list_redraw_jobs(
    sku_code: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    _: Staff = Depends(get_current_user),
):
    rows = (
        db.query(AiRedrawJob)
        .filter(AiRedrawJob.sku_code == sku_code.strip())
        .order_by(AiRedrawJob.created_at.desc())
        .limit(limit)
        .all()
    )
    return [_job_out(r) for r in rows]

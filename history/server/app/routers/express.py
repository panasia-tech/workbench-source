from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models import Staff
from app.schemas.express import ExpressTrackingOut
from app.services.express import ExpressNotConfiguredError, get_tracking

router = APIRouter(prefix="/api/express", tags=["express"])


@router.get("/track/{tracking_no}", summary="查询快递轨迹", response_model=ExpressTrackingOut)
async def track(
    tracking_no: str,
    refresh: bool = Query(False, description="true 时强制调用第三方并更新缓存"),
    phone: str | None = Query(
        None,
        description="收/寄件人手机号后四位（顺丰等选填，建议填写）",
        max_length=8,
    ),
    db: Session = Depends(get_db),
    _: Staff = Depends(get_current_user),
):
    try:
        return await get_tracking(db, tracking_no, refresh=refresh, phone_suffix=phone or "")
    except ExpressNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

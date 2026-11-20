from fastapi import APIRouter, Depends

from app.database import get_db
from app.deps import get_current_user
from app.models import Staff
from app.schemas.listing_config import ListingFormConfigOut, ListingFormConfigVersionOut
from app.services.listing_form_config import build_form_config, get_config_version
from sqlalchemy.orm import Session

router = APIRouter(prefix="/api/listing", tags=["listing"])


@router.get("/form-config/version", summary="上架表单配置版本", response_model=ListingFormConfigVersionOut)
async def form_config_version(
    db: Session = Depends(get_db),
    _: Staff = Depends(get_current_user),
):
    version = await get_config_version(db)
    return ListingFormConfigVersionOut(version=version)


@router.get("/form-config", summary="上架表单配置", response_model=ListingFormConfigOut)
async def form_config(
    db: Session = Depends(get_db),
    _: Staff = Depends(get_current_user),
):
    payload = await build_form_config(db)
    return ListingFormConfigOut(**payload)

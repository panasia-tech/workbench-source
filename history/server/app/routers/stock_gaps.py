"""库存缺口总览：员工打开就看到在库货还缺什么才能上架。逻辑见 services/stock_gaps.py。"""

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.enums import StaffRole
from app.models import Staff
from app.services import stock_gaps as sg

router = APIRouter(prefix="/api/stock-gaps", tags=["stock-gaps"])

_ROLES = (StaffRole.ADMIN, StaffRole.WAREHOUSE, StaffRole.SALES)


@router.get("", summary="缺口清单：各种类件数 + 当前种类的货")
def list_gaps(
    kind: str | None = Query(None, description="unresolved/no_price/no_image/below_cost/unlisted/other，留空看全部"),
    q: str | None = Query(None, description="货号 / 商品名 / 品牌 / 型号 / 库位"),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(*_ROLES)),
):
    return sg.overview(db, kind=kind, q=q, page=page, size=size, role=str(user.role))


class KindsIn(BaseModel):
    kinds: list[str] = Field(description="算缺口的种类，见 GET /settings 的 all")


@router.get("/settings", summary="哪几种算缺口")
def read_settings(db: Session = Depends(get_db), _: Staff = Depends(require_roles(*_ROLES))):
    return {"kinds": sg.enabled_kinds(db), "all": [{"key": k, "label": v} for k, v in sg.KINDS.items()]}


@router.put("/settings", summary="改哪几种算缺口（管理员）")
def write_settings(body: KindsIn, db: Session = Depends(get_db), user: Staff = Depends(require_roles(StaffRole.ADMIN))):
    sg.save_kinds(db, body.kinds, user.id)
    return read_settings(db, user)

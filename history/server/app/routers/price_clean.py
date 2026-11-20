"""步入式价格清洗。规矩见 services/price_clean.py。"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.enums import StaffRole
from app.models import PriceCleanTask, PriceSample, PriceVersion, Sku, Staff  # noqa: F401
from app.services import price_clean as pc

router = APIRouter(prefix="/api/price-clean", tags=["价格清洗"])

_EDITORS = (StaffRole.SALES, StaffRole.WAREHOUSE, StaffRole.PURCHASER, StaffRole.ADMIN)


class SampleIn(BaseModel):
    kept: bool | None = None
    reason: str | None = None
    price_type: str | None = None
    task_id: str | None = None  # 页面上看的是哪次清洗；别人中途重新开始了就对不上


class ConfirmIn(BaseModel):
    price: int
    note: str | None = None
    task_id: str | None = None


class ReviewIn(BaseModel):
    approve: bool
    note: str | None = None


def _sku(db: Session, code: str) -> Sku:
    sku = db.query(Sku).filter(Sku.sku_code == code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="货号不存在")
    return sku


def _open_task(db: Session, sku: Sku, task_id: str | None = None) -> PriceCleanTask:
    task = pc.latest_task(db, sku.id)
    if task is None:
        raise HTTPException(status_code=400, detail="还没开始清洗")
    if task_id and task.id != task_id:
        # 两人同时洗：B 点了重新开始，A 再改样本 / 确认，会改到 B 那批、出的版本和 A 填价的依据对不上
        raise HTTPException(status_code=409, detail="别人刚重新开始了这件货的清洗，刷新看最新样本")
    return task


@router.get("/skus/{sku_code}", summary="一件货的价格清洗：最近一次清洗的样本、有效价、版本")
def read(sku_code: str, db: Session = Depends(get_db), user: Staff = Depends(require_roles(*_EDITORS))):
    return pc.page(db, _sku(db, sku_code), user)


@router.post("/skus/{sku_code}/start", summary="开始清洗：带上最近一次采集的样本，按规则先筛一遍")
def start(sku_code: str, db: Session = Depends(get_db), user: Staff = Depends(require_roles(*_EDITORS))):
    sku = _sku(db, sku_code)
    pc.start(db, sku, user)
    db.commit()
    return pc.page(db, sku, user)


@router.patch("/skus/{sku_code}/samples/{sample_id}", summary="改一条样本：剔除（写原因）/ 恢复 / 改价格类型")
def edit_sample(sku_code: str, sample_id: str, body: SampleIn, db: Session = Depends(get_db),
                user: Staff = Depends(require_roles(*_EDITORS))):
    sku = _sku(db, sku_code)
    task = _open_task(db, sku, body.task_id)
    sample = db.get(PriceSample, sample_id)
    if sample is None or sample.task_id != task.id:
        raise HTTPException(status_code=404, detail="样本不存在")
    pc.edit_sample(db, task, sample, user, kept=body.kept, reason=body.reason, price_type=body.price_type)
    db.commit()
    return pc.page(db, sku, user)


@router.post("/skus/{sku_code}/confirm", summary="人工确认：出一个待生效的价格版本")
def confirm(sku_code: str, body: ConfirmIn, db: Session = Depends(get_db), user: Staff = Depends(require_roles(*_EDITORS))):
    sku = _sku(db, sku_code)
    pc.confirm(db, sku, _open_task(db, sku, body.task_id), user, price=body.price, note=body.note)
    db.commit()
    return pc.page(db, sku, user)


@router.post("/versions/{version_id}/review", summary="管理员：价格版本生效 / 退回")
def review(version_id: str, body: ReviewIn, db: Session = Depends(get_db), user: Staff = Depends(require_roles(StaffRole.ADMIN))):
    v = db.get(PriceVersion, version_id)
    if v is None:
        raise HTTPException(status_code=404, detail="版本不存在")
    pc.review(db, v, user, approve=body.approve, note=body.note)
    db.commit()
    return pc.page(db, db.get(Sku, v.sku_id), user)

"""采购工作台 W06：公司内部采购价格表。管理员维护，采购员查价。规矩见 services/purchase_price.py。"""
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.enums import StaffRole
from app.models import PurchaseOrder, PurchasePriceRule, Staff
from app.services import purchase_price as price

router = APIRouter(prefix="/api/purchase/prices", tags=["purchase"])

_READ = require_roles(StaffRole.PURCHASER, StaffRole.WAREHOUSE, StaffRole.ADMIN)
_WRITE = require_roles(StaffRole.ADMIN)


@router.get("", summary="价格表（现在生效的）")
def list_rules(q: str | None = None, page: int = Query(1, ge=1), size: int = Query(50, ge=1, le=200),
               db: Session = Depends(get_db), _: Staff = Depends(_READ)):
    qry = price.active(db)
    if q and q.strip():
        like = f"%{q.strip()}%"
        qry = qry.filter(or_(PurchasePriceRule.brand.like(like), PurchasePriceRule.model.like(like),
                             PurchasePriceRule.spec.like(like)))
    total = qry.count()
    rows = qry.order_by(PurchasePriceRule.brand, PurchasePriceRule.model, PurchasePriceRule.spec,
                        PurchasePriceRule.accessory).offset((page - 1) * size).limit(size).all()
    return {"items": [price.rule_out(r) for r in rows], "total": total, "accessories": price.ACCESSORIES}


@router.get("/quote", summary="查公司价：ok 有价 / pending 有待定 / none 没有 / review 待核")
def quote(brand: str, model: str, spec: str | None = None, accessory: str | None = None,
          declared_model: str | None = None, db: Session = Depends(get_db), _: Staff = Depends(_READ)):
    return price.quote(db, brand=brand, model=model, spec=spec, accessory=accessory, declared_model=declared_model)


@router.get("/for-order/{order_id}", summary="采购单下单时锁住的那版价，和现在的比")
def for_order(order_id: str, db: Session = Depends(get_db), user: Staff = Depends(_READ)):
    po = db.get(PurchaseOrder, order_id)
    if po is None or (user.role == StaffRole.PURCHASER and po.created_by_id != user.id):
        raise HTTPException(status_code=404, detail="没有这张采购单")
    if not po.price_rule_id:
        return {"locked": None}
    r = db.get(PurchasePriceRule, po.price_rule_id)
    now = price.active(db).filter(PurchasePriceRule.rule_key == r.rule_key).first()
    return {"locked": price.rule_out(r), "current": price.rule_out(now) if now else None,
            "changed": bool(now and now.id != r.id)}


@router.get("/{rule_id}/history", summary="这个型号 + 配件组合的各版价格")
def history(rule_id: str, db: Session = Depends(get_db), _: Staff = Depends(_READ)):
    r = db.get(PurchasePriceRule, rule_id)
    if r is None:
        raise HTTPException(status_code=404, detail="没有这条")
    return {"items": price.history(db, r)}


class RuleIn(BaseModel):
    brand: str = Field(min_length=1, max_length=64)
    model: str = Field(min_length=1, max_length=128)
    spec: str | None = Field(default=None, max_length=128)
    accessory: str = "unit"
    first_offer: str | None = None
    target: str | None = None
    ceiling: str | None = None
    source: str | None = Field(default=None, max_length=128)
    note: str | None = Field(default=None, max_length=500)


@router.post("", summary="加一条，或给已有的加一版（旧版留着）")
def save(body: RuleIn, db: Session = Depends(get_db), user: Staff = Depends(_WRITE)):
    row = price.save(db, user, body.model_dump())
    db.commit()
    return price.rule_out(row)


@router.delete("/{rule_id}", summary="不收这个型号了：当前版停用（不删）")
def retire(rule_id: str, db: Session = Depends(get_db), _: Staff = Depends(_WRITE)):
    price.retire(db, rule_id)
    db.commit()
    return {"ok": True}

"""采购工作台 W06：内部采购价格表查价、改价、锁版本（禅道 #53）。

规矩：
  - 按 品牌 + 型号 + 规格 + 配件组合 取价；单机和全套是两条，不混价；
  - 首报 / 目标 / 最高三栏分开，空着显示「待定」，不拿来自动报价（比例要老板定，11-15 用户认可）；
  - 规格没填、同型号有好几种规格或配件对得上 → 「待核」，不给价；卖家写的型号和采购填的对不上 → 「待核」；
  - 改价加新版、旧版留着；采购单锁下单时那一版（price_rule_id），后来调表不改旧单；
  - 外面的行情只是参考，不在这里冒充公司价。
"""
from __future__ import annotations

import re
from datetime import datetime
from decimal import Decimal, InvalidOperation

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models import PurchaseOrder, PurchasePriceRule, Staff

ACCESSORIES = {"unit": "单机", "full": "全套（盒、充电器、配件齐）", "no_box": "无盒有配件", "parts": "缺配件"}
FIELDS = {"first_offer": "首报", "target": "目标", "ceiling": "最高"}


def norm(s: str | None) -> str:
    return re.sub(r"[\s\-_/·.()（）]+", "", (s or "").lower())


def rule_key(brand: str, model: str, spec: str | None, accessory: str) -> str:
    return "|".join((norm(brand), norm(model), norm(spec), accessory))[:255]


def _money(v, label: str) -> Decimal | None:
    if v is None or v == "":
        return None
    try:
        d = Decimal(str(v)).quantize(Decimal("0.01"))
    except InvalidOperation as exc:
        raise HTTPException(status_code=400, detail=f"{label}要填数字") from exc
    if d <= 0:
        raise HTTPException(status_code=400, detail=f"{label}要大于 0")
    return d


def active(db: Session):
    return db.query(PurchasePriceRule).filter(PurchasePriceRule.superseded_at.is_(None))


def save(db: Session, staff: Staff, data: dict) -> PurchasePriceRule:
    """加一条或给已有的加一版。三栏可以空着（待定），填了的要首报 ≤ 目标 ≤ 最高。"""
    brand, model = (data.get("brand") or "").strip(), (data.get("model") or "").strip()
    if not brand or not model:
        raise HTTPException(status_code=400, detail="品牌和型号都要填")
    accessory = data.get("accessory") or "unit"
    if accessory not in ACCESSORIES:
        raise HTTPException(status_code=400, detail="配件组合不对")
    spec = (data.get("spec") or "").strip() or None
    prices = {k: _money(data.get(k), w) for k, w in FIELDS.items()}
    filled = [(FIELDS[k], v) for k, v in prices.items() if v is not None]
    for (a, x), (b, y) in zip(filled, filled[1:]):
        if x > y:
            raise HTTPException(status_code=400, detail=f"{a}不能比{b}高")
    key = rule_key(brand, model, spec, accessory)
    prev = active(db).filter(PurchasePriceRule.rule_key == key).first()
    now = datetime.utcnow()
    if prev is not None:
        if all(getattr(prev, k) == v for k, v in prices.items()):
            raise HTTPException(status_code=400, detail="价格没变，不用加新版")
        prev.superseded_at = now
    row = PurchasePriceRule(rule_key=key, brand=brand, model=model, spec=spec, accessory=accessory, **prices,
                            version=(prev.version + 1) if prev else 1, effective_from=now,
                            source=(data.get("source") or "").strip()[:128] or None,
                            note=(data.get("note") or "").strip() or None, created_by_id=staff.id)
    db.add(row)
    db.flush()
    return row


def retire(db: Session, rule_id: str) -> None:
    """不收这个型号了：当前版停用（不删，历史和锁过的单还能查）。"""
    row = db.get(PurchasePriceRule, rule_id)
    if row is None or row.superseded_at is not None:
        raise HTTPException(status_code=404, detail="没有这条，或者已经不是现在生效的")
    row.superseded_at = datetime.utcnow()


def rule_out(r: PurchasePriceRule) -> dict:
    return {
        "id": r.id, "brand": r.brand, "model": r.model, "spec": r.spec, "accessory": r.accessory,
        "accessory_label": ACCESSORIES.get(r.accessory, r.accessory), "version": r.version,
        **{k: (str(getattr(r, k)) if getattr(r, k) is not None else None) for k in FIELDS},
        "pending": [w for k, w in FIELDS.items() if getattr(r, k) is None],
        "effective_from": r.effective_from.isoformat() if r.effective_from else None,
        "superseded_at": r.superseded_at.isoformat() if r.superseded_at else None,
        "source": r.source, "note": r.note,
    }


def history(db: Session, r: PurchasePriceRule) -> list[dict]:
    return [rule_out(x) for x in db.query(PurchasePriceRule).filter(PurchasePriceRule.rule_key == r.rule_key)
            .order_by(PurchasePriceRule.version.desc()).all()]


def quote(db: Session, *, brand: str, model: str, spec: str | None = None, accessory: str | None = None,
          declared_model: str | None = None) -> dict:
    """查公司价。status：ok 有价 / pending 有这条但三栏有待定 / none 表里没有 / review 待核（别拿来报价）。"""
    if declared_model and norm(declared_model) and norm(model) and \
            norm(declared_model) not in norm(model) and norm(model) not in norm(declared_model):
        return {"status": "review", "reason": f"卖家写的型号「{declared_model}」和填的「{model}」对不上，先核对再报价"}
    rows = [r for r in active(db).filter(PurchasePriceRule.rule_key.like(f"{norm(brand)}|{norm(model)}|%")).all()]
    if not rows:
        return {"status": "none", "reason": "价格表里没有这个型号"}
    if spec:
        rows = [r for r in rows if norm(r.spec) == norm(spec)]
        if not rows:
            return {"status": "none", "reason": f"价格表里没有「{spec}」这个规格"}
    elif len({norm(r.spec) for r in rows}) > 1:
        return {"status": "review", "reason": "同型号有好几种规格，先填规格",
                "choices": sorted({r.spec or "" for r in rows})}
    if accessory:
        rows = [r for r in rows if r.accessory == accessory]
        if not rows:
            return {"status": "none", "reason": f"价格表里没有「{ACCESSORIES.get(accessory, accessory)}」这种配件组合的价"}
    elif len(rows) > 1:
        return {"status": "review", "reason": "单机和全套价格不一样，先选配件组合",
                "choices": [ACCESSORIES.get(r.accessory, r.accessory) for r in rows]}
    r = rows[0]
    out = rule_out(r)
    return {"status": "pending" if out["pending"] else "ok", "rule": out,
            "reason": f"{'、'.join(out['pending'])}还没定" if out["pending"] else None}


def lock_for_order(db: Session, po: PurchaseOrder, rule_id: str | None) -> None:
    """建采购单时锁住当时那一版价格。没指定就按品牌型号规格找，唯一一条才锁。"""
    if rule_id:
        r = db.get(PurchasePriceRule, rule_id)
        if r is None or r.superseded_at is not None:
            raise HTTPException(status_code=400, detail="这版价格已经不是现在生效的了，刷新再选")
        po.price_rule_id = r.id
        return
    if not (po.brand and po.model):
        return
    q = quote(db, brand=po.brand, model=po.model, spec=po.spec)
    if q["status"] in ("ok", "pending"):
        po.price_rule_id = q["rule"]["id"]

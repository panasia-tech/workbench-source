"""把一件在库 SKU 解析到仓库 SPU 对照表上的某一款。

自动上架的地基：行情要按「品牌+型号」去搜，图片要按「品牌+型号」去采，
而 Sku 上的 brand/model 是验货时人工敲的，脏且不统一。SPU 对照表是那张桥。

生产实测命中率（351 件在库）：
  barcode(69码) → warehouse_spu.spu_code   261 件 (74%)
  model         → warehouse_spu.model      171 个不同 model 里能对上 162 个 (95%)
对比直接拿 model 去 crawl_product 里碰，只有 118/351 (34%)。

解析不出来的不进自动化，转人工——宁可漏，不可错挂到别款上。
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import Sku, WarehouseSpu

# 命中方式，用于排障与看板展示
MATCH_CONFIRMED = "confirmed"  # 员工匹配、管理员验收过的（services/spu_match.py），优先于现算
MATCH_BARCODE = "barcode"
MATCH_BRAND_MODEL = "brand_model"
MATCH_MODEL = "model"
MATCH_NONE = "none"


@dataclass(frozen=True)
class SpuMatch:
    """解析结果。spu 为 None 时 how=none，其余字段仅作排障用。"""

    spu: WarehouseSpu | None
    how: str
    ambiguous: int = 0  # 同样匹配上的候选数（>1 表示同名多 SPU，已按 spu_code 取定）

    @property
    def matched(self) -> bool:
        return self.spu is not None

    @property
    def query(self) -> str | None:
        """行情搜索词 / 图片采集词：「品牌 型号」。"""
        return self.spu.brand_model if self.spu else None


def _norm(v: str | None) -> str:
    return (v or "").strip()


def _pick(rows: list[WarehouseSpu]) -> tuple[WarehouseSpu | None, int]:
    """同名多 SPU 时按 spu_code 取定，保证同一件货每次解析到同一款。

    「盛色 N50PRO6」在清单里就有 3 个 SPU 编码——它们品牌型号完全相同，
    对行情搜索和图片采集是等价的，随便取哪个都不影响结果，但必须**稳定**。
    """
    if not rows:
        return None, 0
    return sorted(rows, key=lambda s: s.spu_code)[0], len(rows)


def resolve_spu(db: Session, sku: Sku) -> SpuMatch:
    """先看验收过的人工匹配；没有再按 69码 → 品牌+型号 → 型号 的顺序解析，只认启用的 SPU。"""
    from app.models import SkuSpuMatch

    confirmed = (
        db.query(SkuSpuMatch)
        .filter(SkuSpuMatch.sku_id == sku.id, SkuSpuMatch.status == SkuSpuMatch.CONFIRMED)
        .first()
    )
    if confirmed is not None:
        if not confirmed.spu_id:
            # 验收确认「目录里没有」也算定论，不再拿现算去碰别的款
            return SpuMatch(None, MATCH_NONE)
        spu = db.get(WarehouseSpu, confirmed.spu_id)
        if spu is not None:
            return SpuMatch(spu, MATCH_CONFIRMED, 1)
        # 认定的那款已从目录删掉：退回现算，匹配页上会显示要重新匹配

    base = db.query(WarehouseSpu).filter(WarehouseSpu.enabled.is_(True))

    # ① 69码精确命中 SPU 编码——最可靠，一物一码不会串款
    barcode = _norm(sku.barcode)
    if barcode:
        row = base.filter(func.lower(WarehouseSpu.spu_code) == barcode.lower()).first()
        if row is not None:
            return SpuMatch(row, MATCH_BARCODE, 1)

    model = _norm(sku.model)
    if not model:
        return SpuMatch(None, MATCH_NONE)

    # ② 品牌+型号同时命中，比只对型号精确（不同品牌可能撞型号名）
    brand = _norm(sku.brand)
    if brand:
        rows = base.filter(
            func.lower(WarehouseSpu.brand) == brand.lower(),
            func.lower(WarehouseSpu.model) == model.lower(),
        ).all()
        row, n = _pick(rows)
        if row is not None:
            return SpuMatch(row, MATCH_BRAND_MODEL, n)

    # ③ 只对型号——验货时品牌可能写法不一（「盛色」vs「SANC」），型号相对稳定
    rows = base.filter(func.lower(WarehouseSpu.model) == model.lower()).all()
    row, n = _pick(rows)
    if row is not None:
        return SpuMatch(row, MATCH_MODEL, n)

    return SpuMatch(None, MATCH_NONE)


def resolve_many(db: Session, skus: list[Sku]) -> dict[str, WarehouseSpu | None]:
    """一批货一起解析（库存商品卡片墙用）：规则和 resolve_spu 一样，SPU 清单只读一次（生产 170 款）。"""
    from app.models import SkuSpuMatch

    if not skus:
        return {}
    spus = db.query(WarehouseSpu).filter(WarehouseSpu.enabled.is_(True)).all()
    by_id = {s.id: s for s in db.query(WarehouseSpu).all()}
    by_code: dict[str, list[WarehouseSpu]] = {}
    by_bm: dict[tuple[str, str], list[WarehouseSpu]] = {}
    by_model: dict[str, list[WarehouseSpu]] = {}
    for s in spus:
        by_code.setdefault((s.spu_code or "").lower(), []).append(s)
        if s.model:
            by_model.setdefault(s.model.lower(), []).append(s)
            if s.brand:
                by_bm.setdefault((s.brand.lower(), s.model.lower()), []).append(s)
    confirmed = {
        m.sku_id: m.spu_id
        for m in db.query(SkuSpuMatch).filter(
            SkuSpuMatch.sku_id.in_([s.id for s in skus]), SkuSpuMatch.status == SkuSpuMatch.CONFIRMED,
        )
    }
    out: dict[str, WarehouseSpu | None] = {}
    for sku in skus:
        if sku.id in confirmed:
            spu_id = confirmed[sku.id]
            if not spu_id:
                out[sku.id] = None
                continue
            if spu_id in by_id:
                out[sku.id] = by_id[spu_id]
                continue
        barcode, model, brand = _norm(sku.barcode).lower(), _norm(sku.model).lower(), _norm(sku.brand).lower()
        rows = (by_code.get(barcode) if barcode else None) or (by_bm.get((brand, model)) if brand and model else None) \
            or (by_model.get(model) if model else None) or []
        out[sku.id] = _pick(rows)[0]
    return out

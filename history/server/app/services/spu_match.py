"""员工匹配商品：一件在库货对照候选 SPU 确认、报找不到；管理员验收通过或退回（原因 + 可选附件）。

沿用现有 SPU / SKU 结构：SKU 是一物一码的单件，SPU 是「品牌+型号(+配置)」款式档案（warehouse_spu）。
系统按 69码 → 品牌+型号 → 型号 现算（spu_resolve.py）只当候选；这里把候选摆给员工、拦住容易错的情况：

- 正常：69码命中，或品牌+型号只命中一个 SPU。
- 冲突（待核实）：同名多个 SPU（不同配置/地区）、69码和型号指向不同 SPU、只有型号对上而品牌不一致。
  不替员工挑第一个；同名多配置要写清配置并拍铭牌/配置页，才让提交。
- 无匹配：目录里找不到、或货上既没 69码 也没型号。给相近型号做参考，对不上就报「找不到」等管理员处理。

验收通过后 resolve_spu 一律用这里认定的 SPU；改挂已认定的要先看影响、确认后才改，前后都记日志。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.models import ListingApproval, Sku, SkuAutoListing, SkuSpuMatch, SkuSpuMatchLog, SpuImageSearch, WarehouseSpu

NORMAL = "NORMAL"
CONFLICT = "CONFLICT"
NONE = "NONE"

# 找谁核实：写在每条提示里，员工不用猜
ASK_ADMIN = "找仓库主管（管理员）核实"
MIN_NOTE = 4


def _norm(v: str | None) -> str:
    return (v or "").strip()


def _loose(v: str | None) -> str:
    """型号宽松比较：去空格、横线、下划线、斜杠，小写。只用来找「相近型号」，不用来认定。"""
    return re.sub(r"[\s\-_/]+", "", (v or "").lower())


@dataclass
class Candidate:
    spu: WarehouseSpu
    why: str  # 69码命中 / 品牌型号命中 / 只有型号命中 / 相近型号 / 搜索
    image: str | None = None

    def out(self, diff_fields: set[str]) -> dict:
        s = self.spu
        return {
            "spu_id": s.id,
            "spu_code": s.spu_code,
            "brand": s.brand,
            "model": s.model,
            "spec": s.spec,
            "note": s.note,
            "name": s.brand_model,
            "why": self.why,
            "image": self.image,
            "diff": sorted(diff_fields),
        }


@dataclass
class Assessment:
    state: str
    title: str
    detail: str
    next_step: str
    candidates: list[Candidate] = field(default_factory=list)
    # 同名多配置时，候选之间不一样的字段（spu_code / spec / note），界面上高亮
    diff_fields: set[str] = field(default_factory=set)

    def out(self) -> dict:
        return {
            "state": self.state,
            "title": self.title,
            "detail": self.detail,
            "next_step": self.next_step,
            "candidates": [c.out(self.diff_fields) for c in self.candidates],
        }


def _enabled(db: Session):
    return db.query(WarehouseSpu).filter(WarehouseSpu.enabled.is_(True))


def _images(db: Session, spus: list[WarehouseSpu]) -> dict[str, str]:
    ids = [s.id for s in spus]
    if not ids:
        return {}
    rows = db.query(SpuImageSearch.spu_id, SpuImageSearch.reference_url).filter(SpuImageSearch.spu_id.in_(ids)).all()
    from app.services.oss_media import sign_oss_url

    return {sid: sign_oss_url(url) or url for sid, url in rows if url}


def _diff(spus: list[WarehouseSpu]) -> set[str]:
    out = set()
    for name in ("spu_code", "spec", "note"):
        if len({_norm(getattr(s, name)) for s in spus}) > 1:
            out.add(name)
    return out


def similar(db: Session, sku: Sku, limit: int = 6) -> list[WarehouseSpu]:
    """相近型号：宽松后互相包含，或同品牌下型号前 4 位一样。只做参考。"""
    key = _loose(sku.model)
    if len(key) < 2:
        return []
    out = []
    for spu in _enabled(db).all():
        m = _loose(spu.model)
        if not m:
            continue
        same_brand = bool(_norm(sku.brand)) and _norm(spu.brand).lower() == _norm(sku.brand).lower()
        # 太短的型号（如「m2」）互相包含没意义，会把跑步机配到显示器上：只在同品牌里比
        contains = (key in m or m in key) and (same_brand or min(len(key), len(m)) >= 4)
        if contains or (same_brand and m[:4] == key[:4]):
            out.append(spu)
    out.sort(key=lambda s: (abs(len(_loose(s.model)) - len(key)), s.spu_code))
    return out[:limit]


def assess(db: Session, sku: Sku) -> Assessment:
    barcode = _norm(sku.barcode)
    brand = _norm(sku.brand)
    model = _norm(sku.model)
    if not barcode and not model:
        return Assessment(
            NONE, "缺少匹配依据", "这件货既没有 69码，也没有型号。",
            "先在「编辑商品信息」里补 69码（扫包装条码）或照铭牌补型号，再回来匹配；都看不到就报「找不到」，" + ASK_ADMIN,
        )

    by_code = _enabled(db).filter(func.lower(WarehouseSpu.spu_code) == barcode.lower()).first() if barcode else None
    by_name: list[WarehouseSpu] = []
    name_how = ""
    if model:
        if brand:
            by_name = _enabled(db).filter(
                func.lower(WarehouseSpu.brand) == brand.lower(), func.lower(WarehouseSpu.model) == model.lower()
            ).all()
            name_how = "品牌型号命中"
        if not by_name:
            by_name = _enabled(db).filter(func.lower(WarehouseSpu.model) == model.lower()).all()
            name_how = "只有型号命中"
    by_name.sort(key=lambda s: s.spu_code)

    pics = _images(db, ([by_code] if by_code else []) + by_name)

    def cand(spu, why):
        return Candidate(spu, why, pics.get(spu.id))

    if by_code is not None:
        others = [s for s in by_name if s.id != by_code.id]
        if by_name and not any(s.id == by_code.id for s in by_name):
            return Assessment(
                CONFLICT, "69码和型号指向不同商品",
                f"69码 {barcode} 对应「{by_code.brand_model}」，但这件货登记的型号是「{brand} {model}」。",
                "对照实物铭牌和包装条码：型号登记错了就选 69码那个；条码贴错了就选型号那个，并在说明里写清楚、拍条码照片。拿不准"
                + ASK_ADMIN,
                [cand(by_code, "69码命中")] + [cand(s, name_how) for s in others],
                _diff([by_code] + others),
            )
        return Assessment(
            NORMAL, "69码命中，匹配可靠", f"69码 {barcode} 就是 SPU「{by_code.brand_model}」的编码。",
            "核对候选的型号、配置和实物一致后确认。", [cand(by_code, "69码命中")],
        )

    if len(by_name) > 1:
        diff = _diff(by_name)
        no_spec = not any(_norm(s.spec) for s in by_name)
        return Assessment(
            CONFLICT, f"同名有 {len(by_name)} 个商品，要分清配置",
            f"「{by_name[0].brand_model}」在目录里有 {len(by_name)} 个 SPU，系统不会替你挑。",
            ("这几个还没登记配置差异，先" + ASK_ADMIN + "在 SPU 目录补「配置」。" if no_spec else
             "看实物的容量/颜色/地区版本，选配置一致的那个；说明里写上配置，拍铭牌或配置页照片。没有一致的就报「找不到」。"),
            [cand(s, name_how) for s in by_name], diff,
        )
    if len(by_name) == 1:
        spu = by_name[0]
        if name_how == "只有型号命中" and brand:
            return Assessment(
                CONFLICT, "型号对上了，品牌对不上",
                f"目录里「{model}」是 {spu.brand} 的，这件货登记的品牌是「{brand}」。",
                "看实物：确实是同一个东西（品牌写法不同）就确认，并在说明里写一句；不是就报「找不到」，" + ASK_ADMIN,
                [cand(spu, name_how)],
            )
        return Assessment(
            NORMAL, "品牌型号唯一命中", f"目录里只有一个「{spu.brand_model}」。",
            "核对候选的配置和实物一致后确认。", [cand(spu, name_how)],
        )

    near = similar(db, sku)
    pics = _images(db, near)
    what = f"「{brand} {model}」".replace("「 ", "「") if model else f"69码 {barcode}"
    return Assessment(
        NONE, "目录里找不到对应商品",
        f"{what} 在 SPU 目录里没有。" + ("下面是相近型号，只作参考，别为了凑而选。" if near else ""),
        "相近型号里有完全一致的就选它并说明；没有就点「报告找不到」，写清实物型号并拍铭牌，" + ASK_ADMIN + "补目录。",
        [Candidate(s, "相近型号", pics.get(s.id)) for s in near],
    )


def search(db: Session, q: str, limit: int = 20) -> list[dict]:
    q = _norm(q)
    if not q:
        return []
    like = f"%{q}%"
    rows = (
        _enabled(db)
        .filter(or_(WarehouseSpu.spu_code.ilike(like), WarehouseSpu.brand.ilike(like), WarehouseSpu.model.ilike(like),
                    WarehouseSpu.spec.ilike(like)))
        .order_by(WarehouseSpu.brand, WarehouseSpu.model, WarehouseSpu.spu_code)
        .limit(limit)
        .all()
    )
    pics = _images(db, rows)
    return [Candidate(s, "搜索", pics.get(s.id)).out(set()) for s in rows]


def current(db: Session, sku: Sku) -> SkuSpuMatch | None:
    return db.query(SkuSpuMatch).filter(SkuSpuMatch.sku_id == sku.id).first()


def _log(db, sku, action, *, from_spu=None, to_spu=None, from_status=None, to_status=None, note=None, media=None, user_id=None):
    db.flush()
    seq = (db.query(func.max(SkuSpuMatchLog.seq)).filter(SkuSpuMatchLog.sku_id == sku.id).scalar() or 0) + 1
    db.add(SkuSpuMatchLog(
        sku_id=sku.id, seq=seq, action=action, from_spu_id=from_spu, to_spu_id=to_spu, from_status=from_status,
        to_status=to_status, note=note, media=list(media or []), staff_id=user_id,
    ))


def impact(db: Session, sku: Sku, row: SkuSpuMatch) -> dict:
    """改挂已有匹配会影响什么：给员工看，确认后才改。"""
    old = db.get(WarehouseSpu, row.spu_id) if row.spu_id else None
    approvals = (
        db.query(func.count(ListingApproval.id))
        .filter(ListingApproval.sku_id == sku.id, ListingApproval.status.in_(("SUBMITTED", "APPROVED")))
        .scalar()
    )
    auto = db.query(SkuAutoListing).filter(SkuAutoListing.sku_id == sku.id).first()
    return {
        "current_spu": old.brand_model + (f"（{old.spec}）" if old and old.spec else "") if old else "（报过找不到）",
        "current_spu_code": old.spu_code if old else None,
        "current_status": row.status,
        "price_approvals": approvals or 0,
        "auto_listing": bool(auto),
        "effects": [
            x for x in (
                f"这件货 {approvals} 条已提交/已通过的上架价格审批会作废，要按新商品重新清洗" if approvals else None,
                "自动上架改用新商品的行情和图片" if auto else None,
                "行情价、同款在库、图片参考都改按新商品算",
                "要重新验收",
            ) if x
        ],
    }


def _effective(db: Session, sku: Sku) -> str | None:
    """下游（行情、自动上架、图片、同款在库）眼下认的是哪个 SPU。"""
    from app.services.spu_resolve import resolve_spu

    db.flush()
    m = resolve_spu(db, sku)
    return m.spu.id if m.spu else None


def _follow(db: Session, sku: Sku, before: str | None) -> None:
    """下游认的 SPU 变了才动：旧商品下清洗出来的价格作废，自动上架的缓存指到新商品。图片/价格不能混进别款。"""
    after = _effective(db, sku)
    if after != before:
        _apply_change_effects(db, sku, after)


def _apply_change_effects(db: Session, sku: Sku, spu_id: str | None) -> None:
    from app.services import listing_approval as la

    la.mark_stale(db, sku.id, "所属商品改了，要按新商品重新清洗")
    auto = db.query(SkuAutoListing).filter(SkuAutoListing.sku_id == sku.id).first()
    if auto is not None and auto.spu_id != spu_id:
        spu = db.get(WarehouseSpu, spu_id) if spu_id else None
        auto.spu_id = spu_id
        auto.spu_query = spu.brand_model if spu else None
        auto.match_how = "confirmed" if spu else None


def submit(db: Session, sku: Sku, spu_id: str, *, note: str | None, media: list[str] | None, user_id: str,
           confirm_change: bool = False) -> SkuSpuMatch:
    """员工确认这件货属于哪个 SPU。依据不足、改已有关系没确认，都拦下。"""
    spu = db.get(WarehouseSpu, spu_id)
    if spu is None or not spu.enabled:
        raise HTTPException(status_code=400, detail="这个商品不在目录里或已停用")
    note = _norm(note) or None
    media = [m for m in (media or []) if m]
    a = assess(db, sku)
    hit = next((c for c in a.candidates if c.spu.id == spu.id), None)

    # 同名多配置：必须写配置 + 拍照，不能凭感觉挑
    siblings = _enabled(db).filter(
        func.lower(WarehouseSpu.brand) == spu.brand.lower(),
        func.lower(func.coalesce(WarehouseSpu.model, "")) == (spu.model or "").lower(),
        WarehouseSpu.id != spu.id,
    ).count()
    barcode_ok = _norm(sku.barcode).lower() == spu.spu_code.lower()
    if siblings and not barcode_ok:
        if not _norm(spu.spec):
            raise HTTPException(status_code=400, detail=f"「{spu.brand_model}」有 {siblings + 1} 个配置，目录里还没写清配置差异，不能凭编码挑。先{ASK_ADMIN}补「配置」")
        if len(note or "") < MIN_NOTE or not media:
            raise HTTPException(status_code=400, detail=f"同名有 {siblings + 1} 个配置：说明里写清实物配置（如容量/颜色/版本），并拍铭牌或配置页照片")
    if a.state == CONFLICT and hit is not None and len(note or "") < MIN_NOTE:
        raise HTTPException(status_code=400, detail=f"{a.title}：说明里写一句你是怎么核对的")
    if hit is None or hit.why == "相近型号":
        # 不在系统候选里（搜出来的、相近型号）：登记的型号和目录对不上，必须有依据
        if len(note or "") < MIN_NOTE or not media:
            raise HTTPException(status_code=400, detail="选的不是系统认出来的候选：说明里写清为什么是它，并拍铭牌/包装照片")

    row = current(db, sku)
    if row is not None and row.status == SkuSpuMatch.CONFIRMED and row.spu_id != spu.id and not confirm_change:
        raise HTTPException(status_code=409, detail={"message": "这件货已经验收过匹配，改挂会有影响", "impact": impact(db, sku, row)})
    if row is not None and row.status in SkuSpuMatch.WAITING_REVIEW and row.spu_id != spu.id and not confirm_change:
        raise HTTPException(status_code=409, detail={"message": "这件货已经提交过匹配，正等验收", "impact": impact(db, sku, row)})

    now = datetime.utcnow()
    before = _effective(db, sku)
    if row is None:
        row = SkuSpuMatch(sku_id=sku.id, status=SkuSpuMatch.CHECKING, version=0, media=[], return_media=[])
        db.add(row)
    old_spu, old_status = row.spu_id, row.status
    changed = row.version > 0 and old_spu != spu.id
    row.spu_id = spu.id
    row.status = SkuSpuMatch.SUBMITTED
    row.note = note
    row.media = media
    row.submitted_by = user_id
    row.submitted_at = now
    row.reviewed_by = row.reviewed_at = None
    row.version = (row.version or 0) + 1
    _log(db, sku, "CHANGE" if changed else "SUBMIT", from_spu=old_spu, to_spu=spu.id, from_status=old_status if row.version > 1 else None,
         to_status=row.status, note=note, media=media, user_id=user_id)
    if old_status == SkuSpuMatch.CONFIRMED and old_spu != spu.id:
        # 改挂已验收的：旧商品下清洗的价格立刻作废，不等新匹配验收
        _apply_change_effects(db, sku, spu.id)
    else:
        _follow(db, sku, before)
    return row


def report_none(db: Session, sku: Sku, *, note: str | None, media: list[str] | None, user_id: str,
                confirm_change: bool = False) -> SkuSpuMatch:
    """找不到对应商品：保存异常、写清实物型号，等管理员补目录或确认。"""
    note = _norm(note)
    media = [m for m in (media or []) if m]
    if len(note) < MIN_NOTE:
        raise HTTPException(status_code=400, detail="写清实物上看到的品牌、型号、配置，管理员才好补目录")
    row = current(db, sku)
    if row is not None and row.spu_id and row.status in (SkuSpuMatch.CONFIRMED, *SkuSpuMatch.WAITING_REVIEW) and not confirm_change:
        raise HTTPException(status_code=409, detail={"message": "这件货已经匹配过商品，改报找不到会有影响", "impact": impact(db, sku, row)})
    before = _effective(db, sku)
    if row is None:
        row = SkuSpuMatch(sku_id=sku.id, version=0, media=[], return_media=[])
        db.add(row)
    old_spu, old_status = row.spu_id, row.status
    row.spu_id = None
    row.status = SkuSpuMatch.NO_MATCH
    row.note = note
    row.media = media
    row.submitted_by = user_id
    row.submitted_at = datetime.utcnow()
    row.reviewed_by = row.reviewed_at = None
    row.version = (row.version or 0) + 1
    _log(db, sku, "REPORT", from_spu=old_spu, to_spu=None, from_status=old_status, to_status=row.status, note=note, media=media, user_id=user_id)
    _follow(db, sku, before)
    return row


def review(db: Session, sku: Sku, *, approve: bool, reason: str | None, media: list[str] | None, user_id: str) -> SkuSpuMatch:
    """管理员验收：通过，或退回（原因必填，可附标注截图）。"""
    row = current(db, sku)
    if row is None or row.status not in SkuSpuMatch.WAITING_REVIEW:
        raise HTTPException(status_code=400, detail="这件货没有待验收的匹配")
    if row.submitted_by == user_id:
        raise HTTPException(status_code=400, detail="自己提交的要别人来验收")
    reason = _norm(reason) or None
    media = [m for m in (media or []) if m]
    if not approve and not reason:
        raise HTTPException(status_code=400, detail="退回要写原因：哪里不对、要补什么")
    old_status = row.status
    before = _effective(db, sku)
    row.status = SkuSpuMatch.CONFIRMED if approve else SkuSpuMatch.RETURNED
    row.reviewed_by = user_id
    row.reviewed_at = datetime.utcnow()
    row.return_reason = None if approve else reason
    row.return_media = [] if approve else media
    _log(db, sku, "APPROVE" if approve else "RETURN", from_spu=row.spu_id, to_spu=row.spu_id, from_status=old_status,
         to_status=row.status, note=reason, media=media, user_id=user_id)
    _follow(db, sku, before)
    if approve and row.spu_id:
        # 商品资料确认后顺手让爬虫补同款图;爬虫没配/挂了不影响验收
        try:
            from app.models import WarehouseSpu
            from app.services import product_image

            spu = db.get(WarehouseSpu, row.spu_id)
            if spu is not None:
                product_image.request_for_spu(db, spu)
        except Exception:  # noqa: BLE001
            pass
    return row

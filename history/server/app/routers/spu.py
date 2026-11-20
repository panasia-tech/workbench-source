"""仓库 SPU 对照表：品牌+型号 / SPU 编码 / 该 SPU 下的一堆 SKU 编码。

维护对象是人工整理的「仓库SPU品牌型号_SPUSKU对应清单」：仓库/WMS 侧同一款货
在不同渠道会有多个 SKU 编码，这张表把它们归一到同一个 SPU，便于按款查、按款统计。
"""

import io

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, selectinload

from app.database import get_db
from app.deps import get_current_user, require_roles
from app.enums import StaffRole
from app.models import Staff, WarehouseSpu, WarehouseSpuSku
from app.schemas.spu import (
    SpuCreate,
    SpuImportResult,
    SpuLookupOut,
    SpuOut,
    SpuPage,
    SpuPendingOut,
    SpuSkuAdd,
    SpuSkuOut,
    SpuSkuUpdate,
    SpuUpdate,
)
from app.services import spu_import

router = APIRouter(prefix="/api/spu", tags=["spu"])

_XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _sku_out(row: WarehouseSpuSku, spu: WarehouseSpu) -> SpuSkuOut:
    reason = spu_import.sku_issue(row.sku_code, spu.brand, spu.model)
    return SpuSkuOut(
        id=row.id, spu_id=row.spu_id, sku_code=row.sku_code,
        placeholder_reason=reason, note=row.note, created_at=row.created_at,
    )


def _out(spu: WarehouseSpu) -> SpuOut:
    skus = [_sku_out(s, spu) for s in spu.skus]
    return SpuOut(
        id=spu.id,
        spu_code=spu.spu_code,
        brand=spu.brand,
        model=spu.model,
        brand_model=spu.brand_model,
        spec=spu.spec,
        enabled=spu.enabled,
        note=spu.note,
        sku_count=len(skus),
        real_sku_count=sum(1 for s in skus if s.placeholder_reason is None),
        skus=skus,
        created_at=spu.created_at,
        updated_at=spu.updated_at,
    )


def _attach_skus(db: Session, spu: WarehouseSpu, codes: list[str], note: str | None = None) -> tuple[int, list[str]]:
    """把一批 SKU 编码挂到 spu 上。返回 (新增数, 冲突提示)。已挂别的 SPU 的直接拒绝，不静默改挂。"""
    added = 0
    conflicts: list[str] = []
    for code in spu_import.split_sku_codes(codes):
        row = (
            db.query(WarehouseSpuSku)
            .filter(func.lower(WarehouseSpuSku.sku_code) == code.lower())
            .first()
        )
        if row is not None:
            if row.spu_id != spu.id:
                other = db.get(WarehouseSpu, row.spu_id)
                conflicts.append(f"{code}（已挂在 {other.spu_code if other else row.spu_id} 下）")
            continue  # 已挂在本 SPU 下：幂等跳过
        db.add(WarehouseSpuSku(spu_id=spu.id, sku_code=code, note=note))
        added += 1
    return added, conflicts


# ==================== 列表 / 反查 ====================
@router.get("/items", summary="SPU 对照表列表", response_model=SpuPage)
def list_spus(
    q: str | None = Query(None, description="按品牌 / 型号 / SPU编码 / SKU编码 模糊筛选"),
    enabled: bool | None = Query(None, description="只看启用 / 停用"),
    brand: str | None = Query(None, description="按品牌精确筛选"),
    unmapped: bool = Query(False, description="只看还没挂任何 SKU 编码的 SPU"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
    _: Staff = Depends(get_current_user),
):
    query = db.query(WarehouseSpu)
    if q:
        like = f"%{q.strip()}%"
        # SKU 编码命中也要把它所属的 SPU 带出来（对照表最常见的用法是拿 SKU 反查）
        sub = db.query(WarehouseSpuSku.spu_id).filter(WarehouseSpuSku.sku_code.like(like))
        query = query.filter(
            or_(
                WarehouseSpu.brand.like(like),
                WarehouseSpu.model.like(like),
                WarehouseSpu.spu_code.like(like),
                WarehouseSpu.note.like(like),
                WarehouseSpu.id.in_(sub),
            )
        )
    if enabled is not None:
        query = query.filter(WarehouseSpu.enabled.is_(enabled))
    if brand:
        query = query.filter(WarehouseSpu.brand == brand.strip())
    if unmapped:
        query = query.filter(~WarehouseSpu.skus.any())

    total = query.count()
    items = (
        query.options(selectinload(WarehouseSpu.skus))
        .order_by(WarehouseSpu.brand.asc(), WarehouseSpu.model.asc(), WarehouseSpu.spu_code.asc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return SpuPage(items=[_out(s) for s in items], total=total)


@router.get("/brands", summary="品牌下拉选项", response_model=list[str])
def list_brands(db: Session = Depends(get_db), _: Staff = Depends(get_current_user)):
    rows = db.query(WarehouseSpu.brand).distinct().order_by(WarehouseSpu.brand.asc()).all()
    return [b for (b,) in rows]


@router.get("/lookup", summary="按 SKU 编码反查 SPU", response_model=SpuLookupOut)
def lookup_by_sku(
    sku_code: str = Query(description="仓库/WMS 侧 SKU 编码"),
    db: Session = Depends(get_db),
    _: Staff = Depends(get_current_user),
):
    """对照表的主用途：拿到一个来路不明的 SKU 编码，问它是哪款货。

    查不到不算错误（返回 matched=false），调用方据此提示「清单里还没登记」。
    """
    code = (sku_code or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="sku_code 不能为空")
    row = (
        db.query(WarehouseSpuSku)
        .filter(func.lower(WarehouseSpuSku.sku_code) == code.lower())
        .first()
    )
    if row is None:
        return SpuLookupOut(sku_code=code, matched=False)
    spu = db.get(WarehouseSpu, row.spu_id)
    return SpuLookupOut(
        sku_code=code,
        matched=True,
        spu_id=spu.id,
        spu_code=spu.spu_code,
        brand=spu.brand,
        model=spu.model,
        brand_model=spu.brand_model,
    )


# ---------- 模板 / 导出 / 导入（须在 /items/{spu_id} 之前声明）----------
@router.get("/items/import-template", summary="下载导入模板")
def import_template(_: Staff = Depends(require_roles(StaffRole.WAREHOUSE))):
    return StreamingResponse(
        io.BytesIO(spu_import.build_template()),
        media_type=_XLSX_MIME,
        headers={"Content-Disposition": 'attachment; filename="spu_sku_template.xlsx"'},
    )


@router.get("/items/export", summary="导出 SPU 对照表")
def export_catalog(
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.WAREHOUSE)),
):
    """导出全部对照关系（xlsx）。导出文件列与模板一致，可直接再导入。"""
    return StreamingResponse(
        io.BytesIO(spu_import.build_export(db)),
        media_type=_XLSX_MIME,
        headers={"Content-Disposition": 'attachment; filename="spu_sku_all.xlsx"'},
    )


@router.get("/pending-codes", summary="待补正式编码的款", response_model=list[SpuPendingOut])
def pending_codes(
    db: Session = Depends(get_db),
    _: Staff = Depends(get_current_user),
):
    """列出仓库侧一个可用编码都没有的款——挂了临时码 / 占位数字 / 商品名的也算没有。

    判定要跑 Python 侧的分类器，SQL 表达不了，所以不分页整表算；
    对照表只有百来款，代价可以忽略。
    """
    return [SpuPendingOut(**item) for item in spu_import.pending_rows(db)]


@router.get("/pending-codes/export", summary="导出待补编码清单")
def export_pending(
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.WAREHOUSE)),
):
    """导出给仓库去补正式编码的清单（xlsx）。"""
    return StreamingResponse(
        io.BytesIO(spu_import.build_pending_export(db)),
        media_type=_XLSX_MIME,
        headers={"Content-Disposition": 'attachment; filename="spu_pending_codes.xlsx"'},
    )


@router.post("/items/import", summary="导入 SPU 对照表", response_model=SpuImportResult)
async def import_catalog(
    file: UploadFile = File(...),
    replace: bool = Query(
        False,
        description="false=合并导入(默认,只新增/更新/改挂,绝不删除);"
        "true=覆盖导入,对照表与文件严格一致(文件里没有的 SPU 及其 SKU 对应会被删除,仅 ADMIN 可用)",
    ),
    dry_run: bool = Query(False, description="true=只预览会改动哪些已有数据,什么都不写;界面上先预览、确认后再正式导入"),
    current: Staff = Depends(require_roles(StaffRole.WAREHOUSE)),
    db: Session = Depends(get_db),
):
    if replace and current.role != StaffRole.ADMIN:
        raise HTTPException(status_code=403, detail="当前角色只能合并导入(replace=false)")
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="文件为空")
    try:
        rows, warnings = spu_import.parse_workbook(content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not rows:
        raise HTTPException(status_code=400, detail="未解析到有效数据行（请检查「品牌+型号」与「SPU编码」列）")
    result = spu_import.upsert_catalog(db, rows, replace=replace, dry_run=dry_run)
    result["warnings"] = warnings + result["warnings"]
    return SpuImportResult(**result)


# ==================== SPU 增删改 ====================
@router.post("/items", summary="新建 SPU", response_model=SpuOut)
def create_spu(
    body: SpuCreate,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.WAREHOUSE)),
):
    code = body.spu_code.strip()
    if db.query(WarehouseSpu).filter(func.lower(WarehouseSpu.spu_code) == code.lower()).first():
        raise HTTPException(status_code=400, detail="SPU 编码已存在")
    spu = WarehouseSpu(
        spu_code=code,
        brand=body.brand.strip(),
        model=(body.model or "").strip() or None,
        spec=(body.spec or "").strip() or None,
        enabled=body.enabled,
        note=(body.note or "").strip() or None,
    )
    db.add(spu)
    db.flush()
    _, conflicts = _attach_skus(db, spu, body.sku_codes)
    if conflicts:
        db.rollback()
        raise HTTPException(status_code=400, detail="以下 SKU 编码已挂在别的 SPU 下：" + "；".join(conflicts))
    db.commit()
    db.refresh(spu)
    return _out(spu)


@router.get("/items/{spu_id}", summary="SPU 详情", response_model=SpuOut)
def get_spu(spu_id: str, db: Session = Depends(get_db), _: Staff = Depends(get_current_user)):
    spu = db.get(WarehouseSpu, spu_id)
    if not spu:
        raise HTTPException(status_code=404, detail="SPU 不存在")
    return _out(spu)


@router.patch("/items/{spu_id}", summary="更新 SPU", response_model=SpuOut)
def update_spu(
    spu_id: str,
    body: SpuUpdate,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.WAREHOUSE)),
):
    spu = db.get(WarehouseSpu, spu_id)
    if not spu:
        raise HTTPException(status_code=404, detail="SPU 不存在")
    data = body.model_dump(exclude_unset=True)
    if "spu_code" in data:
        code = (data["spu_code"] or "").strip()
        dup = (
            db.query(WarehouseSpu)
            .filter(func.lower(WarehouseSpu.spu_code) == code.lower(), WarehouseSpu.id != spu.id)
            .first()
        )
        if dup:
            raise HTTPException(status_code=400, detail="SPU 编码已存在")
        data["spu_code"] = code
    if "brand" in data:
        data["brand"] = (data["brand"] or "").strip()
        if not data["brand"]:
            raise HTTPException(status_code=400, detail="品牌不能为空")
    if "model" in data:
        data["model"] = (data["model"] or "").strip() or None
    if "note" in data:
        data["note"] = (data["note"] or "").strip() or None
    if "spec" in data:
        data["spec"] = (data["spec"] or "").strip() or None
    for key, val in data.items():
        setattr(spu, key, val)
    db.commit()
    db.refresh(spu)
    return _out(spu)


@router.delete("/items/{spu_id}", summary="删除 SPU", status_code=204)
def delete_spu(
    spu_id: str,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """删除 SPU 会连同其 SKU 对应一并删除。日常停用请用 enabled 开关。"""
    spu = db.get(WarehouseSpu, spu_id)
    if not spu:
        raise HTTPException(status_code=404, detail="SPU 不存在")
    db.delete(spu)
    db.commit()


# ==================== SKU 对应增删改 ====================
@router.post("/items/{spu_id}/skus", summary="给 SPU 追加 SKU 编码", response_model=SpuOut)
def add_skus(
    spu_id: str,
    body: SpuSkuAdd,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.WAREHOUSE)),
):
    """一行一个编码——清单里的编码本身含空格与全角逗号，不能按这些字符切分。"""
    spu = db.get(WarehouseSpu, spu_id)
    if not spu:
        raise HTTPException(status_code=404, detail="SPU 不存在")
    added, conflicts = _attach_skus(db, spu, body.sku_codes, (body.note or "").strip() or None)
    if conflicts:
        db.rollback()
        raise HTTPException(status_code=400, detail="以下 SKU 编码已挂在别的 SPU 下：" + "；".join(conflicts))
    if not added:
        raise HTTPException(status_code=400, detail="没有新增：编码为空或都已挂在本 SPU 下")
    db.commit()
    db.refresh(spu)
    return _out(spu)


@router.patch("/skus/{row_id}", summary="修改 SKU 对应", response_model=SpuSkuOut)
def update_sku(
    row_id: str,
    body: SpuSkuUpdate,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.WAREHOUSE)),
):
    """改编码 / 改备注 / 改挂到别的 SPU（挂错款时纠错用）。"""
    row = db.get(WarehouseSpuSku, row_id)
    if not row:
        raise HTTPException(status_code=404, detail="对应关系不存在")
    data = body.model_dump(exclude_unset=True)
    if "sku_code" in data:
        code = (data["sku_code"] or "").strip()
        if not code:
            raise HTTPException(status_code=400, detail="SKU 编码不能为空")
        dup = (
            db.query(WarehouseSpuSku)
            .filter(func.lower(WarehouseSpuSku.sku_code) == code.lower(), WarehouseSpuSku.id != row.id)
            .first()
        )
        if dup:
            other = db.get(WarehouseSpu, dup.spu_id)
            raise HTTPException(
                status_code=400,
                detail=f"SKU 编码「{code}」已挂在 {other.spu_code if other else dup.spu_id} 下",
            )
        row.sku_code = code
    if "spu_id" in data and data["spu_id"]:
        if not db.get(WarehouseSpu, data["spu_id"]):
            raise HTTPException(status_code=404, detail="目标 SPU 不存在")
        row.spu_id = data["spu_id"]
    if "note" in data:
        row.note = (data["note"] or "").strip() or None
    db.commit()
    db.refresh(row)
    return _sku_out(row, db.get(WarehouseSpu, row.spu_id))


@router.delete("/skus/{row_id}", summary="删除 SKU 对应", status_code=204)
def delete_sku(
    row_id: str,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.WAREHOUSE)),
):
    row = db.get(WarehouseSpuSku, row_id)
    if not row:
        raise HTTPException(status_code=404, detail="对应关系不存在")
    db.delete(row)
    db.commit()

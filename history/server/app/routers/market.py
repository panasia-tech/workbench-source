import io
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.enums import StaffRole
from app.models import CrawlPrice, CrawlProduct, Staff
from app.schemas.market import (
    CrawlImportResult,
    CrawlOcrUpload,
    CrawlPriceOut,
    CrawlPriceUpload,
    CrawlProductCreate,
    CrawlProductOut,
    CrawlProductPage,
    CrawlProductUpdate,
    CrawlTaskOut,
)
from app.services import crawl_import, crawl_price_runs
from app.services.finance import china_today

logger = logging.getLogger(__name__)
from app.services.ocr import OcrNotConfiguredError, ocr_market

router = APIRouter(prefix="/api/market", tags=["market"])


# ==================== 管理端（ADMIN）：商品 watch list CRUD ====================
@router.get("/products", summary="监控商品列表", response_model=CrawlProductPage)
def list_products(
    q: str | None = Query(None, description="按名称 / 搜索词 / 备注模糊筛选"),
    enabled: bool | None = Query(None, description="只看启用 / 停用"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    query = db.query(CrawlProduct)
    if q:
        like = f"%{q.strip()}%"
        query = query.filter(
            CrawlProduct.name.like(like)
            | CrawlProduct.keyword.like(like)
            | CrawlProduct.note.like(like)
        )
    if enabled is not None:
        query = query.filter(CrawlProduct.enabled.is_(enabled))
    total = query.count()
    items = (
        query.order_by(CrawlProduct.sort_order.asc(), CrawlProduct.created_at.asc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return CrawlProductPage(items=items, total=total)


# ---------- 批量导入 / 模板下载（注意：须在 /products/{product_id} 之前声明） ----------
@router.get("/products/import-template", summary="下载导入模板")
def import_template(
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    content = crawl_import.build_template()
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="crawl_products_template.xlsx"'},
    )


@router.get("/products/export", summary="导出监控商品")
def export_products(
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    """导出全部监控商品（xlsx）。导出文件可直接用于「覆盖导入」。"""
    content = crawl_import.build_export(db)
    return StreamingResponse(
        io.BytesIO(content),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="crawl_products_all.xlsx"'},
    )


@router.post("/products/import", summary="导入监控商品", response_model=CrawlImportResult)
async def import_products(
    file: UploadFile = File(...),
    replace: bool = Query(
        True,
        description="true=覆盖导入,名单与文件严格一致(库里有、文件里没有的会被删除,"
        "其历史行情随之删除,仅 ADMIN 可用);false=合并导入,只新增/更新,绝不删除",
    ),
    current: Staff = Depends(require_roles(StaffRole.ADMIN, StaffRole.CRAWLER, StaffRole.MARKET_BOT)),
    db: Session = Depends(get_db),
):
    """CRAWLER 只能合并导入(replace=false)。

    巡航台开爬前会自动同步一次自己的 Excel 任务清单,但那只是它的任务集、
    不是 ERP 的完整监控名单;放开覆盖模式会让爬虫账号删光其余型号及其历史行情。
    破坏性的覆盖导入仍然只有 ADMIN 能做。
    """
    if replace and current.role != StaffRole.ADMIN:
        raise HTTPException(status_code=403, detail="当前角色只能合并导入(replace=false)")
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="文件为空")
    try:
        rows = crawl_import.parse_workbook(content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not rows:
        raise HTTPException(status_code=400, detail="未解析到有效数据行（请检查「名称」列）")
    result = crawl_import.upsert_products(db, rows, created_by_id=current.id, replace=replace)
    return CrawlImportResult(**result)


@router.post("/products", summary="创建监控商品", response_model=CrawlProductOut)
def create_product(
    body: CrawlProductCreate,
    current: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    name = body.name.strip()
    if db.query(CrawlProduct).filter(CrawlProduct.name == name).first():
        raise HTTPException(status_code=400, detail="商品名已存在")
    row = CrawlProduct(
        name=name,
        keyword=(body.keyword or "").strip() or None,
        enabled=body.enabled,
        sort_order=body.sort_order,
        note=(body.note or "").strip() or None,
        created_by_id=current.id,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


@router.patch("/products/{product_id}", summary="更新监控商品", response_model=CrawlProductOut)
def update_product(
    product_id: str,
    body: CrawlProductUpdate,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    row = db.get(CrawlProduct, product_id)
    if not row:
        raise HTTPException(status_code=404, detail="商品不存在")
    data = body.model_dump(exclude_unset=True)
    if "name" in data:
        new_name = (data["name"] or "").strip()
        if not new_name:
            raise HTTPException(status_code=400, detail="商品名不能为空")
        clash = (
            db.query(CrawlProduct)
            .filter(CrawlProduct.name == new_name, CrawlProduct.id != product_id)
            .first()
        )
        if clash:
            raise HTTPException(status_code=400, detail="商品名已存在")
        data["name"] = new_name
    if "keyword" in data:
        data["keyword"] = (data["keyword"] or "").strip() or None
    if "note" in data:
        data["note"] = (data["note"] or "").strip() or None
    for k, v in data.items():
        setattr(row, k, v)
    db.commit()
    db.refresh(row)
    return row


@router.delete("/products/{product_id}", summary="删除监控商品", status_code=204)
def delete_product(
    product_id: str,
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    row = db.get(CrawlProduct, product_id)
    if not row:
        raise HTTPException(status_code=404, detail="商品不存在")
    db.delete(row)  # 价格记录随 cascade 一并删除
    db.commit()
    return Response(status_code=204)


@router.get("/products/{product_id}/prices", summary="商品价格走势", response_model=list[CrawlPriceOut])
def product_prices(
    product_id: str,
    days: int = Query(30, ge=1, le=365),
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
    db: Session = Depends(get_db),
):
    if not db.get(CrawlProduct, product_id):
        raise HTTPException(status_code=404, detail="商品不存在")
    return (
        db.query(CrawlPrice)
        .filter(CrawlPrice.product_id == product_id)
        .order_by(CrawlPrice.crawl_date.desc())
        .limit(days)
        .all()
    )


# ==================== 设备端（CRAWLER）：取任务 + 上传行情 ====================
@router.get("/crawl-tasks", summary="爬取任务列表", response_model=list[CrawlTaskOut])
def crawl_tasks(
    _: Staff = Depends(require_roles(StaffRole.CRAWLER, StaffRole.MARKET_BOT)),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(CrawlProduct)
        .filter(CrawlProduct.enabled.is_(True))
        .order_by(CrawlProduct.sort_order.asc(), CrawlProduct.created_at.asc())
        .all()
    )
    return [
        CrawlTaskOut(id=r.id, name=r.name, keyword=(r.keyword or r.name))
        for r in rows
    ]


def _save_price(db, product, crawl_date, price, trend_delta, search_heat, raw, uploader=None):
    """按 (product_id, crawl_date) upsert 一条行情，并刷新冗余最新价。

    同时往 crawl_price_run 追加一条（F01-06）：crawl_price 当天重跑会被盖掉，逐次的结果留在那边。
    """
    record = (
        db.query(CrawlPrice)
        .filter(CrawlPrice.product_id == product.id, CrawlPrice.crawl_date == crawl_date)
        .first()
    )
    if record:
        record.price = price
        record.trend_delta = trend_delta
        record.search_heat = search_heat
        record.raw = raw
    else:
        record = CrawlPrice(
            product_id=product.id,
            crawl_date=crawl_date,
            price=price,
            trend_delta=trend_delta,
            search_heat=search_heat,
            raw=raw,
        )
        db.add(record)
        db.flush()  # 要 record.id 记进逐次那条
    now = datetime.utcnow()
    db.add(crawl_price_runs.build_run(
        db, product_id=product.id, crawl_date=crawl_date, price=price, trend_delta=trend_delta,
        search_heat=search_heat, raw=raw, uploader_id=uploader.id if uploader is not None else None,
        crawl_price_id=record.id, now=now,
    ))
    # 刷新冗余「最新价」——仅当本次日期 >= 已记录的最近日期时才覆盖
    if product.last_price_date is None or crawl_date >= product.last_price_date:
        product.last_price = price
        product.last_price_date = crawl_date
    product.last_crawled_at = now
    db.commit()
    db.refresh(record)
    return record


def _resolve_upload_product(db: Session, body: CrawlPriceUpload) -> CrawlProduct:
    """按 product_id 或 product_name 定位监控商品。

    按名上报是给巡航台用的:它的任务来自本机 Excel,没有 ERP 的 product_id。
    清单里没有该型号时自动登记一条,避免每加一个型号都要先去后台建。
    """
    if body.product_id:
        product = db.get(CrawlProduct, body.product_id)
        if not product:
            raise HTTPException(status_code=404, detail="商品不存在")
        return product

    name = (body.product_name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="product_id 与 product_name 至少提供一个")
    if len(name) > 128:
        raise HTTPException(status_code=400, detail="型号名过长(上限 128 字符)")

    product = db.query(CrawlProduct).filter(CrawlProduct.name == name).first()
    if product:
        return product
    product = CrawlProduct(name=name, keyword=name, enabled=True, note="巡航台上报时自动登记")
    db.add(product)
    db.flush()
    logger.info("行情上报自动登记监控商品: %s", name)
    return product


@router.post("/prices", summary="上传行情价格", response_model=CrawlPriceOut)
def upload_price(
    body: CrawlPriceUpload,
    current: Staff = Depends(require_roles(StaffRole.CRAWLER, StaffRole.MARKET_BOT)),
    db: Session = Depends(get_db),
):
    product = _resolve_upload_product(db, body)
    crawl_date = body.crawl_date or china_today()
    return _save_price(
        db, product, crawl_date, body.price, body.trend_delta, body.search_heat, body.raw, uploader=current,
    )


@router.post("/ocr-price", summary="OCR 识别行情入库", response_model=CrawlPriceOut)
async def ocr_price(
    body: CrawlOcrUpload,
    current: Staff = Depends(require_roles(StaffRole.CRAWLER, StaffRole.MARKET_BOT)),
    db: Session = Depends(get_db),
):
    """设备端上传「行情」页截图，服务端 OCR 出近7日成交均价并入库。"""
    product = db.get(CrawlProduct, body.product_id)
    if not product:
        raise HTTPException(status_code=404, detail="商品不存在")
    try:
        result = await ocr_market(image_base64=body.image_base64)
    except OcrNotConfiguredError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    parsed = result.get("parsed") or {}
    price = parsed.get("price")
    if price is None:
        # 没识别出均价：把 OCR 原文带回，便于真机校准
        raise HTTPException(status_code=422, detail={"msg": "未识别出成交均价", "raw_text": result.get("raw_text")})

    crawl_date = body.crawl_date or china_today()
    raw = {"source": "ocr", "parsed": parsed, "raw_text": result.get("raw_text")}
    return _save_price(
        db, product, crawl_date,
        price, parsed.get("trend_delta"), parsed.get("search_heat"), raw, uploader=current,
    )

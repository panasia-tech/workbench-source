"""自动上架看板：看流水线卡在哪，把转人工的行放回流水线。

流水线本身是无人值守的（services/auto_listing/worker.py 推），但它会主动
认输——解析不出 SPU、行情倒挂、等价超期，都会停到 NEEDS_HUMAN 且 next_run_at
置空，从此没人再碰。人把 SPU 对照表补好、行情价爬到之后，得有个地方把这些行
放回流水线，否则货就永远躺在那儿了。

重试只对 NEEDS_HUMAN / FAILED 开放：PUBLISHING 的行群控作业已经在跑，重置回
RESOLVING 会再发一次，同一件货挂两条链接。
"""

from datetime import datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.deps import require_roles
from app.enums import AutoListingStage, StaffRole
from app.models import Sku, SkuAutoListing, SkuShopListing, Staff
from app.services.auto_listing.backfill import listed_sku_ids, outcome
from app.services.auto_listing.pricing import floor_price, to_int_yuan
from app.services.listing_approval import min_cost_ratio

router = APIRouter(prefix="/api/auto-listing", tags=["auto-listing"])

_ROLES = (StaffRole.ADMIN, StaffRole.WAREHOUSE, StaffRole.SALES)
# 可重试的阶段：只有「停下来等人」的两种。见模块 docstring
_RETRYABLE = (AutoListingStage.NEEDS_HUMAN, AutoListingStage.FAILED)


class AutoListingRowOut(BaseModel):
    """看板一行 = 一件货的流水线进度 + 它是哪件货（join sku）。"""

    id: str = Field(description="流水线行 ID")
    sku_id: str = Field(description="SKU ID")
    sku_code: str | None = Field(default=None, description="货号")
    product_name: str | None = Field(default=None, description="商品名称")
    brand: str | None = Field(default=None, description="品牌")
    model: str | None = Field(default=None, description="型号")
    stage: str = Field(description="阶段 RESOLVING/COLLECTING/WAIT_NEGOTIATION/READY/PUBLISHING/DONE/NEEDS_HUMAN/FAILED")
    hold_publish: bool = Field(default=False, description="存量回填的行：只补价补图，备好停在 READY 等人工上架，不发布")
    issue: str = Field(
        default="other",
        description="卡在哪：ready/ready_crawled 备好 / waiting_price / waiting_image / missing_photo / "
        "unresolved 认不出型号 / below_cost 行情低于成本 / needs_human / listed / other",
    )
    below_cost: bool = Field(default=False, description="行情价低于成本线（成本 × 后台定的比例），看板标红")
    spu_query: str | None = Field(default=None, description="解析出的「品牌 型号」搜索词")
    match_how: str | None = Field(default=None, description="解析方式 barcode/brand_model/model")
    cost_price: Decimal | None = Field(default=None, description="成本价")
    market_price: Decimal | None = Field(default=None, description="取到的行情价")
    resolved_price: Decimal | None = Field(default=None, description="定下的售价")
    negotiated_at: datetime | None = Field(default=None, description="议价完成时间；为空即卡在议价闸门")
    gc_job_id: str | None = Field(default=None, description="群控发布作业 ID")
    attempts: int = Field(description="连续未推进次数")
    last_error: str | None = Field(default=None, description="停下来的原因")
    next_run_at: datetime | None = Field(default=None, description="下次推进时间；为空 = 挂起，worker 不再捡")
    collecting_since: datetime | None = Field(default=None, description="开始等行情价的时间")
    published_at: datetime | None = Field(default=None, description="确认在架的时间")
    updated_at: datetime | None = Field(default=None, description="最近更新时间")


class AutoListingPage(BaseModel):
    items: list[AutoListingRowOut] = Field(description="当前页")
    total: int = Field(description="符合条件的总行数")


class AutoListingSummary(BaseModel):
    enabled: bool = Field(description="总开关 AUTO_LISTING_ENABLED 是否已开（关着则不登记也不推进）")
    counts: dict[str, int] = Field(description="各阶段行数，无行的阶段为 0")
    total: int = Field(description="流水线总行数")


def _below_cost(row: SkuAutoListing, sku: Sku | None, ratio) -> bool:
    if sku is None or row.market_price is None:
        return False
    floor = floor_price(sku.cost_price, ratio)
    market = to_int_yuan(row.market_price)
    return floor is not None and market is not None and market < floor


def _row_out(row: SkuAutoListing, sku: Sku | None, ratio=Decimal("1")) -> AutoListingRowOut:
    return AutoListingRowOut(
        id=row.id,
        sku_id=row.sku_id,
        sku_code=sku.sku_code if sku else None,
        product_name=sku.product_name if sku else None,
        brand=sku.brand if sku else None,
        model=sku.model if sku else None,
        stage=row.stage,
        hold_publish=bool(row.hold_publish),
        issue=outcome(row),
        below_cost=_below_cost(row, sku, ratio),
        spu_query=row.spu_query,
        match_how=row.match_how,
        cost_price=sku.cost_price if sku else None,
        market_price=row.market_price,
        resolved_price=row.resolved_price,
        negotiated_at=sku.negotiated_at if sku else None,
        gc_job_id=row.gc_job_id,
        attempts=row.attempts,
        last_error=row.last_error,
        next_run_at=row.next_run_at,
        collecting_since=row.collecting_since,
        published_at=row.published_at,
        updated_at=row.updated_at,
    )


class BackfillOut(BaseModel):
    dry_run: bool = Field(description="只数不动")
    new: int = Field(description="新登记的存量货件数（在库、没进过流水线、没在任何店铺挂着）")
    rerun: int = Field(description="以前回填过、还没备好、这次重跑的件数")
    watch_created: int = Field(description="行情监控清单新加或重新启用的型号数")
    outcomes: dict[str, int] = Field(
        description="真跑后的结果：ready 备好 / missing_photo 缺图 / waiting_price 等行情价 / "
        "unresolved 解析不出型号 / needs_human 其他要人看（行情倒挂、缺成本等）/ listed 已在架"
    )
    failed: int = Field(description="推进时出错的件数（看服务端日志）")


@router.post("/backfill", summary="存量在库货补行情价和图（不发布）", response_model=BackfillOut)
def backfill(
    dry_run: bool = Query(True, description="默认只数不动；false 才真跑"),
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """把存量货登记进流水线并当场推到「备好 / 缺什么」，备好的停在待人工上架，绝不发布。
    总开关关着也能用。"""
    from app.services.auto_listing.backfill import BackfillBusy, run_backfill

    try:
        return run_backfill(db, dry_run=dry_run)
    except BackfillBusy:
        raise HTTPException(status_code=409, detail="自动上架正在推进，过一会儿再点")


@router.get("/summary", summary="各阶段行数", response_model=AutoListingSummary)
def summary(db: Session = Depends(get_db), _: Staff = Depends(require_roles(*_ROLES))):
    """给看板顶部的筛选条用。开关状态一并带出——不然「一行都没有」到底是没货
    还是开关压根没开，看板上分不出来。"""
    rows = dict(
        db.query(SkuAutoListing.stage, func.count(SkuAutoListing.id))
        .group_by(SkuAutoListing.stage)
        .all()
    )
    counts = {stage.value: int(rows.get(stage.value, 0)) for stage in AutoListingStage}
    return AutoListingSummary(
        enabled=settings.auto_listing_enabled,
        counts=counts,
        total=sum(counts.values()),
    )


@router.get("/rows", summary="流水线列表", response_model=AutoListingPage)
def list_rows(
    stage: str | None = Query(None, description="按阶段筛选，留空看全部"),
    q: str | None = Query(None, description="按货号 / 商品名 / 品牌 / 型号模糊筛选"),
    issue: str | None = Query(None, description="unresolved：只看认不出型号的（填型号弹窗用）"),
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(*_ROLES)),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=500),
):
    """按更新时间倒序：刚出事的排最前面。"""
    query = db.query(SkuAutoListing, Sku).outerjoin(Sku, Sku.id == SkuAutoListing.sku_id)
    if stage:
        query = query.filter(SkuAutoListing.stage == stage.strip().upper())
    if issue == "unresolved":
        # 与 backfill.outcome 同一口径：转人工且原因是解析不出 SPU
        # 已在店铺挂着的不列：在卖的货重跑会把上架价改成行情价
        query = query.filter(
            SkuAutoListing.stage == AutoListingStage.NEEDS_HUMAN,
            SkuAutoListing.last_error.like("%SPU%"),
            SkuAutoListing.sku_id.notin_(listed_sku_ids(db)),
        )
    kw = (q or "").strip()
    if kw:
        like = f"%{kw}%"
        query = query.filter(
            or_(
                Sku.sku_code.like(like),
                Sku.product_name.like(like),
                Sku.brand.like(like),
                Sku.model.like(like),
            )
        )
    total = query.count()
    rows = (
        query.order_by(SkuAutoListing.updated_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    ratio = min_cost_ratio(db)
    return AutoListingPage(items=[_row_out(r, s, ratio) for r, s in rows], total=total)


@router.post("/rows/{row_id}/retry", summary="放回流水线重跑", response_model=AutoListingRowOut)
def retry_row(
    row_id: str,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(*_ROLES)),
):
    """从头（RESOLVING）重跑：转人工的原因多半是 SPU 对照表或行情价变了，
    重解析一遍才能吃到人刚补的数据，接着原阶段跑等于拿旧结论继续。
    """
    row = db.query(SkuAutoListing).filter(SkuAutoListing.id == row_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="流水线行不存在")
    if row.stage not in _RETRYABLE:
        raise HTTPException(
            status_code=400,
            detail=f"仅「转人工/失败」的行可重跑，当前 {row.stage}（在跑的行重置会重复发布）",
        )
    row.stage = AutoListingStage.RESOLVING
    row.attempts = 0
    row.last_error = None
    row.collecting_since = None
    row.next_run_at = datetime.utcnow()
    db.commit()
    db.refresh(row)
    return _row_out(row, db.get(Sku, row.sku_id), min_cost_ratio(db))


class IdentifyIn(BaseModel):
    brand: str = Field(min_length=1, max_length=64, description="品牌")
    model: str = Field(min_length=1, max_length=128, description="型号")


class IdentifyOut(BaseModel):
    row: AutoListingRowOut
    in_catalog: bool = Field(description="填的品牌型号在商品目录里找到了；false 要先去目录里加这一款")


@router.post("/rows/{row_id}/identify", summary="认不出型号时填品牌型号，重新解析", response_model=IdentifyOut)
def identify_row(
    row_id: str,
    body: IdentifyIn,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.ADMIN, StaffRole.WAREHOUSE)),
):
    """只给「解析不出型号」停下来的行用：写回货的品牌、型号，从头再跑。存量行当场跑完。"""
    from app.services.auto_listing.backfill import BackfillBusy, identify
    from app.services.spu_resolve import resolve_spu

    row = db.query(SkuAutoListing).filter(SkuAutoListing.id == row_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="流水线行不存在")
    if outcome(row) != "unresolved":
        raise HTTPException(status_code=400, detail="这件货不是卡在认不出型号")
    if db.query(listed_sku_ids(db).filter(SkuShopListing.sku_id == row.sku_id).exists()).scalar():
        raise HTTPException(status_code=400, detail="这件货已经在店铺上架了，不用再补")
    brand, model = body.brand.strip(), body.model.strip()
    if not brand or not model:
        raise HTTPException(status_code=400, detail="品牌和型号都要填")
    try:
        identify(db, row, brand=brand, model=model)
    except BackfillBusy:
        raise HTTPException(status_code=409, detail="自动上架正在推进，过一会儿再点")
    sku = db.get(Sku, row.sku_id)
    return IdentifyOut(row=_row_out(row, sku, min_cost_ratio(db)), in_catalog=resolve_spu(db, sku).matched)

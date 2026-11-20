"""本机内部接口：群控真机发布前回 ERP 再核一次（E05-10）。外部走 nginx 的请求一律拒绝。

ERP 只在建群控发布作业时查过一次（listing_ops._resolve_targets / _publish_approved），
作业在群控排队、真机执行可能隔很久，期间货卖了、被锁了、审批作废了也照发。
群控把发布任务交给执行端之前调这里（groupcontrol-server/app/erp_precheck.py）：
说不能发，群控就把任务取消（CANCELLED，原因进 task.error），ERP 回写（sync_gc_publish_status）
看到取消就把店铺置 FAILED、原因进 last_error，店铺不会卡在「上架中」。

只读，不改任何东西。判断不了的（比如 ERP 里没有这个号对应的店铺行）不拦——
这道是补漏的，不是第二套发布规则。

链接焕新（refresh=true，删掉重发）：动的是 ERP 里本来就在架的链接，所以不看「已在架」，
也不等上架审批（用户 11-10 定，见 gc_bridge/listing_refresh）；只看货还在不在库、
这家店在 ERP 里还是不是在架、有没有别的上下架在途。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.enums import ShopListingStatus, SkuStatus
from app.models import SaleShop, Sku, SkuShopListing
from app.routers.internal_notify import require_local
from app.services import listing_approval as la

router = APIRouter(prefix="/api/internal", tags=["内部"])

_SKU_STATUS_LABEL = {
    SkuStatus.RESERVED: "已预留",
    SkuStatus.SHIPPED: "已出库",
    SkuStatus.LOSS: "已报损",
    SkuStatus.SPLIT: "已拆分",
}


class PublishCheckIn(BaseModel):
    sku_code: str = Field(max_length=64)
    account_id: str = Field(max_length=36, description="群控账号 id")
    job_id: str | None = Field(default=None, max_length=36, description="群控作业 id")
    refresh: bool = Field(default=False, description="链接焕新（删掉重发）的任务：不看在架、不等审批")


def _stock_blocker(sku: Sku) -> str | None:
    if sku.status != SkuStatus.IN_STOCK:
        return f"货不在库（{_SKU_STATUS_LABEL.get(sku.status, sku.status)}）"
    if sku.reserve_source:
        return "货已锁定"
    return None


def _account_rows(db: Session, sku: Sku, account_id: str) -> list[SkuShopListing]:
    """这件货在这个群控号上的店铺行。两个店铺挂同一个号 = 闲鱼上同一条链接，两行都算。"""
    shop_ids = [sid for (sid,) in db.query(SaleShop.id).filter(SaleShop.gc_account_id == account_id)]
    cond = SkuShopListing.gc_account_id == account_id
    if shop_ids:
        cond = or_(cond, SkuShopListing.sale_shop_id.in_(shop_ids))
    return db.query(SkuShopListing).filter(SkuShopListing.sku_id == sku.id, cond).all()


def _approval_blocker(db: Session, sku: Sku, account_id: str, rows: list[SkuShopListing],
                      job_id: str | None) -> str | None:
    """开了上架审批：这一单要发的店铺，现在的批准还能不能用。

    这一单发哪个店铺：店铺行上记着这个作业号的那几行；对不上（老作业、行被改过）就按
    挂在这个号上的启用店铺算。批准换过版本（又改了价/图）也拦：这一单带的是旧内容。
    """
    mine = [r for r in rows if job_id and r.gc_job_id == job_id]
    if mine:
        targets = [(r.sale_shop_id, r) for r in mine]
    else:
        shops = db.query(SaleShop).filter(SaleShop.gc_account_id == account_id,
                                          SaleShop.enabled.is_(True)).all()
        targets = [(s.id, None) for s in shops]
    if not targets:
        return "上架审批：ERP 里没有这个号对应的店铺"
    for shop_id, row in targets:
        approval = la.current(db, sku.id, shop_id)
        why = la.problem_for_publish(db, sku, approval)
        if why:
            return f"上架审批：{why}"
        if row is not None and row.listing_approval_id and row.listing_approval_id != approval.id:
            return "上架审批：批准的内容改过了，这一单带的是旧的价和图"
    return None


def publish_blocker(db: Session, sku_code: str, account_id: str, *, job_id: str | None = None,
                    refresh: bool = False) -> str | None:
    """这一单现在还能不能发到这个号上。能发返回 None，不能发返回原因（给人看的）。"""
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if sku is None:
        return "ERP 里没有这个货号"
    why = _stock_blocker(sku)
    if why:
        return why
    rows = _account_rows(db, sku, account_id)
    if refresh:
        if any(r.gc_job_id for r in rows):
            return "这家店还有上下架在途"
        if rows and not any(r.publish_status == ShopListingStatus.LISTED for r in rows):
            return "ERP 里这家店已经不是在架状态"
        return None
    if any(r.publish_status == ShopListingStatus.SOLD for r in rows):
        return "这家店这件货已经卖掉了"
    if any(r.publish_status == ShopListingStatus.LISTED for r in rows):
        return "这家店已经在架了"
    if job_id and any(r.publish_status == ShopListingStatus.LISTING and r.gc_job_id
                      and r.gc_job_id != job_id for r in rows):
        return "这家店已经换了一单新的上架作业，这一单作废"
    if la.approval_required(db):
        return _approval_blocker(db, sku, account_id, rows, job_id)
    return None


@router.post("/publish-check", summary="群控发布前再核一次能不能发（仅本机）",
             dependencies=[Depends(require_local)])
def publish_check(body: PublishCheckIn, db: Session = Depends(get_db)):
    why = publish_blocker(db, body.sku_code.strip(), body.account_id.strip(),
                          job_id=body.job_id, refresh=body.refresh)
    return {"allow": why is None, "reason": why}

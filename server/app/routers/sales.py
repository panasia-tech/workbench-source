import io
from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.services import export_xlsx, stock_lock_delist
from app.enums import (
    OutboundType,
    ReserveSource,
    ReturnOrderStatus,
    SaleOrderStatus,
    SkuStatus,
    StaffRole,
)
from app.models import ReturnOrder, SaleOrder, SaleShop, SalesOutbound, Sku, Staff
from app.schemas.sales import (
    OutboundFeeIn,
    ManualDealRequest,
    OutboundListResponse,
    OutboundRecordOut,
    SaleListResponse,
    SaleOrderCreate,
    SaleOrderOut,
    SaleSkuMatchOut,
)
from app.services.order_no import generate_order_no
from app.services.query_filters import parse_date_range
from app.services.oss_media import sign_media_payload, thumb_url_for_cover
from app.services.staff_lookup import map_staff_names
from app.services import practice

router = APIRouter(prefix="/api/sales", tags=["sales"])


# 退货中（含待入库）视为"待退货"
ACTIVE_RETURN_STATUSES = (ReturnOrderStatus.RETURNING, ReturnOrderStatus.PENDING_INBOUND)


def _sku_by_order(
    db: Session, orders: list[SaleOrder]
) -> tuple[dict[str, Sku], dict[str, datetime]]:
    """订单关联的实物 SKU 与发货时间：走出库记录。"""
    result: dict[str, Sku] = {}
    shipped: dict[str, datetime] = {}
    if not orders:
        return result, shipped
    rows = (
        db.query(SalesOutbound.sale_order_id, SalesOutbound.created_at, Sku)
        .join(Sku, Sku.id == SalesOutbound.sku_id)
        .filter(SalesOutbound.sale_order_id.in_([o.id for o in orders]))
        .all()
    )
    for order_id, outbound_at, sku in rows:
        result[order_id] = sku
        shipped[order_id] = outbound_at
    return result, shipped


def _sale_out(
    order: SaleOrder,
    names: dict[str, str],
    sku: Sku | None = None,
    shipped_at: datetime | None = None,
) -> SaleOrderOut:
    data = SaleOrderOut.model_validate(order).model_dump()
    data["operator_name"] = names.get(order.created_by_id)
    data["shipped_at"] = shipped_at
    if sku:
        data["sku_code"] = sku.sku_code
        data["cover_url"] = sku.cover_url
        data["location_images"] = sku.location_images or []
    if not data.get("cover_url"):
        data["cover_url"] = order.product_image_url
    payload = sign_media_payload(data)
    if payload.get("cover_url"):
        payload["cover_thumb_url"] = thumb_url_for_cover(payload["cover_url"])
    return SaleOrderOut(**payload)


@router.get("/orders", response_model=SaleListResponse, summary="销售订单列表")
def list_orders(
    status: str | None = None,
    q: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    # 仓管负责发货出库，可只读查看出库（销售）记录列表
    user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    query = db.query(SaleOrder)
    # 仓管只读看全部出库记录（不按创建人过滤）；销售仅看自己的
    if user.role not in (StaffRole.ADMIN, StaffRole.WAREHOUSE):
        query = query.filter(SaleOrder.created_by_id == user.id)
    if status == "RETURNING":
        query = (
            query.join(SalesOutbound, SalesOutbound.sale_order_id == SaleOrder.id)
            .join(ReturnOrder, ReturnOrder.outbound_id == SalesOutbound.id)
            .filter(ReturnOrder.status.in_(ACTIVE_RETURN_STATUSES))
            .distinct()
        )
    elif status:
        query = query.filter(SaleOrder.status == status)
    if q:
        like = f"%{q}%"
        query = query.filter(
            (SaleOrder.order_no.like(like))
            | (SaleOrder.external_order_no.like(like))
            | (SaleOrder.buyer_name.like(like))
            | (SaleOrder.buyer_phone.like(like))
            | (SaleOrder.platform.like(like))
        )
    start, end = parse_date_range(date_from, date_to)
    if start:
        query = query.filter(SaleOrder.created_at >= start)
    if end:
        query = query.filter(SaleOrder.created_at < end)
    total = query.count()
    orders = (
        query.order_by(SaleOrder.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    names = map_staff_names(db, {o.created_by_id for o in orders})
    skus, shipped = _sku_by_order(db, orders)
    items = [_sale_out(o, names, skus.get(o.id), shipped.get(o.id)) for o in orders]
    return SaleListResponse(items=items, total=total, page=page, size=size)


def _outbounds_query(
    db: Session,
    user: Staff,
    outbound_type: str | None,
    mine: bool,
    q: str | None,
    date_from: str | None,
    date_to: str | None,
    all_operators: bool = False,
):
    """出库流水列表/导出共用的筛选查询，保证两边口径一致。

    all_operators=True 用于退货选单场景：仓管收退货与是谁出的库无关，需要看全部出库。
    """
    query = (
        db.query(SalesOutbound, Sku)
        .join(Sku, Sku.id == SalesOutbound.sku_id)
    )
    if outbound_type:
        types = [t.strip() for t in outbound_type.split(",") if t.strip()]
        if types:
            query = query.filter(SalesOutbound.outbound_type.in_(types))
    if (user.role == StaffRole.WAREHOUSE and not all_operators) or (
        mine and user.role != StaffRole.ADMIN
    ):
        query = query.filter(SalesOutbound.operator_id == user.id)
    if q:
        like = f"%{q}%"
        query = query.filter(
            (Sku.sku_code.like(like))
            | (Sku.product_name.like(like))
            | (SalesOutbound.buyer_name.like(like))
            | (SalesOutbound.outbound_no.like(like))
        )
    start, end = parse_date_range(date_from, date_to)
    if start:
        query = query.filter(SalesOutbound.created_at >= start)
    if end:
        query = query.filter(SalesOutbound.created_at < end)
    return query


def _returned_outbound_ids(db: Session, outbound_ids: list[str]) -> set[str]:
    """存在未取消退货单的出库 id 集合（含退货中/待入库/已完成）。"""
    if not outbound_ids:
        return set()
    rows = (
        db.query(ReturnOrder.outbound_id)
        .filter(
            ReturnOrder.outbound_id.in_(outbound_ids),
            ReturnOrder.status != ReturnOrderStatus.CANCELLED,
        )
        .all()
    )
    return {r[0] for r in rows}


@router.get("/outbounds", response_model=OutboundListResponse, summary="出库流水列表")
def list_outbounds(
    outbound_type: str | None = Query(None),
    mine: bool = Query(False),
    all_operators: bool = Query(False, description="退货选单用：仓管也看全部操作人的出库"),
    q: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    """出库流水：直接列 SalesOutbound，含发货/自提/切单/手动成交。

    - outbound_type 支持逗号分隔多类型（如 "ORDER_SHIP,MANUAL"）；为空则查全部类型。
    - mine=True 时按操作人归属过滤（非 ADMIN），与「我的-今日出库」统计口径一致。
    """
    query = _outbounds_query(
        db, user, outbound_type, mine, q, date_from, date_to, all_operators=all_operators
    )
    total = query.count()
    rows = (
        query.order_by(SalesOutbound.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    names = map_staff_names(db, {ob.operator_id for ob, _ in rows})
    returned = _returned_outbound_ids(db, [ob.id for ob, _ in rows])
    hide_cost = user.role == StaffRole.SALES
    items = []
    for ob, sku in rows:
        data = OutboundRecordOut.model_validate(ob).model_dump()
        data["has_return"] = ob.id in returned
        data["sku_code"] = sku.sku_code
        data["product_name"] = sku.product_name
        data["product_spec"] = sku.spec
        data["cover_url"] = sku.cover_url
        data["location_images"] = sku.location_images or []
        data["operator_name"] = names.get(ob.operator_id)
        data["fee_editable"] = _fee_editable(user, ob)
        if hide_cost:
            data["cost_price"] = None
        payload = sign_media_payload(data)
        if payload.get("cover_url"):
            payload["cover_thumb_url"] = thumb_url_for_cover(payload["cover_url"])
        items.append(OutboundRecordOut(**payload))
    return OutboundListResponse(items=items, total=total, page=page, size=size)


def _fee_editable(user: Staff, ob: SalesOutbound) -> bool:
    """自提不收服务费；出库人自己和管理员能补填。"""
    return ob.outbound_type != OutboundType.PICKUP and (user.role == StaffRole.ADMIN or ob.operator_id == user.id)


@router.post("/outbounds/{outbound_id}/platform-fee", response_model=OutboundRecordOut, summary="补填闲鱼实际服务费")
def set_outbound_fee(
    outbound_id: str,
    body: OutboundFeeIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    """出库时还看不到服务费的（闲鱼结算时才扣），之后在出库记录里补上；传空清掉、回到按档估。"""
    ob = db.get(SalesOutbound, outbound_id)
    if ob is None:
        raise HTTPException(status_code=404, detail="出库记录不存在")
    if not _fee_editable(user, ob):
        raise HTTPException(status_code=403, detail="自提没有服务费；别人出的库要管理员来改")
    if body.platform_fee is not None and body.platform_fee > ob.sale_price:
        raise HTTPException(status_code=400, detail="服务费比售价还多，核对一下闲鱼订单页上的数")
    ob.platform_fee = body.platform_fee
    db.commit()
    data = OutboundRecordOut.model_validate(ob).model_dump()
    data["fee_editable"] = True
    if user.role == StaffRole.SALES:
        data["cost_price"] = None
    return OutboundRecordOut(**data)


@router.get("/outbounds/export", summary="导出出库流水")
def export_outbounds(
    outbound_type: str | None = Query(None),
    q: str | None = None,
    date_from: str | None = None,
    date_to: str | None = None,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.ADMIN)),
):
    """导出当前筛选条件下的全部出库流水（xlsx），仅管理员。

    销售记录导出走出库口径：逐行含售价/成本/平台手续费/快递费/到手收益与退货标记，
    手续费与收益算法与经营账单(finance_stats)一致。
    """
    query = _outbounds_query(db, user, outbound_type, False, q, date_from, date_to)
    total = query.count()
    if total > export_xlsx.EXPORT_MAX_ROWS:
        raise HTTPException(
            status_code=400,
            detail=f"待导出 {total} 条超过上限 {export_xlsx.EXPORT_MAX_ROWS} 条，请缩小日期范围",
        )
    rows = query.order_by(SalesOutbound.created_at.desc()).all()
    names = map_staff_names(db, {ob.operator_id for ob, _ in rows})
    returned = _returned_outbound_ids(db, [ob.id for ob, _ in rows])
    content = export_xlsx.build_outbound_export(rows, names, returned)
    return StreamingResponse(
        io.BytesIO(content),
        media_type=export_xlsx.XLSX_MEDIA_TYPE,
        headers={"Content-Disposition": 'attachment; filename="sales_outbounds.xlsx"'},
    )


@router.post("/orders", response_model=SaleOrderOut, summary="创建销售订单")
def create_order(
    body: SaleOrderCreate,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN)),
):
    order_no = generate_order_no(db, "SO", SaleOrder, "order_no")
    order = SaleOrder(
        order_no=order_no,
        status=SaleOrderStatus.PENDING,
        created_by_id=user.id,
        **body.model_dump(),
    )
    db.add(order)
    db.commit()
    db.refresh(order)
    return _sale_out(order, {user.id: user.name})


@router.get("/sale-shops", summary="销售店铺列表")
def list_sale_shops(
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    """启用中的销售店铺列表（供手动销售等选择渠道）。"""
    rows = (
        db.query(SaleShop)
        .filter(SaleShop.enabled.is_(True))
        .order_by(SaleShop.sort_order, SaleShop.code)
        .all()
    )
    return [
        {"id": s.id, "code": s.code, "label": s.label, "xianyu_user_name": s.xianyu_user_name}
        for s in rows
    ]


@router.post("/manual-deal", response_model=SaleOrderOut, summary="手动成交出库")
def manual_deal(
    body: ManualDealRequest,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN)),
):
    """销售手动成交：一步建销售订单 + 出库（SKU→已发货）。"""
    practice.gate(db, user)
    sku_code = (body.sku_code or "").strip()
    if not sku_code:
        raise HTTPException(status_code=400, detail="请先扫码或填写货号")
    if body.sale_price is None or Decimal(body.sale_price) <= 0:
        raise HTTPException(status_code=400, detail="成交价必须大于 0")
    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")

    evidence = [u for u in (body.evidence_urls or []) if u]
    if not evidence:
        raise HTTPException(status_code=400, detail="请上传成交凭证（图片/视频）")

    phone = (body.buyer_phone or "").strip() or None
    suffix = phone[-4:] if phone and len(phone) >= 4 else None
    tracking_no = (body.tracking_no or "").strip() or None
    # 凭证可能混有视频，订单缩略图取第一张图片，没有图片再退回收款截图
    _video_ext = (".mp4", ".mov", ".m4v", ".webm")
    first_image = next((u for u in evidence if not u.lower().endswith(_video_ext)), None)

    order = SaleOrder(
        order_no=generate_order_no(db, "SO", SaleOrder, "order_no"),
        platform="manual",
        buyer_name=(body.buyer_name or "").strip() or None,
        buyer_phone=phone,
        amount=Decimal(body.sale_price),
        screenshot_url=first_image or body.payment_screenshot_url,
        product_title=sku.product_name,
        product_spec=sku.spec,
        product_image_url=sku.cover_url,
        shop_name=(body.shop_name or "").strip() or None,
        tracking_no=tracking_no,
        tracking_phone_suffix=suffix,
        status=SaleOrderStatus.PENDING,
        created_by_id=user.id,
    )
    db.add(order)
    db.flush()

    # 交易方式决定平台手续费：自提→PICKUP(0%)、平台交易→MANUAL 且按无忧档位记 worry_free
    is_pickup = (body.transaction_type or "").upper() == "PICKUP"
    ob_type = OutboundType.PICKUP if is_pickup else OutboundType.MANUAL
    worry_free = None if is_pickup else bool(body.worry_free)
    fee = None if is_pickup else body.platform_fee

    # 复用库存出库逻辑（_do_outbound 用 getattr 取字段，传简单对象即可，内部不 commit）
    req = SimpleNamespace(
        sale_order_id=order.id,
        buyer_name=order.buyer_name,
        sale_price=Decimal(body.sale_price),
        evidence_urls=evidence,
        payment_screenshot_url=body.payment_screenshot_url,
        express_fee=body.express_fee,
        worry_free=worry_free,
        platform_fee=fee,
        tracking_no=tracking_no,
        tracking_phone_suffix=suffix,
        remark=(body.remark or "").strip() or None,
    )
    from app.routers.inventory import _do_outbound  # 延迟导入避免循环依赖

    outbound = _do_outbound(db, user, sku, req, ob_type)
    db.commit()
    db.refresh(order)
    stock_lock_delist.after_stock_left(db, sku, reason="手动成交出库", operator_id=user.id)
    return _sale_out(order, {user.id: user.name}, sku=sku, shipped_at=outbound.created_at)


@router.get("/orders/{order_id}/sku-match", response_model=SaleSkuMatchOut, summary="订单扫码匹配 SKU")
def match_order_sku(
    order_id: str,
    sku_code: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    order = db.get(SaleOrder, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="销售订单不存在")
    if user.role != StaffRole.ADMIN and order.created_by_id != user.id:
        raise HTTPException(status_code=403, detail="无权操作")
    if order.status != SaleOrderStatus.PENDING:
        raise HTTPException(status_code=400, detail="订单已发货")

    sku = db.query(Sku).filter(Sku.sku_code == sku_code.strip()).first()
    if not sku:
        raise HTTPException(status_code=404, detail="SKU 不存在")
    if sku.status not in (SkuStatus.IN_STOCK, SkuStatus.RESERVED):
        raise HTTPException(status_code=400, detail="商品不在库")
    if sku.status == SkuStatus.RESERVED and sku.reserve_source == ReserveSource.SWITCH:
        raise HTTPException(status_code=400, detail="商品为切单占用，请先处理切单")

    return SaleSkuMatchOut(
        sku_code=sku.sku_code,
        product_name=sku.product_name,
        spec=sku.spec,
        location_code=sku.location_code,
        suggest_price=sku.suggest_price,
    )


@router.get("/orders/{order_id}", response_model=SaleOrderOut, summary="销售订单详情")
def get_order(
    order_id: str,
    db: Session = Depends(get_db),
    # 仓管可只读查看出库（销售）单详情
    user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    order = db.get(SaleOrder, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="销售订单不存在")
    if (
        user.role not in (StaffRole.ADMIN, StaffRole.WAREHOUSE)
        and order.created_by_id != user.id
    ):
        raise HTTPException(status_code=403, detail="无权查看")
    names = map_staff_names(db, {order.created_by_id})
    skus, shipped = _sku_by_order(db, [order])
    return _sale_out(order, names, skus.get(order.id), shipped.get(order.id))


@router.patch("/orders/{order_id}/tracking-phone", summary="补录收件人手机尾号")
def update_tracking_phone(
    order_id: str,
    body: dict,
    db: Session = Depends(get_db),
    _: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.WAREHOUSE, StaffRole.ADMIN)),
):
    """补收件人手机尾号(顺丰轨迹查询必需),并恢复对应物流轮询任务。"""
    from app.services.express import normalize_phone_suffix
    from app.services.logistics_poll import STATE_ACTIVE, STATE_NEED_PHONE
    from app.models import LogisticsPollTask
    from datetime import datetime

    order = db.get(SaleOrder, order_id)
    if not order:
        raise HTTPException(status_code=404, detail="销售订单不存在")
    suffix = normalize_phone_suffix(str(body.get("phone_suffix") or ""))
    if not suffix or len(suffix) < 4:
        raise HTTPException(status_code=400, detail="请提供 4 位手机尾号")
    order.tracking_phone_suffix = suffix
    tasks = (
        db.query(LogisticsPollTask)
        .filter(LogisticsPollTask.entity_id == order.id, LogisticsPollTask.entity_type == "SALE_ORDER")
        .all()
    )
    for t in tasks:
        t.phone_suffix = suffix
        if t.state == STATE_NEED_PHONE:
            t.state = STATE_ACTIVE
            t.next_due_at = datetime.utcnow()
    db.commit()
    return {"ok": True, "phone_suffix": suffix, "poll_tasks_resumed": len(tasks)}

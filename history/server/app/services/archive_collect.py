"""采集采购订单全流程媒体文件。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy.orm import Session

from app.schemas._tz import utc_to_cn

from app.models import (
    Inspection,
    PurchaseOrder,
    SaleOrder,
    SalesOutbound,
    Sku,
    SkuListingInfo,
    SwitchOrder,
)
from app.services.oss_media import is_oss_url_unavailable, public_url_to_object_key


@dataclass
class MediaBinding:
    table: str
    record_id: str
    attr: str
    index: int | None = None


@dataclass
class CollectedMedia:
    object_key: str
    source_url: str
    archive_name: str
    binding: MediaBinding


@dataclass
class OrderMediaBundle:
    purchase_order_id: str
    order_no: str
    order_date: str
    month_folder: str
    files: list[CollectedMedia] = field(default_factory=list)


def _bind_str(entity: object, attr: str) -> MediaBinding:
    return MediaBinding(table=entity.__tablename__, record_id=entity.id, attr=attr)


def _bind_list(entity: object, attr: str, index: int) -> MediaBinding:
    return MediaBinding(table=entity.__tablename__, record_id=entity.id, attr=attr, index=index)


def binding_to_dict(binding: MediaBinding) -> dict:
    data = {"table": binding.table, "record_id": binding.record_id, "attr": binding.attr}
    if binding.index is not None:
        data["index"] = binding.index
    return data


def _add_file(
    bundle: OrderMediaBundle,
    url: str | None,
    archive_name: str,
    binding: MediaBinding,
    seen: set[str],
) -> None:
    if not url or is_oss_url_unavailable(url):
        return
    key = public_url_to_object_key(url)
    if not key or key in seen:
        return
    seen.add(key)
    suffix = os.path.splitext(key)[1] or ".jpg"
    prefix = archive_name.rsplit(".", 1)[0]
    name = f"{prefix}{suffix}"
    bundle.files.append(
        CollectedMedia(
            object_key=key,
            source_url=url,
            archive_name=name,
            binding=binding,
        )
    )


def _order_folders(dt: datetime) -> tuple[str, str]:
    cn = utc_to_cn(dt) or dt
    return cn.strftime("%Y-%m"), cn.strftime("%Y-%m-%d")


def collect_order_media(db: Session, order: PurchaseOrder) -> OrderMediaBundle:
    ref_dt = order.updated_at or order.created_at or datetime.utcnow()
    month_folder, date_folder = _order_folders(ref_dt)
    bundle = OrderMediaBundle(
        purchase_order_id=order.id,
        order_no=order.order_no,
        order_date=date_folder,
        month_folder=month_folder,
    )
    seen: set[str] = set()

    for i, url in enumerate(order.product_images or []):
        if not url:
            continue
        _add_file(
            bundle,
            url,
            f"01_product_{i + 1}.jpg",
            _bind_list(order, "product_images", i),
            seen,
        )
    _add_file(
        bundle,
        order.screenshot_url,
        "01_purchase_screenshot.jpg",
        _bind_str(order, "screenshot_url"),
        seen,
    )
    _add_file(
        bundle,
        order.screenshot_url_2,
        "01_purchase_screenshot_2.jpg",
        _bind_str(order, "screenshot_url_2"),
        seen,
    )

    # 一单多件：每件一张验货单、一个 SKU，文件名前加 p{第几件}_ 分开
    multi = (order.quantity or 1) > 1
    inspections = db.query(Inspection).filter(Inspection.purchase_order_id == order.id).order_by(Inspection.piece_no).all()
    piece_of = {i.id: i.piece_no for i in inspections}
    for inspection in inspections:
        pre = f"p{inspection.piece_no}_" if multi else ""
        for i, url in enumerate(inspection.listing_images or []):
            _add_file(
                bundle,
                url,
                f"02_{pre}inspection_listing_{i + 1}.jpg",
                _bind_list(inspection, "listing_images", i),
                seen,
            )
        for i, url in enumerate(inspection.defect_images or []):
            _add_file(
                bundle,
                url,
                f"03_{pre}inspection_defect_{i + 1}.jpg",
                _bind_list(inspection, "defect_images", i),
                seen,
            )

    for sku in db.query(Sku).filter(Sku.purchase_order_id == order.id).all():
        pre = f"p{piece_of.get(sku.inspection_id, 1)}_" if multi else ""
        _add_file(bundle, sku.cover_url, f"04_{pre}sku_cover.jpg", _bind_str(sku, "cover_url"), seen)
        for i, url in enumerate(sku.images or []):
            _add_file(
                bundle,
                url,
                f"05_{pre}sku_image_{i + 1}.jpg",
                _bind_list(sku, "images", i),
                seen,
            )

        listing = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).first()
        if listing:
            for i, url in enumerate(listing.images or []):
                _add_file(
                    bundle,
                    url,
                    f"06_{pre}listing_image_{i + 1}.jpg",
                    _bind_list(listing, "images", i),
                    seen,
                )

        for ob in db.query(SalesOutbound).filter(SalesOutbound.sku_id == sku.id).all():
            for i, url in enumerate(ob.evidence_urls or []):
                _add_file(
                    bundle,
                    url,
                    f"07_{pre}outbound_evidence_{ob.outbound_no}_{i + 1}.jpg",
                    _bind_list(ob, "evidence_urls", i),
                    seen,
                )
            _add_file(
                bundle,
                ob.payment_screenshot_url,
                f"08_{pre}outbound_payment_{ob.outbound_no}.jpg",
                _bind_str(ob, "payment_screenshot_url"),
                seen,
            )
            if ob.sale_order_id:
                sale = db.get(SaleOrder, ob.sale_order_id)
                if sale:
                    _add_file(
                        bundle,
                        sale.screenshot_url,
                        f"09_{pre}sale_screenshot_{sale.order_no}.jpg",
                        _bind_str(sale, "screenshot_url"),
                        seen,
                    )

        for sw in db.query(SwitchOrder).filter(SwitchOrder.sku_id == sku.id).all():
            for i, url in enumerate(sw.evidence_urls or []):
                _add_file(
                    bundle,
                    url,
                    f"10_{pre}switch_evidence_{sw.switch_no}_{i + 1}.jpg",
                    _bind_list(sw, "evidence_urls", i),
                    seen,
                )
            for i, url in enumerate(sw.deposit_evidence_urls or []):
                _add_file(
                    bundle,
                    url,
                    f"11_{pre}switch_deposit_{sw.switch_no}_{i + 1}.jpg",
                    _bind_list(sw, "deposit_evidence_urls", i),
                    seen,
                )
            for i, url in enumerate(sw.final_evidence_urls or []):
                _add_file(
                    bundle,
                    url,
                    f"12_{pre}switch_final_{sw.switch_no}_{i + 1}.jpg",
                    _bind_list(sw, "final_evidence_urls", i),
                    seen,
                )

    return bundle


_TABLE_MODELS = {
    "purchase_order": PurchaseOrder,
    "inspection": Inspection,
    "sku": Sku,
    "sku_listing_info": SkuListingInfo,
    "sales_outbound": SalesOutbound,
    "sale_order": SaleOrder,
    "switch_order": SwitchOrder,
}


def apply_media_unavailable(db: Session, binding_data: dict) -> None:
    from app.services.oss_media import mark_oss_url_unavailable

    model = _TABLE_MODELS.get(binding_data["table"])
    if not model:
        return
    entity = db.get(model, binding_data["record_id"])
    if not entity:
        return
    attr = binding_data["attr"]
    index = binding_data.get("index")
    if index is not None:
        items = list(getattr(entity, attr) or [])
        if index < len(items):
            items[index] = mark_oss_url_unavailable(items[index])
            setattr(entity, attr, items)
    else:
        setattr(entity, attr, mark_oss_url_unavailable(getattr(entity, attr)))

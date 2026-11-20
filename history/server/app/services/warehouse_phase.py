"""仓库列表相位：入库 → 议价 → 填表建品 → 上架。"""



from sqlalchemy import and_, exists, or_

from sqlalchemy.orm import Query, Session



from app.enums import ListingInfoStatus, ShopListingStatus, SkuStatus, WarehousePhase

from app.models import Sku, SkuListingInfo, SkuShopListing





def _listed_exists():

    return exists().where(

        SkuShopListing.sku_id == Sku.id,

        SkuShopListing.publish_status == ShopListingStatus.LISTED,

    )





def _listing_in_progress_exists():

    return exists().where(

        SkuShopListing.sku_id == Sku.id,

        SkuShopListing.publish_status == ShopListingStatus.LISTING,

    )





def _negotiation_pending():

    return and_(Sku.negotiated_at.is_(None), Sku.status == SkuStatus.IN_STOCK)





def apply_phase_filter(query: Query, phase: str | None) -> Query:

    if not phase:

        return query.filter(Sku.status == SkuStatus.IN_STOCK)



    if phase == WarehousePhase.SHIPPED:

        return query.filter(Sku.status == SkuStatus.SHIPPED)



    if phase == WarehousePhase.LOCKED:

        return query.filter(Sku.status == SkuStatus.RESERVED)



    if phase == WarehousePhase.ON_SALE:

        return query.filter(Sku.status == SkuStatus.IN_STOCK, _listed_exists())



    if phase == WarehousePhase.LISTING:

        return query.filter(

            Sku.status == SkuStatus.IN_STOCK,

            ~_listed_exists(),

            or_(

                _listing_in_progress_exists(),

                exists().where(

                    SkuListingInfo.sku_id == Sku.id,

                    SkuListingInfo.status == ListingInfoStatus.PUBLISHING,

                ),

            ),

        )



    if phase == WarehousePhase.PENDING_CREATE:

        return query.filter(

            Sku.status == SkuStatus.IN_STOCK,

            Sku.negotiated_at.isnot(None),

            ~_listed_exists(),

            exists().where(

                SkuListingInfo.sku_id == Sku.id,

                SkuListingInfo.status.in_((ListingInfoStatus.READY, ListingInfoStatus.FAILED)),

            ),

        )



    if phase == WarehousePhase.PENDING_INBOUND:

        return query.filter(

            Sku.status == SkuStatus.IN_STOCK,

            Sku.negotiated_at.isnot(None),

            ~_listed_exists(),

            or_(

                ~exists().where(SkuListingInfo.sku_id == Sku.id),

                exists().where(

                    SkuListingInfo.sku_id == Sku.id,

                    SkuListingInfo.status == ListingInfoStatus.DRAFT,

                ),

            ),

            ~exists().where(

                SkuListingInfo.sku_id == Sku.id,

                SkuListingInfo.status == ListingInfoStatus.READY,

            ),

        )



    if phase == WarehousePhase.PENDING_NEGOTIATION:

        return query.filter(_negotiation_pending())



    return query.filter(Sku.status == SkuStatus.IN_STOCK)





def compute_warehouse_phase(

    sku: Sku,

    listing: SkuListingInfo | None,

    *,

    listed_count: int = 0,

    listing_count: int = 0,

) -> str:

    if sku.status == SkuStatus.SHIPPED:

        return WarehousePhase.SHIPPED

    if sku.status == SkuStatus.RESERVED:

        return WarehousePhase.LOCKED

    if listed_count > 0:

        return WarehousePhase.ON_SALE

    if listing and listing.status == ListingInfoStatus.PUBLISHING:

        return WarehousePhase.LISTING

    if listing_count > 0:

        return WarehousePhase.LISTING

    if sku.negotiated_at is None and sku.status == SkuStatus.IN_STOCK:

        return WarehousePhase.PENDING_NEGOTIATION

    if listing and listing.status in (ListingInfoStatus.READY, ListingInfoStatus.FAILED):

        return WarehousePhase.PENDING_CREATE

    if listing and listing.status != ListingInfoStatus.DRAFT:

        return WarehousePhase.PENDING_CREATE

    return WarehousePhase.PENDING_INBOUND





def count_on_sale(db: Session, base_query: Query | None = None) -> int:

    q = db.query(Sku).filter(Sku.status == SkuStatus.IN_STOCK, _listed_exists())

    if base_query is not None:

        q = base_query.filter(Sku.status == SkuStatus.IN_STOCK, _listed_exists())

    return q.count()



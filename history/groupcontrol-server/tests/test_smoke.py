from app.models import Account, Listing, ListingStatus


def test_tables_create_and_listing_roundtrip(db):
    acc = Account(nick="smoke")
    db.add(acc)
    db.flush()
    lst = Listing(sku="SKU_SMOKE", account_id=acc.id, status=ListingStatus.DELISTED)
    db.add(lst)
    db.commit()
    got = db.query(Listing).filter(Listing.sku == "SKU_SMOKE").one()
    assert got.status == ListingStatus.DELISTED
    assert got.account_id == acc.id

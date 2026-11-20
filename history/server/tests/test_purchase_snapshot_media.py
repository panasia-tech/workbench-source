"""采购工作台 W04（11-16 补）：卖家写的型号规格、下单后补抓的标出来、原件转存带 SHA-256（禅道 #51）。"""
import hashlib
from datetime import datetime
from decimal import Decimal

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.enums import OrderStatus, StaffRole, StaffStatus
from app.models import (PurchaseAccount, PurchaseItemSnapshot, PurchaseOrder, PurchasePlatformEvent, PurchasePlatformOrder,
                        Staff)
from app.services import purchase_platform as pp
from app.services import purchase_snapshot as snap


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine, tables=[Staff.__table__, PurchaseAccount.__table__, PurchasePlatformOrder.__table__,
                                             PurchasePlatformEvent.__table__, PurchaseOrder.__table__,
                                             PurchaseItemSnapshot.__table__])
    s = sessionmaker(bind=engine, autoflush=True)()
    s.add_all([Staff(id="p1", staff_no="p1", username="p1", name="小吕", role=StaffRole.PURCHASER, status=StaffStatus.ACTIVE,
                     password_hash="x"),
               PurchaseAccount(code="tb1", label="海蜘蛛", enabled=True)])
    s.commit()
    yield s
    s.close()


def test_老快照哈希不变_新字段有值才算进去():
    base = dict(platform_item_id="1", source_url=None, title="t", description=None, condition_text=None,
                accessories_text=None, listed_price=Decimal("1"), images=["a"])
    assert snap.content_hash(**base) == snap.content_hash(**base, declared_model=" ", specs=None)
    assert snap.content_hash(**base) != snap.content_hash(**base, declared_model="U2720Q")


def test_外面的图排队转存_自己传的算已存_存上记SHA256_失败留原因能再试(db):
    row = snap.create_version(db, purchase_order_id=None, user_id="p1", title="戴尔",
                              images=["https://img.alicdn.com/a.jpg", "purchase/products/x.jpg"],
                              videos=["https://video/v.mp4"], declared_model="U2720Q", specs="4K 27寸")
    db.commit()
    assert [(m["type"], m["status"]) for m in row.media] == [("image", "pending"), ("image", "saved"), ("video", "pending")]
    calls = []

    def fetch(url):
        if url.endswith(".mp4"):
            raise OSError("超时")
        return b"JPEGDATA", "image/jpeg"

    def upload(d, name, body, ctype):
        calls.append((d, name))
        return f"{d}/{name}"

    assert snap.archive_media(row, fetch=fetch, upload=upload) == 1
    img, _, vid = row.media
    assert img["status"] == "saved" and img["sha256"] == hashlib.sha256(b"JPEGDATA").hexdigest() and img["size"] == 8
    assert img["key"] == f"purchase/snapshots/{row.root_id}/{img['sha256'][:16]}.jpg"
    assert vid["status"] == "failed" and "超时" in vid["error"]
    out = snap.snapshot_out(row)
    assert (out["media_saved"], out["media_total"], out["declared_model"], out["specs"]) == (2, 3, "U2720Q", "4K 27寸")
    # 冻结了也能再转（不改内容）
    row.frozen_at = datetime.utcnow()
    assert snap.archive_media(row, fetch=lambda u: (b"MP4", "video/mp4"), upload=upload) == 1
    assert row.media[2]["status"] == "saved" and row.media[2]["key"].endswith(".mp4")
    assert len(calls) == 2, "存过的不再拉"


def test_执行端抓的商品页_标下单后补抓_同样内容不加版本_改了加一版首份留着(db):
    shot = {"title": "戴尔 U2720Q 95新", "description": "无坏点，带支架", "declared_model": "U2720Q", "specs": "27寸 4K",
            "images": ["https://img/1.jpg"], "captured_at": "2026-11-15T12:00:00"}
    o = {"platform_order_no": "O1", "raw_status": "等待卖家发货", "ordered_at": "2026-11-15T10:00:00", "snapshot": shot}
    pp.ingest(db, "xianyu", "海蜘蛛", [o])
    pp.ingest(db, "xianyu", "海蜘蛛", [o])
    db.commit()
    row = db.query(PurchasePlatformOrder).one()
    shots = db.query(PurchaseItemSnapshot).filter_by(platform_order_id=row.id).all()
    assert len(shots) == 1 and shots[0].capture_kind == "late" and shots[0].declared_model == "U2720Q"
    pp.ingest(db, "xianyu", "海蜘蛛", [{**o, "snapshot": {**shot, "title": "已售出"}}])
    db.commit()
    vs = sorted(db.query(PurchaseItemSnapshot).filter_by(platform_order_id=row.id).all(), key=lambda r: r.version)
    assert [v.version for v in vs] == [1, 2] and vs[0].title == "戴尔 U2720Q 95新", "卖家后来改了，首份不被覆盖"
    # 采购单挂上以后能看到这几版
    po = PurchaseOrder(order_no="PO1", status=OrderStatus.PENDING_INSPECT, product_name="x", unit_price=Decimal("1"),
                       external_order_no="O1", purchase_account="tb1", created_by_id="p1", platform_order_id=row.id)
    db.add(po)
    db.commit()
    assert [r.version for r in snap.for_order(db, po)] == [2, 1]

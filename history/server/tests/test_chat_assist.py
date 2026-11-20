"""聊天「+」面板：SKU 槽按成色分槽、实拍只出能给买家看的、自提地址只有管理员能改。"""
import pytest
from fastapi.testclient import TestClient

from app.database import Base, get_db
from app.deps import create_access_token
from app.enums import SkuStatus, StaffRole, StaffStatus
from app.main import app
from app.models import AppSetting, Inspection, Sku, SkuListingInfo, Staff, WarehouseSpu
from app.routers import chat_assist
from app.services.condition_slot import slot_of

BASE = "https://bkt.oss-cn-shanghai.aliyuncs.com"


@pytest.fixture()
def client(db_session, monkeypatch):
    Base.metadata.create_all(db_session.get_bind(), tables=[AppSetting.__table__, Inspection.__table__])
    # 签名要真 OSS：测试里原样返回，缩略图 / 封面加个标记好断言
    monkeypatch.setattr(chat_assist, "sign_oss_url", lambda u, expires=86400: u)
    monkeypatch.setattr(chat_assist, "sign_oss_thumb_url", lambda u, size="small", expires=86400: f"{u}#thumb")
    monkeypatch.setattr(chat_assist, "sign_video_poster_url", lambda u, expires=86400: f"{u}#poster")
    app.dependency_overrides[get_db] = lambda: db_session
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _auth(db, role, username):
    staff = Staff(staff_no=f"no-{username}", username=username, password_hash="x",
                  name=username, role=role, status=StaffStatus.ACTIVE)
    db.add(staff)
    db.commit()
    return {"Authorization": f"Bearer {create_access_token(staff.id, staff.role)}"}


def _sku(db, code, *, grade=None, status=SkuStatus.IN_STOCK, barcode="6900000000001", model="X1",
         images=None, location_images=None, short_code=None, inspection_id="insp-x"):
    row = Sku(
        sku_code=code, short_code=short_code, barcode=barcode, purchase_order_id="po-x",
        inspection_id=inspection_id, product_name="测试眼镜", brand="Rokid", model=model,
        condition_grade=grade, cost_price=100, status=status,
        images=images if images is not None else [f"{BASE}/sku/product/{code}-1.jpg"],
        location_images=location_images or [], location_code="A01",
    )
    db.add(row)
    db.commit()
    return row


def test_slot_of_buckets_grades():
    assert slot_of("全新") == "new"
    assert slot_of("准新") == "9"
    assert slot_of("99新") == "9"
    assert slot_of("95新") == "9"
    assert slot_of("9成新") == "9"
    assert slot_of("88新") == "8"
    assert slot_of("85新") == "8"
    assert slot_of("8新") == "8"
    assert slot_of("7新") == "7"
    assert slot_of("6新") == "6"
    assert slot_of("5新") == "6"
    assert slot_of("") == "none"
    assert slot_of(None) == "none"
    assert slot_of("成色一般") == "none"


def test_slots_group_same_spu_by_grade(client, db_session):
    db_session.add(WarehouseSpu(spu_code="6900000000001", brand="Rokid", model="X1", enabled=True))
    db_session.commit()
    base = _sku(db_session, "S-BASE", grade="9新", short_code="0209")
    _sku(db_session, "S-NEW", grade="全新")
    _sku(db_session, "S-85", grade="85新")
    _sku(db_session, "S-NONE", grade=None)
    _sku(db_session, "S-SOLD", grade="8新", status=SkuStatus.SHIPPED)          # 不在库，不进槽
    _sku(db_session, "S-OTHER", grade="9新", barcode="6900000000999", model="Y2")  # 别的款
    db_session.add(SkuListingInfo(sku_id=base.id, express_fee=0))
    db_session.commit()

    headers = _auth(db_session, StaffRole.SALES, "sales1")
    res = client.get("/api/chat-assist/slots", params={"sku": "S-BASE"}, headers=headers)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["spu"]["name"] == "Rokid X1"
    slots = {s["key"]: s for s in body["slots"]}
    assert [s["key"] for s in body["slots"]] == ["new", "9", "8", "7", "6", "none"]
    assert [i["sku_code"] for i in slots["9"]["items"]] == ["S-BASE"]
    assert [i["sku_code"] for i in slots["new"]["items"]] == ["S-NEW"]
    assert [i["sku_code"] for i in slots["8"]["items"]] == ["S-85"]
    assert slots["7"]["count"] == 0
    assert [i["sku_code"] for i in slots["none"]["items"]] == ["S-NONE"]
    assert slots["9"]["cover"].endswith("#thumb")
    assert body["item"]["grade"] == "9新"
    assert "包邮" in body["item"]["tags"] and "#0209" in body["item"]["tags"]


def test_slots_grade_falls_back_to_listing_stuff_status(client, db_session):
    row = _sku(db_session, "S-ONLY", grade=None, barcode=None, model="Z9")
    db_session.add(SkuListingInfo(sku_id=row.id, stuff_status=95))
    db_session.commit()
    headers = _auth(db_session, StaffRole.SALES, "sales2")
    body = client.get("/api/chat-assist/slots", params={"q": "S-ONLY"}, headers=headers).json()
    slots = {s["key"]: s for s in body["slots"]}
    assert [i["sku_code"] for i in slots["9"]["items"]] == ["S-ONLY"]
    assert "none" not in slots


def test_slots_404_and_forbidden(client, db_session):
    headers = _auth(db_session, StaffRole.SALES, "sales3")
    assert client.get("/api/chat-assist/slots", params={"q": "不存在的货"}, headers=headers).status_code == 404
    wh = _auth(db_session, StaffRole.WAREHOUSE, "wh1")
    assert client.get("/api/chat-assist/slots", params={"q": "x"}, headers=wh).status_code == 403


def test_media_only_buyer_safe(client, db_session):
    db_session.add(Inspection(
        id="insp-1", inspect_no="I-1", purchase_order_id="po-1", status="DONE",
        defect_videos=[f"{BASE}/inspection/defect-video/v1.mp4", f"{BASE}/sku/redispatch/x.mp4"],
    ))
    db_session.commit()
    _sku(
        db_session, "S-MEDIA", inspection_id="insp-1",
        images=[
            f"{BASE}/sku/product/a.jpg",
            f"{BASE}/asset/2026_order_shot.jpg",      # 订单截图
            f"{BASE}/sku/location/loc.jpg",           # 库位照
            f"{BASE}/inspection/listing/b.mp4",
            "__OSS_UNAVAILABLE__|" + f"{BASE}/sku/product/old.jpg",  # 已归档
            f"{BASE}/sku/product/a.jpg",              # 重复
        ],
        location_images=[f"{BASE}/sku/location/l2.jpg"],
    )
    headers = _auth(db_session, StaffRole.PURCHASER, "pur1")
    res = client.get("/api/chat-assist/skus/S-MEDIA/media", headers=headers)
    assert res.status_code == 200, res.text
    media = res.json()["media"]
    assert [(m["type"], m["url"].rsplit("/", 1)[-1]) for m in media] == [
        ("image", "a.jpg"), ("video", "b.mp4"), ("video", "v1.mp4"),
    ]
    assert media[0]["thumb"].endswith("#thumb")
    assert media[1]["thumb"].endswith("#poster")


def test_pickup_address_admin_only_and_in_config(client, db_session):
    sales = _auth(db_session, StaffRole.SALES, "sales4")
    admin = _auth(db_session, StaffRole.ADMIN, "admin1")
    assert client.put("/api/chat-assist/pickup-address", json={"text": "x"}, headers=sales).status_code == 403
    res = client.put("/api/chat-assist/pickup-address", json={"text": " 杭州市余杭区 A 仓 "}, headers=admin)
    assert res.status_code == 200 and res.json()["pickup_address"] == "杭州市余杭区 A 仓"
    assert db_session.get(AppSetting, "pickup_address").value == "杭州市余杭区 A 仓"


def test_media_returns_listing_price_and_detail_fields(client, db_session):
    sku = _sku(
        db_session, "S-PRICE", images=[f"{BASE}/sku/product/p.jpg"],
        grade="95新", short_code="0144",
    )
    sku.spec = "R7-5800H / 16G / 512G"
    sku.negotiation_remark = "含电源"
    db_session.add(SkuListingInfo(
        sku_id=sku.id, price=3999, images=[], desc="自用电脑，成色好，无拆修",
    ))
    db_session.commit()
    headers = _auth(db_session, StaffRole.PURCHASER, "pur-price")
    res = client.get("/api/chat-assist/skus/S-PRICE/media", headers=headers)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["price"] == "3999"
    assert body["sku_code"] == "S-PRICE"
    assert body["brand"] == "Rokid" and body["model"] == "X1"
    assert body["grade"] == "95新"
    assert body["state_label"] == "在库" and body["on_sale"] is False
    assert body["on_shelf_count"] == 0
    assert body["description"] == "自用电脑，成色好，无拆修"
    assert body["config"] == "R7-5800H / 16G / 512G"
    assert body["remark"] == "含电源"
    assert body["short_code"] == "0144"
    assert body["missing"] == []


def test_media_reports_missing_product_fields(client, db_session):
    sku = _sku(db_session, "S-EMPTY", images=[], grade=None)
    sku.location_code = None
    db_session.add(SkuListingInfo(sku_id=sku.id, price=None, images=[], desc=None))
    db_session.commit()
    headers = _auth(db_session, StaffRole.PURCHASER, "pur-empty")
    body = client.get("/api/chat-assist/skus/S-EMPTY/media", headers=headers).json()
    assert {"image", "price", "grade", "location", "description", "config", "remark"} <= set(body["missing"])

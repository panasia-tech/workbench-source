"""没实拍图时按 SPU 文生图补上架图。

红线：
  1. 等出图不算失败——不能把「机器正在干活」记成重试次数，等成 NEEDS_HUMAN；
  2. 供应商不支持文生图就明说，不静默换路子；
  3. 生成的图只进 SkuListingInfo，绝不写回 Sku.images（那是验货实拍图的位置）。
"""

from datetime import datetime, timedelta
from decimal import Decimal

import pytest

from app.enums import AutoListingStage, SkuStatus
from app.models import AiRedrawJob, CrawlProduct, Sku, SkuListingInfo, WarehouseSpu
from app.services.auto_listing import images as img
from app.services.auto_listing.pipeline import advance, enqueue


def _sku(db, **kw):
    base = dict(
        sku_code="M20260908-001", purchase_order_id="p", inspection_id="i",
        product_name="小米空气净化器", brand="小米", model="空气净化器4PRO",
        cost_price=Decimal("900"), status=SkuStatus.IN_STOCK,
        images=[],  # 没拍照
        negotiated_at=datetime.utcnow(),
    )
    sku = Sku(**{**base, **kw})
    db.add(sku)
    db.flush()
    return sku


@pytest.fixture()
def db(db_session):
    db_session.add(WarehouseSpu(spu_code="90000638", brand="小米", model="空气净化器4PRO"))
    db_session.add(CrawlProduct(
        name="小米 空气净化器4PRO", keyword="小米 空气净化器4PRO",
        enabled=True, last_price=Decimal("1360"),
    ))
    db_session.commit()
    return db_session


@pytest.fixture(autouse=True)
def _apinebula(monkeypatch):
    """默认按「供应商 apinebula + 生图已开」跑，并挡掉真实投递。"""
    monkeypatch.setattr(img.settings, "redraw_provider", "apinebula", raising=False)
    monkeypatch.setattr(img.settings, "auto_listing_generate_images", True, raising=False)
    monkeypatch.setattr(img.redraw_worker, "enqueue", lambda job_id: None)


def _to_collecting(db, sku):
    """推到 COLLECTING（解析已完成）。"""
    row = enqueue(db, sku)
    db.commit()
    advance(db, row)  # RESOLVING → COLLECTING
    db.commit()
    return row


# ---------------------------------------------------------------- 提示词

def test_提示词优先用解析出的规范名(db):
    sku = _sku(db, brand="小米科技", model="AC-M16-SC")
    assert "小米 空气净化器4PRO" in img.build_prompt(sku, "小米 空气净化器4PRO")


def test_没解析结果时退回品牌型号再退回商品名(db):
    sku = _sku(db)
    assert "小米 空气净化器4PRO" in img.build_prompt(sku, None)
    bare = _sku(db, sku_code="M2", brand=None, model=None, product_name="杂牌充电宝")
    assert "杂牌充电宝" in img.build_prompt(bare, None)


def test_什么都没有就拼不出提示词(db):
    bare = _sku(db, sku_code="M3", brand=None, model=None, product_name="")
    assert img.build_prompt(bare, None) == ""


def test_模板里的花括号不炸(db, monkeypatch):
    """模板是 .env 里人手填的，出现别的花括号不该 KeyError。"""
    monkeypatch.setattr(img.settings, "auto_listing_image_prompt", "{spu} 风格{未闭合", raising=False)
    assert img.build_prompt(_sku(db), "小米 净化器") == "小米 净化器 风格{未闭合"


# ---------------------------------------------------------------- 流转

def test_没实拍图就提生图任务并等着(db):
    sku = _sku(db)
    row = _to_collecting(db, sku)
    advance(db, row)
    db.commit()

    job = db.query(AiRedrawJob).one()
    assert job.status == "PENDING" and job.source_image_url == ""  # 文生图
    assert "小米 空气净化器4PRO" in job.prompt
    assert row.image_task_id == job.id
    # 等机器干活：留在 COLLECTING，且不计重试次数
    assert row.stage == AutoListingStage.COLLECTING and row.attempts == 0


def test_出图后继续往下走(db):
    sku = _sku(db)
    row = _to_collecting(db, sku)
    advance(db, row); db.commit()

    job = db.query(AiRedrawJob).one()
    job.status = "SUCCEEDED"
    job.result_url = (
        "https://bkt.oss-cn-hangzhou.aliyuncs.com/listing/ai-redraw/abc.png"
        "?OSSAccessKeyId=LTAI&Expires=1&Signature=deadbeef"
    )
    db.commit()

    advance(db, row); db.commit()
    assert row.stage == AutoListingStage.READY and row.image_count == 1
    info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).one()
    # 存干净原始 URL，不存短效签名
    assert info.images == ["https://bkt.oss-cn-hangzhou.aliyuncs.com/listing/ai-redraw/abc.png"]
    # 生成图只进上架信息，不写回验货实拍图那一栏
    assert sku.images == []


def test_等出图不计重试次数(db):
    """出图要一两分钟，轮询十几次很正常，不能把人等成 NEEDS_HUMAN。"""
    sku = _sku(db)
    row = _to_collecting(db, sku)
    for _ in range(12):
        advance(db, row)
        db.commit()
    assert row.stage == AutoListingStage.COLLECTING and row.attempts == 0
    assert db.query(AiRedrawJob).count() == 1  # 也不该重复提交


def test_生图失败退避重试并留原因(db):
    sku = _sku(db)
    row = _to_collecting(db, sku)
    advance(db, row); db.commit()
    job = db.query(AiRedrawJob).one()
    job.status = "FAILED"
    job.error_message = "apinebula 失败: 余额不足"
    db.commit()

    advance(db, row); db.commit()
    assert row.attempts == 1 and "余额不足" in row.last_error
    assert row.image_task_id is None  # 清掉，下轮重提


def test_生图超时当失败处理(db):
    sku = _sku(db)
    row = _to_collecting(db, sku)
    advance(db, row); db.commit()
    job = db.query(AiRedrawJob).one()
    job.created_at = datetime.utcnow() - timedelta(hours=2)
    db.commit()

    advance(db, row); db.commit()
    assert "超时" in row.last_error and row.image_task_id is None


# ---------------------------------------------------------------- 闸门

def test_供应商不支持文生图就明说(db, monkeypatch):
    monkeypatch.setattr(img.settings, "redraw_provider", "alapi", raising=False)
    sku = _sku(db)
    row = _to_collecting(db, sku)
    advance(db, row); db.commit()
    assert db.query(AiRedrawJob).count() == 0
    assert "apinebula" in row.last_error and row.attempts == 1


def test_生图开关关掉就还是老行为(db, monkeypatch):
    monkeypatch.setattr(img.settings, "auto_listing_generate_images", False, raising=False)
    sku = _sku(db)
    row = _to_collecting(db, sku)
    advance(db, row); db.commit()
    assert db.query(AiRedrawJob).count() == 0
    assert row.last_error == "没有可用的商品实拍图"


def test_有实拍图就不生图(db):
    sku = _sku(db, images=["https://oss/real.jpg"])
    row = _to_collecting(db, sku)
    advance(db, row); db.commit()
    assert db.query(AiRedrawJob).count() == 0
    assert row.stage == AutoListingStage.READY
    info = db.query(SkuListingInfo).filter(SkuListingInfo.sku_id == sku.id).one()
    assert info.images == ["https://oss/real.jpg"]

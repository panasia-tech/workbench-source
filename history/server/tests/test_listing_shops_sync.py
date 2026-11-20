"""gc 模式上架页快照:店铺 = 群控账号镜像,只列 gc_account_id 非空的启用店铺。

镜像同步本身(建店/改名跟随/停用/认领)见 test_gc_shop_sync.py。
gc client 全 monkeypatch(不连真 gc);gc_publish_enabled 默认 False,逐用例打开。
"""
import asyncio

import pytest

import app.services.gc_bridge.shop_sync as S
import app.services.listing_shops as LS
from app.config import settings
from app.enums import SkuStatus
from app.models import SaleShop, Sku


@pytest.fixture()
def gc_on(monkeypatch):
    monkeypatch.setattr(settings, "gc_publish_enabled", True)


def _mock_accounts(monkeypatch, accounts):
    async def list_accounts():
        return accounts
    monkeypatch.setattr(S.gc, "list_accounts", list_accounts)


def _sku(db):
    from decimal import Decimal
    sku = Sku(sku_code="SK1", product_name="显示器", purchase_order_id="po1", inspection_id="in1",
              cost_price=Decimal("1"), status=SkuStatus.IN_STOCK)
    db.add(sku)
    db.commit()
    return sku


def test_payload_lists_only_gc_backed_shops(db_session, gc_on, monkeypatch):
    db_session.add(SaleShop(code="s1", label="传统店", xianyu_user_name="tb123", enabled=True))
    _mock_accounts(monkeypatch, [{"id": "acc-1", "nick": "闲鱼甲", "device_id": "d1"}])
    sku = _sku(db_session)
    # sync_gc_publish_status 也会走 gc,顺手 mock 掉防误连
    async def no_writeback(db, sku_):
        return 0
    monkeypatch.setattr(LS, "sync_gc_publish_status", no_writeback)

    out = asyncio.run(LS.build_shops_payload(db_session, sku))
    assert [(s.shop_label, s.publish_status) for s in out] == [("闲鱼甲", "PENDING")]


def test_payload_survives_gc_down(db_session, gc_on, monkeypatch):
    # 已有镜像 + gc 挂了:快照照常出(用 DB 里的镜像),不挡查询
    db_session.add(SaleShop(code="gc-abc", label="闲鱼甲", xianyu_user_name="闲鱼甲",
                            gc_account_id="acc-1", enabled=True))

    async def boom():
        raise ConnectionError("refused")
    monkeypatch.setattr(S.gc, "list_accounts", boom)
    sku = _sku(db_session)
    out = asyncio.run(LS.build_shops_payload(db_session, sku))
    assert [s.shop_label for s in out] == ["闲鱼甲"]


def test_non_gc_mode_lists_all_enabled(db_session, monkeypatch):
    # 未开 gc:列全部启用店铺
    db_session.add_all([
        SaleShop(code="s1", label="传统店", xianyu_user_name="tb123", enabled=True),
        SaleShop(code="s2", label="停用店", xianyu_user_name="tb456", enabled=False),
    ])
    sku = _sku(db_session)
    out = asyncio.run(LS.build_shops_payload(db_session, sku))
    assert [s.shop_label for s in out] == ["传统店"]


def test_payload_carries_device_kind(db_session, gc_on, monkeypatch):
    # 店铺镜像账号 → 激活设备 kind 透传(browser=AdsPower 浏览器环境);gc 侧缺 kind 回退 android
    db_session.add_all([
        SaleShop(code="gc-abc", label="闲鱼甲", xianyu_user_name="闲鱼甲",
                 gc_account_id="acc-1", enabled=True),
        SaleShop(code="gc-def", label="闲鱼乙", xianyu_user_name="闲鱼乙",
                 gc_account_id="acc-2", enabled=True),
    ])
    _mock_accounts(monkeypatch, [
        {"id": "acc-1", "nick": "闲鱼甲", "device_id": "d1"},
        {"id": "acc-2", "nick": "闲鱼乙", "device_id": "d2"},
    ])

    async def list_devices():
        return [{"id": "d1", "kind": "browser"}, {"id": "d2"}]
    monkeypatch.setattr(S.gc, "list_devices", list_devices)
    LS._kind_cache.update(at=0.0, map={})  # 清 60s 缓存,防用例间串数据

    sku = _sku(db_session)
    out = asyncio.run(LS.build_shops_payload(db_session, sku))
    assert [(s.shop_label, s.device_kind) for s in out] == [("闲鱼甲", "browser"), ("闲鱼乙", "android")]

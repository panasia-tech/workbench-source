"""店铺 = gc 账号镜像的自动同步(gc_bridge.shop_sync.sync_gc_shops):

新账号建店、改名跟随、账号删除则停用、未绑历史店铺按名认领(全自动绑定的核心)。
gc client 全 monkeypatch;async 用 asyncio.run 直调。
"""
import asyncio

import app.services.gc_bridge.shop_sync as S
from app.models import SaleShop


def _mock_accounts(monkeypatch, accounts):
    async def list_accounts():
        return accounts
    monkeypatch.setattr(S.gc, "list_accounts", list_accounts)


def _shops(db):
    return {s.code: s for s in db.query(SaleShop).all()}


def test_new_account_creates_shop(db_session, monkeypatch):
    _mock_accounts(monkeypatch, [{"id": "a1b2c3d4e5", "nick": "深海初级葱花"}])
    asyncio.run(S.sync_gc_shops(db_session))
    shops = _shops(db_session)
    assert list(shops) == ["gc-a1b2c3d4"]
    s = shops["gc-a1b2c3d4"]
    assert s.label == "深海初级葱花" and s.xianyu_user_name == "深海初级葱花"
    assert s.gc_account_id == "a1b2c3d4e5" and s.enabled is True


def test_rename_follows(db_session, monkeypatch):
    db_session.add(SaleShop(code="gc-a1b2c3d4", label="旧名", xianyu_user_name="旧名",
                            gc_account_id="a1b2c3d4e5", enabled=True))
    db_session.commit()
    _mock_accounts(monkeypatch, [{"id": "a1b2c3d4e5", "nick": "新名"}])
    asyncio.run(S.sync_gc_shops(db_session))
    s = _shops(db_session)["gc-a1b2c3d4"]
    assert s.label == "新名" and s.xianyu_user_name == "新名"
    assert db_session.query(SaleShop).count() == 1   # 不新增


def test_account_deleted_disables_shop(db_session, monkeypatch):
    db_session.add(SaleShop(code="gc-a1b2c3d4", label="店", xianyu_user_name="店",
                            gc_account_id="a1b2c3d4e5", enabled=True))
    db_session.commit()
    _mock_accounts(monkeypatch, [])
    asyncio.run(S.sync_gc_shops(db_session))
    assert _shops(db_session)["gc-a1b2c3d4"].enabled is False


def test_manually_disabled_stays_disabled(db_session, monkeypatch):
    # 人工停用的店铺不被自动启用
    db_session.add(SaleShop(code="gc-a1b2c3d4", label="店", xianyu_user_name="店",
                            gc_account_id="a1b2c3d4e5", enabled=False))
    db_session.commit()
    _mock_accounts(monkeypatch, [{"id": "a1b2c3d4e5", "nick": "店"}])
    asyncio.run(S.sync_gc_shops(db_session))
    assert _shops(db_session)["gc-a1b2c3d4"].enabled is False


def test_adopts_legacy_shop_by_xianyu_user_name(db_session, monkeypatch):
    # 早年手工建的店铺(闲鱼账号名=昵称,未绑)→ 认领绑定,不新建重复店铺
    db_session.add(SaleShop(code="xy895904229796", label="爱吃布丁", xianyu_user_name="爱吃布丁",
                            enabled=True, sort_order=0))
    db_session.commit()
    _mock_accounts(monkeypatch, [{"id": "acc9", "nick": "爱吃布丁"}])
    asyncio.run(S.sync_gc_shops(db_session))
    shops = _shops(db_session)
    assert list(shops) == ["xy895904229796"]          # 没新建 gc- 店铺
    s = shops["xy895904229796"]
    assert s.gc_account_id == "acc9" and s.label == "爱吃布丁"


def test_adopts_legacy_shop_by_label(db_session, monkeypatch):
    # 遗留店铺 code=登录号、label=显示昵称 → 也能按 label 认领
    db_session.add(SaleShop(code="tb5747003181", label="一块布丁", xianyu_user_name="tb5747003181",
                            enabled=True, sort_order=0))
    db_session.commit()
    _mock_accounts(monkeypatch, [{"id": "acc7", "nick": "一块布丁"}])
    asyncio.run(S.sync_gc_shops(db_session))
    shops = _shops(db_session)
    assert list(shops) == ["tb5747003181"]
    s = shops["tb5747003181"]
    assert s.gc_account_id == "acc7"
    assert s.xianyu_user_name == "一块布丁"           # 名字归一为昵称(真源)


def test_unmatched_legacy_shop_left_alone(db_session, monkeypatch):
    # 没有对应 gc 账号的遗留店铺:不动(等手机上线注册后再认领)
    db_session.add(SaleShop(code="tb052254232", label="洞穴Q弹的荆芥",
                            xianyu_user_name="tb052254232", enabled=True, sort_order=0))
    db_session.commit()
    _mock_accounts(monkeypatch, [{"id": "acc1", "nick": "别的账号"}])
    asyncio.run(S.sync_gc_shops(db_session))
    shops = _shops(db_session)
    assert shops["tb052254232"].gc_account_id is None and shops["tb052254232"].enabled is True
    assert "gc-acc1" in shops                          # 别的账号正常建店

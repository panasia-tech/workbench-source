"""设备↔闲鱼账号 绑定路由(管理员):店铺×gc账号×设备的本地 join + upsert 代理。

直调 async 端点函数(绕过 Depends),gc client 全 monkeypatch(不连真 gc)。
"""
import asyncio

import pytest
from fastapi import HTTPException

import app.routers.gc_bind as B
from app.models import SaleShop


def _seed_shops(db):
    db.add_all([
        SaleShop(code="s1", label="店1", xianyu_user_name="闲鱼A", enabled=True, sort_order=0),
        SaleShop(code="s2", label="店2", xianyu_user_name="闲鱼B", enabled=True, sort_order=1),
        SaleShop(code="s3", label="店3", xianyu_user_name="闲鱼C", enabled=True, sort_order=2),
        SaleShop(code="s4", label="停用", xianyu_user_name="闲鱼D", enabled=False, sort_order=3),
    ])
    db.commit()


def _mock_gc(monkeypatch, *, accounts, devices):
    async def list_accounts():
        return accounts

    async def list_devices():
        return devices

    monkeypatch.setattr(B.gc, "list_accounts", list_accounts)
    monkeypatch.setattr(B.gc, "list_devices", list_devices)


def test_bind_shops_joins_account_and_device(db_session, monkeypatch):
    _seed_shops(db_session)
    _mock_gc(
        monkeypatch,
        # A 绑了在线且就绪、登录闲鱼==期望 的设备;B 有账号但没绑设备;C 未在群控注册
        accounts=[
            {"id": "acc-a", "nick": "闲鱼A", "device_id": "dev1"},
            {"id": "acc-b", "nick": "闲鱼B", "device_id": None},
        ],
        devices=[{"id": "dev1", "name": "红米A", "status": "ONLINE", "kind": "browser", "model": "M1", "brand": "Xiaomi",
                  "last_ready": True, "reported_nick": "闲鱼A"}],
    )

    rows = asyncio.run(B.bind_shops(db=db_session, _=None))

    # 停用店铺不出现
    assert [r.shop_code for r in rows] == ["s1", "s2", "s3"]
    a, b, c = rows
    assert a.bound is True and a.device_id == "dev1" and a.device_name == "红米A" and a.device_online is True
    assert a.device_kind == "browser"  # kind 透传(AdsPower 浏览器环境)
    assert a.gc_account_id == "acc-a"
    # 对账:在线 + 就绪 + 登录闲鱼==期望 → match
    assert a.expected_nick == "闲鱼A" and a.reported_nick == "闲鱼A"
    assert a.ready is True and a.match is True
    # B:注册了但没设备 → 未绑定,对账不匹配
    assert b.bound is False and b.device_id is None and b.gc_account_id == "acc-b"
    assert b.expected_nick == "闲鱼B" and b.reported_nick is None and b.ready is False and b.match is False
    # C:压根没注册
    assert c.bound is False and c.gc_account_id is None and c.match is False


def test_bind_shops_offline_device_not_match(db_session, monkeypatch):
    _seed_shops(db_session)
    _mock_gc(
        monkeypatch,
        accounts=[{"id": "acc-a", "nick": "闲鱼A", "device_id": "dev1"}],
        # 离线:即便就绪且昵称对,也不 match(match 要求在线)
        devices=[{"id": "dev1", "name": "红米A", "status": "OFFLINE",
                  "last_ready": True, "reported_nick": "闲鱼A"}],
    )
    rows = asyncio.run(B.bind_shops(db=db_session, _=None))
    assert rows[0].bound is True and rows[0].device_online is False
    assert rows[0].match is False


def test_bind_shops_nick_mismatch_not_match(db_session, monkeypatch):
    _seed_shops(db_session)
    _mock_gc(
        monkeypatch,
        # 设备在线且就绪,但当前登录的闲鱼(reported_nick)不是期望账号 → 串号,不 match
        accounts=[{"id": "acc-a", "nick": "闲鱼A", "device_id": "dev1"}],
        devices=[{"id": "dev1", "name": "红米A", "status": "ONLINE",
                  "last_ready": True, "reported_nick": "别的闲鱼"}],
    )
    rows = asyncio.run(B.bind_shops(db=db_session, _=None))
    a = rows[0]
    assert a.device_online is True and a.ready is True
    assert a.reported_nick == "别的闲鱼" and a.expected_nick == "闲鱼A"
    assert a.match is False


def test_bind_shops_online_not_ready_not_match(db_session, monkeypatch):
    _seed_shops(db_session)
    _mock_gc(
        monkeypatch,
        # 在线 + 昵称对,但 Preflight 未就绪 → 不 match
        accounts=[{"id": "acc-a", "nick": "闲鱼A", "device_id": "dev1"}],
        devices=[{"id": "dev1", "name": "红米A", "status": "ONLINE",
                  "last_ready": False, "reported_nick": "闲鱼A"}],
    )
    rows = asyncio.run(B.bind_shops(db=db_session, _=None))
    assert rows[0].ready is False and rows[0].match is False


def test_bind_shops_502_when_gc_down(db_session, monkeypatch):
    _seed_shops(db_session)

    async def boom():
        raise ConnectionError("refused")

    monkeypatch.setattr(B.gc, "list_accounts", boom)
    monkeypatch.setattr(B.gc, "list_devices", boom)
    with pytest.raises(HTTPException) as ei:
        asyncio.run(B.bind_shops(db=db_session, _=None))
    assert ei.value.status_code == 502


def test_bind_upsert(monkeypatch):
    seen = {}

    async def bind_account(nick, device_id=None):
        seen["nick"], seen["device_id"] = nick, device_id
        return {"id": "acc-a", "nick": nick, "device_id": device_id}

    monkeypatch.setattr(B.gc, "bind_account", bind_account)
    res = asyncio.run(B.bind(B.GcBindRequest(nick="闲鱼A", device_id="dev1"), _=None))
    assert res == {"ok": True, "nick": "闲鱼A", "device_id": "dev1", "bound": True}
    assert seen == {"nick": "闲鱼A", "device_id": "dev1"}


def test_bind_unbind_when_blank_device(monkeypatch):
    async def bind_account(nick, device_id=None):
        return {"id": "acc-a", "nick": nick, "device_id": device_id}

    monkeypatch.setattr(B.gc, "bind_account", bind_account)
    res = asyncio.run(B.bind(B.GcBindRequest(nick="闲鱼A", device_id="  "), _=None))
    assert res["bound"] is False and res["device_id"] is None


def test_bind_rejects_blank_nick(monkeypatch):
    with pytest.raises(HTTPException) as ei:
        asyncio.run(B.bind(B.GcBindRequest(nick="  ", device_id="dev1"), _=None))
    assert ei.value.status_code == 400


# ==================== 店铺→群控账号 显式绑定 ====================


def test_bind_shops_explicit_binding_uses_gc_truth(db_session, monkeypatch):
    # 店1 显式绑定 acc-x(gc nick 与 ERP 闲鱼名完全不同)→ 全以 gc 账号为真源
    _seed_shops(db_session)
    shop = db_session.query(SaleShop).filter_by(code="s1").one()
    shop.gc_account_id = "acc-x"
    db_session.commit()
    _mock_gc(
        monkeypatch,
        accounts=[{"id": "acc-x", "nick": "gc昵称X", "device_id": "dev9"}],
        devices=[{"id": "dev9", "name": "红米X", "status": "ONLINE",
                  "last_ready": True, "reported_nick": "gc昵称X"}],
    )
    rows = asyncio.run(B.bind_shops(db=db_session, _=None))
    a = rows[0]
    assert a.bound_explicit is True and a.gc_account_id == "acc-x"
    assert a.nick == "gc昵称X" and a.expected_nick == "gc昵称X"
    assert a.bound is True and a.device_name == "红米X" and a.match is True
    # 未显式绑定的店:bound_explicit=False,走旧的按名匹配
    assert rows[1].bound_explicit is False


def test_bind_shops_device_hw_id_is_the_browser_env(db_session, monkeypatch):
    # 行情台删 AdsPower 环境时按 device_hw_id 找店铺一并停用:浏览器设备的 hw_id 就是环境 ID。
    # 它跟的是账号的**当前**设备——号换到手机上之后,旧环境就不该再对上这家店,
    # 否则删一个早已不用的环境会把正在手机上卖货的店停掉。
    _seed_shops(db_session)
    s1 = db_session.query(SaleShop).filter_by(code="s1").one()
    s2 = db_session.query(SaleShop).filter_by(code="s2").one()
    s1.gc_account_id, s2.gc_account_id = "acc-web", "acc-moved"
    db_session.commit()
    _mock_gc(
        monkeypatch,
        accounts=[
            {"id": "acc-web", "nick": "浏览器号", "device_id": "dev-web"},
            {"id": "acc-moved", "nick": "搬走的号", "device_id": "dev-phone"},
        ],
        devices=[
            {"id": "dev-web", "name": "adspower browser", "kind": "browser", "hw_id": "k1env001", "status": "OFFLINE"},
            {"id": "dev-old", "name": "adspower browser", "kind": "browser", "hw_id": "k1env002",
             "status": "OFFLINE", "account_id": "acc-moved"},
            {"id": "dev-phone", "name": "红米", "kind": "android", "hw_id": "a1b2c3", "status": "ONLINE"},
        ],
    )
    rows = {r.shop_code: r for r in asyncio.run(B.bind_shops(db=db_session, _=None))}
    assert rows["s1"].device_hw_id == "k1env001" and rows["s1"].device_kind == "browser"
    assert rows["s2"].device_hw_id == "a1b2c3", "号已经换到手机上,旧环境 k1env002 不能再对上这家店"
    assert rows["s3"].device_hw_id is None


def test_bind_shops_explicit_account_deleted(db_session, monkeypatch):
    # 绑定的 gc 账号已被删:nick 空、bound False,但 gc_account_id 仍回传(便于定位)
    _seed_shops(db_session)
    shop = db_session.query(SaleShop).filter_by(code="s1").one()
    shop.gc_account_id = "acc-gone"
    db_session.commit()
    _mock_gc(monkeypatch, accounts=[], devices=[])
    rows = asyncio.run(B.bind_shops(db=db_session, _=None))
    a = rows[0]
    assert a.bound_explicit is True and a.gc_account_id == "acc-gone"
    assert a.nick == "" and a.bound is False and a.match is False


def test_bind_shop_write_and_unbind(db_session, monkeypatch):
    _seed_shops(db_session)

    async def get_account(aid):
        return {"id": aid, "nick": "gc昵称X", "device_id": "dev9"} if aid == "acc-x" else None
    monkeypatch.setattr(B.gc, "get_account", get_account)

    shop = db_session.query(SaleShop).filter_by(code="s1").one()
    res = asyncio.run(B.bind_shop(B.GcBindShopRequest(shop_id=shop.id, gc_account_id="acc-x"),
                                  db=db_session, _=None))
    assert res == {"ok": True, "shop_id": shop.id, "gc_account_id": "acc-x",
                   "nick": "gc昵称X", "bound": True}
    assert shop.gc_account_id == "acc-x"

    res = asyncio.run(B.bind_shop(B.GcBindShopRequest(shop_id=shop.id, gc_account_id="  "),
                                  db=db_session, _=None))
    assert res["bound"] is False and res["gc_account_id"] is None
    assert shop.gc_account_id is None


def test_bind_shop_rejects_unknown_account(db_session, monkeypatch):
    _seed_shops(db_session)

    async def get_account(aid):
        return None
    monkeypatch.setattr(B.gc, "get_account", get_account)

    shop = db_session.query(SaleShop).filter_by(code="s1").one()
    with pytest.raises(HTTPException) as ei:
        asyncio.run(B.bind_shop(B.GcBindShopRequest(shop_id=shop.id, gc_account_id="acc-x"),
                                db=db_session, _=None))
    assert ei.value.status_code == 400
    assert shop.gc_account_id is None


def test_bind_shop_404_unknown_shop(db_session):
    with pytest.raises(HTTPException) as ei:
        asyncio.run(B.bind_shop(B.GcBindShopRequest(shop_id="nope", gc_account_id=None),
                                db=db_session, _=None))
    assert ei.value.status_code == 404


def test_bind_accounts_lists_with_device(db_session, monkeypatch):
    _mock_gc(
        monkeypatch,
        accounts=[{"id": "acc-x", "nick": "gc昵称X", "device_id": "dev9"},
                  {"id": "acc-y", "nick": "无设备号", "device_id": None}],
        devices=[{"id": "dev9", "name": "红米X", "status": "ONLINE", "kind": "browser"}],
    )
    rows = asyncio.run(B.bind_accounts(_=None))
    x, y = rows
    assert x.nick == "gc昵称X" and x.device_name == "红米X" and x.device_online is True
    assert x.device_kind == "browser"  # kind 透传(AdsPower 浏览器环境)
    assert y.device_id is None and y.device_online is False


def test_bind_devices_kind_passthrough(db_session, monkeypatch):
    _mock_gc(
        monkeypatch,
        accounts=[],
        devices=[{"id": "dev9", "name": "红米X", "status": "ONLINE", "kind": "browser"},
                 {"id": "dev10", "name": "红米Y", "status": "OFFLINE"}],
    )
    rows = asyncio.run(B.bind_devices(_=None))
    x, y = rows
    assert x.kind == "browser"   # AdsPower 浏览器环境如实下发
    assert y.kind == "android"   # gc 侧缺 kind 字段时回退 android

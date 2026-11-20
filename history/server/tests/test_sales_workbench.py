"""销售工作台首页 /api/sales-workbench/overview。

只验汇总对不对、范围对不对：今日成交按出库人、北京时间今天；「我的号」按群控负责人筛，
没分到号就看全部；群控连不上 / 某一项出错只把那项给 null；不返回任何成本字段。
群控 client 全 monkeypatch，不连真群控。
"""

import json
from datetime import datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.database import Base, get_db
from app.deps import create_access_token
from app.enums import AutoListingStage, ShopListingStatus, SkuStatus, StaffRole, StaffStatus
from app.main import app
from app.models import (
    Inspection,
    PurchaseOrder,
    SaleShop,
    SalesOutbound,
    Sku,
    SkuAutoListing,
    SkuShopListing,
    Staff,
)
from app.services import listing_approval as la
from app.services import sales_workbench as sw
from app.services.app_settings import set_setting
from app.services.finance import cn_today_start_utc

_ACCOUNTS = [{"id": "acc-a", "nick": "闲鱼A"}, {"id": "acc-b", "nick": "闲鱼B"}, {"id": "acc-c", "nick": "闲鱼C"}]


def _staff(db, role, username):
    s = Staff(staff_no=f"no-{username}", username=username, password_hash="x", name=username, role=role,
              status=StaffStatus.ACTIVE)
    db.add(s)
    db.flush()
    return s


def _sku(db, code, **kw):
    base = dict(sku_code=code, purchase_order_id="p", inspection_id="i", product_name=f"货{code}",
                cost_price=Decimal("900"), status=SkuStatus.IN_STOCK, images=[f"https://oss/{code}.jpg"])
    sku = Sku(**{**base, **kw})
    db.add(sku)
    db.flush()
    return sku


def _outbound(db, sku, staff, price, at):
    db.add(SalesOutbound(outbound_no=f"OB-{sku.sku_code}", sku_id=sku.id, outbound_type="ORDER_SHIP",
                         sale_price=Decimal(price), cost_price=Decimal("1"), operator_id=staff.id, created_at=at))


@pytest.fixture()
def db(db_session):
    # 共用夹具里没有出库、采购、验货表，这里补建（管理员算提成要查后两张）
    Base.metadata.create_all(
        db_session.get_bind(),
        tables=[SalesOutbound.__table__, PurchaseOrder.__table__, Inspection.__table__],
        checkfirst=True,
    )
    return db_session


@pytest.fixture()
def seeded(db):
    me = _staff(db, StaffRole.SALES, "tao")
    other = _staff(db, StaffRole.SALES, "shao")
    admin = _staff(db, StaffRole.ADMIN, "boss")
    shop_a = SaleShop(code="A", label="店A", xianyu_user_name="闲鱼A", gc_account_id="acc-a", sort_order=1)
    shop_b = SaleShop(code="B", label="店B", xianyu_user_name="闲鱼B", gc_account_id="acc-b", sort_order=2)
    shop_off = SaleShop(code="X", label="停用店", xianyu_user_name="x", gc_account_id="acc-x", enabled=False)
    db.add_all([shop_a, shop_b, shop_off])
    db.flush()

    # 在架：A 两条、B 一条；A 还有一条已售的不算
    for code, shop, st in (("L1", shop_a, "LISTED"), ("L2", shop_a, "LISTED"), ("L3", shop_b, "LISTED"),
                           ("L4", shop_a, "SOLD")):
        sku = _sku(db, code)
        db.add(SkuShopListing(sku_id=sku.id, sale_shop_id=shop.id, publish_status=ShopListingStatus(st)))

    # 今天我出了两件（100 + 250），昨天一件、别人今天一件都不算
    today = cn_today_start_utc() + timedelta(hours=1)
    _outbound(db, _sku(db, "S1", status=SkuStatus.SHIPPED), me, "100", today)
    _outbound(db, _sku(db, "S2", status=SkuStatus.SHIPPED), me, "250", today)
    _outbound(db, _sku(db, "S3", status=SkuStatus.SHIPPED), me, "999", cn_today_start_utc() - timedelta(hours=1))
    _outbound(db, _sku(db, "S4", status=SkuStatus.SHIPPED), other, "777", today)

    # 库存缺口：一件认不出型号（要人补），一件爬虫在爬价（不用管）
    g1 = _sku(db, "G1")
    db.add(SkuAutoListing(sku_id=g1.id, stage=AutoListingStage.NEEDS_HUMAN,
                          last_error="解析不出所属 SPU（品牌/型号不在对照表里）", hold_publish=True))
    g2 = _sku(db, "G2")
    db.add(SkuAutoListing(sku_id=g2.id, stage=AutoListingStage.COLLECTING, last_error="还没有行情价", hold_publish=True))
    db.commit()
    return {"me": me, "other": other, "admin": admin}


def _gc(me_id, *, waiting=None):
    return {
        "owners": {"acc-a": [{"staff_id": me_id, "staff_name": "tao"}], "acc-c": [{"staff_id": me_id}],
                   "acc-b": [{"staff_id": "someone-else"}]},
        "accounts": _ACCOUNTS,
        "waiting": waiting if waiting is not None else [
            {"account": "闲鱼A", "buyer": "买家1"},
            {"account": "闲鱼A", "buyer": "买家2"},
            {"account": "闲鱼B", "buyer": "买家3"},
            {"account": "acc-c", "buyer": "买家4"},  # 群控那边没昵称时给的是账号 id
        ],
    }


def test_销售只看自己的成交和自己负责的号(db, seeded):
    me = seeded["me"]
    res = sw.build_overview(db, me, _gc(me.id))
    assert res["today_deals"] == 2 and res["today_amount"] == 350.0
    assert res["accounts_scope"] == "mine"
    assert [(a["nick"], a["listed"], a["waiting"]) for a in res["accounts"]] == [("闲鱼A", 2, 2), ("闲鱼C", 0, 1)], \
        "分给我但 ERP 没对上店铺的号也列出来"
    assert res["listed"] == 2
    assert res["messages"] == 3
    assert res["gaps"] == 1, "爬虫在爬价的不用人管，不算"
    assert res["commission"] == 20.0
    assert res["approval"] == {"required": False, "todo": None, "review": None, "fix": None}
    assert [(t["key"], t["count"], t["url"]) for t in res["todos"]] == [
        ("chat", 3, "/pages/sales-assist/index"),
        ("gaps", 1, "/pages/warehouse/gaps/index"),
    ]
    assert res["todos"][0]["text"] == "3 个买家在等回复"
    assert "cost" not in json.dumps(res), "销售看不到成本"


def test_没分到号就看全部启用店铺(db, seeded):
    other = seeded["other"]
    res = sw.build_overview(db, other, _gc("nobody"))
    assert res["accounts_scope"] == "all"
    assert [a["nick"] for a in res["accounts"]] == ["闲鱼A", "闲鱼B"], "停用店铺不列"
    assert res["listed"] == 3 and res["messages"] == 4
    assert res["today_deals"] == 1 and res["today_amount"] == 777.0


def test_管理员看全部(db, seeded):
    res = sw.build_overview(db, seeded["admin"], _gc(seeded["admin"].id))
    assert res["accounts_scope"] == "all" and res["listed"] == 3 and res["messages"] == 4
    assert res["today_deals"] == 3 and res["today_amount"] == 1127.0


def test_群控连不上_消息给null_其余照常(db, seeded, monkeypatch):
    async def boom(*a, **k):
        raise RuntimeError("群控没开")

    for name in ("chat_sla_owners", "list_accounts", "chat_sla_waiting"):
        monkeypatch.setattr(sw.gc, name, boom)
    import asyncio

    gc_data = asyncio.run(sw.fetch_gc())
    assert gc_data == {"owners": None, "accounts": None, "waiting": None, "waiting_conf": {}}
    res = sw.build_overview(db, seeded["me"], gc_data)
    assert res["messages"] is None
    assert res["accounts_scope"] == "all"
    assert [(a["nick"], a["waiting"]) for a in res["accounts"]] == [("店A", None), ("店B", None)]
    assert res["today_deals"] == 2 and res["gaps"] == 1
    assert [t["key"] for t in res["todos"]] == ["gaps"]


def test_单项出错只给null(db, seeded, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("坏了")

    monkeypatch.setattr(sw.sg, "overview", boom)
    res = sw.build_overview(db, seeded["me"], _gc(seeded["me"].id))
    assert res["gaps"] is None
    assert res["today_deals"] == 2 and res["messages"] == 3
    assert "gaps" not in [t["key"] for t in res["todos"]]


def test_上架审批开着才数待清洗和整改(db, seeded):
    set_setting(db, la.REQUIRED_KEY, "1", seeded["admin"].id)
    db.commit()
    res = sw.build_overview(db, seeded["me"], _gc(seeded["me"].id))
    ap = res["approval"]
    assert ap["required"] is True
    # 在库 6 件（L1~L4、G1、G2），两家店都没清洗；L1~L3 在架又没有批准 → 要整改
    assert ap["todo"] == 6 and ap["fix"] == 3 and ap["review"] == 0
    keys = [t["key"] for t in res["todos"]]
    assert keys == ["chat", "fix", "todo", "gaps"]
    fix = next(t for t in res["todos"] if t["key"] == "fix")
    assert fix["url"] == "/pages/listing/approvals/index?state=fix" and fix["text"] == "3 件在架的要整改"


def test_待审批谁都能批_说法一样(db, seeded):
    ap = {"required": True, "todo": 0, "review": 2, "fix": 0}
    assert sw.build_todos(seeded["admin"], messages=None, approval=ap, gaps=None)[0]["text"] == "2 件等审批"
    assert sw.build_todos(seeded["me"], messages=None, approval=ap, gaps=None)[0]["text"] == "2 件等审批"


# ---------------------------------------------------------------- HTTP

@pytest.fixture()
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)


def _auth(staff):
    return {"Authorization": f"Bearer {create_access_token(staff.id, staff.role)}"}


def test_接口_销售能看_仓管不行(client, db, seeded, monkeypatch):
    me = seeded["me"]
    data = _gc(me.id)

    async def owners():
        return data["owners"]

    async def accounts():
        return data["accounts"]

    async def waiting():
        return {"items": data["waiting"], "conf": {}}

    monkeypatch.setattr(sw.gc, "chat_sla_owners", owners)
    monkeypatch.setattr(sw.gc, "list_accounts", accounts)
    monkeypatch.setattr(sw.gc, "chat_sla_waiting", waiting)

    r = client.get("/api/sales-workbench/overview", headers=_auth(me))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["today_deals"] == 2 and body["messages"] == 3 and body["listed"] == 2
    # 红点：刚开过「今天」就直接用缓存，和 overview 一样
    r = client.get("/api/sales-workbench/badges", headers=_auth(me))
    assert r.status_code == 200 and r.json() == body["badges"]

    wh = _staff(db, StaffRole.WAREHOUSE, "wh")
    db.commit()
    assert client.get("/api/sales-workbench/overview", headers=_auth(wh)).status_code == 403
    assert client.get("/api/sales-workbench/overview").status_code == 401


def test_发货时限_17点前当天_17点后次日():
    # 北京 10:00 卖出 → 当天 17:00；北京 18:00 卖出 → 次日 17:00（参数和返回都是 UTC）
    assert sw.ship_deadline(datetime(2026, 11, 13, 2, 0)) == datetime(2026, 11, 13, 9, 0)
    assert sw.ship_deadline(datetime(2026, 11, 13, 10, 0)) == datetime(2026, 11, 14, 9, 0)


def test_今天_要发的货按时限标红黄_先红后黄_只看我的号(db, seeded):
    from app.enums import ReserveSource

    me = seeded["me"]
    shops = {s.code: s for s in db.query(SaleShop).all()}
    now = datetime(2026, 11, 13, 10, 0)  # 北京 18:00
    for code, shop, sold in (("P1", "A", datetime(2026, 11, 11, 2, 0)),   # 两天前，过了时限
                             ("P2", "A", datetime(2026, 11, 13, 9, 30)),  # 北京 17:30 卖出，明天 17:00 前发
                             ("P3", "B", datetime(2026, 11, 11, 2, 0))):  # 不是我的号
        sku = _sku(db, code, status=SkuStatus.RESERVED, reserve_source=ReserveSource.PLATFORM_SOLD)
        db.add(SkuShopListing(sku_id=sku.id, sale_shop_id=shops[shop].id,
                              publish_status=ShopListingStatus.SOLD, sold_at=sold))
    db.commit()
    ships = sw.ship_tasks(db, me, {shops["A"].id}, now=now)
    assert [(t["key"], t["level"]) for t in ships] == [("ship:P1", "red"), ("ship:P2", "yellow")]
    assert "超过发货时限 2 天（11-11 17:00 前要发）" in ships[0]["sub"] and ships[0]["url"].endswith("?code=P1")
    assert "11-14 17:00 前发" in ships[1]["sub"]
    tasks = sw.build_tasks([{"key": "gaps", "count": 1, "text": "1 件库存要人补", "url": "/g"},
                            {"key": "chat", "count": 2, "text": "2 个买家在等回复", "url": "/c"}], ships)
    assert [t["key"] for t in tasks] == ["chat", "ship:P1", "gaps", "ship:P2"], "先红后黄，同色待办在前"
    assert len(sw.ship_tasks(db, seeded["admin"], None, now=now)) == 3, "管理员看全部"


def test_今天_订单问题和每件货并进一列_一件货一行(db, seeded):
    ships = [{"key": "ship:P1", "kind": "ship", "level": "red", "at": "2026-11-11"}]
    orders = sw.order_tasks({"problems": [
        {"kind": "stuck", "sku_code": "P1", "level": "red"},  # 就是要发的货，不重复
        {"kind": "unsync", "kind_label": "状态不同步", "sku_code": "U1", "product_name": "U", "level": "red",
         "text": "ERP 已出库，闲鱼上还挂着：A", "thumb": None, "url": "/off", "button": "去下架", "at": "x"},
    ]})
    goods = sw.goods_tasks({"items": [
        {"sku_code": "P1", "level": "red", "product_name": "P", "thumb": None, "url": "/i/P1",
         "issues": [{"level": "red", "text": "卖出了还没发", "url": "/ship"}]},
        {"sku_code": "S1", "level": "red", "product_name": "S", "thumb": None, "url": "/i/S1",
         "issues": [{"level": "red", "text": "滞销：在库 40 天", "url": "/d"}, {"level": "yellow", "text": "x", "url": "/a"}]},
        {"sku_code": "Y1", "level": "yellow", "product_name": "Y", "thumb": None, "url": "/i/Y1",
         "issues": [{"level": "yellow", "text": "2 个号等审批", "url": "/a"}]},
        {"sku_code": "G1", "level": "green", "product_name": "G", "thumb": None, "url": "/i/G1", "issues": []},
    ]})
    todos = [{"key": "chat", "count": 2, "text": "2 个买家在等回复", "url": "/c"},
             {"key": "review", "count": 1, "text": "1 件等审批", "url": "/r"}]
    tasks = sw.build_tasks(todos, ships, orders, goods)
    assert [t["key"] for t in tasks] == ["chat", "ship:P1", "order-unsync:U1", "item:S1", "item:Y1"]
    assert tasks[3]["sub"] == "滞销：在库 40 天（另有 1 项）" and tasks[3]["url"] == "/d", "点了直接去处理最急的那项"
    # 库存商品没拿到：计数待办照旧列
    assert [t["key"] for t in sw.build_tasks(todos, ships)] == ["chat", "ship:P1", "review"]


def test_今天_每件货只出我的号上的和没人上过的(db, seeded):
    """原来全公司的货都在每个销售的「今天」里：B 号卖出没发的货在 A 号负责人那里也红。"""
    shops = {s.code: s for s in db.query(SaleShop).all()}
    goods = [{"sku_code": c, "level": "red"} for c in ("L1", "L3", "L4", "G1")]
    # L1 在 A（我的）、L3 只在 B、L4 在 A 卖过、G1 哪个号都没上过
    got = sw._goods_for_my_shops(db, goods, {shops["A"].id})
    assert [g["sku_code"] for g in got] == ["L1", "L4", "G1"]


def test_今天_带我是谁_练习没做完就锁着(db, seeded, monkeypatch):
    monkeypatch.setattr(sw, "_practice_left", lambda db, user: 2)
    res = sw.build_overview(db, seeded["me"], _gc(seeded["me"].id))
    assert res["me"]["role_label"] == "销售" and res["me"]["name"]
    assert res["locked"] is True and res["tasks"][0]["key"] == "practice"
    assert "commission_month" in res
    b = res["badges"]
    assert b["practice"] == 2 and b["today"] == sum(t["level"] == "red" for t in res["tasks"])
    assert b["goods"] is not None and b["orders"] is not None
    sw.remember_badges("u1", b)
    assert sw.cached_badges("u1") == b and sw.cached_badges("u2") is None


def test_已废弃平台的历史单不当成要发的货(db, seeded):
    from app.models import SaleOrder

    db.add(SaleOrder(order_no="OLD1", platform="xianguanjia", status="PENDING", created_by_id=seeded["me"].id,
                     created_at=datetime(2026, 6, 1)))
    db.add(SaleOrder(order_no="NEW1", platform="manual", status="PENDING", created_by_id=seeded["me"].id,
                     created_at=datetime(2026, 11, 13, 2, 0)))
    db.commit()
    keys = [t["title"] for t in sw.ship_tasks(db, seeded["admin"], None, now=datetime(2026, 11, 13, 3, 0))]
    assert keys == ["发货：NEW1"]


def test_库存商品_每件货取最严重的颜色(db, seeded):
    from app.enums import ReserveSource
    from app.services import sales_goods as sg2

    shops = {s.code: s for s in db.query(SaleShop).all()}
    sold = _sku(db, "R1", status=SkuStatus.RESERVED, reserve_source=ReserveSource.PLATFORM_SOLD)
    db.add(SkuShopListing(sku_id=sold.id, sale_shop_id=shops["A"].id, publish_status=ShopListingStatus.SOLD,
                          sold_at=datetime(2026, 11, 10, 2, 0)))
    db.add(SkuShopListing(sku_id=sold.id, sale_shop_id=shops["B"].id, publish_status=ShopListingStatus.LISTED))
    _sku(db, "N1", images=[])
    db.commit()
    res = sg2.build(db, seeded["admin"], now=datetime(2026, 11, 13, 3, 0))
    cards = {c["sku_code"]: c for c in res["items"]}
    r1 = cards["R1"]
    assert r1["level"] == "red" and [i["text"][:6] for i in r1["issues"]] == ["卖出了还没发", "已锁单，还有"]
    assert cards["N1"]["level"] == "red" and "没有实拍图" in cards["N1"]["issues"][0]["text"]
    assert cards["L1"]["level"] == "green" and cards["L1"]["listed"] == 1
    assert cards["G1"]["level"] == "yellow" and cards["G1"]["issues"][0]["text"].startswith("认不出型号")
    assert sum(res["counts"].values()) == res["total"] == len(res["items"])
    assert r1["source"] == "采购" and r1["location_count"] == 0 and r1["cycle"] == r1["age_days"] // 7 + 1
    assert [c["level"] for c in res["items"]] == sorted((c["level"] for c in res["items"]),
                                                        key=lambda x: sg2.LEVEL_ORDER[x]), "先红后黄再绿"
    assert all(c["sku_code"] == "R1" for c in sg2.build(db, seeded["admin"], q="R1")["items"])
    only_red = sg2.build(db, seeded["admin"], level="red", now=datetime(2026, 11, 13, 3, 0))
    assert {c["level"] for c in only_red["items"]} == {"red"} and only_red["counts"] == res["counts"]


def test_一件货_五步走到哪_卡在哪说清(db, seeded, monkeypatch):
    from app.enums import ReserveSource
    from app.services import sales_goods as sg2

    monkeypatch.setattr(la, "market_of", lambda db, sku: {"price": None, "basis": None, "date": None, "query": ""})
    now = datetime(2026, 11, 13, 3, 0)
    # 没型号、没上架：卡在第 1 步，后面都锁着并说先做哪步
    out = sg2.item(db, seeded["admin"], "G1", now=now)
    assert out["current"] == 1 and out["steps"][0]["note"] == "还缺：型号"
    assert [s["state"] for s in out["steps"]] == ["current", "locked", "done", "locked", "locked"]
    assert out["steps"][1]["lock"] == "先做完第 1 步「补齐信息」"
    assert out["steps"][4]["lock"] == "卖出后才能发货"
    assert out["facts"]["floor_price"] is not None and out["card"]["sku_code"] == "G1"
    # 在架的货：第 4 步做完；审批开关关着第 3 步跳过
    out = sg2.item(db, seeded["admin"], "L1", now=now)
    assert out["steps"][2]["skipped"] is True and out["steps"][3]["done"] is True
    # 卖出了：现在就是发货
    shops = {s.code: s for s in db.query(SaleShop).all()}
    sku = _sku(db, "R9", model="X1", status=SkuStatus.RESERVED, reserve_source=ReserveSource.PLATFORM_SOLD)
    db.add(SkuShopListing(sku_id=sku.id, sale_shop_id=shops["A"].id, publish_status=ShopListingStatus.SOLD,
                          sold_at=datetime(2026, 11, 13, 1, 0)))
    db.commit()
    out = sg2.item(db, seeded["admin"], "R9", now=now)
    assert out["current"] == 5 and out["steps"][4]["state"] == "current"
    assert out["steps"][1]["state"] == "skip" and "不用再做" in out["steps"][1]["note"], "卖出了，前面没做完的不用再补"
    assert out["steps"][4]["url"].endswith("manual-sale/index?code=R9") and "17:00 前发" in out["steps"][4]["note"]
    assert sg2.item(db, seeded["admin"], "NOPE") is None
    assert out["shops"] is None and out["photos"], "审批没开不出各号那张表"
    # 审批开着：各号这一份走到哪了，在架没批的写「在架待整改」
    set_setting(db, la.REQUIRED_KEY, "1", seeded["admin"].id)
    db.commit()
    out = sg2.item(db, seeded["me"], "L1", now=now)
    rows = {r["label"]: r for r in out["shops"]}
    assert set(rows) == {"店A", "店B"}, "停用的店不列"
    assert rows["店A"]["state_label"] == "在架待整改" and rows["店B"]["state"] == "NONE" and rows["店B"]["price"] is None
    assert out["can_review_low_price"] is False


def test_订单四类问题(db, seeded):
    from app.enums import ReserveSource
    from app.services import sales_orders as so

    shops = {s.code: s for s in db.query(SaleShop).all()}
    now = datetime(2026, 11, 13, 3, 0)

    def sold(sku, shop, at):
        db.add(SkuShopListing(sku_id=sku.id, sale_shop_id=shops[shop].id, publish_status=ShopListingStatus.SOLD, sold_at=at))

    m = _sku(db, "M1")                                   # 卖出了还在库没锁 → 漏抓
    sold(m, "A", datetime(2026, 11, 12, 2, 0))
    d = _sku(db, "D1", status=SkuStatus.RESERVED, reserve_source=ReserveSource.PLATFORM_SOLD)
    sold(d, "A", datetime(2026, 11, 12, 2, 0)); sold(d, "B", datetime(2026, 11, 12, 3, 0))   # 两个号都卖出 → 对不上货 + 卡住
    u = _sku(db, "U1", status=SkuStatus.SHIPPED)
    sold(u, "A", datetime(2026, 11, 10, 2, 0))
    db.add(SkuShopListing(sku_id=u.id, sale_shop_id=shops["B"].id, publish_status=ShopListingStatus.LISTED))  # 出库了还挂着
    ok = _sku(db, "OK1", status=SkuStatus.SHIPPED)
    sold(ok, "A", datetime(2026, 11, 11, 2, 0))
    old = _sku(db, "OLD1", status=SkuStatus.SHIPPED)
    sold(old, "A", datetime(2026, 9, 1)); sold(old, "B", datetime(2026, 9, 1))  # 很久以前重复卖出，不再提醒
    back = _sku(db, "BACK1")                              # 200 天前卖过、退货回在库：不算漏抓
    sold(back, "A", datetime(2026, 4, 27))
    db.commit()

    out = so.build(db, None, now=now)
    got = {(p["sku_code"], p["kind"]) for p in out["problems"]}
    # L4 是共用夹具里「A 号卖出、货还在库」的那件，没有卖出时间（老数据）：漏抓只看最近 30 天，不算
    assert got == {("M1", "missed"), ("D1", "mismatch"), ("D1", "stuck"), ("U1", "unsync")}
    assert {k["key"]: k["count"] for k in out["kinds"]} == {"missed": 1, "mismatch": 1, "stuck": 1, "unsync": 1}
    assert [r["sku_code"] for r in out["recent"]] == ["OK1"]
    u1 = next(p for p in out["problems"] if p["sku_code"] == "U1")
    assert "店B" in u1["text"] and u1["url"].endswith("shop-off/index?code=U1")
    # 只看 B 号的：D1 在 A、B 都卖过算；U1 是 A 号卖的、但出库了还挂在 B 号上，B 的负责人要去下架；M1 是 A 号卖的不算
    assert {p["sku_code"] for p in so.build(db, {shops["B"].id}, now=now)["problems"]} == {"D1", "U1"}



def test_接管台_超时红_只看我的号_回复率():
    gc_data = {
        "waiting": [
            {"conversation_id": "c1", "account": "闲鱼A", "buyer": "买家1", "waited_sec": 20 * 60, "escalated": False},
            {"conversation_id": "c2", "account": "闲鱼A", "buyer": "买家2", "waited_sec": 3 * 60, "read_by": "tao"},
            {"conversation_id": "c3", "account": "闲鱼B", "buyer": "买家3", "waited_sec": 60 * 60, "escalated": True},
        ],
        "waiting_conf": {"reply_min": 15},
    }
    mine = [{"nick": "闲鱼A", "account_id": "acc-a"}]
    rows = sw.assist_rows(None, gc_data, mine, "mine")
    assert [(r["key"], r["level"]) for r in rows] == [("c1", "red"), ("c2", "yellow")]
    assert rows[0]["status"] == "已升级：等了 20 分钟" and "tao 看过还没回" in rows[1]["status"]
    assert rows[0]["url"] == "/pages/gc-chat/detail/index?id=c1"
    assert [r["key"] for r in sw.assist_rows(None, gc_data, None, "all")] == ["c3", "c1", "c2"]
    assert sw.assist_rows(None, {"waiting": None}, None, "all") is None, "群控没连上"
    stats = sw.assist_stats({"items": [{"name": "tao", "cycles": 4, "replied": 3, "avg_reply_sec": 330, "late_reply": 1, "open": 1}]})
    assert stats == [{"name": "tao", "cycles": 4, "replied": 3, "rate": 75, "avg_reply_min": 5.5, "late_reply": 1, "open": 1}]
    assert sw.assist_stats(None) is None


def test_库存商品_行情涨跌和同款图池(db, seeded):
    from datetime import date

    from app.models import CrawlPrice, CrawlProduct, SpuImageSearch, WarehouseSpu
    from app.services import sales_goods as sg2

    now = datetime(2026, 11, 13, 3, 0)
    spu_up = WarehouseSpu(spu_code="S-UP", brand="飞利浦", model="27M2N55")
    spu_dn = WarehouseSpu(spu_code="S-DN", brand="小米", model="BE3600")
    spu_old = WarehouseSpu(spu_code="S-OLD", brand="AOC", model="Q27")
    db.add_all([spu_up, spu_dn, spu_old])
    db.flush()
    for spu, prices, day0 in ((spu_up, (100, 125), date(2026, 11, 12)), (spu_dn, (200, 170), date(2026, 11, 12)),
                              (spu_old, (100, 150), date(2026, 10, 20))):
        p = CrawlProduct(name=spu.brand_model)
        db.add(p)
        db.flush()
        db.add(CrawlPrice(product_id=p.id, crawl_date=day0 - timedelta(days=1), price=Decimal(prices[0])))
        db.add(CrawlPrice(product_id=p.id, crawl_date=day0, price=Decimal(prices[1])))
    db.add(SpuImageSearch(spu_id=spu_up.id, query=spu_up.brand_model, status="READY"))
    db.add(SpuImageSearch(spu_id=spu_dn.id, query=spu_dn.brand_model, status="REVIEWING"))
    _sku(db, "UP", barcode="S-UP")
    _sku(db, "DN", model="BE3600")
    _sku(db, "OLD", barcode="S-OLD")
    db.commit()
    res = sg2.build(db, seeded["admin"], now=now)
    cards = {c["sku_code"]: c for c in res["items"]}
    # 涨 25% 红，跌 15% 黄；都要销售核价
    assert cards["UP"]["trend"] == {"pct": 25, "date": "11-12", "level": "red", "fresh": True}
    assert any(i["level"] == "red" and i["text"].startswith("行情涨了 25%") for i in cards["UP"]["issues"])
    assert cards["DN"]["trend"]["pct"] == -15 and any(i["text"].startswith("行情跌了 15%") for i in cards["DN"]["issues"])
    # 最近一次超过 7 天：卡上标着，但不催人
    assert cards["OLD"]["trend"]["fresh"] is False and not any("行情" in i["text"] for i in cards["OLD"]["issues"])
    assert (cards["UP"]["pool"], cards["DN"]["pool"], cards["OLD"]["pool"]) == ("可用", "等审核", None)
    bar = {b["key"]: b["n"] for b in res["pool"]}
    assert bar["READY"] == 1 and bar["REVIEWING"] == 1 and bar["NONE"] == 1 and bar["NOSPU"] >= 1

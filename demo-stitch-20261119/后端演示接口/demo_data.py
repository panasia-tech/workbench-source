"""实物（WMS）全量历史库存 + 典型场景演示数据。
货号、品牌型号、SPU 编码全部取自真实文件：
  ~/Documents/ChatGPT/行政管理/erp-miniprogram/仓库SPU品牌型号_SPUSKU对应清单_已清洗.xlsx（259 件真实在库 SKU / 165 个 SPU）
并融合 catalog-snapshot.json 的真实采集行情价，同时完整保留 10 件核心教学样板货号与 4 件锁单待发货订单。
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import date as _date, datetime, timedelta
from decimal import Decimal

from app.enums import ReserveSource, ShopListingStatus, SkuStatus, StaffRole, StaffStatus
from app.models import (
    AppSetting,
    CrawlPrice,
    CrawlProduct,
    Inspection,
    ListingApproval,
    PurchaseOrder,
    ReturnOrder,
    SaleOrder,
    SaleShop,
    SalesOutbound,
    Sku,
    SkuAutoListing,
    SkuShopListing,
    Staff,
)
from app.services.finance import cn_today_start_utc
from app.services.password import hash_password

PWD = "demo1234"
HERE = os.path.dirname(os.path.abspath(__file__))

# 10 件核心样板货号: (货号, 名称, 品牌, 型号, 规格, 成本, 在库天数, 图前缀, SPU)
G = {
    "mon55A": ("513211540233-A", "飞利浦 27M2N5510P 27英寸显示器", "飞利浦", "27M2N5510P", "27寸 IPS 180Hz", 640, 34, "MON1", "90000027"),
    "mon55B": ("513211540233-B", "飞利浦 27M2N5510P 27英寸显示器", "飞利浦", "27M2N5510P", "27寸 IPS 180Hz", 640, 29, "MON1", "90000027"),
    "mon3200": ("513211540215", "飞利浦 25M2N3200W 25英寸显示器", "飞利浦", "25M2N3200W", "25寸 IPS 240Hz", 420, 4, "MON2", "6951613923962"),
    "f24": ("513211540009", "创维 F24G30F 24英寸显示器", "创维", "F24G30F", "24寸 144Hz", 330, 3, None, "6978207303771"),
    "f25": ("513211540213", "创维 F25G37F 25英寸显示器", "创维", "F25G37F", "25寸 165Hz", 360, 2, "MON2", None),
    "d75": ("513211540203", "盈色 D75V 显示器", "盈色", "D75V", "27寸", 280, 31, "MON1", "6974772491387"),
    "pur": ("BQAFLF1XF01011", "小米 空气净化器 4LITE", "小米", "空气净化器4LITE", "", 260, 6, "PUR", "90000621"),
    "dys": ("513211549229", "戴森 HT01 电吹风", "戴森", "HT01", "", 1100, 35, "DYS", "90000003"),
    "mon27": ("513211540026", "飞利浦 27M2N55 27英寸显示器", "飞利浦", "27M2N55", "27寸", 580, 14, "MON1", "6951613926093"),
    "mon32": ("513211540232", "飞利浦 25M2N32 25英寸显示器", "飞利浦", "25M2N32", "25寸", 390, 8, "MON2", "90000010"),
}

LOCKED = [
    ("BQAFLF1XF01011-B", "小米 空气净化器 4LITE", "小米", "空气净化器4LITE", "", 260, "PUR", 359, "买家-阿杰"),
    ("513211549229-B", "戴森 HT01 电吹风", "戴森", "HT01", "", 1100, "DYS", 1680, "买家-小林"),
    ("513211540009-B", "创维 F24G30F 24英寸显示器", "创维", "F24G30F", "24寸 144Hz", 330, "MON1", 468, "买家-momo"),
    ("513211540232-B", "飞利浦 25M2N32 25英寸显示器", "飞利浦", "25M2N32", "25寸", 390, "MON2", 560, "买家-老周"),
]

PHOTOS = {
    "513211540233-A": ("A-04", 3, False, True, True),
    "513211540233-B": ("A-10", 2, False, True, True),
    "513211540215": ("A-07", 2, False, True, False),
    "513211540009": ("A-02", 0, False, True, False),
    "513211540213": ("A-11", 2, False, False, False),
    "513211540203": ("A-09", 3, False, True, True),
    "BQAFLF1XF01011": ("A-03", 2, False, True, True),
    "513211549229": ("A-12", 3, True, True, True),
    "513211540026": ("A-01", 2, False, False, False),
    "513211540232": ("A-06", 2, False, True, True),
    "BQAFLF1XF01011-B": ("A-08", 2, False, True, False),
    "513211549229-B": ("A-05", 2, False, True, False),
    "513211540009-B": ("A-02", 2, False, True, False),
    "513211540232-B": ("A-06", 2, False, True, False),
}
D = "/api/demo-img/"


def _load_historical_259() -> list[dict]:
    candidates = [
        os.path.join(HERE, "historical_inventory_259.json"),
        "./demo",
    ]
    for p in candidates:
        if os.path.isfile(p):
            try:
                with open(p, encoding="utf-8") as f:
                    return json.load(f).get("items") or []
            except Exception:
                pass
    return []


def photo_lists(code: str, fallback_pre: str | None = None):
    """优先使用专属单件实拍图；全量历史库存 SKU 自动挂载同品类高精度仓内实拍图与商品素材池。"""
    if code in PHOTOS:
        loc, nreal, defect, has_loc, has_mat = PHOTOS[code]
        real = [f"{D}inspection/listing/{code}-{n}.jpg" for n in range(1, nreal + 1)]
        dfc = [f"{D}inspection/defect/{code}-1.jpg"] if defect else []
        mats = [f"{D}sku/product/{code}-m{m}.jpg" for m in range(1, 7)] if has_mat else []
        locs = [f"{D}sku/location/{code}-1.jpg"] if has_loc else []
        return real + dfc + mats, locs, (real[0] if real else None)
    if fallback_pre:
        h = abs(hash(code))
        idx1 = (h % 4) + 1
        idx2 = ((h + 1) % 4) + 1
        real = [
            f"{D}inspection/listing/GEN-{fallback_pre}-{idx1}.jpg",
            f"{D}inspection/listing/GEN-{fallback_pre}-{idx2}.jpg",
        ]
        mats = [f"{D}sku/product/GEN-{fallback_pre}-m{m}.jpg" for m in range(1, 7)]
        locs = [f"{D}sku/location/GEN-{fallback_pre}-loc.jpg"]
        return real + mats, locs, real[0]
    return [], [], None


def mats_of(sk):
    return [u for u in (sk.images or []) if "/sku/product/" in u]


def seed(SessionDemo):
    db = SessionDemo()
    now = datetime.utcnow()
    people = {}
    for no, user, name, role in (
        ("S1001", "admin", "销售主管", StaffRole.ADMIN),
        ("S1002", "chenxm", "陈小满", StaffRole.SALES),
        ("S1003", "zhoubb", "周小北", StaffRole.SALES),
        ("S1004", "linxiao", "林晓", StaffRole.WAREHOUSE),
        ("S1005", "newbie", "新同事", StaffRole.SALES),
    ):
        s = Staff(
            id=str(uuid.uuid5(uuid.NAMESPACE_DNS, "demo-" + user)),
            staff_no=no,
            username=user,
            password_hash=hash_password(PWD),
            name=name,
            role=role,
            status=StaffStatus.ACTIVE,
        )
        db.add(s)
        people[user] = s

    shops = []
    for i, (code, label, nick) in enumerate(
        (("S01", "果果数码", "guoguo_digital"), ("S02", "小满优选", "xiaoman_pick"), ("S03", "周周二手", "zhouzhou_2hand")),
        1,
    ):
        sh = SaleShop(code=code, label=label, xianyu_user_name=nick, gc_account_id="gc-acc-%d" % i, sort_order=i)
        db.add(sh)
        shops.append(sh)
    s1, s2, s3 = shops
    db.add(AppSetting(key="listing_approval_required", value="0"))
    db.add(AppSetting(key="listing_min_cost_ratio", value="1.0"))
    db.flush()

    skus = {}
    existing_codes = set()

    def sku(
        key,
        code,
        name,
        brand,
        model,
        spec,
        cost,
        days,
        pre,
        spu_meta,
        status=SkuStatus.IN_STOCK,
        reserve=None,
        suggest_override=None,
    ):
        imgs, locs, cover = photo_lists(code, fallback_pre=pre)
        sug = Decimal(str(suggest_override)) if suggest_override else Decimal(int(cost * 1.45))
        sk = Sku(
            sku_code=code,
            purchase_order_id="po-" + code,
            inspection_id="in-" + code,
            product_name=name,
            brand=brand,
            model=model,
            spec=spec,
            cost_price=Decimal(cost),
            suggest_price=sug,
            status=status,
            reserve_source=reserve,
            images=imgs,
            location_images=locs,
            cover_url=cover,
            condition_grade="A",
            inbound_at=now - timedelta(days=days),
            location_code="A-%02d" % (abs(hash(code)) % 24 + 1),
            spu=spu_meta,
        )
        db.add(sk)
        existing_codes.add(code)
        skus[key] = sk
        return sk

    for key, (code, name, brand, model, spec, cost, days, pre, spu_code) in G.items():
        spu_meta = (
            {
                "code": spu_code,
                "category": "空气净化器" if pre == "PUR" else ("默认/其它" if pre == "DYS" else "显示器"),
                "img_prefix": pre or "MON1",
                "image_lane": "bad" if key in ("f24", "mon3200") else "good",
            }
            if spu_code
            else None
        )
        sku(key, code, name, brand, model, spec, cost, days, pre, spu_meta)

    for i, (code, name, brand, model, spec, cost, pre, price, buyer) in enumerate(LOCKED):
        sku("lk%d" % i, code, name, brand, model, spec, cost, 9, pre, None, SkuStatus.RESERVED, ReserveSource.PLATFORM_SOLD)

    # 全量导入仓库真实 259 件在库历史 SKU（165 个 SPU）
    hist_items = _load_historical_259()
    hist_skus: list[tuple[dict, Sku]] = []
    for idx, h in enumerate(hist_items):
        code = h["sku_code"]
        if code in existing_codes or code == "513211540233":
            # 513211540233 已拆分为 -A / -B 两台同 SPU 样板机
            continue
        spu_meta = {
            "code": h["spu_code"],
            "category": h.get("category") or "显示器",
            "img_prefix": h.get("img_prefix") or "MON1",
            "image_lane": h.get("image_lane") or "good",
        }
        sk = sku(
            f"hist_{idx}",
            code,
            h["product_name"],
            h["brand"],
            h["model"],
            h.get("spec") or "",
            int(h["cost_price"]),
            int(h["inbound_days"]),
            h.get("img_prefix") or "MON1",
            spu_meta,
            suggest_override=round(float(h.get("market_price") or h["cost_price"] * 1.45), 2),
        )
        sk.negotiated_at = now - timedelta(hours=4 + (idx % 36))
        hist_skus.append((h, sk))

    db.flush()

    def shop_imgs(sk, i, same_as=None):
        m = mats_of(sk)
        j = i if same_as is None else same_as
        return [m[2 * j], m[2 * j + 1]] if len(m) > 2 * j + 1 else []

    def ap(sk, shop, status, price, note=None, cost_override=None, same_as=None):
        i = shops.index(shop)
        imgs = shop_imgs(sk, i, same_as)
        r = ListingApproval(
            sku_id=sk.id,
            sale_shop_id=shop.id,
            version=1,
            status=status,
            price=Decimal(price) if price else None,
            images=imgs,
            cost_price=Decimal(cost_override) if cost_override else sk.cost_price,
            min_cost_ratio=Decimal("1.0"),
            edited_by=people["chenxm"].id,
            note=note,
        )
        if status in ("SUBMITTED", "APPROVED", "REJECTED"):
            r.submitted_by = people["chenxm"].id
            r.submitted_at = now - timedelta(hours=3)
        if status in ("APPROVED", "REJECTED"):
            r.reviewed_by = people["admin"].id
            r.reviewed_at = now - timedelta(hours=1)
            r.review_note = note if status == "REJECTED" else None
        db.add(r)
        return r

    def listed(sk, shop, a=None):
        i = shops.index(shop)
        db.add(
            SkuShopListing(
                sku_id=sk.id,
                sale_shop_id=shop.id,
                publish_status=ShopListingStatus.LISTED,
                gc_account_id=shop.gc_account_id,
                listing_approval_id=a.id if a else None,
                images=shop_imgs(sk, i),
            )
        )

    k = skus
    for key in G:
        k[key].negotiated_at = now - timedelta(hours=2)

    db.flush()
    a = ap(k["mon55A"], s1, "APPROVED", 990); db.flush(); listed(k["mon55A"], s1, a)
    a = ap(k["mon55A"], s2, "APPROVED", 990); db.flush(); listed(k["mon55A"], s2, a)
    a = ap(k["mon55A"], s3, "APPROVED", 990); db.flush(); listed(k["mon55A"], s3, a)
    ap(k["d75"], s1, "DRAFT", 425)
    a = ap(k["dys"], s1, "APPROVED", 1650); db.flush(); listed(k["dys"], s1, a)
    listed(k["mon27"], s1)
    ap(k["mon32"], s1, "DRAFT", 585)
    listed(k["lk3"], s2)

    # 给一部分全量历史库存设置真实的已洗净/在架或待洗状态，贴合真实存量进度
    for idx, (h, sk) in enumerate(hist_skus):
        mp = max(int(sk.cost_price) + 30, int(round(float(h.get("market_price") or int(sk.cost_price) * 1.38) / 10.0) * 10))
        if idx % 9 == 0:
            a_h = ap(sk, s1, "APPROVED", mp)
            db.flush()
            listed(sk, s1, a_h)
            a_h2 = ap(sk, s2, "APPROVED", mp)
            db.flush()
            listed(sk, s2, a_h2)
        elif idx % 7 == 0:
            ap(sk, s1, "DRAFT", mp)
        elif idx % 13 == 0:
            db.add(SkuAutoListing(sku_id=sk.id, stage="NEEDS_HUMAN", last_error="历史存量：待核对多关键词行情与精修图池"))
        else:
            db.add(SkuAutoListing(sku_id=sk.id, stage="READY", last_error="存量待洗：已同步 SPU 编码与初始采集池"))

    for key, stage, err in (
        ("mon55B", "READY", "存量：同 SPU 兄弟件，共享行情策略，待配独立图上架"),
        ("mon3200", "NEEDS_HUMAN", "爬虫一直没爬到行情价"),
        ("f24", "NEEDS_HUMAN", "缺图：没有验货实拍图，请补拍"),
        ("f25", "NEEDS_HUMAN", "SPU 解析不出：型号写法对不上商品库"),
        ("pur", "NEEDS_HUMAN", "market_below_cost"),
        ("d75", "READY", "存量：价已备好，待大页面挑图直接上架"),
    ):
        db.add(SkuAutoListing(sku_id=k[key].id, stage=stage, last_error=err))

    shipped = []
    for i, (nm, cost, price, who) in enumerate(
        (
            ("飞利浦 24B1U5301H 显示器", 330, 468, "chenxm"),
            ("小米 小爱音箱 Pro", 150, 219, "chenxm"),
            ("戴森 HD08 电吹风", 900, 1390, "chenxm"),
            ("创维 F27G30F 显示器", 420, 598, "zhoubb"),
        )
    ):
        sk = Sku(
            sku_code="DEMO-SOLD-%d" % (i + 1),
            purchase_order_id="po-s%d" % i,
            inspection_id="in-s%d" % i,
            product_name=nm,
            cost_price=Decimal(cost),
            status=SkuStatus.SHIPPED,
            images=[],
            inbound_at=now - timedelta(days=15),
            condition_grade="A",
        )
        db.add(sk)
        db.flush()
        shipped.append(sk)
        db.add(
            SalesOutbound(
                outbound_no="OUT20261111%03d" % (i + 1),
                sku_id=sk.id,
                buyer_name="买家%d" % (i + 1),
                outbound_type="XIANYU",
                sale_price=Decimal(price),
                cost_price=sk.cost_price,
                operator_id=people[who].id,
                created_at=cn_today_start_utc() + timedelta(minutes=5 * (i + 1)),
            )
        )

    for i, (code, name, brand, model, spec, cost, pre, price, buyer) in enumerate(LOCKED):
        db.add(
            SaleOrder(
                order_no="SO2026111%d" % (i + 1),
                platform="XIANYU",
                external_order_no="XY88%07d" % (i + 1),
                buyer_name=buyer,
                amount=Decimal(price),
                product_title=name,
                product_image_url=D + "inspection/listing/%s-1.jpg" % code,
                shop_name="果果数码",
                status="PENDING",
                created_by_id=people["chenxm"].id,
            )
        )

    for i, (st, reason, sk) in enumerate(
        (("RETURNING", "买家觉得成色与描述不符", shipped[0]), ("PENDING_INBOUND", "七天无理由，买家已寄回", shipped[1]))
    ):
        db.add(
            ReturnOrder(
                return_no="RT2026111%d" % (i + 1),
                sku_id=sk.id,
                sku_code=sk.sku_code,
                product_name=sk.product_name,
                status=st,
                reason=reason,
                created_by_id=people["chenxm"].id,
            )
        )

    # 行情采集库：覆盖核心样板 + 全量 165 个 SPU
    jump = {"HT01": 0.14, "27M2N55": -0.12, "空气净化器4LITE": 0.09}
    seen_models = set()
    for key, (code, name, brand, model, spec, cost, days, pre, spu_code) in G.items():
        if model in seen_models or model == "25M2N3200W":
            continue
        seen_models.add(model)
        base = float(int(cost * 1.5))
        rng = [0.0, 0.012, -0.008, 0.015, jump.get(model, 0.02)]
        price, series = base, []
        for i, step in enumerate(rng):
            price = round(price * (1 + step), 2) if i else base
            series.append((_date.today() - timedelta(days=len(rng) - 1 - i), price))
        cp = CrawlProduct(
            name=f"{brand} {model}".strip(),
            keyword=model,
            enabled=True,
            note="按在库 SPU 自动同步",
            last_price=Decimal(str(series[-1][1])),
            last_price_date=series[-1][0],
        )
        db.add(cp)
        db.flush()
        for d, pr in series:
            db.add(
                CrawlPrice(
                    product_id=cp.id,
                    crawl_date=d,
                    price=Decimal(str(pr)),
                    raw={
                        "source": "cleaned_average",
                        "snapshotId": f"SNAP-{spu_code or code}",
                        "validCount": 5,
                        "validPrices": [round(pr * 0.95), round(pr * 0.98), round(pr), round(pr * 1.02), round(pr * 1.05)],
                    },
                )
            )

    for h, sk in hist_skus:
        mkey = h["model"]
        if mkey in seen_models or mkey == "25M2N3200W":
            continue
        seen_models.add(mkey)
        pr = round(float(h.get("market_price") or int(sk.cost_price) * 1.42), 2)
        cp = CrawlProduct(
            name=f"{h['brand']} {mkey}".strip(),
            keyword=mkey,
            enabled=True,
            note="按在库 SPU 自动同步",
            last_price=Decimal(str(pr)),
            last_price_date=_date.today(),
        )
        db.add(cp)
        db.flush()
        db.add(
            CrawlPrice(
                product_id=cp.id,
                crawl_date=_date.today(),
                price=Decimal(str(pr)),
                raw={
                    "source": "cleaned_average",
                    "snapshotId": f"SNAP-{h['spu_code']}",
                    "validCount": 4,
                    "validPrices": [round(pr * 0.96), round(pr * 0.99), round(pr * 1.01), round(pr * 1.04)],
                },
            )
        )

    for n, sk in enumerate(db.query(Sku).all(), 1):
        db.add(
            PurchaseOrder(
                id=sk.purchase_order_id,
                order_no="PO2026110%03d" % n,
                status="IN_STOCK",
                product_name=sk.product_name,
                unit_price=sk.cost_price,
                created_by_id=people["admin"].id,
            )
        )
        db.add(
            Inspection(
                id=sk.inspection_id,
                inspect_no="IN2026110%03d" % n,
                purchase_order_id=sk.purchase_order_id,
                status="DONE",
                inspector_id=people["linxiao"].id,
            )
        )
    db.commit()
    ids = {u: p.id for u, p in people.items()}
    ids["_shops"] = [s.id for s in shops]
    db.close()
    return ids

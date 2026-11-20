"""销售工作台首页：销售一打开就看到今天卖了多少、在架多少、有几个买家在等、手上要做什么。

不另算一套，每一项都调现成的口径：
- 今日成交：销售出库（SalesOutbound，按出库人），跟提成、仪表盘「今日出库」同一个口径；
- 待清洗 / 待审批 / 在架待整改：上架审批清洗任务列表（routers/listing_approval.list_tasks）的 counts；
- 库存缺口：库存缺口总览（services/stock_gaps.overview），只数「要人补」的，系统自己在等的不算；
- 今日提成：services/commission.compute_commission(period="today")；
- 买家在等回复：群控消息响应考核（chat_sla）的等待中会话，按闲鱼号负责人筛「我负责的号」。
  一个号都没分给我（或群控连不上负责人）就看全部号。

任一项出错只把那一项给 null，整页照样出来。销售看不到成本，这里一个成本字段都不返回。

「今天」任务（tasks，11-13 对齐销售工作台交付包）：待办和每件要发的货排成一列，
红 = 现在动手、黄 = 今天要做 / 在等、绿 = 不用管（不列），先红后黄。颜色只表达这一件事。
实物发货时限：当天 17:00 前卖出的当天 17:00 前发，17:00 后卖出的次日 17:00 前发，过了就红。
11-14 照交付包排成一列「要处理，先做这些」：订单问题（漏抓 / 对不上货 / 状态不同步，sales_orders）
和每件货最急的那个问题（库存商品 sales_goods）也并进来，一件货只出一行；上架审批、库存缺口这几条
计数待办就不再单列（每件货的那行已经写了）。
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta
from decimal import Decimal

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.enums import ReserveSource, SaleOrderStatus, ShopListingStatus, SkuStatus, StaffRole
from app.models import SaleOrder, SaleShop, SalesOutbound, Sku, SkuShopListing, Staff
from app.services import listing_approval as la
from app.services import stock_gaps as sg
from app.services.commission import compute_commission
from app.services.finance import cn_today_start_utc
from app.services.gc_bridge import client as gc

logger = logging.getLogger(__name__)

# 群控慢或连不上时最多等这么久，首页不能跟着卡住
GC_TIMEOUT_SEC = 5

# 待办点了去哪（小程序页面，H5 同一份）
URL_CHAT = "/pages/gc-chat/list/index"
URL_ASSIST = "/pages/sales-assist/index"
URL_CHAT_DETAIL = "/pages/gc-chat/detail/index?id={id}"
URL_APPROVALS = "/pages/listing/approvals/index"
URL_GAPS = "/pages/warehouse/gaps/index"
URL_PRACTICE = "/pages/practice/index"
URL_MANUAL_SALE = "/pages/sales/manual-sale/index"
URL_SHIP = "/pages/sales/ship/index"

# 实物发货时限（北京时间）
SHIP_CUTOFF_HOUR = 17
CN_OFFSET = timedelta(hours=8)

# 计数类待办的颜色：会被拦 / 买家在等 / 在架要整改是红，其余是黄
TODO_LEVEL = {"practice": "red", "chat": "red", "fix": "red", "review": "yellow", "todo": "yellow", "gaps": "yellow",
              "price_review": "yellow"}
LEVEL_ORDER = {"red": 0, "yellow": 1}

# 已废弃的平台：历史单留在库里（用户 11-13 定数据不动），但不再当成要发的货提醒
RETIRED_PLATFORMS = ("xianguanjia",)


def _is_admin(user: Staff) -> bool:
    return user.role == StaffRole.ADMIN


def _safe(name: str, db: Session, fn, *args):
    """单项出错不连累整页：记日志、给 None；回滚一下，免得坏掉的事务拖累后面几项。"""
    try:
        return fn(db, *args)
    except Exception:  # noqa: BLE001
        logger.exception("销售工作台：%s 出错", name)
        db.rollback()
        return None


# ---------------------------------------------------------------- 群控（异步，先拉）

async def fetch_gc() -> dict:
    """负责人、账号表、等待中的会话，三样一起拉；哪样没拉到就是 None。"""

    async def one(coro):
        try:
            return await asyncio.wait_for(coro, timeout=GC_TIMEOUT_SEC)
        except Exception as exc:  # noqa: BLE001
            logger.warning("销售工作台：群控没拉到 %s", exc)
            return None

    owners, accounts, waiting = await asyncio.gather(
        one(gc.chat_sla_owners()), one(gc.list_accounts()), one(gc.chat_sla_waiting())
    )
    return {
        "owners": owners if isinstance(owners, dict) else None,
        "accounts": accounts if isinstance(accounts, list) else None,
        "waiting": (waiting.get("items") or []) if isinstance(waiting, dict) else None,
        "waiting_conf": (waiting.get("conf") or {}) if isinstance(waiting, dict) else {},
    }


# ---------------------------------------------------------------- 各项（同步，查库）

def today_deals(db: Session, user: Staff) -> dict:
    q = db.query(func.count(SalesOutbound.id), func.coalesce(func.sum(SalesOutbound.sale_price), 0)).filter(
        SalesOutbound.created_at >= cn_today_start_utc()
    )
    if not _is_admin(user):
        q = q.filter(SalesOutbound.operator_id == user.id)
    count, amount = q.one()
    return {"count": int(count or 0), "amount": float(Decimal(str(amount or 0)))}


def approval_counts(db: Session, user: Staff) -> dict:
    """上架审批的待清洗 / 待审批 / 在架待整改。开关没开就不数（没开时这几样不用做）。"""
    if not la.approval_required(db):
        return {"required": False, "todo": None, "review": None, "fix": None}
    # 直接用清洗任务列表算好的 counts，口径跟审批页一模一样。
    # 按位置传参（state, keyword, page, size, db, 当前员工）：那边正在改，员工参数名变过
    from app.routers import listing_approval as la_api

    res = la_api.list_tasks("all", None, 1, 1, db, user)
    counts = res.get("counts") or {}
    return {"required": True, "todo": counts.get("todo", 0), "review": counts.get("review", 0), "fix": counts.get("fix", 0)}


def gap_todo(db: Session, user: Staff) -> int:
    """库存缺口里要人补的件数，跟仓库页入口上的「要人补 N 件」一个数。"""
    res = sg.overview(db, kind=None, q=None, page=1, size=1, role=str(user.role))
    return sum(k["todo"] for k in res.get("kinds") or [])


def today_commission(db: Session, user: Staff) -> float:
    return compute_commission(db, user, period="today").total_commission


def my_accounts(db: Session, user: Staff, gc_data: dict) -> tuple[str, list[dict]]:
    """(范围, 我的号)。负责人在群控上有分给我的号 → mine，只列这些；否则 all，列全部启用店铺。

    每个号带在架链接数和在等回复的会话数（群控没拉到时为 None）。
    """
    shops = db.query(SaleShop).filter(SaleShop.enabled.is_(True)).order_by(SaleShop.sort_order, SaleShop.code).all()
    listed_by_shop = dict(
        db.query(SkuShopListing.sale_shop_id, func.count(SkuShopListing.id))
        .filter(SkuShopListing.publish_status == ShopListingStatus.LISTED)
        .group_by(SkuShopListing.sale_shop_id)
        .all()
    )
    nick_by_acc = {a.get("id"): a.get("nick") for a in gc_data.get("accounts") or [] if a.get("id")}

    # 等待中会话只带了账号昵称（没昵称时是账号 id），先认回账号 id
    acc_by_nick = {nick: acc for acc, nick in nick_by_acc.items() if nick}
    for s in shops:
        if s.gc_account_id and s.xianyu_user_name:
            acc_by_nick.setdefault(s.xianyu_user_name, s.gc_account_id)
    waiting = gc_data.get("waiting")
    waiting_by_acc: dict[str, int] = {}
    for it in waiting or []:
        key = it.get("account")
        acc = acc_by_nick.get(key, key)
        waiting_by_acc[acc] = waiting_by_acc.get(acc, 0) + 1

    owners = gc_data.get("owners") or {}
    mine = {acc for acc, lst in owners.items() if any((o or {}).get("staff_id") == user.id for o in lst or [])}
    scope = "mine" if mine and not _is_admin(user) else "all"

    out: list[dict] = []
    seen_acc: set[str] = set()
    for s in shops:
        if scope == "mine" and s.gc_account_id not in mine:
            continue
        if s.gc_account_id:
            seen_acc.add(s.gc_account_id)
        out.append({
            "shop_id": s.id,
            "account_id": s.gc_account_id,
            "nick": nick_by_acc.get(s.gc_account_id) or s.label,
            "listed": int(listed_by_shop.get(s.id, 0)),
            "waiting": waiting_by_acc.get(s.gc_account_id, 0) if waiting is not None and s.gc_account_id else None,
        })
    # 群控上分给我、ERP 里还没对上店铺的号也列出来，在架数就是 0
    if scope == "mine":
        for acc in sorted(mine - seen_acc):
            out.append({
                "shop_id": None,
                "account_id": acc,
                "nick": nick_by_acc.get(acc) or acc,
                "listed": 0,
                "waiting": waiting_by_acc.get(acc, 0) if waiting is not None else None,
            })
    return scope, out


def build_todos(user: Staff, *, messages, approval, gaps, practice_left=None, price_review=None) -> list[dict]:
    """一条一句话 + 点了去哪。数是 0 或拿不到的不列。"""
    todos: list[dict] = []

    def add(key: str, count, text: str, url: str):
        if count:
            todos.append({"key": key, "count": count, "text": text.format(n=count), "url": url})

    # 练习门禁：没做完上架、审批、发货都会被拦，排第一
    add("practice", practice_left, "先做上手练习（还差 {n} 步），做完才能上架、审批、发货", URL_PRACTICE)

    add("chat", messages, "{n} 个买家在等回复", URL_ASSIST)
    if approval and approval.get("required"):
        add("fix", approval.get("fix"), "{n} 件在架的要整改", f"{URL_APPROVALS}?state=fix")
        add(
            "review",
            approval.get("review"),
            "{n} 件等审批",
            f"{URL_APPROVALS}?state=review",
        )
        add("todo", approval.get("todo"), "{n} 件待清洗", f"{URL_APPROVALS}?state=todo")
    add("gaps", gaps, "{n} 件库存要人补", URL_GAPS)
    if price_review:
        add("price_review", price_review["count"], "{n} 个清洗价等你生效", price_review["url"])
    return todos


def _price_review(db: Session, user: Staff) -> dict | None:
    """管理员：价格清洗出的版本等生效。点了去最早那件的清洗页。"""
    if not _is_admin(user):
        return None
    from app.models import PriceVersion

    from app.services.price_clean import _today

    # 行情已过期的不催：生效不了，页面上能退回
    rows = (
        db.query(PriceVersion)
        .filter(PriceVersion.status == "PENDING",
                (PriceVersion.expires_on.is_(None)) | (PriceVersion.expires_on >= _today()))
        .order_by(PriceVersion.created_at)
        .all()
    )
    if not rows:
        return None
    sku = db.get(Sku, rows[0].sku_id)
    return {"count": len(rows), "url": f"/pages/price-clean/index?code={sku.sku_code if sku else ''}"}


def _practice_left(db: Session, user: Staff) -> int:
    from app.services import practice

    return practice.left(db, user.id) if practice.gated(db, user) else 0


def ship_deadline(sold_at_utc: datetime) -> datetime:
    """卖出时间（UTC）→ 发货截止（UTC）：当天 17:00 前卖出当天 17:00，之后卖出次日 17:00。"""
    cn = sold_at_utc + CN_OFFSET
    cutoff = cn.replace(hour=SHIP_CUTOFF_HOUR, minute=0, second=0, microsecond=0)
    if cn >= cutoff:
        cutoff += timedelta(days=1)
    return cutoff - CN_OFFSET


def _ship_level(sold_at: datetime | None, now: datetime) -> tuple[str, str]:
    if sold_at is None:
        return "red", "卖出时间不明，先核对发没发"
    deadline = ship_deadline(sold_at)
    if now > deadline:
        days = (now - deadline).days
        return "red", f"超过发货时限{f' {days} 天' if days else ''}（{(deadline + CN_OFFSET):%m-%d %H:%M} 前要发）"
    return "yellow", f"{(deadline + CN_OFFSET):%m-%d %H:%M} 前发"


def ship_tasks(db: Session, user: Staff, shop_ids: set[str] | None, now: datetime | None = None) -> list[dict]:
    """要发的实物：闲鱼卖出后锁着的货（群控售出同步锁的）+ 还没发的销售单。shop_ids 给了只看这些号卖的。"""
    from app.services.oss_media import thumb_url_for_cover

    now = now or datetime.utcnow()
    out: list[dict] = []
    rows = (
        db.query(Sku, func.max(SkuShopListing.sold_at), func.min(SkuShopListing.sale_shop_id))
        .outerjoin(SkuShopListing, (SkuShopListing.sku_id == Sku.id) & SkuShopListing.sold_at.isnot(None))
        .filter(Sku.status == SkuStatus.RESERVED, Sku.reserve_source == ReserveSource.PLATFORM_SOLD)
        .group_by(Sku.id)
        .all()
    )
    for sku, sold_at, shop_id in rows:
        if shop_ids is not None and shop_id not in shop_ids:
            continue
        level, sub = _ship_level(sold_at, now)
        out.append({
            "key": f"ship:{sku.sku_code}",
            "kind": "ship",
            "level": level,
            "title": f"发货：{sku.product_name}",
            "sub": f"货号 {sku.sku_code} · {sub}",
            # 实拍图第一张；绝不用封面（Sku.cover_url 里有过买家订单截图）
            "thumb": thumb_url_for_cover(sku.images[0]) if sku.images else None,
            "url": f"{URL_MANUAL_SALE}?code={sku.sku_code}",
            "button": "去发货",
            "at": sold_at.isoformat() if sold_at else "",
        })
    q = db.query(SaleOrder).filter(
        SaleOrder.status == SaleOrderStatus.PENDING, SaleOrder.platform.notin_(RETIRED_PLATFORMS),
    )
    if not _is_admin(user):
        q = q.filter(SaleOrder.created_by_id == user.id)
    for order in q.order_by(SaleOrder.created_at).limit(50):
        level, sub = _ship_level(order.created_at, now)
        out.append({
            "key": f"order:{order.id}",
            "kind": "ship",
            "level": level,
            "title": f"发货：{order.product_title or order.order_no}",
            "sub": f"{order.buyer_name or '买家'} · {sub}",
            "thumb": thumb_url_for_cover(order.product_image_url) if order.product_image_url else None,
            "url": f"{URL_SHIP}?id={order.id}",
            "button": "去发货",
            "at": order.created_at.isoformat() if order.created_at else "",
        })
    return sorted(out, key=lambda t: (LEVEL_ORDER.get(t["level"], 2), t["at"]))


# 并进每件货的问题后，这几条计数待办就是重复的（每件货那行已经写了），不再单列
PER_ITEM_TODOS = ("fix", "review", "todo", "gaps")


def order_tasks(orders: dict | None) -> list[dict]:
    """订单问题里除了「卡住没走」（就是要发的货，已经在 ship_tasks 里）的三类，一单一行。"""
    out = []
    for p in (orders or {}).get("problems") or []:
        if p["kind"] == "stuck":
            continue
        out.append({
            "key": f"order-{p['kind']}:{p['sku_code']}",
            "kind": "order",
            "level": p["level"],
            "tag": p["kind_label"],
            "title": p["product_name"],
            "sub": p["text"],
            "thumb": p["thumb"],
            "url": p["url"],
            "button": p["button"],
            "at": p["at"],
            "sku_code": p["sku_code"],
        })
    return out


def goods_tasks(goods: dict | None) -> list[dict]:
    """库存商品里红、黄的货，一件一行：写最急的那个问题，其余几项写「另有 N 项」，点了直接去处理那一项。"""
    out = []
    for c in (goods or {}).get("items") or []:
        if c["level"] == "green" or not c["issues"]:
            continue
        top, more = c["issues"][0], len(c["issues"]) - 1
        out.append({
            "key": f"item:{c['sku_code']}",
            "kind": "item",
            "level": c["level"],
            "tag": "实物",
            "title": c["product_name"],
            "sub": top["text"] + (f"（另有 {more} 项）" if more else ""),
            "thumb": c["thumb"],
            "url": top["url"],
            "item_url": c["url"],
            "button": "去处理",
            "at": "",
            "sku_code": c["sku_code"],
        })
    return out


def _goods_for_my_shops(db: Session, goods: list[dict], my_shop_ids: set[str]) -> list[dict]:
    """「今天」里每件货一行也按号分人：在我的号上挂过 / 卖过的，或者哪个号都没上过（谁都能接）的留下；
    只在别人号上的不出（原来全公司的货都在每个销售的「今天」里，B 号卖出没发的货在 A 那里也红，两个人都去发）。
    「库存商品」页本身照旧全公司。"""
    codes = [g["sku_code"] for g in goods]
    if not codes:
        return goods
    shops_of: dict[str, set[str]] = {}
    for code, shop_id in (
        db.query(Sku.sku_code, SkuShopListing.sale_shop_id)
        .join(SkuShopListing, SkuShopListing.sku_id == Sku.id)
        .filter(Sku.sku_code.in_(codes))
    ):
        shops_of.setdefault(code, set()).add(shop_id)
    return [g for g in goods if not shops_of.get(g["sku_code"]) or shops_of[g["sku_code"]] & my_shop_ids]


def build_tasks(todos: list[dict], ships: list[dict] | None, orders: list[dict] | None = None,
                goods: list[dict] | None = None, assigned: list[dict] | None = None,
                virtual: list[dict] | None = None) -> list[dict]:
    """「今天」一列：计数待办 + 每件要发的货 + 订单问题 + 每件货的问题，先红后黄。

    同色里：计数待办 → 主管加派（services/sales_team.today_tasks）→ 发货、虚拟发码（卖出早的在前）→ 订单问题 → 每件货（库存商品已按库龄长的在前排好）。
    一件货只出一行：发货、订单问题里已经有的货，不再按库存商品出一行。goods 拿不到（None）时照旧列计数待办。
    """
    if goods is not None:
        todos = [t for t in todos if t["key"] not in PER_ITEM_TODOS]
    tasks = [
        {**t, "kind": "todo", "level": t.get("level") or TODO_LEVEL.get(t["key"], "yellow"), "title": t["text"], "sub": "",
         "thumb": None, "button": "去处理", "at": ""}
        for t in todos
    ]
    tasks += assigned or []
    tasks += ships or []
    tasks += virtual or []
    tasks += orders or []
    seen = {t.get("sku_code") or t["key"].split(":", 1)[-1] for t in tasks if t["kind"] in ("ship", "order")}
    tasks += [g for g in goods or [] if g["sku_code"] not in seen]
    rank = {"todo": 0, "assigned": 1, "report": 1, "ship": 2, "virtual": 2, "order": 3, "item": 4}
    # sorted 是稳定的：每件货保持库存商品里的先后
    return sorted(tasks, key=lambda t: (LEVEL_ORDER.get(t["level"], 2), rank.get(t["kind"], 5), t["at"]))


def _me(user: Staff) -> dict:
    from app.services.platform_groups import ROLE_LABELS

    return {"name": user.name or user.username, "role_label": ROLE_LABELS.get(user.role, ""),
            "department": user.department or ""}


def month_commission(db: Session, user: Staff) -> float:
    return compute_commission(db, user, period="month").total_commission


def build_overview(db: Session, user: Staff, gc_data: dict) -> dict:
    from app.services import sales_goods, sales_orders, sales_team, virtual_goods

    today = _safe("今日成交", db, today_deals, user)
    approval = _safe("上架审批", db, approval_counts, user)
    gaps = _safe("库存缺口", db, gap_todo, user)
    commission = _safe("今日提成", db, today_commission, user)
    commission_month = _safe("本月提成", db, month_commission, user)
    practice_left = _safe("上手练习", db, _practice_left, user)
    price_review = _safe("清洗价待生效", db, _price_review, user)
    accounts = _safe("我的号", db, my_accounts, user, gc_data)
    scope, shops = accounts if accounts else ("all", None)
    my_shop_ids = {s["shop_id"] for s in shops if s["shop_id"]} if shops is not None and scope == "mine" else None
    ships = _safe("要发的货", db, ship_tasks, user, my_shop_ids)
    orders_raw = _safe("订单问题", db, lambda d: sales_orders.build(d, my_shop_ids))
    goods_raw = _safe("库存商品", db, lambda d: sales_goods.build(d, user))
    assigned = _safe("主管加派", db, sales_team.today_tasks, user)
    reports = _safe("没见过的情况", db, sales_team.report_tasks, user)
    virtual = _safe("虚拟商品", db, virtual_goods.today_tasks, user)
    if reports:
        assigned = [*(assigned or []), *reports]
    orders = order_tasks(orders_raw) if orders_raw is not None else None
    goods = goods_tasks(goods_raw) if goods_raw is not None else None
    if goods is not None and my_shop_ids is not None:
        goods = _goods_for_my_shops(db, goods, my_shop_ids)

    messages = None
    if gc_data.get("waiting") is not None:
        if shops is not None and scope == "mine":
            messages = sum(s["waiting"] or 0 for s in shops)
        else:
            messages = len(gc_data["waiting"])

    todos = build_todos(user, messages=messages, approval=approval, gaps=gaps, practice_left=practice_left,
                        price_review=price_review)
    # 「N 个买家在等回复」和接管台同一个口径：有超时的才红，刚来的消息黄（原来一律红，点进接管台却是黄的）
    assist_red = _assist_red(gc_data, shops, scope)
    if assist_red is not None:
        for t in todos:
            if t["key"] == "chat":
                t["level"] = "red" if assist_red else "yellow"
    return {
        "me": _me(user),
        # 练习门禁拦着：真实任务先锁着，页顶写明、按钮灰掉（后端照样拦）
        "locked": bool(practice_left),
        # 主管：「今天」页上出「加派任务」
        "is_sup": _is_admin(user),
        "today_deals": today["count"] if today else None,
        "today_amount": today["amount"] if today else None,
        "listed": sum(s["listed"] for s in shops) if shops is not None else None,
        "approval": approval,
        "gaps": gaps,
        "commission": commission,
        "commission_month": commission_month,
        "messages": messages,
        "accounts_scope": scope,
        "accounts": shops,
        "todos": todos,
        "tasks": (tasks := build_tasks(todos, ships, orders, goods, assigned, virtual)),
        # 菜单上的红点：各页里红的有几条（拿不到给 None，不显示）
        "badges": {
            "today": sum(t["level"] == "red" for t in tasks),
            "goods": goods_raw["counts"]["red"] if goods_raw is not None else None,
            "orders": sum(p["level"] == "red" for p in orders_raw["problems"]) if orders_raw is not None else None,
            "assist": assist_red,
            "practice": practice_left or 0,
            "virtual": sum(t["level"] == "red" for t in virtual) if virtual is not None else None,
        },
    }


def _assist_red(gc_data: dict, shops: list[dict] | None, scope: str) -> int | None:
    rows = assist_rows(None, gc_data, shops, scope)
    return None if rows is None else sum(r["level"] == "red" for r in rows)


# 红点每人缓存一会儿：菜单每次切页都要，整套算一遍要将近 1 秒
BADGE_TTL_SEC = 60
_badge_cache: dict[str, tuple[float, dict]] = {}


def cached_badges(user_id: str) -> dict | None:
    import time

    hit = _badge_cache.get(user_id)
    return hit[1] if hit and time.monotonic() - hit[0] < BADGE_TTL_SEC else None


def forget_badges(user_id: str) -> None:
    _badge_cache.pop(user_id, None)


def remember_badges(user_id: str, badges: dict) -> None:
    import time

    _badge_cache[user_id] = (time.monotonic(), badges)


# ---------------------------------------------------------------- 实物接管台

def assist_rows(user: Staff, gc_data: dict, shops: list[dict] | None, scope: str) -> list[dict] | None:
    """在等回复的会话，超过考核时限（默认 15 分钟，扣掉夜间）的红、标「已升级」，其余黄；先红后黄、等得久的在前。
    销售只看分给自己的号（scope=mine），管理员看全部。群控没连上给 None。"""
    waiting = gc_data.get("waiting")
    if waiting is None:
        return None
    reply_min = int((gc_data.get("waiting_conf") or {}).get("reply_min") or 15)
    mine: set[str] | None = None
    if scope == "mine" and shops is not None:
        mine = {s["nick"] for s in shops} | {s["account_id"] for s in shops if s["account_id"]}
    rows = []
    for it in waiting:
        if mine is not None and it.get("account") not in mine:
            continue
        mins = int((it.get("waited_sec") or 0) // 60)
        late = bool(it.get("escalated")) or mins >= reply_min
        status = f"已升级：等了 {mins} 分钟" if late else f"等了 {mins} 分钟"
        if it.get("read_by"):
            status += f"，{it['read_by']} 看过还没回"
        rows.append({
            "key": it.get("conversation_id"),
            "level": "red" if late else "yellow",
            "account": it.get("account"),
            "buyer": it.get("buyer") or "买家",
            "item_title": it.get("item_title"),
            "last_message": it.get("last_message"),
            "status": status,
            "owners": it.get("owners") or [],
            "waited_sec": it.get("waited_sec") or 0,
            "read_by": it.get("read_by"),
            "url": URL_CHAT_DETAIL.format(id=it.get("conversation_id")),
        })
    rows.sort(key=lambda r: (LEVEL_ORDER[r["level"]], -r["waited_sec"]))
    return rows


def assist_stats(stats: dict | None) -> list[dict] | None:
    """今天按负责人：收到几轮、回了几轮（回复率）、平均多久回、超时几次。"""
    if not isinstance(stats, dict):
        return None
    out = []
    for it in stats.get("items") or []:
        cycles = it.get("cycles") or 0
        out.append({
            "name": it.get("name"),
            "cycles": cycles,
            "replied": it.get("replied") or 0,
            "rate": round((it.get("replied") or 0) * 100 / cycles) if cycles else None,
            "avg_reply_min": round(it["avg_reply_sec"] / 60, 1) if it.get("avg_reply_sec") is not None else None,
            "late_reply": it.get("late_reply") or 0,
            "open": it.get("open") or 0,
        })
    return out

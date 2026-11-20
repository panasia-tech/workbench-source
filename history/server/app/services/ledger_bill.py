"""大台账对账：企业支付宝授权给我们的应用，每天拉账务明细，和 ERP 销售单逐笔对。

授权走支付宝「第三方应用授权」：管理员在台账里点「授权对账」拿到链接，发给那家企业支付宝的
管理员，对方登录自己的企业支付宝打开链接点同意，支付宝带着 app_auth_code 回调
LEDGER_ALIPAY_AUTH_REDIRECT，我们换成 app_auth_token 加密存下。之后用它代那家企业调
alipay.data.dataservice.bill.downloadurl.query 拉 signcustomer（账务明细）账单。

前提（开放平台那边，代码管不了）：ERP 用的支付宝应用要是能被商家授权的第三方应用，
开通了账单下载，授权回调地址填成上面那个地址。

对账：只对进账。先拿 ERP 销售单的外部订单号去账单的商户订单号、业务流水号、备注里找；
找不到再按「金额一样、订单在进账前 15 天内」找，有且只有一张才认；闲鱼扣服务费后进账会
略少，金额差 2% 以内也算（标 approx），同样要唯一。宁可对不上，不能对错。

闲鱼卖出大多不开销售单、直接手动出库（11-14 生产近 30 天 26 笔出库、只有 1 张销售单），
所以销售单对完还要对出库单：出库单没有店铺，按这件货在哪个店铺记了售出（sku_shop_listing
SOLD / sold_at，只认一家）归到那家店的支付宝；进账按售价扣掉平台服务费比（出库填了实际服务费用实际的，
没填才按普通 1.6%、无忧卖和没标的 2.6% 估），规矩同上。认不出店铺的出库单只在「金额一分不差且全库唯一」时才认（noshop）。
自提走 ERP 自己的收款码、不进店铺支付宝，不拿来对。
"""

from __future__ import annotations

import csv
import io
import logging
import secrets
import zipfile
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from urllib.parse import quote

from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.config import settings
from app.enums import OutboundType
from app.models import (
    LedgerAlipay,
    LedgerAuthState,
    LedgerBillFetch,
    LedgerBillRow,
    LedgerEntity,
    LedgerLegalPerson,
    LedgerShop,
    SaleOrder,
    SalesOutbound,
    SaleShop,
    Sku,
    SkuShopListing,
    Staff,
)
from app.services import alipay as ali
from app.services.commission import platform_fee
from app.services.ledger_crypto import seal, unseal

logger = logging.getLogger(__name__)

AUTH_URL = "https://openauth.alipay.com/oauth2/appToAppAuth.htm"
STATE_TTL = timedelta(days=30)
REFRESH_BEFORE = timedelta(days=30)  # 授权离过期不到 30 天就续
MATCH_WINDOW_DAYS = 15
APPROX_RATE = Decimal("0.02")
OUTBOUND_TYPES = (OutboundType.MANUAL, OutboundType.ORDER_SHIP, OutboundType.SWITCH)
AUTH_STATUS = {"none": "没授权", "authorized": "已授权", "expired": "授权过期", "error": "授权出错"}
# 账单里每一笔钱是什么（11-14 台账第一步）。先按对上的单和关键词自动分，人改过的不再覆盖
FLOWS = {
    "sales_in": "卖货进账", "refund_out": "退款给买家", "fee_out": "平台服务费",
    "deposit_out": "交保证金", "deposit_in": "退回保证金", "withdraw_out": "提现到银行卡", "topup_in": "转入充值",
    "purchase_out": "采购付款", "purchase_refund_in": "采购退款", "other_in": "其他进账", "other_out": "其他支出",
}
# 对上出库单时，售价 - 到账超过售价这个比例就不当服务费回填（多半是部分退款或对错了）
FEE_BACKFILL_MAX = Decimal("0.2")


# ---------------------------------------------------------------- 授权

def auth_link(db: Session, admin: Staff, row: LedgerAlipay) -> str:
    if not ali.is_configured():
        raise HTTPException(status_code=400, detail="ERP 还没配支付宝应用，没法发授权链接")
    state = secrets.token_urlsafe(24)
    db.add(LedgerAuthState(state=state, alipay_id=row.id, created_by_id=admin.id))
    db.flush()
    redirect = quote(settings.ledger_alipay_auth_redirect, safe="")
    return f"{AUTH_URL}?app_id={settings.alipay_app_id}&redirect_uri={redirect}&state={state}"


def _token_node(resp: dict) -> dict:
    """alipay.open.auth.token.app 新版把令牌放在 tokens 数组里，老版平铺。"""
    if resp.get("tokens"):
        return resp["tokens"][0]
    return resp


def _save_tokens(row: LedgerAlipay, node: dict) -> None:
    row.app_auth_token_enc = seal(node.get("app_auth_token"))
    row.app_refresh_token_enc = seal(node.get("app_refresh_token"))
    if node.get("user_id"):
        row.alipay_user_id = str(node["user_id"])
    expires = int(node.get("expires_in") or 0)
    row.auth_expires_at = datetime.utcnow() + timedelta(seconds=expires) if expires else None
    row.authorized_at = datetime.utcnow()
    row.auth_status = "authorized"
    row.auth_error = None


async def handle_callback(db: Session, *, state: str, code: str) -> LedgerAlipay:
    st = db.get(LedgerAuthState, state or "")
    if st is None or st.used_at is not None or datetime.utcnow() - st.created_at > STATE_TTL:
        raise HTTPException(status_code=400, detail="授权链接无效或已经用过了，找管理员重新发一个")
    row = db.get(LedgerAlipay, st.alipay_id)
    if row is None:
        raise HTTPException(status_code=400, detail="这个支付宝已经从台账里删掉了")
    resp = await ali.call_gateway("alipay.open.auth.token.app", {"grant_type": "authorization_code", "code": code})
    if str(resp.get("code")) != "10000":
        row.auth_status = "error"
        row.auth_error = f"{resp.get('sub_code') or resp.get('code')} {resp.get('sub_msg') or resp.get('msg') or ''}"[:255]
        db.commit()
        raise HTTPException(status_code=400, detail=f"支付宝没给授权：{row.auth_error}")
    _save_tokens(row, _token_node(resp))
    st.used_at = datetime.utcnow()
    db.commit()
    return row


async def refresh_if_needed(db: Session, row: LedgerAlipay) -> None:
    if row.auth_status != "authorized" or not row.auth_expires_at:
        return
    if row.auth_expires_at - datetime.utcnow() > REFRESH_BEFORE:
        return
    resp = await ali.call_gateway(
        "alipay.open.auth.token.app", {"grant_type": "refresh_token", "refresh_token": unseal(row.app_refresh_token_enc)}
    )
    if str(resp.get("code")) == "10000":
        _save_tokens(row, _token_node(resp))
    elif row.auth_expires_at < datetime.utcnow():
        row.auth_status = "expired"
        row.auth_error = f"续期失败：{resp.get('sub_msg') or resp.get('msg')}"[:255]
    db.commit()


# ---------------------------------------------------------------- 账单

_COLS = {
    "账务流水号": "flow_no", "业务流水号": "biz_no", "商户订单号": "merchant_order_no", "商品名称": "item_name",
    "发生时间": "occurred_at", "对方账号": "counterparty", "收入金额（+元）": "income", "支出金额（-元）": "expense",
    "账户余额（元）": "balance", "交易渠道": "channel", "业务类型": "biz_type", "备注": "remark",
}


def _money(v: str | None) -> Decimal | None:
    v = (v or "").strip().replace(",", "")
    if not v:
        return None
    try:
        return abs(Decimal(v))
    except InvalidOperation:
        return None


def _text(raw: bytes) -> str:
    for enc in ("gbk", "utf-8-sig", "utf-8"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("gbk", errors="replace")


def parse_bill(content: bytes) -> list[dict]:
    """支付宝账务明细：zip 里的「…账务明细.csv」（不是「…(汇总).csv」），或者直接一个 csv。"""
    if content[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(content)) as zf:
            names = [n for n in zf.namelist() if n.lower().endswith(".csv")]
            pick = next((n for n in names if "汇总" not in _zip_name(n)), names[0] if names else None)
            if pick is None:
                return []
            content = zf.read(pick)
    rows = list(csv.reader(io.StringIO(_text(content))))
    head_i = next((i for i, r in enumerate(rows) if r and r[0].strip().lstrip("#") == "账务流水号"), None)
    if head_i is None:
        return []
    head = [h.strip() for h in rows[head_i]]
    out = []
    for r in rows[head_i + 1:]:
        if not r or not r[0].strip() or r[0].lstrip().startswith("#"):
            continue
        item = {}
        for i, h in enumerate(head):
            key = _COLS.get(h)
            if key and i < len(r):
                item[key] = r[i].strip().strip("\t").strip() or None
        if not item.get("flow_no"):
            continue
        item["income"] = _money(item.get("income")) or Decimal("0")
        item["expense"] = _money(item.get("expense")) or Decimal("0")
        item["balance"] = _money(item.get("balance"))
        try:
            item["occurred_at"] = datetime.strptime(item["occurred_at"], "%Y-%m-%d %H:%M:%S") if item.get("occurred_at") else None
        except ValueError:
            item["occurred_at"] = None
        out.append(item)
    return out


def _zip_name(n: str) -> str:
    """zip 里的中文文件名常是 GBK 被当成 cp437 解出来的乱码，还原一下再判断。"""
    try:
        return n.encode("cp437").decode("gbk")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return n


def _record(db: Session, row: LedgerAlipay, bill_date: date, status: str, n: int, error: str | None) -> LedgerBillFetch:
    f = db.query(LedgerBillFetch).filter_by(alipay_id=row.id, bill_date=bill_date).first()
    if f is None:
        f = LedgerBillFetch(alipay_id=row.id, bill_date=bill_date)
        db.add(f)
    f.status, f.rows, f.error = status, n, (error or None) and error[:500]
    return f


def store_rows(db: Session, row: LedgerAlipay, bill_date: date, items: list[dict]) -> int:
    have = {
        fn for (fn,) in db.query(LedgerBillRow.flow_no)
        .filter(LedgerBillRow.alipay_id == row.id, LedgerBillRow.flow_no.in_([x["flow_no"] for x in items])).all()
    } if items else set()
    added = 0
    for x in items:
        if x["flow_no"] in have:
            continue
        db.add(LedgerBillRow(alipay_id=row.id, bill_date=bill_date, **{k: v for k, v in x.items() if k in _COLS.values()}))
        added += 1
    db.flush()
    return added


async def fetch_day(db: Session, row: LedgerAlipay, bill_date: date) -> LedgerBillFetch:
    """拉一个支付宝一天的账务明细，存下来并对一遍。出错记在 ledger_bill_fetch，不抛。"""
    import httpx

    if row.auth_status != "authorized":
        return _record(db, row, bill_date, "error", 0, "没授权")
    try:
        resp = await ali.call_gateway(
            "alipay.data.dataservice.bill.downloadurl.query",
            {"bill_type": "signcustomer", "bill_date": bill_date.isoformat()},
            app_auth_token=unseal(row.app_auth_token_enc),
        )
        if str(resp.get("code")) != "10000":
            sub = resp.get("sub_code") or ""
            if sub == "isp.bill_not_exist":
                return _record(db, row, bill_date, "empty", 0, None)
            if "token" in sub.lower() or "auth" in sub.lower():
                row.auth_status, row.auth_error = "expired", f"{sub} {resp.get('sub_msg') or ''}"[:255]
            return _record(db, row, bill_date, "error", 0, f"{sub or resp.get('code')} {resp.get('sub_msg') or resp.get('msg') or ''}")
        async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
            dl = await client.get(resp["bill_download_url"])
            dl.raise_for_status()
        items = parse_bill(dl.content)
        store_rows(db, row, bill_date, items)
        match_alipay(db, row)
        classify(db, row)
        return _record(db, row, bill_date, "ok", len(items), None)
    except Exception as exc:  # noqa: BLE001 - 一家出错不能拖垮整轮
        logger.exception("拉账单失败 alipay=%s date=%s", row.id, bill_date)
        return _record(db, row, bill_date, "error", 0, str(exc))


# ---------------------------------------------------------------- 分类

def _flow_of(b: LedgerBillRow, role: str) -> str:
    """按对上的单和摘要里的字自动分。分不准的落到「其他」，页面上可以改。"""
    text = " ".join(x for x in (b.biz_type, b.item_name, b.remark) if x)
    if b.income and b.income > 0:
        if b.sale_order_id or b.sale_outbound_id:
            return "sales_in"
        if "保证金" in text:
            return "deposit_in"
        if "退款" in text:
            return "purchase_refund_in" if role in ("purchase", "master") else "other_in"
        if "充值" in text or "转入" in text:
            return "topup_in"
        if role == "sales" and ("交易" in text or "闲鱼" in text):
            return "sales_in"
        return "other_in"
    if any(k in text for k in ("服务费", "佣金", "技术服务")):
        return "fee_out"
    if "保证金" in text:
        return "deposit_out"
    if "提现" in text:
        return "withdraw_out"
    if "退款" in text:
        return "refund_out"
    if role == "purchase":
        return "purchase_out"
    return "other_out"


def classify(db: Session, row: LedgerAlipay) -> None:
    for b in db.query(LedgerBillRow).filter(LedgerBillRow.alipay_id == row.id, LedgerBillRow.flow_manual.is_(False)).all():
        b.flow = _flow_of(b, row.role)
    db.flush()


def set_flow(db: Session, bill_id: str, flow: str) -> LedgerBillRow:
    if flow not in FLOWS:
        raise HTTPException(status_code=400, detail="没有这种分类")
    b = db.get(LedgerBillRow, bill_id)
    if b is None:
        raise HTTPException(status_code=404, detail="没有这笔流水")
    b.flow, b.flow_manual = flow, True
    return b


# ---------------------------------------------------------------- 对账

def shop_names(db: Session, alipay_id: str) -> set[str]:
    """这个支付宝下面那几家店在 ERP 销售单上可能出现的店名（店铺名 + 闲鱼号名）。"""
    sale_ids = [s for (s,) in db.query(LedgerShop.sale_shop_id).filter(
        LedgerShop.alipay_id == alipay_id, LedgerShop.sale_shop_id.isnot(None)).all()]
    names = {n for (n,) in db.query(LedgerShop.name).filter(LedgerShop.alipay_id == alipay_id).all() if n}
    for s in db.query(SaleShop).filter(SaleShop.id.in_(sale_ids)).all() if sale_ids else []:
        names |= {x for x in (s.label, s.xianyu_user_name) if x}
    return names


def _orders(db: Session, names: set[str], since: datetime) -> list[SaleOrder]:
    if not names:
        return []
    return (
        db.query(SaleOrder)
        .filter(SaleOrder.shop_name.in_(names), SaleOrder.created_at >= since, SaleOrder.amount.isnot(None))
        .order_by(SaleOrder.created_at)
        .all()
    )


def _shop_ids(db: Session, alipay_id: str) -> set[str]:
    return {s for (s,) in db.query(LedgerShop.sale_shop_id).filter(
        LedgerShop.alipay_id == alipay_id, LedgerShop.sale_shop_id.isnot(None)).all()}


def _sold_shop(db: Session, sku_ids: set[str]) -> dict[str, str | None]:
    """每件货是在哪家店卖掉的：记了售出的店铺只有一家才算，两家以上或没有 = None。"""
    found: dict[str, set[str]] = {}
    if sku_ids:
        for sku_id, shop_id in db.query(SkuShopListing.sku_id, SkuShopListing.sale_shop_id).filter(
            SkuShopListing.sku_id.in_(sku_ids),
            or_(SkuShopListing.publish_status == "SOLD", SkuShopListing.sold_at.isnot(None)),
        ).all():
            found.setdefault(sku_id, set()).add(shop_id)
    return {k: (next(iter(found[k])) if len(found.get(k, ())) == 1 else None) for k in sku_ids}


def _outbounds(db: Session, since: datetime) -> list[SalesOutbound]:
    """能拿来对的出库单：手动出库、按单发货、切单发货（都是闲鱼成交），挂了销售单的走销售单那边。"""
    return (
        db.query(SalesOutbound)
        .filter(SalesOutbound.outbound_type.in_(OUTBOUND_TYPES), SalesOutbound.sale_order_id.is_(None),
                SalesOutbound.created_at >= since, SalesOutbound.sale_price > 0)
        .order_by(SalesOutbound.created_at)
        .all()
    )


def _net(o: SalesOutbound) -> Decimal:
    """闲鱼扣完服务费打到支付宝的钱（出库填了实际服务费就按实际的）。"""
    return Decimal(o.sale_price) - platform_fee(o)[0]


def _pick(cands: list, at: datetime, income: Decimal, *, when, gross, net=None, approx=True):
    """在进账前 15 天内的候选里按金额挑一张：一样的唯一就认，没有一样的再看差 2% 内唯一。"""
    window = [o for o in cands if at - timedelta(days=MATCH_WINDOW_DAYS) <= when(o) <= at]
    same = [o for o in window if gross(o) == income or (net is not None and net(o) == income)]
    if len(same) == 1:
        return same[0], "amount"
    if same or not approx:
        return None, None
    base = net or gross
    near = [o for o in window if base(o) > 0 and abs(base(o) - income) <= base(o) * APPROX_RATE]
    return (near[0], "approx") if len(near) == 1 else (None, None)


def _backfill_fee(o: SalesOutbound, income: Decimal) -> None:
    """出库单还没填服务费的，按「售价 - 到账」回填；到账是全额（服务费另起一笔扣）或差得太多就不填。"""
    if o.platform_fee is not None:
        return
    fee = Decimal(o.sale_price) - Decimal(income)
    if Decimal("0") < fee <= Decimal(o.sale_price) * FEE_BACKFILL_MAX:
        o.platform_fee = fee


def match_alipay(db: Session, row: LedgerAlipay) -> int:
    """把这个支付宝还没对上的进账，先和它那几家店的销售单、再和这几家店卖掉的出库单对一遍。返回新对上的笔数。"""
    names = shop_names(db, row.id)
    bills = (
        db.query(LedgerBillRow)
        .filter(LedgerBillRow.alipay_id == row.id, LedgerBillRow.sale_order_id.is_(None),
                LedgerBillRow.sale_outbound_id.is_(None), LedgerBillRow.income > 0)
        .order_by(LedgerBillRow.occurred_at)
        .all()
    )
    if not bills or not names:
        return 0
    earliest = min((b.occurred_at or datetime.combine(b.bill_date, datetime.min.time())) for b in bills)
    since = earliest - timedelta(days=MATCH_WINDOW_DAYS)
    orders = _orders(db, names, since)
    used = {
        s for (s,) in db.query(LedgerBillRow.sale_order_id)
        .filter(LedgerBillRow.sale_order_id.in_([o.id for o in orders])).all()
    } if orders else set()
    free = [o for o in orders if o.id not in used]

    outs = _outbounds(db, since)
    used_out = {
        s for (s,) in db.query(LedgerBillRow.sale_outbound_id)
        .filter(LedgerBillRow.sale_outbound_id.in_([o.id for o in outs])).all()
    } if outs else set()
    outs = [o for o in outs if o.id not in used_out]
    sold = _sold_shop(db, {o.sku_id for o in outs})
    mine = _shop_ids(db, row.id)
    own = [o for o in outs if sold.get(o.sku_id) in mine]
    others = [o for o in outs if sold.get(o.sku_id) not in mine]
    matched = 0

    for b in bills:
        at = b.occurred_at or datetime.combine(b.bill_date, datetime.max.time())
        text = " ".join(x for x in (b.merchant_order_no, b.biz_no, b.remark, b.item_name) if x)
        hit = next((o for o in free if o.external_order_no and o.external_order_no in text), None)
        how = "order_no"
        if hit is None:
            hit, how = _pick(free, at, b.income, when=lambda o: o.created_at, gross=lambda o: Decimal(o.amount))
        if hit is not None:
            b.sale_order_id, b.match_how = hit.id, how
            free.remove(hit)
            matched += 1
            continue
        out, how = _pick(own, at, b.income, when=lambda o: o.created_at, gross=lambda o: Decimal(o.sale_price), net=_net)
        if out is not None:
            own.remove(out)
        else:
            # 认不出店铺的：一分不差、而且别家店的出库单里也没有一样金额的才认
            out, _ = _pick(others, at, b.income, when=lambda o: o.created_at,
                           gross=lambda o: Decimal(o.sale_price), net=_net, approx=False)
            how = "noshop"
            if out is not None and sold.get(out.sku_id) is not None:
                out = None
            if out is not None:
                others.remove(out)
        if out is not None:
            b.sale_outbound_id, b.match_how = out.id, how
            _backfill_fee(out, b.income)
            matched += 1
    db.flush()
    return matched


def _sum(vals) -> str:
    return str(sum((Decimal(v or 0) for v in vals), Decimal("0")).quantize(Decimal("0.01")))


def overview(db: Session, *, start: date, end: date) -> dict:
    """每个支付宝在这段日子里：授权状态、拉没拉到、进账、对上多少、没对上多少。"""
    alipays = db.query(LedgerAlipay).order_by(LedgerAlipay.created_at).all()
    ent = {e.id: e for e in db.query(LedgerEntity).filter(LedgerEntity.id.in_({a.entity_id for a in alipays})).all()} if alipays else {}
    lps = {p.id: p for p in db.query(LedgerLegalPerson).filter(LedgerLegalPerson.id.in_({e.legal_person_id for e in ent.values()})).all()} if ent else {}
    out = []
    for a in alipays:
        rows = (
            db.query(LedgerBillRow)
            .filter(LedgerBillRow.alipay_id == a.id, LedgerBillRow.bill_date >= start, LedgerBillRow.bill_date <= end)
            .all()
        )
        income = [r for r in rows if r.income and r.income > 0]
        fetches = db.query(LedgerBillFetch).filter(
            LedgerBillFetch.alipay_id == a.id, LedgerBillFetch.bill_date >= start, LedgerBillFetch.bill_date <= end).all()
        e = ent.get(a.entity_id)
        out.append({
            "alipay_id": a.id, "account": a.account, "alias": a.alias,
            "entity_name": e.name if e else None, "legal_person_name": lps[e.legal_person_id].name if e and e.legal_person_id in lps else None,
            "auth_status": a.auth_status, "auth_label": AUTH_STATUS.get(a.auth_status, a.auth_status), "auth_error": a.auth_error,
            "fetch_errors": [{"date": f.bill_date.isoformat(), "error": f.error} for f in fetches if f.status == "error"],
            "days_fetched": sum(1 for f in fetches if f.status in ("ok", "empty")),
            "income_total": _sum(r.income for r in income),
            "expense_total": _sum(r.expense for r in rows),
            "income_count": len(income),
            "matched_count": sum(1 for r in income if r.sale_order_id or r.sale_outbound_id),
            "unmatched_count": sum(1 for r in income if not (r.sale_order_id or r.sale_outbound_id)),
            "shops": len(shop_names(db, a.id)) > 0,
        })
    return {"start": start.isoformat(), "end": end.isoformat(), "items": out}


def detail(db: Session, row: LedgerAlipay, *, start: date, end: date) -> dict:
    """一个支付宝：这段日子的进账逐笔（对上哪张单），和这几家店在 ERP 里卖了却没对上进账的单（含出库单）。"""
    bills = (
        db.query(LedgerBillRow)
        .filter(LedgerBillRow.alipay_id == row.id, LedgerBillRow.bill_date >= start, LedgerBillRow.bill_date <= end)
        .order_by(LedgerBillRow.occurred_at.desc())
        .all()
    )
    so = {o.id: o for o in db.query(SaleOrder).filter(SaleOrder.id.in_({b.sale_order_id for b in bills if b.sale_order_id})).all()}
    names = shop_names(db, row.id)
    since = datetime.combine(start, datetime.min.time()) - timedelta(days=MATCH_WINDOW_DAYS)
    until = datetime.combine(end, datetime.max.time())
    matched_ids = {s for (s,) in db.query(LedgerBillRow.sale_order_id).filter(LedgerBillRow.sale_order_id.isnot(None)).all()}
    pending = [o for o in _orders(db, names, since) if o.created_at <= until and o.id not in matched_ids]

    matched_out = {s for (s,) in db.query(LedgerBillRow.sale_outbound_id).filter(LedgerBillRow.sale_outbound_id.isnot(None)).all()}
    outs = [o for o in _outbounds(db, since) if o.created_at <= until]
    mine = _shop_ids(db, row.id)
    sold = _sold_shop(db, {o.sku_id for o in outs})
    pending_out = [o for o in outs if sold.get(o.sku_id) in mine and o.id not in matched_out]
    bill_out = {b.sale_outbound_id for b in bills if b.sale_outbound_id}
    ob = {o.id: o for o in db.query(SalesOutbound).filter(SalesOutbound.id.in_(bill_out)).all()} if bill_out else {}
    sku_ids = {o.sku_id for o in pending_out} | {o.sku_id for o in ob.values()}
    skus = {s.id: s for s in db.query(Sku).filter(Sku.id.in_(sku_ids)).all()} if sku_ids else {}
    sold |= _sold_shop(db, {o.sku_id for o in ob.values()} - set(sold))
    shop_ids = {v for v in sold.values() if v}
    labels = {s.id: s.label for s in db.query(SaleShop).filter(SaleShop.id.in_(shop_ids)).all()} if shop_ids else {}

    def order_out(o: SaleOrder | None):
        if o is None:
            return None
        return {"id": o.id, "order_no": o.order_no, "external_order_no": o.external_order_no, "amount": str(o.amount),
                "shop_name": o.shop_name, "product_title": o.product_title, "created_at": (o.created_at + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M")}

    def outbound_out(o: SalesOutbound | None):
        if o is None:
            return None
        sku = skus.get(o.sku_id)
        return {"id": o.id, "order_no": o.outbound_no, "external_order_no": None, "amount": str(o.sale_price),
                "shop_name": labels.get(sold.get(o.sku_id) or ""), "product_title": sku.product_name if sku else None,
                "created_at": (o.created_at + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M"), "kind": "outbound"}

    return {
        "alipay_id": row.id, "account": row.account, "auth_status": row.auth_status, "shop_names": sorted(names),
        "bills": [
            {
                "flow_no": b.flow_no, "occurred_at": b.occurred_at.strftime("%Y-%m-%d %H:%M") if b.occurred_at else None,
                "income": str(b.income), "expense": str(b.expense), "item_name": b.item_name, "counterparty": b.counterparty,
                "biz_type": b.biz_type, "merchant_order_no": b.merchant_order_no, "match_how": b.match_how,
                "id": b.id, "flow": b.flow, "flow_label": FLOWS.get(b.flow or "", "没分类"), "flow_manual": b.flow_manual,
                "order": order_out(so.get(b.sale_order_id)) or outbound_out(ob.get(b.sale_outbound_id)),
            }
            for b in bills
        ],
        "orders_without_income": [order_out(o) for o in pending] + [outbound_out(o) for o in pending_out],
    }


async def run_daily(db: Session, *, bill_date: date | None = None, backfill_days: int = 7) -> dict:
    """每天跑：续期快过期的授权，拉昨天的账单；前几天拉失败的再补一次。"""
    bill_date = bill_date or (datetime.utcnow() + timedelta(hours=8)).date() - timedelta(days=1)
    done = {"ok": 0, "empty": 0, "error": 0}
    for row in db.query(LedgerAlipay).filter(LedgerAlipay.auth_status == "authorized").all():
        try:
            await refresh_if_needed(db, row)
        except Exception:  # noqa: BLE001
            logger.exception("续期失败 alipay=%s", row.id)
        days = [bill_date]
        first = (row.authorized_at + timedelta(hours=8)).date() - timedelta(days=1) if row.authorized_at else bill_date
        for i in range(1, backfill_days + 1):
            d = bill_date - timedelta(days=i)
            if d < first:
                break  # 授权之前的账单不去补
            f = db.query(LedgerBillFetch).filter_by(alipay_id=row.id, bill_date=d).first()
            if f is None or f.status == "error":
                days.append(d)
        for d in days:
            f = await fetch_day(db, row, d)
            done[f.status] = done.get(f.status, 0) + 1
            db.commit()
            if row.auth_status != "authorized":
                break
    return done

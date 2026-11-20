"""大台账的读写、业务员填报、临时开放。权限口径见 models/ledger.py。

11-14 第一步的规矩（老板全量台账交付包，密码不存）：
  - 公司只能查账征收，不能核定；
  - 一个主体最多一个主资金号；只有收款号能挂店铺（主资金号、采购号不收卖货的钱）；
  - 采购号开因公付，从同一主体的主资金号扣，主体还没有主资金号就开不了；
  - 店铺走支付宝结算就挂在本主体的一个收款号上，别的结算方式直接挂主体、填商户号；
  - 提醒只提醒、不替人做决定：年报没报、本季度卖货额快到小规模 30 万免税线。

第二步（手机卡、代理 IP、设备）：
  - 一证五号：法人名下主卡 + 副卡 + 原有个人卡，同一家运营商最多 5 张，满了只能用外部合约卡；
  - 副卡挂在同一法人、同一运营商的主卡下，一张主卡最多 4 张副卡；外部合约卡要填实名人和合约到期日；
  - 同一平台的两个店不能共用一条代理（不同平台可以）；还有设备在用的代理停不掉、删不掉；
  - 一张卡只能插在一台手机里；设备的用途要和挂在上面的账号一致（第三步起不止销售店）；
  - 提醒：外部卡合约 30 天内到期、话费不够下个月月租、代理 7 天内到期。

第三步（买卖分开、财务槽位、单店损益）：
  - 店铺分销售店、采购号、引流号。销售店的钱进收款号或平台商户号；采购号只能因公付（挂采购支付宝，
    从同主体主资金号扣）或外币卡；引流号不收不付，只记往哪家销售店引流；
  - 支付宝挂的账号要和它的用途对得上（收款号挂销售店、采购号挂采购号）；设备的用途也要和账号一致；
  - 单店月度损益按 ERP 出库算（和经营账单同一口径）：卖了多少 − 成本 − 服务费 − 退货回冲的毛利；
  - 提醒：代持协议 30 天内到期。

第四步（审计报告另外 12 个模块，条目和规矩在 services/ledger_records.py）：
  - 员工实名卡（员工用自己身份证办给公司用的卡）：要写在谁名下，一直标红，人离职了标得更红，要尽快换成法人卡；
  - 支付宝记无密转账证书到期日（30 天内提醒）和报备的转账场景；主体记数电票每月授信额度；店铺记币种；
  - 台账里的东西删了，「谁知道它的密码」也一起删。

审计报告第一部分补的三条（11-15）：
  - 一张执照（个体户、公司）最多挂 3 家闲鱼店（采购号不算）；没执照的个人闲鱼号挂在类型是「个人」的主体下，不算数；
  - 只提醒：个体户名下单店一个月到 8 万该切流量；个体户一个月 10 万免税线；小规模连续 12 个月 450 万预警、500 万要转一般纳税人；
  - 「个人」主体没有年报和免税线这些提醒。
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation

from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.enums import StaffStatus
from app.models import (
    DailyBill,
    LedgerAccessLog,
    LedgerAlipay,
    LedgerDevice,
    LedgerEntity,
    LedgerGrant,
    LedgerKnows,
    LedgerLegalPerson,
    LedgerProxy,
    LedgerRecord,
    LedgerShop,
    LedgerSim,
    SaleShop,
    Staff,
)

# 第一次打开后能看多久。过了就再也打不开（「看完就看不到了」）
READ_MINUTES = 10
# 开放后多久内要打开，管理员开放时可改
DEFAULT_GRANT_HOURS = 24
MAX_GRANT_HOURS = 24 * 7

ENTITY_TYPES = {"individual": "个体户", "company": "公司", "person": "个人（没执照）"}
LICENSED = ("individual", "company")  # 有执照的，「个人」是没执照的个人闲鱼号
PLATFORMS = {
    "xianyu": "闲鱼", "taobao": "淘宝", "jd": "京东", "wechat_shop": "微信小店", "xhs": "小红书", "douyin": "抖店",
    "dianping": "大众点评", "douyin_app": "抖音", "doushengsheng": "抖省省", "wechat": "微信号",
    "pdd": "拼多多", "zhuanzhuan": "转转", "zbj": "猪八戒", "card_shop": "发卡网店", "airbnb": "Airbnb",
    "ota": "海外票务 / 交通", "affiliate": "海外联盟号", "overseas_buy": "海外采购站", "other": "其他",
}
CURRENCIES = {c: c for c in ("CNY", "JPY", "HKD", "USD", "EUR", "KRW", "THB", "SGD")}
SHOP_ROLES = {"sales": "销售店", "purchase": "采购号", "marketing": "引流号"}
# building 开店中：第五步派开店单时先占一个位，开店进度走完自动改成在用；它和在用一样占名额（各种「最多几个」都按没注销算）
STATUSES = {"active": "在用", "building": "开店中", "paused": "暂停", "closed": "注销/退回"}
TAX_PAYERS = {"small": "小规模", "general": "一般纳税人"}
TAX_LEVIES = {"audit": "查账征收", "assessed": "核定征收"}
ALIPAY_ROLES = {"master": "主资金号", "sales": "收款号", "purchase": "采购号"}
CHANNELS = {"alipay": "企业支付宝", "wechat": "微信支付商户号", "douyin": "抖音支付", "xhs": "小红书钱包", "jd": "京东钱包",
            "other": "其他", "corporate_pay": "因公付（采购支付宝）", "overseas": "外币卡", "none": "不收不付"}
# 每种账号能用哪些结算方式
ROLE_CHANNELS = {
    "sales": ("alipay", "wechat", "douyin", "xhs", "jd", "other"),
    "purchase": ("corporate_pay", "overseas"),
    "marketing": ("none",),
}
INVOICE_MODES = {"exempt": "个体普票（季度 30 万免税）", "vat": "公司 6% 查账", "purchase": "采购索票", "none": "不涉税"}
AGREEMENT_WARN_DAYS = 30
# 小规模纳税人每季度 30 万以内免增值税（开普票），到 80% 提醒
QUARTER_FREE = Decimal("300000")
QUARTER_WARN = Decimal("0.8")
XIANYU_PER_LICENSE = 3  # 闲鱼一张执照最多挂 3 家企业店；个人闲鱼号不算
SHOP_MONTH_CAP = Decimal("80000")  # 个体户名下单店一个月 8 万就该切流量到别家
MONTH_FREE = Decimal("100000")  # 个体户月 10 万（增值税和附加税的月免税线）
YEAR_WARN = Decimal("4500000")  # 连续 12 个月 450 万预警
YEAR_GENERAL = Decimal("5000000")  # 500 万要登记成一般纳税人

CARRIERS = {c: c for c in ("中国移动", "中国联通", "中国电信", "中国广电")}
SIM_CATEGORIES = {"master": "主卡", "sub": "副卡", "external": "外部合约卡", "employee": "员工实名卡"}
SIM_BILLINGS = {"independent": "自己扣话费", "shared": "共用主卡话费"}
CARDS_PER_PERSON = 5  # 一证五号：同一个人在同一家运营商最多 5 张
SUBS_PER_MASTER = 4
CONTRACT_WARN_DAYS = 30
LOW_BALANCE = Decimal("30")  # 话费低于月租或这个数就提醒
PROXY_PROTOCOLS = {"socks5": "SOCKS5", "http": "HTTP", "https": "HTTPS"}
PROXY_WARN_DAYS = 7
DEVICE_KINDS = {"env": "AdsPower 环境", "phone": "手机", "pc": "电脑"}
DEVICE_PURPOSES = {"sales": "销售", "purchase": "采购", "marketing": "引流"}

LEVELS = {
    "legal_person": LedgerLegalPerson,
    "entity": LedgerEntity,
    "alipay": LedgerAlipay,
    "shop": LedgerShop,
    "sim": LedgerSim,
    "proxy": LedgerProxy,
    "device": LedgerDevice,
}
# 每层能改的字段，和上一层的外键
FIELDS = {
    "legal_person": ("name", "phone", "email", "personal_cards", "face_sla", "agreement_end", "note", "status", "needs_check"),
    "entity": ("legal_person_id", "name", "entity_type", "credit_code", "tax_payer", "tax_levy", "tax_office", "tax_phone",
               "liaison_phone", "registered_on", "report_year", "report_filed_on", "business_scope", "invoice_quota", "note",
               "status", "needs_check"),
    "alipay": ("entity_id", "account", "alias", "phone", "alipay_user_id", "role", "corporate_pay", "daily_limit",
               "single_limit", "frozen_reserve", "book_code", "cert_expires_on", "transfer_scene", "note", "status", "needs_check"),
    "shop": ("entity_id", "alipay_id", "role", "channel", "platform", "name", "sale_shop_id", "merchant_no", "fee_rate",
             "deposit", "deposit_from", "frozen", "invoice_mode", "book_code", "lead_shop_id", "phone", "device_id", "currency",
             "note", "status", "needs_check"),
    "sim": ("legal_person_id", "phone", "carrier", "category", "master_id", "billing", "plan", "monthly_rent", "balance",
            "balance_on", "iccid", "holder", "vendor", "contract_end", "custodian", "staff_id", "note", "status", "needs_check"),
    "proxy": ("code", "provider", "protocol", "host", "port", "exit_ip", "region", "monthly_cost", "expires_on", "note",
              "status", "needs_check"),
    # gc_device_id / gc_nick / last_online_at 只由群控同步写
    "device": ("kind", "name", "purpose", "ads_user_id", "model", "serial", "imei1", "imei2", "host_id", "proxy_id",
               "sim1_id", "sim2_id", "custodian", "location", "note", "status", "needs_check"),
}
# 店铺的上一层是主体；挂哪个收款号单独校验（见 _check_shop）
PARENT = {"entity": ("legal_person_id", "legal_person"), "alipay": ("entity_id", "entity"), "shop": ("entity_id", "entity"),
          "sim": ("legal_person_id", "legal_person")}
REQUIRED = {"legal_person": "name", "entity": "name", "alipay": "account", "shop": "name", "sim": "phone", "proxy": "code",
            "device": "name"}
_REQUIRED_MSG = {"name": "名称不能为空", "account": "支付宝账号不能为空", "phone": "手机号不能为空", "code": "编号不能为空"}
# 指到别的行的字段 → 指的是哪一层
REFS = {"master_id": "sim", "device_id": "device", "proxy_id": "proxy", "host_id": "device", "sim1_id": "sim", "sim2_id": "sim",
        "lead_shop_id": "shop"}
PHONE_FIELDS = ("phone", "tax_phone", "liaison_phone")


def _clean(v):
    if isinstance(v, str):
        v = v.strip()
        return v or None
    return v


def norm_phone(v: str | None) -> str | None:
    """反查和换号都按号码比，先去掉空格、横杠和 +86。"""
    if not v:
        return None
    v = "".join(ch for ch in v if ch not in " -")
    if v.startswith("+86"):
        v = v[3:]
    return v or None


def log(db: Session, staff: Staff, action: str, target_type: str, target_id: str | None, detail: str | None = None):
    db.add(LedgerAccessLog(staff_id=staff.id, action=action, target_type=target_type, target_id=target_id,
                           detail=(detail or None) and detail[:2000]))


# ---------------------------------------------------------------- 读

def _d(v) -> str | None:
    return str(v) if v is not None else None


def _shop_out(s: LedgerShop, shop_labels: dict[str, str], device_names: dict[str, str] | None = None) -> dict:
    return {
        "id": s.id, "entity_id": s.entity_id, "alipay_id": s.alipay_id, "platform": s.platform,
        "platform_label": PLATFORMS.get(s.platform, s.platform), "name": s.name,
        "channel": s.channel, "channel_label": CHANNELS.get(s.channel, s.channel), "merchant_no": s.merchant_no,
        "fee_rate": _d(s.fee_rate), "deposit": _d(s.deposit), "deposit_from": s.deposit_from,
        "sale_shop_id": s.sale_shop_id, "sale_shop_label": shop_labels.get(s.sale_shop_id or ""),
        "phone": s.phone, "device_id": s.device_id, "device_name": (device_names or {}).get(s.device_id or ""),
        "role": s.role, "role_label": SHOP_ROLES.get(s.role, s.role), "lead_shop_id": s.lead_shop_id,
        "frozen": _d(s.frozen), "invoice_mode": s.invoice_mode, "invoice_label": INVOICE_MODES.get(s.invoice_mode or ""),
        "book_code": s.book_code, "currency": s.currency or "CNY",
        "status": s.status, "note": s.note, "needs_check": s.needs_check,
    }


def quarter_start(today: date) -> date:
    return date(today.year, (today.month - 1) // 3 * 3 + 1, 1)


def year_start(today: date) -> date:
    """连续 12 个月从哪天算起：往前数 11 个整月的 1 号，连本月一共 12 个月。"""
    m = today.year * 12 + today.month - 1 - 11
    return date(m // 12, m % 12 + 1, 1)


def entity_sales(db: Session, entity_ids: list[str], today: date) -> dict[str, dict[str, Decimal]]:
    """每个主体本月、本季度、连续 12 个月卖了多少：ERP 出库单按这件货在哪家店记了售出，归到挂着那家 ERP 店铺的主体。

    只算认得出店铺的出库；平台上成交但没进 ERP 的不算，所以是「至少卖了这么多」。
    """
    from app.services.finance import cn_range_to_utc
    from app.services.ledger_bill import _outbounds, _sold_shop

    zero = Decimal("0")
    out = {e: {"month": zero, "quarter": zero, "year": zero} for e in entity_ids}
    if not entity_ids:
        return out
    shop_entity = {sid: eid for sid, eid in db.query(LedgerShop.sale_shop_id, LedgerShop.entity_id).filter(
        LedgerShop.entity_id.in_(entity_ids), LedgerShop.sale_shop_id.isnot(None), LedgerShop.status != "closed").all()}
    if not shop_entity:
        return out
    since = {k: cn_range_to_utc(d, today)[0] for k, d in
             (("month", today.replace(day=1)), ("quarter", quarter_start(today)), ("year", year_start(today)))}
    obs = _outbounds(db, since["year"])
    sold = _sold_shop(db, {o.sku_id for o in obs})
    for o in obs:
        eid = shop_entity.get(sold.get(o.sku_id) or "")
        if eid:
            for k, t in since.items():
                if o.created_at >= t:
                    out[eid][k] += Decimal(o.sale_price)
    return out


def quarter_sales(db: Session, entity_ids: list[str], today: date) -> dict[str, Decimal]:
    """本季度每个主体卖了多少（口径同 entity_sales）。"""
    return {e: v["quarter"] for e, v in entity_sales(db, entity_ids, today).items()}


def _xianyu_count(db: Session, entity_id: str, but: str | None = None) -> int:
    """一个主体下挂了几家闲鱼店（销售店、引流号都算，采购号是买东西的不算）。"""
    q = db.query(LedgerShop).filter(LedgerShop.entity_id == entity_id, LedgerShop.platform == "xianyu",
                                    LedgerShop.role != "purchase", LedgerShop.status != "closed")
    if but:
        q = q.filter(LedgerShop.id != but)
    return q.count()


def shop_alerts(s: LedgerShop, e: LedgerEntity | None, month_gmv: Decimal | None) -> list[dict]:
    """个体户名下的销售店一个月到 8 万就该切流量到别家，免得把主体顶过月 10 万。"""
    if not e or e.entity_type != "individual" or s.role != "sales" or s.status != "active" or not month_gmv:
        return []
    if month_gmv >= SHOP_MONTH_CAP:
        return [{"level": "danger", "text": f"本月卖了 ¥{month_gmv:,.0f}，到了单店 8 万，该把流量切到别家店"}]
    if month_gmv >= SHOP_MONTH_CAP * QUARTER_WARN:
        return [{"level": "warn", "text": f"本月卖了 ¥{month_gmv:,.0f}，快到单店 8 万（{month_gmv / SHOP_MONTH_CAP:.0%}）"}]
    return []


def entity_alerts(e: LedgerEntity, sold: Decimal | None, today: date, *, month: Decimal | None = None,
                  year: Decimal | None = None, xianyu: int = 0) -> list[dict]:
    """主体上要人去办的事。只提醒，不替人做决定。sold 是本季度、month 本月、year 连续 12 个月卖的；xianyu 是挂了几家闲鱼店。"""
    out = []
    if e.status != "active" or e.entity_type not in LICENSED:
        return out
    if xianyu > XIANYU_PER_LICENSE:
        out.append({"level": "danger", "text": f"挂了 {xianyu} 家闲鱼店，一张执照最多 {XIANYU_PER_LICENSE} 家"})
    due = today.year - 1
    born_this_year = e.registered_on is not None and e.registered_on.year > due
    if not born_this_year and (e.report_year or 0) < due:
        if today <= date(today.year, 6, 30):
            out.append({"level": "warn", "text": f"{due} 年的年报还没报，6 月 30 日截止"})
        else:
            out.append({"level": "danger", "text": f"{due} 年的年报过了 6 月 30 日还没报"})
    if e.tax_payer == "small" and sold:
        pct = sold / QUARTER_FREE
        if pct >= 1:
            out.append({"level": "danger", "text": f"本季度卖了 ¥{sold:,.0f}，过了 30 万免税线"})
        elif pct >= QUARTER_WARN:
            out.append({"level": "warn", "text": f"本季度卖了 ¥{sold:,.0f}，快到 30 万免税线（{pct:.0%}）"})
    if e.tax_payer == "small" and e.entity_type == "individual" and month:
        if month >= MONTH_FREE:
            out.append({"level": "danger", "text": f"本月卖了 ¥{month:,.0f}，过了个体户月 10 万免税线"})
        elif month >= MONTH_FREE * QUARTER_WARN:
            out.append({"level": "warn", "text": f"本月卖了 ¥{month:,.0f}，快到个体户月 10 万免税线（{month / MONTH_FREE:.0%}）"})
    if e.tax_payer == "small" and year:
        if year >= YEAR_GENERAL:
            out.append({"level": "danger", "text": f"连续 12 个月卖了 ¥{year:,.0f}，过了 500 万，要登记成一般纳税人（13% 增值税）"})
        elif year >= YEAR_WARN:
            out.append({"level": "warn", "text": f"连续 12 个月卖了 ¥{year:,.0f}，到 500 万就要转一般纳税人"})
    return out


def month_bounds(month: date) -> tuple[date, date]:
    """某月的第一天和最后一天。"""
    import calendar

    first = month.replace(day=1)
    return first, first.replace(day=calendar.monthrange(first.year, first.month)[1])


def shop_month(db: Session, sale_shop_ids: set[str], month: date) -> dict[str, dict]:
    """单店月度损益，按 ERP 出库算，和经营账单同一口径：

    卖了多少（出库售价）− 成本 − 闲鱼服务费（填了实际用实际的，没填按档估）− 本月退货回冲的毛利。
    出库按这件货在哪家店记了售出归店（只认一家）；平台上成交但没进 ERP 的不算。
    """
    from app.enums import ReturnOrderStatus
    from app.models import ReturnOrder, SalesOutbound
    from app.services.commission import platform_fee
    from app.services.finance import cn_range_to_utc
    from app.services.ledger_bill import OUTBOUND_TYPES, _sold_shop

    zero = Decimal("0")
    out = {i: {"gmv": zero, "cost": zero, "fee": zero, "refund": zero, "refund_margin": zero, "count": 0, "returns": 0}
           for i in sale_shop_ids}
    if not sale_shop_ids:
        return {}
    start, end = cn_range_to_utc(*month_bounds(month))
    obs = db.query(SalesOutbound).filter(SalesOutbound.outbound_type.in_(OUTBOUND_TYPES), SalesOutbound.sale_price > 0,
                                         SalesOutbound.created_at >= start, SalesOutbound.created_at < end).all()
    rets = (
        db.query(SalesOutbound).join(ReturnOrder, ReturnOrder.outbound_id == SalesOutbound.id)
        .filter(ReturnOrder.created_at >= start, ReturnOrder.created_at < end,
                ReturnOrder.status != ReturnOrderStatus.CANCELLED).all()
    )
    sold = _sold_shop(db, {o.sku_id for o in obs} | {o.sku_id for o in rets})
    for o in obs:
        m = out.get(sold.get(o.sku_id) or "")
        if m is not None:
            m["gmv"] += Decimal(o.sale_price)
            m["cost"] += Decimal(o.cost_price or 0)
            m["fee"] += platform_fee(o)[0]
            m["count"] += 1
    for o in rets:
        m = out.get(sold.get(o.sku_id) or "")
        if m is not None:
            m["refund"] += Decimal(o.sale_price)
            m["refund_margin"] += Decimal(o.sale_price) - Decimal(o.cost_price or 0)
            m["returns"] += 1
    return {
        k: {**{f: _d(v[f]) for f in ("gmv", "cost", "fee", "refund")}, "count": v["count"], "returns": v["returns"],
            "net": _d(v["gmv"] - v["cost"] - v["fee"] - v["refund_margin"]), "month": month.strftime("%Y-%m")}
        for k, v in out.items()
    }


def purchase_month(db: Session, alipay_ids: list[str], month: date) -> dict[str, str]:
    """采购支付宝这个月净花了多少：采购付款 − 采购退款（团购券过期退回来的冲成本，不算卖货收入）。要先授权对账才有。"""
    from app.models import LedgerBillRow

    if not alipay_ids:
        return {}
    first, last = month_bounds(month)
    out: dict[str, Decimal] = {}
    for aid, flow, inc, exp in db.query(LedgerBillRow.alipay_id, LedgerBillRow.flow, LedgerBillRow.income,
                                         LedgerBillRow.expense).filter(
            LedgerBillRow.alipay_id.in_(alipay_ids), LedgerBillRow.bill_date >= first, LedgerBillRow.bill_date <= last,
            LedgerBillRow.flow.in_(("purchase_out", "purchase_refund_in"))).all():
        out[aid] = out.get(aid, Decimal("0")) + (Decimal(exp or 0) if flow == "purchase_out" else -Decimal(inc or 0))
    return {k: _d(max(v, Decimal("0"))) for k, v in out.items()}


def lp_alerts(lp: LedgerLegalPerson, today: date) -> list[dict]:
    if lp.status != "active" or not lp.agreement_end:
        return []
    left = (lp.agreement_end - today).days
    if left < 0:
        return [{"level": "danger", "text": f"代持协议 {_days(lp.agreement_end)}到期了，要续签"}]
    if left <= AGREEMENT_WARN_DAYS:
        return [{"level": "warn", "text": f"代持协议还有 {left} 天到期，要续签"}]
    return []


def alipay_alerts(a: LedgerAlipay, today: date) -> list[dict]:
    """无密转账的证书到期（应用公钥证书、支付宝公钥证书、根证书，按最早到期的记）。"""
    if a.status != "active" or not a.cert_expires_on:
        return []
    left = (a.cert_expires_on - today).days
    if left < 0:
        return [{"level": "danger", "text": f"转账证书 {_days(a.cert_expires_on)}到期了，无密转账会失败"}]
    if left <= AGREEMENT_WARN_DAYS:
        return [{"level": "warn", "text": f"转账证书还有 {left} 天到期，要换"}]
    return []


def _days(d: date) -> str:
    return f"{d.month} 月 {d.day} 日"


def sim_alerts(c: LedgerSim, today: date, *, gone: set | None = None, staff_names: dict | None = None) -> list[dict]:
    """gone：离职员工的 id（员工实名卡用）。"""
    out = []
    if c.status != "active":
        return out
    if c.category == "employee":
        who = (staff_names or {}).get(c.staff_id or "", "员工")
        if c.staff_id in (gone or set()):
            out.append({"level": "danger", "text": f"{c.phone} 在 {who} 名下，他已经离职了，随时能去营业厅挂失补卡，马上换成法人卡"})
        else:
            out.append({"level": "warn", "text": f"{c.phone} 在 {who} 名下，离职后能挂失补卡，尽快换成法人卡"})
    if c.category == "external" and c.contract_end:
        left = (c.contract_end - today).days
        if left < 0:
            out.append({"level": "danger", "text": f"{c.phone} 的合约 {_days(c.contract_end)}到期了，要换绑"})
        elif left <= CONTRACT_WARN_DAYS:
            out.append({"level": "warn", "text": f"{c.phone} 的合约还有 {left} 天到期，要换绑"})
    if c.billing == "independent" and c.balance is not None:
        floor = max(c.monthly_rent or Decimal("0"), LOW_BALANCE)
        if c.balance < floor:
            seen = f"（{_days(c.balance_on)}查的）" if c.balance_on else ""
            out.append({"level": "warn", "text": f"{c.phone} 话费只剩 ¥{c.balance:,.2f}{seen}"})
    return out


def proxy_alerts(p: LedgerProxy, today: date) -> list[dict]:
    if p.status != "active" or not p.expires_on:
        return []
    left = (p.expires_on - today).days
    if left < 0:
        return [{"level": "danger", "text": f"{_days(p.expires_on)}到期了"}]
    if left <= PROXY_WARN_DAYS:
        return [{"level": "warn", "text": f"还有 {left} 天到期"}]
    return []


def sim_out(c: LedgerSim, today: date, *, phones: dict[str, str], slots: dict[str, str], gone: set | None = None,
            staff_names: dict | None = None) -> dict:
    return {
        "id": c.id, "legal_person_id": c.legal_person_id, "phone": c.phone, "carrier": c.carrier,
        "category": c.category, "category_label": SIM_CATEGORIES.get(c.category, c.category),
        "master_id": c.master_id, "master_phone": phones.get(c.master_id or ""),
        "billing": c.billing, "billing_label": SIM_BILLINGS.get(c.billing, c.billing), "plan": c.plan,
        "monthly_rent": _d(c.monthly_rent), "balance": _d(c.balance),
        "balance_on": c.balance_on.isoformat() if c.balance_on else None, "iccid": c.iccid, "holder": c.holder,
        "vendor": c.vendor, "contract_end": c.contract_end.isoformat() if c.contract_end else None,
        "custodian": c.custodian, "in_device": slots.get(c.id), "staff_id": c.staff_id,
        "staff_name": (staff_names or {}).get(c.staff_id or ""),
        "alerts": sim_alerts(c, today, gone=gone, staff_names=staff_names),
        "status": c.status, "note": c.note, "needs_check": c.needs_check,
    }


def _sim_slots(db: Session, sim_ids: list[str]) -> dict[str, str]:
    """卡 id → 插在哪台设备上（设备名）。"""
    if not sim_ids:
        return {}
    out = {}
    for d in db.query(LedgerDevice).filter(or_(LedgerDevice.sim1_id.in_(sim_ids), LedgerDevice.sim2_id.in_(sim_ids))).all():
        for sid in (d.sim1_id, d.sim2_id):
            if sid:
                out[sid] = d.name
    return out


def _departed_and_names(db: Session, sims: list[LedgerSim]) -> tuple[set, dict]:
    """员工实名卡上要用：在谁名下（名字）、那人离职没有。"""
    ids = {c.staff_id for c in sims if c.staff_id}
    if not ids:
        return set(), {}
    rows = db.query(Staff).filter(Staff.id.in_(ids)).all()
    gone = {s.id for s in rows if s.deleted_at is not None or s.status == StaffStatus.DISABLED}
    return gone, {s.id: s.name or s.username for s in rows}


def _today() -> date:
    from app.services.finance import china_today

    return china_today()


def detail(db: Session, lp: LedgerLegalPerson) -> dict:
    """一个法人连同下面三层，整棵给出去。不走支付宝的店铺挂在主体的 shops 里。"""
    entities = db.query(LedgerEntity).filter(LedgerEntity.legal_person_id == lp.id).order_by(LedgerEntity.created_at).all()
    ent_ids = [e.id for e in entities]
    alipays = (
        db.query(LedgerAlipay).filter(LedgerAlipay.entity_id.in_(ent_ids)).order_by(LedgerAlipay.created_at).all()
        if entities else []
    )
    shops = (
        db.query(LedgerShop).filter(LedgerShop.entity_id.in_(ent_ids)).order_by(LedgerShop.created_at).all()
        if entities else []
    )
    sale_ids = {s.sale_shop_id for s in shops if s.sale_shop_id}
    shop_labels = {s.id: s.label for s in db.query(SaleShop).filter(SaleShop.id.in_(sale_ids)).all()} if sale_ids else {}
    dev_ids = {s.device_id for s in shops if s.device_id}
    device_names = (
        {d.id: d.name for d in db.query(LedgerDevice).filter(LedgerDevice.id.in_(dev_ids)).all()} if dev_ids else {}
    )
    today = _today()
    months = shop_month(db, {s.sale_shop_id for s in shops if s.sale_shop_id and s.role == "sales"}, today)
    names = {s.id: s.name for s in shops}
    ent_by_id = {e.id: e for e in entities}
    by_alipay: dict[str, list] = {}
    loose: dict[str, list] = {}
    for s in shops:
        m = months.get(s.sale_shop_id or "") if s.role == "sales" else None
        row = {**_shop_out(s, shop_labels, device_names), "lead_shop_name": names.get(s.lead_shop_id or ""), "month": m,
               "alerts": shop_alerts(s, ent_by_id.get(s.entity_id), Decimal(m["gmv"]) if m else None)}
        if s.alipay_id:
            by_alipay.setdefault(s.alipay_id, []).append(row)
        else:
            loose.setdefault(s.entity_id, []).append(row)
    bought = purchase_month(db, [a.id for a in alipays if a.role == "purchase"], today)
    by_entity: dict[str, list] = {}
    for a in alipays:
        by_entity.setdefault(a.entity_id, []).append({
            "id": a.id, "entity_id": a.entity_id, "account": a.account, "alias": a.alias, "phone": a.phone,
            "alipay_user_id": a.alipay_user_id, "cert_expires_on": a.cert_expires_on.isoformat() if a.cert_expires_on else None,
            "transfer_scene": a.transfer_scene, "alerts": alipay_alerts(a, today),
            "role": a.role, "role_label": ALIPAY_ROLES.get(a.role, a.role), "corporate_pay": a.corporate_pay,
            "daily_limit": _d(a.daily_limit), "single_limit": _d(a.single_limit), "frozen_reserve": _d(a.frozen_reserve),
            "book_code": a.book_code, "month_purchase": bought.get(a.id) if a.role == "purchase" else None,
            "status": a.status, "note": a.note, "needs_check": a.needs_check, "shops": by_alipay.get(a.id, []),
            "auth_status": a.auth_status, "auth_error": a.auth_error,
        })
    sold = entity_sales(db, ent_ids, today)
    xianyu = {e.id: _xianyu_count(db, e.id) for e in entities}
    sims = db.query(LedgerSim).filter(LedgerSim.legal_person_id == lp.id).order_by(LedgerSim.created_at).all()
    phones = {c.id: c.phone for c in sims}
    slots = _sim_slots(db, list(phones))
    gone, staff_names = _departed_and_names(db, sims)
    return {
        "id": lp.id, "name": lp.name, "phone": lp.phone, "email": lp.email, "status": lp.status, "note": lp.note,
        "needs_check": lp.needs_check, "personal_cards": lp.personal_cards or {}, "face_sla": lp.face_sla,
        "agreement_end": lp.agreement_end.isoformat() if lp.agreement_end else None, "alerts": lp_alerts(lp, today),
        "sims": [sim_out(c, today, phones=phones, slots=slots, gone=gone, staff_names=staff_names) for c in sims],
        "entities": [
            {
                "id": e.id, "legal_person_id": e.legal_person_id, "name": e.name, "entity_type": e.entity_type,
                "entity_type_label": ENTITY_TYPES.get(e.entity_type, e.entity_type), "credit_code": e.credit_code,
                "tax_payer": e.tax_payer, "tax_payer_label": TAX_PAYERS.get(e.tax_payer, e.tax_payer),
                "tax_levy": e.tax_levy, "tax_levy_label": TAX_LEVIES.get(e.tax_levy, e.tax_levy),
                "tax_office": e.tax_office, "tax_phone": e.tax_phone, "liaison_phone": e.liaison_phone,
                "registered_on": e.registered_on.isoformat() if e.registered_on else None,
                "report_year": e.report_year, "report_filed_on": e.report_filed_on.isoformat() if e.report_filed_on else None,
                "business_scope": e.business_scope, "invoice_quota": _d(e.invoice_quota),
                "quarter_sales": _d(sold[e.id]["quarter"]), "month_sales": _d(sold[e.id]["month"]),
                "year_sales": _d(sold[e.id]["year"]), "xianyu_shops": xianyu[e.id],
                "alerts": entity_alerts(e, sold[e.id]["quarter"], today, month=sold[e.id]["month"],
                                        year=sold[e.id]["year"], xianyu=xianyu[e.id]),
                "status": e.status, "note": e.note, "needs_check": e.needs_check, "alipays": by_entity.get(e.id, []),
                "shops": loose.get(e.id, []),
            }
            for e in entities
        ],
    }


def search(db: Session, *, q: str | None, needs_check: bool | None, page: int, size: int) -> dict:
    """法人清单。q 在四层里都搜，命中哪层都回到它的法人上。"""
    query = db.query(LedgerLegalPerson)
    kw = (q or "").strip()
    if kw:
        like = f"%{kw}%"
        ent = db.query(LedgerEntity.legal_person_id).filter(or_(LedgerEntity.name.like(like), LedgerEntity.credit_code.like(like)))
        ali = (
            db.query(LedgerEntity.legal_person_id)
            .join(LedgerAlipay, LedgerAlipay.entity_id == LedgerEntity.id)
            .filter(or_(LedgerAlipay.account.like(like), LedgerAlipay.alias.like(like)))
        )
        shop = (
            db.query(LedgerEntity.legal_person_id)
            .join(LedgerShop, LedgerShop.entity_id == LedgerEntity.id)
            .filter(or_(LedgerShop.name.like(like), LedgerShop.merchant_no.like(like)))
        )
        sim = db.query(LedgerSim.legal_person_id).filter(LedgerSim.phone.like(f"%{norm_phone(kw) or kw}%"))
        query = query.filter(or_(
            LedgerLegalPerson.name.like(like), LedgerLegalPerson.phone.like(like),
            LedgerLegalPerson.id.in_(ent), LedgerLegalPerson.id.in_(ali), LedgerLegalPerson.id.in_(shop),
            LedgerLegalPerson.id.in_(sim),
        ))
    if needs_check:
        query = query.filter(LedgerLegalPerson.id.in_(_needs_check_ids(db)))
    total = query.count()
    rows = query.order_by(LedgerLegalPerson.created_at.desc()).offset((page - 1) * size).limit(size).all()
    counts = _counts(db, [r.id for r in rows])
    check = set(_needs_check_ids(db, [r.id for r in rows]))
    alerts = _alert_counts(db, [r.id for r in rows])
    return {
        "total": total,
        "items": [
            {"id": r.id, "name": r.name, "phone": r.phone, "status": r.status, "needs_check": r.id in check,
             "alerts": alerts.get(r.id, 0), **counts.get(r.id, {})}
            for r in rows
        ],
    }


def _alert_counts(db: Session, lp_ids: list[str]) -> dict[str, int]:
    if not lp_ids:
        return {}
    ents = db.query(LedgerEntity).filter(LedgerEntity.legal_person_id.in_(lp_ids)).all()
    today = _today()
    sold = entity_sales(db, [e.id for e in ents], today)
    out: dict[str, int] = {}
    for e in ents:
        f = sold[e.id]
        out[e.legal_person_id] = out.get(e.legal_person_id, 0) + len(entity_alerts(
            e, f["quarter"], today, month=f["month"], year=f["year"], xianyu=_xianyu_count(db, e.id)))
    ent_by_id = {e.id: e for e in ents}
    shops = db.query(LedgerShop).filter(LedgerShop.entity_id.in_(list(ent_by_id)), LedgerShop.role == "sales",
                                        LedgerShop.sale_shop_id.isnot(None)).all() if ents else []
    months = shop_month(db, {s.sale_shop_id for s in shops}, today)
    for s in shops:
        e = ent_by_id[s.entity_id]
        m = months.get(s.sale_shop_id)
        out[e.legal_person_id] += len(shop_alerts(s, e, Decimal(m["gmv"]) if m else None))
    sims = db.query(LedgerSim).filter(LedgerSim.legal_person_id.in_(lp_ids)).all()
    gone, _ = _departed_and_names(db, sims)
    for c in sims:
        out[c.legal_person_id] = out.get(c.legal_person_id, 0) + len(sim_alerts(c, today, gone=gone))
    for lp in db.query(LedgerLegalPerson).filter(LedgerLegalPerson.id.in_(lp_ids)).all():
        out[lp.id] = out.get(lp.id, 0) + len(lp_alerts(lp, today))
    return out


def _counts(db: Session, lp_ids: list[str]) -> dict[str, dict]:
    out = {i: {"entities": 0, "alipays": 0, "shops": 0, "sims": 0} for i in lp_ids}
    if not lp_ids:
        return out
    for (lp,) in db.query(LedgerSim.legal_person_id).filter(LedgerSim.legal_person_id.in_(lp_ids)).all():
        out[lp]["sims"] += 1
    ents = db.query(LedgerEntity.id, LedgerEntity.legal_person_id).filter(LedgerEntity.legal_person_id.in_(lp_ids)).all()
    ent_lp = {e: lp for e, lp in ents}
    for _, lp in ents:
        out[lp]["entities"] += 1
    if ent_lp:
        for (eid,) in db.query(LedgerAlipay.entity_id).filter(LedgerAlipay.entity_id.in_(list(ent_lp))).all():
            out[ent_lp[eid]]["alipays"] += 1
        for (eid,) in db.query(LedgerShop.entity_id).filter(LedgerShop.entity_id.in_(list(ent_lp))).all():
            out[ent_lp[eid]]["shops"] += 1
    return out


def _needs_check_ids(db: Session, within: list[str] | None = None) -> list[str]:
    """自己或下面任何一层要核对的法人。"""
    ids = {r for (r,) in db.query(LedgerLegalPerson.id).filter(LedgerLegalPerson.needs_check.is_(True)).all()}
    ids |= {r for (r,) in db.query(LedgerEntity.legal_person_id).filter(LedgerEntity.needs_check.is_(True)).all()}
    ids |= {r for (r,) in db.query(LedgerSim.legal_person_id).filter(LedgerSim.needs_check.is_(True)).all()}
    ids |= {
        r for (r,) in db.query(LedgerEntity.legal_person_id).join(LedgerAlipay, LedgerAlipay.entity_id == LedgerEntity.id)
        .filter(LedgerAlipay.needs_check.is_(True)).all()
    }
    ids |= {
        r for (r,) in db.query(LedgerEntity.legal_person_id).join(LedgerShop, LedgerShop.entity_id == LedgerEntity.id)
        .filter(LedgerShop.needs_check.is_(True)).all()
    }
    return [i for i in ids if within is None or i in within]


def legal_person_of(db: Session, level: str, row) -> str | None:
    """任一层的行 → 它所属法人的 id。代理、设备不属于哪个法人。"""
    if level == "legal_person":
        return row.id
    if level in ("entity", "sim"):
        return row.legal_person_id
    if level in ("proxy", "device"):
        return None
    return db.get(LedgerEntity, row.entity_id).legal_person_id


# ---------------------------------------------------------------- 管理员改

def _get(db: Session, level: str, row_id: str):
    row = db.get(LEVELS[level], row_id)
    if row is None:
        raise HTTPException(status_code=404, detail="这条不存在或已删除")
    return row


_ENUMS = {
    "status": (STATUSES, "状态不对"),
    "entity_type": (ENTITY_TYPES, "主体类型只能是个体户或公司"),
    "platform": (PLATFORMS, "平台不对"),
    "tax_payer": (TAX_PAYERS, "纳税人只能是小规模或一般纳税人"),
    "tax_levy": (TAX_LEVIES, "征收方式只能是查账或核定"),
    "role": (ALIPAY_ROLES, "支付宝只能是主资金号、收款号或采购号"),
    "channel": (CHANNELS, "结算方式不对"),
    "carrier": (CARRIERS, "运营商只能是移动、联通、电信、广电"),
    "category": (SIM_CATEGORIES, "卡只能是主卡、副卡或外部合约卡"),
    "billing": (SIM_BILLINGS, "话费只能是自己扣或共用主卡"),
    "protocol": (PROXY_PROTOCOLS, "代理协议只能是 SOCKS5、HTTP、HTTPS"),
    "kind": (DEVICE_KINDS, "设备只能是 AdsPower 环境、手机或电脑"),
    "purpose": (DEVICE_PURPOSES, "用途只能是销售、采购或引流"),
    "currency": (CURRENCIES, "币种不对"),
}
# 同名字段在不同层是不同的选项
_LEVEL_ENUMS = {("shop", "role"): (SHOP_ROLES, "账号只能是销售店、采购号或引流号")}
_OPTIONAL_ENUMS = {"invoice_mode": INVOICE_MODES}
_MONEY = {"fee_rate": "服务费率", "deposit": "保证金", "monthly_rent": "月租", "balance": "话费余额", "monthly_cost": "月费",
          "daily_limit": "日累计限额", "single_limit": "单笔限额", "frozen_reserve": "冻结的钱", "frozen": "冻结 / 在途的钱",
          "invoice_quota": "每月开票额度"}
_DAYS = {"registered_on": "成立日期", "report_filed_on": "年报报送日期", "balance_on": "查余额的日期",
         "contract_end": "合约到期日", "expires_on": "到期日", "agreement_end": "代持协议到期日",
         "cert_expires_on": "证书到期日"}
_REF_LABEL = {"sim": "这张卡", "device": "这个设备", "proxy": "这条代理"}


def _money(v, label: str, *, top: Decimal | None = None) -> Decimal | None:
    if v is None:
        return None
    try:
        d = Decimal(str(v))
    except InvalidOperation:
        raise HTTPException(status_code=400, detail=f"{label}要填数字") from None
    if d < 0 or (top is not None and d > top):
        raise HTTPException(status_code=400, detail=f"{label}不对")
    return d


def _day(v, label: str) -> date | None:
    if v is None or isinstance(v, date):
        return v
    try:
        return date.fromisoformat(str(v)[:10])
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{label}要写成 2026-06-30 这样") from None


def _cards(v) -> dict | None:
    """名下原有个人卡：{"中国联通": 2}，0 张的不记。"""
    if not v:
        return None
    if not isinstance(v, dict):
        raise HTTPException(status_code=400, detail="原有个人卡要按运营商填张数")
    out = {}
    for k, n in v.items():
        if k not in CARRIERS:
            raise HTTPException(status_code=400, detail=_ENUMS["carrier"][1])
        try:
            n = int(n or 0)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="原有个人卡要填张数") from None
        if not 0 <= n <= CARDS_PER_PERSON:
            raise HTTPException(status_code=400, detail=f"原有个人卡一家运营商最多 {CARDS_PER_PERSON} 张")
        if n:
            out[k] = n
    return out or None


def _apply(db: Session, level: str, row, data: dict) -> None:
    for f in FIELDS[level]:
        if f not in data:
            continue
        v = data[f] if f == "personal_cards" else _clean(data[f])
        if f in PHONE_FIELDS:
            v = norm_phone(v)
        if f == "currency" and v is None:
            v = "CNY"
        if f == REQUIRED[level] and not v:
            raise HTTPException(status_code=400, detail=_REQUIRED_MSG[f])
        enum = _LEVEL_ENUMS.get((level, f)) or _ENUMS.get(f)
        if enum and v not in enum[0]:
            raise HTTPException(status_code=400, detail=enum[1])
        if f in _OPTIONAL_ENUMS and v is not None and v not in _OPTIONAL_ENUMS[f]:
            raise HTTPException(status_code=400, detail="开票口径不对")
        if f in ("needs_check", "corporate_pay"):
            v = bool(v)
        if f in _MONEY:
            v = _money(v, _MONEY[f], top=Decimal("100") if f == "fee_rate" else None)
        if f in _DAYS:
            v = _day(v, _DAYS[f])
        if f == "personal_cards":
            v = _cards(v)
        if f == "port" and v is not None:
            try:
                v = int(v)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="端口要填数字") from None
            if not 0 < v < 65536:
                raise HTTPException(status_code=400, detail="端口不对")
        if f in REFS and v and db.get(LEVELS[REFS[f]], v) is None:
            raise HTTPException(status_code=400, detail=f"{_REF_LABEL[REFS[f]]}不存在或已删除")
        if f == "report_year" and v is not None:
            try:
                v = int(v)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="年报年份要填数字") from None
            if not 2000 <= v <= 2100:
                raise HTTPException(status_code=400, detail="年报年份不对")
        if level in PARENT and f == PARENT[level][0]:
            _get(db, PARENT[level][1], v or "")  # 挂到的上一层得存在
        if f == "staff_id" and v and db.get(Staff, v) is None:
            raise HTTPException(status_code=400, detail="没有这个员工")
        if f == "sale_shop_id" and v and db.get(SaleShop, v) is None:
            raise HTTPException(status_code=400, detail="ERP 里没有这个店铺")
        setattr(row, f, v)


def _master(db: Session, entity_id: str, but: str | None = None) -> LedgerAlipay | None:
    q = db.query(LedgerAlipay).filter(LedgerAlipay.entity_id == entity_id, LedgerAlipay.role == "master",
                                      LedgerAlipay.status != "closed")
    if but:
        q = q.filter(LedgerAlipay.id != but)
    return q.first()


def _own_cards(db: Session, lp_id: str, carrier: str, but: str | None = None) -> int:
    """法人本人名下、这家运营商、公司开的在用卡（主卡 + 副卡）有几张。"""
    q = db.query(LedgerSim).filter(LedgerSim.legal_person_id == lp_id, LedgerSim.carrier == carrier,
                                   LedgerSim.category.in_(("master", "sub")), LedgerSim.status != "closed")
    if but:
        q = q.filter(LedgerSim.id != but)
    return q.count()


def _subs(db: Session, master_id: str, but: str | None = None) -> int:
    q = db.query(LedgerSim).filter(LedgerSim.master_id == master_id, LedgerSim.status != "closed")
    if but:
        q = q.filter(LedgerSim.id != but)
    return q.count()


def _check_sim(db: Session, c: LedgerSim, before: dict) -> None:
    dup = db.query(LedgerSim).filter(LedgerSim.phone == c.phone, LedgerSim.id != (c.id or "")).first()
    if dup is not None:
        raise HTTPException(status_code=400, detail=f"{c.phone} 已经在台账里了（{db.get(LedgerLegalPerson, dup.legal_person_id).name} 名下）")
    if c.category == "employee":
        if not c.staff_id:
            raise HTTPException(status_code=400, detail="员工实名卡要选在哪个员工名下")
    else:
        c.staff_id = None
    if c.category == "external":
        if not c.holder:
            raise HTTPException(status_code=400, detail="外部合约卡要填实名在谁名下")
        if not c.contract_end:
            raise HTTPException(status_code=400, detail="外部合约卡要填合约到期日，到期前要换绑")
    else:
        c.holder = None
    if c.category == "sub":
        m = db.get(LedgerSim, c.master_id or "")
        if m is None or m.category != "master" or m.status == "closed" or m.id == c.id:
            raise HTTPException(status_code=400, detail="副卡要选它挂在哪张主卡下")
        if m.legal_person_id != c.legal_person_id or m.carrier != c.carrier:
            raise HTTPException(status_code=400, detail="副卡要挂在同一个法人、同一家运营商的主卡下")
        if c.status != "closed" and _subs(db, m.id, but=c.id) >= SUBS_PER_MASTER:
            raise HTTPException(status_code=400, detail=f"主卡 {m.phone} 已经带了 {SUBS_PER_MASTER} 张副卡")
    else:
        c.master_id = None
        if c.billing == "shared":
            raise HTTPException(status_code=400, detail="只有副卡能共用主卡的话费")
    if c.category in ("master", "sub") and c.status != "closed":
        lp = db.get(LedgerLegalPerson, c.legal_person_id)
        mine = (lp.personal_cards or {}).get(c.carrier, 0)
        n = _own_cards(db, lp.id, c.carrier, but=c.id) + mine
        if n >= CARDS_PER_PERSON:
            raise HTTPException(status_code=400, detail=(
                f"{lp.name} 名下{c.carrier}的卡已经 {n} 张了（含原有个人卡 {mine} 张），一证五号，再要号只能用外部合约卡"))
    was_master = before.get("category") == "master" and before.get("status") != "closed"
    moved = (c.category != "master" or c.status == "closed" or c.carrier != before.get("carrier")
             or c.legal_person_id != before.get("legal_person_id"))
    if c.id and was_master and moved and _subs(db, c.id):
        raise HTTPException(status_code=400, detail=f"下面还挂着 {_subs(db, c.id)} 张副卡，先处理副卡")


def _check_cards(db: Session, lp: LedgerLegalPerson) -> None:
    """改了法人名下原有个人卡的张数，一证五号重新核一遍。"""
    for carrier, mine in (lp.personal_cards or {}).items():
        n = _own_cards(db, lp.id, carrier) + mine
        if n > CARDS_PER_PERSON:
            raise HTTPException(status_code=400, detail=f"{carrier}加上公司开的卡一共 {n} 张，超过一证五号了")


def proxy_clash(db: Session, proxy_id: str | None, *, device: LedgerDevice | None = None,
                shop: LedgerShop | None = None) -> None:
    """同一平台的两个店不能用同一条代理。device / shop 是正要保存、库里还是旧值的那一条。"""
    if not proxy_id:
        return
    devs = {d.id: d for d in db.query(LedgerDevice).filter(LedgerDevice.proxy_id == proxy_id,
                                                           LedgerDevice.status != "closed").all()}
    if device is not None:
        devs.pop(device.id, None)
        if device.proxy_id == proxy_id and device.status != "closed":
            devs[device.id or "_new"] = device
    if not devs:
        return
    shops = {s.id: s for s in db.query(LedgerShop).filter(LedgerShop.device_id.in_([i for i in devs if i != "_new"]),
                                                           LedgerShop.status != "closed").all()}
    if shop is not None:
        shops.pop(shop.id, None)
        if shop.device_id in devs and shop.status != "closed":
            shops[shop.id or "_new"] = shop
    seen: dict[str, LedgerShop] = {}
    for s in shops.values():
        if s.platform in seen:
            code = db.get(LedgerProxy, proxy_id).code
            raise HTTPException(status_code=400, detail=(
                f"同一平台的店不能共用一条代理：代理 {code} 上会有两家{PLATFORMS.get(s.platform, s.platform)}店"
                f"「{seen[s.platform].name}」「{s.name}」"))
        seen[s.platform] = s


def _check_device(db: Session, d: LedgerDevice, before: dict) -> None:
    if d.ads_user_id:
        dup = db.query(LedgerDevice).filter(LedgerDevice.ads_user_id == d.ads_user_id, LedgerDevice.id != (d.id or "")).first()
        if dup is not None:
            raise HTTPException(status_code=400, detail=f"AdsPower 环境 {d.ads_user_id} 已经记过了：{dup.name}")
    if d.kind != "env":
        d.ads_user_id = None
        d.host_id = None
    if d.kind != "phone":
        d.sim1_id = d.sim2_id = None
    if d.host_id:
        host = db.get(LedgerDevice, d.host_id)
        if host.kind != "pc" or host.id == d.id:
            raise HTTPException(status_code=400, detail="环境要开在一台电脑上")
    if d.sim1_id and d.sim1_id == d.sim2_id:
        raise HTTPException(status_code=400, detail="两个卡槽插的是同一张卡")
    for sid in (d.sim1_id, d.sim2_id):
        if not sid:
            continue
        other = db.query(LedgerDevice).filter(or_(LedgerDevice.sim1_id == sid, LedgerDevice.sim2_id == sid),
                                              LedgerDevice.id != (d.id or "")).first()
        if other is not None:
            raise HTTPException(status_code=400, detail=f"{db.get(LedgerSim, sid).phone} 已经插在 {other.name} 里了")
    if d.id:
        odd = db.query(LedgerShop).filter(LedgerShop.device_id == d.id, LedgerShop.role != d.purpose).first()
        if odd is not None:
            raise HTTPException(status_code=400, detail=(
                f"上面挂着{SHOP_ROLES.get(odd.role, odd.role)}「{odd.name}」，设备用途要和账号一致，先把它挪走"))
    proxy_clash(db, d.proxy_id, device=d)


def _check_shop(db: Session, row: LedgerShop) -> None:
    """买卖分开：销售店收钱、采购号只花钱（因公付）、引流号不收不付。"""
    if row.role == "marketing":
        row.channel, row.alipay_id, row.merchant_no = "none", None, None
    if row.channel not in ROLE_CHANNELS[row.role]:
        allowed = "、".join(CHANNELS[c] for c in ROLE_CHANNELS[row.role])
        raise HTTPException(status_code=400, detail=f"{SHOP_ROLES[row.role]}只能用{allowed}")
    if row.channel in ("alipay", "corporate_pay"):
        want = "sales" if row.channel == "alipay" else "purchase"
        if not row.alipay_id:
            raise HTTPException(status_code=400, detail="要选收款的支付宝" if want == "sales" else "要选从哪个采购支付宝扣")
        ali = _get(db, "alipay", row.alipay_id)
        if ali.role != want:
            raise HTTPException(status_code=400, detail=(
                "店铺只能挂在收款号上，主资金号、采购号不收卖货的钱" if want == "sales"
                else "采购号只能挂在采购支付宝上，收款号、主资金号不拿来买东西"))
        row.entity_id = ali.entity_id
    else:
        row.alipay_id = None
    if not row.entity_id:
        raise HTTPException(status_code=400, detail="要先选挂在哪个主体上")
    if row.platform == "xianyu" and row.role != "purchase" and row.status != "closed":
        ent = db.get(LedgerEntity, row.entity_id)
        if ent is not None and ent.entity_type in LICENSED and _xianyu_count(db, ent.id, but=row.id) >= XIANYU_PER_LICENSE:
            raise HTTPException(status_code=400, detail=(
                f"「{ent.name}」下已经有 {XIANYU_PER_LICENSE} 家闲鱼店了，一张执照最多 {XIANYU_PER_LICENSE} 家；"
                "没执照的个人闲鱼号挂到类型是「个人」的主体下"))
    if row.role != "marketing":
        row.lead_shop_id = None
    elif row.lead_shop_id:
        target = db.get(LedgerShop, row.lead_shop_id)
        if target.id == row.id or target.role != "sales":
            raise HTTPException(status_code=400, detail="引流号只能往销售店引流")
    if row.role != "sales":
        row.sale_shop_id = None  # ERP 店铺是卖货的闲鱼号，对不到采购号、引流号上
    if row.id and row.role != "sales" and db.query(LedgerShop).filter(LedgerShop.lead_shop_id == row.id).first():
        raise HTTPException(status_code=400, detail="有引流号在往这家店引流，先改掉引流号")
    if row.device_id:
        dev = db.get(LedgerDevice, row.device_id)
        if dev.purpose != row.role:
            raise HTTPException(status_code=400, detail=(
                f"{SHOP_ROLES[row.role]}要挂在{DEVICE_PURPOSES[row.role]}用的设备上，「{dev.name}」是{DEVICE_PURPOSES[dev.purpose]}用的"))
        proxy_clash(db, dev.proxy_id, shop=row)


def _check(db: Session, level: str, row, before: dict) -> None:
    """改完一条以后整体核一遍规矩（见文件开头）。before 是改之前的值，新建时为空。"""
    if level == "legal_person":
        _check_cards(db, row)
    elif level == "sim":
        _check_sim(db, row, before)
    elif level == "device":
        _check_device(db, row, before)
    elif level == "proxy":
        dup = db.query(LedgerProxy).filter(LedgerProxy.code == row.code, LedgerProxy.id != (row.id or "")).first()
        if dup is not None:
            raise HTTPException(status_code=400, detail=f"编号 {row.code} 已经有了")
        if row.id and row.status == "closed":
            n = db.query(LedgerDevice).filter(LedgerDevice.proxy_id == row.id, LedgerDevice.status != "closed").count()
            if n:
                raise HTTPException(status_code=400, detail=f"还有 {n} 个设备在用这条代理，先给它们换代理，不然会直连")
    elif level == "entity":
        if row.entity_type == "company" and row.tax_levy == "assessed":
            raise HTTPException(status_code=400, detail="公司只能查账征收，不能核定")
        if row.id and row.entity_type in LICENSED and _xianyu_count(db, row.id) > XIANYU_PER_LICENSE:
            raise HTTPException(status_code=400, detail=(
                f"下面挂着 {_xianyu_count(db, row.id)} 家闲鱼店，一张执照最多 {XIANYU_PER_LICENSE} 家，先挪走几家"))
    elif level == "alipay":
        if row.role == "master" and row.status != "closed":
            other = _master(db, row.entity_id, but=row.id)
            if other is not None:
                raise HTTPException(status_code=400, detail=f"这个主体已经有主资金号了：{other.account}")
        if row.corporate_pay:
            if row.role != "purchase":
                raise HTTPException(status_code=400, detail="只有采购号能开因公付")
            if _master(db, row.entity_id) is None:
                raise HTTPException(status_code=400, detail="这个主体还没有主资金号，开不了因公付")
        if row.id:
            want = {"sales": "sales", "purchase": "purchase"}.get(row.role)
            odd = db.query(LedgerShop).filter(LedgerShop.alipay_id == row.id, LedgerShop.role != (want or "")).first()
            if odd is not None:
                raise HTTPException(status_code=400, detail=(
                    f"下面挂着{SHOP_ROLES.get(odd.role, odd.role)}「{odd.name}」，和{ALIPAY_ROLES[row.role]}对不上，先挪走"))
        was_master = before.get("role") == "master" and before.get("status") != "closed"
        if was_master and (row.role != "master" or row.status == "closed" or row.entity_id != before.get("entity_id")):
            payer = db.query(LedgerAlipay).filter(LedgerAlipay.entity_id == before["entity_id"], LedgerAlipay.id != row.id,
                                                  LedgerAlipay.corporate_pay.is_(True)).first()
            if payer is not None and _master(db, before["entity_id"], but=row.id) is None:
                raise HTTPException(status_code=400, detail=f"采购号 {payer.account} 开着因公付、要从它扣钱，先关掉那边")
        if row.id and before.get("entity_id") and row.entity_id != before["entity_id"]:
            # 支付宝换了主体，挂在它下面的店铺跟着走
            db.query(LedgerShop).filter(LedgerShop.alipay_id == row.id).update({"entity_id": row.entity_id},
                                                                                synchronize_session=False)
    elif level == "shop":
        _check_shop(db, row)


def _snapshot(row) -> dict:
    return {c: getattr(row, c, None) for c in ("role", "status", "entity_id", "category", "carrier", "legal_person_id")}


# 列默认值要到 flush 才填上，_check 在那之前就要用，新建时先摆好
_DEFAULTS = {
    "legal_person": {},
    "entity": {"entity_type": "individual", "tax_payer": "small", "tax_levy": "audit"},
    "alipay": {"role": "sales", "corporate_pay": False},
    "shop": {"channel": "alipay", "platform": "xianyu", "role": "sales"},
    "sim": {"carrier": "中国移动", "category": "master", "billing": "independent"},
    "proxy": {"protocol": "socks5"},
    "device": {"kind": "env", "purpose": "sales"},
}


def create(db: Session, staff: Staff, level: str, data: dict):
    row = LEVELS[level](created_by_id=staff.id, status="active", **_DEFAULTS[level])
    if level == "shop" and data.get("alipay_id") and not data.get("entity_id"):
        data = {**data, "entity_id": _get(db, "alipay", data["alipay_id"]).entity_id}
    if level in PARENT and not data.get(PARENT[level][0]):
        raise HTTPException(status_code=400, detail="要先选挂在哪一个上面")
    _apply(db, level, row, {**data, "needs_check": False})
    if not getattr(row, REQUIRED[level], None):
        raise HTTPException(status_code=400, detail=_REQUIRED_MSG[REQUIRED[level]])
    _check(db, level, row, {})
    db.add(row)
    db.flush()
    log(db, staff, "create", level, row.id)
    return row


def update(db: Session, staff: Staff, level: str, row_id: str, data: dict):
    row = _get(db, level, row_id)
    before = _snapshot(row)
    _apply(db, level, row, data)
    _check(db, level, row, before)
    log(db, staff, "update", level, row.id, ",".join(sorted(k for k in data if k in FIELDS[level])))
    return row


_BELOW = "下面还挂着东西，先删掉或挪走下面的"
_CHILD = {
    "legal_person": [(LedgerEntity, "legal_person_id", _BELOW), (LedgerSim, "legal_person_id", "名下还有手机卡，先删掉或挪走"),
                     (LedgerRecord, "legal_person_id", "其他台账里还有条目记着这个法人（合同、背调……），先改掉")],
    "entity": [(LedgerAlipay, "entity_id", _BELOW), (LedgerShop, "entity_id", _BELOW),
               (LedgerRecord, "entity_id", "其他台账里还有条目记着这个主体（对公户、印章、发票……），先改掉")],
    "alipay": [(LedgerShop, "alipay_id", _BELOW), (DailyBill, "alipay_id", "财务传过这个户的每日账单，删了就对不上是谁的了；不用了改成注销")],
    "shop": [(LedgerShop, "lead_shop_id", "有引流号在往这家店引流，先改掉引流号")],
    "sim": [(LedgerSim, "master_id", "下面还挂着副卡，先处理副卡"),
            (LedgerDevice, "sim1_id", "还插在手机里，先从手机上拔掉"), (LedgerDevice, "sim2_id", "还插在手机里，先从手机上拔掉")],
    "proxy": [(LedgerDevice, "proxy_id", "还有设备在用这条代理，先给它们换代理，不然会直连")],
    "device": [(LedgerShop, "device_id", "上面还挂着店铺，先把店铺挪走"), (LedgerDevice, "host_id", "上面还开着环境，先把环境挪走")],
}


def delete(db: Session, staff: Staff, level: str, row_id: str) -> None:
    row = _get(db, level, row_id)
    for model, fk, msg in _CHILD.get(level, []):
        if db.query(model).filter(getattr(model, fk) == row.id).first() is not None:
            raise HTTPException(status_code=400, detail=msg)
    if level == "alipay" and row.role == "master":
        payer = db.query(LedgerAlipay).filter(LedgerAlipay.entity_id == row.entity_id, LedgerAlipay.corporate_pay.is_(True)).first()
        if payer is not None:
            raise HTTPException(status_code=400, detail=f"采购号 {payer.account} 开着因公付、要从它扣钱，先关掉那边")
    if level in ("alipay", "shop"):
        from app.models import LedgerCase, LedgerVault

        if db.query(LedgerCase).filter(LedgerCase.target_type == level, LedgerCase.target_id == row.id,
                                       LedgerCase.status == "open").first() is not None:
            raise HTTPException(status_code=400, detail="还有开店进度没走完，先在「开店」页撤销")
        if db.query(LedgerVault).filter(LedgerVault.target_type == level, LedgerVault.target_id == row.id).first() is not None:
            raise HTTPException(status_code=400, detail="密码库里还有这个账号的密码，先删掉那条或改挂别处")
    if level == "legal_person":
        from app.models import LedgerTarget

        db.query(LedgerGrant).filter(LedgerGrant.legal_person_id == row.id).delete()
        db.query(LedgerTarget).filter(LedgerTarget.legal_person_id == row.id).delete()
    if level in ("device", "alipay", "shop"):
        db.query(LedgerKnows).filter(LedgerKnows.target_type == level, LedgerKnows.target_id == row.id).delete(
            synchronize_session=False)
    log(db, staff, "delete", level, row.id, getattr(row, REQUIRED[level], None))
    db.delete(row)


def merge(db: Session, staff: Staff, source_id: str, into_id: str) -> LedgerLegalPerson:
    """业务员填重了的法人：把 source 下面的主体挪到 into，再删掉 source。"""
    if source_id == into_id:
        raise HTTPException(status_code=400, detail="不能合并到自己")
    src = _get(db, "legal_person", source_id)
    dst = _get(db, "legal_person", into_id)
    db.query(LedgerEntity).filter(LedgerEntity.legal_person_id == src.id).update({"legal_person_id": dst.id})
    db.query(LedgerSim).filter(LedgerSim.legal_person_id == src.id).update({"legal_person_id": dst.id})
    db.query(LedgerGrant).filter(LedgerGrant.legal_person_id == src.id).update({"legal_person_id": dst.id})
    for f in ("phone", "email", "note"):
        if not getattr(dst, f) and getattr(src, f):
            setattr(dst, f, getattr(src, f))
    log(db, staff, "merge", "legal_person", dst.id, f"并入 {src.name}（{src.id}）")
    db.flush()  # 卡挪过来再删 src，不然外键拦
    db.delete(src)
    return dst


def mark_checked(db: Session, staff: Staff, lp: LedgerLegalPerson) -> None:
    """这个法人整棵核对完了。"""
    lp.needs_check = False
    db.query(LedgerSim).filter(LedgerSim.legal_person_id == lp.id).update({"needs_check": False}, synchronize_session=False)
    ent_ids = [e for (e,) in db.query(LedgerEntity.id).filter(LedgerEntity.legal_person_id == lp.id).all()]
    if ent_ids:
        db.query(LedgerEntity).filter(LedgerEntity.id.in_(ent_ids)).update({"needs_check": False}, synchronize_session=False)
        db.query(LedgerAlipay).filter(LedgerAlipay.entity_id.in_(ent_ids)).update({"needs_check": False}, synchronize_session=False)
        db.query(LedgerShop).filter(LedgerShop.entity_id.in_(ent_ids)).update({"needs_check": False}, synchronize_session=False)
    log(db, staff, "check", "legal_person", lp.id)


# ---------------------------------------------------------------- 业务员填报

def submit(db: Session, staff: Staff, data: dict) -> None:
    """业务员填一条「法人 → 主体 → 支付宝 → 店铺」。

    能对上已有的就挂上去，对不上的新建并标「要核对」。**不告诉业务员对没对上**——
    回什么都一样，免得拿填报来试探台账里有没有某个人。
    """
    d = {k: _clean(v) for k, v in data.items()}
    if not d.get("legal_person_name"):
        raise HTTPException(status_code=400, detail="法人姓名要填")
    if d.get("alipay_account") and not d.get("entity_name"):
        raise HTTPException(status_code=400, detail="填了支付宝就要填它属于哪个主体")
    if d.get("shop_name") and not d.get("alipay_account"):
        raise HTTPException(status_code=400, detail="填了店铺就要填它收款的支付宝账号")
    if d.get("entity_type") and d["entity_type"] not in ENTITY_TYPES:
        raise HTTPException(status_code=400, detail="主体类型只能是个体户、公司或个人")
    if d.get("shop_platform") and d["shop_platform"] not in PLATFORMS:
        raise HTTPException(status_code=400, detail="平台不对")

    def new(model, **kw):
        row = model(created_by_id=staff.id, needs_check=True, note=d.get("note"), **kw)
        db.add(row)
        db.flush()
        return row

    # 法人：姓名 + 手机号都对上才算同一个人；只有姓名的一律新建，管理员再合并
    lp = None
    if d.get("legal_person_phone"):
        lp = (
            db.query(LedgerLegalPerson)
            .filter(LedgerLegalPerson.name == d["legal_person_name"], LedgerLegalPerson.phone == d["legal_person_phone"])
            .first()
        )
    if lp is None:
        lp = new(LedgerLegalPerson, name=d["legal_person_name"], phone=d.get("legal_person_phone"), email=d.get("legal_person_email"))

    ent = None
    if d.get("entity_name"):
        q = db.query(LedgerEntity).filter(LedgerEntity.legal_person_id == lp.id)
        ent = (q.filter(LedgerEntity.credit_code == d["credit_code"]) if d.get("credit_code") else q.filter(LedgerEntity.name == d["entity_name"])).first()
        if ent is None:
            ent = new(LedgerEntity, legal_person_id=lp.id, name=d["entity_name"],
                      entity_type=d.get("entity_type") or "individual", credit_code=d.get("credit_code"))

    ali = None
    if d.get("alipay_account"):
        ali = db.query(LedgerAlipay).filter(LedgerAlipay.entity_id == ent.id, LedgerAlipay.account == d["alipay_account"]).first()
        if ali is None:
            ali = new(LedgerAlipay, entity_id=ent.id, account=d["alipay_account"])

    if d.get("shop_name"):
        platform = d.get("shop_platform") or "xianyu"
        hit = (
            db.query(LedgerShop)
            .filter(LedgerShop.alipay_id == ali.id, LedgerShop.platform == platform, LedgerShop.name == d["shop_name"])
            .first()
        )
        if hit is None:
            new(LedgerShop, entity_id=ent.id, alipay_id=ali.id, platform=platform, name=d["shop_name"])

    log(db, staff, "submit", "legal_person", lp.id)


# ---------------------------------------------------------------- 临时开放

def grant(db: Session, admin: Staff, *, staff_id: str, legal_person_id: str, hours: int | None, reason: str | None) -> LedgerGrant:
    target = db.get(Staff, staff_id)
    if target is None or target.deleted_at is not None or target.status != StaffStatus.ACTIVE:
        raise HTTPException(status_code=400, detail="没有这个员工，或者他已经停用了")
    _get(db, "legal_person", legal_person_id)
    hours = max(1, min(int(hours or DEFAULT_GRANT_HOURS), MAX_GRANT_HOURS))
    row = LedgerGrant(staff_id=staff_id, legal_person_id=legal_person_id, granted_by_id=admin.id,
                      reason=_clean(reason), expires_at=datetime.utcnow() + timedelta(hours=hours))
    db.add(row)
    db.flush()
    log(db, admin, "grant", "legal_person", legal_person_id, f"开放给 {target.name or target.username}，{hours} 小时内打开")
    return row


def revoke(db: Session, admin: Staff, grant_id: str) -> LedgerGrant:
    row = db.get(LedgerGrant, grant_id)
    if row is None:
        raise HTTPException(status_code=404, detail="没有这条开放记录")
    if row.revoked_at is None:
        row.revoked_at = datetime.utcnow()
        log(db, admin, "revoke", "grant", row.id)
    return row


def grant_state(g: LedgerGrant, now: datetime | None = None) -> str:
    now = now or datetime.utcnow()
    if g.revoked_at:
        return "revoked"
    if g.opened_at:
        return "reading" if g.read_until and now < g.read_until else "read"
    return "waiting" if now < g.expires_at else "expired"


GRANT_STATES = {"waiting": "等他打开", "reading": "正在看", "read": "已看完", "expired": "没打开就过期了", "revoked": "已收回"}


def open_grant(db: Session, staff: Staff, grant_id: str) -> tuple[LedgerGrant, dict]:
    """业务员打开开放给他的那条：第一次打开起算 READ_MINUTES 分钟，过了就再也打不开。"""
    g = db.get(LedgerGrant, grant_id)
    if g is None or g.staff_id != staff.id:
        raise HTTPException(status_code=404, detail="没有开放给你的这条")
    state = grant_state(g)
    if state in ("read", "expired", "revoked"):
        raise HTTPException(status_code=410, detail={"read": "已经看过了，看不到了", "expired": "过期了，找管理员重新开放",
                                                     "revoked": "管理员已经收回了"}[state])
    now = datetime.utcnow()
    if g.opened_at is None:
        g.opened_at = now
        g.read_until = now + timedelta(minutes=READ_MINUTES)
        log(db, staff, "open", "grant", g.id)
    lp = db.get(LedgerLegalPerson, g.legal_person_id)
    if lp is None:
        raise HTTPException(status_code=410, detail="这条已经删了")
    log(db, staff, "view", "legal_person", lp.id, "临时开放")
    return g, detail(db, lp)

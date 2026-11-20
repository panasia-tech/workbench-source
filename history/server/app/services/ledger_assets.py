"""大台账第二步：代理 IP、设备的清单，群控同步，续期 / 充值，手机号反查和换号。

增删改走 services/ledger.py 的通用那套（level = sim / proxy / device），规矩也在那边；这里只放
清单和几个动作。设备从群控只读同步，不往群控、AdsPower 写任何东西。
"""

from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models import (
    LedgerAlipay,
    LedgerCharge,
    LedgerDevice,
    LedgerEntity,
    LedgerLegalPerson,
    LedgerProxy,
    LedgerShop,
    LedgerSim,
    SaleShop,
    Staff,
)
from app.services import ledger as lg

CHARGE_KINDS = {"proxy_renew": "续期", "sim_recharge": "充值"}


def _add_months(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    y, m = d.year + y, m + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


def _dt(v) -> str | None:
    """库里存的是 UTC，页面上要北京时间。"""
    return (v + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M") if v else None


# ---------------------------------------------------------------- 清单

def list_proxies(db: Session) -> dict:
    proxies = db.query(LedgerProxy).order_by(LedgerProxy.code).all()
    devs = db.query(LedgerDevice).filter(LedgerDevice.proxy_id.isnot(None), LedgerDevice.status != "closed").all()
    by_proxy: dict[str, list] = {}
    for d in devs:
        by_proxy.setdefault(d.proxy_id, []).append(d)
    shops: dict[str, list] = {}
    if devs:
        for s in db.query(LedgerShop).filter(LedgerShop.device_id.in_([d.id for d in devs]), LedgerShop.status != "closed").all():
            shops.setdefault(s.device_id, []).append(s)
    today = lg._today()
    items = []
    for p in proxies:
        used = by_proxy.get(p.id, [])
        items.append({
            "id": p.id, "code": p.code, "provider": p.provider, "protocol": p.protocol,
            "protocol_label": lg.PROXY_PROTOCOLS.get(p.protocol, p.protocol), "host": p.host, "port": p.port,
            "exit_ip": p.exit_ip, "region": p.region, "monthly_cost": lg._d(p.monthly_cost),
            "expires_on": p.expires_on.isoformat() if p.expires_on else None, "alerts": lg.proxy_alerts(p, today),
            "devices": [{"id": d.id, "name": d.name} for d in used],
            "shops": [{"name": s.name, "platform_label": lg.PLATFORMS.get(s.platform, s.platform)}
                      for d in used for s in shops.get(d.id, [])],
            "status": p.status, "note": p.note,
        })
    monthly = sum((p.monthly_cost or Decimal("0")) for p in proxies if p.status == "active")
    return {"items": items, "monthly_total": lg._d(monthly)}


def list_devices(db: Session, kind: str | None) -> dict:
    q = db.query(LedgerDevice)
    if kind:
        q = q.filter(LedgerDevice.kind == kind)
    devices = q.order_by(LedgerDevice.kind, LedgerDevice.name).all()
    names = {d.id: d.name for d in db.query(LedgerDevice.id, LedgerDevice.name).all()}
    proxies = {p.id: p for p in db.query(LedgerProxy).all()}
    sim_ids = {i for d in devices for i in (d.sim1_id, d.sim2_id) if i}
    sims = {c.id: c for c in db.query(LedgerSim).filter(LedgerSim.id.in_(sim_ids)).all()} if sim_ids else {}
    shops: dict[str, list] = {}
    if devices:
        for s in db.query(LedgerShop).filter(LedgerShop.device_id.in_([d.id for d in devices])).all():
            shops.setdefault(s.device_id, []).append(s)
    lp_names = dict(db.query(LedgerLegalPerson.id, LedgerLegalPerson.name).all())

    def sim(i):
        c = sims.get(i or "")
        return {"id": c.id, "phone": c.phone, "carrier": c.carrier, "legal_person": lp_names.get(c.legal_person_id)} if c else None

    today = lg._today()
    return {"items": [
        {
            "id": d.id, "kind": d.kind, "kind_label": lg.DEVICE_KINDS.get(d.kind, d.kind), "name": d.name,
            "purpose": d.purpose, "purpose_label": lg.DEVICE_PURPOSES.get(d.purpose, d.purpose),
            "ads_user_id": d.ads_user_id, "gc_device_id": d.gc_device_id, "gc_nick": d.gc_nick,
            "last_online_at": _dt(d.last_online_at), "model": d.model, "serial": d.serial, "imei1": d.imei1,
            "imei2": d.imei2, "host_id": d.host_id, "host_name": names.get(d.host_id or ""),
            "proxy_id": d.proxy_id, "proxy_code": proxies[d.proxy_id].code if d.proxy_id in proxies else None,
            "proxy_alerts": lg.proxy_alerts(proxies[d.proxy_id], today) if d.proxy_id in proxies else [],
            "sim1_id": d.sim1_id, "sim2_id": d.sim2_id, "sim1": sim(d.sim1_id), "sim2": sim(d.sim2_id),
            "shops": [{"id": s.id, "name": s.name, "platform_label": lg.PLATFORMS.get(s.platform, s.platform)}
                      for s in shops.get(d.id, [])],
            "custodian": d.custodian, "location": d.location, "status": d.status, "note": d.note,
        }
        for d in devices
    ]}


def sim_options(db: Session) -> list[dict]:
    """设备卡槽能选的卡：没停用的，带上是谁名下的。"""
    lp_names = dict(db.query(LedgerLegalPerson.id, LedgerLegalPerson.name).all())
    return [{"id": c.id, "label": f"{c.phone}（{lp_names.get(c.legal_person_id, '')} · {c.carrier}）"}
            for c in db.query(LedgerSim).filter(LedgerSim.status != "closed").order_by(LedgerSim.phone).all()]


# ---------------------------------------------------------------- 群控同步

async def sync_from_gc(db: Session, staff: Staff) -> dict:
    """把群控里的 AdsPower 环境、手机同步成台账设备；按闲鱼号把店铺挂到它现在登着的设备上。

    只空补齐、不覆盖人填的；群控里停用的设备不新建。
    """
    from app.services.gc_bridge import client as gc

    try:
        devices = await gc.list_devices()
        accounts = await gc.list_accounts()
    except Exception as e:  # noqa: BLE001 —— 连不上群控就照实说
        raise HTTPException(status_code=502, detail=f"连不上群控：{e}") from None
    nick_of = {a.get("id"): (a.get("nick") or "").strip() for a in accounts if a.get("id")}
    rows = db.query(LedgerDevice).all()
    by_gc = {r.gc_device_id: r for r in rows if r.gc_device_id}
    by_ads = {r.ads_user_id: r for r in rows if r.ads_user_id}
    by_serial = {r.serial: r for r in rows if r.serial and r.kind == "phone"}
    sims = {c.phone: c for c in db.query(LedgerSim).filter(LedgerSim.status != "closed").all()}
    slotted = {i for r in rows for i in (r.sim1_id, r.sim2_id) if i}

    created = updated = sims_put = 0
    ledger_of_gc: dict[str, LedgerDevice] = {}
    for d in devices:
        gid = d.get("id")
        if not gid:
            continue
        kind = "env" if d.get("kind") == "browser" else "phone"
        hw = (d.get("hw_id") or "").strip() or None
        serial = (d.get("serial") or "").strip() or None
        row = by_gc.get(gid) or (by_ads.get(hw) if kind == "env" and hw else None) or (by_serial.get(serial) if kind == "phone" and serial else None)
        if row is None:
            if d.get("status") == "DISABLED":
                continue
            model = " ".join(x for x in (d.get("brand"), d.get("model")) if x and x not in ("adspower", "browser"))
            name = f"环境 {hw}" if kind == "env" and hw else (model or d.get("name") or gid[:8])
            row = LedgerDevice(kind=kind, name=name, purpose="sales", status="active", created_by_id=staff.id)
            db.add(row)
            created += 1
        else:
            updated += 1
        row.gc_device_id = gid
        row.gc_nick = nick_of.get(d.get("account_id")) or d.get("reported_nick") or row.gc_nick
        row.last_online_at = d.get("last_online_at") and _parse(d["last_online_at"]) or row.last_online_at
        if kind == "env" and hw and not row.ads_user_id:
            row.ads_user_id = hw
        if kind == "phone":
            for f in ("serial", "imei1", "imei2"):
                if not getattr(row, f) and d.get(f):
                    setattr(row, f, d[f])
            if not row.model and d.get("model"):
                row.model = " ".join(x for x in (d.get("brand"), d.get("model")) if x)
            c = sims.get(lg.norm_phone(d.get("phone_number")) or "")
            if c and c.id not in slotted and not row.sim1_id:
                row.sim1_id = c.id
                slotted.add(c.id)
                sims_put += 1
        ledger_of_gc[gid] = row
    db.flush()

    # 店铺 → 它的闲鱼号现在登在哪台设备上（gc 账号的激活设备）
    linked = 0
    shops = db.query(SaleShop).all()
    for a in accounts:
        row = ledger_of_gc.get(a.get("device_id"))
        if row is None or row.purpose != "sales" or row.status == "closed":
            continue
        nick = (a.get("nick") or "").strip()
        sale_ids = [s.id for s in shops if s.gc_account_id == a.get("id") or (not s.gc_account_id and s.xianyu_user_name == nick)]
        if not sale_ids:
            continue
        for s in db.query(LedgerShop).filter(LedgerShop.sale_shop_id.in_(sale_ids), LedgerShop.device_id.is_(None),
                                             LedgerShop.status != "closed").all():
            s.device_id = row.id
            try:
                lg.proxy_clash(db, row.proxy_id, shop=s)
            except HTTPException:
                s.device_id = None  # 会撞代理的不自动挂，留给人看
                continue
            linked += 1
    out = {"created": created, "updated": updated, "shops_linked": linked, "sims_put": sims_put}
    lg.log(db, staff, "sync", "device", None, f"群控同步：新建 {created}、更新 {updated}、挂店铺 {linked}、插卡 {sims_put}")
    return out


def _parse(v):
    if isinstance(v, datetime):
        return v
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


# ---------------------------------------------------------------- 续期、充值

def _charge(db: Session, staff: Staff, kind: str, target_id: str, **kw) -> LedgerCharge:
    row = LedgerCharge(kind=kind, target_id=target_id, staff_id=staff.id, **kw)
    db.add(row)
    return row


def renew_proxy(db: Session, staff: Staff, proxy_id: str, *, months: int, amount, note: str | None) -> LedgerProxy:
    p = lg._get(db, "proxy", proxy_id)
    if not 1 <= int(months) <= 36:
        raise HTTPException(status_code=400, detail="续几个月要在 1 到 36 之间")
    today = lg._today()
    old = p.expires_on
    p.expires_on = _add_months(max(old, today) if old else today, int(months))
    if p.status == "paused":
        p.status = "active"
    _charge(db, staff, "proxy_renew", p.id, amount=lg._money(amount, "续费金额"), months=int(months),
            before=old.isoformat() if old else None, after=p.expires_on.isoformat(), note=lg._clean(note))
    lg.log(db, staff, "update", "proxy", p.id, f"续期 {months} 个月，到 {p.expires_on.isoformat()}")
    return p


def recharge_sim(db: Session, staff: Staff, sim_id: str, *, amount, note: str | None) -> LedgerSim:
    c = lg._get(db, "sim", sim_id)
    amt = lg._money(amount, "充值金额")
    if not amt:
        raise HTTPException(status_code=400, detail="充值金额要大于 0")
    old = c.balance
    c.balance = (old or Decimal("0")) + amt
    c.balance_on = lg._today()
    _charge(db, staff, "sim_recharge", c.id, amount=amt, before=lg._d(old), after=lg._d(c.balance), note=lg._clean(note))
    lg.log(db, staff, "update", "sim", c.id, f"充值 ¥{amt}")
    return c


def charges(db: Session, target_id: str) -> list[dict]:
    names = dict(db.query(Staff.id, Staff.name).all())
    return [
        {"id": r.id, "kind": r.kind, "kind_label": CHARGE_KINDS.get(r.kind, r.kind), "amount": lg._d(r.amount),
         "months": r.months, "before": r.before, "after": r.after, "note": r.note,
         "staff": names.get(r.staff_id), "created_at": _dt(r.created_at)}
        for r in db.query(LedgerCharge).filter(LedgerCharge.target_id == target_id).order_by(LedgerCharge.created_at.desc()).limit(50)
    ]


# ---------------------------------------------------------------- 反查、换号

# 台账里记手机号的地方：(模型, 字段, 叫法)
_PHONE_SPOTS = (
    (LedgerLegalPerson, "phone", "法人主设备手机号"),
    (LedgerEntity, "tax_phone", "办税人手机号"),
    (LedgerEntity, "liaison_phone", "工商联络员手机号"),
    (LedgerAlipay, "phone", "支付宝绑定手机号"),
    (LedgerShop, "phone", "店铺绑定手机号"),
)


def _label(row) -> str:
    if isinstance(row, LedgerAlipay):
        return row.account
    return row.name


def sim_uses(db: Session, sim_id: str) -> dict:
    """这个号在台账里绑了哪些东西、插在哪台手机里。"""
    c = lg._get(db, "sim", sim_id)
    out = []
    for model, field, what in _PHONE_SPOTS:
        for row in db.query(model).filter(getattr(model, field) == c.phone).all():
            out.append({"what": what, "name": _label(row), "level": lg_level(model), "id": row.id})
    for a in db.query(LedgerAlipay).filter(LedgerAlipay.account == c.phone).all():
        out.append({"what": "支付宝登录名", "name": a.account, "level": "alipay", "id": a.id})
    for d in db.query(LedgerDevice).filter(or_(LedgerDevice.sim1_id == c.id, LedgerDevice.sim2_id == c.id)).all():
        out.append({"what": "插在", "name": d.name, "level": "device", "id": d.id})
    return {"phone": c.phone, "items": out}


def lg_level(model) -> str:
    return {LedgerLegalPerson: "legal_person", LedgerEntity: "entity", LedgerAlipay: "alipay", LedgerShop: "shop"}[model]


def rebind(db: Session, staff: Staff, sim_id: str, to_sim_id: str) -> dict:
    """旧号换成新号：台账里记着旧号的地方都改成新号，旧卡从手机上拔掉、停用。

    平台那边的换绑要人去做，这里只改台账，另外建一张换号核验单（其他台账 → 员工与离职）逐处打勾。
    支付宝登录名就是旧号的不改，列出来提醒去支付宝改。
    """
    from app.services.ledger_records import rebind_checklist

    old = lg._get(db, "sim", sim_id)
    new = lg._get(db, "sim", to_sim_id)
    if old.id == new.id:
        raise HTTPException(status_code=400, detail="新号和旧号是同一个")
    if new.status == "closed":
        raise HTTPException(status_code=400, detail=f"{new.phone} 已经停用了")
    if old.category == "master" and lg._subs(db, old.id):
        raise HTTPException(status_code=400, detail="旧卡下面还挂着副卡，先处理副卡")
    uses = sim_uses(db, old.id)["items"]
    moved = 0
    for model, field, _ in _PHONE_SPOTS:
        moved += db.query(model).filter(getattr(model, field) == old.phone).update({field: new.phone}, synchronize_session=False)
    logins = [a.account for a in db.query(LedgerAlipay).filter(LedgerAlipay.account == old.phone).all()]
    db.query(LedgerDevice).filter(LedgerDevice.sim1_id == old.id).update({"sim1_id": None}, synchronize_session=False)
    db.query(LedgerDevice).filter(LedgerDevice.sim2_id == old.id).update({"sim2_id": None}, synchronize_session=False)
    old.status = "closed"
    lg.log(db, staff, "update", "sim", old.id, f"换号 {old.phone} → {new.phone}，改了 {moved} 处")
    # 台账里改了，平台那边还要人一处处去改：建一张核验单，改完一处勾一处
    check = rebind_checklist(db, staff, old.phone, new.phone, uses)
    return {"moved": moved, "logins": logins, "checklist_id": check.id}

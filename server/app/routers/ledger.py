"""大台账接口。管理员看全部、能改；其他员工只能填报，和打开管理员临时开放给自己的那条。"""

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user, require_roles
from app.enums import StaffRole, StaffStatus
from app.models import LedgerAccessLog, LedgerGrant, LedgerLegalPerson, SaleShop, Staff
from app.services import ledger as lg
from app.services import ledger_assets as la
from app.services import ledger_records as lr
from app.services import ledger_onboard as lo
from app.services import ledger_vault as lv

router = APIRouter(prefix="/api/ledger", tags=["ledger"])

_admin = require_roles()  # 只有管理员能过（require_roles 对 ADMIN 恒放行）


def _cn(dt: datetime | None) -> str | None:
    """库里存的是 UTC，页面上要北京时间。"""
    from datetime import timedelta

    return (dt + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M") if dt else None


@router.get("/me", summary="我在台账里能做什么")
def me(db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    from app.models import LedgerCase, LedgerVault

    is_admin = user.role == StaffRole.ADMIN
    # 台账一个签约委托客户都没有时，管理员一进来就先建第一条（only 管理员看得到，业务员照常只能填）
    empty = is_admin and db.query(LedgerLegalPerson.id).first() is None
    # 第五步：审核人看「开店」页；派了开店单 / 给了账号的员工看「我的开店」「我的账号」
    my_cases = db.query(LedgerCase.id).filter(LedgerCase.assignee_id == user.id, LedgerCase.status == "open").count()
    my_vault = db.query(LedgerVault.id).filter(LedgerVault.assignee_id == user.id).count()
    return {"name": user.name or user.username, "is_admin": is_admin, "read_minutes": lg.READ_MINUTES, "empty": empty,
            "is_reviewer": lo.is_reviewer(db, user), "is_vault_owner": lv.is_owner(user), "my_cases": my_cases,
            "my_vault": my_vault}


@router.get("/options", summary="下拉选项：主体类型、平台、状态、纳税人、征收方式、支付宝角色、结算方式、流水分类、卡、代理、设备")
def options(_: Staff = Depends(get_current_user)):
    from app.services.ledger_bill import FLOWS

    return {"entity_types": lg.ENTITY_TYPES, "platforms": lg.PLATFORMS, "statuses": lg.STATUSES,
            "tax_payers": lg.TAX_PAYERS, "tax_levies": lg.TAX_LEVIES, "alipay_roles": lg.ALIPAY_ROLES,
            "channels": lg.CHANNELS, "flows": FLOWS, "carriers": lg.CARRIERS, "sim_categories": lg.SIM_CATEGORIES,
            "sim_billings": lg.SIM_BILLINGS, "proxy_protocols": lg.PROXY_PROTOCOLS, "device_kinds": lg.DEVICE_KINDS,
            "device_purposes": lg.DEVICE_PURPOSES, "cards_per_person": lg.CARDS_PER_PERSON, "shop_roles": lg.SHOP_ROLES,
            "role_channels": lg.ROLE_CHANNELS, "invoice_modes": lg.INVOICE_MODES, "currencies": lg.CURRENCIES}


# ---------------------------------------------------------------- 业务员

class SubmitIn(BaseModel):
    legal_person_name: str = Field(min_length=1, max_length=64)
    legal_person_phone: str | None = Field(default=None, max_length=32)
    legal_person_email: str | None = Field(default=None, max_length=128)
    entity_name: str | None = Field(default=None, max_length=128)
    entity_type: str | None = None
    credit_code: str | None = Field(default=None, max_length=32)
    alipay_account: str | None = Field(default=None, max_length=128)
    shop_platform: str | None = None
    shop_name: str | None = Field(default=None, max_length=128)
    note: str | None = Field(default=None, max_length=2000)


@router.post("/submit", summary="填报一条：委托客户 → 受托主体 → 支付宝 → 托管店铺（填完脱敏不可反查）")
def submit(body: SubmitIn, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    lg.submit(db, user, body.model_dump())
    db.commit()
    return {"ok": True}


def _grant_out(db: Session, g: LedgerGrant, *, for_admin: bool) -> dict:
    state = lg.grant_state(g)
    out = {
        "id": g.id, "reason": g.reason, "state": state, "state_label": lg.GRANT_STATES[state],
        "expires_at": _cn(g.expires_at), "opened_at": _cn(g.opened_at), "read_until": _cn(g.read_until),
        "created_at": _cn(g.created_at),
    }
    if for_admin:
        staff = db.get(Staff, g.staff_id)
        lp = db.get(LedgerLegalPerson, g.legal_person_id)
        out.update(staff_name=(staff.name or staff.username) if staff else None, legal_person_id=g.legal_person_id,
                   legal_person_name=lp.name if lp else None)
    return out


@router.get("/my-grants", summary="管理员开放给我的（打开前只看得到开放原因）")
def my_grants(db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    rows = db.query(LedgerGrant).filter(LedgerGrant.staff_id == user.id).order_by(LedgerGrant.created_at.desc()).limit(50).all()
    return {"items": [_grant_out(db, g, for_admin=False) for g in rows if lg.grant_state(g) in ("waiting", "reading")]}


@router.post("/my-grants/{grant_id}/open", summary="打开开放给我的那条：第一次打开后只能看一会儿")
def open_grant(grant_id: str, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    try:
        g, data = lg.open_grant(db, user, grant_id)
    except HTTPException:
        db.rollback()
        raise
    db.commit()
    return {"grant": _grant_out(db, g, for_admin=False), "legal_person": data}


# ---------------------------------------------------------------- 管理员

@router.get("/legal-persons", summary="签约委托客户清单（四层一起搜）")
def list_legal_persons(
    q: str | None = Query(None), needs_check: bool | None = Query(None),
    page: int = Query(1, ge=1), size: int = Query(30, ge=1, le=100),
    db: Session = Depends(get_db), _: Staff = Depends(_admin),
):
    return lg.search(db, q=q, needs_check=needs_check, page=page, size=size)


@router.get("/legal-persons/{lp_id}", summary="单个委托客户及其受托主体、支付宝、托管店铺")
def read_legal_person(lp_id: str, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    lp = lg._get(db, "legal_person", lp_id)
    lg.log(db, user, "view", "legal_person", lp.id)
    db.commit()
    return lg.detail(db, lp)


class RowIn(BaseModel):
    """四层共用，按层取用各自的字段（见 services/ledger.FIELDS）。"""

    model_config = {"extra": "allow"}


def _level(level: str) -> str:
    if level not in lg.LEVELS:
        raise HTTPException(status_code=404, detail="没有这一层")
    return level


@router.post("/rows/{level}", summary="新建一条（legal_person/entity/alipay/shop/sim/proxy/device）")
def create_row(level: str, body: RowIn, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    row = lg.create(db, user, _level(level), body.model_dump())
    db.commit()
    return {"id": row.id, "legal_person_id": lg.legal_person_of(db, level, row)}


@router.patch("/rows/{level}/{row_id}", summary="改一条；改上一层的 id 就是挪到别处")
def update_row(level: str, row_id: str, body: RowIn, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    row = lg.update(db, user, _level(level), row_id, body.model_dump())
    db.commit()
    return {"id": row.id, "legal_person_id": lg.legal_person_of(db, level, row)}


@router.delete("/rows/{level}/{row_id}", summary="删一条（下面还挂着东西的删不了）")
def delete_row(level: str, row_id: str, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    lg.delete(db, user, _level(level), row_id)
    db.commit()
    return {"ok": True}


class FirstIn(BaseModel):
    legal_person: dict
    entity: dict
    alipay: dict | None = None
    shop: dict | None = None


@router.post("/first", summary="建第一条受托台账：委托客户 → 受托主体 →（支付宝）→（店铺）一次建完，哪层不对就都不建")
def create_first(body: FirstIn, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    lp = lg.create(db, user, "legal_person", body.legal_person)
    ent = lg.create(db, user, "entity", {**body.entity, "legal_person_id": lp.id})
    ali = lg.create(db, user, "alipay", {**body.alipay, "entity_id": ent.id, "role": "sales"}) if body.alipay else None
    shop = None
    if body.shop:
        via = {"alipay_id": ali.id, "channel": "alipay"} if ali else {"entity_id": ent.id}
        shop = lg.create(db, user, "shop", {**body.shop, **via, "role": "sales"})
    db.commit()
    return {"legal_person_id": lp.id, "entity_id": ent.id, "alipay_id": ali.id if ali else None,
            "shop_id": shop.id if shop else None}


class MergeIn(BaseModel):
    into_id: str


@router.post("/legal-persons/{lp_id}/merge", summary="填重了的委托客户档案合并")
def merge(lp_id: str, body: MergeIn, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    dst = lg.merge(db, user, lp_id, body.into_id)
    db.commit()
    return {"id": dst.id}


@router.post("/legal-persons/{lp_id}/checked", summary="该委托客户受托全链核对完成")
def checked(lp_id: str, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    lg.mark_checked(db, user, lg._get(db, "legal_person", lp_id))
    db.commit()
    return {"ok": True}


class GrantIn(BaseModel):
    staff_id: str
    legal_person_id: str
    hours: int | None = Field(default=None, description=f"多少小时内要打开，默认 {lg.DEFAULT_GRANT_HOURS}")
    reason: str | None = Field(default=None, max_length=255)


@router.get("/grants", summary="开放记录")
def list_grants(
    legal_person_id: str | None = Query(None), db: Session = Depends(get_db), _: Staff = Depends(_admin),
):
    q = db.query(LedgerGrant)
    if legal_person_id:
        q = q.filter(LedgerGrant.legal_person_id == legal_person_id)
    return {"items": [_grant_out(db, g, for_admin=True) for g in q.order_by(LedgerGrant.created_at.desc()).limit(200).all()]}


@router.post("/grants", summary="把某委托客户受托档案临时开放给经办人")
def create_grant(body: GrantIn, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    g = lg.grant(db, user, staff_id=body.staff_id, legal_person_id=body.legal_person_id, hours=body.hours, reason=body.reason)
    db.commit()
    return _grant_out(db, g, for_admin=True)


@router.post("/grants/{grant_id}/revoke", summary="收回开放")
def revoke_grant(grant_id: str, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    g = lg.revoke(db, user, grant_id)
    db.commit()
    return _grant_out(db, g, for_admin=True)


ACTIONS = {"view": "查看", "create": "新建", "update": "修改", "delete": "删除", "submit": "填报", "grant": "开放",
           "revoke": "收回", "open": "打开开放", "merge": "合并", "check": "核对完", "auth": "发授权链接", "fetch": "补拉账单",
           "sync": "群控同步"}


@router.get("/logs", summary="谁看了、改了、开放了什么")
def logs(
    target_id: str | None = Query(None), page: int = Query(1, ge=1), size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db), _: Staff = Depends(_admin),
):
    q = db.query(LedgerAccessLog)
    if target_id:
        q = q.filter(LedgerAccessLog.target_id == target_id)
    total = q.count()
    rows = q.order_by(LedgerAccessLog.created_at.desc()).offset((page - 1) * size).limit(size).all()
    names = {s.id: s.name or s.username for s in db.query(Staff).filter(Staff.id.in_({r.staff_id for r in rows})).all()} if rows else {}
    return {
        "total": total,
        "items": [
            {"at": _cn(r.created_at), "staff_name": names.get(r.staff_id), "action": ACTIONS.get(r.action, r.action),
             "target_type": r.target_type, "target_id": r.target_id, "detail": r.detail}
            for r in rows
        ],
    }


@router.get("/staff-options", summary="能开放给谁：在职员工")
def staff_options(db: Session = Depends(get_db), _: Staff = Depends(_admin)):
    rows = (
        db.query(Staff).filter(Staff.deleted_at.is_(None), Staff.status == StaffStatus.ACTIVE)
        .order_by(Staff.role, Staff.name).all()
    )
    return {"items": [{"id": s.id, "name": s.name or s.username, "role": s.role} for s in rows]}


@router.get("/sale-shop-options", summary="能挂上的 ERP 店铺")
def sale_shop_options(db: Session = Depends(get_db), _: Staff = Depends(_admin)):
    rows = db.query(SaleShop).order_by(SaleShop.sort_order, SaleShop.label).all()
    return {"items": [{"id": s.id, "label": s.label, "xianyu_user_name": s.xianyu_user_name} for s in rows]}


# ---------------------------------------------------------------- 单店月度损益（第三步）

@router.get("/shops/{shop_id}/months", summary="一家销售店最近几个月的损益（按 ERP 出库算）")
def shop_months(shop_id: str, n: int = Query(6, ge=1, le=24), db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    s = lg._get(db, "shop", shop_id)
    if s.role != "sales" or not s.sale_shop_id:
        return {"items": []}
    month = lg._today().replace(day=1)
    items = []
    for _ in range(n):
        items.append(lg.shop_month(db, {s.sale_shop_id}, month)[s.sale_shop_id])
        month = (month - timedelta(days=1)).replace(day=1)
    return {"items": items}


# ---------------------------------------------------------------- 手机卡、代理、设备（第二步）

@router.get("/proxies", summary="代理 IP 清单：谁在用、快到期的")
def list_proxies(db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    return la.list_proxies(db)


@router.get("/devices", summary="设备清单：AdsPower 环境、手机、电脑")
def list_devices(kind: str | None = Query(None), db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    return la.list_devices(db, kind)


@router.get("/sim-options", summary="设备卡槽能选的卡")
def sim_options(db: Session = Depends(get_db), _: Staff = Depends(_admin)):
    return {"items": la.sim_options(db)}


@router.post("/devices/sync", summary="从群控同步 AdsPower 环境和手机（只读群控）")
async def sync_devices(db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    out = await la.sync_from_gc(db, user)
    db.commit()
    return out


class RenewIn(BaseModel):
    months: int = Field(ge=1, le=36)
    amount: float | None = Field(default=None, ge=0)
    note: str | None = Field(default=None, max_length=255)


@router.post("/proxies/{proxy_id}/renew", summary="代理续期，记一笔")
def renew_proxy(proxy_id: str, body: RenewIn, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    p = la.renew_proxy(db, user, proxy_id, months=body.months, amount=body.amount, note=body.note)
    db.commit()
    return {"id": p.id, "expires_on": p.expires_on.isoformat()}


class RechargeIn(BaseModel):
    amount: float = Field(gt=0)
    note: str | None = Field(default=None, max_length=255)


@router.post("/sims/{sim_id}/recharge", summary="话费充值，记一笔、余额加上")
def recharge_sim(sim_id: str, body: RechargeIn, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    c = la.recharge_sim(db, user, sim_id, amount=body.amount, note=body.note)
    db.commit()
    return {"id": c.id, "legal_person_id": c.legal_person_id, "balance": lg._d(c.balance)}


@router.get("/charges", summary="一条代理 / 一张卡的续期、充值记录")
def list_charges(target_id: str = Query(...), db: Session = Depends(get_db), _: Staff = Depends(_admin)):
    return {"items": la.charges(db, target_id)}


@router.get("/sims/{sim_id}/uses", summary="这个号在台账里绑了什么")
def sim_uses(sim_id: str, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    out = la.sim_uses(db, sim_id)
    lg.log(db, user, "view", "sim", sim_id, "反查绑定")
    db.commit()
    return out


class RebindIn(BaseModel):
    to_sim_id: str


@router.post("/sims/{sim_id}/rebind", summary="换号：台账里记着旧号的地方都换成新号，旧卡停用")
def rebind_sim(sim_id: str, body: RebindIn, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    out = la.rebind(db, user, sim_id, body.to_sim_id)
    db.commit()
    return out


# ---------------------------------------------------------------- 其他台账（第四步，审计报告另外 12 个模块）

@router.get("/records/catalog", summary="其他台账有哪几种、每种有哪些字段")
def records_catalog(_: Staff = Depends(_admin)):
    return lr.catalog()


@router.get("/records/refs", summary="表单下拉：受托主体、委托客户、托管店铺、对公户")
def records_refs(db: Session = Depends(get_db), _: Staff = Depends(_admin)):
    return lr.ref_options(db)


@router.get("/records/radar", summary="雷达：其他台账里所有要人去办的事，红的在前")
def records_radar(db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    if lr.ensure_months(db, user):
        db.commit()
    return {"items": lr.radar(db), "counts": lr.counts(db)}


@router.get("/records", summary="某一种台账的清单")
def list_records(kind: str = Query(...), q: str | None = Query(None), db: Session = Depends(get_db),
                 user: Staff = Depends(_admin)):
    if kind == "close_month" and lr.ensure_months(db, user):
        db.commit()
    return {"items": lr.list_records(db, kind, q)}


class RecordIn(BaseModel):
    """字段按 kind 取用（见 services/ledger_records.KINDS）。"""

    model_config = {"extra": "allow"}


@router.post("/records/{kind}", summary="新建一条")
def create_record(kind: str, body: RecordIn, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    rec = lr.create(db, user, kind, body.model_dump())
    db.commit()
    return {"id": rec.id}


@router.patch("/records/item/{rid}", summary="改一条")
def update_record(rid: str, body: RecordIn, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    rec = lr.update(db, user, rid, body.model_dump())
    db.commit()
    return {"id": rec.id}


@router.delete("/records/item/{rid}", summary="删一条")
def delete_record(rid: str, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    lr.delete(db, user, rid)
    db.commit()
    return {"ok": True}


@router.get("/records/item/{rid}/events", summary="一条的流水（借出归还、充值、带看……）")
def record_events(rid: str, db: Session = Depends(get_db), _: Staff = Depends(_admin)):
    return {"items": lr.events(db, rid)}


@router.post("/records/item/{rid}/events/{ev}", summary="记一笔流水")
def add_record_event(rid: str, ev: str, body: RecordIn, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    lr.add_event(db, user, rid, ev, body.model_dump())
    db.commit()
    return {"ok": True}


class TickIn(BaseModel):
    item: str
    done: bool = True


@router.post("/records/item/{rid}/tick", summary="清单打勾 / 取消")
def tick_record(rid: str, body: TickIn, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    lr.tick(db, user, rid, body.item, body.done)
    db.commit()
    return {"ok": True}


@router.post("/records/item/{rid}/check-cert", summary="域名：连 443 查证书哪天到期")
def check_cert(rid: str, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    rec = lr.check_cert(db, user, rid)
    db.commit()
    return {"cert_expires_on": rec.attrs.get("cert_expires_on")}


@router.get("/knows", summary="谁知道哪些密码（不记密码本身）")
def list_knows(db: Session = Depends(get_db), _: Staff = Depends(_admin)):
    return {"items": lr.knows_list(db)}


@router.get("/knows/targets", summary="选是哪个东西：设备、支付宝、店铺、台账条目")
def know_targets(q: str | None = Query(None), db: Session = Depends(get_db), _: Staff = Depends(_admin)):
    return {"items": lr.targets(db, q)}


class KnowsIn(BaseModel):
    target_type: str
    target_id: str
    what: str
    staff_ids: list[str] = Field(min_length=1, max_length=50)


@router.post("/knows", summary="记谁知道")
def add_knows(body: KnowsIn, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    n = lr.add_knows(db, user, target_type=body.target_type, target_id=body.target_id, what=body.what,
                     staff_ids=body.staff_ids)
    db.commit()
    return {"added": n}


@router.delete("/knows/{kid}", summary="密码改好了：这个人不再知道")
def rotated(kid: str, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    lr.rotated(db, user, kid)
    db.commit()
    return {"ok": True}


@router.get("/employee-sims", summary="员工实名卡")
def employee_sims(db: Session = Depends(get_db), _: Staff = Depends(_admin)):
    return {"items": lr.employee_sims(db)}


# ---------------------------------------------------------------- 对账

def _range(start: str | None, end: str | None) -> tuple:
    from datetime import date as _date, timedelta as _td

    today = (datetime.utcnow() + _td(hours=8)).date()
    try:
        e = _date.fromisoformat(end) if end else today - _td(days=1)
        st = _date.fromisoformat(start) if start else e - _td(days=6)
    except ValueError:
        raise HTTPException(status_code=400, detail="日期格式不对，要 2026-11-09 这样")
    if st > e or (e - st).days > 92:
        raise HTTPException(status_code=400, detail="日期范围不对（最多三个月）")
    return st, e


@router.post("/alipays/{alipay_id}/auth-link", summary="生成授权对账链接，发给那家企业支付宝的管理员")
def auth_link(alipay_id: str, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    from app.services import ledger_bill as lb

    row = lg._get(db, "alipay", alipay_id)
    url = lb.auth_link(db, user, row)
    lg.log(db, user, "auth", "alipay", row.id, "生成授权链接")
    db.commit()
    return {"url": url, "days": lb.STATE_TTL.days}


@router.get("/alipay-auth/callback", summary="支付宝授权回调（支付宝跳回来，不需要登录）", include_in_schema=False)
async def auth_callback(
    app_auth_code: str | None = Query(None), state: str | None = Query(None), db: Session = Depends(get_db),
):
    from fastapi.responses import HTMLResponse
    from app.services import ledger_bill as lb

    def page(title: str, text: str, code: int = 200):
        html = (
            '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{title}</title><div style="font:16px/1.7 -apple-system,sans-serif;padding:48px 24px;text-align:center">'
            f'<h2>{title}</h2><p style="color:#555">{text}</p></div>'
        )
        return HTMLResponse(html, status_code=code)

    if not app_auth_code or not state:
        return page("授权没完成", "链接不完整，请回到支付宝重新点同意，或者找管理员重新发链接。", 400)
    try:
        row = await lb.handle_callback(db, state=state, code=app_auth_code)
    except HTTPException as exc:
        return page("授权没完成", str(exc.detail), exc.status_code)
    except Exception:  # noqa: BLE001
        return page("授权没完成", "和支付宝通信出错，过几分钟再点一次链接。", 502)
    return page("授权成功", f"支付宝 {row.account} 已授权对账，可以关掉这个页面了。")


@router.get("/reconcile", summary="对账总览：每个支付宝这段日子的进账和对上情况")
def reconcile_overview(
    start: str | None = Query(None), end: str | None = Query(None), db: Session = Depends(get_db), _: Staff = Depends(_admin),
):
    from app.services import ledger_bill as lb

    st, e = _range(start, end)
    return lb.overview(db, start=st, end=e)


@router.get("/reconcile/{alipay_id}", summary="一个支付宝的进账逐笔，和卖了却没对上进账的单")
def reconcile_detail(
    alipay_id: str, start: str | None = Query(None), end: str | None = Query(None),
    db: Session = Depends(get_db), user: Staff = Depends(_admin),
):
    from app.services import ledger_bill as lb

    st, e = _range(start, end)
    row = lg._get(db, "alipay", alipay_id)
    lg.log(db, user, "view", "alipay", row.id, f"对账 {st}~{e}")
    db.commit()
    return lb.detail(db, row, start=st, end=e)


@router.post("/reconcile/{alipay_id}/fetch", summary="现在就拉这段日子的账单（补拉）")
async def reconcile_fetch(
    alipay_id: str, start: str | None = Query(None), end: str | None = Query(None),
    db: Session = Depends(get_db), user: Staff = Depends(_admin),
):
    from datetime import timedelta as _td
    from app.services import ledger_bill as lb

    st, e = _range(start, end)
    if (e - st).days > 31:
        raise HTTPException(status_code=400, detail="一次最多补拉 31 天")
    row = lg._get(db, "alipay", alipay_id)
    if row.auth_status != "authorized":
        raise HTTPException(status_code=400, detail="这个支付宝还没授权对账")
    result = {"ok": 0, "empty": 0, "error": 0}
    errors = []
    d = st
    while d <= e:
        f = await lb.fetch_day(db, row, d)
        result[f.status] = result.get(f.status, 0) + 1
        if f.status == "error":
            errors.append(f"{d}：{f.error}")
        db.commit()
        d += _td(days=1)
    lg.log(db, user, "fetch", "alipay", row.id, f"补拉 {st}~{e}")
    db.commit()
    return {**result, "errors": errors[:5]}


class FlowIn(BaseModel):
    flow: str


@router.post("/bills/{bill_id}/flow", summary="改一笔流水的分类（改过的不再自动覆盖）")
def set_bill_flow(bill_id: str, body: FlowIn, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    from app.services import ledger_bill as lb

    b = lb.set_flow(db, bill_id, body.flow)
    lg.log(db, user, "update", "bill", b.id, f"分类改成 {lb.FLOWS[body.flow]}")
    db.commit()
    return {"id": b.id, "flow": b.flow, "flow_label": lb.FLOWS[b.flow], "flow_manual": True}


# ---------------------------------------------------------------- 第五步：开店（看缺口、教程、进度）

@router.get("/onboard/home", summary="开店首页：要动手的事（红黄）、缺口、教程覆盖")
def onboard_home(db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    rev = lo.is_reviewer(db, user)
    lo.ensure_seed(db)
    db.commit()
    out = {"issues": lo.issues(db, user), "is_boss": lo.is_boss(user), "is_reviewer": rev}
    if rev:
        out.update(gaps=lo.gaps(db), coverage=lo.coverage(db), target_keys=lo.TARGET_KEYS, platforms=lg.PLATFORMS)
    return out


@router.get("/onboard/cases", summary="开店进度：审核人看全部，员工看自己的")
def onboard_cases(all: bool = Query(False), closed: bool = Query(False), db: Session = Depends(get_db),
                  user: Staff = Depends(get_current_user)):
    mine = not (all and lo.is_reviewer(db, user))
    return {"items": lo.list_cases(db, assignee_id=user.id if mine else None, include_closed=closed)}


@router.get("/onboard/cases/{cid}", summary="一份开店进度：每一步的状态、材料、历次审核意见")
def onboard_case(cid: str, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    return lo.get_case(db, user, cid)


class DispatchIn(BaseModel):
    kind: str
    assignee_id: str
    entity_id: str | None = None
    alipay_id: str | None = None
    target_id: str | None = None
    platform: str | None = None
    role: str | None = None
    channel: str | None = None
    due_on: str | None = None
    title: str | None = Field(default=None, max_length=128)
    note: str | None = Field(default=None, max_length=2000)


@router.post("/onboard/cases", summary="派开店单（没有已发布教程的平台派不了）")
def onboard_dispatch(body: DispatchIn, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    c = lo.dispatch(db, user, body.model_dump())
    db.commit()
    return {"id": c.id}


class CaseEditIn(BaseModel):
    model_config = {"extra": "allow"}


@router.patch("/onboard/cases/{cid}", summary="改派、改截止日、撤销")
def onboard_case_edit(cid: str, body: CaseEditIn, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    data = {k: v for k, v in body.model_dump().items() if k in ("assignee_id", "due_on", "note", "cancel")}
    lo.update_case(db, user, cid, data)
    db.commit()
    return {"ok": True}


class StepIn(BaseModel):
    materials: dict = Field(default_factory=dict)
    confirmed: bool = False


@router.post("/onboard/cases/{cid}/steps/{code}/submit", summary="交这一步的材料")
def onboard_submit(cid: str, code: str, body: StepIn, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    r = lo.submit_step(db, user, cid, code, body.materials, body.confirmed)
    db.commit()
    return {"status": r.status, "version_no": r.version_no}


class VerdictIn(BaseModel):
    approve: bool
    note: str | None = Field(default=None, max_length=2000)


@router.post("/onboard/cases/{cid}/steps/{code}/review", summary="审核人：通过 / 打回")
def onboard_review(cid: str, code: str, body: VerdictIn, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    r = lo.review_step(db, user, cid, code, body.approve, body.note)
    db.commit()
    return {"status": r.status}


class SkipIn(BaseModel):
    reason: str = Field(max_length=2000)


@router.post("/onboard/cases/{cid}/steps/{code}/skip", summary="申请跳过这一步（老板批）")
def onboard_skip(cid: str, code: str, body: SkipIn, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    s = lo.request_skip(db, user, cid, code, body.reason)
    db.commit()
    return {"id": s.id}


class LockInIn(BaseModel):
    login_name: str | None = Field(default=None, max_length=128)
    password: str | None = Field(default=None, max_length=256)
    secondary: str | None = Field(default=None, max_length=256)
    totp: str | None = Field(default=None, max_length=128)


@router.post("/onboard/cases/{cid}/steps/{code}/lock-in", summary="交新设的密码：锁进密码库，交完自己也看不到")
def onboard_lock_in(cid: str, code: str, body: LockInIn, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    lo.lock_in(db, user, cid, code, body.model_dump())
    db.commit()
    return {"ok": True}


@router.get("/onboard/reviews", summary="等审核的步骤")
def onboard_reviews(db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    lo.require_reviewer(db, user)
    return {"items": lo.pending_reviews(db)}


@router.get("/onboard/skips", summary="等老板批的跳步申请")
def onboard_skips(db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    return {"items": lo.pending_skips(db)}


@router.post("/onboard/skips/{sid}", summary="老板批跳步")
def onboard_skip_verdict(sid: str, body: VerdictIn, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    lo.decide_skip(db, user, sid, body.approve, body.note)
    db.commit()
    return {"ok": True}


@router.get("/onboard/tutorials", summary="教程清单（各版本）")
def onboard_tutorials(db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    lo.require_reviewer(db, user)
    items = lo.list_tutorials(db)
    db.commit()
    return {"items": items, "kinds": lo.TUTORIAL_KINDS, "platforms": lg.PLATFORMS, "material_kinds": lo.MATERIAL_KINDS,
            "lockin_categories": {k: lv.CATEGORIES[k] for k in lo.LOCKIN_CATEGORIES}}


@router.get("/onboard/tutorials/{tid}", summary="一份教程的整棵树")
def onboard_tutorial(tid: str, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    from app.models import LedgerTutorial

    lo.require_reviewer(db, user)
    t = db.get(LedgerTutorial, tid)
    if t is None:
        raise HTTPException(status_code=404, detail="没有这份教程")
    return lo.tutorial_out(db, t, full=True)


class TutorialIn(BaseModel):
    kind: str | None = None
    platform: str | None = None
    code: str | None = None
    title: str | None = Field(default=None, max_length=128)
    summary: str | None = Field(default=None, max_length=2000)
    body: list | None = None


def _tut_data(body: TutorialIn) -> dict:
    return {k: v for k, v in body.model_dump().items() if v is not None}


@router.post("/onboard/tutorials", summary="新写一份教程（草稿）")
def onboard_tutorial_new(body: TutorialIn, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    t = lo.save_tutorial(db, user, _tut_data(body), None)
    db.commit()
    return {"id": t.id}


@router.put("/onboard/tutorials/{tid}", summary="改教程：已发布的会另存成新版本草稿")
def onboard_tutorial_save(tid: str, body: TutorialIn, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    t = lo.save_tutorial(db, user, _tut_data(body), tid)
    db.commit()
    return {"id": t.id, "version": t.version}


@router.post("/onboard/tutorials/{tid}/submit", summary="提交老板发布")
def onboard_tutorial_submit(tid: str, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    lo.submit_tutorial(db, user, tid)
    db.commit()
    return {"ok": True}


@router.post("/onboard/tutorials/{tid}/verdict", summary="老板：发布 / 退回")
def onboard_tutorial_verdict(tid: str, body: VerdictIn, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    lo.verdict_tutorial(db, user, tid, body.approve, body.note)
    db.commit()
    return {"ok": True}


class TargetIn(BaseModel):
    targets: dict = Field(default_factory=dict)
    note: str | None = Field(default=None, max_length=2000)


@router.put("/onboard/targets/{lp_id}", summary="老板：调整某委托客户的托管目标配额")
def onboard_target(lp_id: str, body: TargetIn, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    lo.set_target(db, user, lp_id, body.model_dump())
    db.commit()
    return {"ok": True}


@router.get("/onboard/dispatch-options", summary="派单下拉：主体、收款号、店铺、员工")
def onboard_dispatch_options(db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    from app.models import LedgerAlipay, LedgerEntity, LedgerShop

    lo.require_reviewer(db, user)
    lps = {p.id: p.name for p in db.query(LedgerLegalPerson).all()}
    ents = db.query(LedgerEntity).filter(LedgerEntity.status != "closed").order_by(LedgerEntity.name).all()
    en = {e.id: e.name for e in ents}
    alis = db.query(LedgerAlipay).filter(LedgerAlipay.status != "closed").order_by(LedgerAlipay.account).all()
    shops = db.query(LedgerShop).filter(LedgerShop.status != "closed").order_by(LedgerShop.name).all()
    staff = db.query(Staff).filter(Staff.deleted_at.is_(None), Staff.status == StaffStatus.ACTIVE).order_by(Staff.name).all()
    return {
        "entities": [{"id": e.id, "name": e.name, "legal_person_id": e.legal_person_id,
                      "legal_person_name": lps.get(e.legal_person_id)} for e in ents],
        "alipays": [{"id": a.id, "account": a.account, "role": a.role, "entity_id": a.entity_id, "entity_name": en.get(a.entity_id),
                     "status": a.status} for a in alis],
        "shops": [{"id": s.id, "name": s.name, "platform": s.platform, "entity_id": s.entity_id, "status": s.status}
                  for s in shops],
        "staff": [{"id": s.id, "name": s.name or s.username} for s in staff],
        "platforms": lg.PLATFORMS,
    }


@router.get("/onboard/reviewers", summary="审核人（主管）名单")
def onboard_reviewers(db: Session = Depends(get_db), _: Staff = Depends(_admin)):
    ids = lo.reviewer_ids(db)
    names = {s.id: s.name or s.username for s in db.query(Staff).filter(Staff.id.in_(ids)).all()} if ids else {}
    return {"items": [{"id": i, "name": names.get(i, "（已删除）")} for i in ids]}


class ReviewersIn(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=50)


@router.put("/onboard/reviewers", summary="改审核人名单")
def onboard_reviewers_set(body: ReviewersIn, db: Session = Depends(get_db), user: Staff = Depends(_admin)):
    lo.set_reviewers(db, user, body.ids)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- 第五步：密码库

def _ip(request: Request) -> str | None:
    return (request.headers.get("x-real-ip") or (request.client.host if request.client else None) or "")[:64] or None


@router.get("/vault/state", summary="密码库：配好没有、我是不是主人、绑没绑验证器")
def vault_state(db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    return lv.factor_state(db, user) | {"categories": lv.CATEGORIES}


@router.post("/vault/bind/start", summary="主人：生成验证器二维码")
def vault_bind_start(db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    out = lv.bind_start(db, user)
    db.commit()
    return out


class BindIn(BaseModel):
    code: str = Field(max_length=6)
    current_code: str | None = Field(default=None, max_length=6)


@router.post("/vault/bind/confirm", summary="主人：输入新验证器的码完成绑定（换绑要再输旧的码）")
def vault_bind_confirm(body: BindIn, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    lv.bind_confirm(db, user, body.code, body.current_code)
    db.commit()
    return {"ok": True}


class CodeIn(BaseModel):
    code: str = Field(max_length=6)


@router.post("/vault/unlock", summary="主人：输 6 位码解锁 15 分钟")
def vault_unlock(body: CodeIn, request: Request, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    out = lv.unlock(db, user, body.code, _ip(request))
    db.commit()
    return out


@router.post("/vault/lock", summary="立即上锁")
def vault_lock(x_vault_token: str | None = Header(None), db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    lv.lock(db, user, x_vault_token)
    db.commit()
    return {"ok": True}


@router.get("/vault/items", summary="密码库清单（不带任何密码）")
def vault_items(q: str | None = Query(None), db: Session = Depends(get_db), _: Staff = Depends(_admin)):
    return {"items": lv.list_items(db, q=q)}


class VaultIn(BaseModel):
    model_config = {"extra": "allow"}


def _vault_data(body: VaultIn) -> dict:
    keys = set(lv.FIELDS) | {"password", "secondary", "totp"}
    return {k: v for k, v in body.model_dump().items() if k in keys}


@router.post("/vault/items", summary="主人（已解锁）：新建一条")
def vault_create(body: VaultIn, x_vault_token: str | None = Header(None), db: Session = Depends(get_db),
                 user: Staff = Depends(get_current_user)):
    lv._session(db, user, x_vault_token)
    v = lv.save(db, user, _vault_data(body))
    db.commit()
    return {"id": v.id}


@router.patch("/vault/items/{vid}", summary="主人（已解锁）：改一条；密码那几项不传就不动，传空串就清掉")
def vault_update(vid: str, body: VaultIn, x_vault_token: str | None = Header(None), db: Session = Depends(get_db),
                 user: Staff = Depends(get_current_user)):
    lv._session(db, user, x_vault_token)
    lv.save(db, user, _vault_data(body), vid)
    db.commit()
    return {"ok": True}


@router.delete("/vault/items/{vid}", summary="主人（已解锁）：删一条")
def vault_delete(vid: str, x_vault_token: str | None = Header(None), db: Session = Depends(get_db),
                 user: Staff = Depends(get_current_user)):
    lv.delete(db, user, vid, x_vault_token)
    db.commit()
    return {"ok": True}


class RevealIn(BaseModel):
    field: str


@router.post("/vault/items/{vid}/reveal", summary="主人（已解锁）：看一条的一项明文；别人一律 403")
def vault_reveal(vid: str, body: RevealIn, x_vault_token: str | None = Header(None), db: Session = Depends(get_db),
                 user: Staff = Depends(get_current_user)):
    out = lv.reveal(db, user, vid, x_vault_token, body.field)
    db.commit()
    return out


@router.post("/vault/items/{vid}/code", summary="领 6 位动态码：员工只能领给自己用、开了领码的；种子不出去")
def vault_code(vid: str, x_vault_token: str | None = Header(None), db: Session = Depends(get_db),
               user: Staff = Depends(get_current_user)):
    out = lv.code_for(db, user, vid, x_vault_token)
    db.commit()
    return out


@router.get("/vault/mine", summary="给我用的账号（不带密码）")
def vault_mine(db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    items = lv.list_items(db, assignee_id=user.id)
    keep = ("id", "category_label", "title", "login_name", "employee_totp", "has_totp", "device_name", "target_label")
    return {"items": [{k: i[k] for k in keep} for i in items]}


@router.get("/vault/targets", summary="密码挂在台账哪一条：支付宝、店铺、设备、其他台账")
def vault_targets(q: str | None = Query(None), db: Session = Depends(get_db), _: Staff = Depends(_admin)):
    from app.models import LedgerEntity, LedgerProxy, LedgerSim

    like = f"%{(q or '').strip()}%"
    out = [{"type": "entity", "id": e.id, "label": f"主体 {e.name}"}
           for e in db.query(LedgerEntity).filter(LedgerEntity.name.like(like)).limit(20)]
    out += [{"type": "proxy", "id": p.id, "label": f"代理 {p.code}"}
            for p in db.query(LedgerProxy).filter(LedgerProxy.code.like(like)).limit(20)]
    out += [{"type": "sim", "id": c.id, "label": f"手机卡 {c.phone}"}
            for c in db.query(LedgerSim).filter(LedgerSim.phone.like(like)).limit(20)]
    return {"items": lr.targets(db, q) + out}


# ---------------------------------------------------------------- 密码库填进 AdsPower（工位上的巡航台来领，按电脑公钥加密）

class StationIn(BaseModel):
    station_id: str = Field(max_length=64)
    name: str | None = Field(default=None, max_length=64)
    public_key: str = Field(max_length=64)


@router.post("/vault/stations", summary="巡航台：登记这台电脑的公钥（新的、换了的都要主人批准）")
def vault_station_register(body: StationIn, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    from app.services import ledger_vault_ads as la

    s = la.register(db, user, body.station_id, body.name, body.public_key)
    db.commit()
    return la.station_state(db, s.id)


@router.get("/vault/stations/{sid}/state", summary="巡航台：这台电脑批准了没有")
def vault_station_state(sid: str, db: Session = Depends(get_db), _: Staff = Depends(get_current_user)):
    from app.services import ledger_vault_ads as la

    return la.station_state(db, sid)


@router.get("/vault/stations", summary="能填密码的工位")
def vault_stations(db: Session = Depends(get_db), _: Staff = Depends(_admin)):
    from app.services import ledger_vault_ads as la

    return {"items": la.list_stations(db)}


class StationDecideIn(BaseModel):
    trust: bool


@router.post("/vault/stations/{sid}/decide", summary="主人（已解锁）：批准 / 停用一台工位")
def vault_station_decide(sid: str, body: StationDecideIn, x_vault_token: str | None = Header(None),
                         db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    from app.services import ledger_vault_ads as la

    la.decide_station(db, user, x_vault_token, sid, body.trust)
    db.commit()
    return {"ok": True}


@router.post("/vault/items/{vid}/ads-sync", summary="主人（已解锁）：现在填进 AdsPower（填失败了重填）")
def vault_ads_sync(vid: str, x_vault_token: str | None = Header(None), db: Session = Depends(get_db),
                   user: Staff = Depends(get_current_user)):
    from app.models import LedgerVault
    from app.services import ledger_vault_ads as la

    lv._session(db, user, x_vault_token)
    v = db.get(LedgerVault, vid)
    if v is None:
        raise HTTPException(status_code=404, detail="没有这一条")
    if not la.request(db, user, v, "主人点了填进 AdsPower"):
        raise HTTPException(status_code=400, detail="先挂一个有环境编号的 AdsPower 环境，并且至少存了密码或种子")
    db.commit()
    return {"ok": True}


class PollIn(BaseModel):
    station_id: str = Field(max_length=64)
    ads_user_ids: list[str] = Field(default_factory=list, max_length=2000)


@router.post("/vault/ads/poll", summary="巡航台：本机有这些环境，领要填的（只有批准过的电脑领得到，内容按它的公钥加密）")
def vault_ads_poll(body: PollIn, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    from app.services import ledger_vault_ads as la

    items = la.poll(db, user, body.station_id, body.ads_user_ids)
    db.commit()
    return {"items": items}


class AdsResultIn(BaseModel):
    station_id: str = Field(max_length=64)
    item_id: str = Field(max_length=36)
    ack: str = Field(max_length=64)
    ok: bool
    verified: bool = False
    error: str | None = Field(default=None, max_length=255)


@router.post("/vault/ads/result", summary="巡航台：填好了没有（带上加密包里的回执）")
def vault_ads_result(body: AdsResultIn, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    from app.services import ledger_vault_ads as la

    v = la.result(db, user, body.station_id, body.item_id, body.ack, body.ok, body.verified, body.error)
    db.commit()
    return {"status": v.ads_status}

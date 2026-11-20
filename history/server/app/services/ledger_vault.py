"""密码库（第五步，11-17 老板推翻「密码不存」后做的，V2 交付包 04 号方案）。

怎么存：
  - 信封加密：每条一把随机 32 字节数据密钥（DEK），用它 AES-256-GCM 加密 {password, secondary, totp} 这一包，
    DEK 再用主密钥（环境变量 LEDGER_VAULT_KEK，64 位十六进制）加密；两层都把「条目 id|分类」当附加数据，
    密文挪到别的条目上解不开。主密钥不进库、不进 git，没配就存不了、也看不了；
  - 列表接口从不带密文，只带 has_password / has_secondary / has_totp。

谁能看：
  - 明文只有「密码库主人」能看（LEDGER_VAULT_OWNERS 里的工号，改 .env 重启才变——不做成页面上能改，
    不然随便哪个管理员把自己加进去就能看全部密码）；
  - 主人先在页面上扫码绑手机验证器（iPhone 自带「密码」App、Google / Microsoft Authenticator 都行），
    以后每次输 6 位码解锁 15 分钟，一次只解开点的那一条；同一个码不能用两次，连错 5 次锁 15 分钟；
  - 员工：只能领「给他用、并且开了员工领码」那几条的 6 位动态码（服务器算好给他，种子不出去），
    在开店步骤里新设的密码交上来就锁进库里，交完自己也看不到；
  - 每次解锁、解锁失败、看、改、删、领码、交密码都记进 ledger_access_log（target_type=vault）。

填进 AdsPower（V2 的 fakey 同步）：不走群控，走工位上的巡航台，按电脑公钥加密，见 services/ledger_vault_ads.py。
条目挂了环境（device_id），改了密码 / 种子或换了环境就自动变成「等填」。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import struct
import time
from datetime import datetime, timedelta

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.config import settings
from app.models import (
    LedgerAlipay,
    LedgerDevice,
    LedgerEntity,
    LedgerProxy,
    LedgerRecord,
    LedgerShop,
    LedgerSim,
    LedgerVault,
    LedgerVaultFactor,
    LedgerVaultSession,
    Staff,
)
from app.services import ledger as lg

CATEGORIES = {
    "gov_tax": "税务 / 工商", "alipay": "支付宝", "platform": "平台账号", "network_ads": "代理 / AdsPower",
    "device_sim": "手机 / 卡", "other": "其他",
}
TARGETS = {"alipay": LedgerAlipay, "shop": LedgerShop, "entity": LedgerEntity, "device": LedgerDevice,
           "proxy": LedgerProxy, "sim": LedgerSim, "record": LedgerRecord}
SESSION_MINUTES = 15
MAX_FAILS = 5
LOCK_MINUTES = 15
ISSUER = "泛亚台账"


def _bad(msg: str, code: int = 400):
    raise HTTPException(status_code=code, detail=msg)


# ---------------------------------------------------------------- 加解密

def _kek() -> bytes:
    raw = (settings.ledger_vault_kek or "").strip()
    try:
        key = bytes.fromhex(raw)
    except ValueError:
        key = b""
    if len(key) != 32:
        _bad("密码库还没配主密钥（服务器 .env 的 LEDGER_VAULT_KEK，64 位十六进制），现在存不了也看不了", 503)
    return key


def ready() -> bool:
    try:
        _kek()
        return True
    except HTTPException:
        return False


def seal(item_id: str, category: str, payload: dict) -> str:
    aad = f"{item_id}|{category}".encode()
    dek = AESGCM.generate_key(bit_length=256)
    n1, n2 = os.urandom(12), os.urandom(12)
    body = AESGCM(dek).encrypt(n1, json.dumps(payload, ensure_ascii=False).encode(), aad)
    wrapped = AESGCM(_kek()).encrypt(n2, dek, aad)
    return json.dumps({"v": 1, "dek": base64.b64encode(n2 + wrapped).decode(), "data": base64.b64encode(n1 + body).decode()})


def unseal(item_id: str, category: str, blob: str | None) -> dict:
    if not blob:
        return {}
    aad = f"{item_id}|{category}".encode()
    d = json.loads(blob)
    w = base64.b64decode(d["dek"])
    dek = AESGCM(_kek()).decrypt(w[:12], w[12:], aad)
    b = base64.b64decode(d["data"])
    return json.loads(AESGCM(dek).decrypt(b[:12], b[12:], aad))


def _seal_text(purpose: str, text: str) -> str:
    """验证器种子这种单个值：同样用主密钥，附加数据是用途 + 人。"""
    n = os.urandom(12)
    return base64.b64encode(n + AESGCM(_kek()).encrypt(n, text.encode(), purpose.encode())).decode()


def _unseal_text(purpose: str, blob: str) -> str:
    b = base64.b64decode(blob)
    return AESGCM(_kek()).decrypt(b[:12], b[12:], purpose.encode()).decode()


# ---------------------------------------------------------------- TOTP（RFC 6238，30 秒、6 位、SHA1）

def norm_secret(s: str) -> str:
    s = "".join(s.split()).upper().rstrip("=")
    try:
        base64.b32decode(s + "=" * (-len(s) % 8))
    except Exception:  # noqa: BLE001
        _bad("二次验证种子不对：应该是一串 A-Z 和 2-7 组成的 Base32")
    if len(s) < 16:
        _bad("二次验证种子太短，至少 16 位")
    return s


def totp_at(secret_b32: str, step: int) -> str:
    key = base64.b32decode(secret_b32 + "=" * (-len(secret_b32) % 8))
    h = hmac.new(key, struct.pack(">Q", step), hashlib.sha1).digest()
    o = h[-1] & 0x0F
    return f"{(struct.unpack('>I', h[o:o + 4])[0] & 0x7FFFFFFF) % 1000000:06d}"


def totp_now(secret_b32: str, now: float | None = None) -> tuple[str, int]:
    t = time.time() if now is None else now
    return totp_at(secret_b32, int(t // 30)), 30 - int(t) % 30


def totp_match(secret_b32: str, code: str, now: float | None = None) -> int | None:
    """前后各放一个 30 秒（手机时间差一点也能过），对上了返回是第几个 30 秒。"""
    code = (code or "").strip()
    if len(code) != 6 or not code.isdigit():
        return None
    step = int((time.time() if now is None else now) // 30)
    for s in (step - 1, step, step + 1):
        if hmac.compare_digest(totp_at(secret_b32, s), code):
            return s
    return None


# ---------------------------------------------------------------- 主人、绑验证器、解锁

def owner_nos() -> set[str]:
    return {x.strip() for x in (settings.ledger_vault_owners or "").replace("，", ",").split(",") if x.strip()}


def is_owner(user: Staff) -> bool:
    return bool(user.staff_no) and user.staff_no in owner_nos()


def _require_owner(user: Staff):
    if not is_owner(user):
        _bad("只有密码库主人能看明文（服务器 .env 的 LEDGER_VAULT_OWNERS）", 403)


def bind_start(db: Session, user: Staff) -> dict:
    """生成一个新种子给主人扫。已经绑过的要先输对现在的码才能换（见 bind_confirm 的 current_code）。"""
    _require_owner(user)
    f = db.get(LedgerVaultFactor, user.id) or LedgerVaultFactor(staff_id=user.id)
    secret = base64.b32encode(os.urandom(20)).decode().rstrip("=")
    f.pending_enc = _seal_text(f"factor|{user.id}", secret)
    db.add(f)
    db.flush()
    label = f"{ISSUER}:{user.name or user.username}"
    from urllib.parse import quote

    uri = f"otpauth://totp/{quote(label)}?secret={secret}&issuer={quote(ISSUER)}&algorithm=SHA1&digits=6&period=30"
    return {"uri": uri, "secret": secret, "rebinding": bool(f.totp_enc)}


def _check_lock(f: LedgerVaultFactor):
    if f.locked_until and f.locked_until > datetime.utcnow():
        left = int((f.locked_until - datetime.utcnow()).total_seconds() // 60) + 1
        _bad(f"连错 {MAX_FAILS} 次，锁住了，{left} 分钟后再试", 429)


def _fail(db: Session, user: Staff, f: LedgerVaultFactor, what: str):
    f.fails = (f.fails or 0) + 1
    if f.fails >= MAX_FAILS:
        f.locked_until = datetime.utcnow() + timedelta(minutes=LOCK_MINUTES)
        f.fails = 0
    lg.log(db, user, "unlock_fail", "vault", None, what)
    db.commit()  # 失败次数和留痕要落下来，后面的异常会让调用方回滚
    _bad("验证码不对（或者这个码刚用过，等下一个）")


def bind_confirm(db: Session, user: Staff, code: str, current_code: str | None = None) -> None:
    _require_owner(user)
    f = db.get(LedgerVaultFactor, user.id)
    if f is None or not f.pending_enc:
        _bad("先点「绑定手机验证器」扫码")
    _check_lock(f)
    if f.totp_enc:
        old = _unseal_text(f"factor|{user.id}", f.totp_enc)
        step = totp_match(old, current_code or "")
        if step is None or step <= f.last_step:
            _fail(db, user, f, "换绑时旧验证器的码不对")
    new = _unseal_text(f"factor|{user.id}", f.pending_enc)
    step = totp_match(new, code)
    if step is None:
        _fail(db, user, f, "绑定时新验证器的码不对")
    f.totp_enc, f.pending_enc, f.last_step, f.fails, f.locked_until = f.pending_enc, None, step, 0, None
    lg.log(db, user, "bind", "vault", None, "绑定手机验证器")


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def unlock(db: Session, user: Staff, code: str, ip: str | None) -> dict:
    _require_owner(user)
    f = db.get(LedgerVaultFactor, user.id)
    if f is None or not f.totp_enc:
        _bad("还没绑手机验证器，先绑定")
    _check_lock(f)
    secret = _unseal_text(f"factor|{user.id}", f.totp_enc)
    step = totp_match(secret, code)
    if step is None or step <= (f.last_step or 0):
        _fail(db, user, f, "解锁验证码不对")
    f.last_step, f.fails, f.locked_until = step, 0, None
    token = secrets.token_urlsafe(32)
    exp = datetime.utcnow() + timedelta(minutes=SESSION_MINUTES)
    db.add(LedgerVaultSession(token_hash=_hash(token), staff_id=user.id, ip=ip, expires_at=exp))
    lg.log(db, user, "unlock", "vault", None, f"解锁 {SESSION_MINUTES} 分钟")
    return {"token": token, "seconds": SESSION_MINUTES * 60}


def lock(db: Session, user: Staff, token: str | None) -> None:
    if token:
        s = db.get(LedgerVaultSession, _hash(token))
        if s is not None and s.staff_id == user.id and s.revoked_at is None:
            s.revoked_at = datetime.utcnow()
            lg.log(db, user, "lock", "vault", None, "立即上锁")


def _session(db: Session, user: Staff, token: str | None) -> LedgerVaultSession:
    _require_owner(user)
    s = db.get(LedgerVaultSession, _hash(token)) if token else None
    if s is None or s.staff_id != user.id or s.revoked_at is not None or s.expires_at <= datetime.utcnow():
        _bad("密码库已上锁，先输验证码解锁", 401)
    return s


def factor_state(db: Session, user: Staff) -> dict:
    f = db.get(LedgerVaultFactor, user.id) if is_owner(user) else None
    return {"ready": ready(), "is_owner": is_owner(user), "owners_set": bool(owner_nos()),
            "bound": bool(f and f.totp_enc), "session_minutes": SESSION_MINUTES}


# ---------------------------------------------------------------- 条目

FIELDS = ("category", "title", "target_type", "target_id", "login_name", "assignee_id", "employee_totp", "device_id", "ads_domain",
          "note")


def _target_label(db: Session, t: str | None, tid: str | None) -> str | None:
    if not t or not tid or t not in TARGETS:
        return None
    row = db.get(TARGETS[t], tid)
    if row is None:
        return None
    return getattr(row, "name", None) or getattr(row, "account", None) or getattr(row, "phone", None) \
        or getattr(row, "code", None)


def out(db: Session, v: LedgerVault, names: dict[str, str] | None = None) -> dict:
    names = names if names is not None else {}
    dev = db.get(LedgerDevice, v.device_id) if v.device_id else None
    return {
        "id": v.id, "category": v.category, "category_label": CATEGORIES.get(v.category, v.category), "title": v.title,
        "target_type": v.target_type, "target_id": v.target_id, "target_label": _target_label(db, v.target_type, v.target_id),
        "login_name": v.login_name, "has_password": v.has_password, "has_secondary": v.has_secondary, "has_totp": v.has_totp,
        "assignee_id": v.assignee_id, "assignee_name": names.get(v.assignee_id or ""), "employee_totp": v.employee_totp,
        "device_id": v.device_id, "device_name": dev.name if dev else None, "ads_user_id": dev.ads_user_id if dev else None,
        "rotated_at": lg_cn(v.rotated_at), "updated_at": lg_cn(v.updated_at), "note": v.note,
        "ads_domain": v.ads_domain, "ads_status": v.ads_status, "ads_synced_at": lg_cn(v.ads_synced_at), "ads_error": v.ads_error,
    }


def lg_cn(dt: datetime | None) -> str | None:
    return (dt + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M") if dt else None


def _names(db: Session, ids) -> dict[str, str]:
    ids = {i for i in ids if i}
    return {s.id: s.name or s.username for s in db.query(Staff).filter(Staff.id.in_(ids)).all()} if ids else {}


def list_items(db: Session, *, q: str | None = None, assignee_id: str | None = None) -> list[dict]:
    query = db.query(LedgerVault)
    if assignee_id:
        query = query.filter(LedgerVault.assignee_id == assignee_id)
    rows = query.order_by(LedgerVault.category, LedgerVault.title).all()
    if q:
        k = q.strip().lower()
        rows = [r for r in rows if k in (r.title or "").lower() or k in (r.login_name or "").lower()]
    names = _names(db, [r.assignee_id for r in rows])
    return [out(db, r, names) for r in rows]


def _apply(db: Session, v: LedgerVault, data: dict):
    for k in FIELDS:
        if k in data:
            val = data[k]
            if isinstance(val, str):
                val = val.strip() or None
            setattr(v, k, val)
    v.employee_totp = bool(v.employee_totp)
    if v.category not in CATEGORIES:
        _bad("分类不对")
    if not v.title:
        _bad("名称不能为空")
    if v.target_type or v.target_id:
        if v.target_type not in TARGETS or not v.target_id or db.get(TARGETS[v.target_type], v.target_id) is None:
            _bad("挂的台账条目不存在")
    if v.assignee_id and db.get(Staff, v.assignee_id) is None:
        _bad("给谁用：没有这个员工")
    if v.device_id:
        d = db.get(LedgerDevice, v.device_id)
        if d is None or d.kind != "env":
            _bad("只能填进 AdsPower 环境")


def _secret_update(v: LedgerVault, old: dict, data: dict) -> tuple[dict, list[str]]:
    """data 里出现 password / secondary / totp 才改那一项；给空串 = 清掉。返回新的包和改了哪几项。"""
    new, changed = dict(old), []
    for k, label in (("password", "登录密码"), ("secondary", "二级 / 支付密码"), ("totp", "二次验证种子")):
        if k not in data or data[k] is None:
            continue
        val = data[k].strip() if isinstance(data[k], str) else data[k]
        if k == "totp" and val:
            val = norm_secret(val)
        if val:
            new[k] = val
        else:
            new.pop(k, None)
        if new.get(k) != old.get(k):
            changed.append(label)
    return new, changed


def save(db: Session, user: Staff, data: dict, item_id: str | None = None) -> LedgerVault:
    _kek()
    if item_id:
        v = db.get(LedgerVault, item_id)
        if v is None:
            _bad("没有这一条", 404)
        old_cat = v.category
    else:
        v = LedgerVault(id=lg_new_id(), created_by_id=user.id)
        old_cat = None
    old = unseal(v.id, old_cat, v.secret) if v.secret else {}
    old_device, old_login = v.device_id, v.login_name
    _apply(db, v, data)
    payload, changed = _secret_update(v, old, data)
    if v.secret is None or changed or old_cat != v.category:
        v.secret = seal(v.id, v.category, payload)
    v.has_password, v.has_secondary, v.has_totp = bool(payload.get("password")), bool(payload.get("secondary")), \
        bool(payload.get("totp"))
    if "登录密码" in changed or "二级 / 支付密码" in changed:
        v.rotated_at = datetime.utcnow()
    if v.employee_totp and not v.has_totp:
        _bad("开员工领码要先存二次验证种子")
    db.add(v)
    db.flush()
    from app.services import ledger_vault_ads as la

    la.guess_device(db, v)
    if not v.device_id:
        v.ads_status = "none"
    elif changed or v.device_id != old_device or v.login_name != old_login or v.ads_status == "none":
        la.request(db, user, v, "新存" if old_cat is None else "改了密码或环境")
    what = "新建" if old_cat is None else "修改"
    lg.log(db, user, "create" if old_cat is None else "update", "vault", v.id,
           f"{what}「{v.title}」" + (f"，改了{'、'.join(changed)}" if changed else ""))
    return v


def lg_new_id() -> str:
    from app.models.staff import new_uuid

    return new_uuid()


def delete(db: Session, user: Staff, item_id: str, token: str | None):
    """删要先解锁（删了找不回来）。"""
    _session(db, user, token)
    v = db.get(LedgerVault, item_id)
    if v is None:
        _bad("没有这一条", 404)
    lg.log(db, user, "delete", "vault", v.id, f"删除「{v.title}」")
    db.delete(v)


def reveal(db: Session, user: Staff, item_id: str, token: str | None, field: str) -> dict:
    """一次只解一条的一项。不是主人一律 403（并记一笔）。"""
    if not is_owner(user):
        lg.log(db, user, "deny", "vault", item_id, "非密码库主人想看明文，已拦下")
        db.commit()
        _bad("只有密码库主人能看明文", 403)
    _session(db, user, token)
    v = db.get(LedgerVault, item_id)
    if v is None:
        _bad("没有这一条", 404)
    if field not in ("password", "secondary", "totp"):
        _bad("要看哪一项不对")
    data = unseal(v.id, v.category, v.secret)
    lg.log(db, user, "reveal", "vault", v.id, f"看了「{v.title}」的{ {'password': 'DEMO_ONLY_REDACTED', 'secondary': '二级 / 支付密码', 'totp': '二次验证种子'}[field]}")
    return {"value": data.get(field)}


def code_for(db: Session, user: Staff, item_id: str, token: str | None = None) -> dict:
    """6 位动态码。员工：只有给他用、并且开了员工领码的；主人：解锁时哪条都行。种子从不出去。"""
    v = db.get(LedgerVault, item_id)
    if v is None:
        _bad("没有这一条", 404)
    if is_owner(user) and token:
        _session(db, user, token)
    elif not (v.assignee_id == user.id and v.employee_totp):
        lg.log(db, user, "deny", "vault", v.id, "领不属于自己的动态码，已拦下")
        db.commit()
        _bad("这个账号的动态码不归你领", 403)
    secret = unseal(v.id, v.category, v.secret).get("totp")
    if not secret:
        _bad("这一条没存二次验证种子")
    code, left = totp_now(secret)
    lg.log(db, user, "code", "vault", v.id, f"领了「{v.title}」的动态码")
    return {"code": code, "seconds_left": left}


def lock_in(db: Session, user: Staff, *, title: str, category: str, target_type: str | None, target_id: str | None,
            login_name: str | None, password: str | None, secondary: str | None, totp: str | None,
            source: str) -> LedgerVault:
    """开店时员工新设的密码交上来：同一个台账条目已经有一条就更新那条，没有就新建；给他用，交完他也看不到。"""
    if not (password or secondary or totp):
        _bad("至少填一项：登录密码、二级 / 支付密码、二次验证种子")
    v = None
    if target_type and target_id:
        v = db.query(LedgerVault).filter(LedgerVault.target_type == target_type, LedgerVault.target_id == target_id,
                                         LedgerVault.category == category).first()
    data = {"password": password, "secondary": secondary, "totp": totp}
    if v is None:
        data.update(category=category, title=title, target_type=target_type, target_id=target_id,
                    login_name=login_name, assignee_id=user.id, employee_totp=bool(totp))
    elif login_name:
        data["login_name"] = login_name
    v = save(db, user, data, v.id if v else None)
    lg.log(db, user, "lockin", "vault", v.id, f"{source}：交了新设的密码")
    return v

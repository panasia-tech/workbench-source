"""密码库填进 AdsPower（11-17 用户要做，V2 交付包的 fakey 同步）。

不走群控：群控的任务内容明文存在 gc.db、操作留痕还记输入的前 40 个字。走的是工位上的巡航台：
  1. 巡航台第一次用时在本机生成一对 X25519 密钥，私钥用系统加密（Windows DPAPI）存本机，公钥连同电脑 id
     （workbench_device.id）交上来，状态「等批准」；
  2. 密码库主人解锁后在「密码库」页对着指纹批准（巡航台上显示同一串指纹）；换了公钥要重新批准；
  3. 条目挂了 AdsPower 环境、存了密码 / 种子，主人点「填进 AdsPower」（或改了密码、员工在开店步骤交了新密码）
     就变成「等填」；
  4. 批准过的工位定时来问「我这台 AdsPower 上有这些环境，有要填的吗」：服务器把那条的登录名、密码、种子、网站
     用这台电脑的公钥加密（临时 X25519 + HKDF-SHA256 + AES-256-GCM，附加数据绑了条目 id 和电脑 id），
     一次领 5 分钟；只有这台电脑解得开，nginx、日志、抓包看到的都只是密文；
  5. 巡航台调本机 AdsPower 写进去，再读回来核对，把加密包里的回执（ack）交回来；回执对得上才记「已填好」。
     库里只存回执的哈希，没解开密文的人编不出回执。

同一个 AdsPower 团队的环境在哪台电脑上写都一样（云端同步），所以哪台批准过的工位领到都行。
每次发出去、填好、填失败都记 ledger_access_log（target_type=vault）。
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
from datetime import datetime, timedelta

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models import LedgerDevice, LedgerShop, LedgerVault, LedgerVaultStation, Staff, WorkbenchDevice
from app.services import ledger as lg
from app.services import ledger_vault as lv

HKDF_INFO = b"panasia-vault-ads-v1"
CLAIM_MINUTES = 5
BATCH = 5
STATION_STATES = {"pending": "等批准", "trusted": "已批准", "revoked": "已停用"}
ADS_STATES = {"none": "不填", "pending": "等工位来填", "synced": "已填好", "error": "填失败"}
# AdsPower 自动填按网站匹配；条目没写就按挂的台账条目猜
DOMAINS = {
    "xianyu": "goofish.com", "taobao": "taobao.com", "jd": "jd.com", "wechat_shop": "channels.weixin.qq.com",
    "xhs": "xiaohongshu.com", "douyin": "fxg.jinritemai.com", "dianping": "dianping.com", "douyin_app": "douyin.com",
    "pdd": "pinduoduo.com", "zhuanzhuan": "zhuanzhuan.com",
}


def _bad(msg: str, code: int = 400):
    raise HTTPException(status_code=code, detail=msg)


# ---------------------------------------------------------------- 加密（给某一台电脑）

def _raw_pub(b64: str) -> bytes:
    try:
        raw = base64.b64decode(b64, validate=True)
    except Exception:  # noqa: BLE001
        raw = b""
    if len(raw) != 32:
        _bad("公钥不对：要 32 字节 X25519 公钥的 base64")
    return raw


def fingerprint(pub_b64: str) -> str:
    h = hashlib.sha256(_raw_pub(pub_b64)).hexdigest()[:16].upper()
    return " ".join(h[i:i + 4] for i in range(0, 16, 4))


def _kdf(shared: bytes, epk: bytes, pub: bytes) -> bytes:
    # salt 用两边公钥拼起来：换了任何一边，派生出来的钥匙都不同
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=epk + pub, info=HKDF_INFO).derive(shared)


def seal_for(pub_b64: str, plain: bytes, aad: bytes) -> dict:
    pub = _raw_pub(pub_b64)
    eph = X25519PrivateKey.generate()
    epk = eph.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    key = _kdf(eph.exchange(X25519PublicKey.from_public_bytes(pub)), epk, pub)
    nonce = os.urandom(12)
    ct = AESGCM(key).encrypt(nonce, plain, aad)
    return {"v": 1, "epk": base64.b64encode(epk).decode(), "nonce": base64.b64encode(nonce).decode(),
            "ct": base64.b64encode(ct).decode()}


def open_with(priv: X25519PrivateKey, box: dict, aad: bytes) -> bytes:
    """测试和自检用：巡航台那边是同一套算法的 Node 实现（src/main/vault-ads.js）。"""
    pub = priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    epk = base64.b64decode(box["epk"])
    key = _kdf(priv.exchange(X25519PublicKey.from_public_bytes(epk)), epk, pub)
    return AESGCM(key).decrypt(base64.b64decode(box["nonce"]), base64.b64decode(box["ct"]), aad)


def aad_for(item_id: str, station_id: str) -> bytes:
    return f"{item_id}|{station_id}".encode()


# ---------------------------------------------------------------- 工位

def _cn(dt):
    return (dt + timedelta(hours=8)).strftime("%Y-%m-%d %H:%M") if dt else None


def station_out(db: Session, s: LedgerVaultStation, names: dict | None = None) -> dict:
    names = names or {}
    return {"id": s.id, "name": s.name, "fingerprint": s.fingerprint, "status": s.status,
            "status_label": STATION_STATES.get(s.status, s.status), "registered_by": names.get(s.registered_by_id or ""),
            "approved_by": names.get(s.approved_by_id or ""), "approved_at": _cn(s.approved_at),
            "last_seen_at": _cn(s.last_seen_at), "created_at": _cn(s.created_at)}


def register(db: Session, user: Staff, station_id: str, name: str | None, public_key: str) -> LedgerVaultStation:
    """巡航台交公钥。新电脑、或者同一台换了公钥（重装、私钥丢了），都要主人重新批准。"""
    station_id = (station_id or "").strip()
    if not station_id or len(station_id) > 64:
        _bad("电脑 id 不对")
    fp = fingerprint(public_key)
    dev = db.get(WorkbenchDevice, station_id)
    name = ((name or "").strip() or (dev.name if dev else "") or "未命名电脑")[:64]
    s = db.get(LedgerVaultStation, station_id)
    if s is None:
        s = LedgerVaultStation(id=station_id, name=name, public_key=public_key, fingerprint=fp, status="pending",
                               registered_by_id=user.id)
        db.add(s)
        lg.log(db, user, "station", "vault", None, f"工位「{name}」登记公钥 {fp}，等批准")
    elif s.public_key != public_key:
        s.public_key, s.fingerprint, s.status, s.approved_by_id, s.approved_at = public_key, fp, "pending", None, None
        s.registered_by_id = user.id
        lg.log(db, user, "station", "vault", None, f"工位「{name}」换了公钥 {fp}，要重新批准")
    s.name = name
    s.last_seen_at = datetime.utcnow()
    db.flush()
    return s


def list_stations(db: Session) -> list[dict]:
    rows = db.query(LedgerVaultStation).order_by(LedgerVaultStation.status, LedgerVaultStation.name).all()
    ids = [r.registered_by_id for r in rows] + [r.approved_by_id for r in rows]
    names = {x.id: x.name or x.username for x in db.query(Staff).filter(Staff.id.in_([i for i in ids if i])).all()}
    return [station_out(db, r, names) for r in rows]


def decide_station(db: Session, user: Staff, token: str | None, station_id: str, trust: bool) -> LedgerVaultStation:
    lv._session(db, user, token)  # 只有解了锁的主人能批
    s = db.get(LedgerVaultStation, station_id)
    if s is None:
        _bad("没有这台工位", 404)
    s.status = "trusted" if trust else "revoked"
    s.approved_by_id, s.approved_at = (user.id, datetime.utcnow()) if trust else (s.approved_by_id, s.approved_at)
    lg.log(db, user, "station", "vault", None, f"{'批准' if trust else '停用'}工位「{s.name}」{s.fingerprint}")
    return s


def station_state(db: Session, station_id: str) -> dict:
    s = db.get(LedgerVaultStation, station_id)
    if s is None:
        return {"registered": False}
    return {"registered": True, "status": s.status, "status_label": STATION_STATES[s.status], "fingerprint": s.fingerprint}


# ---------------------------------------------------------------- 要填

def env_of(db: Session, v: LedgerVault) -> LedgerDevice | None:
    d = db.get(LedgerDevice, v.device_id) if v.device_id else None
    return d if d is not None and d.kind == "env" and d.ads_user_id else None


def guess_device(db: Session, v: LedgerVault) -> None:
    """条目没指定环境、挂的是店铺：店铺跑在哪个 AdsPower 环境就填哪个（员工在开店步骤交密码时用）。"""
    if v.device_id or v.target_type != "shop" or not v.target_id:
        return
    shop = db.get(LedgerShop, v.target_id)
    d = db.get(LedgerDevice, shop.device_id) if shop is not None and shop.device_id else None
    if d is not None and d.kind == "env":
        v.device_id = d.id


def domain_of(db: Session, v: LedgerVault) -> str:
    if v.ads_domain:
        return v.ads_domain
    if v.target_type == "shop" and v.target_id:
        shop = db.get(LedgerShop, v.target_id)
        if shop is not None and shop.platform in DOMAINS:
            return DOMAINS[shop.platform]
    if v.category == "alipay" or v.target_type == "alipay":
        return "alipay.com"
    return ""


def request(db: Session, user: Staff, v: LedgerVault, why: str) -> bool:
    """变成「等填」。挂的不是有编号的 AdsPower 环境、或者什么密码都没存，就不填（返回 False）。"""
    if env_of(db, v) is None or not (v.has_password or v.has_totp):
        return False
    v.ads_status, v.ads_job_at, v.ads_station_id, v.ads_claim_until, v.ads_ack_hash, v.ads_error = \
        "pending", datetime.utcnow(), None, None, None, None
    lg.log(db, user, "ads_request", "vault", v.id, f"「{v.title}」要填进 AdsPower：{why}")
    return True


def _trusted(db: Session, station_id: str) -> LedgerVaultStation:
    s = db.get(LedgerVaultStation, station_id or "")
    if s is None or s.status != "trusted":
        _bad("这台电脑还没被密码库主人批准", 403)
    return s


def poll(db: Session, user: Staff, station_id: str, ads_user_ids: list[str]) -> list[dict]:
    """批准过的工位来领要填的：只给它本机 AdsPower 里有的环境，一次最多 BATCH 条，领 CLAIM_MINUTES 分钟。"""
    s = _trusted(db, station_id)
    now = datetime.utcnow()
    s.last_seen_at = now
    ids = {i for i in (ads_user_ids or []) if isinstance(i, str) and i}
    if not ids:
        return []
    envs = {d.id: d for d in db.query(LedgerDevice).filter(LedgerDevice.kind == "env",
                                                             LedgerDevice.ads_user_id.in_(ids)).all()}
    if not envs:
        return []
    rows = db.query(LedgerVault).filter(LedgerVault.ads_status == "pending", LedgerVault.device_id.in_(list(envs))) \
        .order_by(LedgerVault.ads_job_at).all()
    out = []
    for v in rows:
        if v.ads_claim_until and v.ads_claim_until > now and v.ads_station_id != s.id:
            continue  # 别的工位刚领走
        secret = lv.unseal(v.id, v.category, v.secret)
        ack = secrets.token_urlsafe(24)
        payload = {"item_id": v.id, "ads_user_id": envs[v.device_id].ads_user_id, "domain": domain_of(db, v),
                   "username": v.login_name or "", "password": secret.get("password") or "",
                   "fakey": secret.get("totp") or "", "ack": ack, "issued_at": now.isoformat()}
        box = seal_for(s.public_key, json.dumps(payload, ensure_ascii=False).encode(), aad_for(v.id, s.id))
        v.ads_station_id, v.ads_claim_until = s.id, now + timedelta(minutes=CLAIM_MINUTES)
        v.ads_ack_hash = hashlib.sha256(ack.encode()).hexdigest()
        lg.log(db, user, "ads_send", "vault", v.id, f"「{v.title}」加密发给工位「{s.name}」去填")
        out.append({"item_id": v.id, "ads_user_id": payload["ads_user_id"], "box": box})
        if len(out) >= BATCH:
            break
    return out


def result(db: Session, user: Staff, station_id: str, item_id: str, ack: str, ok: bool, verified: bool,
           error: str | None) -> LedgerVault:
    s = _trusted(db, station_id)
    v = db.get(LedgerVault, item_id)
    if v is None:
        _bad("没有这一条", 404)
    if v.ads_station_id != s.id or not v.ads_ack_hash or \
            hashlib.sha256((ack or "").encode()).hexdigest() != v.ads_ack_hash:
        lg.log(db, user, "deny", "vault", v.id, f"工位「{s.name}」交的回执对不上，已拦下")
        db.commit()
        _bad("回执对不上（可能被别的工位重新领了）", 409)
    v.ads_ack_hash, v.ads_claim_until = None, None
    if ok and verified:
        v.ads_status, v.ads_synced_at, v.ads_error = "synced", datetime.utcnow(), None
        lg.log(db, user, "ads_ok", "vault", v.id, f"工位「{s.name}」填好了，读回核对一致")
    else:
        v.ads_status = "error"
        v.ads_error = ((error or "") or ("写进去了但读回来对不上" if ok else "没写进去"))[:255]
        lg.log(db, user, "ads_fail", "vault", v.id, f"工位「{s.name}」：{v.ads_error}")
    return v

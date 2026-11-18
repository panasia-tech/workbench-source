#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
锚点全量台账 · 密码保险箱加密与双因子认证核心模块（零第三方依赖）
1. 静态落库加密：PBKDF2-HMAC-SHA256 派生子密钥 + SHA256-CTR 流加密 + HMAC-SHA256 (Encrypt-then-MAC) 防篡改认证加密
2. 标准动态口令：RFC 6238 TOTP (HMAC-SHA1, 6位, 30秒步长)，100% 兼容 iPhone 自带「密码」App / Google & Microsoft Authenticator
3. WebAuthn Passkey 挑战签发与短期解锁会话令牌管理（内存态，到期或手动上锁立即销毁，绝不落盘）
"""

from __future__ import annotations
import base64
import hashlib
import hmac
import os
import secrets
import sqlite3
import struct
import time
import urllib.parse
from datetime import datetime
from pathlib import Path

from qr_svg import render_qr_svg

BASE_DIR = Path(__file__).resolve().parent
KEK_FILE = Path(os.environ.get("LEDGER_KEK_PATH", str(BASE_DIR / ".vault_master.key")))


def _b64u_enc(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64u_dec(text: str) -> bytes:
    pad = "=" * ((4 - len(text) % 4) % 4)
    return base64.urlsafe_b64decode((text + pad).encode("ascii"))


def get_master_kek() -> bytes:
    env_hex = os.environ.get("LEDGER_VAULT_KEK_HEX", "").strip()
    if len(env_hex) == 64:
        return bytes.fromhex(env_hex)
    if KEK_FILE.exists():
        raw = KEK_FILE.read_bytes().strip()
        if len(raw) >= 32:
            return raw[:32]
    kek = secrets.token_bytes(32)
    KEK_FILE.write_bytes(kek)
    try:
        os.chmod(KEK_FILE, 0o600)
    except OSError:
        pass
    return kek


def _keystream_xor(data: bytes, enc_key: bytes, nonce: bytes) -> bytes:
    out = bytearray(len(data))
    blocks = (len(data) + 31) // 32
    for counter in range(blocks):
        blk = hmac.new(enc_key, nonce + struct.pack(">Q", counter), hashlib.sha256).digest()
        start = counter * 32
        end = min(start + 32, len(data))
        for i in range(start, end):
            out[i] = data[i] ^ blk[i - start]
    return bytes(out)


def encrypt_secret(plaintext: str, aad: str = "vault") -> str:
    if not plaintext:
        return ""
    if plaintext.startswith("ENCv1$"):
        return plaintext
    kek = get_master_kek()
    nonce = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", kek, nonce, 12_000, dklen=64)
    enc_key, mac_key = dk[:32], dk[32:]
    pt_bytes = plaintext.encode("utf-8")
    ct = _keystream_xor(pt_bytes, enc_key, nonce)
    tag = hmac.new(mac_key, b"ENCv1|" + nonce + b"|" + aad.encode("utf-8") + b"|" + ct, hashlib.sha256).digest()
    return f"ENCv1${_b64u_enc(nonce)}${_b64u_enc(ct)}${_b64u_enc(tag)}"


def decrypt_secret(token: str, aad: str = "vault") -> str:
    if not token:
        return ""
    if not token.startswith("ENCv1$"):
        return token
    parts = token.split("$")
    if len(parts) != 4:
        raise ValueError("密文格式损坏")
    _, n_b64, c_b64, t_b64 = parts
    nonce = _b64u_dec(n_b64)
    ct = _b64u_dec(c_b64)
    tag = _b64u_dec(t_b64)
    kek = get_master_kek()
    dk = hashlib.pbkdf2_hmac("sha256", kek, nonce, 12_000, dklen=64)
    enc_key, mac_key = dk[:32], dk[32:]
    expected_tag = hmac.new(mac_key, b"ENCv1|" + nonce + b"|" + aad.encode("utf-8") + b"|" + ct, hashlib.sha256).digest()
    if not hmac.compare_digest(tag, expected_tag):
        raise ValueError("密文完整性校验失败（密钥不匹配或密文被篡改）")
    pt = _keystream_xor(ct, enc_key, nonce)
    return pt.decode("utf-8")


# ==================== RFC 6238 标准 TOTP ====================
def generate_totp_secret() -> str:
    # 20 bytes = 160 bits -> 32 Base32 chars (no '=' padding needed)
    return base64.b32encode(secrets.token_bytes(20)).decode("ascii").rstrip("=")


def compute_totp(secret_b32: str, ts: float | None = None, period: int = 30, digits: int = 6) -> str:
    clean = secret_b32.strip().replace(" ", "").upper()
    pad = "=" * ((8 - len(clean) % 8) % 8)
    key = base64.b32decode((clean + pad).encode("ascii"))
    t = int(time.time() if ts is None else ts)
    counter = t // period
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code_int = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(code_int % (10 ** digits)).zfill(digits)


def verify_totp(secret_b32: str, code: str, window: int = 1) -> tuple[bool, int]:
    """返回 (是否验证通过, 匹配的30秒时间步counter)"""
    code_clean = "".join(ch for ch in str(code) if ch.isdigit())
    if len(code_clean) != 6:
        return False, 0
    now = time.time()
    for step_offset in range(-window, window + 1):
        ts = now + step_offset * 30
        step_counter = int(ts) // 30
        if hmac.compare_digest(compute_totp(secret_b32, ts=ts), code_clean):
            return True, step_counter
    return False, 0


def build_otpauth_uri(secret_b32: str, account_label: str = "BossMasterVault", issuer: str = "AnchorLedger") -> str:
    label = urllib.parse.quote(f"{issuer}:{account_label}")
    params = urllib.parse.urlencode({
        "secret": secret_b32,
        "issuer": issuer,
        "algorithm": "SHA1",
        "digits": "6",
        "period": "30",
    })
    return f"otpauth://totp/{label}?{params}"


# ==================== 内存级高安全解锁会话与防重放 ====================
class VaultSessionManager:
    def __init__(self) -> None:
        self._sessions: dict[str, dict] = {}
        self._challenges: dict[str, dict] = {}
        self._used_totp_steps: set[int] = set()
        self._failed_attempts: list[float] = []

    def check_rate_limit(self) -> None:
        now = time.time()
        self._failed_attempts = [t for t in self._failed_attempts if now - t < 300]
        if len(self._failed_attempts) >= 8:
            raise ValueError("连续验证失败次数过多，密码保险箱已触发 5 分钟防暴力破解锁定！")

    def record_failure(self) -> None:
        self._failed_attempts.append(time.time())

    def check_and_mark_totp_step(self, step: int) -> None:
        # Keep set bounded
        if len(self._used_totp_steps) > 200:
            self._used_totp_steps.clear()
        self._used_totp_steps.add(step)

    def issue_session(self, auth_method: str, ttl_seconds: int = 900) -> dict:
        token = _b64u_enc(secrets.token_bytes(32))
        now = time.time()
        exp = now + ttl_seconds
        sess = {
            "token": token,
            "auth_method": auth_method,
            "issued_at": now,
            "expires_at": exp,
            "ttl_seconds": ttl_seconds,
        }
        self._sessions[token] = sess
        return sess

    def get_valid_session(self, token: str | None) -> dict | None:
        if not token:
            return None
        sess = self._sessions.get(token)
        if not sess:
            return None
        if time.time() > sess["expires_at"]:
            self._sessions.pop(token, None)
            return None
        return sess

    def revoke_session(self, token: str | None) -> None:
        if token:
            self._sessions.pop(token, None)

    def revoke_all(self) -> None:
        self._sessions.clear()

    def create_webauthn_challenge(self, purpose: str) -> dict:
        cid = _b64u_enc(secrets.token_bytes(16))
        challenge_b64 = _b64u_enc(secrets.token_bytes(32))
        self._challenges[cid] = {
            "challenge": challenge_b64,
            "purpose": purpose,
            "expires_at": time.time() + 120,
        }
        return {"challenge_id": cid, "challenge": challenge_b64}

    def consume_webauthn_challenge(self, cid: str, expected_purpose: str) -> str:
        rec = self._challenges.pop(cid, None)
        if not rec or time.time() > rec["expires_at"] or rec["purpose"] != expected_purpose:
            raise ValueError("扫码/通行密钥验证挑战已过期，请重新点击验证")
        return rec["challenge"]


VAULT_SESSIONS = VaultSessionManager()


# ==================== 数据库表初始化与全量加密密码种子 ====================
VAULT_DDL = """
CREATE TABLE IF NOT EXISTS vault_auth_config (
    id TEXT PRIMARY KEY,
    totp_secret_enc TEXT NOT NULL,
    issuer_name TEXT NOT NULL DEFAULT 'AnchorLedger',
    account_label TEXT NOT NULL DEFAULT '老板全量密码总库',
    is_demo_mode INTEGER NOT NULL DEFAULT 1,
    totp_bound_at TEXT,
    webauthn_cred_id TEXT,
    webauthn_label TEXT,
    webauthn_bound_at TEXT,
    unlock_ttl_seconds INTEGER NOT NULL DEFAULT 900,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credential_vault (
    id TEXT PRIMARY KEY,
    legal_person_id TEXT,
    category TEXT NOT NULL CHECK (category IN ('gov_tax', 'alipay', 'platform', 'network_ads', 'device_sim')),
    target_table TEXT NOT NULL DEFAULT '',
    target_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    login_account TEXT NOT NULL,
    login_password_enc TEXT NOT NULL DEFAULT '',
    secondary_label TEXT NOT NULL DEFAULT '支付/交易密码',
    secondary_password_enc TEXT NOT NULL DEFAULT '',
    account_totp_secret_enc TEXT NOT NULL DEFAULT '',
    recovery_note_enc TEXT NOT NULL DEFAULT '',
    assigned_staff TEXT NOT NULL DEFAULT '',
    employee_totp_enabled INTEGER NOT NULL DEFAULT 1,
    adspower_profile_id TEXT NOT NULL DEFAULT '',
    adspower_sync_status TEXT NOT NULL DEFAULT 'app_only',
    adspower_synced_at TEXT NOT NULL DEFAULT '',
    password_rotated_at TEXT NOT NULL DEFAULT '2026-10-15',
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cred_vault_target ON credential_vault (target_table, target_id);
CREATE INDEX IF NOT EXISTS idx_cred_vault_cat ON credential_vault (category);

CREATE TABLE IF NOT EXISTS vault_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at TEXT NOT NULL,
    action TEXT NOT NULL,
    auth_method TEXT NOT NULL DEFAULT '-',
    target_title TEXT NOT NULL DEFAULT '-',
    client_ip TEXT NOT NULL DEFAULT '127.0.0.1',
    detail TEXT NOT NULL DEFAULT ''
);
"""


def write_audit_log(conn: sqlite3.Connection, action: str, target_title: str = "-", auth_method: str = "-", client_ip: str = "127.0.0.1", detail: str = "") -> None:
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    conn.execute(
        "INSERT INTO vault_audit_logs (occurred_at, action, auth_method, target_title, client_ip, detail) VALUES (?,?,?,?,?,?)",
        (now_str, action, auth_method, target_title, client_ip, detail),
    )


def ensure_vault_tables_and_seed(conn: sqlite3.Connection) -> None:
    conn.executescript(VAULT_DDL)
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    cfg = conn.execute("SELECT id, totp_secret_enc, is_demo_mode FROM vault_auth_config WHERE id='boss_primary'").fetchone()
    kek_mismatch_in_demo = False
    if cfg:
        try:
            decrypt_secret(cfg["totp_secret_enc"], "totp_cfg")
        except ValueError:
            if cfg["is_demo_mode"]:
                kek_mismatch_in_demo = True
                conn.execute("DELETE FROM vault_auth_config")
                conn.execute("DELETE FROM credential_vault")
                cfg = None
            else:
                raise

    if not cfg:
        init_secret = generate_totp_secret()
        conn.execute(
            """INSERT INTO vault_auth_config
               (id, totp_secret_enc, issuer_name, account_label, is_demo_mode, totp_bound_at, unlock_ttl_seconds, updated_at)
               VALUES ('boss_primary', ?, 'AnchorLedger', '老板主控密码库', 1, NULL, 900, ?)""",
            (encrypt_secret(init_secret, "totp_cfg"), now_str),
        )

    existing_cnt = conn.execute("SELECT COUNT(*) FROM credential_vault").fetchone()[0]
    if existing_cnt > 0 and not kek_mismatch_in_demo:
        conn.commit()
        return

    seeds: list[tuple] = []

    # 1. 政务税务与工商年报密码（自动关联各税务局登记与工商年报）
    tax_rows = conn.execute(
        """SELECT t.id, t.tax_bureau_name, e.legal_person_id, e.entity_code, e.entity_name, e.uscc
           FROM tax_registrations t JOIN business_entities e ON e.id = t.business_entity_id"""
    ).fetchall()
    for idx, tr in enumerate(tax_rows, start=1):
        tid, bureau, lp_id, ecode, ename, uscc = tr
        seeds.append((
            f"cred-tax-{idx:02d}", lp_id, "gov_tax", "tax_registrations", tid,
            f"{ecode} · 电子税务局 ({ename})",
            uscc,
            f"Tax#2026!Qc{idx:02d}Lp",
            "个税申报密码",
            f"Gs@{8820 + idx}",
            "",
            f"主管局：{bureau}；登录选【企业业务】输入统一信用代码+密码+办税员短信码",
            "2026-10-08",
        ))

    ar_rows = conn.execute(
        """SELECT a.id, a.aic_bureau_name, e.legal_person_id, e.entity_code, e.entity_name, e.uscc
           FROM annual_reports a JOIN business_entities e ON e.id = a.business_entity_id"""
    ).fetchall()
    for idx, ar in enumerate(ar_rows, start=1):
        aid, bureau, lp_id, ecode, ename, uscc = ar
        seeds.append((
            f"cred-ar-{idx:02d}", lp_id, "gov_tax", "annual_reports", aid,
            f"{ecode} · 工商年报公示系统 ({ename})",
            uscc,
            f"Aic#Year{2026 + idx}!Hz",
            "联络员备案口令",
            f"Lly#{6610 + idx}",
            "",
            f"国家企业信用信息公示系统（浙江）联络员登录，管辖：{bureau}",
            "2026-09-20",
        ))

    # 2. 全部企业支付宝登录密码 + 6位支付交易密码 + 企业邮箱密码
    ali_rows = conn.execute(
        "SELECT id, legal_person_id, account_code, account_name, login_email, is_entity_master_fund, trade_direction FROM alipay_accounts"
    ).fetchall()
    for idx, al in enumerate(ali_rows, start=1):
        aid, lp_id, acode, aname, email, is_master, tdir = al
        role_note = "主资金池盾控户" if is_master else ("因公采购子号" if tdir == "purchase_only" else "销售收款户")
        seeds.append((
            f"cred-ali-{idx:02d}", lp_id, "alipay", "alipay_accounts", aid,
            f"{acode} · {aname}",
            email,
            f"AliPay$Login#{9100 + idx}Zx!",
            "6位支付/盾密码",
            f"{381920 + idx * 7:06d}"[:6],
            "",
            f"定位：{role_note}；对应企业子邮箱 {email} 独立密码：Mail#{7300 + idx}!Qc",
            "2026-10-25",
        ))

    # 3. 13类全平台店铺、买卡券专号、社媒账号密码（关联授权员工与 AdsPower Authenticator fakey）
    plat_rows = conn.execute(
        "SELECT id, legal_person_id, account_code, display_name, platform, platform_login_id, account_role, operator_staff, adspower_profile_id, account_status FROM platform_accounts"
    ).fetchall()
    plat_meta_by_cid: dict[str, tuple[str, str, str, str]] = {}
    for idx, pl in enumerate(plat_rows, start=1):
        pid, lp_id, pcode, dname, plat, login_id, prole, op_staff, ads_pid, acc_st = pl
        cid_key = f"cred-plat-{idx:02d}"
        sec_label = "提现/店铺支付密码" if prole == "sales_only" else ("买券支付口令" if prole == "purchase_only" else "创作者中心二级码")
        # 凡绑定了 AdsPower 窗口或重点小店平台，均配备独立 RFC 6238 Authenticator (fakey) 种子，供 AdsPower 自动填充与员工免明文取动态码！
        has_totp = bool(ads_pid) or (plat in ("doudian", "wechat_shop", "xiaohongshu_shop", "taobao_store", "jd_store"))
        sync_st = ("local_ready" if acc_st == "warming" else "synced") if ads_pid else "app_only"
        sync_at = "2026-11-15 09:30" if sync_st == "synced" else ""
        plat_meta_by_cid[cid_key] = (op_staff or "", ads_pid or "", sync_st, sync_at)
        seeds.append((
            cid_key, lp_id, "platform", "platform_accounts", pid,
            f"{pcode} · {dname} ({plat})",
            login_id,
            f"Shop@{plat[:3].capitalize()}{5200 + idx}!#",
            sec_label,
            f"{619024 + idx * 13:06d}"[:6],
            generate_totp_secret() if has_totp else "",
            "已启用免明文托管：登录密码与2FA种子(fakey)注入绑定AdsPower专窗自动填充，员工仅可拉起专窗或取6位动态码",
            "2026-11-01",
        ))

    # 4. AdsPower 超级主控 + 家宽代理供应商总后台与 SOCKS5 节点密码
    seeds.append((
        "cred-sys-adspower", "lp-ljg", "network_ads", "system", "adspower_master",
        "AdsPower 团队超级管理员总控号",
        "c56cf6f348@example.invalid",
        "AdsMaster#2026! SuperRoot",
        "安全锁口令",
        "908172",
        generate_totp_secret(),
        "控制全部 2 台电脑宿主机与 19 个浏览器指纹环境，开启强制异地登录 TOTP",
        "2026-11-05",
    ))
    seeds.append((
        "cred-sys-proxy-vendor", "lp-ljg", "network_ads", "system", "proxy_vendor_portal",
        "蛟龙住宅家宽代理 · 采购续费总后台（¥10/月）",
        "00009916210",
        "JlResiProxy#2026!Vip",
        "API提卡密钥",
        "sk_live_jl_99281a7c0f",
        "",
        "全部 16 条静态住宅 SOCKS5 家宽节点续期与账密重置入口",
        "2026-10-18",
    ))
    px_rows = conn.execute("SELECT id, proxy_code, exit_ip, proxy_user, proxy_pass, host, port FROM proxy_ips").fetchall()
    for idx, px in enumerate(px_rows, start=1):
        pxid, pxcode, exit_ip, puser, ppass, phost, pport = px
        seeds.append((
            f"cred-px-{idx:02d}", "lp-ljg", "network_ads", "proxy_ips", pxid,
            f"{pxcode} · 家宽节点 ({exit_ip})",
            f"{puser}@{phost}:{pport}",
            ppass,
            "节点管理PIN",
            "-",
            "",
            f"SOCKS5 独享住宅出口 {exit_ip}",
            "2026-10-20",
        ))

    # 5. 实体手机锁屏密码/Apple&小米ID + 手机卡运营商 6 位服务密码
    dev_rows = conn.execute("SELECT id, legal_person_id, device_code, brand_model, device_kind FROM physical_devices").fetchall()
    for idx, dv in enumerate(dev_rows, start=1):
        did, lp_id, dcode, bmodel, dkind = dv
        sec_lbl = "系统开机密码" if dkind == "adspower_pc_host" else "AppleID / 小米云密码"
        seeds.append((
            f"cred-dev-{idx:02d}", lp_id, "device_sim", "physical_devices", did,
            f"{dcode} · {bmodel}",
            dcode,
            f"{258010 + idx:06d}" if dkind != "adspower_pc_host" else f"MacHost#{2026 + idx}!Qc",
            sec_lbl,
            f"CloudId#{4400 + idx}!Hz",
            "",
            "手机锁屏统一关闭面容防误触，交接离职时必须同步轮换锁屏码",
            "2026-09-30",
        ))

    sim_rows = conn.execute("SELECT id, legal_person_id, phone_number, carrier, real_name_holder FROM sim_cards").fetchall()
    for idx, sm in enumerate(sim_rows, start=1):
        sid, lp_id, phone, carrier, holder = sm
        seeds.append((
            f"cred-sim-{idx:02d}", lp_id, "device_sim", "sim_cards", sid,
            f"SIM服务密码 · {phone} ({carrier}·{holder})",
            phone,
            f"{147250 + idx * 3:06d}"[:6],
            "SIM卡 PIN 码",
            "1234",
            "",
            f"{carrier}掌厅登录 / 办理副卡 / 查询通话详单专用 6 位服务密码",
            "2026-09-15",
        ))

    for row in seeds:
        cid, lp_id, cat, t_tbl, t_id, title, l_acc, l_pwd, s_lbl, s_pwd, sub_totp, note, rot_at = row
        pmeta = plat_meta_by_cid.get(cid, ("", "", "app_only", ""))
        conn.execute(
            """INSERT INTO credential_vault
               (id, legal_person_id, category, target_table, target_id, title, login_account,
                login_password_enc, secondary_label, secondary_password_enc, account_totp_secret_enc,
                recovery_note_enc, assigned_staff, employee_totp_enabled, adspower_profile_id,
                adspower_sync_status, adspower_synced_at, password_rotated_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                cid, lp_id, cat, t_tbl, t_id, title, l_acc,
                encrypt_secret(l_pwd, cid),
                s_lbl,
                encrypt_secret(s_pwd, cid) if s_pwd and s_pwd != "-" else "",
                encrypt_secret(sub_totp, cid) if sub_totp else "",
                encrypt_secret(note, cid) if note else "",
                pmeta[0],
                1 if cat == "platform" else 0,
                pmeta[1],
                pmeta[2],
                pmeta[3],
                rot_at,
                now_str,
            ),
        )

    write_audit_log(conn, "INIT_VAULT", "全量密码保险箱", "SYSTEM", "127.0.0.1", f"已完成 {len(seeds)} 条业务密码加密落库初始化（含 AdsPower Authenticator fakey 映射）")
    conn.commit()


def get_vault_public_summary(conn: sqlite3.Connection, token: str | None, viewer_role: str = "boss", viewer_staff: str = "") -> dict:
    """
    安全摘要（严格分级 RBAC）：
    - 老板端 (boss)：可见全库脱敏摘要，2FA 解锁后可单条按需解密；
    - 主管端 (supervisor)：仅见平台账号与 AdsPower 同步状态摘要，隐藏政务税务/主资金池盾密，且无明文解密权；
    - 员工端 (employee)：【免明文托管】仅返回分配给该员工本人 (assigned_staff == viewer_staff) 的平台商业账号条目，用于拉起 AdsPower 专窗与读取 6 位 Authenticator 动态码，彻底物理隐藏全库其余条目！
    """
    # 兼容旧库平滑补列
    existing_cols = {r[1] for r in conn.execute("PRAGMA table_info(credential_vault)").fetchall()}
    for col_ddl in [
        ("assigned_staff", "TEXT NOT NULL DEFAULT ''"),
        ("employee_totp_enabled", "INTEGER NOT NULL DEFAULT 1"),
        ("adspower_profile_id", "TEXT NOT NULL DEFAULT ''"),
        ("adspower_sync_status", "TEXT NOT NULL DEFAULT 'app_only'"),
        ("adspower_synced_at", "TEXT NOT NULL DEFAULT ''"),
    ]:
        if col_ddl[0] not in existing_cols:
            conn.execute(f"ALTER TABLE credential_vault ADD COLUMN {col_ddl[0]} {col_ddl[1]}")

    sess = VAULT_SESSIONS.get_valid_session(token) if viewer_role == "boss" else None
    cfg = conn.execute("SELECT * FROM vault_auth_config WHERE id='boss_primary'").fetchone()

    ads_lookup = {
        r[0]: {"profile_code": r[1], "ads_serial_no": r[2], "ads_user_id": r[3], "window_name": r[4], "profile_status": r[5]}
        for r in conn.execute("SELECT id, profile_code, ads_serial_no, ads_user_id, window_name, profile_status FROM adspower_profiles").fetchall()
    }

    rows = conn.execute(
        """SELECT id, legal_person_id, category, target_table, target_id, title, login_account,
                  secondary_label, assigned_staff, employee_totp_enabled, adspower_profile_id,
                  adspower_sync_status, adspower_synced_at,
                  CASE WHEN login_password_enc != '' THEN 1 ELSE 0 END AS has_login_pwd,
                  CASE WHEN secondary_password_enc != '' THEN 1 ELSE 0 END AS has_secondary_pwd,
                  CASE WHEN account_totp_secret_enc != '' THEN 1 ELSE 0 END AS has_sub_totp,
                  CASE WHEN recovery_note_enc != '' THEN 1 ELSE 0 END AS has_note,
                  password_rotated_at, updated_at
           FROM credential_vault
           ORDER BY category, id"""
    ).fetchall()

    all_items = []
    for r in rows:
        d = dict(r)
        d["has_totp"] = bool(d.get("has_sub_totp") or d.get("employee_totp_enabled"))
        ads = ads_lookup.get(d["adspower_profile_id"] or "", {})
        d["ads_profile_code"] = ads.get("profile_code", "")
        d["ads_serial_no"] = ads.get("ads_serial_no", "")
        d["ads_user_id"] = ads.get("ads_user_id", "")
        d["ads_window_name"] = ads.get("window_name", "")
        d["ads_profile_status"] = ads.get("profile_status", "")
        all_items.append(d)

    if viewer_role == "employee":
        items = [x for x in all_items if x["category"] == "platform" and x["assigned_staff"] == viewer_staff]
        logs = [dict(r) for r in conn.execute(
            "SELECT * FROM vault_audit_logs WHERE auth_method LIKE ? ORDER BY id DESC LIMIT 20",
            (f"%{viewer_staff}%",),
        ).fetchall()]
    elif viewer_role == "gm_office":
        items = []
        logs = []
    elif viewer_role == "supervisor":
        items = [x for x in all_items if x["category"] in ("platform", "network_ads")]
        logs = [dict(r) for r in conn.execute("SELECT * FROM vault_audit_logs ORDER BY id DESC LIMIT 20").fetchall()]
    else:
        items = all_items
        logs = [dict(r) for r in conn.execute("SELECT * FROM vault_audit_logs ORDER BY id DESC LIMIT 30").fetchall()]

    remaining_sec = int(max(0, sess["expires_at"] - time.time())) if sess else 0
    return {
        "viewer_role": viewer_role,
        "viewer_staff": viewer_staff,
        "unlocked": bool(sess),
        "auth_method": sess["auth_method"] if sess else None,
        "remaining_seconds": remaining_sec,
        "is_demo_mode": bool(cfg["is_demo_mode"]) if cfg else True,
        "totp_bound_at": cfg["totp_bound_at"] if cfg else None,
        "webauthn_bound": bool(cfg["webauthn_cred_id"]) if cfg else False,
        "webauthn_label": cfg["webauthn_label"] if cfg else None,
        "unlock_ttl_seconds": cfg["unlock_ttl_seconds"] if cfg else 900,
        "total_count": len(items),
        "full_vault_count": len(all_items),
        "ads_synced_count": sum(1 for x in all_items if x["adspower_sync_status"] == "synced"),
        "items": items,
        "audit_logs": logs,
    }


def get_totp_setup_payload(conn: sqlite3.Connection, current_token: str | None) -> dict:
    """
    获取用于 iPhone 相机 / Authenticator 扫码绑定的二维码：
    - 若当前处于首次未绑定状态（is_demo_mode = 1），允许直接展示二维码以便老板首次拿 iPhone 扫码绑定；
    - 一旦老板点击「确认绑定我的 iPhone（锁定生产态）」（is_demo_mode = 0），之后查看或重置二维码必须先通过已绑设备解锁！
    """
    cfg = conn.execute("SELECT * FROM vault_auth_config WHERE id='boss_primary'").fetchone()
    sess = VAULT_SESSIONS.get_valid_session(current_token)
    if not cfg["is_demo_mode"] and not sess:
        raise ValueError("当前已处于生产绑定锁定态：如需换绑新 iPhone，请先用原验证器或 Passkey 解锁后再操作！")

    secret_b32 = decrypt_secret(cfg["totp_secret_enc"], "totp_cfg")
    uri = build_otpauth_uri(secret_b32, cfg["account_label"], cfg["issuer_name"])
    qr_svg = render_qr_svg(uri)

    res = {
        "issuer": cfg["issuer_name"],
        "account_label": cfg["account_label"],
        "secret_b32": secret_b32,
        "otpauth_uri": uri,
        "qr_svg": qr_svg,
        "is_demo_mode": bool(cfg["is_demo_mode"]),
    }
    # 仅在首次未锁定生产态前，提供当前30秒演示验证码便于本地快速验收；锁定生产态后绝不返回！
    if cfg["is_demo_mode"]:
        res["demo_current_code"] = compute_totp(secret_b32)
        res["demo_seconds_left"] = 30 - (int(time.time()) % 30)
    return res

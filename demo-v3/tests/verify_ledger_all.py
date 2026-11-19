#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
自动化全量验证脚本：验证全量台账数据结构、API CRUD、导出、续期/话费/换绑动作及五大税法与风控硬拦截规则
"""

from __future__ import annotations
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from vault_security import compute_totp


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def req_json(base: str, path: str, method: str = "GET", body: dict | None = None, extra_headers: dict | None = None) -> tuple[int, dict]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    hdrs = {"Content-Type": "application/json"} if data else {}
    if extra_headers:
        hdrs.update(extra_headers)
    r = urllib.request.Request(
        base + path,
        data=data,
        method=method,
        headers=hdrs,
    )
    try:
        with urllib.request.urlopen(r, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def main() -> None:
    tmp_dir = Path(tempfile.mkdtemp(prefix="ledger_test_"))
    test_db = tmp_dir / "test_ledger.sqlite"
    port = find_free_port()
    base = f"http://127.0.0.1:{port}"

    env = os.environ.copy()
    env["LEDGER_PORT"] = str(port)
    env["LEDGER_DB_PATH"] = str(test_db)

    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "ledger_server.py")],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        # Wait server ready
        for _ in range(30):
            try:
                code, h = req_json(base, "/api/health")
                if code == 200 and h.get("ok"):
                    break
            except Exception:
                time.sleep(0.15)
        else:
            raise RuntimeError("Server failed to start")

        # Case 1: Bootstrap structure & 1号签约委托客户林建国 1客户->4受托主体->4税->4年报->14企支->14闲鱼店+全平台
        code, boot_res = req_json(base, "/api/bootstrap?today=2026-11-14")
        assert code == 200 and boot_res["ok"], "bootstrap failed"
        d = boot_res["data"]
        ljg_ents = [e for e in d["business_entities"] if e["legal_person_id"] == "lp-ljg"]
        ljg_alis = [a for a in d["alipay_accounts"] if a["legal_person_id"] == "lp-ljg"]
        ljg_tax = [t for t in d["tax_registrations"] if t["legal_person_id"] == "lp-ljg"]
        ljg_ar = [a for a in d["annual_reports"] if a["legal_person_id"] == "lp-ljg"]
        ljg_xy_sales = [p for p in d["platform_accounts"] if p["legal_person_id"] == "lp-ljg" and p["platform"] == "xianyu" and p["account_role"] == "sales_only"]
        assert len(ljg_ents) == 4, f"Expected 4 licenses for LJG, got {len(ljg_ents)}"
        assert len(ljg_tax) == 4, f"Expected 4 tax registrations for LJG, got {len(ljg_tax)}"
        assert len(ljg_ar) == 4, f"Expected 4 annual reports for LJG, got {len(ljg_ar)}"
        assert len(ljg_alis) == 14, f"Expected 14 enterprise Alipays for LJG, got {len(ljg_alis)}"
        assert len(ljg_xy_sales) == 14, f"Expected 14 Xianyu stores for LJG, got {len(ljg_xy_sales)}"
        assert all(g["passed"] for g in d["guardrails"]), f"Initial guardrails should all pass: {d['guardrails']}"
        print("[PASS] Case 1: 1委托客户 -> 4受托主体 / 4税务 / 4工商年报 / 14企支 / 14闲鱼店+全矩阵基准核验通过")

        # Case 2: 税法红线阻断 - 跨营业执照主体因公支付串户
        code, res = req_json(base, "/api/records/alipay_accounts", "POST", {
            "legal_person_id": "lp-ljg",
            "business_entity_id": "ent-ljg-02",
            "account_code": "ALI-BAD-CROSS",
            "account_name": "跨主体测试采购号",
            "login_email": "5d5d4fbfca@example.invalid",
            "trade_direction": "purchase_only",
            "is_entity_master_fund": 0,
            "corporate_pay_enabled": 1,
            "master_alipay_id": "ali-01",  # ali-01 belongs to ent-ljg-01!
        })
        assert code == 400 and res.get("rule_blocked"), f"Cross-entity corporate pay must fail: {res}"
        print(f"[PASS] Case 2: 跨营业执照因公支付串户成功阻断 -> {res['error']}")

        # Case 3: 主体 3选1 唯一主户阻断
        code, res = req_json(base, "/api/records/alipay_accounts", "POST", {
            "legal_person_id": "lp-ljg",
            "business_entity_id": "ent-ljg-01",
            "account_code": "ALI-BAD-MASTER2",
            "account_name": "重复主资金池",
            "login_email": "3c07e66cf5@example.invalid",
            "trade_direction": "master_fund",
            "is_entity_master_fund": 1,
        })
        assert code == 400 and res.get("rule_blocked"), f"2nd master fund in same entity must fail: {res}"
        print(f"[PASS] Case 3: 同主体重复设第2个主资金号成功阻断 -> {res['error']}")

        # Case 4: 买卖隔离阻断 - 销售支付宝绑给大众点评买卡券号
        code, res = req_json(base, "/api/records/platform_accounts", "POST", {
            "legal_person_id": "lp-ljg",
            "business_entity_id": "ent-ljg-01",
            "platform": "dianping",
            "account_code": "DP-BAD-SELL",
            "display_name": "违规买券号",
            "platform_login_id": "dp_bad",
            "account_role": "purchase_only",
            "alipay_account_id": "ali-02",  # sales_only!
            "proxy_ip_id": "px-16",
        })
        assert code == 400 and res.get("rule_blocked"), f"Sales Alipay bound to purchase account must fail: {res}"
        print(f"[PASS] Case 4: 买卖混用（销售支付宝绑买券号）成功阻断 -> {res['error']}")

        # Case 5: 家宽规则 - 同一平台共用同一家宽必须阻断，不同平台复用同一家宽必须放行！
        code, res = req_json(base, "/api/records/platform_accounts", "POST", {
            "legal_person_id": "lp-ljg",
            "business_entity_id": "ent-ljg-01",
            "platform": "xianyu",
            "account_code": "XY-DUP-PROXY",
            "display_name": "撞IP闲鱼店",
            "platform_login_id": "tb_dup_px",
            "account_role": "sales_only",
            "alipay_account_id": "ali-02",
            "proxy_ip_id": "px-01",  # px-01 already has pa-xy-01 (xianyu)!
        })
        assert code == 400 and res.get("rule_blocked"), f"Same-platform proxy reuse must fail: {res}"
        print(f"[PASS] Case 5a: 同一平台共用家宽IP成功阻断 -> {res['error']}")

        # Positive cross-platform reuse on px-08 (px-08 currently has xianyu only -> add dianping purchase account!)
        code, res = req_json(base, "/api/records/platform_accounts", "POST", {
            "legal_person_id": "lp-ljg",
            "business_entity_id": "ent-ljg-02",
            "platform": "dianping",
            "account_code": "DP-OK-REUSE08",
            "display_name": "合法跨平台复用点评买券号",
            "platform_login_id": "dp_ok_px08",
            "account_role": "purchase_only",
            "alipay_account_id": "ali-08",
            "proxy_ip_id": "px-08",
        })
        assert code == 200 and res.get("ok"), f"Cross-platform proxy reuse should succeed: {res}"
        print("[PASS] Case 5b: 不同平台（闲鱼+大众点评）复用同一条家宽IP成功放行")

        # Case 6: 防直连删除保护 - 删除在用代理 IP 必须阻断
        code, res = req_json(base, "/api/records/proxy_ips/px-12", "DELETE")
        assert code == 400 and res.get("rule_blocked"), f"Deleting active proxy must fail: {res}"
        print(f"[PASS] Case 6: 在用家宽代理删除保护成功阻断 -> {res['error']}")

        # Case 7: 运营商一主4副动态配额阻断（林建国移动原有1张+已开4张=满5张）
        code, res = req_json(base, "/api/records/sim_cards", "POST", {
            "legal_person_id": "lp-ljg",
            "phone_number": "00020187193",
            "carrier": "中国移动",
            "card_category": "company_sub",
            "real_name_holder": "林建国",
            "billing_mode": "shared_master",
            "master_sim_id": "sim-01",
        })
        assert code == 400 and res.get("rule_blocked"), f"Exceeding 5-card carrier quota must fail: {res}"
        print(f"[PASS] Case 7: 运营商一主4副（扣除个人存量卡后）超额开卡成功阻断 -> {res['error']}")

        # Case 8: 代理续期、话费充值流水、外部合约卡一键批量换绑迁移、CSV导出
        code, res = req_json(base, "/api/actions/proxy-renew", "POST", {"proxy_ip_id": "px-12", "months": 1})
        assert code == 200 and res.get("ok"), f"Proxy renew failed: {res}"

        code, res = req_json(base, "/api/actions/sim-fee", "POST", {"sim_card_id": "sim-16", "change_type": "recharge", "amount_yuan": 50, "notes": "自动化验收充值"})
        assert code == 200 and res.get("balance_fen") == 5900, f"SIM recharge failed: {res}"

        code, res = req_json(base, "/api/actions/sim-rebind", "POST", {"old_sim_id": "sim-12", "new_sim_id": "sim-14"})
        assert code == 200 and res.get("ok"), f"SIM batch rebind failed: {res}"

        with urllib.request.urlopen(base + "/api/export/proxy_ips.csv", timeout=5) as csv_resp:
            assert csv_resp.status == 200 and len(csv_resp.read()) > 200
        print("[PASS] Case 8: 家宽续期、话费台账记账、外部卡一键换绑迁移、CSV导出全部验证通过")

        # Case 9: 全量密码保险箱（ENCv1 落盘加密 + 锁定态 401 阻断 + RFC 6238 TOTP 解锁 + 单条解密审计 + 立即上锁）
        assert all(px["proxy_pass"] == "••••••••" for px in d["proxy_ips"]), "proxy_pass must be masked in bootstrap"
        assert d["vault"]["unlocked"] is False and d["vault"]["total_count"] >= 100, "Vault should default locked with >100 items"
        assert "ENCv1$" not in json.dumps(d["vault"]["items"]), "Ciphertexts must never leak in public summary"

        # Check SQLite directly: zero plaintext in credential_vault
        sconn = sqlite3.connect(str(test_db))
        enc_rows = sconn.execute("SELECT category, login_password_enc FROM credential_vault").fetchall()
        sconn.close()
        cats = {r[0] for r in enc_rows}
        assert cats == {"gov_tax", "alipay", "platform", "network_ads", "device_sim"}, f"Missing categories: {cats}"
        assert all(r[1].startswith("ENCv1$") for r in enc_rows), "Every stored login password must be ENCv1 encrypted"

        # Reveal while locked -> 401
        code, rev_locked = req_json(base, "/api/vault/reveal", "POST", {"id": "cred-ali-01"})
        assert code == 401 and rev_locked.get("vault_locked") is True, f"Locked vault must reject reveal: {rev_locked}"

        # Setup QR + RFC 6238 TOTP unlock
        code, qr_res = req_json(base, "/api/vault/setup-qr", "GET")
        assert code == 200 and "<svg" in qr_res["data"]["qr_svg"] and len(qr_res["data"]["secret_b32"]) >= 16
        valid_otp = compute_totp(qr_res["data"]["secret_b32"])

        # Wrong OTP -> 401
        code, bad_otp = req_json(base, "/api/vault/unlock-totp", "POST", {"code": "000000" if valid_otp != "000000" else "999999"})
        assert code == 401, "Wrong OTP must return 401"

        # Valid OTP -> 200 + token
        code, ok_otp = req_json(base, "/api/vault/unlock-totp", "POST", {"code": valid_otp})
        assert code == 200 and ok_otp.get("token"), f"Valid OTP unlock failed: {ok_otp}"
        v_hdr = {"X-Vault-Token": ok_otp["token"]}

        # Single-item reveal with token -> decrypted secret
        code, rev_ok = req_json(base, "/api/vault/reveal", "POST", {"id": "cred-ali-01"}, extra_headers=v_hdr)
        assert code == 200 and "AliPay$Login#" in rev_ok["secret"]["login_password"], f"Decrypt mismatch: {rev_ok}"
        assert len(rev_ok["secret"]["secondary_password"]) == 6, "Expected 6-digit Alipay shield password"

        # Save new encrypted item
        code, sv_res = req_json(base, "/api/vault/save", "POST", {
            "category": "platform",
            "legal_person_id": "lp-ljg",
            "title": "测试新增淘宝网店密钥",
            "login_account": "tb_test_vault_01",
            "login_password": "MySuperSecret#2026!",
            "secondary_label": "提现口令",
            "secondary_password": "881920",
        }, extra_headers=v_hdr)
        assert code == 200 and sv_res.get("id")

        # Manual lock -> token immediately revoked
        code, lk_res = req_json(base, "/api/vault/lock", "POST", {}, extra_headers=v_hdr)
        assert code == 200 and lk_res.get("ok")
        code, rev_after_lock = req_json(base, "/api/vault/reveal", "POST", {"id": "cred-ali-01"}, extra_headers=v_hdr)
        assert code == 401, "Revoked token must immediately fail with 401"
        print(f"[PASS] Case 9: 全量密码保险箱 ({len(enc_rows)}条ENCv1密文 · iPhone扫码TOTP解锁 · 单条按需解密 · 审计与手动上锁) 全部验证通过")

        # Case 10: 单账号专属财务逻辑与损益预留槽（多清算通道、鱼小铺1.6%佣金、退券冲回/保证金流水、财务CSV导出）
        pa_by_id = {p["id"]: p for p in d["platform_accounts"]}
        assert all(p.get("settlement_channel") and p.get("finance_book_code") for p in d["platform_accounts"]), "Every account must have finance slots populated"
        assert pa_by_id["pa-xy-01"]["settlement_channel"] == "alipay_direct" and pa_by_id["pa-xy-01"]["commission_rate_bps"] == 60
        assert pa_by_id["pa-xy-09"]["commission_rate_bps"] == 160, "Yuxiaopu must have 160 bps (1.60%) commission"
        assert pa_by_id["pa-wxs-01"]["settlement_channel"] == "wechat_pay_mch" and "mch_" in pa_by_id["pa-wxs-01"]["merchant_account_no"]
        assert pa_by_id["pa-dp-01"]["settlement_channel"] == "corporate_pay_deduct"
        assert pa_by_id["pa-xhsm-01"]["settlement_channel"] == "no_settlement"

        # Block setting settlement channel on marketing_only account
        code, bad_fin = req_json(base, "/api/records/platform_accounts/pa-xhsm-01", "PUT", {"settlement_channel": "alipay_direct"})
        assert code == 400 and bad_fin.get("rule_blocked"), f"Marketing account must block payment channel: {bad_fin}"

        # Persist custom financial slot update on WeChat Shop
        code, ok_fin = req_json(base, "/api/records/platform_accounts/pa-wxs-01", "PUT", {
            "merchant_account_no": "mch_168830101_PROD",
            "commission_rate_bps": 180,
            "finance_book_code": "KD-1012-WXS01",
        })
        assert code == 200 and ok_fin.get("ok"), f"Updating account finance slots failed: {ok_fin}"

        # Record purchase refund clawback & deposit return bills
        code, rfd_bill = req_json(base, "/api/records/alipay_bills", "POST", {
            "bill_date": "2026-11-14",
            "business_entity_id": "ent-ljg-02",
            "alipay_account_id": "ali-08",
            "deducted_master_alipay_id": "ali-05",
            "related_platform_account_id": "pa-dy-01",
            "flow_direction": "inflow_purchase_refund",
            "biz_scene": "抖音团购过期未核销原路退券冲回主户",
            "counterparty": "抖音生活服务商户平台",
            "amount_fen": 17000,
            "oa_finance_voucher_no": "OA-RFD-20261114-09",
        })
        assert code == 200 and rfd_bill.get("id"), f"Purchase refund bill insert failed: {rfd_bill}"

        with urllib.request.urlopen(base + "/api/export/account_finance.csv", timeout=5) as fcsv:
            csv_txt = fcsv.read().decode("utf-8-sig")
            assert fcsv.status == 200 and "mch_168830101_PROD" in csv_txt and "KD-1012-WXS01" in csv_txt
        print("[PASS] Case 10: 每个账号专属财务预留槽（多通道清算·差异化费率·退券原路冲回·保证金·ERP映射与财务CSV）全部验证通过")

        # =====================================================================
        # Case 11: 密码库 ↔ AdsPower Authenticator 联动 & 员工免明文托管 RBAC 硬边界
        # =====================================================================
        emp_zy_hdr = {"X-Ledger-Role": "employee", "X-Ledger-Staff": urllib.parse.quote("赵宇")}
        sup_hdr = {"X-Ledger-Role": "supervisor", "X-Ledger-Staff": urllib.parse.quote("周安")}
        boss_hdr = {"X-Ledger-Role": "boss", "X-Ledger-Staff": urllib.parse.quote("老板")}

        # 11a. 员工与主管调 /api/vault/reveal 必须硬返 403！
        code, emp_rev = req_json(base, "/api/vault/reveal", "POST", {"id": "cred-plat-pa-xy-05"}, extra_headers=emp_zy_hdr)
        assert code == 403 and (emp_rev.get("rbac_blocked") or emp_rev.get("rule_blocked")), f"Employee reveal must be 403: {emp_rev}"
        code, sup_rev = req_json(base, "/api/vault/reveal", "POST", {"id": "cred-ali-01"}, extra_headers=sup_hdr)
        assert code == 403 and (sup_rev.get("rbac_blocked") or sup_rev.get("rule_blocked")), f"Supervisor reveal must be 403: {sup_rev}"

        # 11b. 员工 bootstrap 仅见本人名下受限槽位，绝不含他人或政务税务密码
        code, emp_boot = req_json(base, "/api/bootstrap", "GET", extra_headers=emp_zy_hdr)
        assert code == 200 and emp_boot["ok"]
        emp_items = emp_boot["data"]["vault"]["items"]
        assert len(emp_items) > 0 and all(it["assigned_staff"] == "赵宇" for it in emp_items), f"Employee scope leak: {emp_items}"
        assert all(it["category"] in ("platform", "alipay") for it in emp_items)

        # 11c. 员工领用本人店铺 6 位 Authenticator 动态码 -> 200（无明文密码泄露）；领用他人店铺 -> 403！
        zy_cred = next(it for it in emp_items if it.get("adspower_profile_id") == "ads-05" or it.get("target_id") == "pa-xy-05")
        cxw_cred = next(it for it in d["vault"]["items"] if it.get("assigned_staff") == "陈晓雯" and it["category"] == "platform")
        code, own_otp = req_json(base, "/api/vault/employee-totp", "POST", {"credential_id": zy_cred["id"]}, extra_headers=emp_zy_hdr)
        assert code == 200 and len(own_otp["data"]["code"]) == 6 and own_otp["data"]["code"].isdigit(), f"Employee TOTP failed: {own_otp}"
        assert "password" not in json.dumps(own_otp["data"]).lower(), "Plaintext password must never appear in employee-totp response"

        code, other_otp = req_json(base, "/api/vault/employee-totp", "POST", {"credential_id": cxw_cred["id"]}, extra_headers=emp_zy_hdr)
        assert code == 403 and (other_otp.get("rbac_blocked") or other_otp.get("rule_blocked")), f"Cross-employee TOTP must be 403: {other_otp}"

        # 11d. 员工在开店时单向加密锁入新密码 & 同步 AdsPower（且锁入后依然 403 不可反查）
        code, lockin_res = req_json(base, "/api/vault/employee-lock-in", "POST", {
            "target_table": "platform_accounts",
            "target_id": "pa-wyq-xy02",
            "title": "WYQ-XY02 · 山屿优选卡券2店",
            "login_account": "tb_wyq9002",
            "login_password": "NewStore#LockIn2026!",
            "secondary_password": "654321",
        }, extra_headers=emp_zy_hdr)
        assert code == 200 and lockin_res.get("credential_id"), f"Employee one-way lock-in failed: {lockin_res}"
        code, rev_own_after = req_json(base, "/api/vault/reveal", "POST", {"id": lockin_res["credential_id"]}, extra_headers=emp_zy_hdr)
        assert code == 403, "Employee still must not reveal even after locking in password"

        # 11e. 老板同步密码+fakey 至 AdsPower & 员工唤起本人专窗
        code, sync_ads = req_json(base, "/api/adspower/sync-credential", "POST", {
            "credential_id": zy_cred["id"],
            "adspower_profile_id": "ads-05",
        }, extra_headers=boss_hdr)
        assert code == 200 and sync_ads["data"]["ads_user_id"] == "k9x2m05" and sync_ads["data"]["has_fakey"] is True, f"AdsPower sync failed: {sync_ads}"

        code, open_win = req_json(base, "/api/adspower/open-window", "POST", {"adspower_profile_id": "ads-05"}, extra_headers=emp_zy_hdr)
        assert code == 200 and open_win["data"]["profile_code"] == "ADS-005", f"AdsPower open window failed: {open_win}"
        print("[PASS] Case 11: 密码库 ↔ AdsPower Authenticator (fakey) 桥接 & 员工免明文托管 RBAC (403防泄密/6位动态码/单向锁库) 全部验证通过")

        # =====================================================================
        # Case 12: 企业支付宝(15步) ↔ 闲鱼开店(18步) 双轨双锁状态机 & 禁填0 & 历史意见保留
        # =====================================================================
        code, ali_tpl = req_json(base, "/api/tutorials/template?id=tpl-alipay-ent")
        code2, xy_tpl = req_json(base, "/api/tutorials/template?id=tpl-xianyu-store")
        assert sum(len(s["steps"]) for s in ali_tpl["data"]["stages"]) == 15, "Alipay tutorial must have 15 steps"
        assert sum(len(s["steps"]) for s in xy_tpl["data"]["stages"]) == 18, "Xianyu tutorial must have 18 steps"

        # 12a. Gate-1 验证：上游 ali-18 未过 C10 前，闲鱼店 pa-wyq-xy02 强提 S09 必须 400 阻断！
        code, gate1_blk = req_json(base, "/api/onboarding/submit-step", "POST", {
            "case_id": "case-plat-pa-wyq-xy02",
            "step_code": "S09",
            "materials": {"ent_shop_cert": "试图强闯企业店认证"},
            "confirmed": True,
        }, extra_headers=emp_zy_hdr)
        assert code == 400 and gate1_blk.get("rule_blocked") and "C10" in gate1_blk.get("error", ""), f"Gate-1 must block S09: {gate1_blk}"

        # 老板先驳回赵宇在 S09 上的违规跳步申请 skip-req-demo-01
        code, sk_rej = req_json(base, "/api/onboarding/skip-verdict", "POST", {
            "skip_id": "skip-req-demo-01",
            "verdict": "reject",
            "boss_note": "企业店必须完成企业管家授权，严禁跳过！",
        }, extra_headers=boss_hdr)
        assert code == 200 and sk_rej["ok"]

        # 赵宇提交上游支付宝 ali-18 的 C10 -> 主管周安审核通过 -> Gate-1 自动解锁 S09！
        code, c10_sub = req_json(base, "/api/onboarding/submit-step", "POST", {
            "case_id": "case-ali-ali-18",
            "step_code": "C10",
            "materials": {"ent_steward_img": "ali18_c10_enterprise_steward_ok.png"},
            "confirmed": True,
        }, extra_headers=emp_zy_hdr)
        assert code == 200 and c10_sub["status"] == "submitted", f"C10 submit failed: {c10_sub}"

        code, c10_rev = req_json(base, "/api/onboarding/review-step", "POST", {
            "case_id": "case-ali-ali-18",
            "step_code": "C10",
            "verdict": "approve",
            "review_note": "委托客户法人现场企业管家授权截图清晰无误，放行！",
        }, extra_headers=sup_hdr)
        assert code == 200 and c10_rev["ok"]

        # 现在再提交 pa-wyq-xy02 的 S09 立即畅通无阻！
        code, s09_ok = req_json(base, "/api/onboarding/submit-step", "POST", {
            "case_id": "case-plat-pa-wyq-xy02",
            "step_code": "S09",
            "materials": {"ent_store_cert_img": "wyq_xy02_ent_license_verified.png"},
            "confirmed": True,
        }, extra_headers=emp_zy_hdr)
        assert code == 200 and s09_ok["status"] == "submitted", f"S09 should unlock after C10 approved: {s09_ok}"

        # 12b. Gate-2 验证：上游 ali-13 的 D15 尚处于 submitted 未审核通过前，闲鱼14店 S18 上架必须 400 阻断！
        emp_lt_hdr = {"X-Ledger-Role": "employee", "X-Ledger-Staff": urllib.parse.quote("林婷")}
        code, gate2_blk = req_json(base, "/api/onboarding/submit-step", "POST", {
            "case_id": "case-plat-pa-xy-14",
            "step_code": "S18",
            "materials": {"launch_ready_note": "试图未核对账单API直接开售"},
            "confirmed": True,
        }, extra_headers=emp_lt_hdr)
        assert code == 400 and gate2_blk.get("rule_blocked") and "D15" in gate2_blk.get("error", ""), f"Gate-2 must block S18: {gate2_blk}"

        # 主管周安审核通过 ali-13 的 D15 -> ali-13 完成全部15步且 bill_sync_status 自动变为 '已授权日账单' -> 解锁 S18！
        code, d15_rev = req_json(base, "/api/onboarding/review-step", "POST", {
            "case_id": "case-ali-ali-13",
            "step_code": "D15",
            "verdict": "approve",
            "review_note": "0.13元T+1账单API拉取映射核验无误，准予开售！",
        }, extra_headers=sup_hdr)
        assert code == 200 and d15_rev["case_detail"]["status"] == "completed"

        code, s18_sub = req_json(base, "/api/onboarding/submit-step", "POST", {
            "case_id": "case-plat-pa-xy-14",
            "step_code": "S18",
            "materials": {"launch_ready_note": "xy14_all_18_steps_ready_for_sale.png"},
            "confirmed": True,
        }, extra_headers=emp_lt_hdr)
        assert code == 200 and s18_sub["status"] == "submitted", f"S18 submit failed: {s18_sub}"

        code, s18_rev = req_json(base, "/api/onboarding/review-step", "POST", {
            "case_id": "case-plat-pa-xy-14",
            "step_code": "S18",
            "verdict": "approve",
            "review_note": "18步全绿验收通过，正式切换在售！",
        }, extra_headers=sup_hdr)
        assert code == 200 and s18_rev["case_detail"]["status"] == "completed"

        # 校验 pa-xy-14 的主台账状态已自动切换为 'active'，ali-13 账单同步已变为 '已授权日账单'
        code, chk_boot = req_json(base, "/api/bootstrap")
        pa14 = next(p for p in chk_boot["data"]["platform_accounts"] if p["id"] == "pa-xy-14")
        ali13 = next(a for a in chk_boot["data"]["alipay_accounts"] if a["id"] == "ali-13")
        assert pa14["account_status"] == "active", f"pa-xy-14 should transition to active: {pa14}"
        assert ali13["bill_sync_status"] == "已授权日账单", f"ali-13 bill_sync_status should update: {ali13}"

        # 12c. 材料禁填 "0" 防呆拦截 & 被打回步骤重交永久保留 v1 历史驳回意见验证
        emp_cxw_hdr = {"X-Ledger-Role": "employee", "X-Ledger-Staff": urllib.parse.quote("陈晓雯")}
        code, zero_blk = req_json(base, "/api/onboarding/submit-step", "POST", {
            "case_id": "case-plat-pa-wyq-xy03",
            "step_code": "S08",
            "materials": {"face_verify_video": "0"},
            "confirmed": True,
        }, extra_headers=emp_cxw_hdr)
        assert code == 400 and zero_blk.get("rule_blocked"), f"Pure '0' material must be blocked: {zero_blk}"

        code, s08_v2 = req_json(base, "/api/onboarding/submit-step", "POST", {
            "case_id": "case-plat-pa-wyq-xy03",
            "step_code": "S08",
            "materials": {"face_verify_video": "wyq_xy03_face_v2_full_green_receipt.mp4"},
            "confirmed": True,
        }, extra_headers=emp_cxw_hdr)
        assert code == 200 and s08_v2["version_no"] == 2
        s08_step = next(st for stg in s08_v2["case_detail"]["stages"] for st in stg["steps"] if st["step_code"] == "S08")
        assert len(s08_step["history"]) == 2 and s08_step["history"][1]["version_no"] == 1 and "驳回原因" in s08_step["history"][1]["review_note"]
        print("[PASS] Case 12: 企业支付宝(15步) ↔ 闲鱼(18步) 跨轨双门禁(C10锁S09 / D15锁S18)、禁填0与多版本审核意见保留全部验证通过")

        # =====================================================================
        # Case 13: 统筹看缺口 + 主管编排教程 + 老板终审发布 + 按缺口一键拆单派活闭环
        # =====================================================================
        gap_ov = chk_boot["data"]["gap_overview"]
        assert len(gap_ov["issues"]) >= 3 and len(gap_ov["lp_gap_rows"]) == 2, "Gap overview must contain issues and 2 LP rows"

        # 13a. 微信小店教程 tpl-wechat-shop-v1 尚未经老板批准前，派发微信小店单必须触发 Lock 400 阻断！
        code, dp_blk = req_json(base, "/api/gap/dispatch-case", "POST", {
            "target_kind": "platform",
            "legal_person_id": "lp-wyq",
            "business_entity_id": "ent-wyq-01",
            "platform": "wechat_shop",
            "display_name": "山屿严选微信小店1店",
            "assigned_staff": "陈晓雯",
        }, extra_headers=sup_hdr)
        assert code == 400 and dp_blk.get("rule_blocked"), f"Dispatch without published tutorial must block: {dp_blk}"

        # 13b. 老板终审批准 tpl-wechat-shop-v1 正式上线 -> 再次派发微信小店任务单立即成功！
        code, pub_ok = req_json(base, "/api/tutorials/publish-verdict", "POST", {
            "template_id": "tpl-wechat-shop-v1",
            "verdict": "approve",
            "boss_note": "老板终审通过上线",
        }, extra_headers=boss_hdr)
        assert code == 200 and pub_ok["status"] == "published"

        code, dp_ok = req_json(base, "/api/gap/dispatch-case", "POST", {
            "target_kind": "platform",
            "legal_person_id": "lp-wyq",
            "business_entity_id": "ent-wyq-01",
            "platform": "wechat_shop",
            "display_name": "山屿严选微信小店1店",
            "assigned_staff": "陈晓雯",
        }, extra_headers=sup_hdr)
        assert code == 200 and dp_ok.get("case_id"), f"Dispatch after boss approval must succeed: {dp_ok}"

        # 13c. 主管周安为小红书小店新建标准教程并提交老板终审
        code, au_ok = req_json(base, "/api/tutorials/save-template", "POST", {
            "code": "TPL-XHSSHOP-V1",
            "target_kind": "platform",
            "platform": "xiaohongshu_shop",
            "title": "小红书小店入驻与千帆钱包绑定教程",
            "version": "v1.0",
            "summary": "主管实操样板店沉淀",
            "submit_for_boss": True,
            "stages": [
                {
                    "stage_code": "X1",
                    "title": "执照认证与保证金缴纳",
                    "steps": [
                        {
                            "step_code": "X01",
                            "title": "绑定异平台复用家宽IP并提交个体户执照入驻千帆",
                            "guide": "打开 ark.xiaohongshu.com 提交主体资质",
                            "warn_text": "严禁与另一家小红书小店共用同一条家宽IP！",
                            "require_review": 1,
                            "materials": [{"field_key": "ark_id", "label": "小红书千帆店铺ID", "kind": "text", "required": 1}],
                        }
                    ],
                }
            ],
        }, extra_headers=sup_hdr)
        assert code == 200 and au_ok["status"] == "pending_boss", f"Supervisor authoring failed: {au_ok}"
        print("[PASS] Case 13: 统筹看缺口引擎 + 主管新建教程 + 老板终审上线 + 无教程防盲派与缺口拆单闭环全部验证通过")

        # =====================================================================
        # Case 14: 总经办端 (gm_office) & 各部门主管端 同库分专区物理隔离与零隐私泄露验证
        # =====================================================================
        gm_hdr = {"X-Ledger-Role": "gm_office", "X-Ledger-Staff": urllib.parse.quote("沈悦")}
        sup_wh_hdr = {"X-Ledger-Role": "supervisor", "X-Ledger-Staff": urllib.parse.quote("马强")}
        sup_cs_hdr = {"X-Ledger-Role": "supervisor", "X-Ledger-Staff": urllib.parse.quote("苏晴")}

        code, gm_boot = req_json(base, "/api/bootstrap", "GET", extra_headers=gm_hdr)
        assert code == 200 and gm_boot["ok"]
        gd = gm_boot["data"]
        assert len(gd["governance"]["workbench_cards"]) == 6, "GM Office must see all 6 workbenches governance cards"
        assert gd["alipay_accounts"] == [] and gd["alipay_bills"] == [] and gd["sim_cards"] == [] and gd["proxy_ips"] == [], "GM Office must be strictly isolated from Alipay/SIM/Proxy assets"
        assert gd["vault"]["items"] == [], "GM Office must see zero vault credentials"
        code, gm_rev = req_json(base, "/api/vault/reveal", "POST", {"id": "cred-ali-01"}, extra_headers=gm_hdr)
        assert code == 403, "GM Office must be 403 blocked on vault reveal"

        code, wh_boot = req_json(base, "/api/bootstrap", "GET", extra_headers=sup_wh_hdr)
        assert code == 200 and wh_boot["data"]["governance"]["focus_workbench"] == "warehouse"
        assert all(it["workbench_key"] == "warehouse" or it["assignee_staff"] == "马强" for it in wh_boot["data"]["governance"]["items"])
        assert wh_boot["data"]["alipay_accounts"] == [] and wh_boot["data"]["proxy_ips"] == []
        print("[PASS] Case 14: 总经办端与非开店业务主管端 同库分专区隔离（0资金/0代理/0号卡/0密码暴露）全部验证通过")

        # =====================================================================
        # Case 15: 六大工作台 Wiki/培训视频/KPI/OKR 提报 -> 总经办初审 -> 老板终审 -> 自动点亮教程步骤视频槽
        # =====================================================================
        # 15a. 老板终审前，企业支付宝 C10 步骤的 video_url 为空（诚实显示待录）
        code, c_before = req_json(base, "/api/onboarding/case?id=case-ali-ali-18")
        c10_before = next(st for stg in c_before["data"]["stages"] for st in stg["steps"] if st["step_code"] == "C10")
        assert c10_before["video_url"] == "", f"Before boss approval, C10 video_url should be empty: {c10_before['video_url']}"

        # 老板在 11 基建治理专区终审批准 gov-ops-vid-c10 -> 企业支付宝教程 C10 步骤视频链接当场自动点亮！
        code, pub_c10_vid = req_json(base, "/api/governance/review", "POST", {
            "item_id": "gov-ops-vid-c10",
            "verdict": "approve",
            "note": "老板验收通过，点亮C10视频！",
        }, extra_headers=boss_hdr)
        assert code == 200 and pub_c10_vid["status"] == "published"

        code, c_after = req_json(base, "/api/onboarding/case?id=case-ali-ali-18")
        c10_after = next(st for stg in c_after["data"]["stages"] for st in stg["steps"] if st["step_code"] == "C10")
        assert "panasia_alipay_c10_steward_guide.mp4" in c10_after["video_url"], f"C10 video_url must auto-light after boss approval: {c10_after}"

        # 15b. 总经办初审销售工作台视频 gov-sales-vid-01 (pending_gm -> pending_boss) -> 老板终审 (pending_boss -> published)
        code, gm_pass = req_json(base, "/api/governance/review", "POST", {
            "item_id": "gov-sales-vid-01",
            "verdict": "approve",
            "note": "总经办沈悦初审通过，呈老板终审",
        }, extra_headers=gm_hdr)
        assert code == 200 and gm_pass["status"] == "pending_boss"

        code, boss_pass = req_json(base, "/api/governance/review", "POST", {
            "item_id": "gov-sales-vid-01",
            "verdict": "approve",
            "note": "老板终审通过上线",
        }, extra_headers=boss_hdr)
        assert code == 200 and boss_pass["status"] == "published"

        # 15c. 客服主管苏晴针对被打回的 gov-cs-wiki-01 填 "0" 拦截 -> 正常重交 v2 且完整保留 v1 老板驳回意见
        code, gov_zero = req_json(base, "/api/governance/submit", "POST", {
            "item_id": "gov-cs-wiki-01",
            "resource_url": "0",
            "summary_note": "敷衍测试",
        }, extra_headers=sup_cs_hdr)
        assert code == 400 and gov_zero.get("rule_blocked"), f"Governance '0' submission must block: {gov_zero}"

        code, cs_v2 = req_json(base, "/api/governance/submit", "POST", {
            "item_id": "gov-cs-wiki-01",
            "resource_url": "https://docs.example.invalid/demo_cs_refund_v2_with_clawback",
            "summary_note": "已联合采购部补齐 inflow_purchase_refund 因公退券原路冲回主户登记全流程",
        }, extra_headers=sup_cs_hdr)
        assert code == 200 and cs_v2["version_no"] == 2 and cs_v2["status"] == "pending_gm"
        hist = cs_v2["item"]["history"]
        assert len(hist) == 2 and hist[1]["version_no"] == 1 and "inflow_purchase_refund" in hist[1]["boss_note"]

        # 15d. 总经办新建派发一条新的 KPI 缺口槽位并提交口径公式
        code, new_slot = req_json(base, "/api/governance/create-slot", "POST", {
            "workbench_key": "cs",
            "item_type": "kpi",
            "title": "客服夜班值守转化率与差评安抚挽回率 KPI",
            "assignee_staff": "苏晴",
            "priority": "high",
        }, extra_headers=gm_hdr)
        assert code == 200 and new_slot.get("id")
        print("[PASS] Case 15: 六大工作台 Wiki/培训视频/KPI/OKR 派单 -> 提报禁0 -> 总经办初审 -> 老板终审及跨模块视频自动点亮闭环全部验证通过")

        # =====================================================================
        # Case 16: 10 台 64GB Mac Pro (50账号/台·总容量500槽位) 集群健康度台账、50配额硬阻断与一键无损降载验证
        # =====================================================================
        code, boss_boot4 = req_json(base, "/api/bootstrap", "GET", extra_headers=boss_hdr)
        assert code == 200 and boss_boot4["ok"]
        ch = boss_boot4["data"].get("cluster_health") or {}
        ch_sum = ch.get("summary") or {}
        assert ch_sum.get("mac_host_count") == 10, f"Expected 10 Mac Pros, got {ch_sum}"
        assert ch_sum.get("ram_per_host_gb") == 64 and ch_sum.get("total_cluster_ram_gb") == 640, f"Expected 64GBx10=640GB, got {ch_sum}"
        assert ch_sum.get("quota_per_host") == 50 and ch_sum.get("total_account_quota") == 500, f"Expected 50x10=500 slots, got {ch_sum}"
        assert any(g["code"] == "RULE_MACPRO_50_QUOTA" and g["passed"] for g in boss_boot4["data"]["guardrails"])
        # 验证全景图反向穿透字段已注入每家挂载窗口的店铺
        pa_ads = [p for p in boss_boot4["data"]["platform_accounts"] if p.get("adspower_profile_id")]
        assert len(pa_ads) >= 20 and all(p.get("ads_host_code", "").startswith("MAC-PRO-") for p in pa_ads)
        # 验证非老板/非开店主管严禁窥探集群健康数据
        assert (gm_boot["data"].get("cluster_health") or {}) == {}, "GM Office must not see Mac Pro cluster telemetry"

        # 16a. 验证单机账号配额硬阻断：将 MAC-PRO-05 (dev-pc-05，当前承载 1 窗 2 账号 -> 占用 2 槽位) 临时设为上限 2，再挂第 3 个窗口必触发 400 阻断！
        code, q_set = req_json(base, "/api/health/mac-action", "POST", {
            "device_id": "dev-pc-05",
            "action": "update_quota_or_telemetry",
            "max_account_quota": 2,
            "open_windows_now": 1,
            "ram_used_gb": 16.5,
        }, extra_headers=boss_hdr)
        assert code == 200, f"Quota update failed: {q_set}"

        code, quota_blk = req_json(base, "/api/records/adspower_profiles", "POST", {
            "profile_code": "ADS-QUOTA-BLK",
            "ads_serial_no": "299",
            "ads_user_id": "k99quota01",
            "window_name": "超额挂载测试窗口",
            "role_isolation": "marketing_only",
            "host_device_id": "dev-pc-05",
            "proxy_ip_id": "px-16",
        }, extra_headers=boss_hdr)
        assert code == 400 and quota_blk.get("rule_blocked") and "Mac Pro" in quota_blk.get("error", ""), f"Expected Mac Pro quota hard block: {quota_blk}"

        # 恢复 MAC-PRO-05 默认 50 账号配额上限 -> 再次新增窗口立即放行！
        code, _ = req_json(base, "/api/health/mac-action", "POST", {
            "device_id": "dev-pc-05",
            "action": "update_quota_or_telemetry",
            "max_account_quota": 50,
            "open_windows_now": 1,
            "ram_used_gb": 16.5,
        }, extra_headers=boss_hdr)
        assert code == 200
        code, quota_ok = req_json(base, "/api/records/adspower_profiles", "POST", {
            "profile_code": "ADS-QUOTA-OK",
            "ads_serial_no": "299",
            "ads_user_id": "k99quota01",
            "window_name": "恢复50配额后正常新增窗口",
            "role_isolation": "marketing_only",
            "host_device_id": "dev-pc-05",
            "proxy_ip_id": "px-16",
        }, extra_headers=boss_hdr)
        assert code == 200 and quota_ok["ok"], f"Expected window creation after restoring 50 quota: {quota_ok}"

        # 16b. 验证 MAC-PRO-03 (57.6G/64G 内存 + 6.2G Swap 高危) 一键无损清缓存降载 + MAC-PRO-10 唤醒 Local API + 真机 ADB/电池与窗口 Cookie 修复
        code, heal_mac3 = req_json(base, "/api/health/mac-action", "POST", {
            "device_id": "dev-pc-03",
            "action": "clean_cache_reclaim_ram",
        }, extra_headers=boss_hdr)
        assert code == 200 and heal_mac3["ok"], f"MAC-PRO-03 heal failed: {heal_mac3}"

        code, wake_mac10 = req_json(base, "/api/health/mac-action", "POST", {
            "device_id": "dev-pc-10",
            "action": "wake_local_api",
        }, extra_headers=boss_hdr)
        assert code == 200 and wake_mac10["ok"]

        code, sync_win = req_json(base, "/api/health/window-action", "POST", {"profile_id": "ads-07"}, extra_headers=boss_hdr)
        assert code == 200 and sync_win["ok"]

        code, adb_ok = req_json(base, "/api/health/mobile-action", "POST", {"device_id": "dev-ph-15", "action": "confirm_adb_flash"}, extra_headers=boss_hdr)
        assert code == 200 and adb_ok["ok"]

        code, bat_ok = req_json(base, "/api/health/mobile-action", "POST", {"device_id": "dev-ph-12", "action": "mark_battery_serviced"}, extra_headers=boss_hdr)
        assert code == 200 and bat_ok["ok"]

        code, after_heal = req_json(base, "/api/bootstrap", "GET", extra_headers=boss_hdr)
        ah_sum = after_heal["data"]["cluster_health"]["summary"]
        assert ah_sum["critical_host_count"] == 0 and ah_sum["warning_host_count"] == 0 and ah_sum["mobile_alert_count"] == 0, f"All Mac & mobile alerts should be healed: {ah_sum}"
        print("[PASS] Case 16: 10台64GB Mac Pro(50账号/台·总500槽位)健康度台账 + 单机配额硬阻断 + 一键清缓存降载/API唤醒/真机ADB与电池修复闭环验证通过")

        # =====================================================================
        # Case 17: 统一固定资产总账 + 负载温度 + 「物理定位(在司/居家) × 公司受控网」四象限巡检 + 带号带卡禁报废核减验证
        # =====================================================================
        assert ah_sum["total_asset_devices"] == 25 and ah_sum["agreement_signed_count"] == 25
        assert ah_sum["total_asset_cost_fen"] > 35000000, f"Expected >35w asset cost: {ah_sum}"
        assert ah_sum["loc_net_violation_count"] == 2, f"Expected 2 seeded location/corp-net violations: {ah_sum}"
        devs_by_id = {d["id"]: d for d in after_heal["data"]["physical_devices"]}
        # 验证四象限判定精准命中：dev-ph-06 在司断公司网(cellular_5g)、dev-ph-11 未报备离司(14.6km)、dev-ph-14 已批居家+公司VPN合规
        assert devs_by_id["dev-ph-06"]["loc_net_compliance_code"] == "violation_office_no_corp_net"
        assert devs_by_id["dev-ph-11"]["loc_net_compliance_code"] == "violation_unapproved_offsite"
        assert devs_by_id["dev-ph-14"]["loc_net_compliance_code"] == "compliant_wfh"
        assert any(g["code"] == "RULE_ASSET_RETIRE_UNBIND" and g["passed"] for g in after_heal["data"]["guardrails"])

        # 17a. 一键处置违规1 (dev-ph-06 强制切回公司Wi-Fi) 与 违规2 (dev-ph-11 补批居家办公并拨通公司VPN) -> 违规归零！
        code, fix_wifi = req_json(base, "/api/assets/compliance-action", "POST", {
            "device_id": "dev-ph-06",
            "action": "enforce_corp_wifi",
        }, extra_headers=boss_hdr)
        assert code == 200 and fix_wifi["ok"], f"Enforce corp wifi failed: {fix_wifi}"

        code, fix_wfh = req_json(base, "/api/assets/compliance-action", "POST", {
            "device_id": "dev-ph-11",
            "action": "approve_wfh_vpn",
            "wfh_approval_ref": "OA-WFH-20261118-99",
        }, extra_headers=boss_hdr)
        assert code == 200 and fix_wfh["ok"]
        assert fix_wfh["cluster_health"]["summary"]["loc_net_violation_count"] == 0, "All loc/net violations should be resolved!"

        # 17b. 验证带卡/带店铺设备申请报废或转二手售卖被硬拦截 (dev-ph-01 仍插卡且绑号 -> HTTP 400)；空闲未绑设备 (dev-pc-09) 正常放行！
        code, ret_blk = req_json(base, "/api/assets/retire-request", "POST", {
            "device_id": "dev-ph-01",
            "target_action": "transfer_to_resale_sku",
            "reason": "违规带卡带店转卖测试",
        }, extra_headers=boss_hdr)
        assert code == 400 and ret_blk.get("rule_blocked"), f"Bound device retirement must be hard-blocked: {ret_blk}"

        code, ret_ok = req_json(base, "/api/assets/retire-request", "POST", {
            "device_id": "dev-pc-09",
            "target_action": "scrap_retire",
            "reason": "空闲未绑窗口备机调拨核减测试",
        }, extra_headers=boss_hdr)
        assert code == 200 and ret_ok["ok"] and ret_ok.get("request_no"), f"Unbound standby retirement should succeed: {ret_ok}"
        print("[PASS] Case 17: 固定资产三账合一 + 实时负载温度 +『定位(在司/居家)×公司受控网』四象限管控 + 带卡带号禁报废核减全部验证通过")

        print("\nALL 17 VERIFICATION SUITES PASSED WITH ZERO FAILURES.")
    finally:
        proc.terminate()
        proc.wait(timeout=5)
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    main()

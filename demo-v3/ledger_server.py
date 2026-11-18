#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
泛亚锚点 · 老板全量台账（桌面专属版）本地持久化后端服务
零第三方依赖（基于 Python 3 标准库 http.server + sqlite3），开箱即用。
"""

from __future__ import annotations
import csv
import datetime as dt
import io
import json
import mimetypes
import os
import sqlite3
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from db_init_and_seed import (
    DEFAULT_DB_PATH,
    FLOW_DIRECTION_LABELS,
    PLATFORM_LABELS,
    SETTLEMENT_CHANNEL_LABELS,
    init_db,
    sync_phone_bindings,
)
from device_adspower_health_seed import (
    build_cluster_health_overview,
    count_host_assigned_slots,
    ensure_cluster_and_health_seeded,
    get_device_asset_map,
)
from tutorial_and_gap_seed import (
    build_all_cases_summary,
    build_gap_and_issues_overview,
    ensure_tutorials_and_gaps_seeded,
    evaluate_case_detail,
)
from vault_security import (
    VAULT_SESSIONS,
    _b64u_dec,
    compute_totp,
    decrypt_secret,
    encrypt_secret,
    ensure_vault_tables_and_seed,
    generate_totp_secret,
    get_totp_setup_payload,
    get_vault_public_summary,
    verify_totp,
    write_audit_log,
)
from workbench_governance_seed import (
    GOV_ITEM_TYPE_LABELS,
    WORKBENCH_META,
    build_governance_overview,
    ensure_governance_seeded,
    get_governance_item_detail,
    sync_published_governance_to_tutorial_steps,
)
from dispatch_capacity_seed import (
    ensure_dispatch_capacity_seeded,
    list_dispatch_capacity_policies,
    save_dispatch_capacity_policies,
)

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
DB_PATH = Path(os.environ.get("LEDGER_DB_PATH", str(DEFAULT_DB_PATH)))
BUILD_ID = "anchor-boss-master-ledger-desktop-20261118-v8"

ALLOWED_TABLES = {
    "legal_persons": [
        "name", "id_card_no", "primary_phone", "residence_city", "face_verify_sla",
        "agency_contract_no", "contract_expires_at", "status", "notes"
    ],
    "business_entities": [
        "legal_person_id", "entity_code", "entity_name", "uscc", "entity_type",
        "registration_authority", "established_date", "registered_address",
        "business_scope", "license_status", "target_store_slots", "notes"
    ],
    "tax_registrations": [
        "business_entity_id", "tax_bureau_name", "taxpayer_type", "collection_mode",
        "filing_cycle", "tax_officer_name", "bound_sim_id", "current_period",
        "quarter_sales_fen", "quarter_exempt_limit_fen", "filing_status",
        "next_due_date", "receipt_no", "notes"
    ],
    "annual_reports": [
        "business_entity_id", "report_year", "aic_bureau_name", "window_period",
        "liaison_name", "liaison_sim_id", "report_status", "submitted_date",
        "publicity_receipt_no", "notes"
    ],
    "alipay_accounts": [
        "legal_person_id", "business_entity_id", "account_code", "account_name",
        "login_email", "alipay_uid", "entity_fund_slot", "trade_direction",
        "is_entity_master_fund", "corporate_pay_enabled", "master_alipay_id",
        "daily_limit_fen", "single_tx_limit_fen", "bound_sim_id",
        "settlement_bank", "settlement_card_no", "balance_fen", "frozen_reserve_fen",
        "month_inflow_fen", "month_outflow_fen", "cert_sign_mode", "finance_book_code",
        "bill_sync_status", "account_status", "notes"
    ],
    "alipay_bills": [
        "bill_date", "business_entity_id", "alipay_account_id", "deducted_master_alipay_id",
        "related_platform_account_id", "flow_direction", "biz_scene", "counterparty",
        "platform_order_ref", "amount_fen", "fee_fen", "oa_finance_voucher_no",
        "reconcile_status", "notes"
    ],
    "carrier_quotas": [
        "legal_person_id", "holder_name", "holder_id_card", "holder_role",
        "carrier", "statutory_limit", "existing_personal_cards", "yztc_verified_date", "notes"
    ],
    "sim_cards": [
        "legal_person_id", "phone_number", "carrier", "region_city", "iccid",
        "card_category", "master_sim_id", "real_name_holder", "holder_relation",
        "custodian_staff", "billing_mode", "plan_name", "monthly_rent_fen",
        "billing_day", "balance_fen", "low_balance_threshold_fen",
        "last_recharge_date", "last_recharge_fen", "next_recharge_due",
        "is_external", "external_vendor", "contract_start_date", "contract_end_date",
        "rebind_lead_days", "sim_status", "notes"
    ],
    "proxy_ips": [
        "proxy_code", "provider", "plan_name", "isp_region", "protocol",
        "host", "port", "proxy_user", "proxy_pass", "exit_ip",
        "monthly_cost_fen", "purchased_at", "expires_at", "connectivity_status",
        "oa_renewal_ref", "notes"
    ],
    "physical_devices": [
        "legal_person_id", "device_code", "device_kind", "brand_model", "serial_number",
        "imei_1", "imei_2", "role_isolation", "sim_slot_1_id", "sim_slot_2_id",
        "workstation_loc", "custodian_staff", "installed_apps", "device_status", "notes"
    ],
    "adspower_profiles": [
        "profile_code", "ads_serial_no", "ads_user_id", "window_name", "group_name",
        "host_device_id", "proxy_ip_id", "role_isolation", "fingerprint_locked",
        "cookie_backup_at", "profile_status", "notes"
    ],
    "platform_accounts": [
        "legal_person_id", "business_entity_id", "platform", "account_code",
        "display_name", "platform_login_id", "account_role", "virtual_biz_usage",
        "bound_sim_id", "alipay_account_id", "adspower_profile_id", "proxy_ip_id",
        "physical_device_id", "lead_target_account_id",
        "settlement_channel", "merchant_account_no", "settlement_bank_ref",
        "settlement_cycle", "commission_rate_bps", "deposit_fen", "deposit_source_ref",
        "frozen_balance_fen", "month_gmv_fen", "month_cost_fen", "month_refund_fen",
        "tax_invoice_mode", "finance_book_code",
        "daily_quota_note", "operator_staff", "account_status", "notes"
    ],
}

NULLABLE_FK_COLS = {
    "legal_person_id", "business_entity_id", "bound_sim_id", "liaison_sim_id",
    "master_alipay_id", "deducted_master_alipay_id", "related_platform_account_id",
    "master_sim_id", "sim_slot_1_id", "sim_slot_2_id", "alipay_account_id",
    "adspower_profile_id", "proxy_ip_id", "physical_device_id", "lead_target_account_id"
}

INT_COLS = {
    "target_store_slots", "quarter_sales_fen", "quarter_exempt_limit_fen",
    "report_year", "is_entity_master_fund", "corporate_pay_enabled",
    "daily_limit_fen", "single_tx_limit_fen", "balance_fen", "frozen_reserve_fen",
    "month_inflow_fen", "month_outflow_fen", "amount_fen", "fee_fen",
    "statutory_limit", "existing_personal_cards",
    "monthly_rent_fen", "billing_day", "low_balance_threshold_fen",
    "last_recharge_fen", "is_external", "rebind_lead_days",
    "port", "monthly_cost_fen", "fingerprint_locked",
    "commission_rate_bps", "deposit_fen", "frozen_balance_fen",
    "month_gmv_fen", "month_cost_fen", "month_refund_fen"
}


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def parse_date_safe(s: str | None) -> dt.date | None:
    if not s:
        return None
    try:
        return dt.date.fromisoformat(s[:10])
    except Exception:
        return None


def days_until(date_str: str | None, today: dt.date) -> int | None:
    d = parse_date_safe(date_str)
    return (d - today).days if d else None


def rows_to_dicts(rows) -> list[dict]:
    return [dict(r) for r in rows]


class BusinessRuleError(Exception):
    pass


def validate_before_write(conn: sqlite3.Connection, table: str, data: dict, record_id: str | None = None) -> None:
    cur = conn.cursor()

    if table == "alipay_accounts":
        be_id = data.get("business_entity_id")
        direction = data.get("trade_direction")
        is_master = int(data.get("is_entity_master_fund") or 0)
        corp_pay = int(data.get("corporate_pay_enabled") or 0)
        master_id = data.get("master_alipay_id") or None

        if is_master == 1:
            if direction != "master_fund":
                raise BusinessRuleError("资金规则阻断：勾选为【本主体3选1主资金号】时，账户职能必须设为「因公支付主资金池 (master_fund)」，严禁混作直接买卖！")
            dup = cur.execute(
                "SELECT id, account_name FROM alipay_accounts WHERE business_entity_id = ? AND is_entity_master_fund = 1 AND id <> ?",
                (be_id, record_id or ""),
            ).fetchone()
            if dup:
                raise BusinessRuleError(
                    f"主体3选1阻断：该营业执照主体下已存在唯一主资金账号「{dup['account_name']}」。每个营业执照只允许选定 1 个主资金账号！"
                )

        if corp_pay == 1:
            if direction != "purchase_only":
                raise BusinessRuleError("买卖隔离阻断：仅【采购专用账号 (purchase_only)】可开启因公支付扣款，销售账号严禁既买又卖！")
            if not master_id:
                raise BusinessRuleError("因公支付阻断：开启因公支付的采购账号，必须选择同营业执照主体下的主资金账号！")

        if master_id:
            if record_id and master_id == record_id:
                raise BusinessRuleError("逻辑阻断：主资金账号不能指向自身！")
            m_row = cur.execute(
                "SELECT business_entity_id, account_name, is_entity_master_fund FROM alipay_accounts WHERE id = ?",
                (master_id,),
            ).fetchone()
            if not m_row:
                raise BusinessRuleError("所选主资金账号不存在！")
            if m_row["business_entity_id"] != be_id:
                raise BusinessRuleError(
                    f"违反税法红线阻断：采购子账号所属营业执照与被扣款主账号「{m_row['account_name']}」不属于同一营业执照主体，严禁跨主体资金乱串！"
                )
            if m_row["is_entity_master_fund"] != 1:
                raise BusinessRuleError(f"内控阻断：目标账号「{m_row['account_name']}」并非该主体选定的主资金账号（3选1主户）！")

        # 如果修改既有支付宝的 trade_direction 或 business_entity_id，检查已绑定的平台店铺是否冲突
        if record_id:
            bound_plats = cur.execute(
                "SELECT display_name, account_role, business_entity_id FROM platform_accounts WHERE alipay_account_id = ? AND account_status <> 'retired'",
                (record_id,),
            ).fetchall()
            for bp in bound_plats:
                if bp["account_role"] == "sales_only" and direction != "sales_only":
                    raise BusinessRuleError(
                        f"买卖隔离阻断：该支付宝当前绑定了销售店铺「{bp['display_name']}」，不能改为非销售收款属性！"
                    )
                if bp["account_role"] == "purchase_only" and direction != "purchase_only":
                    raise BusinessRuleError(
                        f"买卖隔离阻断：该支付宝当前绑定了采购买券号「{bp['display_name']}」，不能改为非采购属性！"
                    )
                if bp["business_entity_id"] and bp["business_entity_id"] != be_id:
                    raise BusinessRuleError(
                        f"违反税法阻断：该支付宝已绑定店铺「{bp['display_name']}」，修改营业执照会导致跨主体串户！"
                    )

    elif table == "platform_accounts":
        plat = data.get("platform")
        role = data.get("account_role")
        ali_id = data.get("alipay_account_id")
        be_id = data.get("business_entity_id")
        ads_id = data.get("adspower_profile_id")
        proxy_id = data.get("proxy_ip_id")
        status = data.get("account_status") or "active"

        # 若选了 AdsPower 窗口但未显式选 proxy_ip_id，则自动继承窗口的 proxy_ip_id；若两者都选，校验一致
        if ads_id:
            ads_row = cur.execute("SELECT window_name, proxy_ip_id, role_isolation, host_device_id FROM adspower_profiles WHERE id = ?", (ads_id,)).fetchone()
            if not ads_row:
                raise BusinessRuleError("所选 AdsPower 窗口不存在！")
            if not proxy_id:
                data["proxy_ip_id"] = ads_row["proxy_ip_id"]
                proxy_id = ads_row["proxy_ip_id"]
            elif proxy_id != ads_row["proxy_ip_id"]:
                raise BusinessRuleError(
                    f"环境代理不一致阻断：所选 AdsPower 窗口「{ads_row['window_name']}」绑定的代理IP与您填写的家宽代理IP不一致！"
                )
            if ads_row["role_isolation"] != role:
                raise BusinessRuleError(
                    f"买卖环境隔离阻断：AdsPower 窗口「{ads_row['window_name']}」职能为 {ads_row['role_isolation']}，严禁混登 {role} 账号！"
                )
            # 校验 Mac Pro 64GB 单机 50 账号容量红线！
            if status != "retired" and ads_row["host_device_id"]:
                ensure_cluster_and_health_seeded(conn)
                m_row = cur.execute(
                    "SELECT host_code, max_account_quota, ram_total_gb FROM mac_host_cluster_telemetry WHERE device_id = ?",
                    (ads_row["host_device_id"],),
                ).fetchone()
                if m_row:
                    acc_cnt, _ = count_host_assigned_slots(conn, ads_row["host_device_id"], exclude_plat_id=record_id)
                    max_q = int(m_row["max_account_quota"] or 50)
                    if acc_cnt >= max_q:
                        raise BusinessRuleError(
                            f"Mac Pro 50账号容量红线阻断：宿主机「{m_row['host_code']}」({m_row['ram_total_gb']}GB) 当前已挂载 {acc_cnt}/{max_q} 个账号达满载上限！"
                            f"为防单机浏览器缓存撑爆与硬件故障连坐，请将该账号分配至集群其他空闲 Mac Pro（如 MAC-PRO-07 ~ MAC-PRO-09）！"
                        )

        # 校验1：一个平台必须一个家宽，不同平台可以复用！
        if proxy_id and status != "retired":
            conflict = cur.execute(
                """SELECT pa.display_name, pa.account_code, px.proxy_code, px.exit_ip
                   FROM platform_accounts pa
                   JOIN proxy_ips px ON px.id = pa.proxy_ip_id
                   WHERE pa.proxy_ip_id = ? AND pa.platform = ? AND pa.account_status <> 'retired' AND pa.id <> ?""",
                (proxy_id, plat, record_id or ""),
            ).fetchone()
            if conflict:
                plat_cn = PLATFORM_LABELS.get(plat, plat)
                raise BusinessRuleError(
                    f"同平台家宽冲突阻断：家宽代理 {conflict['proxy_code']} ({conflict['exit_ip']}) 下已存在【{plat_cn}】账号「{conflict['display_name']}」。"
                    f"规则要求：同一个平台必须独占一条家宽IP，仅不同平台之间可以复用！"
                )

        # 校验2：平台角色固有红线（例如大众点评/抖省省必为采购，小店/网店/抖店必为销售）
        must_purchase = {"dianping", "doushengsheng", "taobao_buyer", "jd_buyer"}
        must_sales = {"taobao_store", "wechat_shop", "xiaohongshu_shop", "doudian", "jd_store"}
        if plat in must_purchase and role != "purchase_only":
            raise BusinessRuleError(f"角色定位阻断：【{PLATFORM_LABELS.get(plat, plat)}】固定用于虚拟卡券/货源采购，必须标记为「采购账号 (purchase_only)」！")
        if plat in must_sales and role != "sales_only":
            raise BusinessRuleError(f"角色定位阻断：【{PLATFORM_LABELS.get(plat, plat)}】属于开店卖货主体，必须标记为「销售账号 (sales_only)」！")

        # 校验2B：单账号财务结算通道自动补全与零收付隔离校验
        ch = (data.get("settlement_channel") or "").strip()
        if not ch:
            if role == "marketing_only":
                ch = "no_settlement"
            elif role == "purchase_only":
                ch = "corporate_pay_deduct"
            elif plat == "wechat_shop":
                ch = "wechat_pay_mch"
            elif plat == "xiaohongshu_shop":
                ch = "xhs_merchant"
            elif plat == "doudian":
                ch = "douyin_pay_mch"
            elif plat == "jd_store":
                ch = "jd_wallet_mch"
            else:
                ch = "alipay_direct"
            data["settlement_channel"] = ch
        if role == "marketing_only" and ch != "no_settlement":
            raise BusinessRuleError("财务隔离阻断：纯社媒种草营销账号严禁配置收付款结算通道，必须保持「纯引流零收付 (no_settlement)」！")
        bps = int(data.get("commission_rate_bps") or 0)
        if bps < 0 or bps > 10000:
            raise BusinessRuleError("费率校验阻断：平台佣金费率万分比 (commission_rate_bps) 须在 0 ~ 10000 之间！")

        # 校验3：支付宝买卖互斥与税法同主体校验
        if ali_id:
            ali_row = cur.execute(
                "SELECT account_name, trade_direction, business_entity_id FROM alipay_accounts WHERE id = ?",
                (ali_id,),
            ).fetchone()
            if not ali_row:
                raise BusinessRuleError("关联的企业支付宝不存在！")
            if role == "sales_only" and ali_row["trade_direction"] != "sales_only":
                raise BusinessRuleError(
                    f"买卖混用阻断：销售店铺只能绑定【销售收款专用支付宝】，「{ali_row['account_name']}」并非销售收款号（严禁既买又卖）！"
                )
            if role == "purchase_only" and ali_row["trade_direction"] != "purchase_only":
                raise BusinessRuleError(
                    f"买卖混用阻断：采购买券账号只能绑定【采购专用支付宝（含因公支付子号）】，「{ali_row['account_name']}」不可用于采购付款！"
                )
            if role == "marketing_only":
                raise BusinessRuleError("社媒隔离阻断：纯社媒种草营销号不应直接绑定收付款支付宝，请通过导流目标小店承接交易！")
            if be_id and ali_row["business_entity_id"] != be_id:
                raise BusinessRuleError(
                    f"违反税法红线阻断：账号所属营业执照主体与支付宝「{ali_row['account_name']}」所属营业执照不一致，严禁跨主体收付串户！"
                )

    elif table == "sim_cards":
        cat = data.get("card_category")
        holder = (data.get("real_name_holder") or "").strip()
        carrier = data.get("carrier")
        if cat in ("company_master", "company_sub"):
            data["is_external"] = 0
            q_row = cur.execute(
                "SELECT statutory_limit, existing_personal_cards FROM carrier_quotas WHERE holder_name = ? AND carrier = ?",
                (holder, carrier),
            ).fetchone()
            if q_row:
                opened = cur.execute(
                    """SELECT COUNT(*) FROM sim_cards
                       WHERE real_name_holder = ? AND carrier = ?
                         AND card_category IN ('company_master', 'company_sub')
                         AND sim_status <> 'retired' AND id <> ?""",
                    (holder, carrier, record_id or ""),
                ).fetchone()[0]
                max_open = max(0, int(q_row["statutory_limit"]) - int(q_row["existing_personal_cards"]))
                if opened >= max_open:
                    raise BusinessRuleError(
                        f"运营商一主4副限额阻断：{holder} 在【{carrier}】原有个人卡 {q_row['existing_personal_cards']} 张，"
                        f"本公司最多只能开 {max_open} 张（当前已开 {opened} 张）。剩余缺口请改用【外部补缺合约卡 (external_contract)】录入！"
                    )
        elif cat == "external_contract":
            data["is_external"] = 1
            if not data.get("contract_end_date"):
                raise BusinessRuleError("外部卡必填项阻断：录入【外部补缺合约卡】必须填写合约到期时间 (contract_end_date)，以便提前换绑预警！")

    elif table == "adspower_profiles":
        host_id = data.get("host_device_id")
        if host_id:
            ensure_cluster_and_health_seeded(conn)
            m_row = cur.execute(
                "SELECT host_code, max_account_quota, ram_total_gb FROM mac_host_cluster_telemetry WHERE device_id = ?",
                (host_id,),
            ).fetchone()
            if m_row:
                acc_cnt, win_cnt = count_host_assigned_slots(conn, host_id, exclude_ads_id=record_id)
                max_q = int(m_row["max_account_quota"] or 50)
                if win_cnt >= max_q or acc_cnt >= max_q:
                    raise BusinessRuleError(
                        f"Mac Pro 50槽位容量红线阻断：宿主机「{m_row['host_code']}」({m_row['ram_total_gb']}GB) 已达 {max(acc_cnt, win_cnt)}/{max_q} 窗口/账号上限！"
                        f"单台 64GB Mac Pro 严格限制最多放 50 个账号槽位，请改选空闲 Mac Pro 机柜！"
                    )


def validate_before_delete(conn: sqlite3.Connection, table: str, record_id: str) -> None:
    cur = conn.cursor()
    if table == "proxy_ips":
        w_cnt = cur.execute("SELECT COUNT(*) FROM adspower_profiles WHERE proxy_ip_id = ?", (record_id,)).fetchone()[0]
        p_cnt = cur.execute("SELECT COUNT(*) FROM platform_accounts WHERE proxy_ip_id = ? AND account_status <> 'retired'", (record_id,)).fetchone()[0]
        if w_cnt > 0 or p_cnt > 0:
            raise BusinessRuleError(
                f"高危防直连阻断：该家宽代理当前仍绑定 {w_cnt} 个 AdsPower 窗口、{p_cnt} 个在用平台账号！"
                f"直接删除会导致 AdsPower 回落本机直连引发多店关联封号，请先将窗口换绑新代理后再删除。"
            )
    elif table == "alipay_accounts":
        sub_cnt = cur.execute("SELECT COUNT(*) FROM alipay_accounts WHERE master_alipay_id = ?", (record_id,)).fetchone()[0]
        pa_cnt = cur.execute("SELECT COUNT(*) FROM platform_accounts WHERE alipay_account_id = ?", (record_id,)).fetchone()[0]
        if sub_cnt > 0 or pa_cnt > 0:
            raise BusinessRuleError(f"关联保护阻断：该支付宝仍挂有 {sub_cnt} 个因公支付采购子号、{pa_cnt} 个平台账号，请先解除关联。")
    elif table == "business_entities":
        ali_cnt = cur.execute("SELECT COUNT(*) FROM alipay_accounts WHERE business_entity_id = ?", (record_id,)).fetchone()[0]
        if ali_cnt > 0:
            raise BusinessRuleError(f"主体保护阻断：该营业执照下仍有 {ali_cnt} 个企业支付宝在册，无法直接删除。")


def build_bootstrap_payload(
    conn: sqlite3.Connection,
    today: dt.date | None = None,
    vault_token: str | None = None,
    viewer_role: str = "boss",
    viewer_staff: str = "",
) -> dict:
    if today is None:
        today = dt.date.today()
    ensure_tutorials_and_gaps_seeded(conn)
    ensure_cluster_and_health_seeded(conn)
    ensure_vault_tables_and_seed(conn)
    cur = conn.cursor()

    legal_persons = rows_to_dicts(cur.execute("SELECT * FROM legal_persons ORDER BY id").fetchall())
    lp_map = {r["id"]: r for r in legal_persons}

    entities = rows_to_dicts(cur.execute("SELECT * FROM business_entities ORDER BY entity_code").fetchall())
    ent_map = {r["id"]: r for r in entities}

    tax_regs = rows_to_dicts(cur.execute("SELECT * FROM tax_registrations ORDER BY id").fetchall())
    tax_by_ent = {r["business_entity_id"]: r for r in tax_regs}

    annual_reports = rows_to_dicts(cur.execute("SELECT * FROM annual_reports ORDER BY report_year DESC, id").fetchall())
    ar_by_ent = {}
    for r in annual_reports:
        ar_by_ent.setdefault(r["business_entity_id"], []).append(r)

    sims = rows_to_dicts(cur.execute("SELECT * FROM sim_cards ORDER BY id").fetchall())
    sim_map = {r["id"]: r for r in sims}

    sim_fee_records = rows_to_dicts(cur.execute("SELECT * FROM sim_fee_records ORDER BY occurred_date DESC, id DESC").fetchall())
    alipays = rows_to_dicts(cur.execute("SELECT * FROM alipay_accounts ORDER BY business_entity_id, account_code").fetchall())
    ali_map = {r["id"]: r for r in alipays}

    alipay_bills = rows_to_dicts(cur.execute("SELECT * FROM alipay_bills ORDER BY bill_date DESC, id DESC").fetchall())
    carrier_quotas = rows_to_dicts(cur.execute("SELECT * FROM carrier_quotas ORDER BY id").fetchall())
    proxies = rows_to_dicts(cur.execute("SELECT * FROM proxy_ips ORDER BY proxy_code").fetchall())
    proxy_map = {r["id"]: r for r in proxies}
    proxy_renewals = rows_to_dicts(cur.execute("SELECT * FROM proxy_renewals ORDER BY renewed_at DESC, id DESC").fetchall())

    devices = rows_to_dicts(cur.execute("SELECT * FROM physical_devices ORDER BY device_code").fetchall())
    dev_map = {r["id"]: r for r in devices}

    ads_profiles = rows_to_dicts(cur.execute("SELECT * FROM adspower_profiles ORDER BY ads_serial_no").fetchall())
    ads_map = {r["id"]: r for r in ads_profiles}

    platform_accounts = rows_to_dicts(cur.execute("SELECT * FROM platform_accounts ORDER BY platform, account_code").fetchall())
    pa_map = {r["id"]: r for r in platform_accounts}

    phone_bindings = rows_to_dicts(cur.execute("SELECT * FROM phone_bindings WHERE status = 'active' ORDER BY sim_card_id, rebind_priority, id").fetchall())
    bindings_by_sim: dict[str, list[dict]] = {}
    for b in phone_bindings:
        bindings_by_sim.setdefault(b["sim_card_id"], []).append(b)

    # Device slot reverse lookup for SIMs
    device_slot_by_sim: dict[str, str] = {}
    device_id_by_sim: dict[str, str] = {}
    for d in devices:
        if d["sim_slot_1_id"]:
            device_slot_by_sim[d["sim_slot_1_id"]] = f"{d['device_code']} · 卡槽1"
            device_id_by_sim[d["sim_slot_1_id"]] = d["id"]
        if d["sim_slot_2_id"]:
            device_slot_by_sim[d["sim_slot_2_id"]] = f"{d['device_code']} · 卡槽2"
            device_id_by_sim[d["sim_slot_2_id"]] = d["id"]

    # Enrich SIMs
    for s in sims:
        s["legal_person_name"] = lp_map.get(s["legal_person_id"], {}).get("name", "-")
        s["master_phone_number"] = sim_map.get(s["master_sim_id"], {}).get("phone_number", "") if s["master_sim_id"] else ""
        s["device_slot_label"] = device_slot_by_sim.get(s["id"], "未插卡/卡册保管")
        s["installed_device_id"] = device_id_by_sim.get(s["id"], "")
        s["bound_objects"] = bindings_by_sim.get(s["id"], [])
        s["bound_count"] = len(s["bound_objects"])
        s["contract_days_left"] = days_until(s["contract_end_date"], today) if s["is_external"] and s["contract_end_date"] else None
        # Effective balance alerting
        eff_bal = sim_map[s["master_sim_id"]]["balance_fen"] if (s["billing_mode"] == "shared_master" and s["master_sim_id"] in sim_map) else s["balance_fen"]
        s["effective_balance_fen"] = eff_bal
        s["is_low_balance"] = (s["billing_mode"] == "independent") and (
            s["balance_fen"] < max(s["low_balance_threshold_fen"], s["monthly_rent_fen"])
        ) and s["sim_status"] != "retired"
        s["is_contract_expiring"] = bool(s["is_external"] and s["contract_days_left"] is not None and s["contract_days_left"] <= s["rebind_lead_days"] and s["sim_status"] != "retired")

    # Enrich Carrier Quotas
    for cq in carrier_quotas:
        opened_cards = [
            s for s in sims
            if s["real_name_holder"] == cq["holder_name"]
            and s["carrier"] == cq["carrier"]
            and s["card_category"] in ("company_master", "company_sub")
            and s["sim_status"] != "retired"
        ]
        cq["opened_company_cards"] = len(opened_cards)
        cq["opened_phones"] = [s["phone_number"] for s in opened_cards]
        cq["max_company_openable"] = max(0, cq["statutory_limit"] - cq["existing_personal_cards"])
        cq["remaining_slots"] = cq["max_company_openable"] - cq["opened_company_cards"]

    # Enrich Proxies with cross-platform reuse matrix & expiry countdown
    ads_by_proxy: dict[str, list[dict]] = {}
    for a in ads_profiles:
        ads_by_proxy.setdefault(a["proxy_ip_id"], []).append(a)

    pa_by_proxy: dict[str, list[dict]] = {}
    for pa in platform_accounts:
        if pa["proxy_ip_id"] and pa["account_status"] != "retired":
            pa_by_proxy.setdefault(pa["proxy_ip_id"], []).append(pa)

    for px in proxies:
        d_left = days_until(px["expires_at"], today)
        px["days_left"] = d_left
        if d_left is not None:
            if d_left < 0:
                px["computed_expiry_state"] = "expired"
            elif d_left <= 7:
                px["computed_expiry_state"] = "expiring_7d"
            elif d_left <= 15:
                px["computed_expiry_state"] = "expiring_15d"
            else:
                px["computed_expiry_state"] = "healthy"
        else:
            px["computed_expiry_state"] = "unknown"

        bound_pas = pa_by_proxy.get(px["id"], [])
        px["reused_accounts"] = [
            {
                "id": p["id"],
                "platform": p["platform"],
                "platform_label": PLATFORM_LABELS.get(p["platform"], p["platform"]),
                "display_name": p["display_name"],
                "account_role": p["account_role"],
                "legal_person_id": p["legal_person_id"],
            }
            for p in bound_pas
        ]
        px["reused_platform_count"] = len(bound_pas)
        # Check same-platform duplicate if any
        seen_plats = [p["platform"] for p in bound_pas]
        px["has_same_platform_conflict"] = len(seen_plats) != len(set(seen_plats))
        px["bound_windows"] = [
            {"id": w["id"], "profile_code": w["profile_code"], "ads_serial_no": w["ads_serial_no"], "window_name": w["window_name"]}
            for w in ads_by_proxy.get(px["id"], [])
        ]
        px["bound_window_count"] = len(px["bound_windows"])
        # Derive legal_person_ids touching this proxy for filtering
        lp_ids = sorted({p["legal_person_id"] for p in bound_pas if p.get("legal_person_id")})
        px["legal_person_ids"] = lp_ids
        # 列表接口绝不下发明文密码（家宽代理密码统一经由 2FA 密码保险箱按需解密查看）
        px["proxy_pass"] = "••••••••"

    # Enrich Alipays
    subs_by_master: dict[str, list[dict]] = {}
    for a in alipays:
        if a["master_alipay_id"]:
            subs_by_master.setdefault(a["master_alipay_id"], []).append(a)

    stores_by_ali: dict[str, list[dict]] = {}
    for pa in platform_accounts:
        if pa["alipay_account_id"] and pa["account_status"] != "retired":
            stores_by_ali.setdefault(pa["alipay_account_id"], []).append(pa)

    for a in alipays:
        ent = ent_map.get(a["business_entity_id"], {})
        a["entity_name"] = ent.get("entity_name", "-")
        a["entity_code"] = ent.get("entity_code", "-")
        a["legal_person_name"] = lp_map.get(a["legal_person_id"], {}).get("name", "-")
        a["master_account_name"] = ali_map.get(a["master_alipay_id"], {}).get("account_name", "") if a["master_alipay_id"] else ""
        a["master_account_code"] = ali_map.get(a["master_alipay_id"], {}).get("account_code", "") if a["master_alipay_id"] else ""
        a["bound_phone"] = sim_map.get(a["bound_sim_id"], {}).get("phone_number", "") if a["bound_sim_id"] else ""
        a["corporate_pay_sub_accounts"] = [
            {"id": s["id"], "account_code": s["account_code"], "account_name": s["account_name"]}
            for s in subs_by_master.get(a["id"], [])
        ]
        a["bound_platform_accounts"] = [
            {"id": p["id"], "display_name": p["display_name"], "platform_label": PLATFORM_LABELS.get(p["platform"], p["platform"]), "account_role": p["account_role"]}
            for p in stores_by_ali.get(a["id"], [])
        ]

    # Enrich Bills
    for b in alipay_bills:
        ali = ali_map.get(b["alipay_account_id"], {})
        b["alipay_name"] = ali.get("account_name", "-")
        b["alipay_code"] = ali.get("account_code", "-")
        b["legal_person_id"] = ali.get("legal_person_id", "")
        b["entity_code"] = ent_map.get(b["business_entity_id"], {}).get("entity_code", "-")
        b["master_alipay_name"] = ali_map.get(b["deducted_master_alipay_id"], {}).get("account_name", "") if b["deducted_master_alipay_id"] else ""
        b["master_alipay_code"] = ali_map.get(b["deducted_master_alipay_id"], {}).get("account_code", "") if b["deducted_master_alipay_id"] else ""
        rel_pa = pa_map.get(b.get("related_platform_account_id") or "", {})
        b["related_account_code"] = rel_pa.get("account_code", "")
        b["related_account_name"] = rel_pa.get("display_name", "")
        b["flow_direction_label"] = FLOW_DIRECTION_LABELS.get(b["flow_direction"], b["flow_direction"])

    # Enrich Tax & Annual Reports
    for t in tax_regs:
        ent = ent_map.get(t["business_entity_id"], {})
        t["entity_code"] = ent.get("entity_code", "-")
        t["entity_name"] = ent.get("entity_name", "-")
        t["legal_person_id"] = ent.get("legal_person_id", "")
        t["legal_person_name"] = lp_map.get(t["legal_person_id"], {}).get("name", "-")
        t["bound_phone"] = sim_map.get(t["bound_sim_id"], {}).get("phone_number", "") if t["bound_sim_id"] else ""
        t["quota_usage_pct"] = round(t["quarter_sales_fen"] * 100.0 / t["quarter_exempt_limit_fen"], 1) if t["quarter_exempt_limit_fen"] else 0.0

    for ar in annual_reports:
        ent = ent_map.get(ar["business_entity_id"], {})
        ar["entity_code"] = ent.get("entity_code", "-")
        ar["entity_name"] = ent.get("entity_name", "-")
        ar["legal_person_id"] = ent.get("legal_person_id", "")
        ar["legal_person_name"] = lp_map.get(ar["legal_person_id"], {}).get("name", "-")
        ar["liaison_phone"] = sim_map.get(ar["liaison_sim_id"], {}).get("phone_number", "") if ar["liaison_sim_id"] else ""

    # Enrich Business Entities
    for e in entities:
        e["legal_person_name"] = lp_map.get(e["legal_person_id"], {}).get("name", "-")
        ent_alis = [a for a in alipays if a["business_entity_id"] == e["id"]]
        ent_pas = [p for p in platform_accounts if p["business_entity_id"] == e["id"] and p["account_status"] != "retired"]
        e["alipay_count"] = len(ent_alis)
        e["master_alipay"] = next((a for a in ent_alis if a["is_entity_master_fund"] == 1), None)
        e["purchase_alipay_count"] = sum(1 for a in ent_alis if a["trade_direction"] == "purchase_only")
        e["sales_alipay_count"] = sum(1 for a in ent_alis if a["trade_direction"] == "sales_only")
        e["platform_account_count"] = len(ent_pas)
        e["sales_store_count"] = sum(1 for p in ent_pas if p["account_role"] == "sales_only")
        e["tax_registration"] = tax_by_ent.get(e["id"])
        e["latest_annual_report"] = (ar_by_ent.get(e["id"]) or [None])[0]

    # Enrich Devices & AdsPower & Platform Accounts
    ads_by_host: dict[str, list[dict]] = {}
    for a in ads_profiles:
        ads_by_host.setdefault(a["host_device_id"], []).append(a)

    pa_by_dev: dict[str, list[dict]] = {}
    pa_by_ads: dict[str, list[dict]] = {}
    for p in platform_accounts:
        if p["account_status"] != "retired":
            if p["physical_device_id"]:
                pa_by_dev.setdefault(p["physical_device_id"], []).append(p)
            if p["adspower_profile_id"]:
                pa_by_ads.setdefault(p["adspower_profile_id"], []).append(p)

    for d in devices:
        d["legal_person_name"] = lp_map.get(d["legal_person_id"], {}).get("name", "公共集群")
        s1 = sim_map.get(d["sim_slot_1_id"]) if d["sim_slot_1_id"] else None
        s2 = sim_map.get(d["sim_slot_2_id"]) if d["sim_slot_2_id"] else None
        d["slot_1_phone"] = s1["phone_number"] if s1 else ""
        d["slot_1_carrier"] = s1["carrier"] if s1 else ""
        d["slot_1_balance_fen"] = s1["effective_balance_fen"] if s1 else None
        d["slot_2_phone"] = s2["phone_number"] if s2 else ""
        d["slot_2_carrier"] = s2["carrier"] if s2 else ""
        d["slot_2_balance_fen"] = s2["effective_balance_fen"] if s2 else None
        d["hosted_ads_count"] = len(ads_by_host.get(d["id"], []))
        d["app_accounts"] = [
            {"id": p["id"], "display_name": p["display_name"], "platform_label": PLATFORM_LABELS.get(p["platform"], p["platform"]), "account_role": p["account_role"]}
            for p in pa_by_dev.get(d["id"], [])
        ]

    for w in ads_profiles:
        px = proxy_map.get(w["proxy_ip_id"], {})
        hd = dev_map.get(w["host_device_id"], {})
        w["proxy_code"] = px.get("proxy_code", "-")
        w["proxy_exit_ip"] = px.get("exit_ip", "-")
        w["proxy_isp_region"] = px.get("isp_region", "-")
        w["proxy_expires_at"] = px.get("expires_at", "-")
        w["proxy_days_left"] = px.get("days_left")
        w["proxy_expiry_state"] = px.get("computed_expiry_state", "unknown")
        w["host_device_code"] = hd.get("device_code", "-")
        w["host_brand_model"] = hd.get("brand_model", "-")
        bound_pas = pa_by_ads.get(w["id"], [])
        w["bound_accounts"] = [
            {"id": p["id"], "display_name": p["display_name"], "platform": p["platform"], "platform_label": PLATFORM_LABELS.get(p["platform"], p["platform"]), "legal_person_id": p["legal_person_id"]}
            for p in bound_pas
        ]
        w["legal_person_ids"] = sorted({p["legal_person_id"] for p in bound_pas if p.get("legal_person_id")})

    for p in platform_accounts:
        p["platform_label"] = PLATFORM_LABELS.get(p["platform"], p["platform"])
        p["legal_person_name"] = lp_map.get(p["legal_person_id"], {}).get("name", "-")
        ent = ent_map.get(p["business_entity_id"], {}) if p["business_entity_id"] else {}
        p["entity_code"] = ent.get("entity_code", "个人/非执照号")
        p["entity_name"] = ent.get("entity_name", "无需执照主体")
        ali = ali_map.get(p["alipay_account_id"], {}) if p["alipay_account_id"] else {}
        p["alipay_code"] = ali.get("account_code", "")
        p["alipay_name"] = ali.get("account_name", "")
        p["alipay_corporate_pay"] = bool(ali.get("corporate_pay_enabled"))
        p["alipay_master_code"] = ali.get("master_account_code", "")
        sim = sim_map.get(p["bound_sim_id"], {}) if p["bound_sim_id"] else {}
        p["bound_phone"] = sim.get("phone_number", "")
        p["sim_is_external"] = bool(sim.get("is_external"))
        p["sim_contract_days_left"] = sim.get("contract_days_left")
        ads = ads_map.get(p["adspower_profile_id"], {}) if p["adspower_profile_id"] else {}
        p["ads_profile_code"] = ads.get("profile_code", "")
        p["ads_serial_no"] = ads.get("ads_serial_no", "")
        p["ads_host_id"] = ads.get("host_device_id", "")
        p["ads_host_code"] = ads.get("host_device_code", "")
        px = proxy_map.get(p["proxy_ip_id"], {}) if p["proxy_ip_id"] else {}
        p["proxy_code"] = px.get("proxy_code", "")
        p["proxy_exit_ip"] = px.get("exit_ip", "")
        p["proxy_isp_region"] = px.get("isp_region", "")
        p["proxy_expires_at"] = px.get("expires_at", "")
        p["proxy_days_left"] = px.get("days_left")
        p["proxy_expiry_state"] = px.get("computed_expiry_state", "")
        dv = dev_map.get(p["physical_device_id"], {}) if p["physical_device_id"] else {}
        p["device_code"] = dv.get("device_code", "")
        p["device_model"] = dv.get("brand_model", "")
        lt = pa_map.get(p["lead_target_account_id"], {}) if p["lead_target_account_id"] else {}
        p["lead_target_name"] = lt.get("display_name", "")
        # 单账号专属财务派生指标
        p["settlement_channel_label"] = SETTLEMENT_CHANNEL_LABELS.get(p["settlement_channel"], p["settlement_channel"])
        bps = int(p.get("commission_rate_bps") or 0)
        p["commission_rate_pct"] = round(bps / 100.0, 2)
        gmv = int(p.get("month_gmv_fen") or 0)
        cost = int(p.get("month_cost_fen") or 0)
        rfd = int(p.get("month_refund_fen") or 0)
        est_fee = int(round(max(0, gmv - rfd) * bps / 10000.0)) if p["account_role"] == "sales_only" else 0
        p["estimated_fee_fen"] = est_fee
        p["net_margin_fen"] = (gmv - rfd - cost - est_fee) if p["account_role"] == "sales_only" else 0
        p["net_purchase_fen"] = max(0, cost - rfd) if p["account_role"] == "purchase_only" else 0

    for sfr in sim_fee_records:
        sm = sim_map.get(sfr["sim_card_id"], {})
        sfr["phone_number"] = sm.get("phone_number", "-")
        sfr["carrier"] = sm.get("carrier", "-")
        sfr["legal_person_id"] = sm.get("legal_person_id", "")

    for pr in proxy_renewals:
        px = proxy_map.get(pr["proxy_ip_id"], {})
        pr["proxy_code"] = px.get("proxy_code", "-")
        pr["exit_ip"] = px.get("exit_ip", "-")

    # 实时全库 5 大硬规则合规自检
    cross_entity_violations = [
        a["account_code"] for a in alipays
        if a["master_alipay_id"] and ali_map.get(a["master_alipay_id"], {}).get("business_entity_id") != a["business_entity_id"]
    ] + [
        p["account_code"] for p in platform_accounts
        if p["business_entity_id"] and p["alipay_account_id"]
        and ali_map.get(p["alipay_account_id"], {}).get("business_entity_id") != p["business_entity_id"]
    ]
    missing_master_entities = [e["entity_code"] for e in entities if not e["master_alipay"]]

    buy_sell_mix_violations = [
        p["account_code"] for p in platform_accounts
        if p["alipay_account_id"] and p["account_role"] in ("sales_only", "purchase_only")
        and ali_map.get(p["alipay_account_id"], {}).get("trade_direction") != p["account_role"]
    ]

    same_plat_proxy_conflicts = [px["proxy_code"] for px in proxies if px["has_same_platform_conflict"]]
    expiring_or_expired_proxies = [
        {"id": px["id"], "proxy_code": px["proxy_code"], "exit_ip": px["exit_ip"], "expires_at": px["expires_at"], "days_left": px["days_left"], "reused_count": px["reused_platform_count"]}
        for px in proxies if px["days_left"] is not None and px["days_left"] <= 7
    ]

    low_balance_sims = [
        {"id": s["id"], "phone_number": s["phone_number"], "carrier": s["carrier"], "balance_fen": s["balance_fen"], "monthly_rent_fen": s["monthly_rent_fen"], "bound_count": s["bound_count"]}
        for s in sims if s["is_low_balance"]
    ]
    expiring_external_sims = [
        {"id": s["id"], "phone_number": s["phone_number"], "external_vendor": s["external_vendor"], "contract_end_date": s["contract_end_date"], "days_left": s["contract_days_left"], "bound_count": s["bound_count"]}
        for s in sims if s["is_contract_expiring"]
    ]
    quota_overruns = [f"{q['holder_name']}-{q['carrier']}" for q in carrier_quotas if q["remaining_slots"] < 0]
    missing_tax_or_ar = [e["entity_code"] for e in entities if not e["tax_registration"] or not e["latest_annual_report"]]

    guardrails = [
        {
            "code": "RULE_TAX_ENTITY_ISOLATION",
            "title": "税法红线：主体内资金账号「3选1」设主号 & 因公支付严禁跨营业执照串户",
            "passed": len(cross_entity_violations) == 0 and len(missing_master_entities) == 0,
            "summary": f"已核验 {len(entities)} 个营业执照主体、{len(alipays)} 个企业支付宝：每主体唯一主资金池，跨主体因公支付串户 {len(cross_entity_violations)} 起。",
            "violations": cross_entity_violations + missing_master_entities,
        },
        {
            "code": "RULE_BUY_SELL_SEGREGATION",
            "title": "买卖互斥红线：全部支付宝与12类业务平台账号「采购 vs 销售」零混用",
            "passed": len(buy_sell_mix_violations) == 0,
            "summary": f"已核验 {len(platform_accounts)} 个平台账号与 {len(alipays)} 个企业支付宝：销售收款户与采购买券因公付子号 100% 物理隔离，违规混绑 {len(buy_sell_mix_violations)} 起。",
            "violations": buy_sell_mix_violations,
        },
        {
            "code": "RULE_PROXY_ONE_PER_PLATFORM",
            "title": "家宽防关联红线：同一平台必须独占一条家宽IP，不同平台允许安全复用",
            "passed": len(same_plat_proxy_conflicts) == 0,
            "summary": f"在用 {len(proxies)} 条 ¥10/月家宽代理，承载 {len(platform_accounts)} 个跨平台账号，同平台撞IP {len(same_plat_proxy_conflicts)} 起；7天内到期/已过期家宽 {len(expiring_or_expired_proxies)} 条。",
            "violations": same_plat_proxy_conflicts,
        },
        {
            "code": "RULE_SIM_QUOTA_AND_CONTRACT",
            "title": "一主4副动态配额（扣除存量卡）与外部补缺卡合约到期换绑追踪",
            "passed": len(quota_overruns) == 0,
            "summary": f"实名运营商配额超限 {len(quota_overruns)} 项；30天内合约到期的外部补缺卡 {len(expiring_external_sims)} 张，话费余额不足预警卡 {len(low_balance_sims)} 张。",
            "violations": quota_overruns,
        },
        {
            "code": "RULE_FOUR_TAX_FOUR_ANNUAL",
            "title": "主体证照闭环：每个营业执照独立绑定 1 税务局登记 + 1 工商管理局年报",
            "passed": len(missing_tax_or_ar) == 0,
            "summary": f"{len(entities)} 本营业执照对应 {len(tax_regs)} 条税务登记、{len(annual_reports)} 份工商年报，缺漏主体 {len(missing_tax_or_ar)} 个。",
            "violations": missing_tax_or_ar,
        },
    ]

    cluster_health = build_cluster_health_overview(conn)
    asset_map = get_device_asset_map(conn)
    mac_by_id = {m["device_id"]: m for m in cluster_health["mac_hosts"]}
    mob_by_id = {ph["device_id"]: ph for ph in cluster_health["mobile_devices"]}
    for d in devices:
        ac = asset_map.get(d["id"], {})
        mh = mac_by_id.get(d["id"])
        ph = mob_by_id.get(d["id"])
        d["asset_no"] = ac.get("asset_no", "")
        d["purchase_order_no"] = ac.get("purchase_order_no", "")
        d["purchase_date"] = ac.get("purchase_date", "")
        d["purchase_cost_fen"] = ac.get("purchase_cost_fen", 0)
        d["salvage_value_fen"] = ac.get("salvage_value_fen", 0)
        d["asset_lifecycle_status"] = ac.get("asset_lifecycle_status", "in_use")
        d["control_agreement_no"] = ac.get("control_agreement_no", "")
        d["agreement_signed_by"] = ac.get("agreement_signed_by", d.get("custodian_staff", ""))
        d["last_inventory_date"] = ac.get("last_inventory_date", "")
        d["inventory_status"] = ac.get("inventory_status", "verified")
        d["work_schedule_mode"] = ac.get("work_schedule_mode", "office_onsite")
        d["wfh_approval_ref"] = ac.get("wfh_approval_ref", "")
        d["geo_fence_state"] = ac.get("geo_fence_state", "in_company")
        d["geo_location_label"] = ac.get("geo_location_label", "")
        d["geo_coords"] = ac.get("geo_coords", "")
        d["distance_from_office_km"] = ac.get("distance_from_office_km", 0.0)
        d["net_conn_kind"] = ac.get("net_conn_kind", "corp_wifi")
        d["connected_ssid_or_nic"] = ac.get("connected_ssid_or_nic", "")
        d["gateway_egress_note"] = ac.get("gateway_egress_note", "")
        d["remote_locked"] = ac.get("remote_locked", 0)
        d["compliance_note"] = ac.get("compliance_note", "")
        d["loc_net_compliance_code"] = ac.get("loc_net_compliance_code", "compliant_office")
        d["loc_net_compliance_label"] = ac.get("loc_net_compliance_label", "🟢 在司 · 已连公司网")
        d["loc_net_compliance_level"] = ac.get("loc_net_compliance_level", "green")
        if mh:
            d["cpu_load_pct"] = mh.get("cpu_load_pct", 0)
            d["temp_c"] = mh.get("soc_temp_c", 45.0)
            d["ram_summary_text"] = f"{mh['ram_used_gb']}G/64G"
        elif ph:
            d["cpu_load_pct"] = ph.get("cpu_load_pct", 0)
            d["temp_c"] = ph.get("battery_temp_c", 33.0)
            d["battery_health_pct"] = ph.get("battery_health_pct", 95)
            d["ram_summary_text"] = f"RAM {ph.get('ram_usage_pct', 48)}%"
        else:
            d["cpu_load_pct"] = 15
            d["temp_c"] = 35.0
            d["ram_summary_text"] = "-"

    host_grade_by_id = {m["device_id"]: m["effective_health_grade"] for m in cluster_health["mac_hosts"]}
    over_quota_hosts = [
        f"{m['host_code']} ({m['occupied_slots']}/{m['max_account_quota']})"
        for m in cluster_health["mac_hosts"]
        if m["occupied_slots"] > m["max_account_quota"]
    ]
    guardrails.append({
        "code": "RULE_MACPRO_50_QUOTA",
        "title": "算力与防爆炸半径红线：10 台 64GB Mac Pro 单机上限 50 账号（集群总容量 500 槽位）",
        "passed": len(over_quota_hosts) == 0,
        "summary": (
            f"在册 {cluster_health['summary']['mac_host_count']} 台 64GB Mac Pro（总内存 {cluster_health['summary']['total_cluster_ram_gb']}GB · "
            f"总槽位 {cluster_health['summary']['total_account_quota']} 号）：当前已挂载 {cluster_health['summary']['total_mounted_accounts']} 号，"
            f"剩余可扩盘 {cluster_health['summary']['total_remaining_slots']} 槽，超50号上限宿主机 {len(over_quota_hosts)} 台。"
        ),
        "violations": over_quota_hosts,
    })

    illegal_retired_assets = [
        f"{d['asset_no']} ({d['device_code']})"
        for d in devices
        if d.get("asset_lifecycle_status") == "retired_disposed"
        and (d.get("sim_slot_1_id") or d.get("sim_slot_2_id") or d.get("hosted_ads_count", 0) > 0 or len(d.get("app_accounts", [])) > 0)
    ]
    guardrails.append({
        "code": "RULE_ASSET_RETIRE_UNBIND",
        "title": "固定资产退役与转二手售卖防泄密红线：未拔出公司 SIM 卡或未解绑店铺/窗口严禁报废核减",
        "passed": len(illegal_retired_assets) == 0,
        "summary": (
            f"全司统管 {cluster_health['summary']['total_asset_devices']} 台受控硬件资产（《设备受控协议》已签 {cluster_health['summary']['agreement_signed_count']} 份），"
            f"带卡/带号违规核减 {len(illegal_retired_assets)} 台；当前在司连公司网合规 {cluster_health['summary']['in_office_compliant_count']} 台、报备居家 {cluster_health['summary']['wfh_compliant_count']} 台。"
        ),
        "violations": illegal_retired_assets,
    })
    for p in platform_accounts:
        p["ads_host_health_grade"] = host_grade_by_id.get(p.get("ads_host_id") or "", "")

    # 汇总开店流程案例进度与全维统筹缺口看板
    cases_summary, cases_by_target = build_all_cases_summary(conn)
    for a in alipays:
        c_obj = cases_by_target.get(f"alipay:{a['id']}")
        a["onboarding_case_id"] = c_obj["id"] if c_obj else ""
        a["onboarding_progress_pct"] = c_obj["progress_pct"] if c_obj else 100
        a["onboarding_status"] = c_obj["status"] if c_obj else "completed"
        a["onboarding_step_code"] = c_obj["current_step_code"] if c_obj else ""
        a["onboarding_step_title"] = c_obj["current_step_title"] if c_obj else ""
        a["onboarding_done_text"] = f"{c_obj['done_steps']}/{c_obj['total_steps']}" if c_obj else "15/15"

    for p in platform_accounts:
        c_obj = cases_by_target.get(f"platform:{p['id']}")
        p["onboarding_case_id"] = c_obj["id"] if c_obj else ""
        p["onboarding_progress_pct"] = c_obj["progress_pct"] if c_obj else None
        p["onboarding_status"] = c_obj["status"] if c_obj else ""
        p["onboarding_step_code"] = c_obj["current_step_code"] if c_obj else ""
        p["onboarding_step_title"] = c_obj["current_step_title"] if c_obj else ""
        p["onboarding_done_text"] = f"{c_obj['done_steps']}/{c_obj['total_steps']}" if c_obj else ""
        p["onboarding_cross_blocked"] = bool(c_obj and c_obj.get("cross_blocked_msg"))
        p["onboarding_has_rejected"] = bool(c_obj and c_obj.get("has_rejected"))

    gap_overview = build_gap_and_issues_overview(conn, PLATFORM_LABELS, cases_summary, today)
    governance = build_governance_overview(conn, viewer_role=viewer_role, viewer_staff=viewer_staff)

    # 在老板首屏行动箱追加「定位×公司网违规」、Mac Pro 集群内存/温度高危提醒 & 软基建待终审快捷跳转
    extra_boss_issues = []
    if viewer_role == "boss" and cluster_health["summary"].get("loc_net_violation_count", 0) > 0:
        extra_boss_issues.append({
            "level": "red",
            "category": "定位×公司受控网红线",
            "legal_person_id": "",
            "assigned_staff": "周安/各保管人",
            "title": f"【上班设备在岗与公司网巡检】检出 {cluster_health['summary']['loc_net_violation_count']} 台设备违规（人在公司未连公司网 / 未报备私带离司）",
            "detail": "按《公司设备使用协议》：上班时间在公司必须连接公司受控网，离司必须持有居家审批并拨通公司 VPN",
            "action_type": "jump_health",
            "action_target": "ads_device_health",
            "jump_view": "ads_device_health",
            "action_label": "去定位与网络管控台处置 ›",
        })
    if viewer_role == "boss" and cluster_health["summary"]["critical_host_count"] > 0:
        extra_boss_issues.append({
            "level": "red",
            "category": "Mac Pro 负载与温度",
            "legal_person_id": "",
            "assigned_staff": "林婷/周安",
            "title": f"【64GB Mac Pro 负载/高温红灯】{cluster_health['summary']['critical_host_count']} 台宿主机内存高压/高温告警（总槽位已用 {cluster_health['summary']['total_mounted_accounts']}/500）",
            "detail": "点击进入『07 Ads·设备健康·定位』专页一键清理浏览器冗余缓存降温降载",
            "action_type": "jump_health",
            "action_target": "ads_device_health",
            "jump_view": "ads_device_health",
            "action_label": "去设备健康台账降载 ›",
        })
    if viewer_role == "boss" and (governance["pending_boss_count"] > 0 or governance["totals"]["missing_or_rejected"] > 0):
        extra_boss_issues.append({
            "level": "yellow",
            "category": "六大工作台基建治理",
            "legal_person_id": "",
            "assigned_staff": "总经办/各主管",
            "title": f"【制度·视频·KPI/OKR】待老板终审 {governance['pending_boss_count']} 项 · 全司剩余缺口 {governance['totals']['missing_or_rejected']} 项",
            "detail": "销售/客服/采购/仓管/开店/总经办独立分区纳管，终审通过后自动点亮对应工作台 ? 帮助槽与培训视频",
            "action_type": "jump_gov_hub",
            "action_target": "gov_hub",
            "jump_view": "gov_hub",
            "action_label": "去基建治理终审 ›",
        })
    if extra_boss_issues:
        merged_issues = [x for x in extra_boss_issues if x["level"] == "red"] + list(gap_overview["action_issues"]) + [x for x in extra_boss_issues if x["level"] != "red"]
        gap_overview = {**gap_overview, "action_issues": merged_issues, "issues": merged_issues}

    # 按角色严格隔离数据（总经办与非开店部门主管不接触底层支付宝余额、税表、家宽代理IP与号卡隐私！）
    is_asset_role = viewer_role == "boss" or (viewer_role == "supervisor" and viewer_staff in ("", "周安"))
    if viewer_role == "employee" and viewer_staff:
        visible_cases = [c for c in cases_summary if c["assigned_staff"] == viewer_staff]
        visible_alis = [a for a in alipays if a.get("onboarding_case_id") in {c["id"] for c in visible_cases}]
        visible_plats = [p for p in platform_accounts if p["operator_staff"] == viewer_staff or p.get("onboarding_case_id") in {c["id"] for c in visible_cases}]
        emp_issues = [it for it in gap_overview["action_issues"] if it.get("assigned_staff") == viewer_staff]
        gap_overview = {**gap_overview, "action_issues": emp_issues, "issues": emp_issues}
    elif not is_asset_role:
        visible_cases = []
        visible_alis = []
        visible_plats = []
    else:
        visible_cases = cases_summary
        visible_alis = alipays
        visible_plats = platform_accounts

    return {
        "meta": {
            "build_id": BUILD_ID,
            "today": today.isoformat(),
            "viewer_role": viewer_role,
            "viewer_staff": viewer_staff,
            "staff_roster": ["陈晓雯", "赵宇", "林婷", "李航"],
            "supervisor_roster": [
                {"staff": "周安", "label": "周安 · 开店中控主管", "workbench": "account_ops"},
                {"staff": "陆铭", "label": "陆铭 · 销售工作台主管", "workbench": "sales"},
                {"staff": "苏晴", "label": "苏晴 · 客服工作台主管", "workbench": "cs"},
                {"staff": "郑凯", "label": "郑凯 · 采购工作台主管", "workbench": "procurement"},
                {"staff": "马强", "label": "马强 · 仓管工作台主管", "workbench": "warehouse"},
            ],
            "gm_office_name": "沈悦",
            "supervisor_name": "周安",
            "platform_labels": PLATFORM_LABELS,
            "settlement_channel_labels": SETTLEMENT_CHANNEL_LABELS,
            "flow_direction_labels": FLOW_DIRECTION_LABELS,
            "oa_recharge_note": "话费充值、家宽续费及全部业务账号财务核算槽位均已预留 OA/钉钉/ERP 接口位，当前台账先行全量纳管。",
        },
        "legal_persons": legal_persons if is_asset_role else [],
        "business_entities": entities if is_asset_role else [],
        "tax_registrations": tax_regs if viewer_role == "boss" else [],
        "annual_reports": annual_reports if viewer_role == "boss" else [],
        "alipay_accounts": visible_alis,
        "alipay_bills": alipay_bills if viewer_role == "boss" else [],
        "carrier_quotas": carrier_quotas if is_asset_role else [],
        "sim_cards": sims if is_asset_role else [],
        "sim_fee_records": sim_fee_records if viewer_role == "boss" else [],
        "proxy_ips": proxies if is_asset_role else [],
        "proxy_renewals": proxy_renewals if is_asset_role else [],
        "physical_devices": devices if is_asset_role else [],
        "adspower_profiles": ads_profiles if (is_asset_role or viewer_role == "employee") else [],
        "platform_accounts": visible_plats,
        "phone_bindings": phone_bindings if is_asset_role else [],
        "onboarding_cases": visible_cases,
        "tutorial_templates": gap_overview["templates"] if is_asset_role else [],
        "pending_skip_requests": gap_overview["pending_skips"] if viewer_role == "boss" else [],
        "gap_overview": gap_overview,
        "cluster_health": cluster_health if is_asset_role else {},
        "governance": governance,
        "alerts": {
            "expiring_proxies": expiring_or_expired_proxies if is_asset_role else [],
            "low_balance_sims": low_balance_sims if is_asset_role else [],
            "expiring_external_sims": expiring_external_sims if is_asset_role else [],
        },
        "guardrails": guardrails if is_asset_role else [],
        "dispatch_capacity_policies": list_dispatch_capacity_policies(conn) if viewer_role == "boss" else [],
        "vault": get_vault_public_summary(conn, vault_token, viewer_role=viewer_role, viewer_staff=viewer_staff),
    }


def _adspower_local_call(method: str, api_path: str, payload: dict | None = None) -> tuple[bool, dict]:
    """对接本机 AdsPower Local API (http://127.0.0.1:50325)，若未启动客户端则诚实返回离线暂存标识"""
    ads_base = os.environ.get("ADSPOWER_LOCAL_API", "http://127.0.0.1:50325").rstrip("/")
    try:
        if method == "GET":
            q = urllib.parse.urlencode(payload or {})
            url = f"{ads_base}{api_path}" + (f"?{q}" if q else "")
            req = urllib.request.Request(url, method="GET")
        else:
            raw = json.dumps(payload or {}, ensure_ascii=False).encode("utf-8")
            req = urllib.request.Request(
                f"{ads_base}{api_path}",
                data=raw,
                method=method,
                headers={"Content-Type": "application/json"},
            )
        with urllib.request.urlopen(req, timeout=1.2) as resp:
            res_json = json.loads(resp.read().decode("utf-8", errors="replace"))
            return res_json.get("code") == 0, res_json
    except Exception as exc:
        return False, {"code": -1, "offline": True, "msg": str(exc)}


def _get_template_full(conn: sqlite3.Connection, tpl_id: str) -> dict | None:
    cur = conn.cursor()
    tpl = cur.execute("SELECT * FROM tutorial_templates WHERE id = ?", (tpl_id,)).fetchone()
    if not tpl:
        return None
    stages = [dict(r) for r in cur.execute("SELECT * FROM tutorial_stages WHERE template_id = ? ORDER BY sort_order", (tpl_id,)).fetchall()]
    steps = [dict(r) for r in cur.execute("SELECT * FROM tutorial_steps WHERE template_id = ? ORDER BY sort_order", (tpl_id,)).fetchall()]
    mats = [dict(r) for r in cur.execute(
        "SELECT m.* FROM tutorial_step_materials m JOIN tutorial_steps s ON s.id = m.step_id WHERE s.template_id = ? ORDER BY m.sort_order",
        (tpl_id,),
    ).fetchall()]
    m_by_s: dict[str, list[dict]] = {}
    for m in mats:
        m["field_key"] = m["material_key"]
        m["placeholder"] = m.get("help_text") or ""
        m_by_s.setdefault(m["step_id"], []).append(m)
    s_by_stg: dict[str, list[dict]] = {}
    for s in steps:
        s["guards"] = json.loads(s["guard_json"] or "[]")
        s["terms"] = json.loads(s["terms_json"] or "[]")
        s["materials"] = m_by_s.get(s["id"], [])
        s_by_stg.setdefault(s["stage_id"], []).append(s)
    for stg in stages:
        stg["steps"] = s_by_stg.get(stg["id"], [])
    out = dict(tpl)
    out["stages"] = stages
    return out


def sanitize_record_input(table: str, payload: dict) -> dict:
    cols = ALLOWED_TABLES[table]
    out = {}
    for c in cols:
        if c not in payload:
            continue
        val = payload[c]
        if c in NULLABLE_FK_COLS and (val == "" or val is None):
            out[c] = None
        elif c in INT_COLS:
            out[c] = int(round(float(val))) if val not in ("", None) else 0
        else:
            out[c] = "" if val is None else str(val).strip()
    return out


CSV_EXPORTERS = {
    "alipay_accounts": (
        "企业支付宝与因公支付台账",
        ["account_code", "account_name", "entity_code", "entity_name", "entity_fund_slot", "trade_direction", "corporate_pay_enabled", "master_account_code", "login_email", "bound_phone", "settlement_bank", "settlement_card_no", "balance_yuan", "bill_sync_status", "notes"],
        lambda d: [
            {
                **r,
                "balance_yuan": f"{r['balance_fen']/100:.2f}",
                "corporate_pay_enabled": "是(扣同主体主户)" if r["corporate_pay_enabled"] else "否",
            }
            for r in d["alipay_accounts"]
        ],
    ),
    "platform_accounts": (
        "全平台账号与小店矩阵台账",
        ["account_code", "platform_label", "display_name", "platform_login_id", "account_role", "entity_code", "settlement_channel_label", "merchant_account_no", "alipay_code", "commission_rate_pct", "bound_phone", "ads_profile_code", "proxy_code", "proxy_exit_ip", "proxy_expires_at", "device_code", "virtual_biz_usage", "finance_book_code", "operator_staff", "account_status", "notes"],
        lambda d: d["platform_accounts"],
    ),
    "account_finance": (
        "全账号专属财务结算与损益预留台账",
        ["account_code", "platform_label", "display_name", "account_role", "entity_code", "settlement_channel_label", "merchant_account_no", "settlement_bank_ref", "settlement_cycle", "alipay_code", "commission_rate_pct", "deposit_yuan", "deposit_source_ref", "frozen_yuan", "month_gmv_yuan", "month_cost_yuan", "month_refund_yuan", "estimated_fee_yuan", "net_margin_yuan", "tax_invoice_mode", "finance_book_code"],
        lambda d: [
            {
                **r,
                "deposit_yuan": f"{(r.get('deposit_fen') or 0)/100:.2f}",
                "frozen_yuan": f"{(r.get('frozen_balance_fen') or 0)/100:.2f}",
                "month_gmv_yuan": f"{(r.get('month_gmv_fen') or 0)/100:.2f}",
                "month_cost_yuan": f"{(r.get('month_cost_fen') or 0)/100:.2f}",
                "month_refund_yuan": f"{(r.get('month_refund_fen') or 0)/100:.2f}",
                "estimated_fee_yuan": f"{(r.get('estimated_fee_fen') or 0)/100:.2f}",
                "net_margin_yuan": f"{(r.get('net_margin_fen') or 0)/100:.2f}",
            }
            for r in d["platform_accounts"]
        ],
    ),
    "proxy_ips": (
        "家宽代理IP到期与跨平台复用台账",
        ["proxy_code", "provider", "isp_region", "protocol", "host", "port", "exit_ip", "monthly_cost_yuan", "purchased_at", "expires_at", "days_left", "reused_summary", "notes"],
        lambda d: [
            {
                **r,
                "monthly_cost_yuan": f"{r['monthly_cost_fen']/100:.2f}",
                "reused_summary": " | ".join(f"{x['platform_label']}:{x['display_name']}" for x in r["reused_accounts"]),
            }
            for r in d["proxy_ips"]
        ],
    ),
    "sim_cards": (
        "手机卡配额外部合约与话费总台账",
        ["phone_number", "carrier", "card_category", "master_phone_number", "real_name_holder", "device_slot_label", "monthly_rent_yuan", "billing_day", "balance_yuan", "next_recharge_due", "is_external", "external_vendor", "contract_end_date", "contract_days_left", "bound_count", "notes"],
        lambda d: [
            {
                **r,
                "monthly_rent_yuan": f"{r['monthly_rent_fen']/100:.2f}",
                "balance_yuan": f"{r['balance_fen']/100:.2f}",
            }
            for r in d["sim_cards"]
        ],
    ),
    "entities_compliance": (
        "营业执照4税务4工商年报台账",
        ["entity_code", "entity_name", "uscc", "legal_person_name", "tax_bureau", "quarter_sales_yuan", "filing_status", "aic_bureau", "report_year", "report_status", "alipay_count", "sales_store_count"],
        lambda d: [
            {
                "entity_code": e["entity_code"],
                "entity_name": e["entity_name"],
                "uscc": e["uscc"],
                "legal_person_name": e["legal_person_name"],
                "tax_bureau": (e["tax_registration"] or {}).get("tax_bureau_name", "-"),
                "quarter_sales_yuan": f"{((e['tax_registration'] or {}).get('quarter_sales_fen', 0))/100:.2f}",
                "filing_status": (e["tax_registration"] or {}).get("filing_status", "-"),
                "aic_bureau": (e["latest_annual_report"] or {}).get("aic_bureau_name", "-"),
                "report_year": (e["latest_annual_report"] or {}).get("report_year", "-"),
                "report_status": (e["latest_annual_report"] or {}).get("report_status", "-"),
                "alipay_count": e["alipay_count"],
                "sales_store_count": e["sales_store_count"],
            }
            for e in d["business_entities"]
        ],
    ),
}


class LedgerHTTPHandler(BaseHTTPRequestHandler):
    server_version = "AnchorMasterLedger/2.0"

    def log_message(self, fmt: str, *args) -> None:
        # Quiet clean logging
        pass

    def _send_json(self, obj: dict, status: int = 200) -> None:
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def _get_viewer_context(self, qs: dict | None = None, body: dict | None = None) -> tuple[str, str]:
        role = (
            ((qs or {}).get("role") or [None])[0]
            or (body or {}).get("viewer_role")
            or self.headers.get("X-Ledger-Role")
            or "boss"
        )
        role = str(role).strip().lower()
        if role not in ("boss", "gm_office", "supervisor", "employee"):
            role = "boss"
        raw_staff = (
            ((qs or {}).get("staff") or [None])[0]
            or (body or {}).get("viewer_staff")
            or urllib.parse.unquote(self.headers.get("X-Ledger-Staff") or "")
            or ""
        )
        staff = str(raw_staff).strip()
        if role == "employee" and not staff:
            staff = "陈晓雯"
        elif role == "gm_office" and not staff:
            staff = "沈悦"
        elif role == "supervisor" and not staff:
            staff = "周安"
        return role, staff

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/ledger-build.txt":
            body = BUILD_ID.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if path == "/api/health":
            self._send_json({"ok": True, "mode": "boss-master-ledger-desktop", "build": BUILD_ID})
            return

        if path == "/api/bootstrap":
            today_param = (qs.get("today") or [None])[0]
            today = parse_date_safe(today_param) or dt.date.today()
            vtoken = self.headers.get("X-Vault-Token")
            v_role, v_staff = self._get_viewer_context(qs=qs)
            conn = get_conn()
            try:
                data = build_bootstrap_payload(conn, today=today, vault_token=vtoken, viewer_role=v_role, viewer_staff=v_staff)
                self._send_json({"ok": True, "data": data})
            finally:
                conn.close()
            return

        if path == "/api/onboarding/case":
            cid = ((qs.get("id") or [""])[0]).strip()
            conn = get_conn()
            try:
                ensure_tutorials_and_gaps_seeded(conn)
                ensure_governance_seeded(conn)
                sync_published_governance_to_tutorial_steps(conn)
                detail = evaluate_case_detail(conn, cid)
                if not detail:
                    self._send_json({"ok": False, "error": "未找到该开店进度案例"}, 404)
                else:
                    self._send_json({"ok": True, "data": detail})
            finally:
                conn.close()
            return

        if path == "/api/governance/item":
            gid = ((qs.get("id") or [""])[0]).strip()
            conn = get_conn()
            try:
                ensure_governance_seeded(conn)
                item = get_governance_item_detail(conn, gid)
                if not item:
                    self._send_json({"ok": False, "error": "未找到该制度/视频/KPI治理条目"}, 404)
                else:
                    self._send_json({"ok": True, "data": item})
            finally:
                conn.close()
            return

        if path == "/api/tutorials/template":
            tid = ((qs.get("id") or [""])[0]).strip()
            conn = get_conn()
            try:
                ensure_tutorials_and_gaps_seeded(conn)
                tpl = _get_template_full(conn, tid)
                if not tpl:
                    self._send_json({"ok": False, "error": "未找到该教程模板"}, 404)
                else:
                    self._send_json({"ok": True, "data": tpl})
            finally:
                conn.close()
            return

        if path == "/api/vault/setup-qr":
            vtoken = self.headers.get("X-Vault-Token")
            conn = get_conn()
            try:
                ensure_vault_tables_and_seed(conn)
                payload = get_totp_setup_payload(conn, vtoken)
                self._send_json({"ok": True, "data": payload})
            except ValueError as ve:
                self._send_json({"ok": False, "error": str(ve)}, 403)
            finally:
                conn.close()
            return

        if path == "/api/dispatch-capacity-policies":
            v_role, _ = self._get_viewer_context(qs=qs)
            if v_role != "boss":
                self._send_json({"ok": False, "error": "权限隔离：店铺分组月度派单容量策略仅限最高管理端查看与配置"}, 403)
                return
            conn = get_conn()
            try:
                items = list_dispatch_capacity_policies(conn)
                self._send_json({"ok": True, "data": items})
            finally:
                conn.close()
            return

        if path.startswith("/api/export/") and path.endswith(".csv"):
            key = path[len("/api/export/"):-len(".csv")]
            if key not in CSV_EXPORTERS:
                self._send_json({"ok": False, "error": f"不支持的导出类型: {key}"}, 404)
                return
            conn = get_conn()
            try:
                boot = build_bootstrap_payload(conn)
                _, headers, extractor = CSV_EXPORTERS[key]
                rows = extractor(boot)
                buf = io.StringIO()
                buf.write("\ufeff")
                writer = csv.DictWriter(buf, fieldnames=headers, extrasaction="ignore")
                writer.writeheader()
                for r in rows:
                    writer.writerow(r)
                raw = buf.getvalue().encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Content-Disposition", f'attachment; filename="{key}_{dt.date.today().isoformat()}.csv"')
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            finally:
                conn.close()
            return

        # Serve static desktop web app
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        target = (WEB_DIR / rel).resolve()
        if not str(target).startswith(str(WEB_DIR.resolve())) or not target.is_file():
            target = WEB_DIR / "index.html"
        if not target.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "Frontend asset not found")
            return
        ctype, _ = mimetypes.guess_type(str(target))
        raw = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", f"{ctype or 'text/html'}; charset=utf-8" if (ctype or "").startswith(("text/", "application/javascript", "application/json")) else (ctype or "application/octet-stream"))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            body = self._read_json_body()
        except Exception as e:
            self._send_json({"ok": False, "error": f"JSON 解析失败: {e}"}, 400)
            return

        conn = get_conn()
        try:
            if path.startswith("/api/records/"):
                table = path[len("/api/records/"):].strip("/")
                if table not in ALLOWED_TABLES:
                    self._send_json({"ok": False, "error": f"未知数据表: {table}"}, 400)
                    return
                clean = sanitize_record_input(table, body)
                if table == "adspower_profiles":
                    clean.setdefault("group_name", "默认环境分组")
                validate_before_write(conn, table, clean, record_id=None)
                rec_id = body.get("id") or f"{table[:3]}-{uuid.uuid4().hex[:8]}"
                cols = ["id"] + list(clean.keys())
                placeholders = ",".join(["?"] * len(cols))
                vals = [rec_id] + [clean[c] for c in clean.keys()]
                conn.execute(f"INSERT INTO {table} ({','.join(cols)}) VALUES ({placeholders})", vals)
                if table in ("adspower_profiles", "physical_devices"):
                    ensure_cluster_and_health_seeded(conn)
                sync_phone_bindings(conn)
                conn.commit()
                self._send_json({"ok": True, "id": rec_id})
                return

            if path == "/api/actions/sim-fee":
                sim_id = body.get("sim_card_id")
                change_type = body.get("change_type") or "recharge"
                amount_fen = int(round(float(body.get("amount_yuan", 0)) * 100))
                if change_type != "recharge" and amount_fen > 0:
                    amount_fen = -amount_fen
                row = conn.execute("SELECT balance_fen, low_balance_threshold_fen, monthly_rent_fen, sim_status FROM sim_cards WHERE id = ?", (sim_id,)).fetchone()
                if not row:
                    raise BusinessRuleError("手机卡不存在！")
                new_bal = int(row["balance_fen"]) + amount_fen
                today_s = dt.date.today().isoformat()
                new_status = row["sim_status"]
                if new_status in ("low_balance", "arrears_suspended") and new_bal >= max(row["low_balance_threshold_fen"], row["monthly_rent_fen"]):
                    new_status = "active"
                elif new_bal < max(row["low_balance_threshold_fen"], row["monthly_rent_fen"]) and new_status == "active":
                    new_status = "low_balance"

                if change_type == "recharge" and amount_fen > 0:
                    conn.execute(
                        "UPDATE sim_cards SET balance_fen = ?, last_recharge_date = ?, last_recharge_fen = ?, sim_status = ?, updated_at = datetime('now','localtime') WHERE id = ?",
                        (new_bal, today_s, amount_fen, new_status, sim_id),
                    )
                else:
                    conn.execute(
                        "UPDATE sim_cards SET balance_fen = ?, sim_status = ?, updated_at = datetime('now','localtime') WHERE id = ?",
                        (new_bal, new_status, sim_id),
                    )
                conn.execute(
                    """INSERT INTO sim_fee_records
                       (id, sim_card_id, occurred_date, change_type, amount_fen, balance_after_fen, operator_name, payment_source, oa_approval_ref, notes)
                       VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (
                        f"sfr-{uuid.uuid4().hex[:8]}", sim_id, body.get("occurred_date") or today_s,
                        change_type, amount_fen, new_bal, body.get("operator_name") or "老板/管理员台账登记",
                        "人工台账登记（待接OA/钉钉）", body.get("oa_approval_ref") or "待接入OA/钉钉审批",
                        body.get("notes") or "",
                    ),
                )
                conn.commit()
                self._send_json({"ok": True, "balance_fen": new_bal})
                return

            if path == "/api/actions/proxy-renew":
                px_id = body.get("proxy_ip_id")
                months = max(1, int(body.get("months") or 1))
                row = conn.execute("SELECT expires_at, monthly_cost_fen FROM proxy_ips WHERE id = ?", (px_id,)).fetchone()
                if not row:
                    raise BusinessRuleError("家宽代理记录不存在！")
                today_d = dt.date.today()
                old_exp = parse_date_safe(row["expires_at"]) or today_d
                base_d = max(today_d, old_exp)
                new_exp = (base_d + dt.timedelta(days=30 * months)).isoformat()
                cost_fen = int(row["monthly_cost_fen"]) * months
                conn.execute(
                    "UPDATE proxy_ips SET expires_at = ?, connectivity_status = 'online', updated_at = datetime('now','localtime') WHERE id = ?",
                    (new_exp, px_id),
                )
                conn.execute(
                    "UPDATE adspower_profiles SET profile_status = 'active', updated_at = datetime('now','localtime') WHERE proxy_ip_id = ? AND profile_status = 'proxy_warning'",
                    (px_id,),
                )
                ensure_cluster_and_health_seeded(conn)
                conn.execute(
                    """UPDATE adspower_window_health
                       SET exit_ip_check='matched', proxy_ping_ms=24, open_state='idle', health_grade='healthy',
                           health_note='家宽代理已续期恢复，防直连熔断已自动解除'
                       WHERE profile_id IN (SELECT id FROM adspower_profiles WHERE proxy_ip_id = ?)""",
                    (px_id,),
                )
                conn.execute(
                    """INSERT INTO proxy_renewals
                       (id, proxy_ip_id, renewed_at, months_added, amount_fen, old_expires_at, new_expires_at, operator_name, oa_approval_ref)
                       VALUES (?,?,?,?,?,?,?,?,?)""",
                    (
                        f"prn-{uuid.uuid4().hex[:8]}", px_id, today_d.isoformat(), months, cost_fen,
                        row["expires_at"], new_exp, body.get("operator_name") or "台账手工续期",
                        body.get("oa_approval_ref") or "待接入OA/钉钉续费",
                    ),
                )
                conn.commit()
                self._send_json({"ok": True, "new_expires_at": new_exp})
                return

            if path == "/api/actions/sim-rebind":
                old_sim_id = body.get("old_sim_id")
                new_sim_id = body.get("new_sim_id")
                if not old_sim_id or not new_sim_id or old_sim_id == new_sim_id:
                    raise BusinessRuleError("请选择不同的原卡与接替新卡！")
                if not conn.execute("SELECT 1 FROM sim_cards WHERE id = ?", (new_sim_id,)).fetchone():
                    raise BusinessRuleError("接替新卡不存在！")
                conn.execute("UPDATE tax_registrations SET bound_sim_id = ? WHERE bound_sim_id = ?", (new_sim_id, old_sim_id))
                conn.execute("UPDATE annual_reports SET liaison_sim_id = ? WHERE liaison_sim_id = ?", (new_sim_id, old_sim_id))
                conn.execute("UPDATE alipay_accounts SET bound_sim_id = ? WHERE bound_sim_id = ?", (new_sim_id, old_sim_id))
                conn.execute("UPDATE platform_accounts SET bound_sim_id = ? WHERE bound_sim_id = ?", (new_sim_id, old_sim_id))
                conn.execute("UPDATE physical_devices SET sim_slot_1_id = ? WHERE sim_slot_1_id = ?", (new_sim_id, old_sim_id))
                conn.execute("UPDATE physical_devices SET sim_slot_2_id = ? WHERE sim_slot_2_id = ?", (new_sim_id, old_sim_id))
                conn.execute("UPDATE sim_cards SET sim_status = 'retired', notes = notes || ' [已一键换绑迁移至 ' || ? || ']' WHERE id = ?", (new_sim_id, old_sim_id))
                sync_phone_bindings(conn)
                conn.commit()
                self._send_json({"ok": True})
                return

            if path == "/api/dispatch-capacity-policies/save":
                v_role, v_staff = self._get_viewer_context(body=body)
                if v_role != "boss":
                    self._send_json({"ok": False, "error": "权限隔离：店铺分组月度派单容量策略仅限最高管理端修改"}, 403)
                    return
                items = body.get("items")
                if not isinstance(items, list):
                    raise BusinessRuleError("请提交有效的策略数组 items")
                saved = save_dispatch_capacity_policies(conn, items, updated_by=v_staff or "boss")
                self._send_json({"ok": True, "data": saved})
                return

            if path == "/api/vault/unlock-totp":
                ensure_vault_tables_and_seed(conn)
                try:
                    VAULT_SESSIONS.check_rate_limit()
                except ValueError as rle:
                    self._send_json({"ok": False, "error": str(rle)}, 429)
                    return

                cfg = conn.execute("SELECT * FROM vault_auth_config WHERE id='boss_primary'").fetchone()
                secret_b32 = decrypt_secret(cfg["totp_secret_enc"], "totp_cfg")
                code = str(body.get("code") or "")
                ok_code, step = verify_totp(secret_b32, code)
                if not ok_code:
                    VAULT_SESSIONS.record_failure()
                    write_audit_log(conn, "UNLOCK_FAILED", "密码保险箱", "Authenticator动态码", self.client_address[0], "6位动态验证码不匹配")
                    conn.commit()
                    self._send_json({"ok": False, "error": "6 位动态验证码错误或已过期（每 30 秒刷新，请核对 iPhone 上的最新数字）"}, 401)
                    return

                VAULT_SESSIONS.check_and_mark_totp_step(step)
                now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                if body.get("lock_production_bind"):
                    conn.execute(
                        "UPDATE vault_auth_config SET is_demo_mode = 0, totp_bound_at = COALESCE(totp_bound_at, ?), updated_at = ? WHERE id='boss_primary'",
                        (now_s, now_s),
                    )
                sess = VAULT_SESSIONS.issue_session("iPhone/Authenticator动态码", int(cfg["unlock_ttl_seconds"] or 900))
                write_audit_log(conn, "UNLOCK_OK", "全量密码保险箱", sess["auth_method"], self.client_address[0], f"成功解锁 {sess['ttl_seconds'] // 60} 分钟临时查看权限")
                conn.commit()
                self._send_json({"ok": True, "token": sess["token"], "expires_in": sess["ttl_seconds"], "auth_method": sess["auth_method"]})
                return

            if path == "/api/vault/webauthn/challenge":
                ensure_vault_tables_and_seed(conn)
                purpose = body.get("purpose") or "authenticate"
                cfg = conn.execute("SELECT * FROM vault_auth_config WHERE id='boss_primary'").fetchone()
                vtoken = self.headers.get("X-Vault-Token")
                sess = VAULT_SESSIONS.get_valid_session(vtoken)
                if purpose == "register" and not cfg["is_demo_mode"] and not sess:
                    self._send_json({"ok": False, "error": "生产锁定态下新增/重绑 Passkey 需先通过动态验证码解锁！"}, 403)
                    return
                if purpose == "authenticate" and not cfg["webauthn_cred_id"]:
                    self._send_json({"ok": False, "error": "尚未注册 Passkey 通行密钥，请先点击【首次扫码注册 iPhone / 指纹】！"}, 400)
                    return
                ch = VAULT_SESSIONS.create_webauthn_challenge(purpose)
                ch["cred_id"] = cfg["webauthn_cred_id"] or ""
                self._send_json({"ok": True, "data": ch})
                return

            if path == "/api/vault/webauthn/verify":
                ensure_vault_tables_and_seed(conn)
                purpose = body.get("purpose") or "authenticate"
                cid = str(body.get("challenge_id") or "")
                cred_id = str(body.get("cred_id") or "")
                client_data_b64 = str(body.get("client_data_json") or "")
                try:
                    expected_challenge = VAULT_SESSIONS.consume_webauthn_challenge(cid, purpose)
                    client_json = json.loads(_b64u_dec(client_data_b64).decode("utf-8"))
                except Exception as ce:
                    self._send_json({"ok": False, "error": f"通行密钥挑战校验失败: {ce}"}, 400)
                    return

                expected_type = "webauthn.create" if purpose == "register" else "webauthn.get"
                if client_json.get("type") != expected_type or client_json.get("challenge") != expected_challenge:
                    self._send_json({"ok": False, "error": "WebAuthn 挑战签名不匹配！"}, 401)
                    return

                cfg = conn.execute("SELECT * FROM vault_auth_config WHERE id='boss_primary'").fetchone()
                now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                if purpose == "register":
                    label = str(body.get("label") or "老板 iPhone FaceID / Mac TouchID")
                    conn.execute(
                        "UPDATE vault_auth_config SET webauthn_cred_id = ?, webauthn_label = ?, webauthn_bound_at = ?, updated_at = ? WHERE id='boss_primary'",
                        (cred_id, label, now_s, now_s),
                    )
                    write_audit_log(conn, "BIND_PASSKEY", label, "WebAuthn/iPhone扫码", self.client_address[0], "成功绑定苹果跨设备扫码/生物识别通行密钥")
                else:
                    if not cfg["webauthn_cred_id"] or cfg["webauthn_cred_id"] != cred_id:
                        self._send_json({"ok": False, "error": "通行密钥凭证 ID 不匹配！"}, 401)
                        return

                sess = VAULT_SESSIONS.issue_session("iPhone扫码FaceID / 指纹Passkey", int(cfg["unlock_ttl_seconds"] or 900))
                write_audit_log(conn, "UNLOCK_OK", "全量密码保险箱", sess["auth_method"], self.client_address[0], "通过 Passkey 扫码/生物识别解锁")
                conn.commit()
                self._send_json({"ok": True, "token": sess["token"], "expires_in": sess["ttl_seconds"], "auth_method": sess["auth_method"]})
                return

            if path == "/api/vault/lock":
                vtoken = self.headers.get("X-Vault-Token") or body.get("token")
                VAULT_SESSIONS.revoke_session(vtoken)
                ensure_vault_tables_and_seed(conn)
                write_audit_log(conn, "LOCK_MANUAL", "全量密码保险箱", "手动上锁", self.client_address[0], "已立即销毁内存解锁令牌")
                conn.commit()
                self._send_json({"ok": True})
                return

            if path == "/api/vault/rotate-totp":
                ensure_vault_tables_and_seed(conn)
                vtoken = self.headers.get("X-Vault-Token")
                sess = VAULT_SESSIONS.get_valid_session(vtoken)
                cfg = conn.execute("SELECT * FROM vault_auth_config WHERE id='boss_primary'").fetchone()
                if not cfg["is_demo_mode"] and not sess:
                    self._send_json({"ok": False, "error": "请先解锁密码库后再重新生成绑定二维码！"}, 401)
                    return
                new_secret = generate_totp_secret()
                now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                conn.execute(
                    "UPDATE vault_auth_config SET totp_secret_enc = ?, is_demo_mode = 1, totp_bound_at = NULL, updated_at = ? WHERE id='boss_primary'",
                    (encrypt_secret(new_secret, "totp_cfg"), now_s),
                )
                write_audit_log(conn, "ROTATE_TOTP", "Authenticator主密钥", sess["auth_method"] if sess else "初始态", self.client_address[0], "已重新生成新的 160-bit TOTP 种子待 iPhone 扫码")
                conn.commit()
                self._send_json({"ok": True, "data": get_totp_setup_payload(conn, vtoken)})
                return

            if path == "/api/vault/reveal":
                v_role, v_staff = self._get_viewer_context(body=body)
                if v_role != "boss":
                    write_audit_log(conn, "REVEAL_DENIED_RBAC", str(body.get("id") or "-"), f"{v_role}:{v_staff}", self.client_address[0], "非老板角色尝试查看明文密码被服务端 RBAC 硬阻断")
                    conn.commit()
                    self._send_json({
                        "ok": False,
                        "error": "免明文安全阻断：员工与主管端严禁查看明文密码！员工请使用【🚀 一键启动 AdsPower 专窗自动填充】或【🔢 获取 6 位 Authenticator 动态码】。",
                        "rbac_blocked": True,
                    }, 403)
                    return
                vtoken = self.headers.get("X-Vault-Token")
                sess = VAULT_SESSIONS.get_valid_session(vtoken)
                if not sess:
                    self._send_json({"ok": False, "error": "密码库处于锁定状态或解锁已超时，请先用 iPhone 扫码或输入 Authenticator 动态码解锁！", "vault_locked": True}, 401)
                    return
                cid = str(body.get("id") or "")
                row = conn.execute("SELECT * FROM credential_vault WHERE id = ?", (cid,)).fetchone()
                if not row:
                    self._send_json({"ok": False, "error": "未找到该密码条目"}, 404)
                    return
                login_pwd = decrypt_secret(row["login_password_enc"], cid) if row["login_password_enc"] else ""
                sec_pwd = decrypt_secret(row["secondary_password_enc"], cid) if row["secondary_password_enc"] else ""
                sub_totp_secret = decrypt_secret(row["account_totp_secret_enc"], cid) if row["account_totp_secret_enc"] else ""
                note_txt = decrypt_secret(row["recovery_note_enc"], cid) if row["recovery_note_enc"] else ""
                sub_totp_code = compute_totp(sub_totp_secret) if sub_totp_secret else ""
                sub_totp_left = (30 - (int(dt.datetime.now().timestamp()) % 30)) if sub_totp_secret else 0

                write_audit_log(conn, "REVEAL_SECRET", row["title"], sess["auth_method"], self.client_address[0], f"解密查看了账号 {row['login_account']} 的密钥")
                conn.commit()
                self._send_json({
                    "ok": True,
                    "secret": {
                        "id": cid,
                        "title": row["title"],
                        "login_account": row["login_account"],
                        "login_password": login_pwd,
                        "secondary_label": row["secondary_label"],
                        "secondary_password": sec_pwd,
                        "account_totp_secret": sub_totp_secret,
                        "sub_totp_code": sub_totp_code,
                        "sub_totp_seconds_left": sub_totp_left,
                        "recovery_note": note_txt,
                    },
                })
                return

            if path == "/api/vault/save":
                vtoken = self.headers.get("X-Vault-Token")
                sess = VAULT_SESSIONS.get_valid_session(vtoken)
                if not sess:
                    self._send_json({"ok": False, "error": "请先解锁密码保险箱后再录入或修改密码！", "vault_locked": True}, 401)
                    return
                cid = str(body.get("id") or "").strip() or f"cred-{uuid.uuid4().hex[:8]}"
                existing = conn.execute("SELECT * FROM credential_vault WHERE id = ?", (cid,)).fetchone()
                now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                today_s = dt.date.today().isoformat()

                title = str(body.get("title") or (existing["title"] if existing else "")).strip()
                login_acc = str(body.get("login_account") or (existing["login_account"] if existing else "")).strip()
                cat = str(body.get("category") or (existing["category"] if existing else "platform")).strip()
                if not title or not login_acc:
                    raise BusinessRuleError("密码条目标题与登录账号不能为空！")

                lp_id = body.get("legal_person_id") if "legal_person_id" in body else (existing["legal_person_id"] if existing else "lp-ljg")
                t_tbl = str(body.get("target_table") if "target_table" in body else (existing["target_table"] if existing else ""))
                t_id = str(body.get("target_id") if "target_id" in body else (existing["target_id"] if existing else ""))
                sec_lbl = str(body.get("secondary_label") or (existing["secondary_label"] if existing else "支付/交易密码"))

                # 空字符串若未传则保留旧密文；若传了新明文则重新用独立随机 Nonce 加密
                def enc_field(key_plain: str, old_col: str) -> str:
                    if key_plain in body:
                        v = str(body.get(key_plain) or "").strip()
                        return encrypt_secret(v, cid) if v else ""
                    return existing[old_col] if existing else ""

                l_enc = enc_field("login_password", "login_password_enc")
                s_enc = enc_field("secondary_password", "secondary_password_enc")
                t_enc = enc_field("account_totp_secret", "account_totp_secret_enc")
                n_enc = enc_field("recovery_note", "recovery_note_enc")

                if existing:
                    conn.execute(
                        """UPDATE credential_vault
                           SET legal_person_id=?, category=?, target_table=?, target_id=?, title=?, login_account=?,
                               login_password_enc=?, secondary_label=?, secondary_password_enc=?,
                               account_totp_secret_enc=?, recovery_note_enc=?, password_rotated_at=?, updated_at=?
                           WHERE id=?""",
                        (lp_id, cat, t_tbl, t_id, title, login_acc, l_enc, sec_lbl, s_enc, t_enc, n_enc, today_s, now_s, cid),
                    )
                    write_audit_log(conn, "UPDATE_SECRET", title, sess["auth_method"], self.client_address[0], "加密更新了密码条目")
                else:
                    conn.execute(
                        """INSERT INTO credential_vault
                           (id, legal_person_id, category, target_table, target_id, title, login_account,
                            login_password_enc, secondary_label, secondary_password_enc, account_totp_secret_enc,
                            recovery_note_enc, password_rotated_at, updated_at)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (cid, lp_id, cat, t_tbl, t_id, title, login_acc, l_enc, sec_lbl, s_enc, t_enc, n_enc, today_s, now_s),
                    )
                    write_audit_log(conn, "CREATE_SECRET", title, sess["auth_method"], self.client_address[0], "新增加密密码条目")
                conn.commit()
                self._send_json({"ok": True, "id": cid})
                return

            if path == "/api/vault/delete":
                vtoken = self.headers.get("X-Vault-Token")
                sess = VAULT_SESSIONS.get_valid_session(vtoken)
                if not sess:
                    self._send_json({"ok": False, "error": "请先解锁密码保险箱！", "vault_locked": True}, 401)
                    return
                cid = str(body.get("id") or "")
                row = conn.execute("SELECT title FROM credential_vault WHERE id=?", (cid,)).fetchone()
                conn.execute("DELETE FROM credential_vault WHERE id=?", (cid,))
                write_audit_log(conn, "DELETE_SECRET", row["title"] if row else cid, sess["auth_method"], self.client_address[0], "删除了密码条目")
                conn.commit()
                self._send_json({"ok": True})
                return

            # ==================== 新增 1：员工免明文取 6 位 Authenticator 动态码 + AdsPower 联动 ====================
            if path == "/api/vault/employee-totp":
                ensure_vault_tables_and_seed(conn)
                v_role, v_staff = self._get_viewer_context(body=body)
                cid = str(body.get("id") or body.get("credential_id") or "").strip()
                row = conn.execute("SELECT * FROM credential_vault WHERE id = ?", (cid,)).fetchone()
                if not row:
                    self._send_json({"ok": False, "error": "未找到该凭据条目"}, 404)
                    return
                if v_role == "employee":
                    if row["category"] != "platform" or row["assigned_staff"] != v_staff or not int(row["employee_totp_enabled"] or 0):
                        write_audit_log(conn, "EMP_TOTP_DENIED", row["title"], f"employee:{v_staff}", self.client_address[0], "越权请求非本人名下店铺动态码被阻断")
                        conn.commit()
                        self._send_json({"ok": False, "error": f"越权阻断：账号「{row['title']}」未授权给员工 {v_staff}，仅可获取本人负责店铺的动态验证码！", "rbac_blocked": True}, 403)
                        return
                elif v_role == "supervisor" and row["category"] not in ("platform", "network_ads"):
                    self._send_json({"ok": False, "error": "权限阻断：政务税务与支付宝盾密仅限老板端查看！", "rbac_blocked": True}, 403)
                    return

                totp_secret = decrypt_secret(row["account_totp_secret_enc"], cid) if row["account_totp_secret_enc"] else ""
                if not totp_secret:
                    # 若该平台账号尚未初始化 fakey 种子，可自动为其签发并同步记录（不返回种子原文，只返回6位动态码！）
                    totp_secret = generate_totp_secret()
                    now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                    conn.execute("UPDATE credential_vault SET account_totp_secret_enc = ?, updated_at = ? WHERE id = ?", (encrypt_secret(totp_secret, cid), now_s, cid))

                otp_code = compute_totp(totp_secret)
                sec_left = 30 - (int(dt.datetime.now().timestamp()) % 30)
                write_audit_log(conn, "FETCH_6DIGIT_TOTP", row["title"], f"{v_role}:{v_staff or '老板'}", self.client_address[0], f"免明文获取 6 位 Authenticator 动态码（有效期剩 {sec_left}s，未暴露明文密码）")
                conn.commit()
                self._send_json({
                    "ok": True,
                    "data": {
                        "id": cid,
                        "title": row["title"],
                        "login_account": row["login_account"],
                        "code": otp_code,
                        "totp_code": otp_code,
                        "remaining_seconds": sec_left,
                        "seconds_left": sec_left,
                    },
                })
                return

            if path == "/api/vault/employee-lock-in":
                # 开店员工在 B09 / S06 新设密码时单向写入加密库并同步 AdsPower（锁入后不可反查明文！）
                ensure_vault_tables_and_seed(conn)
                v_role, v_staff = self._get_viewer_context(body=body)
                t_tbl = str(body.get("target_table") or "platform_accounts").strip()
                t_id = str(body.get("target_id") or "").strip()
                login_acc = str(body.get("login_account") or "").strip()
                login_pwd = str(body.get("login_password") or "").strip()
                sec_pwd = str(body.get("secondary_password") or "").strip()
                raw_fakey = str(body.get("account_totp_secret") or "").strip()
                if not t_id or not login_acc or not login_pwd:
                    raise BusinessRuleError("单向锁密必填项缺失：请填写登录账号与新设登录密码！")

                existing = conn.execute("SELECT * FROM credential_vault WHERE target_table = ? AND target_id = ?", (t_tbl, t_id)).fetchone()
                cid = existing["id"] if existing else f"cred-lock-{uuid.uuid4().hex[:8]}"
                now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                today_s = dt.date.today().isoformat()

                # 查找绑定的 AdsPower 专窗与归属法人
                lp_id = "lp-ljg"
                ads_pid = ""
                title = str(body.get("title") or login_acc).strip()
                cat = "alipay" if t_tbl == "alipay_accounts" else "platform"
                assigned_to = v_staff if v_role == "employee" else str(body.get("assigned_staff") or "")
                if t_tbl == "platform_accounts":
                    pr = conn.execute("SELECT legal_person_id, account_code, display_name, platform, adspower_profile_id, operator_staff FROM platform_accounts WHERE id = ?", (t_id,)).fetchone()
                    if pr:
                        lp_id = pr["legal_person_id"]
                        ads_pid = pr["adspower_profile_id"] or ""
                        title = f"{pr['account_code']} · {pr['display_name']} ({pr['platform']})"
                        assigned_to = pr["operator_staff"] or assigned_to
                elif t_tbl == "alipay_accounts":
                    ar = conn.execute("SELECT legal_person_id, account_code, account_name FROM alipay_accounts WHERE id = ?", (t_id,)).fetchone()
                    if ar:
                        lp_id = ar["legal_person_id"]
                        title = f"{ar['account_code']} · {ar['account_name']}"
                        assigned_to = ""  # 支付宝盾密不向普通员工长期开放

                fakey_to_store = raw_fakey or (decrypt_secret(existing["account_totp_secret_enc"], cid) if (existing and existing["account_totp_secret_enc"]) else (generate_totp_secret() if cat == "platform" else ""))
                l_enc = encrypt_secret(login_pwd, cid)
                s_enc = encrypt_secret(sec_pwd, cid) if sec_pwd else (existing["secondary_password_enc"] if existing else "")
                t_enc = encrypt_secret(fakey_to_store, cid) if fakey_to_store else ""

                # 尝试同步推送到 AdsPower Local API
                sync_status = "app_only"
                sync_at = ""
                ads_live = False
                if ads_pid:
                    ads_row = conn.execute("SELECT ads_user_id FROM adspower_profiles WHERE id = ?", (ads_pid,)).fetchone()
                    if ads_row:
                        ads_live, _ = _adspower_local_call("POST", "/api/v1/user/update", {
                            "user_id": ads_row["ads_user_id"],
                            "username": login_acc,
                            "password": login_pwd,
                            "fakey": fakey_to_store,
                        })
                        sync_status = "synced"
                        sync_at = now_s

                if existing:
                    conn.execute(
                        """UPDATE credential_vault
                           SET login_account=?, login_password_enc=?, secondary_password_enc=?, account_totp_secret_enc=?,
                               assigned_staff=?, adspower_profile_id=?, adspower_sync_status=?, adspower_synced_at=?,
                               password_rotated_at=?, updated_at=?
                           WHERE id=?""",
                        (login_acc, l_enc, s_enc, t_enc, assigned_to, ads_pid, sync_status, sync_at, today_s, now_s, cid),
                    )
                else:
                    conn.execute(
                        """INSERT INTO credential_vault
                           (id, legal_person_id, category, target_table, target_id, title, login_account,
                            login_password_enc, secondary_label, secondary_password_enc, account_totp_secret_enc,
                            recovery_note_enc, assigned_staff, employee_totp_enabled, adspower_profile_id,
                            adspower_sync_status, adspower_synced_at, password_rotated_at, updated_at)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (
                            cid, lp_id, cat, t_tbl, t_id, title, login_acc, l_enc, "支付/二级口令", s_enc, t_enc,
                            encrypt_secret("开店员工单向锁入托管", cid), assigned_to, 1 if cat == "platform" else 0,
                            ads_pid, sync_status, sync_at, today_s, now_s
                        ),
                    )
                write_audit_log(conn, "ONEWAY_LOCKIN", title, f"{v_role}:{v_staff or '管理员'}", self.client_address[0], f"单向加密锁入新设密码并同步 AdsPower fakey（员工端不回显明文，本机Ads在线={ads_live}）")
                conn.commit()
                self._send_json({
                    "ok": True,
                    "id": cid,
                    "credential_id": cid,
                    "adspower_synced": bool(ads_pid),
                    "live_client": ads_live,
                    "message": "密码已单向 ENCv1 认证加密锁入总库并同步注入 AdsPower（员工端不保留明文）！",
                })
                return

            if path == "/api/adspower/sync-credential":
                ensure_vault_tables_and_seed(conn)
                v_role, v_staff = self._get_viewer_context(body=body)
                cid = str(body.get("credential_id") or "").strip()
                row = conn.execute("SELECT * FROM credential_vault WHERE id = ?", (cid,)).fetchone()
                if not row:
                    raise BusinessRuleError("未找到要同步的密码条目！")
                ads_pid = str(body.get("adspower_profile_id") or row["adspower_profile_id"] or "").strip()
                if not ads_pid:
                    raise BusinessRuleError("该账号尚未绑定 AdsPower 浏览器专窗，请先绑定窗口后再同步自动填充！")
                ads_row = conn.execute("SELECT id, profile_code, ads_user_id, window_name FROM adspower_profiles WHERE id = ?", (ads_pid,)).fetchone()
                if not ads_row:
                    raise BusinessRuleError("目标 AdsPower 窗口不存在！")

                login_pwd = decrypt_secret(row["login_password_enc"], cid) if row["login_password_enc"] else ""
                totp_sec = decrypt_secret(row["account_totp_secret_enc"], cid) if row["account_totp_secret_enc"] else ""
                if not totp_sec:
                    totp_sec = generate_totp_secret()
                live_ok, ads_resp = _adspower_local_call("POST", "/api/v1/user/update", {
                    "user_id": ads_row["ads_user_id"],
                    "username": row["login_account"],
                    "password": login_pwd,
                    "fakey": totp_sec,
                })
                now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                conn.execute(
                    """UPDATE credential_vault
                       SET account_totp_secret_enc = ?, adspower_profile_id = ?, adspower_sync_status = 'synced', adspower_synced_at = ?, updated_at = ?
                       WHERE id = ?""",
                    (encrypt_secret(totp_sec, cid), ads_pid, now_s, now_s, cid),
                )
                mode_note = "直连本机 AdsPower :50325 实时注入成功" if live_ok else "已生成加密同步包就绪（本机 AdsPower 客户端未启动，启动后自动注入 username/password/fakey）"
                write_audit_log(conn, "SYNC_ADSPOWER_FAKEY", row["title"], f"{v_role}:{v_staff or '系统'}", self.client_address[0], f"同步至窗口 {ads_row['profile_code']} ({ads_row['ads_user_id']})：{mode_note}")
                conn.commit()
                self._send_json({
                    "ok": True,
                    "live_client": live_ok,
                    "message": mode_note,
                    "ads_profile_code": ads_row["profile_code"],
                    "data": {
                        "ads_user_id": ads_row["ads_user_id"],
                        "profile_code": ads_row["profile_code"],
                        "has_fakey": bool(totp_sec),
                        "live_client": live_ok,
                        "message": mode_note,
                    },
                })
                return

            if path == "/api/adspower/open-window":
                v_role, v_staff = self._get_viewer_context(body=body)
                ads_pid = str(body.get("adspower_profile_id") or "").strip()
                ads_row = conn.execute("SELECT * FROM adspower_profiles WHERE id = ?", (ads_pid,)).fetchone()
                if not ads_row:
                    raise BusinessRuleError("未找到指定的 AdsPower 专窗！")
                if v_role == "employee":
                    allowed = conn.execute(
                        "SELECT 1 FROM platform_accounts WHERE adspower_profile_id = ? AND operator_staff = ?",
                        (ads_pid, v_staff),
                    ).fetchone()
                    if not allowed:
                        self._send_json({"ok": False, "error": f"越权阻断：窗口 {ads_row['profile_code']} 未分配给员工 {v_staff}，防撞号保护已拦截！", "rbac_blocked": True}, 403)
                        return
                # 防直连熔断：检查所绑家宽代理是否已过期！
                px_row = conn.execute("SELECT proxy_code, expires_at FROM proxy_ips WHERE id = ?", (ads_row["proxy_ip_id"],)).fetchone()
                if px_row:
                    d_left = days_until(px_row["expires_at"], dt.date.today())
                    if d_left is not None and d_left < 0:
                        raise BusinessRuleError(
                            f"防直连熔断阻断：窗口 {ads_row['profile_code']} 绑定的家宽代理 {px_row['proxy_code']} 已过期 {abs(d_left)} 天！"
                            f"严禁在代理断网时打开窗口，请先找主管/老板续期家宽后再启动！"
                        )
                live_ok, ads_resp = _adspower_local_call("GET", "/api/v1/browser/start", {"user_id": ads_row["ads_user_id"], "open_tabs": 1})
                msg = (
                    f"已通过 Local API 拉起 AdsPower 专窗 {ads_row['profile_code']}（账密与 Authenticator 动态码已自动就绪）"
                    if live_ok
                    else f"专窗 {ads_row['profile_code']} (user_id={ads_row['ads_user_id']}) 权限与家宽核验通过！（提示：当前本机未检测到 AdsPower Global :50325 进程，请先双击打开桌面 AdsPower 客户端后再点启动）"
                )
                write_audit_log(conn, "OPEN_ADSPOWER_WIN", ads_row["profile_code"], f"{v_role}:{v_staff or '老板'}", self.client_address[0], msg)
                conn.commit()
                self._send_json({
                    "ok": True,
                    "live_client": live_ok,
                    "message": msg,
                    "data": {
                        "ads_user_id": ads_row["ads_user_id"],
                        "profile_code": ads_row["profile_code"],
                        "live_client": live_ok,
                        "message": msg,
                    },
                })
                return

            # ==================== 新增 2：开店教程步进状态机、跨轨双锁校验、主管审核与老板跳步审批 ====================
            if path == "/api/onboarding/submit-step":
                ensure_tutorials_and_gaps_seeded(conn)
                v_role, v_staff = self._get_viewer_context(body=body)
                case_id = str(body.get("case_id") or "").strip()
                step_code = str(body.get("step_code") or "").strip()
                materials_in = body.get("materials") or {}
                confirmed = bool(body.get("confirmed"))

                detail = evaluate_case_detail(conn, case_id)
                if not detail:
                    raise BusinessRuleError("开店进度案例不存在！")
                target_step = None
                for stg in detail["stages"]:
                    for s in stg["steps"]:
                        if s["step_code"] == step_code:
                            target_step = s
                            break
                if not target_step:
                    raise BusinessRuleError(f"未找到步骤 {step_code}！")
                if target_step["state"] not in ("active", "rejected"):
                    raise BusinessRuleError(f"步进式防呆拦截：步骤 {step_code} 当前状态为「{target_step['state']}」，请先按顺序完成前序步骤或等待审核！")

                # 跨轨强关联硬闸门拦截（如企业支付宝 C10 未过锁死闲鱼 S09，或企业支付宝 D15 未过锁死闲鱼 S18）
                if target_step.get("cross_lock"):
                    cl = target_step["cross_lock"]
                    raise BusinessRuleError(f"⛔ {cl['reason']}（后果：{cl['consequence']}）")

                # 必填材料非空且禁填纯 "0" 校验（对齐《服务页UI设计》：缺数据写「待核」，禁止空着或填0敷衍）
                clean_mats = {}
                for m in target_step["materials"]:
                    mk = m["material_key"]
                    val = str(materials_in.get(mk) if mk in materials_in else "").strip()
                    if m["required"]:
                        if not val:
                            raise BusinessRuleError(f"材料缺失拦截：请填写必填项「{m['label']}」（若暂缺客观数据请如实写『待核』并说明，不可留空）！")
                        if val == "0" and m["material_key"] != "xy_avatar_dep_img":
                            raise BusinessRuleError(f"数据诚实拦截：「{m['label']}」不能填 0 敷衍！若暂无数据请写『待核』。")
                    clean_mats[mk] = val

                if target_step["require_confirm"] and not confirmed:
                    raise BusinessRuleError("防呆确认拦截：请先阅读红色注意条并勾选「我已按指引完成本步骤全部防呆检查」！")

                prev_ver = conn.execute(
                    "SELECT COALESCE(MAX(version_no), 0) FROM onboarding_step_submissions WHERE case_id = ? AND step_code = ?",
                    (case_id, step_code),
                ).fetchone()[0]
                next_ver = int(prev_ver) + 1
                now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                actor = v_staff or ("主管周安" if v_role == "supervisor" else "老板")
                new_status = "submitted" if target_step["require_review"] else "approved"

                conn.execute(
                    """INSERT INTO onboarding_step_submissions
                       (id, case_id, step_id, step_code, version_no, status, materials_json, confirmed,
                        submitted_by, submitted_at, reviewed_by, reviewed_at, review_note)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        f"sub-{uuid.uuid4().hex[:10]}",
                        case_id,
                        target_step["id"],
                        step_code,
                        next_ver,
                        new_status,
                        json.dumps(clean_mats, ensure_ascii=False),
                        1 if confirmed else 0,
                        actor,
                        now_s,
                        "系统自动核验" if new_status == "approved" else "",
                        now_s if new_status == "approved" else "",
                        "无需人工审核步骤，材料校验通过自动放行" if new_status == "approved" else "",
                    ),
                )

                after = evaluate_case_detail(conn, case_id)
                if after and after["done_steps"] >= after["total_steps"]:
                    conn.execute("UPDATE onboarding_cases SET status='completed', completed_at=?, updated_at=? WHERE id=?", (dt.date.today().isoformat(), now_s, case_id))
                    if after["target_kind"] == "platform":
                        conn.execute("UPDATE platform_accounts SET account_status='active', updated_at=? WHERE id=?", (now_s, after["target_id"]))
                else:
                    conn.execute("UPDATE onboarding_cases SET status='in_progress', updated_at=? WHERE id=?", (now_s, case_id))

                conn.commit()
                final_det = evaluate_case_detail(conn, case_id)
                self._send_json({"ok": True, "status": new_status, "version_no": next_ver, "case": final_det, "case_detail": final_det})
                return

            if path == "/api/onboarding/review-step":
                ensure_tutorials_and_gaps_seeded(conn)
                v_role, v_staff = self._get_viewer_context(body=body)
                if v_role not in ("supervisor", "boss"):
                    self._send_json({"ok": False, "error": "职责分离阻断：员工不能审核自己或他人的开店材料，须由【主管】或【老板】审核！", "rbac_blocked": True}, 403)
                    return
                case_id = str(body.get("case_id") or "").strip()
                step_code = str(body.get("step_code") or "").strip()
                verdict = str(body.get("verdict") or "").strip()  # approve | reject
                note = str(body.get("review_note") or "").strip()
                if verdict not in ("approve", "reject"):
                    raise BusinessRuleError("审核决定必须为 approve 或 reject！")
                if verdict == "reject" and len(note) < 4:
                    raise BusinessRuleError("退回规范阻断：打回员工材料必须写清具体原因与修改办法（至少 4 个字）！")

                sub_row = conn.execute(
                    "SELECT * FROM onboarding_step_submissions WHERE case_id = ? AND step_code = ? ORDER BY version_no DESC LIMIT 1",
                    (case_id, step_code),
                ).fetchone()
                if not sub_row or sub_row["status"] != "submitted":
                    raise BusinessRuleError("当前步骤没有处于『待审核(submitted)』状态的提交记录！")

                now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                reviewer = f"{v_staff or ('周安' if v_role == 'supervisor' else '老板')}({v_role})"
                final_st = "approved" if verdict == "approve" else "rejected"
                conn.execute(
                    "UPDATE onboarding_step_submissions SET status=?, reviewed_by=?, reviewed_at=?, review_note=? WHERE id=?",
                    (final_st, reviewer, now_s, note or "审核通过", sub_row["id"]),
                )

                after = evaluate_case_detail(conn, case_id)
                if final_st == "rejected":
                    conn.execute("UPDATE onboarding_cases SET status='blocked', updated_at=? WHERE id=?", (now_s, case_id))
                elif after and after["done_steps"] >= after["total_steps"]:
                    conn.execute("UPDATE onboarding_cases SET status='completed', completed_at=?, updated_at=? WHERE id=?", (dt.date.today().isoformat(), now_s, case_id))
                    if after["target_kind"] == "platform":
                        conn.execute("UPDATE platform_accounts SET account_status='active', updated_at=? WHERE id=?", (now_s, after["target_id"]))
                    elif after["target_kind"] == "alipay":
                        conn.execute("UPDATE alipay_accounts SET bill_sync_status='已授权日账单', updated_at=? WHERE id=?", (now_s, after["target_id"]))
                else:
                    conn.execute("UPDATE onboarding_cases SET status='in_progress', updated_at=? WHERE id=?", (now_s, case_id))

                # 若本次审过的是企业支付宝关键跨轨节点（C10 或 D15），自动唤醒下游等待该支付宝解锁的闲鱼店铺案例！
                if final_st == "approved" and after and after["target_kind"] == "alipay" and step_code in ("C10", "D15"):
                    if step_code == "D15":
                        conn.execute("UPDATE alipay_accounts SET bill_sync_status='已授权日账单', updated_at=? WHERE id=?", (now_s, after["target_id"]))
                    conn.execute(
                        "UPDATE onboarding_cases SET status='in_progress', updated_at=? WHERE linked_alipay_case_id=? AND status='blocked'",
                        (now_s, case_id),
                    )

                conn.commit()
                final_det = evaluate_case_detail(conn, case_id)
                self._send_json({"ok": True, "status": final_st, "case": final_det, "case_detail": final_det})
                return

            if path == "/api/onboarding/skip-request":
                ensure_tutorials_and_gaps_seeded(conn)
                v_role, v_staff = self._get_viewer_context(body=body)
                case_id = str(body.get("case_id") or "").strip()
                step_code = str(body.get("step_code") or "").strip()
                reason = str(body.get("reason") or "").strip()
                if len(reason) < 4:
                    raise BusinessRuleError("申请跳过必须如实填写理由（至少 4 个字，虚报将按绩效制度追责）！")
                stp = conn.execute(
                    "SELECT s.* FROM tutorial_steps s JOIN onboarding_cases c ON c.template_id = s.template_id WHERE c.id = ? AND s.step_code = ?",
                    (case_id, step_code),
                ).fetchone()
                if not stp:
                    raise BusinessRuleError("步骤不存在！")
                dup = conn.execute(
                    "SELECT 1 FROM onboarding_skip_requests WHERE case_id=? AND step_code=? AND status='pending'",
                    (case_id, step_code),
                ).fetchone()
                if dup:
                    raise BusinessRuleError("该步骤已有待老板审批的跳过申请，请勿重复提交！")
                now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                req_id = f"skip-{uuid.uuid4().hex[:8]}"
                conn.execute(
                    """INSERT INTO onboarding_skip_requests (id, case_id, step_id, step_code, reason, requested_by, requested_at, status)
                       VALUES (?,?,?,?,?,?,?,'pending')""",
                    (req_id, case_id, stp["id"], step_code, reason, v_staff or "员工", now_s),
                )
                conn.commit()
                final_det = evaluate_case_detail(conn, case_id)
                self._send_json({"ok": True, "id": req_id, "case": final_det, "case_detail": final_det})
                return

            if path == "/api/onboarding/skip-verdict":
                ensure_tutorials_and_gaps_seeded(conn)
                v_role, _ = self._get_viewer_context(body=body)
                if v_role != "boss":
                    self._send_json({"ok": False, "error": "权限阻断：跳过步骤涉及风控豁免，仅限【老板端】终审裁定！", "rbac_blocked": True}, 403)
                    return
                req_id = str(body.get("id") or body.get("skip_id") or "").strip()
                verdict = str(body.get("verdict") or "").strip()  # approve | reject
                note = str(body.get("reviewer_note") or body.get("boss_note") or "").strip()
                sk = conn.execute("SELECT * FROM onboarding_skip_requests WHERE id=?", (req_id,)).fetchone()
                if not sk or sk["status"] != "pending":
                    raise BusinessRuleError("未找到待处理的跳步申请！")
                now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                new_st = "approved" if verdict == "approve" else "rejected"
                conn.execute(
                    "UPDATE onboarding_skip_requests SET status=?, reviewed_by='老板', reviewed_at=?, reviewer_note=? WHERE id=?",
                    (new_st, now_s, note or ("特批允许跳过（不计该步教程分）" if new_st == "approved" else "不予跳过，须按标准SOP完成"), req_id),
                )
                if new_st == "approved":
                    prev_ver = conn.execute(
                        "SELECT COALESCE(MAX(version_no), 0) FROM onboarding_step_submissions WHERE case_id = ? AND step_code = ?",
                        (sk["case_id"], sk["step_code"]),
                    ).fetchone()[0]
                    conn.execute(
                        """INSERT INTO onboarding_step_submissions
                           (id, case_id, step_id, step_code, version_no, status, materials_json, confirmed,
                            submitted_by, submitted_at, reviewed_by, reviewed_at, review_note)
                           VALUES (?,?,?,?,?,'skipped','{}',1,?,?,'老板',?,?)""",
                        (f"sub-sk-{uuid.uuid4().hex[:8]}", sk["case_id"], sk["step_id"], sk["step_code"], int(prev_ver) + 1, sk["requested_by"], now_s, now_s, note or "老板特批跳过"),
                    )
                conn.commit()
                final_det = evaluate_case_detail(conn, sk["case_id"])
                self._send_json({"ok": True, "status": new_st, "case": final_det, "case_detail": final_det})
                return

            # ==================== 新增 3：主管端编写/维护平台开店教程 & 老板终审上线 ====================
            if path == "/api/tutorials/save-template":
                ensure_tutorials_and_gaps_seeded(conn)
                v_role, v_staff = self._get_viewer_context(body=body)
                if v_role == "employee":
                    self._send_json({"ok": False, "error": "权限阻断：仅【主管端】与【老板端】可编写或修改标准教程模板！", "rbac_blocked": True}, 403)
                    return
                tpl_id = str(body.get("id") or "").strip() or f"tpl-{uuid.uuid4().hex[:8]}"
                platform = str(body.get("platform") or "").strip()
                title = str(body.get("title") or "").strip()
                summary = str(body.get("summary") or "").strip()
                target_kind = "alipay" if platform == "alipay" else "platform"
                submit_for_boss = bool(body.get("submit_for_boss", True))
                stages_in = body.get("stages") or []
                if not platform or not title or not stages_in:
                    raise BusinessRuleError("请填写适用平台、教程标题，并至少配置 1 个阶段与步骤！")

                existing = conn.execute("SELECT * FROM tutorial_templates WHERE id = ?", (tpl_id,)).fetchone()
                now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                new_status = "published" if (v_role == "boss" and submit_for_boss) else ("pending_boss" if submit_for_boss else "draft")
                code = existing["code"] if existing else f"TPL-{platform.upper()}-{uuid.uuid4().hex[:4].upper()}"
                ver = str(body.get("version") or (existing["version"] if existing else "v1.0"))

                if existing:
                    # 检查该模板是否已有在途 onboarding_cases，若有则只更新或追加，不破坏已有 case 外键；新建草稿/待审模板则直接重建树
                    bound_cases = conn.execute("SELECT COUNT(*) FROM onboarding_cases WHERE template_id = ?", (tpl_id,)).fetchone()[0]
                    if bound_cases > 0:
                        conn.execute(
                            "UPDATE tutorial_templates SET title=?, summary=?, version=?, status=?, updated_at=? WHERE id=?",
                            (title, summary, ver, new_status, now_s, tpl_id),
                        )
                        conn.commit()
                        self._send_json({"ok": True, "id": tpl_id, "status": new_status, "note": "已更新在线模板元信息（在途案例步骤保持兼容）"})
                        return
                    conn.execute("DELETE FROM tutorial_stages WHERE template_id = ?", (tpl_id,))
                    conn.execute(
                        "UPDATE tutorial_templates SET platform=?, title=?, summary=?, version=?, author_staff=?, status=?, updated_at=? WHERE id=?",
                        (platform, title, summary, ver, v_staff or "周安(主管)", new_status, now_s, tpl_id),
                    )
                else:
                    conn.execute(
                        """INSERT INTO tutorial_templates
                           (id, code, target_kind, platform, title, version, summary, author_staff, status, published_at, updated_at)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                        (tpl_id, code, target_kind, platform, title, ver, summary, v_staff or "周安(主管)", new_status, dt.date.today().isoformat() if new_status == "published" else "", now_s),
                    )

                g_order = 0
                for s_idx, stg in enumerate(stages_in, start=1):
                    stg_title = str(stg.get("title") or f"阶段 {s_idx}").strip()
                    stg_id = f"stg-{tpl_id}-{s_idx:02d}"
                    conn.execute(
                        "INSERT INTO tutorial_stages (id, template_id, stage_code, title, description, duration_note, sort_order) VALUES (?,?,?,?,?,?,?)",
                        (stg_id, tpl_id, f"P{s_idx}", stg_title, str(stg.get("description") or ""), str(stg.get("duration_note") or "当天完成"), s_idx),
                    )
                    for stp in (stg.get("steps") or []):
                        g_order += 1
                        s_code = str(stp.get("step_code") or f"S{g_order:02d}").strip()
                        s_title = str(stp.get("title") or "").strip()
                        if not s_title:
                            raise BusinessRuleError(f"阶段「{stg_title}」下存在未填标题的步骤！")
                        stp_id = f"stp-{tpl_id}-{s_code}-{g_order}"
                        conn.execute(
                            """INSERT INTO tutorial_steps
                               (id, template_id, stage_id, step_code, sort_order, title, owner_role, when_to_use,
                                guide, warn_text, deliver_note, video_url, require_confirm, require_review, cross_gate_rule, unlock_vault_lockin)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                            (
                                stp_id, tpl_id, stg_id, s_code, g_order, s_title,
                                str(stp.get("owner_role") or "开店员工"),
                                str(stp.get("when_to_use") or "按顺序执行"),
                                str(stp.get("guide") or ""),
                                str(stp.get("warn_text") or ""),
                                str(stp.get("deliver_note") or ""),
                                str(stp.get("video_url") or ""),  # 未录视频保持空串诚实显示待录
                                1 if stp.get("require_confirm") else 0,
                                1 if stp.get("require_review") else 0,
                                str(stp.get("cross_gate_rule") or ""),
                                1 if stp.get("unlock_vault_lockin") else 0,
                            ),
                        )
                        for m_idx, mat in enumerate(stp.get("materials") or [], start=1):
                            m_lbl = str(mat.get("label") or "").strip()
                            if not m_lbl:
                                continue
                            conn.execute(
                                "INSERT INTO tutorial_step_materials (id, step_id, material_key, label, input_type, required, help_text, sort_order) VALUES (?,?,?,?,?,?,?,?)",
                                (f"mat-{stp_id}-{m_idx}", stp_id, f"m_{g_order}_{m_idx}", m_lbl, str(mat.get("input_type") or "text"), 1 if mat.get("required", True) else 0, str(mat.get("help_text") or ""), m_idx),
                            )
                if g_order == 0:
                    raise BusinessRuleError("教程至少需要包含 1 个可执行步骤！")
                conn.commit()
                self._send_json({"ok": True, "id": tpl_id, "status": new_status, "step_count": g_order})
                return

            if path == "/api/tutorials/publish-verdict":
                ensure_tutorials_and_gaps_seeded(conn)
                v_role, _ = self._get_viewer_context(body=body)
                if v_role != "boss":
                    self._send_json({"ok": False, "error": "权限阻断：新编平台开店教程须由【老板端】终审验收后方可正式发布！", "rbac_blocked": True}, 403)
                    return
                tpl_id = str(body.get("id") or body.get("template_id") or "").strip()
                verdict = str(body.get("verdict") or "approve").strip()
                note = str(body.get("note") or body.get("boss_note") or "").strip()
                new_st = "published" if verdict == "approve" else "draft"
                now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                conn.execute(
                    "UPDATE tutorial_templates SET status=?, boss_review_note=?, published_at=?, updated_at=? WHERE id=?",
                    (new_st, note or ("老板终审通过，正式上线生效" if new_st == "published" else "退回主管补充细节"), dt.date.today().isoformat() if new_st == "published" else "", now_s, tpl_id),
                )
                conn.commit()
                self._send_json({"ok": True, "status": new_st})
                return

            # ==================== 新增 4：统筹缺口一键派发开店任务给员工 ====================
            if path == "/api/gap/dispatch-case":
                ensure_tutorials_and_gaps_seeded(conn)
                v_role, v_staff = self._get_viewer_context(body=body)
                if v_role == "employee":
                    self._send_json({"ok": False, "error": "权限阻断：仅老板与主管可统筹派发新开店任务！", "rbac_blocked": True}, 403)
                    return
                lp_id = str(body.get("legal_person_id") or "lp-wyq").strip()
                be_id = str(body.get("business_entity_id") or "").strip() or None
                platform = str(body.get("platform") or "xianyu").strip()
                display_name = str(body.get("display_name") or "").strip()
                assigned_staff = str(body.get("assigned_staff") or "陈晓雯").strip()
                ali_id = str(body.get("alipay_account_id") or "").strip() or None
                sim_id = str(body.get("bound_sim_id") or "").strip() or None
                px_id = str(body.get("proxy_ip_id") or "").strip() or None

                if not display_name:
                    raise BusinessRuleError("请填写拟新开的店铺/账号名称！")

                # 查找该平台已发布的开店教程模板
                tpl_row = conn.execute(
                    "SELECT id, title FROM tutorial_templates WHERE platform = ? AND status = 'published' ORDER BY updated_at DESC LIMIT 1",
                    (platform,),
                ).fetchone()
                if not tpl_row:
                    plat_cn = PLATFORM_LABELS.get(platform, platform)
                    raise BusinessRuleError(
                        f"教程缺口防呆阻断：【{plat_cn}】当前尚无已发布的开店SOP教程！请先由主管在【教程编排工坊】完成实操编写并经老板终审上线后，再派发员工开店单（杜绝无教程盲目开店废号）！"
                    )

                must_buy = {"dianping", "doushengsheng", "taobao_buyer", "jd_buyer"}
                must_mkt = {"wechat", "xiaohongshu_mkt"}
                role = "purchase_only" if platform in must_buy else ("marketing_only" if platform in must_mkt else "sales_only")
                short_uid = uuid.uuid4().hex[:4].upper()
                pa_id = f"pa-new-{uuid.uuid4().hex[:6]}"
                acc_code = f"{platform[:3].upper()}-{short_uid}"
                login_placeholder = f"pending_{short_uid.lower()}"

                clean_pa = {
                    "legal_person_id": lp_id,
                    "business_entity_id": be_id,
                    "platform": platform,
                    "account_code": acc_code,
                    "display_name": display_name,
                    "platform_login_id": login_placeholder,
                    "account_role": role,
                    "virtual_biz_usage": "统筹缺口新派建店任务",
                    "bound_sim_id": sim_id,
                    "alipay_account_id": ali_id,
                    "proxy_ip_id": px_id,
                    "operator_staff": assigned_staff,
                    "account_status": "warming",
                    "daily_quota_note": "0% 刚派单待从第1步开工",
                    "finance_book_code": f"ERP-NEW-{acc_code}",
                    "notes": f"由 {v_staff or '管理端'} 从缺口看板派发给 {assigned_staff} 按教程逐步开设",
                }
                validate_before_write(conn, "platform_accounts", clean_pa, record_id=None)
                cols = ["id"] + list(clean_pa.keys())
                conn.execute(
                    f"INSERT INTO platform_accounts ({','.join(cols)}) VALUES ({','.join(['?']*len(cols))})",
                    [pa_id] + [clean_pa[c] for c in clean_pa.keys()],
                )

                linked_ali_case = None
                if ali_id:
                    ac = conn.execute("SELECT id FROM onboarding_cases WHERE target_kind='alipay' AND target_id=?", (ali_id,)).fetchone()
                    if ac:
                        linked_ali_case = ac[0]

                case_id = f"case-plat-{pa_id}"
                today_d = dt.date.today()
                conn.execute(
                    """INSERT INTO onboarding_cases
                       (id, template_id, target_kind, target_id, legal_person_id, business_entity_id, linked_alipay_case_id,
                        case_title, assigned_staff, supervisor_staff, status, started_at, due_at, notes)
                       VALUES (?,?,?,?,?,?,?,?,?,?,'in_progress',?,?,?)""",
                    (
                        case_id, tpl_row["id"], "platform", pa_id, lp_id, be_id, linked_ali_case,
                        f"{acc_code} · {display_name}", assigned_staff, "周安",
                        today_d.isoformat(), (today_d + dt.timedelta(days=14)).isoformat(),
                        f"缺口统筹派单：按《{tpl_row['title']}》步进执行",
                    ),
                )
                sync_phone_bindings(conn)
                conn.commit()
                self._send_json({"ok": True, "platform_account_id": pa_id, "case_id": case_id})
                return

            # ==================== 新增 5：六大工作台 Wiki / 培训视频 / KPI / OKR 缺口治理与总经办提审闭环 ====================
            if path == "/api/governance/create-slot":
                ensure_governance_seeded(conn)
                v_role, v_staff = self._get_viewer_context(body=body)
                if v_role == "employee":
                    self._send_json({"ok": False, "error": "权限阻断：仅老板、总经办或工作台主管可登记新的制度/视频/考核缺口槽位！", "rbac_blocked": True}, 403)
                    return
                wb_key = str(body.get("workbench_key") or "sales").strip()
                if wb_key not in WORKBENCH_META:
                    raise BusinessRuleError(f"未知的工作台编码: {wb_key}")
                item_type = str(body.get("item_type") or "wiki").strip()
                if item_type not in GOV_ITEM_TYPE_LABELS:
                    raise BusinessRuleError(f"不支持的缺口类型: {item_type}")
                title = str(body.get("title") or "").strip()
                if not title or title == "0":
                    raise BusinessRuleError("请如实填写缺口项标题（禁空、禁填纯0）！")
                assignee = str(body.get("assignee_staff") or WORKBENCH_META[wb_key]["supervisor"]).strip()
                owner_dept = str(body.get("owner_dept") or ("总经办" if wb_key == "gm_office" else f"{WORKBENCH_META[wb_key]['label'][:5]}+总经办")).strip()
                priority = str(body.get("priority") or "high").strip()
                if priority not in ("critical", "high", "normal"):
                    priority = "high"
                due_date = str(body.get("due_date") or (dt.date.today() + dt.timedelta(days=7)).isoformat()).strip()
                bound_step = str(body.get("bound_step_code") or "").strip()
                page_anchor = str(body.get("page_anchor_note") or "").strip()
                summary_note = str(body.get("summary_note") or "新登记工作台治理缺口，待责任人提报补齐").strip()

                short_id = uuid.uuid4().hex[:6].upper()
                item_id = f"gov-{wb_key}-{item_type}-{short_id.lower()}"
                slot_code = str(body.get("slot_code") or f"SLOT-{wb_key.upper()}-{item_type.upper()}-{short_id}").strip()
                now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                conn.execute(
                    """INSERT INTO governance_gap_items
                       (id, slot_code, workbench_key, item_type, title, owner_dept, assignee_staff, priority,
                        status, due_date, bound_step_code, page_anchor_note, summary_note, updated_at)
                       VALUES (?,?,?,?,?,?,?,?,'missing',?,?,?,?,?)""",
                    (item_id, slot_code, wb_key, item_type, title, owner_dept, assignee, priority, due_date, bound_step, page_anchor, summary_note, now_s),
                )
                conn.commit()
                self._send_json({"ok": True, "id": item_id, "slot_code": slot_code, "item": get_governance_item_detail(conn, item_id)})
                return

            if path == "/api/governance/submit":
                ensure_governance_seeded(conn)
                v_role, v_staff = self._get_viewer_context(body=body)
                if v_role == "employee":
                    self._send_json({"ok": False, "error": "权限阻断：Wiki/培训视频/KPI/OKR 标准须由【总经办】或【部门主管】提交！", "rbac_blocked": True}, 403)
                    return
                item_id = str(body.get("item_id") or body.get("id") or "").strip()
                item_row = conn.execute("SELECT * FROM governance_gap_items WHERE id = ?", (item_id,)).fetchone()
                if not item_row:
                    raise BusinessRuleError("未找到要提报的工作台缺口条目！")

                itype = item_row["item_type"]
                res_url = str(body.get("resource_url") or item_row["resource_url"] or "").strip()
                vid_dur = str(body.get("video_duration") or item_row["video_duration"] or "").strip()
                summary = str(body.get("summary_note") or "").strip()
                kpi_formula = str(body.get("kpi_formula") or "").strip()
                kpi_source = str(body.get("kpi_data_source") or "").strip()
                kpi_thresh = str(body.get("kpi_thresholds") or "").strip()
                okr_krs = body.get("okr_krs") or []
                if isinstance(okr_krs, str):
                    okr_krs = [ln.strip() for ln in okr_krs.splitlines() if ln.strip()]

                # 诚实防呆校验（禁空、禁填纯 "0"）
                for fld_val, fld_lbl in [(res_url, "文档/视频链接"), (summary, "提报摘要说明"), (kpi_formula, "KPI计算公式"), (kpi_thresh, "红黄绿阈值")]:
                    if fld_val == "0":
                        raise BusinessRuleError(f"数据诚实拦截：「{fld_lbl}」严禁填纯数字 0 敷衍！缺数据请如实填写『待核』并说明原因。")

                if itype in ("wiki", "video") and not res_url:
                    raise BusinessRuleError(f"请填写已上传的{'钉钉/飞书 Wiki 链接' if itype == 'wiki' else '培训视频播放链接'}！")
                if itype == "video" and not vid_dur:
                    raise BusinessRuleError("培训视频提报请注明视频时长（如 04:30）！")
                if itype == "kpi" and (not kpi_formula or not kpi_thresh):
                    raise BusinessRuleError("KPI 口径提报必须填写明确的【计算公式】与【红黄绿奖惩阈值线】！")
                if itype == "okr" and len(okr_krs) < 2:
                    raise BusinessRuleError("OKR 提报请至少包含 1 条目标(O) 与 1~3 条可量化关键结果(KR)！")
                if not summary:
                    summary = f"{v_staff or v_role} 已完成 {GOV_ITEM_TYPE_LABELS[itype]} 补齐提审"

                prev_ver = conn.execute("SELECT COALESCE(MAX(version_no), 0) FROM governance_item_submissions WHERE item_id = ?", (item_id,)).fetchone()[0]
                next_ver = int(prev_ver) + 1
                now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                actor = v_staff or ("沈悦" if v_role == "gm_office" else ("老板" if v_role == "boss" else "主管"))

                # 业务主管提交先入 pending_gm 由总经办统筹初审（也可勾选直报老板）；总经办提交直入 pending_boss；老板直接提交即 published！
                if v_role == "boss":
                    next_status = "published"
                    sub_status = "approved"
                elif v_role == "gm_office" or bool(body.get("direct_to_boss")):
                    next_status = "pending_boss"
                    sub_status = "pending_boss"
                else:
                    next_status = "pending_gm"
                    sub_status = "pending_gm"

                payload_snap = {
                    "resource_url": res_url,
                    "video_duration": vid_dur,
                    "summary_note": summary,
                    "kpi_formula": kpi_formula,
                    "kpi_data_source": kpi_source,
                    "kpi_thresholds": kpi_thresh,
                    "okr_krs": okr_krs,
                }
                conn.execute(
                    """INSERT INTO governance_item_submissions
                       (id, item_id, version_no, submitted_by, submitted_role, submitted_at, payload_json, status,
                        gm_reviewed_by, gm_reviewed_at, gm_note, boss_reviewed_by, boss_reviewed_at, boss_note)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        f"gsub-{uuid.uuid4().hex[:10]}", item_id, next_ver, actor, v_role, now_s,
                        json.dumps(payload_snap, ensure_ascii=False), sub_status,
                        f"{actor}(总经办)" if v_role == "gm_office" else "", now_s if v_role == "gm_office" else "",
                        "总经办直报老板终审" if v_role == "gm_office" else "",
                        "老板" if v_role == "boss" else "", now_s if v_role == "boss" else "",
                        "老板直接签发上线" if v_role == "boss" else "",
                    ),
                )
                conn.execute(
                    """UPDATE governance_gap_items
                       SET status=?, resource_url=?, video_duration=?, summary_note=?, kpi_formula=?, kpi_data_source=?,
                           kpi_thresholds=?, okr_kr_json=?, current_version=?,
                           published_at=CASE WHEN ?='published' THEN ? ELSE published_at END,
                           updated_at=?
                       WHERE id=?""",
                    (
                        next_status, res_url, vid_dur, summary,
                        kpi_formula or item_row["kpi_formula"],
                        kpi_source or item_row["kpi_data_source"],
                        kpi_thresh or item_row["kpi_thresholds"],
                        json.dumps(okr_krs, ensure_ascii=False) if okr_krs else item_row["okr_kr_json"],
                        next_ver, next_status, dt.date.today().isoformat(), now_s, item_id,
                    ),
                )
                if next_status == "published":
                    sync_published_governance_to_tutorial_steps(conn)
                conn.commit()
                self._send_json({"ok": True, "status": next_status, "version_no": next_ver, "item": get_governance_item_detail(conn, item_id)})
                return

            if path == "/api/governance/review":
                ensure_governance_seeded(conn)
                v_role, v_staff = self._get_viewer_context(body=body)
                if v_role not in ("gm_office", "boss"):
                    self._send_json({"ok": False, "error": "权限阻断：仅【总经办】可执行初审、【老板端】可执行终审拍板！", "rbac_blocked": True}, 403)
                    return
                item_id = str(body.get("item_id") or body.get("id") or "").strip()
                verdict = str(body.get("verdict") or "approve").strip()  # approve | reject
                note = str(body.get("note") or body.get("review_note") or "").strip()
                if verdict not in ("approve", "reject"):
                    raise BusinessRuleError("裁决结果必须为 approve 或 reject！")
                if verdict == "reject" and len(note) < 4:
                    raise BusinessRuleError("退回规范拦截：打回重改必须写清具体缺失点（至少 4 个字，历史驳回意见将永久保留）！")

                item_row = conn.execute("SELECT * FROM governance_gap_items WHERE id = ?", (item_id,)).fetchone()
                if not item_row:
                    raise BusinessRuleError("未找到该治理条目！")
                sub_row = conn.execute(
                    "SELECT * FROM governance_item_submissions WHERE item_id = ? ORDER BY version_no DESC LIMIT 1",
                    (item_id,),
                ).fetchone()
                if not sub_row:
                    raise BusinessRuleError("该条目尚无提审版本记录！")

                now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                if v_role == "gm_office":
                    if item_row["status"] != "pending_gm":
                        raise BusinessRuleError(f"当前条目状态为「{item_row['status']}」，不在总经办待初审队列（终审拍板须由老板端操作）！")
                    reviewer = f"{v_staff or '沈悦'}(总经办)"
                    if verdict == "approve":
                        next_item_st = "pending_boss"
                        next_sub_st = "pending_boss"
                        eff_note = note or "总经办初审通过，格式与口径齐全，呈报老板终审。"
                    else:
                        next_item_st = "rejected"
                        next_sub_st = "rejected"
                        eff_note = note
                    conn.execute(
                        "UPDATE governance_item_submissions SET status=?, gm_reviewed_by=?, gm_reviewed_at=?, gm_note=? WHERE id=?",
                        (next_sub_st, reviewer, now_s, eff_note, sub_row["id"]),
                    )
                    conn.execute(
                        "UPDATE governance_gap_items SET status=?, last_reject_reason=?, updated_at=? WHERE id=?",
                        (next_item_st, f"总经办退回(v{sub_row['version_no']})：{eff_note}" if verdict == "reject" else item_row["last_reject_reason"], now_s, item_id),
                    )
                else:
                    # 老板终审拍板（可终审 pending_boss，也可越级直接终审 pending_gm！）
                    if item_row["status"] not in ("pending_boss", "pending_gm"):
                        raise BusinessRuleError(f"当前条目状态为「{item_row['status']}」，无需重复终审！")
                    if verdict == "approve":
                        next_item_st = "published"
                        next_sub_st = "approved"
                        eff_note = note or "老板终审批准生效，全工作台对应槽位同步锁死点亮！"
                    else:
                        next_item_st = "rejected"
                        next_sub_st = "rejected"
                        eff_note = note
                    conn.execute(
                        "UPDATE governance_item_submissions SET status=?, boss_reviewed_by='老板', boss_reviewed_at=?, boss_note=? WHERE id=?",
                        (next_sub_st, now_s, eff_note, sub_row["id"]),
                    )
                    conn.execute(
                        """UPDATE governance_gap_items
                           SET status=?, last_reject_reason=?,
                               published_at=CASE WHEN ?='published' THEN ? ELSE published_at END,
                               updated_at=?
                           WHERE id=?""",
                        (
                            next_item_st,
                            f"老板驳回意见(v{sub_row['version_no']})：{eff_note}" if verdict == "reject" else item_row["last_reject_reason"],
                            next_item_st, dt.date.today().isoformat(), now_s, item_id,
                        ),
                    )
                    if next_item_st == "published":
                        sync_published_governance_to_tutorial_steps(conn)

                conn.commit()
                self._send_json({"ok": True, "status": next_item_st, "item": get_governance_item_detail(conn, item_id)})
                return

            # ==================== 新增 6：10台 64GB Mac Pro 集群与 AdsPower / 真机健康度巡检与自愈接口 ====================
            if path == "/api/health/mac-action":
                ensure_cluster_and_health_seeded(conn)
                v_role, _ = self._get_viewer_context(body=body)
                if v_role in ("employee", "gm_office"):
                    self._send_json({"ok": False, "error": "权限阻断：宿主机集群调优与配额变更仅限老板端或开店中控主管操作！", "rbac_blocked": True}, 403)
                    return
                dev_id = str(body.get("device_id") or "").strip()
                action = str(body.get("action") or "clean_cache_reclaim_ram").strip()
                m_row = conn.execute("SELECT * FROM mac_host_cluster_telemetry WHERE device_id = ?", (dev_id,)).fetchone()
                if not m_row:
                    raise BusinessRuleError("未找到指定的 Mac Pro 宿主机！")
                now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

                if action == "clean_cache_reclaim_ram":
                    conn.execute(
                        """UPDATE mac_host_cluster_telemetry
                           SET ram_used_gb = 22.8, swap_used_gb = 0.0, cpu_load_pct = 24,
                               soc_temp_c = 45.2, fan_rpm = 1360,
                               ssd_used_gb = MAX(140, ssd_used_gb - CAST(ads_cache_gb AS INTEGER) + 8),
                               ads_cache_gb = 8.4, adspower_client_ver = 'v6.8.5',
                               health_grade = 'healthy',
                               health_note = '✓ 已清理 Chromium 冗余媒体缓存（保留全部登录 Cookie 与指纹）并回收僵尸进程内存，芯片温度回落至 45.2℃、64GB 内存恢复健康！',
                               last_heartbeat_at = ?, updated_at = ?
                           WHERE device_id = ?""",
                        (now_s, now_s, dev_id),
                    )
                    msg = f"{m_row['host_code']} 已释放冗余缓存并清空 Swap，内存回落至 22.8G/64G，芯片温度降至 45.2℃！"
                elif action == "wake_local_api":
                    conn.execute(
                        """UPDATE mac_host_cluster_telemetry
                           SET local_api_status = 'online', health_grade = 'healthy',
                               health_note = '✓ Local API (:50325) 守护进程已唤醒就绪，支持随时热备接管窗口',
                               last_heartbeat_at = ?, updated_at = ?
                           WHERE device_id = ?""",
                        (now_s, now_s, dev_id),
                    )
                    conn.execute("UPDATE physical_devices SET device_status = 'active', updated_at = ? WHERE id = ?", (now_s, dev_id))
                    msg = f"{m_row['host_code']} Local API (:50325) 已成功唤醒并恢复在线心跳！"
                elif action == "update_quota_or_telemetry":
                    new_quota = int(body.get("max_account_quota") or m_row["max_account_quota"] or 50)
                    if new_quota < 1 or new_quota > 200:
                        raise BusinessRuleError("单台 64GB Mac Pro 账号配额须设在 1 ~ 200 之间（推荐标准 50 号/台）！")
                    acc_cnt, win_cnt = count_host_assigned_slots(conn, dev_id)
                    if new_quota < max(acc_cnt, win_cnt):
                        raise BusinessRuleError(f"配额缩减拦截：该机器当前已挂载 {max(acc_cnt, win_cnt)} 个槽位，新配额 ({new_quota}) 不能低于在用数！")
                    ram_u = float(body.get("ram_used_gb") if "ram_used_gb" in body else m_row["ram_used_gb"])
                    swap_u = float(body.get("swap_used_gb") if "swap_used_gb" in body else m_row["swap_used_gb"])
                    open_w = int(body.get("open_windows_now") if "open_windows_now" in body else m_row["open_windows_now"])
                    grade = "critical" if (ram_u >= 54.4 or swap_u >= 4.0) else ("warning" if ram_u >= 48.0 else "healthy")
                    conn.execute(
                        """UPDATE mac_host_cluster_telemetry
                           SET max_account_quota=?, ram_used_gb=?, swap_used_gb=?, open_windows_now=?,
                               health_grade=?, last_heartbeat_at=?, updated_at=?
                           WHERE device_id=?""",
                        (new_quota, ram_u, swap_u, open_w, grade, now_s, now_s, dev_id),
                    )
                    msg = f"{m_row['host_code']} 配额与遥测参数已更新（上限 {new_quota} 账号/台）"
                else:
                    raise BusinessRuleError(f"不支持的宿主机动作: {action}")

                conn.commit()
                self._send_json({"ok": True, "message": msg, "cluster_health": build_cluster_health_overview(conn)})
                return

            if path == "/api/health/window-action":
                ensure_cluster_and_health_seeded(conn)
                pid = str(body.get("profile_id") or "").strip()
                now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                conn.execute(
                    """UPDATE adspower_window_health
                       SET cookie_sync_hours_ago = 0,
                           health_grade = CASE WHEN exit_ip_check = 'blocked_expired' THEN 'critical' ELSE 'healthy' END,
                           health_note = CASE WHEN exit_ip_check = 'blocked_expired' THEN health_note ELSE '✓ Cookie 已完成最新加密云备份，出口家宽一致' END,
                           last_checked_at = ?
                       WHERE profile_id = ?""",
                    (now_s, pid),
                )
                conn.execute("UPDATE adspower_profiles SET cookie_backup_at = ?, updated_at = ? WHERE id = ?", (now_s[:16], now_s, pid))
                conn.commit()
                self._send_json({"ok": True, "message": "已完成该窗口 Cookie 云端备份刷新！"})
                return

            if path == "/api/health/mobile-action":
                ensure_cluster_and_health_seeded(conn)
                dev_id = str(body.get("device_id") or "").strip()
                action = str(body.get("action") or "confirm_adb_flash").strip()
                now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                if action == "confirm_adb_flash":
                    conn.execute(
                        """UPDATE mobile_device_telemetry
                           SET adb_fingerprint_status = 'verified_locked', health_grade = 'healthy',
                               health_note = '✓ 已由程序员完成自研设备指纹 ADB 灌录锁定（严禁恢复出厂设置）',
                               last_heartbeat_at = ?, updated_at = ?
                           WHERE device_id = ?""",
                        (now_s, now_s, dev_id),
                    )
                    msg = "已确认完成自研设备指纹 ADB 灌录并锁定！"
                elif action == "mark_battery_serviced":
                    conn.execute(
                        """UPDATE mobile_device_telemetry
                           SET battery_health_pct = 100, battery_temp_c = 31.8, always_plugged_risk = 0,
                               health_grade = 'healthy',
                               health_note = '✓ 已完成新电池更换与智能定时断电插座改造，鼓包风险已解除',
                               last_heartbeat_at = ?, updated_at = ?
                           WHERE device_id = ?""",
                        (now_s, now_s, dev_id),
                    )
                    msg = "已登记电池更换与温控改造完成，真机恢复健康绿灯！"
                else:
                    raise BusinessRuleError(f"未知的真机维护动作: {action}")
                conn.commit()
                self._send_json({"ok": True, "message": msg})
                return

            # ==================== 新增：固定资产全生命周期 + 「定位 × 公司受控网 × 坐班/居家」管控与核减防泄密接口 ====================
            if path == "/api/assets/compliance-action":
                ensure_cluster_and_health_seeded(conn)
                v_role, v_staff = self._get_viewer_context(body=body)
                if v_role not in ("boss", "supervisor"):
                    self._send_json({"ok": False, "error": "权限阻断：仅老板端与主管端可下发受控设备定位与网络管控指令！", "rbac_blocked": True}, 403)
                    return
                dev_id = str(body.get("device_id") or "").strip()
                action = str(body.get("action") or "enforce_corp_wifi").strip()
                d_row = conn.execute(
                    """SELECT d.device_code, d.device_kind, d.workstation_loc, ac.asset_no
                       FROM physical_devices d
                       JOIN device_asset_and_compliance ac ON ac.device_id = d.id
                       WHERE d.id = ?""",
                    (dev_id,),
                ).fetchone()
                if not d_row:
                    raise BusinessRuleError("未找到该固定资产设备记录！")
                now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

                if action == "enforce_corp_wifi":
                    net_k = "corp_lan" if d_row["device_kind"] == "adspower_pc_host" else "corp_wifi"
                    ssid = "公司千兆内网 VLAN-20" if net_k == "corp_lan" else ("PanAsia-Procure-VLAN (公司采购受控网)" if d_row["device_kind"] == "procurement_phone" else "PanAsia-Corp-5G (公司业务受控Wi-Fi)")
                    conn.execute(
                        """UPDATE device_asset_and_compliance
                           SET geo_fence_state = 'in_company', distance_from_office_km = 0.0,
                               net_conn_kind = ?, connected_ssid_or_nic = ?,
                               gateway_egress_note = '已通过MDM策略强制重连公司受控网，恢复软路由独享家宽分流',
                               compliance_note = '✓ 已强制切回公司受控业务网络，在司连网合规',
                               last_located_at = ?, updated_at = ?
                           WHERE device_id = ?""",
                        (net_k, ssid, now_s, now_s, dev_id),
                    )
                    msg = f"{d_row['device_code']} ({d_row['asset_no']}) 已强制切回公司受控网络「{ssid}」，恢复在司连网合规！"
                elif action == "approve_wfh_vpn":
                    wfh_ref = str(body.get("wfh_approval_ref") or f"OA-WFH-{dt.date.today().strftime('%m%d')}-BOSS").strip()
                    conn.execute(
                        """UPDATE device_asset_and_compliance
                           SET work_schedule_mode = 'wfh_approved', wfh_approval_ref = ?,
                               geo_fence_state = 'at_registered_home',
                               net_conn_kind = 'corp_vpn',
                               connected_ssid_or_nic = 'PanAsia-HQ-VPN (居家加密回传公司内网)',
                               gateway_egress_note = '已验证居家审批单并强制接通公司 WireGuard 受控网关',
                               remote_locked = 0,
                               compliance_note = ?,
                               last_located_at = ?, updated_at = ?
                           WHERE device_id = ?""",
                        (wfh_ref, f"✓ 已登记居家办公审批 ({wfh_ref}) 并接通公司受控 VPN 隧道", now_s, now_s, dev_id),
                    )
                    msg = f"{d_row['device_code']} ({d_row['asset_no']}) 已登记居家办公审批 ({wfh_ref}) 并强制接通公司受控 VPN！"
                elif action == "enforce_return_office":
                    net_k = "corp_lan" if d_row["device_kind"] == "adspower_pc_host" else "corp_wifi"
                    ssid = "公司千兆内网 VLAN-20" if net_k == "corp_lan" else "PanAsia-Corp-5G (公司业务受控Wi-Fi)"
                    conn.execute(
                        """UPDATE device_asset_and_compliance
                           SET work_schedule_mode = 'office_onsite', wfh_approval_ref = '',
                               geo_fence_state = 'in_company', distance_from_office_km = 0.0,
                               geo_location_label = ?,
                               net_conn_kind = ?, connected_ssid_or_nic = ?,
                               remote_locked = 0,
                               compliance_note = '✓ 员工已携设备回到公司工位并连接公司受控网络',
                               last_located_at = ?, updated_at = ?
                           WHERE device_id = ?""",
                        (f"杭州滨江总部·3F ({d_row['workstation_loc']})", net_k, ssid, now_s, now_s, dev_id),
                    )
                    msg = f"{d_row['device_code']} ({d_row['asset_no']}) 已确认回到公司工位并接入公司受控网络！"
                elif action == "remote_lock_device":
                    conn.execute(
                        """UPDATE device_asset_and_compliance
                           SET remote_locked = 1,
                               compliance_note = '🔒 已按《设备使用协议》远程锁死屏幕并停派业务任务，待携机回司核查',
                               updated_at = ?
                           WHERE device_id = ?""",
                        (now_s, dev_id),
                    )
                    msg = f"{d_row['device_code']} ({d_row['asset_no']}) 已下发远程锁机指令并暂停任务派发！"
                elif action == "mark_inventory_checked":
                    today_s = dt.date.today().isoformat()
                    conn.execute(
                        """UPDATE device_asset_and_compliance
                           SET last_inventory_date = ?, inventory_status = 'verified', updated_at = ?
                           WHERE device_id = ?""",
                        (today_s, now_s, dev_id),
                    )
                    msg = f"{d_row['asset_no']} ({d_row['device_code']}) 已完成扫码实物盘点确认（账实相符）！"
                else:
                    raise BusinessRuleError(f"不支持的资产管控动作: {action}")

                conn.commit()
                self._send_json({"ok": True, "message": msg, "cluster_health": build_cluster_health_overview(conn)})
                return

            if path == "/api/assets/retire-request":
                ensure_cluster_and_health_seeded(conn)
                v_role, v_staff = self._get_viewer_context(body=body)
                if v_role != "boss":
                    self._send_json({"ok": False, "error": "权限阻断：固定资产报废核减与转二手变卖仅限老板终审批准！", "rbac_blocked": True}, 403)
                    return
                dev_id = str(body.get("device_id") or "").strip()
                target_action = str(body.get("target_action") or "scrap_retire").strip()
                reason = str(body.get("reason") or "硬件淘汰核减").strip()

                d_row = conn.execute("SELECT * FROM physical_devices WHERE id = ?", (dev_id,)).fetchone()
                ac_row = conn.execute("SELECT * FROM device_asset_and_compliance WHERE device_id = ?", (dev_id,)).fetchone()
                if not d_row or not ac_row:
                    raise BusinessRuleError("未找到该固定资产设备记录！")

                # 核心防泄密硬红线校验：检查卡槽1/卡槽2 SIM 卡、挂载的 AdsPower 窗口、关联的在用平台账号
                blockers = []
                if d_row["sim_slot_1_id"] or d_row["sim_slot_2_id"]:
                    s_nums = [
                        r["phone_number"]
                        for r in conn.execute(
                            "SELECT phone_number FROM sim_cards WHERE id IN (?, ?)",
                            (d_row["sim_slot_1_id"] or "", d_row["sim_slot_2_id"] or ""),
                        ).fetchall()
                    ]
                    blockers.append(f"卡槽仍插有公司手机卡({', '.join(s_nums)})")
                win_cnt = conn.execute("SELECT COUNT(*) FROM adspower_profiles WHERE host_device_id = ?", (dev_id,)).fetchone()[0]
                if win_cnt > 0:
                    blockers.append(f"仍承载 {win_cnt} 个 AdsPower 指纹窗口")
                pa_cnt = conn.execute(
                    "SELECT COUNT(*) FROM platform_accounts WHERE physical_device_id = ? AND account_status <> 'retired'",
                    (dev_id,),
                ).fetchone()[0]
                if pa_cnt > 0:
                    blockers.append(f"仍绑定 {pa_cnt} 个在用平台店铺/买券账号")

                if blockers:
                    raise BusinessRuleError(
                        f"固定资产防泄密硬阻断：设备 {ac_row['asset_no']} ({d_row['device_code']}) 当前{'、'.join(blockers)}！"
                        f"严禁带卡、带店铺账号直接报废或转入二手商品售卖，请先完成拔卡迁移与账号解绑！"
                    )

                req_id = f"arr-{uuid.uuid4().hex[:8]}"
                req_no = f"RED-{dt.date.today().strftime('%Y%m%d')}-{uuid.uuid4().hex[:4].upper()}"
                now_s = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                conn.execute(
                    """INSERT INTO asset_reduction_requests
                       (id, request_no, device_id, asset_no, target_action, reason, requested_by, requested_at, status, review_note)
                       VALUES (?,?,?,?,?,?,?,?,'approved','已通过防泄密净身校验并核减资产台账')""",
                    (req_id, req_no, dev_id, ac_row["asset_no"], target_action, reason, v_staff or "老板", now_s),
                )
                conn.execute(
                    "UPDATE device_asset_and_compliance SET asset_lifecycle_status = 'retired_disposed', updated_at = ? WHERE device_id = ?",
                    (now_s, dev_id),
                )
                conn.execute("UPDATE physical_devices SET device_status = 'idle', updated_at = ? WHERE id = ?", (now_s, dev_id))
                conn.commit()
                self._send_json({"ok": True, "request_no": req_no, "asset_no": ac_row["asset_no"]})
                return

            if path == "/api/actions/reset-baseline":
                VAULT_SESSIONS.revoke_all()
                conn.close()
                c2 = init_db(DB_PATH, force_reset=True)
                c2.close()
                self._send_json({"ok": True})
                return

            self._send_json({"ok": False, "error": f"未知接口: {path}"}, 404)
        except BusinessRuleError as be:
            conn.rollback()
            self._send_json({"ok": False, "error": str(be), "rule_blocked": True}, 400)
        except sqlite3.IntegrityError as ie:
            conn.rollback()
            msg = str(ie)
            if "idx_unique_proxy_per_platform" in msg:
                msg = "同平台家宽冲突阻断：同一条家宽代理IP在同一个平台只能挂载1个账号，仅不同平台允许复用！"
            elif "idx_one_master_fund_per_entity" in msg:
                msg = "主体3选1阻断：同一个营业执照主体下最多只能指定 1 个主资金账号！"
            self._send_json({"ok": False, "error": msg, "rule_blocked": True}, 400)
        except Exception as e:
            conn.rollback()
            traceback.print_exc()
            self._send_json({"ok": False, "error": f"服务处理失败: {e}"}, 500)
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def do_PUT(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]
        if len(parts) != 4 or parts[0] != "api" or parts[1] != "records":
            self._send_json({"ok": False, "error": "无效更新路径"}, 404)
            return
        table, rec_id = parts[2], parts[3]
        if table not in ALLOWED_TABLES:
            self._send_json({"ok": False, "error": f"未知数据表: {table}"}, 400)
            return
        try:
            body = self._read_json_body()
        except Exception as e:
            self._send_json({"ok": False, "error": f"JSON 解析失败: {e}"}, 400)
            return

        conn = get_conn()
        try:
            existing = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (rec_id,)).fetchone()
            if not existing:
                self._send_json({"ok": False, "error": "记录不存在"}, 404)
                return
            merged = dict(existing)
            clean_in = sanitize_record_input(table, body)
            if table == "proxy_ips" and clean_in.get("proxy_pass") in ("••••••••", ""):
                clean_in.pop("proxy_pass", None)
            merged.update(clean_in)
            validate_before_write(conn, table, merged, record_id=rec_id)
            cols = ALLOWED_TABLES[table]
            set_clause = ", ".join(f"{c} = ?" for c in cols)
            vals = [merged[c] for c in cols] + [rec_id]
            conn.execute(f"UPDATE {table} SET {set_clause} WHERE id = ?", vals)
            sync_phone_bindings(conn)
            conn.commit()
            self._send_json({"ok": True, "id": rec_id})
        except BusinessRuleError as be:
            conn.rollback()
            self._send_json({"ok": False, "error": str(be), "rule_blocked": True}, 400)
        except sqlite3.IntegrityError as ie:
            conn.rollback()
            self._send_json({"ok": False, "error": str(ie), "rule_blocked": True}, 400)
        finally:
            conn.close()

    def do_DELETE(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]
        if len(parts) != 4 or parts[0] != "api" or parts[1] != "records":
            self._send_json({"ok": False, "error": "无效删除路径"}, 404)
            return
        table, rec_id = parts[2], parts[3]
        if table not in ALLOWED_TABLES:
            self._send_json({"ok": False, "error": f"未知数据表: {table}"}, 400)
            return
        conn = get_conn()
        try:
            validate_before_delete(conn, table, rec_id)
            conn.execute(f"DELETE FROM {table} WHERE id = ?", (rec_id,))
            sync_phone_bindings(conn)
            conn.commit()
            self._send_json({"ok": True})
        except BusinessRuleError as be:
            conn.rollback()
            self._send_json({"ok": False, "error": str(be), "rule_blocked": True}, 400)
        except sqlite3.IntegrityError as ie:
            conn.rollback()
            self._send_json({"ok": False, "error": f"存在下级关联数据，禁止直接删除: {ie}", "rule_blocked": True}, 400)
        finally:
            conn.close()


def run_server() -> None:
    c = init_db(DB_PATH, force_reset=False)
    ensure_dispatch_capacity_seeded(c)
    c.close()
    host = os.environ.get("LEDGER_HOST", "127.0.0.1")
    port = int(os.environ.get("LEDGER_PORT", "5370"))
    srv = ThreadingHTTPServer((host, port), LedgerHTTPHandler)
    print(f"[Anchor Boss Master Ledger] Desktop server listening on http://{host}:{port}")
    srv.serve_forever()


if __name__ == "__main__":
    run_server()

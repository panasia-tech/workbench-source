#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
泛亚锚点 · 老板全量台账（桌面专属版）SQLite 数据库初始化与全闭环基准数据生成
严格落实业务规则：
1. 1签约委托客户 -> 4受托营业执照主体 -> 4税务局独立登记 + 4工商管理局独立年报（管理运营公司代管运维，客户独立纳税）
2. 每个营业执照主体下企业支付宝资金账号「3选1」设为主资金账号，同主体采购子号通过「因公支付」扣主账号余额；严禁跨营业执照串户（违反税法）
3. 严禁同一账号既买又卖（sales_only / purchase_only / master_fund / marketing_only 严格互斥）
4. 家宽代理IP（¥10/月）：同一平台必须独占1条家宽IP，不同平台允许复用同一条家宽IP；强管到期时间且禁止删除在用代理
5. 手机卡「一主4副」动态配额（5 - 办卡前个人存量卡 = 剩余可开卡数），缺口由带合约期的外部卡补齐；全量管理话费余额/月租/充值台账与 N:N 号码关联对象图谱
6. 全平台覆盖：闲鱼、淘宝采购、淘宝网店、微信、微信小店、小红书社媒营销、小红书小店、大众点评(买卡券)、抖音(买卡券)、抖省省(买卡券)、抖店、京东(采购/网店)
"""

from __future__ import annotations
import os
import sqlite3
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
RUNTIME_DIR = BASE_DIR / ".demo-runtime"
DEFAULT_DB_PATH = RUNTIME_DIR / "master_ledger.sqlite"


SCHEMA_SQL = """
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS legal_persons (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    id_card_no TEXT NOT NULL,
    primary_phone TEXT NOT NULL,
    residence_city TEXT NOT NULL DEFAULT '',
    face_verify_sla TEXT NOT NULL DEFAULT '15分钟内配合刷脸',
    agency_contract_no TEXT NOT NULL DEFAULT '',
    contract_expires_at TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'warning', 'suspended')),
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS business_entities (
    id TEXT PRIMARY KEY,
    legal_person_id TEXT NOT NULL REFERENCES legal_persons(id) ON DELETE RESTRICT,
    entity_code TEXT NOT NULL UNIQUE,
    entity_name TEXT NOT NULL,
    uscc TEXT NOT NULL UNIQUE,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('individual_business', 'company', 'sole_proprietorship')),
    registration_authority TEXT NOT NULL,
    established_date TEXT NOT NULL,
    registered_address TEXT NOT NULL,
    business_scope TEXT NOT NULL DEFAULT '',
    license_status TEXT NOT NULL DEFAULT 'active' CHECK (license_status IN ('active', 'abnormal', 'cancelling', 'cancelled')),
    target_store_slots INTEGER NOT NULL DEFAULT 4,
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS sim_cards (
    id TEXT PRIMARY KEY,
    legal_person_id TEXT REFERENCES legal_persons(id) ON DELETE SET NULL,
    phone_number TEXT NOT NULL UNIQUE,
    carrier TEXT NOT NULL CHECK (carrier IN ('中国移动', '中国联通', '中国电信', '中国广电')),
    region_city TEXT NOT NULL DEFAULT '浙江杭州',
    iccid TEXT NOT NULL DEFAULT '',
    card_category TEXT NOT NULL CHECK (card_category IN ('company_master', 'company_sub', 'personal_existing', 'external_contract')),
    master_sim_id TEXT REFERENCES sim_cards(id) ON DELETE SET NULL,
    real_name_holder TEXT NOT NULL,
    holder_relation TEXT NOT NULL DEFAULT '客户法人本人',
    custodian_staff TEXT NOT NULL DEFAULT '',
    billing_mode TEXT NOT NULL DEFAULT 'independent' CHECK (billing_mode IN ('independent', 'shared_master')),
    plan_name TEXT NOT NULL DEFAULT '',
    monthly_rent_fen INTEGER NOT NULL DEFAULT 0,
    billing_day INTEGER NOT NULL DEFAULT 1 CHECK (billing_day BETWEEN 1 AND 31),
    balance_fen INTEGER NOT NULL DEFAULT 0,
    low_balance_threshold_fen INTEGER NOT NULL DEFAULT 3000,
    last_recharge_date TEXT NOT NULL DEFAULT '',
    last_recharge_fen INTEGER NOT NULL DEFAULT 0,
    next_recharge_due TEXT NOT NULL DEFAULT '',
    is_external INTEGER NOT NULL DEFAULT 0 CHECK (is_external IN (0, 1)),
    external_vendor TEXT NOT NULL DEFAULT '',
    contract_start_date TEXT NOT NULL DEFAULT '',
    contract_end_date TEXT NOT NULL DEFAULT '',
    rebind_lead_days INTEGER NOT NULL DEFAULT 30,
    sim_status TEXT NOT NULL DEFAULT 'active' CHECK (sim_status IN ('active', 'low_balance', 'contract_expiring', 'rebind_pending', 'arrears_suspended', 'retired')),
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS carrier_quotas (
    id TEXT PRIMARY KEY,
    legal_person_id TEXT REFERENCES legal_persons(id) ON DELETE CASCADE,
    holder_name TEXT NOT NULL,
    holder_id_card TEXT NOT NULL,
    holder_role TEXT NOT NULL DEFAULT '客户法人本人',
    carrier TEXT NOT NULL CHECK (carrier IN ('中国移动', '中国联通', '中国电信', '中国广电')),
    statutory_limit INTEGER NOT NULL DEFAULT 5,
    existing_personal_cards INTEGER NOT NULL DEFAULT 0 CHECK (existing_personal_cards >= 0 AND existing_personal_cards <= 5),
    yztc_verified_date TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    UNIQUE (holder_name, carrier)
);

CREATE TABLE IF NOT EXISTS tax_registrations (
    id TEXT PRIMARY KEY,
    business_entity_id TEXT NOT NULL UNIQUE REFERENCES business_entities(id) ON DELETE CASCADE,
    tax_bureau_name TEXT NOT NULL,
    taxpayer_type TEXT NOT NULL CHECK (taxpayer_type IN ('小规模纳税人', '一般纳税人')),
    collection_mode TEXT NOT NULL CHECK (collection_mode IN ('查账征收', '核定征收')),
    filing_cycle TEXT NOT NULL CHECK (filing_cycle IN ('按季申报', '按月申报')),
    tax_officer_name TEXT NOT NULL,
    bound_sim_id TEXT REFERENCES sim_cards(id) ON DELETE SET NULL,
    current_period TEXT NOT NULL DEFAULT '2026-Q4',
    quarter_sales_fen INTEGER NOT NULL DEFAULT 0,
    quarter_exempt_limit_fen INTEGER NOT NULL DEFAULT 30000000,
    filing_status TEXT NOT NULL DEFAULT 'filed' CHECK (filing_status IN ('filed', 'pending', 'warning', 'overdue')),
    next_due_date TEXT NOT NULL,
    receipt_no TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS annual_reports (
    id TEXT PRIMARY KEY,
    business_entity_id TEXT NOT NULL REFERENCES business_entities(id) ON DELETE CASCADE,
    report_year INTEGER NOT NULL,
    aic_bureau_name TEXT NOT NULL,
    window_period TEXT NOT NULL DEFAULT '2026-01-01 ~ 2026-06-30',
    liaison_name TEXT NOT NULL,
    liaison_sim_id TEXT REFERENCES sim_cards(id) ON DELETE SET NULL,
    report_status TEXT NOT NULL CHECK (report_status IN ('publicized', 'pending', 'overdue_abnormal')),
    submitted_date TEXT NOT NULL DEFAULT '',
    publicity_receipt_no TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    UNIQUE (business_entity_id, report_year)
);

CREATE TABLE IF NOT EXISTS alipay_accounts (
    id TEXT PRIMARY KEY,
    legal_person_id TEXT NOT NULL REFERENCES legal_persons(id) ON DELETE RESTRICT,
    business_entity_id TEXT NOT NULL REFERENCES business_entities(id) ON DELETE RESTRICT,
    account_code TEXT NOT NULL UNIQUE,
    account_name TEXT NOT NULL,
    login_email TEXT NOT NULL UNIQUE,
    alipay_uid TEXT NOT NULL DEFAULT '',
    entity_fund_slot TEXT NOT NULL DEFAULT '主体3大资金户之一',
    trade_direction TEXT NOT NULL CHECK (trade_direction IN ('master_fund', 'purchase_only', 'sales_only')),
    is_entity_master_fund INTEGER NOT NULL DEFAULT 0 CHECK (is_entity_master_fund IN (0, 1)),
    corporate_pay_enabled INTEGER NOT NULL DEFAULT 0 CHECK (corporate_pay_enabled IN (0, 1)),
    master_alipay_id TEXT REFERENCES alipay_accounts(id) ON DELETE RESTRICT,
    daily_limit_fen INTEGER NOT NULL DEFAULT 0,
    single_tx_limit_fen INTEGER NOT NULL DEFAULT 10000000,
    bound_sim_id TEXT REFERENCES sim_cards(id) ON DELETE SET NULL,
    settlement_bank TEXT NOT NULL DEFAULT '',
    settlement_card_no TEXT NOT NULL DEFAULT '',
    balance_fen INTEGER NOT NULL DEFAULT 0,
    frozen_reserve_fen INTEGER NOT NULL DEFAULT 0,
    month_inflow_fen INTEGER NOT NULL DEFAULT 0,
    month_outflow_fen INTEGER NOT NULL DEFAULT 0,
    cert_sign_mode TEXT NOT NULL DEFAULT '公钥证书三件套已备',
    finance_book_code TEXT NOT NULL DEFAULT '',
    bill_sync_status TEXT NOT NULL DEFAULT '已授权日账单' CHECK (bill_sync_status IN ('已授权日账单', '手工导账单', '待开通授权')),
    account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'risk_control', 'frozen')),
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_master_fund_per_entity
ON alipay_accounts (business_entity_id)
WHERE is_entity_master_fund = 1;

CREATE TABLE IF NOT EXISTS alipay_bills (
    id TEXT PRIMARY KEY,
    bill_date TEXT NOT NULL,
    business_entity_id TEXT NOT NULL REFERENCES business_entities(id) ON DELETE CASCADE,
    alipay_account_id TEXT NOT NULL REFERENCES alipay_accounts(id) ON DELETE CASCADE,
    deducted_master_alipay_id TEXT REFERENCES alipay_accounts(id) ON DELETE SET NULL,
    related_platform_account_id TEXT REFERENCES platform_accounts(id) ON DELETE SET NULL,
    flow_direction TEXT NOT NULL CHECK (flow_direction IN (
        'inflow_sales',
        'outflow_corporate_pay',
        'inflow_purchase_refund',
        'outflow_sales_refund',
        'outflow_deposit',
        'inflow_deposit_return',
        'inflow_topup',
        'outflow_withdraw'
    )),
    biz_scene TEXT NOT NULL,
    counterparty TEXT NOT NULL,
    platform_order_ref TEXT NOT NULL DEFAULT '',
    amount_fen INTEGER NOT NULL,
    fee_fen INTEGER NOT NULL DEFAULT 0,
    oa_finance_voucher_no TEXT NOT NULL DEFAULT '',
    reconcile_status TEXT NOT NULL DEFAULT 'matched' CHECK (reconcile_status IN ('matched', 'pending', 'variance')),
    notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sim_fee_records (
    id TEXT PRIMARY KEY,
    sim_card_id TEXT NOT NULL REFERENCES sim_cards(id) ON DELETE CASCADE,
    occurred_date TEXT NOT NULL,
    change_type TEXT NOT NULL CHECK (change_type IN ('recharge', 'monthly_rent', 'extra_package')),
    amount_fen INTEGER NOT NULL,
    balance_after_fen INTEGER NOT NULL,
    operator_name TEXT NOT NULL DEFAULT '',
    payment_source TEXT NOT NULL DEFAULT '人工登记（待接OA/钉钉）',
    oa_approval_ref TEXT NOT NULL DEFAULT '待接入OA/钉钉审批',
    notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS proxy_ips (
    id TEXT PRIMARY KEY,
    proxy_code TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL DEFAULT '演示代理服务',
    plan_name TEXT NOT NULL DEFAULT '独享家宽SOCKS5-25M',
    isp_region TEXT NOT NULL DEFAULT '浙江杭州电信家宽',
    protocol TEXT NOT NULL DEFAULT 'SOCKS5' CHECK (protocol IN ('SOCKS5', 'HTTP', 'HTTPS')),
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    proxy_user TEXT NOT NULL,
    proxy_pass TEXT NOT NULL,
    exit_ip TEXT NOT NULL,
    monthly_cost_fen INTEGER NOT NULL DEFAULT 1000,
    purchased_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    connectivity_status TEXT NOT NULL DEFAULT 'online' CHECK (connectivity_status IN ('online', 'expiring', 'expired', 'offline')),
    oa_renewal_ref TEXT NOT NULL DEFAULT '待接入OA/钉钉续费',
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS proxy_renewals (
    id TEXT PRIMARY KEY,
    proxy_ip_id TEXT NOT NULL REFERENCES proxy_ips(id) ON DELETE CASCADE,
    renewed_at TEXT NOT NULL,
    months_added INTEGER NOT NULL DEFAULT 1,
    amount_fen INTEGER NOT NULL DEFAULT 1000,
    old_expires_at TEXT NOT NULL,
    new_expires_at TEXT NOT NULL,
    operator_name TEXT NOT NULL DEFAULT '',
    oa_approval_ref TEXT NOT NULL DEFAULT '待接入OA/钉钉续费'
);

CREATE TABLE IF NOT EXISTS physical_devices (
    id TEXT PRIMARY KEY,
    legal_person_id TEXT REFERENCES legal_persons(id) ON DELETE SET NULL,
    device_code TEXT NOT NULL UNIQUE,
    device_kind TEXT NOT NULL CHECK (device_kind IN ('work_phone', 'procurement_phone', 'adspower_pc_host', 'verify_phone')),
    brand_model TEXT NOT NULL,
    serial_number TEXT NOT NULL UNIQUE,
    imei_1 TEXT NOT NULL DEFAULT '',
    imei_2 TEXT NOT NULL DEFAULT '',
    role_isolation TEXT NOT NULL CHECK (role_isolation IN ('sales_only', 'purchase_only', 'host_cluster', 'verify_shared')),
    sim_slot_1_id TEXT REFERENCES sim_cards(id) ON DELETE SET NULL,
    sim_slot_2_id TEXT REFERENCES sim_cards(id) ON DELETE SET NULL,
    workstation_loc TEXT NOT NULL DEFAULT '',
    custodian_staff TEXT NOT NULL DEFAULT '',
    installed_apps TEXT NOT NULL DEFAULT '',
    device_status TEXT NOT NULL DEFAULT 'active' CHECK (device_status IN ('active', 'maintenance', 'idle')),
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS adspower_profiles (
    id TEXT PRIMARY KEY,
    profile_code TEXT NOT NULL UNIQUE,
    ads_serial_no TEXT NOT NULL UNIQUE,
    ads_user_id TEXT NOT NULL UNIQUE,
    window_name TEXT NOT NULL,
    group_name TEXT NOT NULL,
    host_device_id TEXT NOT NULL REFERENCES physical_devices(id) ON DELETE RESTRICT,
    proxy_ip_id TEXT NOT NULL REFERENCES proxy_ips(id) ON DELETE RESTRICT,
    role_isolation TEXT NOT NULL CHECK (role_isolation IN ('sales_only', 'purchase_only', 'marketing_only')),
    fingerprint_locked INTEGER NOT NULL DEFAULT 1 CHECK (fingerprint_locked IN (0, 1)),
    cookie_backup_at TEXT NOT NULL DEFAULT '',
    profile_status TEXT NOT NULL DEFAULT 'active' CHECK (profile_status IN ('active', 'proxy_warning', 'stopped')),
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS platform_accounts (
    id TEXT PRIMARY KEY,
    legal_person_id TEXT NOT NULL REFERENCES legal_persons(id) ON DELETE RESTRICT,
    business_entity_id TEXT REFERENCES business_entities(id) ON DELETE SET NULL,
    platform TEXT NOT NULL CHECK (platform IN (
        'xianyu', 'taobao_buyer', 'taobao_store',
        'wechat', 'wechat_shop',
        'xiaohongshu_mkt', 'xiaohongshu_shop',
        'dianping', 'douyin', 'doushengsheng', 'doudian',
        'jd_buyer', 'jd_store'
    )),
    account_code TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    platform_login_id TEXT NOT NULL,
    account_role TEXT NOT NULL CHECK (account_role IN ('sales_only', 'purchase_only', 'marketing_only')),
    virtual_biz_usage TEXT NOT NULL DEFAULT '',
    bound_sim_id TEXT REFERENCES sim_cards(id) ON DELETE SET NULL,
    alipay_account_id TEXT REFERENCES alipay_accounts(id) ON DELETE SET NULL,
    adspower_profile_id TEXT REFERENCES adspower_profiles(id) ON DELETE SET NULL,
    proxy_ip_id TEXT REFERENCES proxy_ips(id) ON DELETE RESTRICT,
    physical_device_id TEXT REFERENCES physical_devices(id) ON DELETE SET NULL,
    lead_target_account_id TEXT REFERENCES platform_accounts(id) ON DELETE SET NULL,
    settlement_channel TEXT NOT NULL DEFAULT 'alipay_direct' CHECK (settlement_channel IN (
        'alipay_direct',
        'wechat_pay_mch',
        'douyin_pay_mch',
        'xhs_merchant',
        'jd_wallet_mch',
        'corporate_pay_deduct',
        'overseas_card_fx',
        'no_settlement'
    )),
    merchant_account_no TEXT NOT NULL DEFAULT '',
    settlement_bank_ref TEXT NOT NULL DEFAULT '',
    settlement_cycle TEXT NOT NULL DEFAULT '确认收货实时',
    commission_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (commission_rate_bps >= 0 AND commission_rate_bps <= 10000),
    deposit_fen INTEGER NOT NULL DEFAULT 0,
    deposit_source_ref TEXT NOT NULL DEFAULT '',
    frozen_balance_fen INTEGER NOT NULL DEFAULT 0,
    month_gmv_fen INTEGER NOT NULL DEFAULT 0,
    month_cost_fen INTEGER NOT NULL DEFAULT 0,
    month_refund_fen INTEGER NOT NULL DEFAULT 0,
    tax_invoice_mode TEXT NOT NULL DEFAULT '个体普票按季30万阈值合规监测',
    finance_book_code TEXT NOT NULL DEFAULT '',
    daily_quota_note TEXT NOT NULL DEFAULT '',
    operator_staff TEXT NOT NULL DEFAULT '',
    account_status TEXT NOT NULL DEFAULT 'active' CHECK (account_status IN ('active', 'warming', 'restricted', 'retired')),
    notes TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 核心硬约束：同一个平台必须独占一条家宽代理IP，不同平台可以复用同一条家宽代理IP！
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_proxy_per_platform
ON platform_accounts (proxy_ip_id, platform)
WHERE proxy_ip_id IS NOT NULL AND account_status <> 'retired';

CREATE TABLE IF NOT EXISTS phone_bindings (
    id TEXT PRIMARY KEY,
    sim_card_id TEXT NOT NULL REFERENCES sim_cards(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('alipay', 'tax', 'annual_report', 'platform_account', 'enterprise_email')),
    target_id TEXT NOT NULL,
    target_name_snapshot TEXT NOT NULL,
    platform_or_org TEXT NOT NULL,
    binding_role TEXT NOT NULL DEFAULT '主绑定手机',
    rebind_priority TEXT NOT NULL DEFAULT 'high' CHECK (rebind_priority IN ('critical', 'high', 'normal')),
    bound_date TEXT NOT NULL DEFAULT '2026-09-10',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rebind_todo', 'unbound')),
    notes TEXT NOT NULL DEFAULT '',
    UNIQUE (sim_card_id, target_type, target_id, binding_role)
);

-- SQLite 触发器层硬防呆（防止绕过 API 直接写库违规）
CREATE TRIGGER IF NOT EXISTS trg_alipay_validate_insert
BEFORE INSERT ON alipay_accounts
BEGIN
    SELECT CASE
        WHEN NEW.is_entity_master_fund = 1 AND NEW.trade_direction <> 'master_fund'
            THEN RAISE(ABORT, '税法与内控阻断：设为本主体主资金账号时，资金属性必须标为 master_fund（主资金池），严禁混标直接买卖！')
        WHEN NEW.corporate_pay_enabled = 1 AND NEW.trade_direction <> 'purchase_only'
            THEN RAISE(ABORT, '内控阻断：仅【采购专用账号 (purchase_only)】允许开启因公支付扣主账号余额，销售账号严禁既买又卖！')
        WHEN NEW.corporate_pay_enabled = 1 AND NEW.master_alipay_id IS NULL
            THEN RAISE(ABORT, '内控阻断：开启因公支付的采购子号必须指定同营业执照主体下的主资金账号！')
        WHEN NEW.master_alipay_id IS NOT NULL AND (
            SELECT business_entity_id FROM alipay_accounts WHERE id = NEW.master_alipay_id
        ) <> NEW.business_entity_id
            THEN RAISE(ABORT, '违反税法阻断：因公支付采购子账号与被扣款主资金账号必须属于同一个营业执照主体，严禁跨主体资金乱串！')
        WHEN NEW.master_alipay_id IS NOT NULL AND (
            SELECT is_entity_master_fund FROM alipay_accounts WHERE id = NEW.master_alipay_id
        ) <> 1
            THEN RAISE(ABORT, '内控阻断：因公支付只能挂靠本主体选定的唯一主资金账号（3选1主户）！')
    END;
END;

CREATE TRIGGER IF NOT EXISTS trg_alipay_validate_update
BEFORE UPDATE ON alipay_accounts
BEGIN
    SELECT CASE
        WHEN NEW.is_entity_master_fund = 1 AND NEW.trade_direction <> 'master_fund'
            THEN RAISE(ABORT, '税法与内控阻断：设为本主体主资金账号时，资金属性必须标为 master_fund（主资金池），严禁混标直接买卖！')
        WHEN NEW.corporate_pay_enabled = 1 AND NEW.trade_direction <> 'purchase_only'
            THEN RAISE(ABORT, '内控阻断：仅【采购专用账号 (purchase_only)】允许开启因公支付扣主账号余额，销售账号严禁既买又卖！')
        WHEN NEW.corporate_pay_enabled = 1 AND NEW.master_alipay_id IS NULL
            THEN RAISE(ABORT, '内控阻断：开启因公支付的采购子号必须指定同营业执照主体下的主资金账号！')
        WHEN NEW.master_alipay_id IS NOT NULL AND (
            SELECT business_entity_id FROM alipay_accounts WHERE id = NEW.master_alipay_id
        ) <> NEW.business_entity_id
            THEN RAISE(ABORT, '违反税法阻断：因公支付采购子账号与被扣款主资金账号必须属于同一个营业执照主体，严禁跨主体资金乱串！')
        WHEN NEW.master_alipay_id IS NOT NULL AND (
            SELECT is_entity_master_fund FROM alipay_accounts WHERE id = NEW.master_alipay_id
        ) <> 1
            THEN RAISE(ABORT, '内控阻断：因公支付只能挂靠本主体选定的唯一主资金账号（3选1主户）！')
    END;
END;

CREATE TRIGGER IF NOT EXISTS trg_platform_validate_insert
BEFORE INSERT ON platform_accounts
BEGIN
    SELECT CASE
        WHEN NEW.account_role = 'sales_only' AND NEW.alipay_account_id IS NOT NULL AND (
            SELECT trade_direction FROM alipay_accounts WHERE id = NEW.alipay_account_id
        ) <> 'sales_only'
            THEN RAISE(ABORT, '买卖混用阻断：销售店铺/账号只能绑定【销售收款专用支付宝】，严禁绑定采购号或主资金池！')
        WHEN NEW.account_role = 'purchase_only' AND NEW.alipay_account_id IS NOT NULL AND (
            SELECT trade_direction FROM alipay_accounts WHERE id = NEW.alipay_account_id
        ) <> 'purchase_only'
            THEN RAISE(ABORT, '买卖混用阻断：采购/买卡券账号只能绑定【采购专用支付宝（含因公支付子号）】，严禁动用销售收款账号！')
        WHEN NEW.business_entity_id IS NOT NULL AND NEW.alipay_account_id IS NOT NULL AND (
            SELECT business_entity_id FROM alipay_accounts WHERE id = NEW.alipay_account_id
        ) <> NEW.business_entity_id
            THEN RAISE(ABORT, '违反税法阻断：平台店铺所属营业执照主体与结算/付款支付宝所属营业执照不一致，严禁跨主体串户！')
    END;
END;

CREATE TRIGGER IF NOT EXISTS trg_platform_validate_update
BEFORE UPDATE ON platform_accounts
BEGIN
    SELECT CASE
        WHEN NEW.account_role = 'sales_only' AND NEW.alipay_account_id IS NOT NULL AND (
            SELECT trade_direction FROM alipay_accounts WHERE id = NEW.alipay_account_id
        ) <> 'sales_only'
            THEN RAISE(ABORT, '买卖混用阻断：销售店铺/账号只能绑定【销售收款专用支付宝】，严禁绑定采购号或主资金池！')
        WHEN NEW.account_role = 'purchase_only' AND NEW.alipay_account_id IS NOT NULL AND (
            SELECT trade_direction FROM alipay_accounts WHERE id = NEW.alipay_account_id
        ) <> 'purchase_only'
            THEN RAISE(ABORT, '买卖混用阻断：采购/买卡券账号只能绑定【采购专用支付宝（含因公支付子号）】，严禁动用销售收款账号！')
        WHEN NEW.business_entity_id IS NOT NULL AND NEW.alipay_account_id IS NOT NULL AND (
            SELECT business_entity_id FROM alipay_accounts WHERE id = NEW.alipay_account_id
        ) <> NEW.business_entity_id
            THEN RAISE(ABORT, '违反税法阻断：平台店铺所属营业执照主体与结算/付款支付宝所属营业执照不一致，严禁跨主体串户！')
    END;
END;
"""


from demo_seed import seed_database

SETTLEMENT_CHANNEL_LABELS = {
    "alipay_direct": "企业支付宝直连",
    "wechat_pay_mch": "微信支付商户号(mch)",
    "douyin_pay_mch": "抖音支付/合众商户",
    "xhs_merchant": "小红书千帆钱包",
    "jd_wallet_mch": "京东企业钱包",
    "corporate_pay_deduct": "因公支付直扣主户",
    "overseas_card_fx": "外币卡/跨境结算(预留)",
    "no_settlement": "纯引流零收付",
}

FLOW_DIRECTION_LABELS = {
    "inflow_sales": "销售结算入账",
    "outflow_corporate_pay": "因公支付采购代扣",
    "inflow_purchase_refund": "采购退券冲回主户",
    "outflow_sales_refund": "销售售后退款支出",
    "outflow_deposit": "缴纳店铺保证金",
    "inflow_deposit_return": "退回店铺保证金",
    "inflow_topup": "主资金池注资充值",
    "outflow_withdraw": "提现结转至银行卡",
}


PLATFORM_LABELS = {
    "xianyu": "闲鱼",
    "taobao_buyer": "淘宝(采购号)",
    "taobao_store": "淘宝网店",
    "wechat": "微信",
    "wechat_shop": "微信小店",
    "xiaohongshu_mkt": "小红书(社媒营销)",
    "xiaohongshu_shop": "小红书小店",
    "dianping": "大众点评(买卡券)",
    "douyin": "抖音(买卡券)",
    "doushengsheng": "抖省省(买卡券)",
    "doudian": "抖店",
    "jd_buyer": "京东(采购号)",
    "jd_store": "京东网店",
}


def sync_phone_bindings(conn: sqlite3.Connection) -> None:
    """根据各主表中的 bound_sim_id / liaison_sim_id 自动同步生成 phone_bindings 全量穿透索引（保留手工额外登记的 enterprise_email 绑定）"""
    cur = conn.cursor()
    cur.execute("DELETE FROM phone_bindings WHERE target_type IN ('alipay', 'tax', 'annual_report', 'platform_account')")

    # 税务登记绑定
    for r in cur.execute("""
        SELECT t.id, t.bound_sim_id, t.tax_bureau_name, e.entity_name
        FROM tax_registrations t JOIN business_entities e ON e.id = t.business_entity_id
        WHERE t.bound_sim_id IS NOT NULL
    """).fetchall():
        cur.execute(
            """INSERT OR IGNORE INTO phone_bindings
               (id, sim_card_id, target_type, target_id, target_name_snapshot, platform_or_org, binding_role, rebind_priority, notes)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (f"pb-tax-{r[0]}", r[1], "tax", r[0], f"{r[3]}", r[2], "实名办税/登录收码手机", "critical", "换卡前必须先在电子税务局变更办税手机"),
        )

    # 工商年报联络员绑定
    for r in cur.execute("""
        SELECT a.id, a.liaison_sim_id, a.aic_bureau_name, e.entity_name, a.report_year
        FROM annual_reports a JOIN business_entities e ON e.id = a.business_entity_id
        WHERE a.liaison_sim_id IS NOT NULL
    """).fetchall():
        cur.execute(
            """INSERT OR IGNORE INTO phone_bindings
               (id, sim_card_id, target_type, target_id, target_name_snapshot, platform_or_org, binding_role, rebind_priority, notes)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (f"pb-ar-{r[0]}", r[1], "annual_report", r[0], f"{r[3]} ({r[4]}年报)", r[2], "工商联络员备案手机", "high", "用于国家企业信用信息公示系统短信登录"),
        )

    # 企业支付宝绑定
    for r in cur.execute("""
        SELECT id, bound_sim_id, account_name, login_email, trade_direction
        FROM alipay_accounts WHERE bound_sim_id IS NOT NULL
    """).fetchall():
        role_txt = "主资金池安全手机" if r[4] == "master_fund" else ("因公采购子号安全手机" if r[4] == "purchase_only" else "销售收款支付宝安全手机")
        cur.execute(
            """INSERT OR IGNORE INTO phone_bindings
               (id, sim_card_id, target_type, target_id, target_name_snapshot, platform_or_org, binding_role, rebind_priority, notes)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (f"pb-ali-{r[0]}", r[1], "alipay", r[0], f"{r[2]} ({r[3]})", "企业支付宝", role_txt, "critical", "涉及资金盾/提现/因公支付签约验证"),
        )

    # 多平台账号绑定
    for r in cur.execute("""
        SELECT id, bound_sim_id, display_name, platform, account_role
        FROM platform_accounts WHERE bound_sim_id IS NOT NULL AND account_status <> 'retired'
    """).fetchall():
        plat_cn = PLATFORM_LABELS.get(r[3], r[3])
        role_cn = "店铺主管理员/注册号" if r[4] == "sales_only" else ("买卡券登录/核销收码号" if r[4] == "purchase_only" else "社媒登录/安全验证号")
        cur.execute(
            """INSERT OR IGNORE INTO phone_bindings
               (id, sim_card_id, target_type, target_id, target_name_snapshot, platform_or_org, binding_role, rebind_priority, notes)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (f"pb-pa-{r[0]}", r[1], "platform_account", r[0], r[2], plat_cn, role_cn, "high", "外部合约卡到期前需逐平台换绑"),
        )

    # 企业邮箱主密保绑定示例
    cur.execute(
        """INSERT OR IGNORE INTO phone_bindings
           (id, sim_card_id, target_type, target_id, target_name_snapshot, platform_or_org, binding_role, rebind_priority, notes)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        ("pb-mail-root", "sim-01", "enterprise_email", "mail-demo-admin", "阿里企业邮箱总控域 @example.invalid (含14子邮)", "阿里云企业邮箱", "超级管理员密保手机", "critical", "统管全部企业支付宝登录子邮箱，去139/189运营商邮箱化"),
    )


def init_db(db_path: Path = DEFAULT_DB_PATH, force_reset: bool = False) -> sqlite3.Connection:
    from device_adspower_health_seed import ensure_cluster_and_health_seeded
    from tutorial_and_gap_seed import ensure_tutorials_and_gaps_seeded
    from vault_security import ensure_vault_tables_and_seed
    from workbench_governance_seed import ensure_governance_seeded

    if force_reset and db_path.exists():
        db_path.unlink()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    first_create = not db_path.exists()
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA_SQL)
    cur = conn.cursor()
    count = cur.execute("SELECT COUNT(*) FROM legal_persons").fetchone()[0]
    if first_create or count == 0:
        seed_database(conn)
    ensure_tutorials_and_gaps_seeded(conn)
    ensure_cluster_and_health_seeded(conn)
    ensure_governance_seeded(conn)
    sync_phone_bindings(conn)
    conn.commit()
    ensure_vault_tables_and_seed(conn)
    return conn


if __name__ == "__main__":
    db_path = Path(os.environ.get("LEDGER_DB_PATH", str(DEFAULT_DB_PATH)))
    c = init_db(db_path)
    print(f"Database initialized at {db_path}")
    for tbl in [
        "legal_persons", "business_entities", "tax_registrations", "annual_reports",
        "alipay_accounts", "alipay_bills", "carrier_quotas", "sim_cards", "sim_fee_records",
        "proxy_ips", "physical_devices", "adspower_profiles", "platform_accounts", "phone_bindings"
    ]:
        n = c.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
        print(f"  {tbl:20s}: {n} rows")
    c.close()

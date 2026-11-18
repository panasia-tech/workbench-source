#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
泛亚锚点 · 老板全量台账（桌面专属版）SQLite 数据库初始化与全闭环基准数据生成
严格落实业务规则：
1. 1法人 -> 4营业执照主体 -> 4税务局独立登记 + 4工商管理局独立年报
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
DEFAULT_DB_PATH = BASE_DIR / "master_ledger.sqlite"


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
    holder_relation TEXT NOT NULL DEFAULT '法人本人',
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
    holder_role TEXT NOT NULL DEFAULT '法人本人',
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
    provider TEXT NOT NULL DEFAULT '蛟龙家宽代理',
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
    tax_invoice_mode TEXT NOT NULL DEFAULT '个体普票季度30万免税池',
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


def seed_database(conn: sqlite3.Connection) -> None:
    cur = conn.cursor()

    # 1. 法人主体（主法人：林建国 完整14企支/4主体/14店+全虚拟矩阵；次法人：王雅琴 扩展对照）
    legal_persons = [
        (
            "lp-ljg", "林建国", "000000324952663904", "00008441371", "浙江杭州·拱墅区",
            "10分钟内响应人脸/税务扫码", "AGR-ANCHOR-2026-001", "2028-09-15", "active",
            "主力全量法人：名下4个营业执照主体、4税务登记、4工商年报、14个企业支付宝、14家闲鱼店及全套虚拟卡券/社媒/小店矩阵"
        ),
        (
            "lp-wyq", "王雅琴", "000000901575209398", "00050661013", "浙江宁波·鄞州区",
            "30分钟内响应刷脸", "AGR-ANCHOR-2026-002", "2027-12-31", "active",
            "二号储备扩盘法人（用于多法人切换对照演示）"
        ),
    ]
    cur.executemany(
        """INSERT INTO legal_persons
           (id, name, id_card_no, primary_phone, residence_city, face_verify_sla, agency_contract_no, contract_expires_at, status, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        legal_persons,
    )

    # 2. 营业执照主体：林建国名下 4 个营业执照主体（每主体约 3~4 店铺，共 14 闲鱼店 + 新开各平台小店）+ 王雅琴 1 个主体
    entities = [
        (
            "ent-ljg-01", "lp-ljg", "ENT-LJG-01", "杭州市拱墅区青川数智商贸商行（个体工商户）",
            "92330105MA2K8R101X", "individual_business", "杭州市拱墅区市场监督管理局",
            "2026-05-12", "浙江省杭州市拱墅区莫干山路789号301-1室",
            "互联网销售；软件销售；日用百货销售；单用途商业预付卡代理销售；电子产品销售",
            "active", 4, "林建国1号执照：下挂4家闲鱼店+微信小店+小红书小店；内设3主干+1采购子号共4个企业支付宝"
        ),
        (
            "ent-ljg-02", "lp-ljg", "ENT-LJG-02", "杭州市西湖区云栖严选电子商务工作室",
            "92330106MA2K9B202L", "individual_business", "杭州市西湖区市场监督管理局",
            "2026-05-18", "浙江省杭州市西湖区文三路478号502-8室",
            "互联网销售；信息技术咨询服务；数字文化创意内容应用服务；二手日用百货销售",
            "active", 4, "林建国2号执照：下挂4家闲鱼店+淘宝网店+抖店；内设3主干+1采购子号共4个企业支付宝"
        ),
        (
            "ent-ljg-03", "lp-ljg", "ENT-LJG-03", "杭州星澜数字权益科技有限公司",
            "91330108MA2L0C3036", "company", "杭州市高新区（滨江）市场监督管理局",
            "2026-06-03", "浙江省杭州市滨江区长河街道网商路599号2幢411室",
            "技术服务、开发；虚拟数字权益分发；计算机软硬件零售；互联网销售",
            "active", 3, "林建国3号执照（有限公司主体）：下挂3家闲鱼店+京东网店+微信小店；标准3个企业支付宝（3选1主户）"
        ),
        (
            "ent-ljg-04", "lp-ljg", "ENT-LJG-04", "杭州市余杭区溪谷优选百货经营部",
            "92330110MA2L1D404W", "individual_business", "杭州市余杭区市场监督管理局",
            "2026-06-15", "浙江省杭州市余杭区五常街道文一西路998号605室",
            "互联网销售；办公用品销售；电子专用设备销售；商务代理代办服务",
            "active", 3, "林建国4号执照：下挂3家闲鱼店+小红书小店；标准3个企业支付宝（3选1主户）"
        ),
        (
            "ent-wyq-01", "lp-wyq", "ENT-WYQ-01", "宁波市鄞州区山屿优选数码商行",
            "92330212MA2M5E5019", "individual_business", "宁波市鄞州区市场监督管理局",
            "2026-07-20", "浙江省宁波市鄞州区首南街道天童南路666号",
            "互联网销售；通讯设备销售；电子产品销售",
            "active", 3, "王雅琴1号执照：扩展对照主体，标准3个企业支付宝（1主+1采+1销）"
        ),
    ]
    cur.executemany(
        """INSERT INTO business_entities
           (id, legal_person_id, entity_code, entity_name, uscc, entity_type, registration_authority,
            established_date, registered_address, business_scope, license_status, target_store_slots, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        entities,
    )

    # 3. 运营商「一主4副」动态配额表（展现原有存量卡占用额度，如移动已有1张只能开4张、联通已有1张只能开4张、电信已有2张只能开3张）
    carrier_quotas = [
        ("cq-ljg-cm", "lp-ljg", "林建国", "000000324952663904", "法人本人", "中国移动", 5, 1, "2026-09-02", "本人原自用移动卡1张，本公司仅能新开4张（1主3副）"),
        ("cq-ljg-cu", "lp-ljg", "林建国", "000000324952663904", "法人本人", "中国联通", 5, 1, "2026-09-02", "本人原自用联通卡1张，本公司仅能新开4张（1主3副）"),
        ("cq-ljg-ct", "lp-ljg", "林建国", "000000324952663904", "法人本人", "中国电信", 5, 2, "2026-09-02", "本人原家庭宽带绑电信卡2张，仅能新开3张（1主2副）；且一证通查总卡数逼近行业软上限，其余缺口由外部合约卡补齐"),
        ("cq-wyq-cu", "lp-wyq", "王雅琴", "000000901575209398", "二号法人", "中国联通", 5, 1, "2026-09-10", "原有1张联通卡，剩余可开4张"),
    ]
    cur.executemany(
        """INSERT INTO carrier_quotas
           (id, legal_person_id, holder_name, holder_id_card, holder_role, carrier, statutory_limit, existing_personal_cards, yztc_verified_date, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        carrier_quotas,
    )

    # 4. 手机卡池 & 话费台账（林建国名下可开 4+4+3=11 张自社卡 + 5 张外部合约卡补齐 16+ 卡槽，外加王雅琴 2 张 = 18 张）
    # 包含：主副卡共享话费、独立话费、低余额预警、外部合约卡即将到期换绑预警！
    sims = [
        # 林建国 - 中国移动（原有1张已占坑，公司开满4张：1主+3副）
        ("sim-01", "lp-ljg", "00008441371", "中国移动", "浙江杭州", "898600D219261000001", "company_master", None, "林建国", "法人本人", "周安", "independent", "移动5G畅享主卡套餐(含3副卡共享池)", 5900, 1, 18650, 5000, "2026-11-01", 20000, "2027-01-01", 0, "", "", "", 30, "active", "移动主卡：统付 sim-02~04 三张副卡月租；绑税局1/2与企支主户1"),
        ("sim-02", "lp-ljg", "00046862676", "中国移动", "浙江杭州", "898600D219261000002", "company_sub", "sim-01", "林建国", "法人本人", "陈晓雯", "shared_master", "移动副卡1(随主卡00008441371扣10元/月)", 1000, 1, 0, 0, "2026-11-01", 0, "2027-01-01", 0, "", "", "", 30, "active", "随sim-01主卡统付话费；插工作机DEV-PH-02"),
        ("sim-03", "lp-ljg", "00037539694", "中国移动", "浙江杭州", "898600D219261000003", "company_sub", "sim-01", "林建国", "法人本人", "陈晓雯", "shared_master", "移动副卡2(随主卡扣10元/月)", 1000, 1, 0, 0, "2026-11-01", 0, "2027-01-01", 0, "", "", "", 30, "active", "随sim-01主卡统付话费；插工作机DEV-PH-03"),
        ("sim-04", "lp-ljg", "00080331023", "中国移动", "浙江杭州", "898600D219261000004", "company_sub", "sim-01", "林建国", "法人本人", "李航", "shared_master", "移动副卡3(随主卡扣10元/月)", 1000, 1, 0, 0, "2026-11-01", 0, "2027-01-01", 0, "", "", "", 30, "active", "随sim-01主卡统付话费；用于采购与买券账号绑定"),

        # 林建国 - 中国联通（原有1张已占坑，公司开满4张：1主+3副，注意主卡余额偏低预警！）
        ("sim-05", "lp-ljg", "00070480702", "中国联通", "浙江杭州", "8986012680100000105", "company_master", None, "林建国", "法人本人", "周安", "independent", "联通冰激凌主卡(带3副卡)", 3900, 5, 2150, 5000, "2026-10-05", 10000, "2026-11-18", 0, "", "", "", 30, "low_balance", "【话费预警】主卡+3副卡合计月扣69元，当前仅剩21.50元，下期扣费前需充值！"),
        ("sim-06", "lp-ljg", "00001717911", "中国联通", "浙江杭州", "8986012680100000106", "company_sub", "sim-05", "林建国", "法人本人", "赵宇", "shared_master", "联通副卡1(随主卡00070480702扣10元/月)", 1000, 5, 0, 0, "2026-10-05", 0, "2026-11-18", 0, "", "", "", 30, "active", "随联通主卡扣费"),
        ("sim-07", "lp-ljg", "00011385824", "中国联通", "浙江杭州", "8986012680100000107", "company_sub", "sim-05", "林建国", "法人本人", "赵宇", "shared_master", "联通副卡2(随主卡扣10元/月)", 1000, 5, 0, 0, "2026-10-05", 0, "2026-11-18", 0, "", "", "", 30, "active", "随联通主卡扣费"),
        ("sim-08", "lp-ljg", "00004890061", "中国联通", "浙江杭州", "8986012680100000108", "company_sub", "sim-05", "林建国", "法人本人", "李航", "shared_master", "联通副卡3(随主卡扣10元/月)", 1000, 5, 0, 0, "2026-10-05", 0, "2026-11-18", 0, "", "", "", 30, "active", "采购专用联通副卡"),

        # 林建国 - 中国电信（原有2张已占坑，公司仅能开3张：1主+2副）
        ("sim-09", "lp-ljg", "00080978866", "中国电信", "浙江杭州", "8986032690100000209", "company_master", None, "林建国", "法人本人", "周安", "independent", "电信十全十美主卡(带2副卡)", 4900, 1, 14200, 5000, "2026-11-01", 15000, "2027-01-01", 0, "", "", "", 30, "active", "绑3号/4号税局与企支主户3/4"),
        ("sim-10", "lp-ljg", "00062876883", "中国电信", "浙江杭州", "8986032690100000210", "company_sub", "sim-09", "林建国", "法人本人", "林婷", "shared_master", "电信副卡1(随主卡扣10元/月)", 1000, 1, 0, 0, "2026-11-01", 0, "2027-01-01", 0, "", "", "", 30, "active", "插DEV-PH-10"),
        ("sim-11", "lp-ljg", "00068661481", "中国电信", "浙江杭州", "8986032690100000211", "company_sub", "sim-09", "林建国", "法人本人", "林婷", "shared_master", "电信副卡2(随主卡扣10元/月)", 1000, 1, 0, 0, "2026-11-01", 0, "2027-01-01", 0, "", "", "", 30, "active", "插DEV-PH-11"),

        # 外部补缺合约卡（5张：补齐林建国运营商卡槽缺口，带有明确合约期、换绑预警和独立话费台账！）
        ("sim-12", "lp-ljg", "00030228595", "中国移动", "浙江嘉兴", "898600E226000000312", "external_contract", None, "沈志强(外部配合人A)", "外部签协议供卡", "陈晓雯", "independent", "移动8元保号自由选套餐", 800, 10, 1200, 2000, "2026-09-10", 5000, "2026-11-20", 1, "沈志强·半年期供卡协议", "2026-06-01", "2026-11-30", 30, "contract_expiring", "【紧急：16天后合约到期+余额仅12元】需在11月30日前把绑定的闲鱼12店、小红书号、点评号迁移至新卡！"),
        ("sim-13", "lp-ljg", "00068537127", "中国移动", "浙江绍兴", "898600E226000000313", "external_contract", None, "沈志强(外部配合人A)", "外部签协议供卡", "赵宇", "independent", "移动19元青春卡", 1900, 15, 6400, 2500, "2026-10-15", 10000, "2027-01-15", 1, "沈志强·半年期供卡协议", "2026-06-15", "2026-12-10", 30, "contract_expiring", "【26天后合约到期】已进入30天换绑预警期，请提前准备接替卡"),
        ("sim-14", "lp-ljg", "00018781211", "中国联通", "浙江湖州", "898601E226000000314", "external_contract", None, "韩梅(外部配合人B)", "外部签协议供卡", "林婷", "independent", "联通8元保号卡", 800, 1, 5600, 2000, "2026-10-01", 8000, "2027-03-01", 1, "韩梅·一年期代持供卡协议", "2026-08-01", "2027-07-31", 30, "active", "外部合约稳定期；绑闲鱼14店+小红书小店客服+抖音买券"),
        ("sim-15", "lp-ljg", "00083596707", "中国电信", "浙江杭州", "898603E226000000315", "external_contract", None, "韩梅(外部配合人B)", "外部签协议供卡", "李航", "independent", "电信5元无忧卡", 500, 1, 4500, 2000, "2026-10-01", 5000, "2027-04-01", 1, "韩梅·一年期代持供卡协议", "2026-08-01", "2027-07-31", 30, "active", "虚拟产品买卡券专用接码卡（大众点评/抖省省/抖音团购）"),
        ("sim-16", "lp-ljg", "00057395276", "中国移动", "浙江杭州", "898600E226000000316", "external_contract", None, "吴建平(外部配合人C)", "外部签协议供卡", "李航", "independent", "移动18元飞享卡", 1800, 20, 900, 2500, "2026-09-20", 5000, "2026-11-19", 1, "吴建平·一年期供卡协议", "2026-09-01", "2027-08-31", 30, "low_balance", "【话费告警】当前仅剩9.00元，不足本月20日扣除18元月租，停机将导致绑定的买券号失联！"),

        # 王雅琴（二号法人对照卡）
        ("sim-17", "lp-wyq", "00050661013", "中国联通", "浙江宁波", "8986012680200000401", "company_master", None, "王雅琴", "二号法人", "赵宇", "independent", "联通39元主卡", 3900, 1, 11200, 4000, "2026-11-01", 15000, "2027-01-01", 0, "", "", "", 30, "active", "二号法人主卡"),
        ("sim-18", "lp-wyq", "00081107181", "中国联通", "浙江宁波", "8986012680200000402", "company_sub", "sim-17", "王雅琴", "二号法人", "李航", "shared_master", "联通副卡(随主卡10元/月)", 1000, 1, 0, 0, "2026-11-01", 0, "2027-01-01", 0, "", "", "", 30, "active", "二号法人采购副卡"),
    ]
    cur.executemany(
        """INSERT INTO sim_cards
           (id, legal_person_id, phone_number, carrier, region_city, iccid, card_category, master_sim_id,
            real_name_holder, holder_relation, custodian_staff, billing_mode, plan_name, monthly_rent_fen,
            billing_day, balance_fen, low_balance_threshold_fen, last_recharge_date, last_recharge_fen,
            next_recharge_due, is_external, external_vendor, contract_start_date, contract_end_date,
            rebind_lead_days, sim_status, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        sims,
    )

    # 话费流水台账样本
    fee_records = [
        ("sfr-01", "sim-01", "2026-11-01", "recharge", 20000, 27550, "周安", "人工登记（待接OA/钉钉）", "待接入OA/钉钉审批", "移动主卡+3副卡季度预存话费"),
        ("sfr-02", "sim-01", "2026-11-01", "monthly_rent", -8900, 18650, "系统月结账单", "运营商账单核减", "-", "扣除11月主卡59元+3张副卡30元"),
        ("sfr-03", "sim-05", "2026-11-05", "monthly_rent", -6900, 2150, "系统月结账单", "运营商账单核减", "-", "扣除联通主卡39元+3张副卡30元，余额跌破预警线"),
        ("sfr-04", "sim-09", "2026-11-01", "recharge", 15000, 21100, "周安", "人工登记（待接OA/钉钉）", "待接入OA/钉钉审批", "电信主副卡充值"),
        ("sfr-05", "sim-09", "2026-11-01", "monthly_rent", -6900, 14200, "系统月结账单", "运营商账单核减", "-", "扣除电信主卡49元+2副卡20元"),
        ("sfr-06", "sim-12", "2026-11-10", "monthly_rent", -800, 1200, "系统月结账单", "运营商账单核减", "-", "外部卡保号月租扣款，合约月底到期"),
        ("sfr-07", "sim-16", "2026-10-20", "monthly_rent", -1800, 900, "系统月结账单", "运营商账单核减", "-", "余额仅9元，11月20日扣租前急需充值"),
    ]
    cur.executemany(
        """INSERT INTO sim_fee_records
           (id, sim_card_id, occurred_date, change_type, amount_fen, balance_after_fen, operator_name, payment_source, oa_approval_ref, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        fee_records,
    )

    # 5. 4个税务局登记信息（林建国4本营业执照 1:1 对应4个税务局独立登记 + 王雅琴1个）
    tax_regs = [
        ("tax-ljg-01", "ent-ljg-01", "国家税务总局杭州市拱墅区税务局", "小规模纳税人", "查账征收", "按季申报", "林建国 / 桐新代账", "sim-01", "2026-Q4", 24860000, 30000000, "warning", "2027-01-15", "TAX-GS-2026Q3-8821", "本季销售额24.86万，已达30万免税红线的82.9%，注意分流控制开票额！"),
        ("tax-ljg-02", "ent-ljg-02", "国家税务总局杭州市西湖区税务局", "小规模纳税人", "查账征收", "按季申报", "林建国 / 桐新代账", "sim-05", "2026-Q4", 16420000, 30000000, "filed", "2027-01-15", "TAX-XH-2026Q3-4410", "Q3已完税清卡，Q4累计16.42万，额度健康"),
        ("tax-ljg-03", "ent-ljg-03", "国家税务总局杭州市滨江区税务局", "小规模纳税人", "查账征收", "按季申报", "周安(办税员)", "sim-09", "2026-Q4", 19300000, 30000000, "filed", "2027-01-15", "TAX-BJ-2026Q3-5902", "有限公司主体，独立建账核算，严禁个体户资金串入"),
        ("tax-ljg-04", "ent-ljg-04", "国家税务总局杭州市余杭区税务局", "小规模纳税人", "查账征收", "按季申报", "周安(办税员)", "sim-09", "2026-Q4", 11850000, 30000000, "pending", "2027-01-15", "TAX-YH-2026Q3-3194", "余杭主体当季个税零申报待月度确认"),
        ("tax-wyq-01", "ent-wyq-01", "国家税务总局宁波市鄞州区税务局", "小规模纳税人", "查账征收", "按季申报", "王雅琴", "sim-17", "2026-Q4", 6200000, 30000000, "filed", "2027-01-15", "TAX-YZ-2026Q3-1028", "正常申报"),
    ]
    cur.executemany(
        """INSERT INTO tax_registrations
           (id, business_entity_id, tax_bureau_name, taxpayer_type, collection_mode, filing_cycle,
            tax_officer_name, bound_sim_id, current_period, quarter_sales_fen, quarter_exempt_limit_fen,
            filing_status, next_due_date, receipt_no, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        tax_regs,
    )

    # 6. 4个工商管理局年报信息（林建国4本营业执照各自独立年报记录 + 王雅琴1个）
    annual_reports = [
        ("ar-ljg-01", "ent-ljg-01", 2026, "杭州市拱墅区市场监督管理局", "2027-01-01 ~ 2027-06-30", "林建国", "sim-01", "publicized", "2026-06-18", "NB-330105-2025-99201", "开业当年及上年度公示核验正常，下期2027年1月开启填报"),
        ("ar-ljg-02", "ent-ljg-02", 2026, "杭州市西湖区市场监督管理局", "2027-01-01 ~ 2027-06-30", "林建国", "sim-05", "publicized", "2026-06-18", "NB-330106-2025-77412", "国家企业信用信息公示系统状态正常"),
        ("ar-ljg-03", "ent-ljg-03", 2026, "杭州市高新区（滨江）市场监督管理局", "2027-01-01 ~ 2027-06-30", "周安", "sim-09", "pending", "", "", "2026年6月新设有限公司，须在2027-01-01至06-30完成首次工商年报公示"),
        ("ar-ljg-04", "ent-ljg-04", 2026, "杭州市余杭区市场监督管理局", "2027-01-01 ~ 2027-06-30", "周安", "sim-09", "pending", "", "", "2026年6月新设个体户，须在2027上半年完成首次工商年报，谨防列异影响网店亮照"),
        ("ar-wyq-01", "ent-wyq-01", 2026, "宁波市鄞州区市场监督管理局", "2027-01-01 ~ 2027-06-30", "王雅琴", "sim-17", "pending", "", "", "2026新设待明年一季度首报"),
    ]
    cur.executemany(
        """INSERT INTO annual_reports
           (id, business_entity_id, report_year, aic_bureau_name, window_period, liaison_name,
            liaison_sim_id, report_status, submitted_date, publicity_receipt_no, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        annual_reports,
    )

    # 7. 企业支付宝台账（林建国 14 个企业支付宝 + 王雅琴 3 个对照）
    # 严格遵守：
    # - 每个营业执照主体内部从3大核心资金户里「3选1」设唯一个 master_fund（主资金账号）
    # - 采购专用子账号（purchase_only）开启「因公支付」且仅扣本营业执照主体下的 master_fund（绝不跨主体串户违反税法！）
    # - 销售专用账号（sales_only）仅收销售店铺货款，绝不参与采购扣款（严禁既买又卖！）
    alipays = [
        # === 主体 1（青川数智：4个企业支付宝 = 核心资金户3选1主户 + 2销售户 + 1因公采购子户）===
        ("ali-01", "lp-ljg", "ent-ljg-01", "ALI-E1-M1", "青川数智·企支主资金号(1号)", "23b2953d4d@example.invalid", "2088702611000101", "主体3大资金户①[主户]", "master_fund", 1, 0, None, 0, "sim-01", "招商银行杭州莫干山支行", "0030085739560379", 4680000, 8000000, 3320000, "已授权日账单", "active", "【主体1·3选1主资金池】专供本主体下采购子号(ALI-E1-P1)通过因公支付扣款，绝不跨主体代付，亦不直挂网店卖货"),
        ("ali-02", "lp-ljg", "ent-ljg-01", "ALI-E1-S1", "青川数智·企支销售1号", "caaefe982e@example.invalid", "2088702611000102", "主体3大资金户②[销售]", "sales_only", 0, 0, None, 0, "sim-02", "招商银行杭州莫干山支行", "0030085739560379", 1924000, 6840000, 4916000, "已授权日账单", "active", "纯销售收款户：承接闲鱼1/2店及青川微信小店回款，严禁任何采购付款"),
        ("ali-03", "lp-ljg", "ent-ljg-01", "ALI-E1-S2", "青川数智·企支销售2号", "f29707b332@example.invalid", "2088702611000103", "主体3大资金户③[销售]", "sales_only", 0, 0, None, 0, "sim-03", "招商银行杭州莫干山支行", "0030085739560379", 1450000, 5120000, 3670000, "已授权日账单", "active", "纯销售收款户：承接闲鱼3/4店及青川小红书小店回款"),
        ("ali-04", "lp-ljg", "ent-ljg-01", "ALI-E1-P1", "青川数智·企支采购子号(因公付)", "48881bf7c9@example.invalid", "2088702611000104", "主体扩展子号[因公采购]", "purchase_only", 0, 1, "ali-01", 2000000, "sim-04", "", "", 0, 0, 3320000, "已授权日账单", "active", "纯采购账号：已签约【因公支付】直扣同主体主号 ALI-E1-M1，用于大众点评/抖省省买卡券及主体1闲鱼采购"),

        # === 主体 2（云栖严选：4个企业支付宝 = 核心资金户3选1主户 + 2销售户 + 1因公采购子户）===
        ("ali-05", "lp-ljg", "ent-ljg-02", "ALI-E2-M1", "云栖严选·企支主资金号(1号)", "98cd9bbba7@example.invalid", "2088702611000201", "主体3大资金户①[主户]", "master_fund", 1, 0, None, 0, "sim-05", "工商银行杭州文三路支行", "0083583155309523", 3850000, 6000000, 2150000, "已授权日账单", "active", "【主体2·3选1主资金池】仅对主体2名下采购子号(ALI-E2-P1)开放因公支付扣款"),
        ("ali-06", "lp-ljg", "ent-ljg-02", "ALI-E2-S1", "云栖严选·企支销售1号", "f9a75884d3@example.invalid", "2088702611000202", "主体3大资金户②[销售]", "sales_only", 0, 0, None, 0, "sim-06", "工商银行杭州文三路支行", "0083583155309523", 2280000, 7230000, 4950000, "已授权日账单", "active", "纯销售收款户：承接闲鱼5/6店及云栖淘宝网店结算"),
        ("ali-07", "lp-ljg", "ent-ljg-02", "ALI-E2-S2", "云栖严选·企支销售2号", "1868b96d19@example.invalid", "2088702611000203", "主体3大资金户③[销售]", "sales_only", 0, 0, None, 0, "sim-07", "工商银行杭州文三路支行", "0083583155309523", 1630000, 4890000, 3260000, "已授权日账单", "active", "纯销售收款户：承接闲鱼7/8店及云栖抖店结算"),
        ("ali-08", "lp-ljg", "ent-ljg-02", "ALI-E2-P1", "云栖严选·企支采购子号(因公付)", "94e183c2f2@example.invalid", "2088702611000204", "主体扩展子号[因公采购]", "purchase_only", 0, 1, "ali-05", 1500000, "sim-08", "", "", 0, 0, 2150000, "已授权日账单", "active", "纯采购账号：签约【因公支付】直扣同主体主号 ALI-E2-M1，专供抖音团购/淘宝采购虚拟权益"),

        # === 主体 3（星澜数字有限公司：标准3个企业支付宝 = 1主户[3选1] + 1销售户 + 1因公采购子户）===
        ("ali-09", "lp-ljg", "ent-ljg-03", "ALI-E3-M1", "星澜数字·企支主资金号(对公)", "f2f2b1f93b@example.invalid", "2088702611000301", "主体3大资金户①[主户]", "master_fund", 1, 0, None, 0, "sim-09", "建设银行杭州滨江支行(对公户)", "33050161822700001852", 6420000, 9000000, 2580000, "已授权日账单", "active", "【主体3·3选1主资金池】有限公司对公备付主户，供同主体 ALI-E3-P1 因公支付扣款"),
        ("ali-10", "lp-ljg", "ent-ljg-03", "ALI-E3-S1", "星澜数字·企支销售号", "b9ffe5ba19@example.invalid", "2088702611000302", "主体3大资金户②[销售]", "sales_only", 0, 0, None, 0, "sim-10", "建设银行杭州滨江支行(对公户)", "33050161822700001852", 3190000, 8150000, 4960000, "已授权日账单", "active", "纯销售收款户：承接闲鱼9/10/11店、星澜京东店、星澜微信小店回款"),
        ("ali-11", "lp-ljg", "ent-ljg-03", "ALI-E3-P1", "星澜数字·企支采购子号(因公付)", "84d48570a1@example.invalid", "2088702611000303", "主体3大资金户③[因公采购]", "purchase_only", 0, 1, "ali-09", 3000000, "sim-15", "", "", 0, 0, 2580000, "已授权日账单", "active", "纯采购账号：签约【因公支付】扣同主体主号 ALI-E3-M1，专采AI数字会员/京东权益/点评卡券"),

        # === 主体 4（溪谷优选：标准3个企业支付宝 = 1主户[3选1] + 1销售户 + 1因公采购子户）===
        ("ali-12", "lp-ljg", "ent-ljg-04", "ALI-E4-M1", "溪谷优选·企支主资金号", "44051fb4f1@example.invalid", "2088702611000401", "主体3大资金户①[主户]", "master_fund", 1, 0, None, 0, "sim-09", "农业银行杭州未来科技城支行", "0067132169606551", 2740000, 4500000, 1760000, "手工导账单", "active", "【主体4·3选1主资金池】供同主体 ALI-E4-P1 因公支付扣款"),
        ("ali-13", "lp-ljg", "ent-ljg-04", "ALI-E4-S1", "溪谷优选·企支销售号", "9a2997a45d@example.invalid", "2088702611000402", "主体3大资金户②[销售]", "sales_only", 0, 0, None, 0, "sim-11", "农业银行杭州未来科技城支行", "0067132169606551", 1580000, 4290000, 2710000, "手工导账单", "active", "纯销售收款户：承接闲鱼12/13/14店及溪谷小红书小店结算"),
        ("ali-14", "lp-ljg", "ent-ljg-04", "ALI-E4-P1", "溪谷优选·企支采购子号(因公付)", "fa1de08837@example.invalid", "2088702611000403", "主体3大资金户③[因公采购]", "purchase_only", 0, 1, "ali-12", 1500000, "sim-16", "", "", 0, 0, 1760000, "手工导账单", "active", "纯采购账号：签约【因公支付】扣同主体主号 ALI-E4-M1，专用于抖省省/大众点评地方餐饮券采购"),

        # === 王雅琴主体（3个企业支付宝对照）===
        ("ali-15", "lp-wyq", "ent-wyq-01", "ALI-WYQ-M1", "山屿优选·企支主资金号", "84cbaba53a@example.invalid", "2088702611000501", "主体3大资金户①[主户]", "master_fund", 1, 0, None, 0, "sim-17", "宁波银行鄞州支行", "0070841965032354", 2100000, 3000000, 900000, "已授权日账单", "active", "王雅琴主体3选1主户"),
        ("ali-16", "lp-wyq", "ent-wyq-01", "ALI-WYQ-S1", "山屿优选·企支销售号", "e0f26059df@example.invalid", "2088702611000502", "主体3大资金户②[销售]", "sales_only", 0, 0, None, 0, "sim-17", "宁波银行鄞州支行", "0070841965032354", 1340000, 2980000, 1640000, "已授权日账单", "active", "王雅琴纯销售收款户"),
        ("ali-17", "lp-wyq", "ent-wyq-01", "ALI-WYQ-P1", "山屿优选·企支采购子号(因公付)", "aa38fe33cb@example.invalid", "2088702611000503", "主体3大资金户③[因公采购]", "purchase_only", 0, 1, "ali-15", 1000000, "sim-18", "", "", 0, 0, 900000, "已授权日账单", "active", "王雅琴同主体因公支付采购号"),
    ]
    cur.executemany(
        """INSERT INTO alipay_accounts
           (id, legal_person_id, business_entity_id, account_code, account_name, login_email, alipay_uid,
            entity_fund_slot, trade_direction, is_entity_master_fund, corporate_pay_enabled, master_alipay_id,
            daily_limit_fen, bound_sim_id, settlement_bank, settlement_card_no, balance_fen,
            month_inflow_fen, month_outflow_fen, bill_sync_status, account_status, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        alipays,
    )

    # 8. 家宽代理 IP 台账（¥10/月 SOCKS5 住宅家宽代理，共 16 条：覆盖 14 家闲鱼店单平台独占 + 多平台跨线安全复用 + 临期/过期预警演示！）
    proxies = [
        ("px-01", "IP-HZ-01", "蛟龙家宽代理", "套餐⑤独享家宽-25M", "浙江杭州·电信家宽", "SOCKS5", "hz01.jl-resi.net", 21001, "anch_hz01", "Jk9#mP2x01", "115.236.48.101", 1000, "2026-10-18", "2026-11-17", "expiring", "待接入OA/钉钉续费", "【3天后到期！】当前跨平台复用于：闲鱼1店 + 微信小店1 + 小红书小店1 + 大众点评买券1"),
        ("px-02", "IP-HZ-02", "蛟龙家宽代理", "套餐⑤独享家宽-25M", "浙江杭州·电信家宽", "SOCKS5", "hz02.jl-resi.net", 21002, "anch_hz02", "Jk9#mP2x02", "115.236.48.118", 1000, "2026-10-20", "2026-11-19", "expiring", "待接入OA/钉钉续费", "【5天后到期！】复用于：闲鱼2店 + 小红书社媒营销1号 + 抖省省买券1号"),
        ("px-03", "IP-HZ-03", "蛟龙家宽代理", "套餐⑤独享家宽-25M", "浙江杭州·联通家宽", "SOCKS5", "hz03.jl-resi.net", 21003, "anch_hz03", "Jk9#mP2x03", "124.160.72.43", 1000, "2026-11-01", "2026-12-01", "online", "待接入OA/钉钉续费", "复用于：闲鱼3店 + 微信号1 + 淘宝买券采购1号"),
        ("px-04", "IP-HZ-04", "蛟龙家宽代理", "套餐⑤独享家宽-25M", "浙江杭州·联通家宽", "SOCKS5", "hz04.jl-resi.net", 21004, "anch_hz04", "Jk9#mP2x04", "124.160.72.89", 1000, "2026-11-01", "2026-12-01", "online", "待接入OA/钉钉续费", "复用于：闲鱼4店 + 抖音买券1号"),
        ("px-05", "IP-JX-05", "蛟龙家宽代理", "套餐⑤独享家宽-25M", "浙江嘉兴·电信家宽", "SOCKS5", "jx05.jl-resi.net", 21005, "anch_jx05", "Jk9#mP2x05", "183.159.22.15", 1000, "2026-11-02", "2026-12-02", "online", "待接入OA/钉钉续费", "复用于：闲鱼5店 + 云栖淘宝网店 + 大众点评买券2号"),
        ("px-06", "IP-JX-06", "蛟龙家宽代理", "套餐⑤独享家宽-25M", "浙江嘉兴·电信家宽", "SOCKS5", "jx06.jl-resi.net", 21006, "anch_jx06", "Jk9#mP2x06", "183.159.22.67", 1000, "2026-11-02", "2026-12-02", "online", "待接入OA/钉钉续费", "复用于：闲鱼6店 + 云栖抖店 + 小红书社媒营销2号"),
        ("px-07", "IP-JX-07", "蛟龙家宽代理", "套餐⑤独享家宽-25M", "浙江嘉兴·移动家宽", "SOCKS5", "jx07.jl-resi.net", 21007, "anch_jx07", "Jk9#mP2x07", "112.17.104.31", 1000, "2026-11-05", "2026-12-05", "online", "待接入OA/钉钉续费", "复用于：闲鱼7店 + 抖省省买券2号"),
        ("px-08", "IP-JX-08", "蛟龙家宽代理", "套餐⑤独享家宽-25M", "浙江嘉兴·移动家宽", "SOCKS5", "jx08.jl-resi.net", 21008, "anch_jx08", "Jk9#mP2x08", "112.17.104.92", 1000, "2026-11-05", "2026-12-05", "online", "待接入OA/钉钉续费", "闲鱼8店独占中（可继续挂载非闲鱼平台）"),
        ("px-09", "IP-HZ-09", "蛟龙家宽代理", "套餐⑤独享家宽-25M", "浙江杭州·电信家宽", "SOCKS5", "hz09.jl-resi.net", 21009, "anch_hz09", "Jk9#mP2x09", "115.236.51.14", 1000, "2026-11-06", "2026-12-06", "online", "待接入OA/钉钉续费", "复用于：闲鱼9店 + 星澜京东网店 + 星澜微信小店 + 京东采购1号(买号与店铺已分环境)"),
        ("px-10", "IP-HZ-10", "蛟龙家宽代理", "套餐⑤独享家宽-25M", "浙江杭州·电信家宽", "SOCKS5", "hz10.jl-resi.net", 21010, "anch_hz10", "Jk9#mP2x10", "115.236.51.78", 1000, "2026-11-06", "2026-12-06", "online", "待接入OA/钉钉续费", "复用于：闲鱼10店 + 微信号2 + 抖音买券2号"),
        ("px-11", "IP-HZ-11", "蛟龙家宽代理", "套餐⑤独享家宽-25M", "浙江杭州·联通家宽", "SOCKS5", "hz11.jl-resi.net", 21011, "anch_hz11", "Jk9#mP2x11", "124.160.75.19", 1000, "2026-11-08", "2026-12-08", "online", "待接入OA/钉钉续费", "闲鱼11店"),
        ("px-12", "IP-SX-12", "蛟龙家宽代理", "套餐⑤独享家宽-25M", "浙江绍兴·电信家宽", "SOCKS5", "sx12.jl-resi.net", 21012, "anch_sx12", "Jk9#mP2x12", "60.190.118.44", 1000, "2026-10-13", "2026-11-13", "expired", "待接入OA/钉钉续费", "【高危：昨日已过期！】严禁删除该代理记录（防AdsPower回退本机直连），请立即续费恢复！"),
        ("px-13", "IP-SX-13", "蛟龙家宽代理", "套餐⑤独享家宽-25M", "浙江绍兴·电信家宽", "SOCKS5", "sx13.jl-resi.net", 21013, "anch_sx13", "Jk9#mP2x13", "60.190.118.85", 1000, "2026-11-10", "2026-12-10", "online", "待接入OA/钉钉续费", "复用于：闲鱼13店 + 溪谷小红书小店"),
        ("px-14", "IP-HU-14", "蛟龙家宽代理", "套餐⑤独享家宽-25M", "浙江湖州·联通家宽", "SOCKS5", "hu14.jl-resi.net", 21014, "anch_hu14", "Jk9#mP2x14", "101.68.92.53", 1000, "2026-11-10", "2026-12-10", "online", "待接入OA/钉钉续费", "闲鱼14店 + 大众点评买券3号"),
        ("px-15", "IP-NB-15", "蛟龙家宽代理", "套餐⑤独享家宽-25M", "浙江宁波·电信家宽", "SOCKS5", "nb15.jl-resi.net", 21015, "anch_nb15", "Jk9#mP2x15", "183.134.60.27", 1000, "2026-11-10", "2026-12-10", "online", "待接入OA/钉钉续费", "二号法人山屿闲鱼1店"),
        ("px-16", "IP-HZ-16", "星速静态家宽", "浙江独享住宅SOCKS5", "浙江杭州·移动家宽", "SOCKS5", "hz16.xingsu-ip.cn", 30016, "anch_hz16", "Xs8@kL1q16", "39.170.41.109", 1000, "2026-11-12", "2026-12-12", "online", "待接入OA/钉钉续费", "备用干净家宽IP（用于闲鱼采购号与备用店铺热切换）"),
    ]
    cur.executemany(
        """INSERT INTO proxy_ips
           (id, proxy_code, provider, plan_name, isp_region, protocol, host, port, proxy_user, proxy_pass,
            exit_ip, monthly_cost_fen, purchased_at, expires_at, connectivity_status, oa_renewal_ref, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        proxies,
    )

    # 9. 实体设备池（林建国 14 部手机终端 + 2 台 AdsPower 电脑集群宿主机 + 王雅琴 1 部手机 = 17 台）
    devices = [
        ("dev-pc-01", "lp-ljg", "DEV-PC-01", "adspower_pc_host", "Mac Studio M2 Max (64G/1T)", "C02ZN8K9MD6R", "", "", "host_cluster", None, None, "A区中控机柜-01", "陈晓雯", "AdsPower Enterprise, 群控桌面端", "active", "销售组主力AdsPower宿主机（承载窗口ADS-01~14及各平台小店窗口）"),
        ("dev-pc-02", "lp-ljg", "DEV-PC-02", "adspower_pc_host", "联想 ThinkStation P3 (i9/64G)", "PF4L9X2W881A", "", "", "host_cluster", None, None, "B区采购工位-01", "李航", "AdsPower Enterprise, 采购比价插件", "active", "采购/买卡券与社媒独立AdsPower宿主机（与销售端物理分机操作）"),

        # 14 部实体手机（对应您记忆中的14设备，同时明确区分销售机 vs 采购买卡券专用机，并插好对应手机卡）
        ("dev-ph-01", "lp-ljg", "DEV-PH-01", "work_phone", "Redmi Note 13 Pro", "DX3K9W2M001", "866017061001421", "866017061001439", "sales_only", "sim-01", None, "销售一组-工位01", "陈晓雯", "闲鱼, 微信, 企业支付宝, 电子税务局", "active", "1号主力法人手机（插移动主卡sim-01，兼顾税局扫码与1店客服）"),
        ("dev-ph-02", "lp-ljg", "DEV-PH-02", "work_phone", "Redmi Note 13 Pro", "DX3K9W2M002", "866017061002421", "866017061002439", "sales_only", "sim-02", None, "销售一组-工位02", "陈晓雯", "闲鱼, 微信小店助手, 小红书千帆", "active", "主体1销售2机"),
        ("dev-ph-03", "lp-ljg", "DEV-PH-03", "work_phone", "Redmi Note 13 Pro", "DX3K9W2M003", "866017061003421", "866017061003439", "sales_only", "sim-03", None, "销售一组-工位03", "陈晓雯", "闲鱼, 小红书(社媒营销1号)", "active", "主体1销售3机+小红书种草发帖"),
        ("dev-ph-04", "lp-ljg", "DEV-PH-04", "work_phone", "Redmi Note 12 Turbo", "DX3K9W2M004", "866017061004421", "866017061004439", "sales_only", None, None, "销售一组-工位04", "陈晓雯", "闲鱼(WiFi直连对应家宽代理热点)", "active", "闲鱼4店终端"),
        ("dev-ph-05", "lp-ljg", "DEV-PH-05", "work_phone", "iQOO Z8x", "R8MD31L2005", "860912052005216", "860912052005224", "sales_only", "sim-05", None, "销售二组-工位01", "赵宇", "闲鱼, 千牛(淘宝网店), 电子税务局", "active", "主体2主卡工作机"),
        ("dev-ph-06", "lp-ljg", "DEV-PH-06", "work_phone", "iQOO Z8x", "R8MD31L2006", "860912052006216", "860912052006224", "sales_only", "sim-06", None, "销售二组-工位02", "赵宇", "闲鱼, 抖店百应, 小红书(社媒营销2号)", "active", "主体2销售2机"),
        ("dev-ph-07", "lp-ljg", "DEV-PH-07", "work_phone", "iQOO Z8x", "R8MD31L2007", "860912052007216", "860912052007224", "sales_only", "sim-07", None, "销售二组-工位03", "赵宇", "闲鱼", "active", "主体2销售3机"),
        ("dev-ph-08", "lp-ljg", "DEV-PH-08", "work_phone", "OPPO K11x", "OP9912A8008", "864211073008110", "864211073008128", "sales_only", "sim-13", None, "销售二组-工位04", "赵宇", "闲鱼", "active", "插外部合约卡sim-13（12月10日到期需换卡）"),
        ("dev-ph-09", "lp-ljg", "DEV-PH-09", "work_phone", "荣耀 X50", "HN7721C9009", "865501084009311", "865501084009329", "sales_only", "sim-09", None, "销售三组-工位01", "林婷", "闲鱼, 京麦(京东网店), 微信小店助手", "active", "主体3有限公司主卡工作机"),
        ("dev-ph-10", "lp-ljg", "DEV-PH-10", "work_phone", "荣耀 X50", "HN7721C9010", "865501084010311", "865501084010329", "sales_only", "sim-10", None, "销售三组-工位02", "林婷", "闲鱼, 微信(私域2号)", "active", "主体3销售2机"),
        ("dev-ph-11", "lp-ljg", "DEV-PH-11", "work_phone", "荣耀 X50", "HN7721C9011", "865501084011311", "865501084011329", "sales_only", "sim-11", None, "销售三组-工位03", "林婷", "闲鱼, 小红书千帆", "active", "主体4销售机"),
        ("dev-ph-12", "lp-ljg", "DEV-PH-12", "work_phone", "真我 Realme 11", "RM6630D1012", "867109095012501", "867109095012519", "sales_only", "sim-12", "sim-14", "销售三组-工位04", "林婷", "闲鱼", "active", "双卡工作机：卡槽1插sim-12(11/30合约到期)，卡槽2插sim-14"),
        # 2 部专门划给虚拟产品买卡券/采购组的采购专用手机（严格遵循《采购手机管理规范》物理隔离！）
        ("dev-ph-13", "lp-ljg", "DEV-PH-13", "procurement_phone", "iPhone 13 (128G 采购1机)", "F17H92K1Q8P1", "356918120013801", "356918120013819", "purchase_only", "sim-04", "sim-08", "采购卡券组-工位01", "李航", "大众点评, 抖音, 抖省省, 淘宝买家, 企业支付宝(因公付)", "active", "【采购买券1号专机】双卡插sim-04与sim-08，严禁登录任何销售卖货店铺！"),
        ("dev-ph-14", "lp-ljg", "DEV-PH-14", "procurement_phone", "小米 13 (采购2机)", "XM8831P2K902", "869102030014901", "869102030014919", "purchase_only", "sim-15", "sim-16", "采购卡券组-工位02", "李航", "大众点评, 抖音, 抖省省, 京东买家, 闲鱼采购号, 企业支付宝(因公付)", "active", "【采购买券2号专机】双卡插外部卡sim-15与sim-16，专买地方餐饮券与特惠卡券"),

        # 二号法人手机
        ("dev-ph-15", "lp-wyq", "DEV-PH-15", "work_phone", "Redmi Note 13", "DX9M2W1K015", "866099010015101", "", "sales_only", "sim-17", "sim-18", "宁波协同组-01", "赵宇", "闲鱼", "active", "王雅琴账号测试机"),
    ]
    cur.executemany(
        """INSERT INTO physical_devices
           (id, legal_person_id, device_code, device_kind, brand_model, serial_number, imei_1, imei_2,
            role_isolation, sim_slot_1_id, sim_slot_2_id, workstation_loc, custodian_staff, installed_apps, device_status, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        devices,
    )

    # 10. AdsPower 浏览器窗口台账（关联宿主机 + 绑定家宽代理IP + 承载单窗口或多平台窗口）
    ads_profiles = [
        ("ads-01", "ADS-001", "101", "k9x2m01", "主体1-青川1组全域销售窗", "销售一组-主体1", "dev-pc-01", "px-01", "sales_only", 1, "2026-11-13 22:00", "proxy_warning", "绑定IP-HZ-01(3天后到期)；内挂闲鱼1店+微信小店1+小红书小店1(不同平台合法复用)"),
        ("ads-02", "ADS-002", "102", "k9x2m02", "主体1-闲鱼2店专属窗", "销售一组-主体1", "dev-pc-01", "px-02", "sales_only", 1, "2026-11-13 22:00", "proxy_warning", "绑定IP-HZ-02(5天后到期)"),
        ("ads-03", "ADS-003", "103", "k9x2m03", "主体1-闲鱼3店专属窗", "销售一组-主体1", "dev-pc-01", "px-03", "sales_only", 1, "2026-11-13 22:00", "active", "绑定IP-HZ-03"),
        ("ads-04", "ADS-004", "104", "k9x2m04", "主体1-闲鱼4店专属窗", "销售一组-主体1", "dev-pc-01", "px-04", "sales_only", 1, "2026-11-13 22:00", "active", "绑定IP-HZ-04"),
        ("ads-05", "ADS-005", "105", "k9x2m05", "主体2-闲鱼5店+淘宝网店窗", "销售二组-主体2", "dev-pc-01", "px-05", "sales_only", 1, "2026-11-13 22:15", "active", "同主体跨平台复用IP-JX-05（闲鱼5店 + 云栖淘宝网店）"),
        ("ads-06", "ADS-006", "106", "k9x2m06", "主体2-闲鱼6店+抖店窗", "销售二组-主体2", "dev-pc-01", "px-06", "sales_only", 1, "2026-11-13 22:15", "active", "同主体跨平台复用IP-JX-06（闲鱼6店 + 云栖抖店）"),
        ("ads-07", "ADS-007", "107", "k9x2m07", "主体2-闲鱼7店专属窗", "销售二组-主体2", "dev-pc-01", "px-07", "sales_only", 1, "2026-11-13 22:15", "active", "绑定IP-JX-07"),
        ("ads-08", "ADS-008", "108", "k9x2m08", "主体2-闲鱼8店专属窗", "销售二组-主体2", "dev-pc-01", "px-08", "sales_only", 1, "2026-11-13 22:15", "active", "绑定IP-JX-08"),
        ("ads-09", "ADS-009", "109", "k9x2m09", "主体3-星澜全店旗舰窗", "销售三组-主体3", "dev-pc-01", "px-09", "sales_only", 1, "2026-11-14 09:00", "active", "同主体跨平台复用IP-HZ-09（闲鱼9店 + 星澜京东网店 + 星澜微信小店）"),
        ("ads-10", "ADS-010", "110", "k9x2m10", "主体3-闲鱼10店专属窗", "销售三组-主体3", "dev-pc-01", "px-10", "sales_only", 1, "2026-11-14 09:00", "active", "绑定IP-HZ-10"),
        ("ads-11", "ADS-011", "111", "k9x2m11", "主体3-闲鱼11店专属窗", "销售三组-主体3", "dev-pc-01", "px-11", "sales_only", 1, "2026-11-14 09:00", "active", "绑定IP-HZ-11"),
        ("ads-12", "ADS-012", "112", "k9x2m12", "主体4-闲鱼12店窗[代理过期暂停]", "销售三组-主体4", "dev-pc-01", "px-12", "sales_only", 1, "2026-11-12 23:00", "proxy_warning", "【警告】所绑IP-SX-12已过期，窗口已锁止防直连打开！"),
        ("ads-13", "ADS-013", "113", "k9x2m13", "主体4-闲鱼13店+小红书小店窗", "销售三组-主体4", "dev-pc-01", "px-13", "sales_only", 1, "2026-11-14 09:00", "active", "同主体跨平台复用IP-SX-13"),
        ("ads-14", "ADS-014", "114", "k9x2m14", "主体4-闲鱼14店专属窗", "销售三组-主体4", "dev-pc-01", "px-14", "sales_only", 1, "2026-11-14 09:00", "active", "绑定IP-HU-14"),
        # 社媒营销独立窗口 & 采购买卡券独立宿主机窗口（跨平台复用已有家宽IP，但窗口、Cookie与宿主机完全物理隔离！）
        ("ads-15", "ADS-015", "201", "m8p3c01", "小红书种草营销1号窗", "社媒引流组", "dev-pc-02", "px-02", "marketing_only", 1, "2026-11-14 10:00", "active", "跨平台复用IP-HZ-02（该IP下无其他小红书营销号），专发星巴克/数字权益省钱攻略导流至小红书小店1"),
        ("ads-16", "ADS-016", "202", "m8p3c02", "小红书种草营销2号窗", "社媒引流组", "dev-pc-02", "px-06", "marketing_only", 1, "2026-11-14 10:00", "active", "跨平台复用IP-JX-06，导流至溪谷小红书小店与私域微信"),
        ("ads-17", "ADS-017", "301", "b7q1p01", "采购买券窗A(点评1+抖省省1+淘采1)", "虚拟卡券采购组", "dev-pc-02", "px-01", "purchase_only", 1, "2026-11-14 11:00", "active", "在采购宿主机DEV-PC-02运行；复用IP-HZ-01操作大众点评买券1号（与闲鱼1店不同平台，零冲突）"),
        ("ads-18", "ADS-018", "302", "b7q1p02", "采购买券窗B(京东采1+闲鱼采1)", "虚拟卡券采购组", "dev-pc-02", "px-16", "purchase_only", 1, "2026-11-14 11:00", "active", "绑定独立采购家宽IP-HZ-16（因闲鱼采购号不能与闲鱼1~14销售店共用同平台IP！）"),
        ("ads-19", "ADS-019", "401", "w2n5y01", "山屿优选-闲鱼1店窗", "宁波二号法人组", "dev-pc-01", "px-15", "sales_only", 1, "2026-11-14 09:30", "active", "王雅琴闲鱼窗口"),
    ]
    cur.executemany(
        """INSERT INTO adspower_profiles
           (id, profile_code, ads_serial_no, ads_user_id, window_name, group_name, host_device_id,
            proxy_ip_id, role_isolation, fingerprint_locked, cookie_backup_at, profile_status, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        ads_profiles,
    )

    # 11. 全平台商业账号与小店矩阵（33 个账号：14闲鱼销售店 + 1闲鱼采购号 + 微信2 + 微信小店2 + 小红书社媒营销2 + 小红书小店2 + 大众点评买券3 + 抖音买券2 + 抖省省买券2 + 抖店1 + 淘宝采购1 + 淘宝网店1 + 京东采购1 + 京东网店1 + 王雅琴闲鱼1）
    # 注意验证：
    # - 任意 (proxy_ip_id, platform) 100% 唯一！同平台绝无共用同一家宽，跨平台高效复用！
    # - 任意 sales_only 仅绑 sales_only 支付宝且同营业执照主体！
    # - 任意 purchase_only 仅绑 purchase_only 因公支付采购支付宝且同营业执照主体！
    platform_accounts = [
        # --- 14 家闲鱼销售店铺（4 + 4 + 3 + 3 归属 4 本营业执照，各自独占 px-01 ~ px-14）---
        ("pa-xy-01", "lp-ljg", "ent-ljg-01", "xianyu", "XY-S01", "青川数码卡券1店", "tb_qc880101", "sales_only", "售卖餐饮码券/AI会员/3C数码", "sim-01", "ali-02", "ads-01", "px-01", "dev-ph-01", None, 100000, "日均45单", "陈晓雯", "active", "主体1第1店"),
        ("pa-xy-02", "lp-ljg", "ent-ljg-01", "xianyu", "XY-S02", "青川优选权益2店", "tb_qc880102", "sales_only", "售卖星巴克/霸王茶姬电子券", "sim-02", "ali-02", "ads-02", "px-02", "dev-ph-02", None, 100000, "日均38单", "陈晓雯", "active", "主体1第2店"),
        ("pa-xy-03", "lp-ljg", "ent-ljg-01", "xianyu", "XY-S03", "青川生活服务3店", "tb_qc880103", "sales_only", "售卖CAD描图/远程技术服务", "sim-03", "ali-03", "ads-03", "px-03", "dev-ph-03", None, 100000, "日均26单", "陈晓雯", "active", "主体1第3店"),
        ("pa-xy-04", "lp-ljg", "ent-ljg-01", "xianyu", "XY-S04", "青川极速发卡4店", "tb_qc880104", "sales_only", "售卖影音会员/数字直充", "sim-03", "ali-03", "ads-04", "px-04", "dev-ph-04", None, 100000, "日均31单", "陈晓雯", "active", "主体1第4店"),

        ("pa-xy-05", "lp-ljg", "ent-ljg-02", "xianyu", "XY-S05", "云栖严选好物5店", "tb_yq880205", "sales_only", "售卖连锁餐饮代金券/实物3C", "sim-05", "ali-06", "ads-05", "px-05", "dev-ph-05", None, 100000, "日均42单", "赵宇", "active", "主体2第1店"),
        ("pa-xy-06", "lp-ljg", "ent-ljg-02", "xianyu", "XY-S06", "云栖省钱卡包6店", "tb_yq880206", "sales_only", "售卖电影票/饮品券", "sim-06", "ali-06", "ads-06", "px-06", "dev-ph-06", None, 100000, "日均35单", "赵宇", "active", "主体2第2店"),
        ("pa-xy-07", "lp-ljg", "ent-ljg-02", "xianyu", "XY-S07", "云栖智享数码7店", "tb_yq880207", "sales_only", "售卖数码配件与远程刷机服务", "sim-07", "ali-07", "ads-07", "px-07", "dev-ph-07", None, 100000, "日均22单", "赵宇", "active", "主体2第3店"),
        ("pa-xy-08", "lp-ljg", "ent-ljg-02", "xianyu", "XY-S08", "云栖本地福利8店", "tb_yq880208", "sales_only", "售卖自助餐/火锅团购券", "sim-13", "ali-07", "ads-08", "px-08", "dev-ph-08", None, 100000, "日均29单", "赵宇", "active", "主体2第4店（所绑外部卡sim-13将于12/10到期）"),

        ("pa-xy-09", "lp-ljg", "ent-ljg-03", "xianyu", "XY-S09", "星澜数字官方9店", "tb_xl880309", "sales_only", "售卖AI工具会员/云盘权益", "sim-09", "ali-10", "ads-09", "px-09", "dev-ph-09", None, 200000, "鱼小铺·日均55单", "林婷", "active", "主体3有限公司第1店"),
        ("pa-xy-10", "lp-ljg", "ent-ljg-03", "xianyu", "XY-S10", "星澜企业服务10店", "tb_xl880310", "sales_only", "售卖企业软件/设计服务", "sim-10", "ali-10", "ads-10", "px-10", "dev-ph-10", None, 100000, "日均27单", "林婷", "active", "主体3第2店"),
        ("pa-xy-11", "lp-ljg", "ent-ljg-03", "xianyu", "XY-S11", "星澜卡券直通11店", "tb_xl880311", "sales_only", "售卖商超卡/茶饮卡券", "sim-10", "ali-10", "ads-11", "px-11", "dev-ph-10", None, 100000, "日均30单", "林婷", "active", "主体3第3店"),

        ("pa-xy-12", "lp-ljg", "ent-ljg-04", "xianyu", "XY-S12", "溪谷优选特惠12店", "tb_xg880412", "sales_only", "售卖咖啡快餐券包", "sim-12", "ali-13", "ads-12", "px-12", "dev-ph-12", None, 100000, "暂停待续代理IP", "林婷", "restricted", "【双重预警】家宽IP-SX-12已过期暂停 + 外部手机卡sim-12月底到期需换绑！"),
        ("pa-xy-13", "lp-ljg", "ent-ljg-04", "xianyu", "XY-S13", "溪谷乐享生活13店", "tb_xg880413", "sales_only", "售卖本地生活代订卡券", "sim-11", "ali-13", "ads-13", "px-13", "dev-ph-11", None, 100000, "日均33单", "林婷", "active", "主体4第2店"),
        ("pa-xy-14", "lp-ljg", "ent-ljg-04", "xianyu", "XY-S14", "溪谷全品类14店", "tb_xg880414", "sales_only", "售卖虚拟权益与闲置百货", "sim-14", "ali-13", "ads-14", "px-14", "dev-ph-12", None, 100000, "日均28单", "林婷", "active", "主体4第3店"),

        # --- 闲鱼独立采购号（必须用独立家宽 px-16，绝不与上面14家闲鱼销售店共IP，且绑因公采购支付宝！）---
        ("pa-xy-buy1", "lp-ljg", "ent-ljg-01", "xianyu", "XY-BUY01", "青川闲鱼收货采购专号", "tb_qcbuy_01", "purchase_only", "闲鱼二手3C与低价卡券收货采购", "sim-04", "ali-04", "ads-18", "px-16", "dev-ph-14", None, 0, "日限采3万元(因公付扣ALI-E1-M1)", "李航", "active", "独立采购家宽px-16+采购专机DEV-PH-14，绝不挂售任何商品"),

        # --- 微信 & 微信小店 ---
        ("pa-wx-01", "lp-ljg", "ent-ljg-01", "wechat", "WX-MKT01", "青川福利官-小雯(微信号)", "wxid_qc_wen01", "marketing_only", "私域老客复购发券与售后接待", "sim-02", None, None, "px-03", "dev-ph-02", None, 0, "好友3820人", "陈晓雯", "active", "导流至青川微信小店成交，不在个人微信内混乱收款"),
        ("pa-wx-02", "lp-ljg", "ent-ljg-03", "wechat", "WX-MKT02", "星澜数字管家(企微/个微)", "wxid_xl_vip02", "marketing_only", "数字权益会员续费提醒与导流", "sim-10", None, None, "px-10", "dev-ph-10", None, 0, "好友2150人", "林婷", "active", "导流至星澜微信小店"),
        ("pa-wxs-01", "lp-ljg", "ent-ljg-01", "wechat_shop", "WXS-S01", "青川严选生活馆（微信小店）", "wxshop_33010501", "sales_only", "微信生态售卖电子卡券/礼品卡", "sim-01", "ali-02", "ads-01", "px-01", "dev-ph-02", None, 500000, "保证金5000元·已亮照", "陈晓雯", "active", "复用IP-HZ-01(与闲鱼1店异平台复用)；主体1执照合规开店"),
        ("pa-wxs-02", "lp-ljg", "ent-ljg-03", "wechat_shop", "WXS-S02", "星澜数字权益旗舰店（微信小店）", "wxshop_33010802", "sales_only", "微信小店售卖办公/效率软件权益", "sim-09", "ali-10", "ads-09", "px-09", "dev-ph-09", None, 500000, "有限公司认证小店", "林婷", "active", "复用IP-HZ-09；主体3有限公司执照开店"),
    ]
    cur.executemany(
        """INSERT INTO platform_accounts
           (id, legal_person_id, business_entity_id, platform, account_code, display_name, platform_login_id,
            account_role, virtual_biz_usage, bound_sim_id, alipay_account_id, adspower_profile_id, proxy_ip_id,
            physical_device_id, lead_target_account_id, deposit_fen, daily_quota_note, operator_staff, account_status, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        platform_accounts,
    )

    # 先插入小红书小店（以便小红书社媒营销号外键指向导流目标小店！）
    xhs_shops_and_rest = [
        # --- 小红书小店（销售专用 sales_only）---
        ("pa-xhss-01", "lp-ljg", "ent-ljg-01", "xiaohongshu_shop", "XHSS-S01", "青川数智生活馆（小红书小店）", "xhs_shop_90112", "sales_only", "小红书店铺直售数字权益/设计服务/茶饮券", "sim-02", "ali-03", "ads-01", "px-01", "dev-ph-02", None, 100000, "保证金1000元·个体店", "陈晓雯", "active", "主体1营业执照入驻小红书小店；复用家宽IP-HZ-01"),
        ("pa-xhss-02", "lp-ljg", "ent-ljg-04", "xiaohongshu_shop", "XHSS-S02", "溪谷特惠卡券铺（小红书小店）", "xhs_shop_90418", "sales_only", "小红书店铺售卖吃喝玩乐虚拟券", "sim-11", "ali-13", "ads-13", "px-13", "dev-ph-11", None, 100000, "保证金1000元·个体店", "林婷", "active", "主体4营业执照入驻小红书小店；复用家宽IP-SX-13"),

        # --- 小红书社媒营销号（社媒种草引流 marketing_only，与小店账号联动导流）---
        ("pa-xhsm-01", "lp-ljg", "ent-ljg-01", "xiaohongshu_mkt", "XHSM-M01", "杭城省钱课代表（小红书社媒号）", "xhs_media_66101", "marketing_only", "发布咖啡/火锅半价攻略笔记，主页挂店&私信导流", "sim-03", None, "ads-15", "px-02", "dev-ph-03", "pa-xhss-01", 0, "粉丝1.4万·日发3篇笔记", "陈晓雯", "active", "小红书社媒营销1号：定向导流至【青川数智生活馆(小红书小店)】与私域微信WX-MKT01"),
        ("pa-xhsm-02", "lp-ljg", "ent-ljg-04", "xiaohongshu_mkt", "XHSM-M02", "江浙沪薅券情报局（小红书社媒号）", "xhs_media_66208", "marketing_only", "发布周末探店团购省钱合集，导流至溪谷小红书小店", "sim-12", None, "ads-16", "px-06", "dev-ph-06", "pa-xhss-02", 0, "粉丝6800·注意sim-12月底换绑", "赵宇", "active", "小红书社媒营销2号：复用IP-JX-06；注意绑定手机sim-12将于11/30合约到期！"),

        # --- 大众点评（虚拟产品买卡券专用 purchase_only！）---
        ("pa-dp-01", "lp-ljg", "ent-ljg-01", "dianping", "DP-BUY01", "点评买券1号(V6吃货号)", "dp_user_77101", "purchase_only", "虚拟产品采购：买星巴克/喜茶/地方餐饮团购券码", "sim-04", "ali-04", "ads-17", "px-01", "dev-ph-13", None, 0, "日限购15单·走ALI-E1-P1因公支付", "李航", "active", "只买不卖！通过主体1采购子号因公支付直扣ALI-E1-M1；复用IP-HZ-01(点评平台唯一)"),
        ("pa-dp-02", "lp-ljg", "ent-ljg-03", "dianping", "DP-BUY02", "点评买券2号(黑珍珠会员)", "dp_user_77205", "purchase_only", "虚拟产品采购：高客单餐饮代金券采购", "sim-15", "ali-11", None, "px-05", "dev-ph-14", None, 0, "日限购12单·走ALI-E3-P1因公支付", "李航", "active", "插外部卡sim-15在采购2机运行；复用IP-JX-05(点评平台唯一)"),
        ("pa-dp-03", "lp-ljg", "ent-ljg-04", "dianping", "DP-BUY03", "点评买券3号(杭州本地号)", "dp_user_77312", "purchase_only", "虚拟产品采购：茶饮甜品电子兑换券", "sim-12", "ali-14", None, "px-14", "dev-ph-14", None, 0, "日限购10单·注意sim-12月底换卡", "李航", "active", "走主体4采购子号ALI-E4-P1因公支付；复用IP-HU-14"),

        # --- 抖音 & 抖省省（虚拟产品买卡券专用 purchase_only！）& 抖店（销售专用 sales_only）---
        ("pa-dy-01", "lp-ljg", "ent-ljg-02", "douyin", "DY-BUY01", "抖音团购买券1号", "dy_buy_55104", "purchase_only", "虚拟产品采购：抖音本地生活团购券/电影券采买", "sim-08", "ali-08", None, "px-04", "dev-ph-13", None, 0, "日采20单·走ALI-E2-P1因公支付", "李航", "active", "纯买券采购号，严禁挂小黄车或混接抖店客服；复用IP-HZ-04"),
        ("pa-dy-02", "lp-ljg", "ent-ljg-04", "douyin", "DY-BUY02", "抖音团购买券2号", "dy_buy_55210", "purchase_only", "虚拟产品采购：全国连锁快餐券秒杀采购", "sim-14", "ali-14", None, "px-10", "dev-ph-14", None, 0, "日采15单·走ALI-E4-P1因公支付", "李航", "active", "复用IP-HZ-10(抖音平台唯一)"),
        ("pa-dss-01", "lp-ljg", "ent-ljg-01", "doushengsheng", "DSS-BUY01", "抖省省特惠买券1号", "dss_vip_301", "purchase_only", "虚拟产品采购：抖省省补贴神券/茶饮爆品券采买", "sim-04", "ali-04", None, "px-02", "dev-ph-13", None, 0, "补贴额度高·走ALI-E1-P1因公支付", "李航", "active", "抖省省独立App在采购1机运行；复用IP-HZ-02"),
        ("pa-dss-02", "lp-ljg", "ent-ljg-04", "doushengsheng", "DSS-BUY02", "抖省省特惠买券2号", "dss_vip_302", "purchase_only", "虚拟产品采购：抖省省餐饮连锁券采买", "sim-16", "ali-14", None, "px-07", "dev-ph-14", None, 0, "【注意】所绑sim-16话费仅剩9元需充话费", "李航", "active", "走ALI-E4-P1因公支付；复用IP-JX-07"),
        ("pa-dd-01", "lp-ljg", "ent-ljg-02", "doudian", "DD-S01", "云栖严选生活专营（抖店）", "doudian_33010688", "sales_only", "抖店售卖电子权益/服务类商品", "sim-06", "ali-07", "ads-06", "px-06", "dev-ph-06", None, 200000, "保证金2000元·主体2亮照", "赵宇", "active", "纯销售抖店：绑定主体2销售支付宝ALI-E2-S2，与抖音买券号彻底隔离"),

        # --- 淘宝采购号 vs 淘宝网店 ---
        ("pa-tb-buy1", "lp-ljg", "ent-ljg-02", "taobao_buyer", "TB-BUY01", "云栖淘宝88VIP买券采购号", "tb_vipbuyer_02", "purchase_only", "淘宝百亿补贴卡券/天猫直充权益采购", "sim-08", "ali-08", None, "px-03", "dev-ph-13", None, 0, "88VIP·走ALI-E2-P1因公支付", "李航", "active", "纯淘宝买家采购号；绝不开店卖货"),
        ("pa-tbs-01", "lp-ljg", "ent-ljg-02", "taobao_store", "TBS-S01", "云栖数智企业服务店（淘宝网店）", "tb_shop_yunqi01", "sales_only", "淘宝网店售卖CAD设计/软件技术服务/卡券", "sim-05", "ali-06", "ads-05", "px-05", "dev-ph-05", None, 100000, "消保保证金1000元·企业店铺", "赵宇", "active", "主体2执照认证淘宝网店，绑定ALI-E2-S1纯销售收款"),

        # --- 京东采购号 vs 京东网店 ---
        ("pa-jd-buy1", "lp-ljg", "ent-ljg-03", "jd_buyer", "JD-BUY01", "星澜京东PLUS权益采购号", "jd_plus_xl01", "purchase_only", "京东E卡/自营电子卡券/3C配件采购", "sim-15", "ali-11", "ads-18", "px-09", "dev-ph-14", None, 0, "PLUS年卡·走ALI-E3-P1因公付", "李航", "active", "在采购宿主机ADS-018运行；与京东网店属不同平台枚举(jd_buyer vs jd_store)"),
        ("pa-jds-01", "lp-ljg", "ent-ljg-03", "jd_store", "JDS-S01", "星澜数字专营店（京东网店）", "jd_pop_xinglan", "sales_only", "京东POP店售卖数字权益与数码配件", "sim-09", "ali-10", "ads-09", "px-09", "dev-ph-09", None, 1000000, "保证金10000元·有限公司POP店", "林婷", "active", "主体3有限公司入驻京东网店，对公/ALI-E3-S1销售回款"),

        # --- 二号法人对照店铺 ---
        ("pa-wyq-xy01", "lp-wyq", "ent-wyq-01", "xianyu", "WYQ-XY01", "山屿好物严选1店", "tb_wyq9001", "sales_only", "3C数码与虚拟卡券", "sim-17", "ali-16", "ads-19", "px-15", "dev-ph-15", None, 100000, "日均19单", "赵宇", "active", "王雅琴主体独立闭环演示"),
    ]
    cur.executemany(
        """INSERT INTO platform_accounts
           (id, legal_person_id, business_entity_id, platform, account_code, display_name, platform_login_id,
            account_role, virtual_biz_usage, bound_sim_id, alipay_account_id, adspower_profile_id, proxy_ip_id,
            physical_device_id, lead_target_account_id, deposit_fen, daily_quota_note, operator_staff, account_status, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        xhs_shops_and_rest,
    )

    # 11B. 全量补齐每个账号的专属财务结算、佣金费率、保证金原路退回、月度损益与 ERP/OA 科目预留槽位
    seed_account_finance_profiles(conn)

    # 11C. 支付宝/商户收支、因公支付代扣、退券冲回与保证金流水台账样本（穿透关联具体业务账号）
    bills = [
        ("bill-01", "2026-11-14", "ent-ljg-01", "ali-04", "ali-01", "pa-dp-01", "outflow_corporate_pay", "大众点评买卡券(因公支付扣主户)", "美团点评·星巴克/霸王茶姬电子券包×30", "DP-20261114-00921", 84600, 0, "OA-PAY-20261114-01", "matched", "子号ALI-E1-P1下单，同主体主号ALI-E1-M1实扣846.00元"),
        ("bill-02", "2026-11-14", "ent-ljg-01", "ali-02", None, "pa-xy-01", "inflow_sales", "闲鱼1店虚拟券包销售结算", "闲鱼买家匿名担保结算(38单汇总)", "XY-20261114-batch1", 119200, 715, "ERP-AR-20261114-01", "matched", "纯销售入账(已计提0.6%基础软件服务费7.15元)，与采购链路物理隔离"),
        ("bill-03", "2026-11-14", "ent-ljg-02", "ali-08", "ali-05", "pa-dy-01", "outflow_corporate_pay", "抖音团购券采购(因公支付扣主户)", "抖音生活服务·海底捞代金券×15", "DY-20261114-33812", 127500, 0, "OA-PAY-20261114-02", "matched", "子号ALI-E2-P1下单，同主体主号ALI-E2-M1实扣1275.00元"),
        ("bill-04", "2026-11-14", "ent-ljg-03", "ali-11", "ali-09", "pa-jd-buy1", "outflow_corporate_pay", "AI数字权益与E卡集中采购(因公支付)", "星澜供应商直充与京东自营接口", "DIG-20261114-7710", 240000, 0, "OA-PAY-20261114-03", "matched", "有限公司主体内部因公支付扣主户ALI-E3-M1，已登记待收6%进项专票"),
        ("bill-05", "2026-11-13", "ent-ljg-04", "ali-14", "ali-12", "pa-dss-02", "outflow_corporate_pay", "抖省省特惠买卡券(因公支付)", "抖省省·肯德基/瑞幸团购券×50", "DSS-20261113-5190", 69500, 0, "待关联OA单", "pending", "主体4手工账单待今日傍晚与主户流水核销"),
        ("bill-06", "2026-11-13", "ent-ljg-03", "ali-10", None, "pa-wxs-02", "inflow_sales", "微信小店T+1提现归集入账", "财付通商户号mch_168830302结算结转", "WXSHOP-20261113-08", 358000, 7160, "ERP-AR-20261113-09", "matched", "微信小店扣除2.0%类目技术服务费后T+1结算归集"),
        ("bill-07", "2026-11-13", "ent-ljg-01", "ali-04", "ali-01", "pa-dp-01", "inflow_purchase_refund", "采购卡券超时未核销原路退券冲回", "美团点评·过期自动退券原路回充主户", "DP-REF-20261113-108", 28200, 0, "ERP-RFD-20261113-01", "matched", "因公支付退单原路冲回同主体主资金号ALI-E1-M1，冲减当月采购成本282.00元"),
        ("bill-08", "2026-11-02", "ent-ljg-01", "ali-01", None, "pa-wxs-01", "outflow_deposit", "缴纳微信小店类目店铺保证金", "腾讯微信小店商户保证金专户", "WXS-DEP-20261102-01", 500000, 0, "ERP-DEP-20261102-01", "matched", "计入其他应收款-平台保证金科目，关店时原路退回主体1主户/招行卡*2864"),
    ]
    cur.executemany(
        """INSERT INTO alipay_bills
           (id, bill_date, business_entity_id, alipay_account_id, deducted_master_alipay_id, related_platform_account_id,
            flow_direction, biz_scene, counterparty, platform_order_ref, amount_fen, fee_fen,
            oa_finance_voucher_no, reconcile_status, notes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        bills,
    )

    # 12. 自动同步构建全网手机号 -> 关联对象穿透图谱（涵盖税局、工商年报、企业支付宝、全部平台账号与企业邮箱密保）
    sync_phone_bindings(conn)
    conn.commit()


def seed_account_finance_profiles(conn: sqlite3.Connection) -> None:
    """为每一个企业支付宝与每一个平台商业账号初始化精细化财务逻辑与 ERP/OA 科目预留槽位"""
    cur = conn.cursor()

    # 1) 企业支付宝财务内控槽位（单笔限额、公钥证书状态、风险备付冻结金、财务账套科目号）
    for r in cur.execute(
        "SELECT id, account_code, business_entity_id, trade_direction, is_entity_master_fund, bill_sync_status FROM alipay_accounts"
    ).fetchall():
        aid, acode, ent_id, tdir, is_master, sync_st = r
        single_limit = 10000000 if is_master else (3000000 if tdir == "purchase_only" else 5000000)
        frozen_res = 200000 if is_master else 0
        cert_mode = "手工导账单(待配公钥证书)" if sync_st == "手工导账单" else "公钥证书三件套已备(支持无密对账)"
        subj_suffix = "主资金池" if is_master else ("因公采购专户" if tdir == "purchase_only" else "销售收款专户")
        fin_code = f"1012.{acode}-{subj_suffix}"
        cur.execute(
            """UPDATE alipay_accounts
               SET single_tx_limit_fen = ?, frozen_reserve_fen = ?, cert_sign_mode = ?, finance_book_code = ?
               WHERE id = ?""",
            (single_limit, frozen_res, cert_mode, fin_code, aid),
        )

    # 主体对应结算银行卡参考映射
    ent_bank_map = {
        "ent-ljg-01": ("招行杭州莫干山支行经营者一类卡 *2864", "个体普票季度30万免税池"),
        "ent-ljg-02": ("工行杭州文三路支行经营者一类卡 *9031", "个体普票季度30万免税池"),
        "ent-ljg-03": ("建行杭州滨江支行对公基本户 *1852", "有限公司6%增值税查账核算"),
        "ent-ljg-04": ("农行杭州未来科技城支行经营者卡 *5519", "个体普票季度30万免税池"),
        "ent-wyq-01": ("宁波银行鄞州支行经营者一类卡 *6618", "个体普票季度30万免税池"),
    }
    ent_master_code = {
        "ent-ljg-01": "ALI-E1-M1",
        "ent-ljg-02": "ALI-E2-M1",
        "ent-ljg-03": "ALI-E3-M1",
        "ent-ljg-04": "ALI-E4-M1",
        "ent-wyq-01": "ALI-WYQ-M1",
    }

    # 2) 33个全平台商业账号逐号财务规则与月度损益槽位初始化
    rows = cur.execute(
        """SELECT id, business_entity_id, platform, account_code, account_role, alipay_account_id, deposit_fen, daily_quota_note
           FROM platform_accounts"""
    ).fetchall()

    for idx, r in enumerate(rows, start=1):
        pid, ent_id, plat, acode, role, ali_id, dep_fen, quota_note = r
        bank_ref, default_tax_mode = ent_bank_map.get(ent_id or "", ("待绑主体结算卡", "个人/非执照号不涉销项票"))
        master_code = ent_master_code.get(ent_id or "", "同主体主资金号")

        if role == "marketing_only":
            channel = "no_settlement"
            mch_no = "纯引流号禁开收款商户"
            s_bank = "禁止私下收转账(导流至小店)"
            cycle = "禁收付纯引流"
            rate_bps = 0
            dep_src = "-"
            frozen_fen = 0
            gmv_fen, cost_fen, refund_fen = 0, 0, 0
            tax_mode = "纯内容引流不涉税"
            book_code = f"ERP-MKT-{acode} | 营销获客中心"
        elif role == "purchase_only":
            channel = "corporate_pay_deduct"
            mch_no = f"因公签约->{master_code}"
            s_bank = f"直扣 {master_code} 备付金池"
            cycle = "下单实时扣同主体主户"
            rate_bps = 0
            dep_src = "-"
            frozen_fen = 0
            gmv_fen = 0
            cost_fen = (480000 + (idx % 6) * 165000)
            refund_fen = 28200 if pid == "pa-dp-01" else ((idx % 3) * 12000)
            tax_mode = "采购索取合规普票/6%进项专票" if ent_id == "ent-ljg-03" else "采购索取合规电子普票入成本"
            book_code = f"ERP-BUY-{acode} | 采购成本归集槽(待接OA)"
        else:
            # 销售店铺：按不同平台真实底层清算通道分别落位！
            is_yuxiaopu = ("鱼小铺" in (quota_note or "")) or pid == "pa-xy-09"
            if plat == "xianyu":
                channel = "alipay_direct"
                mch_no = f"闲鱼担保->{acode}"
                s_bank = bank_ref
                cycle = "买家确认收货实时到企支"
                rate_bps = 160 if is_yuxiaopu else 60  # 鱼小铺1.60% vs 标准闲鱼0.60%
                gmv_fen = 4260000 if is_yuxiaopu else (1680000 + (idx % 7) * 290000)
                cost_fen = int(gmv_fen * 0.78)
                refund_fen = int(gmv_fen * 0.025)
                frozen_fen = 68000 if pid == "pa-xy-12" else 35000
            elif plat == "wechat_shop":
                channel = "wechat_pay_mch"
                mch_no = "mch_168830101" if pid == "pa-wxs-01" else "mch_168830302"
                s_bank = bank_ref
                cycle = "确认收货T+1自动提现"
                rate_bps = 200  # 微信小店虚拟/生活卡券类目约2.00%
                gmv_fen = 3850000 if pid == "pa-wxs-02" else 2920000
                cost_fen = int(gmv_fen * 0.76)
                refund_fen = 86000
                frozen_fen = 145000
            elif plat == "xiaohongshu_shop":
                channel = "xhs_merchant"
                mch_no = "xhs_mch_90112" if pid == "pa-xhss-01" else "xhs_mch_90418"
                s_bank = bank_ref
                cycle = "确认收货T+7千帆结算"
                rate_bps = 200
                gmv_fen = 1940000 if pid == "pa-xhss-01" else 1520000
                cost_fen = int(gmv_fen * 0.75)
                refund_fen = 42000
                frozen_fen = 92000
            elif plat == "doudian":
                channel = "douyin_pay_mch"
                mch_no = "dy_mch_33010688"
                s_bank = bank_ref
                cycle = "核销后T+3合众易宝结算"
                rate_bps = 200
                gmv_fen = 2680000
                cost_fen = int(gmv_fen * 0.77)
                refund_fen = 64000
                frozen_fen = 118000
            elif plat == "taobao_store":
                channel = "alipay_direct"
                mch_no = "淘宝企店担保->ALI-E2-S1"
                s_bank = bank_ref
                cycle = "确认收货实时入企支"
                rate_bps = 60
                gmv_fen = 2350000
                cost_fen = int(gmv_fen * 0.74)
                refund_fen = 51000
                frozen_fen = 45000
            elif plat == "jd_store":
                channel = "jd_wallet_mch"
                mch_no = "jd_mch_8830301"
                s_bank = bank_ref
                cycle = "T+7京东企业钱包结转对公"
                rate_bps = 300
                gmv_fen = 4620000
                cost_fen = int(gmv_fen * 0.79)
                refund_fen = 95000
                frozen_fen = 210000
            else:
                channel = "alipay_direct"
                mch_no = f"默认商户->{acode}"
                s_bank = bank_ref
                cycle = "确认收货实时"
                rate_bps = 60
                gmv_fen, cost_fen, refund_fen, frozen_fen = 1200000, 900000, 20000, 0

            dep_src = f"{master_code} / {bank_ref.split(' ')[0]} 原路缴退" if dep_fen > 0 else "免保证金"
            tax_mode = default_tax_mode
            book_code = f"ERP-SHOP-{acode} | 10%净毛利提成核算槽"

        cur.execute(
            """UPDATE platform_accounts
               SET settlement_channel = ?, merchant_account_no = ?, settlement_bank_ref = ?,
                   settlement_cycle = ?, commission_rate_bps = ?, deposit_source_ref = ?,
                   frozen_balance_fen = ?, month_gmv_fen = ?, month_cost_fen = ?, month_refund_fen = ?,
                   tax_invoice_mode = ?, finance_book_code = ?
               WHERE id = ?""",
            (
                channel, mch_no, s_bank, cycle, rate_bps, dep_src,
                frozen_fen, gmv_fen, cost_fen, refund_fen, tax_mode, book_code, pid
            ),
        )


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
        ("pb-mail-root", "sim-01", "enterprise_email", "mail-qingchuan-admin", "阿里企业邮箱总控域 @qingchuan-ops.cn (含14子邮)", "阿里云企业邮箱", "超级管理员密保手机", "critical", "统管全部企业支付宝登录子邮箱，去139/189运营商邮箱化"),
    )


def init_db(db_path: Path = DEFAULT_DB_PATH, force_reset: bool = False) -> sqlite3.Connection:
    from device_adspower_health_seed import ensure_cluster_and_health_seeded
    from tutorial_and_gap_seed import ensure_tutorials_and_gaps_seeded
    from vault_security import ensure_vault_tables_and_seed
    from workbench_governance_seed import ensure_governance_seeded

    if force_reset and db_path.exists():
        db_path.unlink()
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
    c = init_db(force_reset=True)
    print(f"Database initialized at {DEFAULT_DB_PATH}")
    for tbl in [
        "legal_persons", "business_entities", "tax_registrations", "annual_reports",
        "alipay_accounts", "alipay_bills", "carrier_quotas", "sim_cards", "sim_fee_records",
        "proxy_ips", "physical_devices", "adspower_profiles", "platform_accounts", "phone_bindings"
    ]:
        n = c.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
        print(f"  {tbl:20s}: {n} rows")
    c.close()

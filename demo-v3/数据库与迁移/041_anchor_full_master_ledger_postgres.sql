-- 041_anchor_full_master_ledger_postgres.sql
-- 面向 anchor-account-ops-console (PostgreSQL) 的生产前向迁移脚本
-- 作用：解除 003/005/026/032/034 历史唯一键与枚举死锁，落实老板全量台账五大新规

BEGIN;

-- 1. 解除委托客户 5/6 槽位死锁与经营单元固定6枚举死锁
ALTER TABLE legal_person_account_plans DROP CONSTRAINT IF EXISTS legal_person_account_plans_plan_check;
ALTER TABLE operation_units DROP CONSTRAINT IF EXISTS operation_units_profile_check;

-- 2. 补齐营业执照核心字段，并将税务登记、工商年报唯一键从 legal_person_id 下沉至 business_entity_id（支持 1签约委托客户 -> 4受托执照 -> 4税务 + 4年报）
ALTER TABLE business_entities
  ADD COLUMN IF NOT EXISTS uscc TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS registration_authority TEXT,
  ADD COLUMN IF NOT EXISTS established_date DATE,
  ADD COLUMN IF NOT EXISTS registered_address TEXT,
  ADD COLUMN IF NOT EXISTS business_scope TEXT;

ALTER TABLE electronic_tax_accounts
  ADD COLUMN IF NOT EXISTS business_entity_id UUID REFERENCES business_entities(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS quarter_sales_cents BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quarter_exempt_limit_cents BIGINT NOT NULL DEFAULT 30000000;
ALTER TABLE electronic_tax_accounts DROP CONSTRAINT IF EXISTS electronic_tax_accounts_organization_id_legal_person_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tax_accounts_per_business_entity
  ON electronic_tax_accounts (organization_id, business_entity_id) WHERE business_entity_id IS NOT NULL;

ALTER TABLE compliance_reports
  ADD COLUMN IF NOT EXISTS business_entity_id UUID REFERENCES business_entities(id) ON DELETE CASCADE;
ALTER TABLE compliance_reports DROP CONSTRAINT IF EXISTS compliance_reports_organization_id_legal_person_id_report_t_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_compliance_reports_per_entity_period
  ON compliance_reports (organization_id, business_entity_id, report_type, period_key) WHERE business_entity_id IS NOT NULL;

-- 3. 解除 SIM 卡 1:1 绑定死锁与禁止绑设备死锁
DROP INDEX IF EXISTS asset_bindings_one_active_idx;
ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_device_binding_only_email_check;

-- 4. 家宽代理 IP 台账（¥10/月住宅 SOCKS5，含到期时间与防删关联）
CREATE TABLE IF NOT EXISTS ledger_proxy_ips (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  proxy_code TEXT NOT NULL,
  provider TEXT NOT NULL,
  plan_name TEXT NOT NULL DEFAULT '',
  isp_region TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('SOCKS5', 'HTTP', 'HTTPS')),
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  credential_ciphertext TEXT NOT NULL,
  exit_ip TEXT NOT NULL,
  monthly_cost_cents INTEGER NOT NULL DEFAULT 1000,
  purchased_at DATE NOT NULL,
  expires_at DATE NOT NULL,
  oa_renewal_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, proxy_code)
);

-- 5. 手机卡话费与外部合约期扩展表 + 运营商一主4副占坑配额表
CREATE TABLE IF NOT EXISTS ledger_carrier_quotas (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  holder_name TEXT NOT NULL,
  holder_id_card_hash TEXT NOT NULL,
  carrier TEXT NOT NULL CHECK (carrier IN ('中国移动', '中国联通', '中国电信', '中国广电')),
  statutory_limit INTEGER NOT NULL DEFAULT 5,
  existing_personal_cards INTEGER NOT NULL DEFAULT 0 CHECK (existing_personal_cards BETWEEN 0 AND 5),
  yztc_verified_date DATE,
  UNIQUE (organization_id, holder_id_card_hash, carrier)
);

CREATE TABLE IF NOT EXISTS ledger_sim_profiles (
  sim_asset_id UUID PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  card_category TEXT NOT NULL CHECK (card_category IN ('company_master', 'company_sub', 'personal_existing', 'external_contract')),
  master_sim_asset_id UUID REFERENCES assets(id) ON DELETE SET NULL,
  billing_mode TEXT NOT NULL DEFAULT 'independent' CHECK (billing_mode IN ('independent', 'shared_master')),
  monthly_rent_cents INTEGER NOT NULL DEFAULT 0,
  billing_day SMALLINT NOT NULL DEFAULT 1 CHECK (billing_day BETWEEN 1 AND 31),
  balance_cents BIGINT NOT NULL DEFAULT 0,
  next_recharge_due DATE,
  is_external BOOLEAN NOT NULL DEFAULT FALSE,
  external_vendor TEXT,
  contract_start_date DATE,
  contract_end_date DATE,
  oa_recharge_hook_ref TEXT
);

-- 6. 企业支付宝主体内「3选1主资金号」+「因公支付同主体代扣」+「买卖严禁混用」+ 财务账套/单笔限额扩展表
CREATE TABLE IF NOT EXISTS ledger_alipay_profiles (
  alipay_asset_id UUID PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  business_entity_id UUID NOT NULL REFERENCES business_entities(id) ON DELETE RESTRICT,
  trade_direction TEXT NOT NULL CHECK (trade_direction IN ('master_fund', 'purchase_only', 'sales_only')),
  is_entity_master_fund BOOLEAN NOT NULL DEFAULT FALSE,
  corporate_pay_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  master_alipay_asset_id UUID REFERENCES ledger_alipay_profiles(alipay_asset_id) ON DELETE RESTRICT,
  daily_limit_cents BIGINT NOT NULL DEFAULT 0,
  single_tx_limit_cents BIGINT NOT NULL DEFAULT 10000000,
  frozen_reserve_cents BIGINT NOT NULL DEFAULT 0,
  cert_sign_mode TEXT NOT NULL DEFAULT '公钥证书三件套已备',
  finance_book_code TEXT NOT NULL DEFAULT '',
  CHECK (NOT is_entity_master_fund OR trade_direction = 'master_fund'),
  CHECK (NOT corporate_pay_enabled OR (trade_direction = 'purchase_only' AND master_alipay_asset_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_one_master_alipay_per_entity
  ON ledger_alipay_profiles (business_entity_id) WHERE is_entity_master_fund = TRUE;

-- 7. 全平台商业账户矩阵（强制同平台独占1条家宽、不同平台允许复用 + 单账号专属财务结算与损益预留槽）
CREATE TABLE IF NOT EXISTS ledger_platform_accounts (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  legal_person_id UUID NOT NULL REFERENCES legal_persons(id) ON DELETE RESTRICT,
  business_entity_id UUID REFERENCES business_entities(id) ON DELETE SET NULL,
  platform TEXT NOT NULL CHECK (platform IN (
    'xianyu', 'taobao_buyer', 'taobao_store',
    'wechat', 'wechat_shop',
    'xiaohongshu_mkt', 'xiaohongshu_shop',
    'dianping', 'douyin', 'doushengsheng', 'doudian',
    'jd_buyer', 'jd_store'
  )),
  display_name TEXT NOT NULL,
  platform_login_id TEXT NOT NULL,
  account_role TEXT NOT NULL CHECK (account_role IN ('sales_only', 'purchase_only', 'marketing_only')),
  alipay_asset_id UUID REFERENCES ledger_alipay_profiles(alipay_asset_id) ON DELETE SET NULL,
  settlement_channel TEXT NOT NULL DEFAULT 'alipay_direct' CHECK (settlement_channel IN (
    'alipay_direct', 'wechat_pay_mch', 'douyin_pay_mch', 'xhs_merchant',
    'jd_wallet_mch', 'corporate_pay_deduct', 'overseas_card_fx', 'no_settlement'
  )),
  merchant_account_no TEXT NOT NULL DEFAULT '',
  settlement_bank_ref TEXT NOT NULL DEFAULT '',
  settlement_cycle TEXT NOT NULL DEFAULT '确认收货实时',
  commission_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (commission_rate_bps BETWEEN 0 AND 10000),
  deposit_cents BIGINT NOT NULL DEFAULT 0,
  deposit_source_ref TEXT NOT NULL DEFAULT '',
  frozen_balance_cents BIGINT NOT NULL DEFAULT 0,
  month_gmv_cents BIGINT NOT NULL DEFAULT 0,
  month_cost_cents BIGINT NOT NULL DEFAULT 0,
  month_refund_cents BIGINT NOT NULL DEFAULT 0,
  tax_invoice_mode TEXT NOT NULL DEFAULT '个体普票按季30万阈值合规监测',
  finance_book_code TEXT NOT NULL DEFAULT '',
  proxy_ip_id UUID REFERENCES ledger_proxy_ips(id) ON DELETE RESTRICT,
  adspower_profile_id TEXT,
  sim_asset_id UUID REFERENCES assets(id) ON DELETE SET NULL,
  device_asset_id UUID REFERENCES assets(id) ON DELETE SET NULL,
  lead_target_id UUID REFERENCES ledger_platform_accounts(id) ON DELETE SET NULL,
  account_status TEXT NOT NULL DEFAULT 'active',
  CHECK (account_role <> 'marketing_only' OR settlement_channel = 'no_settlement')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_unique_proxy_per_platform
  ON ledger_platform_accounts (proxy_ip_id, platform)
  WHERE proxy_ip_id IS NOT NULL AND account_status <> 'retired';

-- 8. 多通道资金流水、因公代扣、采购退券冲回与保证金全生命周期对账表
CREATE TABLE IF NOT EXISTS ledger_account_bills (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bill_date DATE NOT NULL,
  business_entity_id UUID NOT NULL REFERENCES business_entities(id) ON DELETE CASCADE,
  alipay_asset_id UUID NOT NULL REFERENCES ledger_alipay_profiles(alipay_asset_id) ON DELETE CASCADE,
  deducted_master_alipay_id UUID REFERENCES ledger_alipay_profiles(alipay_asset_id) ON DELETE SET NULL,
  related_platform_account_id UUID REFERENCES ledger_platform_accounts(id) ON DELETE SET NULL,
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
  amount_cents BIGINT NOT NULL,
  fee_cents BIGINT NOT NULL DEFAULT 0,
  oa_finance_voucher_no TEXT NOT NULL DEFAULT '',
  reconcile_status TEXT NOT NULL DEFAULT 'matched' CHECK (reconcile_status IN ('matched', 'pending', 'variance')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;

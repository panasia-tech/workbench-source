-- 046_shop_dispatch_capacity_policy_postgres.sql
-- 模块说明：店铺分组月度派单容量与负荷均衡一次性配置表（仅管理端可读写，销售端仅消费脱敏派单可用态）

CREATE TABLE IF NOT EXISTS shop_dispatch_capacity_policies (
    id                      VARCHAR(64) PRIMARY KEY,
    group_code              VARCHAR(64) NOT NULL UNIQUE,
    group_name              VARCHAR(128) NOT NULL,
    bound_shops_json        JSONB NOT NULL DEFAULT '[]'::jsonb,
    bound_shop_keys_json    JSONB NOT NULL DEFAULT '[]'::jsonb,
    soft_balance_cap_yuan   INTEGER NOT NULL DEFAULT 80000,
    hard_pause_cap_yuan     INTEGER NOT NULL DEFAULT 100000,
    current_month_used_yuan INTEGER NOT NULL DEFAULT 0,
    overflow_mode           VARCHAR(32) NOT NULL DEFAULT 'pause_new_listings',
    enabled                 BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by              VARCHAR(64) NOT NULL DEFAULT 'boss_init',
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes                   TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_shop_dispatch_capacity_enabled
    ON shop_dispatch_capacity_policies (enabled, group_code);

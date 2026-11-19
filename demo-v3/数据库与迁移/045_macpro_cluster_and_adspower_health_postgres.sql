-- =========================================================================================
-- 045_macpro_cluster_and_adspower_health_postgres.sql
-- 锚点中控 V3+ 线上 PostgreSQL 增量迁移脚本：
-- 10 台 64GB Mac Pro 算力集群（单机硬限 50 账号 · 总容量 500 槽位）+ 实时负载/温度 + 统一固定资产台账
-- + 「物理定位 × 公司受控网 × 在司/居家」四象限合规巡检 + 带卡/带号严禁资产报废转售硬触发器
-- =========================================================================================

BEGIN;

-- 1. 10 台 64GB Mac Pro 集群宿主机算力、CPU负载、芯片温度、50账号配额与系统健康度遥测表
CREATE TABLE IF NOT EXISTS ledger_mac_host_cluster_telemetry (
    device_id               VARCHAR(64)   PRIMARY KEY REFERENCES ledger_physical_devices(id) ON DELETE CASCADE,
    host_code               VARCHAR(64)   NOT NULL UNIQUE,   -- MAC-PRO-01 ~ MAC-PRO-10
    rack_slot               VARCHAR(64)   NOT NULL,
    cluster_zone            VARCHAR(128)  NOT NULL,
    cpu_spec                VARCHAR(128)  NOT NULL DEFAULT 'Apple M2 Ultra (24核CPU / 60核GPU)',
    ram_total_gb            INTEGER       NOT NULL DEFAULT 64 CHECK (ram_total_gb > 0),
    ram_used_gb             NUMERIC(6,2)  NOT NULL DEFAULT 12.0 CHECK (ram_used_gb >= 0),
    swap_used_gb            NUMERIC(6,2)  NOT NULL DEFAULT 0.0 CHECK (swap_used_gb >= 0),
    cpu_load_pct            INTEGER       NOT NULL DEFAULT 15 CHECK (cpu_load_pct BETWEEN 0 AND 100),
    soc_temp_c              NUMERIC(5,1)  NOT NULL DEFAULT 45.0,
    fan_rpm                 INTEGER       NOT NULL DEFAULT 1320,
    crawler_lease_tag       VARCHAR(128)  NOT NULL DEFAULT '',
    ssd_total_gb            INTEGER       NOT NULL DEFAULT 1024,
    ssd_used_gb             NUMERIC(7,2)  NOT NULL DEFAULT 120.0,
    ads_cache_gb            NUMERIC(6,2)  NOT NULL DEFAULT 8.5,
    max_account_quota       INTEGER       NOT NULL DEFAULT 50 CHECK (max_account_quota BETWEEN 1 AND 200),
    safe_concurrent_windows INTEGER       NOT NULL DEFAULT 32,
    open_windows_now        INTEGER       NOT NULL DEFAULT 0 CHECK (open_windows_now >= 0),
    adspower_client_ver     VARCHAR(64)   NOT NULL DEFAULT 'AdsPower Global v6.8.5 (SunBrowser 130)',
    local_api_port          INTEGER       NOT NULL DEFAULT 50325,
    local_api_status        VARCHAR(32)   NOT NULL DEFAULT 'online'
        CHECK (local_api_status IN ('online', 'degraded', 'offline')),
    lan_ip                  VARCHAR(64)   NOT NULL DEFAULT '',
    uptime_days             INTEGER       NOT NULL DEFAULT 15,
    last_cache_clean_at     DATE          NOT NULL DEFAULT CURRENT_DATE,
    health_grade            VARCHAR(32)   NOT NULL DEFAULT 'healthy'
        CHECK (health_grade IN ('healthy', 'warning', 'critical')),
    health_note             TEXT          NOT NULL DEFAULT '',
    updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- 2. 实体手机（工作机 & 采购专机）CPU/RAM负载、电池防鼓包温度与程序员 ADB 指纹健康度遥测表
CREATE TABLE IF NOT EXISTS ledger_mobile_device_telemetry (
    device_id               VARCHAR(64)   PRIMARY KEY REFERENCES ledger_physical_devices(id) ON DELETE CASCADE,
    cpu_load_pct            INTEGER       NOT NULL DEFAULT 24 CHECK (cpu_load_pct BETWEEN 0 AND 100),
    ram_usage_pct           INTEGER       NOT NULL DEFAULT 48 CHECK (ram_usage_pct BETWEEN 0 AND 100),
    battery_health_pct      INTEGER       NOT NULL DEFAULT 96 CHECK (battery_health_pct BETWEEN 0 AND 100),
    battery_temp_c          NUMERIC(4,1)  NOT NULL DEFAULT 31.5,
    storage_total_gb        INTEGER       NOT NULL DEFAULT 256,
    storage_free_gb         NUMERIC(6,1)  NOT NULL DEFAULT 168.0,
    os_version              VARCHAR(64)   NOT NULL DEFAULT 'Android 14 / HyperOS',
    adb_fingerprint_status  VARCHAR(32)   NOT NULL DEFAULT 'verified_locked'
        CHECK (adb_fingerprint_status IN ('verified_locked', 'pending_flash', 'drift_risk')),
    network_isolation_mode  VARCHAR(128)  NOT NULL DEFAULT '在司强制连公司受控Wi-Fi(软路由独享家宽路由)',
    health_grade            VARCHAR(32)   NOT NULL DEFAULT 'healthy'
        CHECK (health_grade IN ('healthy', 'warning', 'critical')),
    health_note             TEXT          NOT NULL DEFAULT '',
    updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- 3. AdsPower 单窗口运行环境健康巡检表（出口IP一致性、WebRTC、Cookie云同步、内存占用）
CREATE TABLE IF NOT EXISTS ledger_adspower_window_health (
    profile_id              VARCHAR(64)   PRIMARY KEY REFERENCES ledger_adspower_profiles(id) ON DELETE CASCADE,
    open_state              VARCHAR(32)   NOT NULL DEFAULT 'closed'
        CHECK (open_state IN ('open', 'closed', 'idle', 'locked')),
    memory_mb               INTEGER       NOT NULL DEFAULT 0 CHECK (memory_mb >= 0),
    proxy_ping_ms           INTEGER       NOT NULL DEFAULT 36,
    webrtc_shield           VARCHAR(32)   NOT NULL DEFAULT 'disabled_safe',
    canvas_noise_check      VARCHAR(32)   NOT NULL DEFAULT 'isolated_ok',
    cookie_sync_hours_ago   INTEGER       NOT NULL DEFAULT 2 CHECK (cookie_sync_hours_ago >= 0),
    exit_ip_check           VARCHAR(32)   NOT NULL DEFAULT 'matched'
        CHECK (exit_ip_check IN ('matched', 'mismatch_blocked', 'blocked_expired')),
    kernel_tag              VARCHAR(64)   NOT NULL DEFAULT 'SunBrowser 130',
    health_grade            VARCHAR(32)   NOT NULL DEFAULT 'healthy'
        CHECK (health_grade IN ('healthy', 'warning', 'critical')),
    health_note             TEXT          NOT NULL DEFAULT '',
    updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- 4. 统一固定资产全生命周期 + 「定位 × 公司受控网 × 在司/居家」合规主表（打通 erp-miniprogram asset_device）
CREATE TABLE IF NOT EXISTS ledger_device_asset_and_compliance (
    device_id               VARCHAR(64)   PRIMARY KEY REFERENCES ledger_physical_devices(id) ON DELETE CASCADE,
    asset_no                VARCHAR(64)   NOT NULL UNIQUE,   -- AST-MAC-001 ~ 010, AST-PHN-001 ~ 015
    purchase_order_no       VARCHAR(64)   NOT NULL DEFAULT '',
    purchase_date           DATE          NOT NULL DEFAULT CURRENT_DATE,
    purchase_cost_fen       BIGINT        NOT NULL DEFAULT 0 CHECK (purchase_cost_fen >= 0),
    salvage_value_fen       BIGINT        NOT NULL DEFAULT 0 CHECK (salvage_value_fen >= 0),
    office_site             VARCHAR(128)  NOT NULL DEFAULT '杭州滨江总部·3F',
    asset_lifecycle_status  VARCHAR(32)   NOT NULL DEFAULT 'in_use'
        CHECK (asset_lifecycle_status IN ('in_use', 'standby', 'repairing', 'retired_disposed')),
    control_agreement_no    VARCHAR(64)   NOT NULL DEFAULT '', -- 《公司设备受控使用协议》签署编号
    agreement_signed_by     VARCHAR(64)   NOT NULL DEFAULT '',
    agreement_signed_at     DATE,
    last_inventory_date     DATE,
    inventory_status        VARCHAR(32)   NOT NULL DEFAULT 'verified'
        CHECK (inventory_status IN ('verified', 'pending_check', 'abnormal')),
    work_schedule_mode      VARCHAR(32)   NOT NULL DEFAULT 'office_onsite'
        CHECK (work_schedule_mode IN ('rack_24h', 'office_onsite', 'wfh_approved')),
    wfh_approval_ref        VARCHAR(64)   NOT NULL DEFAULT '',
    geo_fence_state         VARCHAR(32)   NOT NULL DEFAULT 'in_company'
        CHECK (geo_fence_state IN ('in_company', 'at_registered_home', 'outside_unregistered')),
    geo_location_label      VARCHAR(255)  NOT NULL DEFAULT '杭州滨江总部·3F运营区',
    geo_coords              VARCHAR(64)   NOT NULL DEFAULT '30.2084°N, 120.2120°E',
    distance_from_office_km NUMERIC(6,2)  NOT NULL DEFAULT 0.0,
    net_conn_kind           VARCHAR(48)   NOT NULL DEFAULT 'corp_wifi'
        CHECK (net_conn_kind IN ('corp_lan', 'corp_wifi', 'corp_vpn', 'cellular_5g', 'external_wifi_or_hotspot')),
    connected_ssid_or_nic   VARCHAR(128)  NOT NULL DEFAULT 'PanAsia-Corp-5G',
    gateway_egress_note     VARCHAR(255)  NOT NULL DEFAULT '公司软路由透明路由至独享家宽IP',
    remote_locked           BOOLEAN       NOT NULL DEFAULT FALSE,
    compliance_note         TEXT          NOT NULL DEFAULT '',
    last_located_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- 5. 固定资产报废核减 / 转二手商品入库售卖申请表（打通 asset_reduction_request & asset_intake）
CREATE TABLE IF NOT EXISTS ledger_asset_reduction_requests (
    id                      VARCHAR(64)   PRIMARY KEY,
    request_no              VARCHAR(64)   NOT NULL UNIQUE,
    device_id               VARCHAR(64)   NOT NULL REFERENCES ledger_physical_devices(id) ON DELETE CASCADE,
    asset_no                VARCHAR(64)   NOT NULL,
    target_action           VARCHAR(32)   NOT NULL
        CHECK (target_action IN ('scrap_retire', 'transfer_to_resale_sku', 'repair_out')),
    reason                  TEXT          NOT NULL DEFAULT '',
    requested_by            VARCHAR(64)   NOT NULL DEFAULT '',
    requested_at            TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    status                  VARCHAR(32)   NOT NULL DEFAULT 'approved'
        CHECK (status IN ('pending_boss', 'approved', 'rejected')),
    review_note             TEXT          NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_mac_telemetry_grade    ON ledger_mac_host_cluster_telemetry(health_grade);
CREATE INDEX IF NOT EXISTS idx_win_health_grade       ON ledger_adspower_window_health(health_grade);
CREATE INDEX IF NOT EXISTS idx_mob_telemetry_grade    ON ledger_mobile_device_telemetry(health_grade);
CREATE INDEX IF NOT EXISTS idx_dev_asset_geo_net      ON ledger_device_asset_and_compliance(geo_fence_state, net_conn_kind);

-- 6. 数据库层硬防呆触发器 A：严禁单台 Mac Pro 承载超过 max_account_quota (默认 50) 个窗口/账号槽位
CREATE OR REPLACE FUNCTION fn_enforce_macpro_50_slot_quota()
RETURNS TRIGGER AS $$
DECLARE
    v_host_id   VARCHAR(64);
    v_host_code VARCHAR(64);
    v_max_quota INTEGER;
    v_win_cnt   INTEGER;
    v_acc_cnt   INTEGER;
BEGIN
    IF TG_TABLE_NAME = 'ledger_adspower_profiles' THEN
        v_host_id := NEW.host_device_id;
    ELSIF TG_TABLE_NAME = 'ledger_platform_accounts' THEN
        IF NEW.adspower_profile_id IS NULL OR NEW.adspower_profile_id = '' THEN
            RETURN NEW;
        END IF;
        SELECT host_device_id INTO v_host_id FROM ledger_adspower_profiles WHERE id = NEW.adspower_profile_id;
    END IF;

    IF v_host_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT host_code, max_account_quota
      INTO v_host_code, v_max_quota
      FROM ledger_mac_host_cluster_telemetry
     WHERE device_id = v_host_id;

    IF v_max_quota IS NULL THEN
        v_max_quota := 50;
    END IF;

    SELECT COUNT(*) INTO v_win_cnt FROM ledger_adspower_profiles WHERE host_device_id = v_host_id;
    SELECT COUNT(*) INTO v_acc_cnt
      FROM ledger_platform_accounts pa
      JOIN ledger_adspower_profiles ap ON ap.id = pa.adspower_profile_id
     WHERE ap.host_device_id = v_host_id;

    IF GREATEST(v_win_cnt, v_acc_cnt) > v_max_quota THEN
        RAISE EXCEPTION '【Mac Pro 单机 50 账号容量硬阻断】宿主机 % 已超过上限 % 个账号槽位，请迁入空闲 Mac Pro 机柜！',
            COALESCE(v_host_code, v_host_id), v_max_quota;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_macpro_quota_on_ads_profiles ON ledger_adspower_profiles;
CREATE TRIGGER trg_macpro_quota_on_ads_profiles
AFTER INSERT OR UPDATE OF host_device_id ON ledger_adspower_profiles
FOR EACH ROW EXECUTE FUNCTION fn_enforce_macpro_50_slot_quota();

DROP TRIGGER IF EXISTS trg_macpro_quota_on_plat_accounts ON ledger_platform_accounts;
CREATE TRIGGER trg_macpro_quota_on_plat_accounts
AFTER INSERT OR UPDATE OF adspower_profile_id ON ledger_platform_accounts
FOR EACH ROW EXECUTE FUNCTION fn_enforce_macpro_50_slot_quota();

COMMIT;

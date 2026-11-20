#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
锚点中控 V3+ · 统一固定资产台账 + 10台 64GB Mac Pro (50账号/台 = 500槽位) 集群 + 负载/温度 + 「定位 × 公司受控网 × 在司/居家」合规引擎
核心业务规则：
1. 硬件与固定资产三账合一：25 台公司受控设备（10 台 64GB Mac Pro + 15 部业务手机）统一绑定固定资产编码 (AST-*)、采购单号、采购原值、盘点状态及《公司受控设备使用知情协议》（全员签字知情定位与网络管控）；
2. 单机 50 账号硬配额：单台 64GB Mac Pro 最大挂载上限 = 50 个业务账号（总容量 500 槽位），超限 HTTP 400 + PG 触发器硬阻断；
3. 实时负载与温度监控：
   - Mac Pro：24核 CPU 负载率(%)、M2 Ultra 芯片温度(℃)与风扇转速(RPM)、64GB 内存/Swap 水位、行情/图片爬虫租约持有状态；
   - 业务手机：CPU/内存负载率(%)、机身/电池温度(℃)与电池健康度(%)（≥40℃ 或 <78% 红灯防鼓包）、程序员 ADB 自研设备指纹锁死状态；
4. 「定位 × 公司受控网 × 坐班/居家」四象限实时合规引擎（上班时间硬红线）：
   - 🟢 在司合规 (compliant_office)：定位在公司围栏内 + 已连接公司千兆有线内网或公司受控业务 Wi-Fi (PanAsia-Corp-5G / PanAsia-Procure-VLAN)；
   - 🔵 报备居家合规 (compliant_wfh)：OA 已批居家办公 + 定位在员工报备住址 + 已拨通公司加密 VPN 受控隧道；
   - 🔴 在司未连公司网违规 (violation_office_no_corp_net)：定位在公司围栏内，却断开公司网使用 4G/5G 流量或个人热点（防逃避公司网关审计与路由策略）；
   - 🚨 未报备离司/假坐班真居家违规 (violation_unapproved_offsite)：正常坐班日（无居家审批），上班时间设备定位离开公司围栏！
5. 资产核减/报废/转二手售卖防泄密硬阻断：只要设备仍插有在用 SIM 卡、挂载 AdsPower 窗口或关联在用平台店铺账号，硬阻断报废核减与转售入库。
"""

from __future__ import annotations
import datetime as dt
import sqlite3


CLUSTER_HEALTH_DDL = """
-- 1. 10 台 64GB Mac Pro 宿主机集群容量配额、算力负载与芯片温度表
CREATE TABLE IF NOT EXISTS mac_host_cluster_telemetry (
    device_id TEXT PRIMARY KEY REFERENCES physical_devices(id) ON DELETE CASCADE,
    host_code TEXT NOT NULL UNIQUE,
    rack_slot TEXT NOT NULL DEFAULT '',
    cluster_zone TEXT NOT NULL DEFAULT '销售主力集群',
    cpu_spec TEXT NOT NULL DEFAULT 'Apple M2 Ultra (24核CPU / 60核GPU)',
    ram_total_gb INTEGER NOT NULL DEFAULT 64,
    max_account_quota INTEGER NOT NULL DEFAULT 50 CHECK (max_account_quota > 0 AND max_account_quota <= 200),
    safe_concurrent_windows INTEGER NOT NULL DEFAULT 32,
    open_windows_now INTEGER NOT NULL DEFAULT 0,
    ram_used_gb REAL NOT NULL DEFAULT 12.0,
    swap_used_gb REAL NOT NULL DEFAULT 0.0,
    cpu_load_pct INTEGER NOT NULL DEFAULT 15,
    soc_temp_c REAL NOT NULL DEFAULT 45.0,
    fan_rpm INTEGER NOT NULL DEFAULT 1320,
    crawler_lease_tag TEXT NOT NULL DEFAULT '',
    ssd_total_gb INTEGER NOT NULL DEFAULT 1024,
    ssd_used_gb INTEGER NOT NULL DEFAULT 180,
    ads_cache_gb REAL NOT NULL DEFAULT 12.5,
    lan_ip TEXT NOT NULL DEFAULT '',
    adspower_client_ver TEXT NOT NULL DEFAULT 'AdsPower Global v6.8.5 (macOS arm64)',
    sunbrowser_kernel TEXT NOT NULL DEFAULT 'SunBrowser 130.0.6723',
    local_api_port INTEGER NOT NULL DEFAULT 50325,
    local_api_status TEXT NOT NULL DEFAULT 'online' CHECK (local_api_status IN ('online', 'degraded', 'offline')),
    uptime_days INTEGER NOT NULL DEFAULT 5,
    last_heartbeat_at TEXT NOT NULL DEFAULT '2026-11-18 14:35:00',
    health_grade TEXT NOT NULL DEFAULT 'healthy' CHECK (health_grade IN ('healthy', 'warning', 'critical')),
    health_note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 2. 实体手机终端负载、电池温度与自研 ADB 指纹状态巡检表
CREATE TABLE IF NOT EXISTS mobile_device_telemetry (
    device_id TEXT PRIMARY KEY REFERENCES physical_devices(id) ON DELETE CASCADE,
    cpu_load_pct INTEGER NOT NULL DEFAULT 24,
    ram_usage_pct INTEGER NOT NULL DEFAULT 48,
    battery_health_pct INTEGER NOT NULL DEFAULT 92,
    battery_temp_c REAL NOT NULL DEFAULT 33.5,
    always_plugged_risk INTEGER NOT NULL DEFAULT 0 CHECK (always_plugged_risk IN (0, 1)),
    storage_total_gb INTEGER NOT NULL DEFAULT 256,
    storage_free_gb INTEGER NOT NULL DEFAULT 168,
    os_version TEXT NOT NULL DEFAULT 'Android 14 / HyperOS',
    adb_fingerprint_status TEXT NOT NULL DEFAULT 'verified_locked'
        CHECK (adb_fingerprint_status IN ('verified_locked', 'pending_flash', 'tamper_alert')),
    network_isolation_mode TEXT NOT NULL DEFAULT '在司强制连公司受控Wi-Fi(软路由独享家宽路由)',
    last_heartbeat_at TEXT NOT NULL DEFAULT '2026-11-18 14:35:00',
    health_grade TEXT NOT NULL DEFAULT 'healthy' CHECK (health_grade IN ('healthy', 'warning', 'critical')),
    health_note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 3. AdsPower 指纹浏览器窗口级健康度表
CREATE TABLE IF NOT EXISTS adspower_window_health (
    profile_id TEXT PRIMARY KEY REFERENCES adspower_profiles(id) ON DELETE CASCADE,
    proxy_ping_ms INTEGER NOT NULL DEFAULT 28,
    exit_ip_check TEXT NOT NULL DEFAULT 'matched'
        CHECK (exit_ip_check IN ('matched', 'drifted', 'blocked_expired')),
    webrtc_leak_status TEXT NOT NULL DEFAULT 'safe' CHECK (webrtc_leak_status IN ('safe', 'risk')),
    cookie_sync_hours_ago INTEGER NOT NULL DEFAULT 6,
    open_state TEXT NOT NULL DEFAULT 'idle' CHECK (open_state IN ('open', 'idle', 'locked')),
    memory_mb INTEGER NOT NULL DEFAULT 0,
    kernel_tag TEXT NOT NULL DEFAULT 'SunBrowser 130 · 指纹已锁',
    health_grade TEXT NOT NULL DEFAULT 'healthy' CHECK (health_grade IN ('healthy', 'warning', 'critical')),
    health_note TEXT NOT NULL DEFAULT '',
    last_checked_at TEXT NOT NULL DEFAULT '2026-11-18 14:35:00'
);

-- 4. 统一固定资产全生命周期 + 实时物理定位 × 公司受控网合规表（对齐 erp-miniprogram asset_device）
CREATE TABLE IF NOT EXISTS device_asset_and_compliance (
    device_id TEXT PRIMARY KEY REFERENCES physical_devices(id) ON DELETE CASCADE,
    asset_no TEXT NOT NULL UNIQUE,
    purchase_order_no TEXT NOT NULL DEFAULT '',
    purchase_date TEXT NOT NULL DEFAULT '2026-08-18',
    purchase_cost_fen INTEGER NOT NULL DEFAULT 0,
    salvage_value_fen INTEGER NOT NULL DEFAULT 0,
    office_site TEXT NOT NULL DEFAULT '杭州滨江总部·3F',
    asset_lifecycle_status TEXT NOT NULL DEFAULT 'in_use'
        CHECK (asset_lifecycle_status IN ('in_use', 'standby', 'repairing', 'retired_disposed')),
    control_agreement_no TEXT NOT NULL DEFAULT '',
    agreement_signed_by TEXT NOT NULL DEFAULT '',
    agreement_signed_at TEXT NOT NULL DEFAULT '2026-09-01',
    last_inventory_date TEXT NOT NULL DEFAULT '2026-11-01',
    inventory_status TEXT NOT NULL DEFAULT 'verified'
        CHECK (inventory_status IN ('verified', 'pending_check', 'abnormal')),
    work_schedule_mode TEXT NOT NULL DEFAULT 'office_onsite'
        CHECK (work_schedule_mode IN ('rack_24h', 'office_onsite', 'wfh_approved')),
    wfh_approval_ref TEXT NOT NULL DEFAULT '',
    geo_fence_state TEXT NOT NULL DEFAULT 'in_company'
        CHECK (geo_fence_state IN ('in_company', 'at_registered_home', 'outside_unregistered')),
    geo_location_label TEXT NOT NULL DEFAULT '杭州滨江总部·3F运营区',
    geo_coords TEXT NOT NULL DEFAULT '30.2084°N, 120.2120°E',
    distance_from_office_km REAL NOT NULL DEFAULT 0.0,
    net_conn_kind TEXT NOT NULL DEFAULT 'corp_wifi'
        CHECK (net_conn_kind IN ('corp_lan', 'corp_wifi', 'corp_vpn', 'cellular_5g', 'external_wifi_or_hotspot')),
    connected_ssid_or_nic TEXT NOT NULL DEFAULT 'PanAsia-Corp-5G',
    gateway_egress_note TEXT NOT NULL DEFAULT '公司软路由透明路由至独享家宽IP',
    remote_locked INTEGER NOT NULL DEFAULT 0 CHECK (remote_locked IN (0, 1)),
    compliance_note TEXT NOT NULL DEFAULT '',
    last_located_at TEXT NOT NULL DEFAULT '2026-11-18 14:35:00',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- 5. 固定资产核减 / 报废 / 转二手入库申请表（对齐 asset_reduction_request & asset_intake）
CREATE TABLE IF NOT EXISTS asset_reduction_requests (
    id TEXT PRIMARY KEY,
    request_no TEXT NOT NULL UNIQUE,
    device_id TEXT NOT NULL REFERENCES physical_devices(id) ON DELETE CASCADE,
    asset_no TEXT NOT NULL,
    target_action TEXT NOT NULL CHECK (target_action IN ('scrap_retire', 'transfer_to_resale_sku', 'repair_out')),
    reason TEXT NOT NULL DEFAULT '',
    requested_by TEXT NOT NULL DEFAULT '',
    requested_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('pending_boss', 'approved', 'rejected')),
    review_note TEXT NOT NULL DEFAULT ''
);
"""


def _ensure_column(conn: sqlite3.Connection, table: str, col: str, col_def: str) -> None:
    existing = {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if col not in existing:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {col_def}")


def compute_loc_net_compliance(row: dict) -> tuple[str, str, str]:
    """
    根据「物理定位围栏 × 当前网络连接类型 × 今日坐班/居家排班」交叉计算合规象限：
    返回 (code, badge_label, level: 'green'|'blue'|'red'|'amber')
    """
    geo = row.get("geo_fence_state") or "in_company"
    net = row.get("net_conn_kind") or "corp_wifi"
    mode = row.get("work_schedule_mode") or "office_onsite"

    if geo == "in_company":
        if net in ("corp_lan", "corp_wifi"):
            return ("compliant_office", "🟢 在司 · 已连公司网", "green")
        return ("violation_office_no_corp_net", "🔴 违规：在公司未连公司网", "red")

    # 设备不在公司围栏内
    if mode == "wfh_approved":
        if net in ("corp_vpn", "corp_lan", "corp_wifi"):
            return ("compliant_wfh", "🔵 报备居家 · 已连公司VPN", "blue")
        return ("violation_wfh_no_vpn", "🟠 居家未拨公司VPN", "amber")

    return ("violation_unapproved_offsite", "🚨 违规：未报备离司/异地", "red")


def ensure_cluster_and_health_seeded(conn: sqlite3.Connection) -> None:
    conn.executescript(CLUSTER_HEALTH_DDL)
    # 兼容平滑升级补列
    _ensure_column(conn, "mac_host_cluster_telemetry", "soc_temp_c", "REAL NOT NULL DEFAULT 45.0")
    _ensure_column(conn, "mac_host_cluster_telemetry", "fan_rpm", "INTEGER NOT NULL DEFAULT 1320")
    _ensure_column(conn, "mac_host_cluster_telemetry", "crawler_lease_tag", "TEXT NOT NULL DEFAULT ''")
    _ensure_column(conn, "mobile_device_telemetry", "cpu_load_pct", "INTEGER NOT NULL DEFAULT 24")
    _ensure_column(conn, "mobile_device_telemetry", "ram_usage_pct", "INTEGER NOT NULL DEFAULT 48")

    cur = conn.cursor()

    already_mac = cur.execute("SELECT COUNT(*) FROM mac_host_cluster_telemetry").fetchone()[0]
    if already_mac < 10:
        # 1. 将原有 dev-pc-01 / dev-pc-02 升级为统一的 64GB Mac Pro 标准集群命名，并补齐 dev-pc-03 ~ dev-pc-10（共 10 台 64GB Mac Pro！）
        cur.execute(
            """UPDATE physical_devices
               SET device_code = 'MAC-PRO-01',
                   brand_model = 'Apple Mac Pro (M2 Ultra · 64GB 统一内存 / 1TB)',
                   workstation_loc = 'A区中控机柜-U01',
                   custodian_staff = '陈晓雯',
                   notes = '【1号销售主力机 · 配额50号】承载林建国主体1~2主力闲鱼与小店窗口'
               WHERE id = 'dev-pc-01'"""
        )
        cur.execute(
            """UPDATE physical_devices
               SET device_code = 'MAC-PRO-02',
                   brand_model = 'Apple Mac Pro (M2 Ultra · 64GB 统一内存 / 1TB)',
                   workstation_loc = 'B区采购隔离机柜-U02',
                   custodian_staff = '李航',
                   notes = '【2号采购买券隔离专机 · 配额50号】专跑大众点评/抖省省/淘采/京采/闲鱼买货窗，与销售机物理隔离'
               WHERE id = 'dev-pc-02'"""
        )

        extra_mac_pros = [
            ("dev-pc-03", "lp-ljg", "MAC-PRO-03", "adspower_pc_host", "Apple Mac Pro (M2 Ultra · 64GB 统一内存 / 1TB)", "C02MP64G0003", "", "", "host_cluster", None, None, "A区中控机柜-U03", "林婷", "AdsPower Enterprise v6.8.5, Local API :50325", "active", "【3号销售主力机 · 内存与高温预警】承载林建国主体3~4闲鱼与京东/小红书店窗"),
            ("dev-pc-04", "lp-ljg", "MAC-PRO-04", "adspower_pc_host", "Apple Mac Pro (M2 Ultra · 64GB 统一内存 / 1TB)", "C02MP64G0004", "", "", "host_cluster", None, None, "C区社媒机柜-U04", "陈晓雯", "AdsPower Enterprise v6.8.5, 社媒素材助手", "active", "【4号社媒种草隔离专机 · 配额50号】专跑小红书种草号与私域引流窗口，防连坐店铺"),
            ("dev-pc-05", "lp-wyq", "MAC-PRO-05", "adspower_pc_host", "Apple Mac Pro (M2 Ultra · 64GB 统一内存 / 1TB)", "C02MP64G0005", "", "", "host_cluster", None, None, "A区中控机柜-U05", "赵宇", "AdsPower Enterprise v6.8.5, Local API :50325", "active", "【5号二号客户托管专机 · 配额50号】承接王雅琴等签约委托客户受托店铺窗口"),
            ("dev-pc-06", "lp-ljg", "MAC-PRO-06", "adspower_pc_host", "Apple Mac Pro (M2 Ultra · 64GB 统一内存 / 1TB)", "C02MP64G0006", "", "", "host_cluster", None, None, "A区中控机柜-U06", "赵宇", "AdsPower Enterprise v6.8.5, 抖店/微信小店后台", "active", "【6号多平台小店专机 · 配额50号】承接抖店、淘宝企业店与新增微信小店独立环境"),
            ("dev-pc-07", None, "MAC-PRO-07", "adspower_pc_host", "Apple Mac Pro (M2 Ultra · 64GB 统一内存 / 1TB)", "C02MP64G0007", "", "", "host_cluster", None, None, "D区托管预备机柜-U07", "周安", "AdsPower Enterprise v6.8.5, Local API :50325", "active", "【7号新签客户托管预备机 · 50槽空余待派】已装妥安全隔离环境待新签约客户店铺迁入"),
            ("dev-pc-08", None, "MAC-PRO-08", "adspower_pc_host", "Apple Mac Pro (M2 Ultra · 64GB 统一内存 / 1TB)", "C02MP64G0008", "", "", "host_cluster", None, None, "D区托管预备机柜-U08", "周安", "AdsPower Enterprise v6.8.5, Local API :50325", "active", "【8号新签客户托管预备机 · 50槽空余待派】"),
            ("dev-pc-09", None, "MAC-PRO-09", "adspower_pc_host", "Apple Mac Pro (M2 Ultra · 64GB 统一内存 / 1TB)", "C02MP64G0009", "", "", "host_cluster", None, None, "D区托管预备机柜-U09", "周安", "AdsPower Enterprise v6.8.5, Local API :50325", "active", "【9号新签客户托管预备机 · 50槽空余待派】"),
            ("dev-pc-10", None, "MAC-PRO-10", "adspower_pc_host", "Apple Mac Pro (M2 Ultra · 64GB 统一内存 / 1TB)", "C02MP64G0010", "", "", "host_cluster", None, None, "D区热备机柜-U10", "周安", "AdsPower Enterprise v6.8.5 (待启动守护进程)", "maintenance", "【10号灾备热备机 · Local API待唤醒】用于单机故障时5分钟接管云同步窗口"),
        ]
        cur.executemany(
            """INSERT OR IGNORE INTO physical_devices
               (id, legal_person_id, device_code, device_kind, brand_model, serial_number, imei_1, imei_2,
                role_isolation, sim_slot_1_id, sim_slot_2_id, workstation_loc, custodian_staff, installed_apps, device_status, notes)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            extra_mac_pros,
        )

        # 2. 将现有 AdsPower 窗口按物理隔离分配到 MAC-PRO-01 ~ MAC-PRO-06
        cur.execute("UPDATE adspower_profiles SET host_device_id = 'dev-pc-03' WHERE id IN ('ads-09', 'ads-10', 'ads-11', 'ads-12', 'ads-13', 'ads-14')")
        cur.execute("UPDATE adspower_profiles SET host_device_id = 'dev-pc-04' WHERE id IN ('ads-15', 'ads-16')")
        cur.execute("UPDATE adspower_profiles SET host_device_id = 'dev-pc-05' WHERE id IN ('ads-19')")
        cur.execute("UPDATE adspower_profiles SET host_device_id = 'dev-pc-06' WHERE id IN ('ads-05', 'ads-06')")

        cur.execute(
            """INSERT OR IGNORE INTO adspower_profiles
               (id, profile_code, ads_serial_no, ads_user_id, window_name, group_name, host_device_id,
                proxy_ip_id, role_isolation, fingerprint_locked, cookie_backup_at, profile_status, notes)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                "ads-20", "ADS-020", "402", "w2n5y02", "山屿优选-闲鱼2店窗[建店中]", "宁波二号委托客户组",
                "dev-pc-05", "px-17", "sales_only", 1, "2026-11-16 18:00", "active",
                "部署在 MAC-PRO-05 客户托管专机，绑定独享家宽 IP-NB-17"
            ),
        )
        cur.execute("UPDATE platform_accounts SET adspower_profile_id = 'ads-20' WHERE id = 'pa-wyq-xy02' AND adspower_profile_id IS NULL")

        # 3. 写入 10 台 64GB Mac Pro 算力、CPU负载、芯片温度与风扇转速遥测
        mac_telemetry = [
            ("dev-pc-01", "MAC-PRO-01", "A区机柜-U01", "销售主力集群(主体1~2)", "Apple M2 Ultra (24核)", 64, 50, 32, 6, 26.4, 0.0, 28, 46.2, 1380, "", 1024, 310, 24.5, "10.10.20.101", "v6.8.5", "SunBrowser 130", 50325, "online", 9, "2026-11-18 14:35:00", "healthy", "64GB内存余量充沛，芯片温度 46.2℃，公司千兆有线内网在线"),
            ("dev-pc-02", "MAC-PRO-02", "B区机柜-U02", "采购买券物理隔离机", "Apple M2 Ultra (24核)", 64, 50, 32, 2, 18.2, 0.0, 31, 48.5, 1420, "行情爬虫租约持有(market)", 1024, 215, 14.2, "10.10.20.102", "v6.8.5", "SunBrowser 130", 50325, "online", 12, "2026-11-18 14:35:00", "healthy", "采购专窗独立运行并持有行情爬虫租约，与销售店铺物理零交集"),
            ("dev-pc-03", "MAC-PRO-03", "A区机柜-U03", "销售主力集群(主体3~4)", "Apple M2 Ultra (24核)", 64, 50, 32, 5, 57.6, 6.2, 88, 76.8, 2890, "", 1024, 790, 148.6, "10.10.20.103", "v6.8.4", "SunBrowser 130", 50325, "online", 29, "2026-11-18 14:35:00", "critical", "🚨 CPU负载 88% · 芯片温度 76.8℃ · 64GB内存已占 57.6GB (90%) 且触发 6.2GB Swap！连续29天未清历史缓存(148.6GB)，请立即点击『一键释放缓存降温降载』！"),
            ("dev-pc-04", "MAC-PRO-04", "C区机柜-U04", "社媒种草导流隔离机", "Apple M2 Ultra (24核)", 64, 50, 32, 2, 19.5, 0.0, 21, 44.0, 1310, "", 1024, 240, 18.0, "10.10.20.104", "v6.8.5", "SunBrowser 130", 50325, "online", 7, "2026-11-18 14:35:00", "healthy", "小红书种草窗口环境纯净，温度与负载正常"),
            ("dev-pc-05", "MAC-PRO-05", "A区机柜-U05", "二号客户托管专机", "Apple M2 Ultra (24核)", 64, 50, 32, 2, 17.8, 0.0, 16, 43.2, 1290, "", 1024, 190, 11.4, "10.10.20.105", "v6.8.5", "SunBrowser 130", 50325, "online", 4, "2026-11-18 14:35:00", "healthy", "承载王雅琴新开店铺窗口，槽位余量充足"),
            ("dev-pc-06", "MAC-PRO-06", "A区机柜-U06", "综合电商(淘/抖/微店)专机", "Apple M2 Ultra (24核)", 64, 50, 32, 2, 24.1, 0.0, 24, 45.6, 1350, "", 1024, 265, 21.8, "10.10.20.106", "v6.8.5", "SunBrowser 130", 50325, "online", 11, "2026-11-18 14:35:00", "healthy", "承载淘宝企业店与抖店复合窗口，运行平稳"),
            ("dev-pc-07", "MAC-PRO-07", "D区机柜-U07", "新签客户托管预备集群", "Apple M2 Ultra (24核)", 64, 50, 32, 0, 9.4, 0.0, 6, 38.5, 1180, "", 1024, 120, 2.1, "10.10.20.107", "v6.8.5", "SunBrowser 130", 50325, "online", 3, "2026-11-18 14:35:00", "healthy", "50/50 账号槽位全空待命，随时承接新签约客户 50 店受托入驻"),
            ("dev-pc-08", "MAC-PRO-08", "D区机柜-U08", "新签客户托管预备集群", "Apple M2 Ultra (24核)", 64, 50, 32, 0, 9.1, 0.0, 5, 38.1, 1180, "", 1024, 118, 2.0, "10.10.20.108", "v6.8.5", "SunBrowser 130", 50325, "online", 3, "2026-11-18 14:35:00", "healthy", "50/50 账号槽位全空待命"),
            ("dev-pc-09", "MAC-PRO-09", "D区机柜-U09", "新签客户托管预备集群", "Apple M2 Ultra (24核)", 64, 50, 32, 0, 9.2, 0.0, 5, 38.3, 1180, "", 1024, 119, 2.0, "10.10.20.109", "v6.8.5", "SunBrowser 130", 50325, "online", 3, "2026-11-18 14:35:00", "healthy", "50/50 账号槽位全空待命"),
            ("dev-pc-10", "MAC-PRO-10", "D区机柜-U10", "热备接管与灾备专机", "Apple M2 Ultra (24核)", 64, 50, 32, 0, 8.6, 0.0, 4, 37.8, 1160, "", 1024, 115, 1.8, "10.10.20.110", "v6.8.5", "SunBrowser 130", 50325, "degraded", 1, "2026-11-18 14:10:00", "warning", "⚠️ 热备机在司有线内网在线，但 AdsPower Local API (:50325) 守护服务未开启，建议一键唤醒保持热备就绪"),
        ]
        cur.executemany(
            """INSERT OR REPLACE INTO mac_host_cluster_telemetry
               (device_id, host_code, rack_slot, cluster_zone, cpu_spec, ram_total_gb, max_account_quota,
                safe_concurrent_windows, open_windows_now, ram_used_gb, swap_used_gb, cpu_load_pct,
                soc_temp_c, fan_rpm, crawler_lease_tag,
                ssd_total_gb, ssd_used_gb, ads_cache_gb, lan_ip, adspower_client_ver, sunbrowser_kernel,
                local_api_port, local_api_status, uptime_days, last_heartbeat_at, health_grade, health_note)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            mac_telemetry,
        )

    # 4. 补齐所有新增或既有的 Mac Pro / 实体手机遥测与 AdsPower 窗口遥测
    all_pcs = cur.execute("SELECT id, device_code FROM physical_devices WHERE device_kind = 'adspower_pc_host'").fetchall()
    for pid, pcode in all_pcs:
        exists_m = cur.execute("SELECT 1 FROM mac_host_cluster_telemetry WHERE device_id = ?", (pid,)).fetchone()
        if not exists_m:
            cur.execute(
                """INSERT INTO mac_host_cluster_telemetry
                   (device_id, host_code, rack_slot, cluster_zone, ram_total_gb, max_account_quota, health_grade, health_note)
                   VALUES (?,?,?,?,64,50,'healthy','新增宿主机就绪')""",
                (pid, pcode, "新签客户预备机柜区", "新签客户托管预备集群"),
            )

    phone_rows = cur.execute("SELECT id, device_code, device_kind FROM physical_devices WHERE device_kind <> 'adspower_pc_host'").fetchall()
    for idx, (pid, pcode, pkind) in enumerate(phone_rows, start=1):
        exists_ph = cur.execute("SELECT 1 FROM mobile_device_telemetry WHERE device_id = ?", (pid,)).fetchone()
        if exists_ph:
            continue
        if pid == "dev-ph-12":
            cpu_p, ram_p, bat, temp_c, plug_risk, free_gb, adb_st, grade, note = (
                76, 78, 73, 42.8, 1, 34, "verified_locked", "critical",
                "🚨 电池健康度跌至 73% 且长期插电温度 42.8℃（存在微鼓包断电风险），且所插外部卡 sim-12 月底到期，建议本周安排换机/换电池！"
            )
        elif pid == "dev-ph-15":
            cpu_p, ram_p, bat, temp_c, plug_risk, free_gb, adb_st, grade, note = (
                19, 41, 96, 32.0, 0, 198, "pending_flash", "warning",
                "⚠️ 二号委托客户受托终端：尚未联系程序员(微信 z15859900434)完成自研设备指纹 ADB 灌录锁定，正式挂载运营前请补灌录！"
            )
        else:
            cpu_p = 20 + (idx * 7) % 38
            ram_p = 44 + (idx * 5) % 28
            bat = 95 - (idx % 9)
            temp_c = round(31.5 + (idx % 5) * 0.9, 1)
            plug_risk = 0
            free_gb = 140 + (idx * 5) % 70
            adb_st = "verified_locked"
            grade = "healthy"
            note = "自研 ADB 设备指纹锁定完好，负载、电池与温控正常"

        os_ver = "iOS 17.6 (严禁越狱)" if "iPhone" in (pcode or "") or pid == "dev-ph-13" else "Android 14 · ADB指纹锁死"
        net_mode = "在司连公司采购受控Wi-Fi (PanAsia-Procure-VLAN)" if pkind == "procurement_phone" else "在司连公司业务受控Wi-Fi (PanAsia-Corp-5G · 软路由独享家宽路由)"
        cur.execute(
            """INSERT INTO mobile_device_telemetry
               (device_id, cpu_load_pct, ram_usage_pct, battery_health_pct, battery_temp_c, always_plugged_risk,
                storage_total_gb, storage_free_gb, os_version, adb_fingerprint_status, network_isolation_mode,
                last_heartbeat_at, health_grade, health_note)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (pid, cpu_p, ram_p, bat, temp_c, plug_risk, 256, free_gb, os_ver, adb_st, net_mode, "2026-11-18 14:35:00", grade, note),
        )

    ads_rows = cur.execute("SELECT id, profile_code, proxy_ip_id, profile_status FROM adspower_profiles").fetchall()
    for idx, (aid, acode, px_id, pst) in enumerate(ads_rows, start=1):
        exists_w = cur.execute("SELECT 1 FROM adspower_window_health WHERE profile_id = ?", (aid,)).fetchone()
        if exists_w:
            continue
        if aid == "ads-12":
            ping_ms, ip_chk, webrtc, sync_h, open_st, mem_mb, grade, note = (
                -1, "blocked_expired", "safe", 96, "locked", 0, "critical",
                "🚨 所绑家宽 IP-SX-12 已过期断网，系统已自动熔断锁死窗口（严禁回退本机真实IP直连）！"
            )
        elif aid in ("ads-01", "ads-02"):
            ping_ms, ip_chk, webrtc, sync_h, open_st, mem_mb, grade, note = (
                41, "matched", "safe", 78 if aid == "ads-02" else 8, "open", 1180 if aid == "ads-01" else 920, "warning",
                "⚠️ 所绑家宽代理 5 天内即将到期，且 ADS-002 距上次 Cookie 云备份已超 78 小时，请及时续期并备份 Cookie"
            )
        else:
            is_open = idx in (3, 4, 5, 6, 9, 10, 11, 13, 14, 15, 17, 19, 20)
            ping_ms = 19 + (idx * 3) % 26
            ip_chk = "matched"
            webrtc = "safe"
            sync_h = 2 + (idx * 4) % 28
            open_st = "open" if is_open else "idle"
            mem_mb = (880 + (idx * 65) % 480) if is_open else 0
            grade = "healthy"
            note = "出口家宽 IP 一致，WebRTC 零泄漏，Authenticator fakey 自动填充正常"

        cur.execute(
            """INSERT INTO adspower_window_health
               (profile_id, proxy_ping_ms, exit_ip_check, webrtc_leak_status, cookie_sync_hours_ago,
                open_state, memory_mb, kernel_tag, health_grade, health_note, last_checked_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (aid, ping_ms, ip_chk, webrtc, sync_h, open_st, mem_mb, "SunBrowser 130 · 指纹已锁", grade, note, "2026-11-18 14:35:00"),
        )

    # 5. 写入统一固定资产台账 + 定位 × 公司受控网 × 坐班/居家合规种子（覆盖全部 25 台设备及后续新增设备）
    all_devs = [dict(r) for r in cur.execute("SELECT * FROM physical_devices ORDER BY device_code").fetchall()]
    mac_seq = 0
    ph_seq = 0
    for d in all_devs:
        did = d["id"]
        if cur.execute("SELECT 1 FROM device_asset_and_compliance WHERE device_id = ?", (did,)).fetchone():
            continue
        staff = d["custodian_staff"] or "周安"
        if d["device_kind"] == "adspower_pc_host":
            mac_seq += 1
            num = int(d["device_code"].split("-")[-1]) if d["device_code"].startswith("MAC-PRO-") and d["device_code"].split("-")[-1].isdigit() else mac_seq
            asset_no = f"AST-MAC-{num:03d}"
            po_no = f"PO-202608-MAC{(num - 1) // 5 + 1:02d}"
            p_date = "2026-08-15" if num <= 6 else "2026-10-08"
            cost_fen = 3299900  # ¥32,999.00 / 台 (M2 Ultra 64GB/1TB)
            salvage_fen = 2850000
            life_st = "standby" if num >= 7 else "in_use"
            agr_no = f"AGR-CTRL-2026-M{num:02d}"
            sched = "rack_24h"
            wfh_ref = ""
            geo_st = "in_company"
            geo_lbl = f"杭州滨江总部·3F中控机房 ({d['workstation_loc']})"
            coords = "30.2084°N, 120.2120°E"
            dist_km = 0.0
            net_kind = "corp_lan"
            ssid_nic = f"公司千兆内网 VLAN-20 (10.10.20.{100 + num})"
            gw_note = "机房核心交换机绑定 MAC 地址 · 走公司主干专线 + 窗口级独享家宽SOCKS5"
            comp_note = "7×24h 机房在柜，有线连接公司受控内网合规"
        else:
            ph_seq += 1
            num = int(d["device_code"].split("-")[-1]) if d["device_code"].startswith("DEV-PH-") and d["device_code"].split("-")[-1].isdigit() else ph_seq
            asset_no = f"AST-PHN-{num:03d}"
            po_no = f"PO-202609-PHN{(num - 1) // 8 + 1:02d}"
            p_date = "2026-09-05" if num <= 14 else "2026-11-10"
            cost_fen = 429900 if "iPhone" in d["brand_model"] or did == "dev-ph-13" else 179900
            salvage_fen = int(cost_fen * 0.72)
            life_st = "in_use"
            agr_no = f"AGR-CTRL-2026-P{num:02d}"

            # 注入真实典型案例：
            # 案例A (dev-ph-06)：人在公司工位，却断开了公司Wi-Fi切到个人5G流量 -> 触发「在司未连公司网」红灯！
            if did == "dev-ph-06":
                sched = "office_onsite"
                wfh_ref = ""
                geo_st = "in_company"
                geo_lbl = "杭州滨江总部·3F销售二组工位06 (距中心14m)"
                coords = "30.2085°N, 120.2121°E"
                dist_km = 0.01
                net_kind = "cellular_5g"
                ssid_nic = "中国移动 5G 蜂窝流量 (未连接公司Wi-Fi!)"
                gw_note = "⚠️ 已脱离公司软路由网关与独享家宽路由策略"
                comp_note = "🚨 违规：上班时间定位在公司3F工位，但手机断开了 PanAsia-Corp-5G 公司网改走5G流量，违反《设备使用协议》在司必连公司网规定！"
            # 案例B (dev-ph-11)：今日排班为正常坐班（未批居家），上班时间定位却在14.6km外的余杭住宅小区连着家庭宽带 -> 触发「未报备离司/假坐班真居家」红灯！
            elif did == "dev-ph-11":
                sched = "office_onsite"
                wfh_ref = ""
                geo_st = "outside_unregistered"
                geo_lbl = "杭州市余杭区未来科技城某住宅区 (距公司14.6km)"
                coords = "30.2816°N, 120.0762°E"
                dist_km = 14.6
                net_kind = "external_wifi_or_hotspot"
                ssid_nic = "ChinaNet-Home-8821 (外部家庭宽带)"
                gw_note = "🚨 未接入公司网络且无居家办公审批单"
                comp_note = "🚨 严重违规：今日排班为【在司坐班】（无OA居家审批），上班时间业务手机定位在余杭区外部住宅且连外部Wi-Fi，疑似私带设备离司/异地操作！"
            # 案例C (dev-ph-14)：今日已走 OA 报备批准居家办公，定位在报备住址且已拨通公司加密 VPN 隧道 -> 蓝色合规居家示范！
            elif did == "dev-ph-14":
                sched = "wfh_approved"
                wfh_ref = "OA-WFH-20261118-04"
                geo_st = "at_registered_home"
                geo_lbl = "杭州市萧山区员工报备住址 (距公司8.3km)"
                coords = "30.1820°N, 120.2645°E"
                dist_km = 8.3
                net_kind = "corp_vpn"
                ssid_nic = "PanAsia-HQ-VPN (居家加密回传公司内网)"
                gw_note = "已通过 WireGuard 企业隧道接入公司受控采购隔离网关"
                comp_note = "✓ 已持 OA 居家审批单 (OA-WFH-20261118-04)，定位匹配报备住址且全程连入公司受控 VPN"
            else:
                sched = "office_onsite"
                wfh_ref = ""
                geo_st = "in_company"
                geo_lbl = f"杭州滨江总部·3F ({d['workstation_loc']})"
                coords = "30.2084°N, 120.2120°E"
                dist_km = 0.0
                net_kind = "corp_wifi"
                ssid_nic = "PanAsia-Procure-VLAN (公司采购受控网)" if d["device_kind"] == "procurement_phone" else "PanAsia-Corp-5G (公司业务受控Wi-Fi)"
                gw_note = "公司软路由按设备 MAC 自动透明路由至对应独享家宽 IP"
                comp_note = "在司坐班且稳定连接公司受控 Wi-Fi，符合《公司设备使用协议》"

        cur.execute(
            """INSERT INTO device_asset_and_compliance
               (device_id, asset_no, purchase_order_no, purchase_date, purchase_cost_fen, salvage_value_fen,
                office_site, asset_lifecycle_status, control_agreement_no, agreement_signed_by, agreement_signed_at,
                last_inventory_date, inventory_status, work_schedule_mode, wfh_approval_ref,
                geo_fence_state, geo_location_label, geo_coords, distance_from_office_km,
                net_conn_kind, connected_ssid_or_nic, gateway_egress_note, remote_locked, compliance_note, last_located_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                did, asset_no, po_no, p_date, cost_fen, salvage_fen,
                "杭州滨江总部·3F", life_st, agr_no, staff, "2026-09-01",
                "2026-11-01", "verified", sched, wfh_ref,
                geo_st, geo_lbl, coords, dist_km,
                net_kind, ssid_nic, gw_note, 0, comp_note, "2026-11-18 14:35:00",
            ),
        )

    conn.commit()


def count_host_assigned_slots(conn: sqlite3.Connection, host_device_id: str, exclude_plat_id: str | None = None, exclude_ads_id: str | None = None) -> tuple[int, int]:
    q_acc = """
        SELECT COUNT(*)
        FROM platform_accounts pa
        JOIN adspower_profiles ap ON ap.id = pa.adspower_profile_id
        WHERE ap.host_device_id = ? AND pa.account_status <> 'retired'
    """
    params_acc: list = [host_device_id]
    if exclude_plat_id:
        q_acc += " AND pa.id <> ?"
        params_acc.append(exclude_plat_id)
    acc_cnt = conn.execute(q_acc, params_acc).fetchone()[0]

    q_win = "SELECT COUNT(*) FROM adspower_profiles WHERE host_device_id = ?"
    params_win: list = [host_device_id]
    if exclude_ads_id:
        q_win += " AND id <> ?"
        params_win.append(exclude_ads_id)
    win_cnt = conn.execute(q_win, params_win).fetchone()[0]
    return acc_cnt, win_cnt


def get_device_asset_map(conn: sqlite3.Connection) -> dict[str, dict]:
    ensure_cluster_and_health_seeded(conn)
    rows = [dict(r) for r in conn.execute("SELECT * FROM device_asset_and_compliance").fetchall()]
    out: dict[str, dict] = {}
    for r in rows:
        code, label, lvl = compute_loc_net_compliance(r)
        r["loc_net_compliance_code"] = code
        r["loc_net_compliance_label"] = label
        r["loc_net_compliance_level"] = lvl
        out[r["device_id"]] = r
    return out


def build_cluster_health_overview(conn: sqlite3.Connection) -> dict:
    ensure_cluster_and_health_seeded(conn)
    cur = conn.cursor()
    asset_map = get_device_asset_map(conn)

    # 1. 组装 10 台 64GB Mac Pro 宿主机完整健康 + 资产 + 温度 + 定位与公司网画像
    mac_rows = [dict(r) for r in cur.execute(
        """SELECT m.*, d.legal_person_id, d.brand_model, d.serial_number, d.workstation_loc,
                  d.custodian_staff, d.device_status, d.notes AS device_notes
           FROM mac_host_cluster_telemetry m
           JOIN physical_devices d ON d.id = m.device_id
           ORDER BY m.host_code"""
    ).fetchall()]

    win_rows = [dict(r) for r in cur.execute(
        """SELECT ap.*, wh.proxy_ping_ms, wh.exit_ip_check, wh.webrtc_leak_status,
                  wh.cookie_sync_hours_ago, wh.open_state, wh.memory_mb, wh.kernel_tag,
                  wh.health_grade AS win_health_grade, wh.health_note AS win_health_note, wh.last_checked_at,
                  px.proxy_code, px.exit_ip, px.expires_at
           FROM adspower_profiles ap
           LEFT JOIN adspower_window_health wh ON wh.profile_id = ap.id
           LEFT JOIN proxy_ips px ON px.id = ap.proxy_ip_id
           ORDER BY ap.ads_serial_no"""
    ).fetchall()]

    pa_rows = [dict(r) for r in cur.execute(
        """SELECT pa.id, pa.account_code, pa.display_name, pa.platform, pa.account_role,
                  pa.operator_staff, pa.account_status, pa.adspower_profile_id, pa.legal_person_id,
                  be.entity_code
           FROM platform_accounts pa
           LEFT JOIN business_entities be ON be.id = pa.business_entity_id
           WHERE pa.account_status <> 'retired'"""
    ).fetchall()]

    pa_by_win: dict[str, list[dict]] = {}
    for pa in pa_rows:
        if pa["adspower_profile_id"]:
            pa_by_win.setdefault(pa["adspower_profile_id"], []).append(pa)

    wins_by_host: dict[str, list[dict]] = {}
    for w in win_rows:
        w["bound_accounts"] = pa_by_win.get(w["id"], [])
        w["account_count"] = len(w["bound_accounts"])
        if not w.get("win_health_grade"):
            w["win_health_grade"] = "healthy"
            w["win_health_note"] = "环境正常"
        wins_by_host.setdefault(w["host_device_id"], []).append(w)

    total_quota_slots = 0
    total_used_accounts = 0
    total_windows = 0
    total_ram_gb = 0
    total_ram_used_gb = 0.0
    critical_hosts = 0
    warning_hosts = 0

    for m in mac_rows:
        ac = asset_map.get(m["device_id"], {})
        m.update({
            "asset_no": ac.get("asset_no", ""),
            "purchase_cost_fen": ac.get("purchase_cost_fen", 0),
            "purchase_date": ac.get("purchase_date", ""),
            "control_agreement_no": ac.get("control_agreement_no", ""),
            "geo_fence_state": ac.get("geo_fence_state", "in_company"),
            "geo_location_label": ac.get("geo_location_label", ""),
            "net_conn_kind": ac.get("net_conn_kind", "corp_lan"),
            "connected_ssid_or_nic": ac.get("connected_ssid_or_nic", ""),
            "loc_net_compliance_code": ac.get("loc_net_compliance_code", "compliant_office"),
            "loc_net_compliance_label": ac.get("loc_net_compliance_label", "🟢 在司 · 已连公司网"),
            "loc_net_compliance_level": ac.get("loc_net_compliance_level", "green"),
        })

        h_wins = wins_by_host.get(m["device_id"], [])
        acc_cnt = sum(len(w["bound_accounts"]) for w in h_wins)
        win_cnt = len(h_wins)
        occupied = max(acc_cnt, win_cnt)
        quota = int(m["max_account_quota"] or 50)
        rem_slots = max(0, quota - occupied)
        quota_pct = int(round(occupied * 100.0 / quota)) if quota else 0
        ram_pct = int(round(float(m["ram_used_gb"]) * 100.0 / int(m["ram_total_gb"] or 64)))
        ssd_pct = int(round(int(m["ssd_used_gb"]) * 100.0 / int(m["ssd_total_gb"] or 1024)))
        soc_temp = float(m.get("soc_temp_c") or 45.0)

        lp_ids = sorted({pa["legal_person_id"] for w in h_wins for pa in w["bound_accounts"] if pa.get("legal_person_id")})
        if m.get("legal_person_id") and m["legal_person_id"] not in lp_ids:
            lp_ids.append(m["legal_person_id"])

        has_crit_win = any(w["win_health_grade"] == "critical" for w in h_wins)
        if (
            m["health_grade"] == "critical"
            or ram_pct >= 88
            or m["swap_used_gb"] >= 4.0
            or soc_temp >= 75.0
            or occupied > quota
            or has_crit_win
            or m["loc_net_compliance_level"] == "red"
        ):
            eff_grade = "critical"
            critical_hosts += 1
        elif m["health_grade"] == "warning" or ram_pct >= 75 or soc_temp >= 68.0 or quota_pct >= 90 or m["local_api_status"] != "online":
            eff_grade = "warning"
            warning_hosts += 1
        else:
            eff_grade = "healthy"

        m["windows"] = h_wins
        m["window_count"] = win_cnt
        m["account_count"] = acc_cnt
        m["occupied_slots"] = occupied
        m["remaining_slots"] = rem_slots
        m["quota_usage_pct"] = quota_pct
        m["ram_usage_pct"] = ram_pct
        m["ssd_usage_pct"] = ssd_pct
        m["effective_health_grade"] = eff_grade
        m["legal_person_ids"] = lp_ids

        total_quota_slots += quota
        total_used_accounts += acc_cnt
        total_windows += win_cnt
        total_ram_gb += int(m["ram_total_gb"] or 64)
        total_ram_used_gb += float(m["ram_used_gb"] or 0.0)

    # 2. 组装 15 部实体手机健康度 + 固定资产 + 定位×公司网合规画像
    mobile_rows = [dict(r) for r in cur.execute(
        """SELECT mt.*, d.device_code, d.device_kind, d.brand_model, d.serial_number,
                  d.role_isolation, d.workstation_loc, d.custodian_staff, d.legal_person_id,
                  s1.phone_number AS slot_1_phone, s2.phone_number AS slot_2_phone
           FROM mobile_device_telemetry mt
           JOIN physical_devices d ON d.id = mt.device_id
           LEFT JOIN sim_cards s1 ON s1.id = d.sim_slot_1_id
           LEFT JOIN sim_cards s2 ON s2.id = d.sim_slot_2_id
           ORDER BY d.device_code"""
    ).fetchall()]

    for ph in mobile_rows:
        ac = asset_map.get(ph["device_id"], {})
        ph.update({
            "asset_no": ac.get("asset_no", ""),
            "purchase_cost_fen": ac.get("purchase_cost_fen", 0),
            "purchase_date": ac.get("purchase_date", ""),
            "control_agreement_no": ac.get("control_agreement_no", ""),
            "work_schedule_mode": ac.get("work_schedule_mode", "office_onsite"),
            "wfh_approval_ref": ac.get("wfh_approval_ref", ""),
            "geo_fence_state": ac.get("geo_fence_state", "in_company"),
            "geo_location_label": ac.get("geo_location_label", ""),
            "geo_coords": ac.get("geo_coords", ""),
            "distance_from_office_km": ac.get("distance_from_office_km", 0.0),
            "net_conn_kind": ac.get("net_conn_kind", "corp_wifi"),
            "connected_ssid_or_nic": ac.get("connected_ssid_or_nic", ""),
            "gateway_egress_note": ac.get("gateway_egress_note", ""),
            "remote_locked": ac.get("remote_locked", 0),
            "compliance_note": ac.get("compliance_note", ""),
            "loc_net_compliance_code": ac.get("loc_net_compliance_code", "compliant_office"),
            "loc_net_compliance_label": ac.get("loc_net_compliance_label", "🟢 在司 · 已连公司网"),
            "loc_net_compliance_level": ac.get("loc_net_compliance_level", "green"),
        })

    # 3. 汇总首屏红→黄→绿「算力负载、温度、定位×公司受控网与环境」行动箱
    health_issues = []

    # 优先排入「定位 × 公司受控网」违规（上班时间在司断公司网 / 未报备私带离司）
    for dev_item in [*mac_rows, *mobile_rows]:
        c_code = dev_item.get("loc_net_compliance_code")
        d_code = dev_item.get("host_code") or dev_item.get("device_code")
        if c_code == "violation_unapproved_offsite":
            health_issues.append({
                "level": "red",
                "category": "定位×考勤红线：未报备离司",
                "target_kind": "compliance",
                "target_id": dev_item["device_id"],
                "title": f"【未报备离司告警】{d_code} ({dev_item['asset_no']} · 保管:{dev_item['custodian_staff']}) 距司 {dev_item.get('distance_from_office_km', 0)}km · 连 {dev_item.get('connected_ssid_or_nic')}",
                "detail": dev_item.get("compliance_note") or "上班时间定位不在公司围栏内且无居家办公审批单！",
                "action_type": "approve_wfh_vpn",
                "action_label": "🏠 补批居家并切公司VPN ›",
                "secondary_action_type": "enforce_return_office",
                "secondary_action_label": "📍 登记已召回在司连网",
            })
        elif c_code == "violation_office_no_corp_net":
            health_issues.append({
                "level": "red",
                "category": "定位×网络红线：在司未连公司网",
                "target_kind": "compliance",
                "target_id": dev_item["device_id"],
                "title": f"【在司断网违规】{d_code} ({dev_item['asset_no']} · 保管:{dev_item['custodian_staff']}) 定位在公司，却使用 {dev_item.get('connected_ssid_or_nic')}",
                "detail": dev_item.get("compliance_note") or "规定在公司办公必须连接公司受控网络，禁止私切蜂窝流量或个人热点！",
                "action_type": "enforce_corp_wifi",
                "action_label": "📡 强制重连公司受控网 ›",
            })
        elif c_code == "violation_wfh_no_vpn":
            health_issues.append({
                "level": "yellow",
                "category": "居家办公网络提醒",
                "target_kind": "compliance",
                "target_id": dev_item["device_id"],
                "title": f"【居家未拨VPN】{d_code} 已批居家办公，但尚未接通公司 VPN 隧道",
                "detail": dev_item.get("compliance_note") or "请督促员工开启公司受控 VPN 客户端",
                "action_type": "approve_wfh_vpn",
                "action_label": "🔌 一键重连公司VPN ›",
            })

    for m in mac_rows:
        if m["effective_health_grade"] == "critical":
            health_issues.append({
                "level": "red",
                "category": "Mac Pro 负载/温度高危",
                "target_kind": "mac_host",
                "target_id": m["device_id"],
                "title": f"【{m['host_code']} 告警】CPU负载 {m['cpu_load_pct']}% · 芯片温度 {m['soc_temp_c']}℃ · 内存 {m['ram_used_gb']}G/64G ({m['ram_usage_pct']}%) · Swap {m['swap_used_gb']}G",
                "detail": m["health_note"],
                "action_type": "optimize_mac",
                "action_label": "🧹 清缓存降温降载 ›",
            })
        elif m["effective_health_grade"] == "warning":
            health_issues.append({
                "level": "yellow",
                "category": "Mac Pro 守护巡检",
                "target_kind": "mac_host",
                "target_id": m["device_id"],
                "title": f"【{m['host_code']} 提醒】Local API 状态：{m['local_api_status']} · 已挂 {m['account_count']}/{m['max_account_quota']} 号",
                "detail": m["health_note"],
                "action_type": "heal_local_api",
                "action_label": "🔌 唤醒 Local API ›",
            })

    for w in win_rows:
        if w["win_health_grade"] == "critical":
            health_issues.append({
                "level": "red",
                "category": "AdsPower 防直连熔断",
                "target_kind": "ads_window",
                "target_id": w["id"],
                "proxy_id": w["proxy_ip_id"],
                "title": f"【窗口熔断锁死】{w['profile_code']} ({w['window_name']}) 出口代理 {w['proxy_code']} 已断网",
                "detail": w["win_health_note"],
                "action_type": "open_proxy",
                "action_label": "去续期家宽解锁 ›",
            })
        elif w["win_health_grade"] == "warning" and w["cookie_sync_hours_ago"] > 72:
            health_issues.append({
                "level": "yellow",
                "category": "Cookie 云备份超时",
                "target_kind": "ads_window",
                "target_id": w["id"],
                "title": f"【Cookie 待同步】{w['profile_code']} ({w['window_name']}) 已 {w['cookie_sync_hours_ago']} 小时未同步备份",
                "detail": w["win_health_note"],
                "action_type": "sync_cookie",
                "action_label": "☁️ 立即备份 Cookie ›",
            })

    for ph in mobile_rows:
        if ph["health_grade"] == "critical":
            health_issues.append({
                "level": "red",
                "category": "真机高温/电池鼓包预警",
                "target_kind": "mobile",
                "target_id": ph["device_id"],
                "title": f"【真机高温/鼓包】{ph['device_code']} ({ph['asset_no']}) 温度 {ph['battery_temp_c']}℃ · 电池健康 {ph['battery_health_pct']}% · 负载 {ph['cpu_load_pct']}%",
                "detail": ph["health_note"],
                "action_type": "open_device",
                "action_label": "查看真机处置 ›",
            })
        elif ph["health_grade"] == "warning":
            health_issues.append({
                "level": "yellow",
                "category": "真机 ADB 指纹待灌录",
                "target_kind": "mobile",
                "target_id": ph["device_id"],
                "title": f"【待灌录指纹】{ph['device_code']} ({ph['asset_no']}) 状态：{ph['adb_fingerprint_status']}",
                "detail": ph["health_note"],
                "action_type": "flash_adb",
                "action_label": "✓ 标记已完成ADB灌录 ›",
            })

    health_issues.sort(key=lambda x: 0 if x["level"] == "red" else 1)

    all_assets = list(asset_map.values())
    total_asset_cost_fen = sum(int(a.get("purchase_cost_fen") or 0) for a in all_assets)
    total_salvage_fen = sum(int(a.get("salvage_value_fen") or 0) for a in all_assets)
    in_office_compliant = sum(1 for a in all_assets if a["loc_net_compliance_code"] == "compliant_office")
    wfh_compliant = sum(1 for a in all_assets if a["loc_net_compliance_code"] == "compliant_wfh")
    loc_net_violations = sum(1 for a in all_assets if a["loc_net_compliance_level"] in ("red", "amber"))
    agreement_signed_cnt = sum(1 for a in all_assets if a.get("control_agreement_no"))
    inventory_verified_cnt = sum(1 for a in all_assets if a.get("inventory_status") == "verified")
    reduction_logs = [dict(r) for r in cur.execute("SELECT * FROM asset_reduction_requests ORDER BY requested_at DESC").fetchall()]

    return {
        "summary": {
            "mac_host_count": len(mac_rows),
            "ram_per_host_gb": 64,
            "total_cluster_ram_gb": total_ram_gb,
            "total_ram_used_gb": round(total_ram_used_gb, 1),
            "quota_per_host": 50,
            "total_account_quota": total_quota_slots,
            "total_mounted_accounts": total_used_accounts,
            "total_remaining_slots": max(0, total_quota_slots - total_used_accounts),
            "total_ads_windows": total_windows,
            "open_windows_now": sum(int(m["open_windows_now"] or 0) for m in mac_rows),
            "critical_host_count": critical_hosts,
            "warning_host_count": warning_hosts,
            "healthy_host_count": len(mac_rows) - critical_hosts - warning_hosts,
            "mobile_count": len(mobile_rows),
            "mobile_adb_locked_count": sum(1 for p in mobile_rows if p["adb_fingerprint_status"] == "verified_locked"),
            "mobile_alert_count": sum(1 for p in mobile_rows if p["health_grade"] != "healthy"),
            "window_healthy_count": sum(1 for w in win_rows if w["win_health_grade"] == "healthy"),
            "window_alert_count": sum(1 for w in win_rows if w["win_health_grade"] != "healthy"),
            # 新增：固定资产总盘 & 定位×公司网合规核心指标
            "total_asset_devices": len(all_assets),
            "total_asset_cost_fen": total_asset_cost_fen,
            "total_salvage_value_fen": total_salvage_fen,
            "agreement_signed_count": agreement_signed_cnt,
            "inventory_verified_count": inventory_verified_cnt,
            "in_office_compliant_count": in_office_compliant,
            "wfh_compliant_count": wfh_compliant,
            "loc_net_violation_count": loc_net_violations,
        },
        "mac_hosts": mac_rows,
        "ads_windows": win_rows,
        "mobile_devices": mobile_rows,
        "asset_reductions": reduction_logs,
        "health_issues": health_issues,
    }

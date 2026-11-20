/**
 * SQLite 数据库引擎（基于 Node.js 24 原生 node:sqlite + WAL + 外键 + 顺序 Schema 迁移）
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { seedInitialData } from './seed.js';

export const SCHEMA_VERSION = 2;

const MIGRATIONS = [
  {
    version: 1,
    name: 'init_core_procurement_and_monitor_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS staff_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('ADMIN','PURCHASER','WAREHOUSE','FINANCE')),
        password_hash TEXT NOT NULL,
        practice_passed_gates TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        last_login_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS login_attempts (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        ip TEXT NOT NULL,
        ok INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        actor_name TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS quota_pools (
        pool_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        total_budget_cents INTEGER NOT NULL,
        reserved_cents INTEGER NOT NULL DEFAULT 0,
        consumed_cents INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS quota_reservations (
        reservation_id TEXT PRIMARY KEY,
        pool_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        staff_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('reserved','converted','released')),
        idempotency_key TEXT NOT NULL UNIQUE,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pricebook_items (
        id TEXT PRIMARY KEY,
        sku_code TEXT NOT NULL,
        model_name TEXT NOT NULL,
        category TEXT NOT NULL,
        condition_grade TEXT NOT NULL,
        version_no INTEGER NOT NULL DEFAULT 1,
        ref_cents INTEGER NOT NULL,
        initial_offer_cents INTEGER NOT NULL,
        target_cents INTEGER NOT NULL,
        ceiling_cents INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft_pending_review','published','archived')),
        created_by TEXT NOT NULL,
        approved_by TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (sku_code, version_no)
      );

      CREATE TABLE IF NOT EXISTS xianyu_accounts (
        id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL UNIQUE,
        account_name TEXT NOT NULL,
        nickname TEXT NOT NULL DEFAULT '',
        avatar TEXT NOT NULL DEFAULT '',
        window_role TEXT NOT NULL DEFAULT 'WIN-FG-01',
        window_desc TEXT NOT NULL DEFAULT '',
        login_status TEXT NOT NULL DEFAULT 'logged_in',
        im_realtime_ok INTEGER NOT NULL DEFAULT 1,
        mtop_cookie TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        rolling_30d_orders INTEGER NOT NULL DEFAULT 0,
        rolling_30d_refunds INTEGER NOT NULL DEFAULT 0,
        rolling_30d_disputes INTEGER NOT NULL DEFAULT 0,
        redline_pct REAL NOT NULL DEFAULT 5.0,
        warn_pct REAL NOT NULL DEFAULT 3.8,
        synced_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dingtalk_robots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        webhook TEXT NOT NULL,
        secret TEXT NOT NULL,
        last_test_ok INTEGER NOT NULL DEFAULT 0,
        last_test_msg TEXT NOT NULL DEFAULT '尚未连接测试',
        last_test_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS greeting_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        greeting_type TEXT NOT NULL DEFAULT 'text',
        title TEXT NOT NULL DEFAULT '默认话术',
        text_content TEXT NOT NULL,
        image_url TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS seller_blacklist (
        user_id TEXT PRIMARY KEY,
        plain_user_id TEXT NOT NULL DEFAULT '',
        nick TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        added_by TEXT NOT NULL DEFAULT 'liming',
        added_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS monitor_listen_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        search_keyword TEXT NOT NULL,
        match_sub TEXT NOT NULL DEFAULT '',
        exclude_keywords TEXT NOT NULL DEFAULT '',
        seller_exclude_keywords TEXT NOT NULL DEFAULT '',
        match_sub_price_ranges TEXT NOT NULL DEFAULT '{}',
        price_from REAL,
        price_to REAL,
        division_options TEXT NOT NULL DEFAULT '[]',
        sort_mode TEXT NOT NULL DEFAULT 'publish_latest',
        publish_within_minutes INTEGER DEFAULT 30,
        quick_filters TEXT NOT NULL DEFAULT '[]',
        filter_pushed_enabled INTEGER NOT NULL DEFAULT 1,
        interval_seconds INTEGER NOT NULL DEFAULT 15,
        listen_account_ids TEXT NOT NULL DEFAULT '[]',
        miaopai_enabled INTEGER NOT NULL DEFAULT 0,
        miaopai_account_ids TEXT NOT NULL DEFAULT '[]',
        miaopai_price_from REAL,
        miaopai_price_to REAL,
        dingtalk_robot_ids TEXT NOT NULL DEFAULT '[]',
        greeting_enabled INTEGER NOT NULL DEFAULT 0,
        greeting_template_ids TEXT NOT NULL DEFAULT '[]',
        pricebook_sku TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        last_poll_error TEXT NOT NULL DEFAULT '',
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS monitor_shop_tasks (
        id TEXT PRIMARY KEY,
        seller_user_id TEXT NOT NULL,
        seller_nick TEXT NOT NULL DEFAULT '',
        shop_url TEXT NOT NULL DEFAULT '',
        match_sub TEXT NOT NULL DEFAULT '',
        exclude_keywords TEXT NOT NULL DEFAULT '',
        price_from REAL,
        price_to REAL,
        pricebook_sku TEXT NOT NULL DEFAULT '',
        listen_account_ids TEXT NOT NULL DEFAULT '[]',
        miaopai_enabled INTEGER NOT NULL DEFAULT 0,
        miaopai_account_ids TEXT NOT NULL DEFAULT '[]',
        dingtalk_robot_ids TEXT NOT NULL DEFAULT '[]',
        interval_seconds INTEGER NOT NULL DEFAULT 20,
        favorite_seller_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS monitor_hits (
        hit_id TEXT PRIMARY KEY,
        source_type TEXT NOT NULL CHECK (source_type IN ('global','shop')),
        source_task_id TEXT NOT NULL,
        source_task_name TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'goofish',
        item_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        title TEXT NOT NULL,
        desc_text TEXT NOT NULL DEFAULT '',
        price_yuan REAL NOT NULL,
        price_str TEXT NOT NULL,
        seller_user_id TEXT NOT NULL,
        seller_nick TEXT NOT NULL,
        area_text TEXT NOT NULL DEFAULT '',
        publish_time_ms INTEGER NOT NULL,
        pic_url TEXT NOT NULL DEFAULT '',
        images_json TEXT NOT NULL DEFAULT '[]',
        tags_json TEXT NOT NULL DEFAULT '[]',
        pricebook_sku TEXT NOT NULL DEFAULT '',
        ref_cents INTEGER NOT NULL DEFAULT 0,
        ceiling_cents INTEGER NOT NULL DEFAULT 0,
        prebuy_save_cents INTEGER NOT NULL DEFAULT 0,
        prebuy_comm_cents INTEGER NOT NULL DEFAULT 0,
        suspect_quality_flag INTEGER NOT NULL DEFAULT 0,
        prebuy_warning TEXT NOT NULL DEFAULT '',
        dingtalk_pushed INTEGER NOT NULL DEFAULT 0,
        greeting_sent INTEGER NOT NULL DEFAULT 0,
        locked_order_id TEXT,
        linked_case_id TEXT,
        linked_conv_id TEXT,
        raw_payload TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        UNIQUE (platform, item_id, account_id)
      );

      CREATE TABLE IF NOT EXISTS monitor_poll_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        task_name TEXT NOT NULL,
        source_type TEXT NOT NULL,
        raw_count INTEGER NOT NULL DEFAULT 0,
        deduped_count INTEGER NOT NULL DEFAULT 0,
        filtered_out_count INTEGER NOT NULL DEFAULT 0,
        matched_count INTEGER NOT NULL DEFAULT 0,
        pushed_count INTEGER NOT NULL DEFAULT 0,
        account_id TEXT NOT NULL DEFAULT '',
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS favorite_sellers (
        seller_id TEXT PRIMARY KEY,
        seller_nick TEXT NOT NULL,
        category_focus TEXT NOT NULL DEFAULT '',
        visibility_scope TEXT NOT NULL DEFAULT 'personal' CHECK (visibility_scope IN ('personal','team')),
        owner_staff_id TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        notes TEXT NOT NULL DEFAULT '',
        total_deals INTEGER NOT NULL DEFAULT 0,
        shop_monitor_id TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS item_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        version_no INTEGER NOT NULL DEFAULT 1,
        seller_title TEXT NOT NULL,
        seller_declaration TEXT NOT NULL,
        pricebook_sku TEXT NOT NULL DEFAULT '',
        pricebook_ref_version INTEGER NOT NULL DEFAULT 1,
        images_json TEXT NOT NULL DEFAULT '[]',
        source_type TEXT NOT NULL DEFAULT '监控自动锁图',
        captured_by TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        UNIQUE (product_id, version_no)
      );

      CREATE TABLE IF NOT EXISTS conversations (
        conv_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        bucket TEXT NOT NULL DEFAULT 'bargaining',
        seller_id TEXT NOT NULL,
        seller_nick TEXT NOT NULL,
        sku_code TEXT NOT NULL,
        title TEXT NOT NULL,
        listed_cents INTEGER NOT NULL,
        ref_cents INTEGER NOT NULL,
        initial_offer_cents INTEGER NOT NULL,
        target_cents INTEGER NOT NULL,
        ceiling_cents INTEGER NOT NULL,
        agreed_cents INTEGER,
        pause_state TEXT NOT NULL DEFAULT 'auto' CHECK (pause_state IN ('auto','pausing','paused')),
        context_version INTEGER NOT NULL DEFAULT 1,
        pause_reason TEXT,
        snapshot_id TEXT,
        seller_attitude TEXT NOT NULL DEFAULT 'willing_drop',
        ai_score INTEGER NOT NULL DEFAULT 80,
        advice_summary TEXT NOT NULL DEFAULT '',
        needs_manual INTEGER NOT NULL DEFAULT 0,
        wait_minutes INTEGER NOT NULL DEFAULT 0,
        unread_count INTEGER NOT NULL DEFAULT 0,
        slow_group INTEGER NOT NULL DEFAULT 0,
        matched_status TEXT NOT NULL DEFAULT 'matched' CHECK (matched_status IN ('matched','conflict_pending')),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        msg_id TEXT PRIMARY KEY,
        conv_id TEXT NOT NULL,
        sender_type TEXT NOT NULL CHECK (sender_type IN ('seller','buyer_ai','buyer_human','system')),
        sender_name TEXT NOT NULL,
        body TEXT NOT NULL,
        offer_cents INTEGER,
        round_no INTEGER NOT NULL DEFAULT 1,
        idempotency_key TEXT UNIQUE,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS procurement_cases (
        case_id TEXT PRIMARY KEY,
        order_bucket TEXT NOT NULL CHECK (order_bucket IN ('today','issue','done')),
        lvl TEXT NOT NULL CHECK (lvl IN ('red','amb','grn')),
        title TEXT NOT NULL,
        sku_code TEXT NOT NULL,
        model_name TEXT NOT NULL,
        account_id TEXT NOT NULL,
        seller_id TEXT NOT NULL DEFAULT '',
        seller_nick TEXT NOT NULL,
        conv_id TEXT,
        snapshot_id TEXT,
        pricebook_ref_version INTEGER NOT NULL DEFAULT 2,
        ref_cents INTEGER NOT NULL,
        target_cents INTEGER NOT NULL,
        ceiling_cents INTEGER NOT NULL,
        agreed_cents INTEGER,
        paid_cents INTEGER,
        prebuy_step INTEGER NOT NULL DEFAULT 1,
        suspect_quality_flag INTEGER NOT NULL DEFAULT 0,
        prebuy_note TEXT NOT NULL DEFAULT '',
        seller_modified_price INTEGER NOT NULL DEFAULT 0,
        payment_receipt_no TEXT,
        external_order_no TEXT,
        sf_waybill_no TEXT,
        sf_delivery_status TEXT NOT NULL DEFAULT 'created',
        warehouse_check_state TEXT NOT NULL DEFAULT 'pending',
        warehouse_video_url TEXT,
        warehouse_defect_photos TEXT NOT NULL DEFAULT '[]',
        warehouse_defect_note TEXT NOT NULL DEFAULT '',
        owner_staff_id TEXT NOT NULL DEFAULT 'liming',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS aftersales_tickets (
        ticket_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL UNIQUE,
        arrival_track TEXT NOT NULL DEFAULT 'sf_express_refuse' CHECK (arrival_track IN ('sf_express_refuse','signed_platform_return')),
        current_step INTEGER NOT NULL DEFAULT 1,
        waybill_refuse_verified INTEGER NOT NULL DEFAULT 0,
        seller_wx_added INTEGER NOT NULL DEFAULT 0,
        seller_wx_id TEXT NOT NULL DEFAULT '',
        platform_return_locked INTEGER NOT NULL DEFAULT 0,
        seller_signal TEXT NOT NULL DEFAULT '',
        seller_signal_note TEXT NOT NULL DEFAULT '',
        first_knife_mode TEXT NOT NULL DEFAULT 'half_price',
        opening_anchor_cents INTEGER NOT NULL DEFAULT 0,
        target_keep_cents INTEGER NOT NULL DEFAULT 0,
        bottom_line_cents INTEGER NOT NULL DEFAULT 0,
        salvage_profit_cents INTEGER NOT NULL DEFAULT 0,
        is_salvage_profitable INTEGER NOT NULL DEFAULT 0,
        tactics_used_json TEXT NOT NULL DEFAULT '[]',
        plan_b_hash TEXT,
        sf_95338_status TEXT NOT NULL DEFAULT 'none' CHECK (sf_95338_status IN ('none','requested','intercepted','returned_to_seller')),
        settle_mode TEXT NOT NULL DEFAULT 'undecided',
        agreed_reduction_cents INTEGER NOT NULL DEFAULT 0,
        final_keep_cents INTEGER NOT NULL DEFAULT 0,
        intervention_status TEXT NOT NULL DEFAULT 'none',
        intervention_reason TEXT NOT NULL DEFAULT '',
        warehouse_disposal_status TEXT NOT NULL DEFAULT 'pending',
        finance_settled INTEGER NOT NULL DEFAULT 0,
        warehouse_confirmed INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS aftersales_bargain_logs (
        log_id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        round_no INTEGER NOT NULL DEFAULT 1,
        speaker TEXT NOT NULL,
        tactic_code TEXT NOT NULL DEFAULT '',
        offer_cents INTEGER,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS corp_alipay_registrations (
        reg_id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        payee_real_name TEXT NOT NULL,
        payee_alipay_account TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        wx_contract_confirmed INTEGER NOT NULL DEFAULT 1,
        receipt_no TEXT,
        approved_by TEXT,
        status TEXT NOT NULL DEFAULT 'pending_finance' CHECK (status IN ('pending_finance','approved_paid','rejected')),
        schedule_slot TEXT NOT NULL DEFAULT '次日 10:00 (T+1)',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        approved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS statement_batches (
        batch_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        statement_date TEXT NOT NULL,
        sync_source_label TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open_diff' CHECK (status IN ('open_diff','signed_off')),
        signed_off_by TEXT,
        signed_off_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS statement_items (
        item_id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        alipay_tx_no TEXT NOT NULL UNIQUE,
        external_order_no TEXT NOT NULL,
        account_name TEXT NOT NULL,
        seller_nick TEXT NOT NULL,
        item_title TEXT NOT NULL,
        sku_code TEXT NOT NULL,
        statement_amount_cents INTEGER NOT NULL,
        system_amount_cents INTEGER,
        diff_type TEXT NOT NULL CHECK (diff_type IN ('matched','missing_order','amount_diff')),
        resolution_state TEXT NOT NULL DEFAULT 'pending' CHECK (resolution_state IN ('auto','pending','backfilled','amount_adjusted','ignored_non_po')),
        linked_case_id TEXT,
        note TEXT NOT NULL DEFAULT '',
        paid_at_label TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS finance_ledger (
        ledger_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        ticket_id TEXT,
        entry_type TEXT NOT NULL,
        title TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inflow','outflow')),
        receipt_no TEXT,
        verified_by TEXT,
        status TEXT NOT NULL DEFAULT 'verified',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS commissions (
        comm_id TEXT PRIMARY KEY,
        staff_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        ticket_id TEXT,
        policy_mode TEXT NOT NULL CHECK (policy_mode IN ('pre_buy_10_pct','post_arrival_10_pct')),
        base_saved_cents INTEGER NOT NULL,
        estimated_cents INTEGER NOT NULL DEFAULT 0,
        confirmed_cents INTEGER NOT NULL DEFAULT 0,
        paid_cents INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('estimated','confirmed','paid','reversed')),
        note TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        UNIQUE (case_id, policy_mode)
      );

      CREATE TABLE IF NOT EXISTS help_requests (
        req_id TEXT PRIMARY KEY,
        case_id TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        requester_name TEXT NOT NULL,
        question TEXT NOT NULL,
        reply_text TEXT,
        replied_by TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'add_executor_jobs_and_staff_daily_target',
    sql: `
      ALTER TABLE staff_users ADD COLUMN daily_comm_target_cents INTEGER NOT NULL DEFAULT 100000;
      CREATE TABLE IF NOT EXISTS executor_jobs (
        job_id TEXT PRIMARY KEY,
        window_id TEXT NOT NULL,
        window_name TEXT NOT NULL,
        account_name TEXT NOT NULL,
        job_type TEXT NOT NULL,
        target_ref TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        detail TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
    `,
  },
];

export function openDatabase(dbPath) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  const hasMig = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'`)
    .get();
  let curVer = 0;
  if (hasMig) {
    const row = db.prepare(`SELECT MAX(version) AS v FROM schema_migrations`).get();
    curVer = Number(row?.v || 0);
  }

  for (const m of MIGRATIONS) {
    if (m.version <= curVer) continue;
    db.exec('BEGIN;');
    try {
      db.exec(m.sql);
      db.prepare(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)`)
        .run(m.version, m.name, new Date().toISOString());
      db.exec('COMMIT;');
      curVer = m.version;
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    }
  }

  if (curVer !== SCHEMA_VERSION) {
    throw new Error(`Database schema mismatch: cur=${curVer}, expected=${SCHEMA_VERSION}`);
  }

  seedInitialData(db);
  return db;
}

export function withTx(db, fn) {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const res = fn();
    db.exec('COMMIT;');
    return res;
  } catch (err) {
    db.exec('ROLLBACK;');
    throw err;
  }
}

#!/usr/bin/env python3
"""
泛亚采购工作台 · 本地闭环演示后端 v3.0（Python 3.12 标准库 http.server + sqlite3，零第三方依赖）。
设计依据：
- 飞书 Wiki《EC-P01 采购 Copilot 员工理解版》《采购到手议价 SOP (PROC-SOP-001)》《20%高佣激励》《心理学×MBA议价 V2/V3》《两套报价打法》
- 钉钉 Wiki《采购工作台｜看商品、跟订单、验货与售后》《泛亚工作台 UI 设计总纲领 v1.0》
- 销售工作台 C 端步入式陪跑规范（红黄绿唯一行动语义 + 一步一屏陪跑 + 零内部代号黑话）
- 订单三大清晰分类：今天采购的 (today) / 问题订单 (issue) / 已经完结的 (completed)
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("PROCUREMENT_DB_PATH", os.path.join(HERE, "procurement_demo.db"))
DB_LOCK = threading.RLock()

ROLES = {
    "liming": {"id": "liming", "name": "李明", "role": "purchaser", "role_label": "采购业务员", "max_single_cents": 1200000},
    "wangzg": {"id": "wangzg", "name": "王主管", "role": "supervisor", "role_label": "采购主管", "max_single_cents": 5000000},
    "zhaocg": {"id": "zhaocg", "name": "赵仓管", "role": "warehouse", "role_label": "仓库质检", "max_single_cents": 0},
    "chenkj": {"id": "chenkj", "name": "陈会计", "role": "finance", "role_label": "财务对账", "max_single_cents": 5000000},
    "newbie": {"id": "newbie", "name": "周小新", "role": "purchaser", "role_label": "新同事（第一天上岗）", "max_single_cents": 1200000},
}

CONFIDENTIAL_KEYWORDS = ("参考价", "公司参考", "目标价", "授权上限", "采购上限", "底价", "提成", "佣金", "毛利")
ANTI_BICKERING_KEYWORDS = ("申请小二介入", "点小二介入", "闲鱼小法庭见", "法庭见", "投诉你到底", "跟你死磕")

NODE_METAS = [
    (1, "看货建单", "核对机型成色并防撞单", "p1", "采购业务员", "确认这台机器没有同事在聊，记下机型、成色与卖家挂价；不清楚的写「待核」，别填 0。"),
    (2, "留齐底牌", "存好卖家原话与细节实拍", "p1", "采购业务员", "留好卖家成色承诺、机身实拍图、序列号；卖家暂时拍不出就诚实点「暂时拿不到」。"),
    (3, "算好报价", "锁定三档出价与买货预算", "p1", "采购业务员", "系统按行情算好首轮试探价、目标价、最高出价线，并锁住组里买货预算。"),
    (4, "接管聊天", "让自动助手停嘴再打字", "p2", "采购业务员", "人工插手前先把在路上的自动消息撤回或确认发完，防止两个人同时报价穿帮。"),
    (5, "谈拢价格", "按阶梯谈价并记下口头成交价", "p2", "采购业务员", "点现成话术跟卖家谈价，系统自动拦住内部保密词与超上限报价。"),
    (6, "核对改价", "看闲鱼链接是否真改了价", "p3", "采购业务员", "去闲鱼看一眼卖家改后的价格跟聊好的价是不是一分不差；没改好绝不准付钱。"),
    (7, "付钱锁底", "填付款单号并永久锁死卖家原话", "p3", "采购业务员", "填上真实支付单号，系统自动把卖家当时的标题、原话和照片锁死防抵赖。"),
    (8, "到货验机", "仓库开箱对照买前卖家原话", "p4", "仓库质检", "仓管对照买前卖家原话验机；一致就入良品库完结，有漏报毛病就转入问题订单。"),
    (9, "先点退货", "发现毛病先去闲鱼点退货锁时效", "p4", "采购业务员", "铁律：先在闲鱼申请退货退款锁死 48 小时倒计时，千万别直接点仅退款或私下空谈。"),
    (10, "二次议价", "算清留货账并分轮谈退差价", "p4", "采购业务员", "系统算好开口价、目标价、底线价，一步步喂话术谈退差留货；谈不拢就退货寄回。"),
    (11, "查钱收货", "会计核到账、仓管定去向", "p4", "财务对账 + 仓库质检", "会计核对退款或微信补款真到账，仓管确认机器入库或寄回。"),
    (12, "钱货两清", "完结归档并确认提成", "p4", "系统校验", "钱也清了、货也落定了，正式完结这笔单子并确认你的议价提成。"),
]


def now_iso() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def plus_hours_iso(hours: int) -> str:
    return (datetime.now() + timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")


def json_dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False)


def calc_plan_b_hash(s_cents: int, k_cents: int, r_cents: int, deadline: str) -> str:
    raw = f"{s_cents}|{k_cents}|{r_cents}|{deadline}".encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:16]


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=15.0, check_same_thread=False, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


class ApiError(Exception):
    def __init__(self, status: int, message: str, code: str = "BUSINESS_GUARD"):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code


def require_actor(body: dict[str, Any]) -> dict[str, Any]:
    actor_id = str(body.get("actor_id") or "liming")
    if actor_id not in ROLES:
        raise ApiError(400, f"找不到这个员工账号: {actor_id}")
    return ROLES[actor_id]


def is_actor_practice_done(conn: sqlite3.Connection, actor: dict[str, Any]) -> bool:
    if actor["role"] != "purchaser":
        return True
    row = conn.execute("SELECT * FROM onboarding_progress WHERE actor_id=?", (actor["id"],)).fetchone()
    if not row:
        return False
    return bool(row["chat_guard"] >= 3 and row["price_pay"] >= 3 and row["return_planb"] >= 3)


def check_practice_gate(conn: sqlite3.Connection, actor: dict[str, Any]) -> None:
    if not is_actor_practice_done(conn, actor):
        raise ApiError(
            403,
            f"新手保护锁已开启：「{actor['name']}」还没做完「学」里的 3 个 1 分钟防呆练习，做完就能操作真实订单啦。",
            "PRACTICE_GATE_LOCKED",
        )


def validate_no_zero_placeholder(fields: dict[str, Any]) -> None:
    for label, val in fields.items():
        s = str(val if val is not None else "").strip()
        if not s:
            raise ApiError(400, f"「{label}」还没填：请填写真实情况，暂时拿不到的请写「待核」。", "FIELD_EMPTY")
        if s in ("0", "0.0", "0.00", "无", "不知道"):
            raise ApiError(400, f"「{label}」不能填「{s}」哦：拿不到真实数据时请诚实写「待核」，别拿 0 顶替。", "HONEST_DATA_REQUIRED")


def init_db(force_reset: bool = False) -> None:
    with DB_LOCK:
        if force_reset and os.path.exists(DB_PATH):
            os.remove(DB_PATH)
        conn = get_conn()
        try:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS quota_pool (
                    pool_id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    total_cents INTEGER NOT NULL,
                    reserved_cents INTEGER NOT NULL,
                    spent_cents INTEGER NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS quota_reservations (
                    res_id TEXT PRIMARY KEY,
                    order_ref TEXT NOT NULL,
                    conversation_id TEXT,
                    owner_id TEXT NOT NULL,
                    amount_cents INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    idempotency_key TEXT UNIQUE,
                    note TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS discovery_leads (
                    lead_id TEXT PRIMARY KEY,
                    platform TEXT NOT NULL,
                    product_id TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    model_code TEXT NOT NULL,
                    condition_grade TEXT NOT NULL,
                    seller_name TEXT NOT NULL,
                    seller_price_cents INTEGER NOT NULL,
                    ref_price_cents INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    conversation_id TEXT,
                    source_url TEXT,
                    created_at TEXT NOT NULL,
                    UNIQUE(platform, product_id, account_id)
                );

                CREATE TABLE IF NOT EXISTS window_leases (
                    window_id TEXT PRIMARY KEY,
                    role_mode TEXT NOT NULL,
                    bound_account TEXT NOT NULL,
                    status TEXT NOT NULL,
                    current_task TEXT NOT NULL,
                    last_heartbeat TEXT NOT NULL,
                    boundary_note TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS conversations (
                    conv_id TEXT PRIMARY KEY,
                    account_id TEXT NOT NULL,
                    platform_thread_id TEXT NOT NULL,
                    category_group TEXT NOT NULL,
                    seller_name TEXT NOT NULL,
                    model_code TEXT NOT NULL,
                    title TEXT NOT NULL,
                    seller_price_cents INTEGER NOT NULL,
                    ref_price_cents INTEGER NOT NULL,
                    first_offer_cents INTEGER NOT NULL,
                    target_price_cents INTEGER NOT NULL,
                    ceiling_price_cents INTEGER NOT NULL,
                    agreed_price_cents INTEGER,
                    pause_state TEXT NOT NULL,
                    in_flight_seq INTEGER NOT NULL,
                    context_version INTEGER NOT NULL,
                    context_changed_note TEXT,
                    snapshot_json TEXT NOT NULL,
                    ai_attitude TEXT NOT NULL,
                    ai_confidence INTEGER NOT NULL,
                    ai_evidence TEXT NOT NULL,
                    needs_manual INTEGER NOT NULL,
                    idle_minutes INTEGER NOT NULL,
                    unread_count INTEGER NOT NULL,
                    evidence_urls_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS messages (
                    msg_id TEXT PRIMARY KEY,
                    conv_id TEXT NOT NULL,
                    sender TEXT NOT NULL,
                    sender_label TEXT NOT NULL,
                    text TEXT NOT NULL,
                    quote_cents INTEGER,
                    context_version INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    idempotency_key TEXT UNIQUE,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS negotiation_rounds (
                    round_id TEXT PRIMARY KEY,
                    conv_id TEXT NOT NULL,
                    round_no INTEGER NOT NULL,
                    actor TEXT NOT NULL,
                    proposed_cents INTEGER NOT NULL,
                    floor_ref_cents INTEGER NOT NULL,
                    verdict TEXT NOT NULL,
                    note TEXT,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS pricebook_items (
                    item_id TEXT PRIMARY KEY,
                    model_code TEXT NOT NULL,
                    spec_label TEXT NOT NULL,
                    condition_grade TEXT NOT NULL,
                    version_no INTEGER NOT NULL,
                    ref_price_cents INTEGER NOT NULL,
                    first_offer_cents INTEGER NOT NULL,
                    target_cents INTEGER NOT NULL,
                    ceiling_cents INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    updated_by TEXT NOT NULL,
                    approved_by TEXT,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS policy_configs (
                    key TEXT PRIMARY KEY,
                    label TEXT NOT NULL,
                    value_json TEXT NOT NULL,
                    q_refs TEXT NOT NULL,
                    pending_approval INTEGER NOT NULL,
                    description TEXT NOT NULL,
                    updated_by TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS orders (
                    po_id TEXT PRIMARY KEY,
                    external_order_no TEXT NOT NULL UNIQUE,
                    conv_id TEXT,
                    model_code TEXT NOT NULL,
                    title TEXT NOT NULL,
                    seller_name TEXT NOT NULL,
                    stage TEXT NOT NULL,
                    agreed_cents INTEGER NOT NULL,
                    paid_cents INTEGER,
                    snapshot_id TEXT NOT NULL,
                    snapshot_version INTEGER NOT NULL,
                    snapshot_json TEXT NOT NULL,
                    payment_receipt_no TEXT,
                    tracking_no TEXT,
                    quota_res_id TEXT,
                    source TEXT NOT NULL,
                    rpa_missing_fields_json TEXT NOT NULL,
                    last_event_seq INTEGER NOT NULL,
                    idempotency_key TEXT UNIQUE,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS rpa_events (
                    event_id TEXT PRIMARY KEY,
                    scenario_code TEXT NOT NULL,
                    external_order_no TEXT NOT NULL,
                    event_seq INTEGER NOT NULL,
                    idempotency_key TEXT UNIQUE,
                    outcome TEXT NOT NULL,
                    detail TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS aftersales_tickets (
                    ticket_id TEXT PRIMARY KEY,
                    po_id TEXT NOT NULL,
                    model_code TEXT NOT NULL,
                    sku_sn TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    next_owner_id TEXT,
                    handoff_status TEXT NOT NULL,
                    issue_summary TEXT NOT NULL,
                    responsibility TEXT NOT NULL,
                    stage TEXT NOT NULL,
                    s_market_cents INTEGER NOT NULL,
                    paid_cents INTEGER NOT NULL,
                    k_keep_cost_cents INTEGER NOT NULL,
                    r_replace_cost_cents INTEGER NOT NULL,
                    partial_refund_cents INTEGER NOT NULL,
                    plan_b_calc_hash TEXT,
                    plan_b_keep_net_cents INTEGER,
                    plan_b_replace_net_cents INTEGER,
                    platform_return_no TEXT,
                    platform_deadline_at TEXT,
                    carrier_intercept_status TEXT NOT NULL,
                    stock_disposition TEXT NOT NULL,
                    sla_report_deadline TEXT NOT NULL,
                    sla_daily_clear TEXT NOT NULL,
                    sla_platform_deadline TEXT NOT NULL,
                    evidence_declared TEXT NOT NULL,
                    evidence_warehouse TEXT NOT NULL,
                    evidence_is_placeholder INTEGER NOT NULL,
                    evidence_image_url TEXT,
                    updated_at TEXT NOT NULL,
                    bargain_flow_json TEXT NOT NULL DEFAULT '{}'
                );

                CREATE TABLE IF NOT EXISTS aftersales_bargain_logs (
                    log_id TEXT PRIMARY KEY,
                    ticket_id TEXT NOT NULL,
                    round_no INTEGER NOT NULL,
                    role_side TEXT NOT NULL,
                    speaker_label TEXT NOT NULL,
                    seller_style TEXT NOT NULL,
                    ask_refund_cents INTEGER,
                    text TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS finance_ledger (
                    entry_id TEXT PRIMARY KEY,
                    ticket_id TEXT,
                    po_id TEXT NOT NULL,
                    model_code TEXT NOT NULL,
                    entry_type TEXT NOT NULL,
                    channel TEXT NOT NULL,
                    amount_cents INTEGER NOT NULL,
                    direction TEXT NOT NULL,
                    receipt_id TEXT,
                    verified_by TEXT,
                    status TEXT NOT NULL,
                    note TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS commissions (
                    comm_id TEXT PRIMARY KEY,
                    owner_id TEXT NOT NULL,
                    po_id TEXT NOT NULL,
                    ticket_id TEXT,
                    policy_mode TEXT NOT NULL,
                    estimated_cents INTEGER NOT NULL,
                    confirmed_cents INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    note TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS audit_logs (
                    log_id TEXT PRIMARY KEY,
                    actor_id TEXT NOT NULL,
                    actor_role TEXT NOT NULL,
                    action TEXT NOT NULL,
                    entity_id TEXT NOT NULL,
                    detail TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS onboarding_progress (
                    actor_id TEXT PRIMARY KEY,
                    chat_guard INTEGER NOT NULL,
                    price_pay INTEGER NOT NULL,
                    return_planb INTEGER NOT NULL,
                    tour_done_json TEXT NOT NULL,
                    first_order_checklist_done INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS help_requests (
                    help_id TEXT PRIMARY KEY,
                    actor_id TEXT NOT NULL,
                    page_key TEXT NOT NULL,
                    category TEXT NOT NULL,
                    note TEXT NOT NULL,
                    conv_id TEXT,
                    status TEXT NOT NULL,
                    resolved_by TEXT,
                    rule_draft INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS dev_requests (
                    req_id TEXT PRIMARY KEY,
                    actor_id TEXT NOT NULL,
                    actor_name TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    title TEXT NOT NULL,
                    page_key TEXT NOT NULL,
                    detail TEXT NOT NULL,
                    status TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS procurement_cases (
                    case_id TEXT PRIMARY KEY,
                    code TEXT NOT NULL,
                    title TEXT NOT NULL,
                    category_label TEXT NOT NULL,
                    sub_category TEXT NOT NULL,
                    model_code TEXT NOT NULL,
                    condition_grade TEXT NOT NULL,
                    platform TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    seller_name TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    cover_url TEXT NOT NULL,
                    cover_kind TEXT NOT NULL,
                    lead_id TEXT,
                    conv_id TEXT,
                    po_id TEXT,
                    ticket_id TEXT,
                    pricebook_id TEXT,
                    quota_res_id TEXT,
                    capture_json TEXT NOT NULL,
                    warehouse_check_state TEXT NOT NULL,
                    warehouse_check_note TEXT NOT NULL,
                    review_decision TEXT NOT NULL,
                    review_note TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    prebuy_eval_json TEXT NOT NULL DEFAULT '{}'
                );

                CREATE TABLE IF NOT EXISTS case_governance_stages (
                    case_id TEXT NOT NULL,
                    stage_no INTEGER NOT NULL,
                    name TEXT NOT NULL,
                    state TEXT NOT NULL,
                    version_no INTEGER NOT NULL,
                    note TEXT NOT NULL,
                    submitted_by TEXT,
                    latest_verdict TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (case_id, stage_no)
                );

                CREATE TABLE IF NOT EXISTS case_governance_reviews (
                    review_id TEXT PRIMARY KEY,
                    case_id TEXT NOT NULL,
                    stage_no INTEGER NOT NULL,
                    version_no INTEGER NOT NULL,
                    reviewer_id TEXT NOT NULL,
                    reviewer_name TEXT NOT NULL,
                    verdict TEXT NOT NULL,
                    comment TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS corp_alipay_registrations (
                    reg_id TEXT PRIMARY KEY,
                    ticket_id TEXT NOT NULL UNIQUE,
                    po_id TEXT NOT NULL,
                    case_id TEXT,
                    original_paid_cents INTEGER NOT NULL,
                    agreed_payout_cents INTEGER NOT NULL,
                    bargain_saved_cents INTEGER NOT NULL,
                    platform_close_no TEXT NOT NULL,
                    seller_alipay_account TEXT NOT NULL,
                    seller_alipay_name TEXT NOT NULL,
                    register_note TEXT NOT NULL,
                    registered_by TEXT NOT NULL,
                    approval_batch_rule TEXT NOT NULL,
                    expected_approve_at TEXT NOT NULL,
                    approval_status TEXT NOT NULL,
                    approved_by TEXT,
                    approved_at TEXT,
                    alipay_corp_receipt_no TEXT,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS favorite_sellers (
                    seller_id TEXT PRIMARY KEY,
                    seller_name TEXT NOT NULL,
                    owner_id TEXT NOT NULL,
                    scope TEXT NOT NULL DEFAULT 'personal',
                    tags_json TEXT NOT NULL DEFAULT '[]',
                    note TEXT NOT NULL DEFAULT '',
                    platform_url TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS executor_jobs (
                    job_id TEXT PRIMARY KEY,
                    window_id TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    conv_id TEXT,
                    product_id TEXT,
                    job_type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    context_version INTEGER NOT NULL DEFAULT 1,
                    payload_json TEXT NOT NULL DEFAULT '{}',
                    platform_message_id TEXT,
                    error_msg TEXT,
                    idempotency_key TEXT UNIQUE,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS item_snapshots (
                    product_id TEXT NOT NULL,
                    version_no INTEGER NOT NULL,
                    source_url TEXT NOT NULL,
                    title_raw TEXT NOT NULL,
                    description_raw TEXT NOT NULL,
                    quality_raw TEXT NOT NULL,
                    specs_raw TEXT NOT NULL,
                    asking_price_text TEXT NOT NULL,
                    images_json TEXT NOT NULL DEFAULT '[]',
                    captured_at TEXT NOT NULL,
                    PRIMARY KEY (product_id, version_no)
                );

                CREATE TABLE IF NOT EXISTS statement_batches (
                    batch_id TEXT PRIMARY KEY,
                    bill_date TEXT NOT NULL,
                    uploaded_by TEXT NOT NULL,
                    uploaded_at_label TEXT NOT NULL,
                    account_scope TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'open_diff',
                    signed_off_by TEXT,
                    signed_off_at TEXT,
                    created_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS statement_items (
                    stmt_item_id TEXT PRIMARY KEY,
                    batch_id TEXT NOT NULL,
                    alipay_tx_no TEXT NOT NULL UNIQUE,
                    external_order_no TEXT NOT NULL,
                    account_id TEXT NOT NULL,
                    counterparty_name TEXT NOT NULL,
                    item_title TEXT NOT NULL,
                    model_guess TEXT NOT NULL,
                    amount_cents INTEGER NOT NULL,
                    direction TEXT NOT NULL DEFAULT 'outflow',
                    tx_time TEXT NOT NULL,
                    resolution_state TEXT NOT NULL DEFAULT 'auto',
                    resolved_po_id TEXT,
                    resolved_case_id TEXT,
                    resolution_note TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS account_risk_stats (
                    account_id TEXT PRIMARY KEY,
                    account_label TEXT NOT NULL,
                    bound_window TEXT NOT NULL,
                    rolling_30d_orders INTEGER NOT NULL,
                    rolling_30d_refunds INTEGER NOT NULL,
                    rolling_30d_disputes INTEGER NOT NULL,
                    redline_pct REAL NOT NULL DEFAULT 5.0,
                    warn_pct REAL NOT NULL DEFAULT 3.8,
                    note TEXT NOT NULL DEFAULT '',
                    updated_at TEXT NOT NULL
                );
                """
            )
            cols_onb = {r["name"] for r in conn.execute("PRAGMA table_info(onboarding_progress)")}
            if "first_order_checklist_done" not in cols_onb:
                conn.execute("ALTER TABLE onboarding_progress ADD COLUMN first_order_checklist_done INTEGER NOT NULL DEFAULT 0")
            cols_help = {r["name"] for r in conn.execute("PRAGMA table_info(help_requests)")}
            if "rule_draft" not in cols_help:
                conn.execute("ALTER TABLE help_requests ADD COLUMN rule_draft INTEGER NOT NULL DEFAULT 0")
            cols_cases = {r["name"] for r in conn.execute("PRAGMA table_info(procurement_cases)")}
            if "prebuy_eval_json" not in cols_cases:
                conn.execute("ALTER TABLE procurement_cases ADD COLUMN prebuy_eval_json TEXT NOT NULL DEFAULT '{}'")
            cols_tks = {r["name"] for r in conn.execute("PRAGMA table_info(aftersales_tickets)")}
            if "bargain_flow_json" not in cols_tks:
                conn.execute("ALTER TABLE aftersales_tickets ADD COLUMN bargain_flow_json TEXT NOT NULL DEFAULT '{}'")
            cols_convs = {r["name"] for r in conn.execute("PRAGMA table_info(conversations)")}
            if "seller_id" not in cols_convs:
                conn.execute("ALTER TABLE conversations ADD COLUMN seller_id TEXT NOT NULL DEFAULT ''")
            if "slow_group" not in cols_convs:
                conn.execute("ALTER TABLE conversations ADD COLUMN slow_group INTEGER NOT NULL DEFAULT 0")
            if "wait_seconds" not in cols_convs:
                conn.execute("ALTER TABLE conversations ADD COLUMN wait_seconds INTEGER NOT NULL DEFAULT 95")
            if "matched_status" not in cols_convs:
                conn.execute("ALTER TABLE conversations ADD COLUMN matched_status TEXT NOT NULL DEFAULT 'matched'")

            row = conn.execute("SELECT COUNT(*) AS c FROM quota_pool").fetchone()
            if row["c"] == 0:
                seed_db(conn)
            else:
                if conn.execute("SELECT COUNT(*) AS c FROM onboarding_progress").fetchone()["c"] == 0:
                    seed_onboarding(conn)
                if conn.execute("SELECT COUNT(*) AS c FROM procurement_cases").fetchone()["c"] == 0:
                    seed_cases_and_governance(conn)
                if conn.execute("SELECT COUNT(*) AS c FROM statement_batches").fetchone()["c"] == 0:
                    seed_statement_reconciliation(conn)
        finally:
            conn.close()


def seed_onboarding(conn: sqlite3.Connection) -> None:
    ts = now_iso()
    conn.executemany(
        "INSERT OR IGNORE INTO onboarding_progress (actor_id, chat_guard, price_pay, return_planb, tour_done_json, first_order_checklist_done, updated_at) VALUES (?,?,?,?,?,?,?)",
        [
            ("liming", 3, 3, 3, '["today"]', 0, ts),
            ("wangzg", 3, 3, 3, '["today","cases","case-detail"]', 1, ts),
            ("zhaocg", 3, 3, 3, '["case-detail"]', 1, ts),
            ("chenkj", 3, 3, 3, '["ledger"]', 1, ts),
            ("newbie", 0, 0, 0, "[]", 0, ts),
        ],
    )
    conn.execute(
        "INSERT OR IGNORE INTO help_requests (help_id, actor_id, page_key, category, note, conv_id, status, resolved_by, rule_draft, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        ("HELP-1001", "liming", "索尼A7M4谈价单", "卖家价格高于上限", "卖家咬定 10300 不降，我最高只能出到 10200，请王主管看看能不能特批加 100", "CONV-002", "open", None, 0, ts),
    )
    conn.executemany(
        "INSERT OR IGNORE INTO dev_requests VALUES (?,?,?,?,?,?,?,?,?)",
        [
            ("DEV-301", "liming", "李明", "feature", "闲鱼悬浮窗希望能一键复制卖家原话", "闲鱼聊天助手", "每次手动核对成色原话容易漏字，点一下带过去更省事。", "待评审", ts),
            ("DEV-302", "zhaocg", "赵仓管", "bug", "手机端看验货对照表希望字再大一号", "订单详情页", "仓库灯光暗，单手拿手机核对序列号需要大字。", "已验收", ts),
        ],
    )


def log_audit(conn: sqlite3.Connection, actor_id: str, action: str, entity_id: str, detail: str) -> None:
    role_info = ROLES.get(actor_id, {"role_label": actor_id})
    lid = f"LOG-{int(time.time() * 1000)}-{hashlib.md5((action + entity_id + detail + str(time.time_ns())).encode()).hexdigest()[:6]}"
    conn.execute(
        "INSERT INTO audit_logs (log_id, actor_id, actor_role, action, entity_id, detail, created_at) VALUES (?,?,?,?,?,?,?)",
        (lid, actor_id, role_info["role_label"], action, entity_id, detail, now_iso()),
    )


def make_capture(decl_st: str, decl_d: str, photo_st: str, photo_d: str, sn_st: str, sn_d: str, shot_st: str, shot_d: str) -> str:
    return json_dumps(
        {
            "declaration": {"name": "卖家成色与瑕疵原话", "state": decl_st, "detail": decl_d},
            "photos": {"name": "卖家机身细节实拍图", "state": photo_st, "detail": photo_d},
            "serial_report": {"name": "序列号 / 验机或快门图", "state": sn_st, "detail": sn_d},
            "price_shot": {"name": "闲鱼改价 / 仓库开箱图", "state": shot_st, "detail": shot_d},
        }
    )


def make_prebuy_eval(
    evaluated: bool,
    wrote_like_new: bool,
    blurry_photos: bool,
    fully_disclosed: bool,
    suspect_tag: bool,
    focus_points: list[str],
    note_to_wh: str,
) -> str:
    return json_dumps(
        {
            "evaluated": evaluated,
            "seller_wrote_like_new": wrote_like_new,
            "photos_blurry_incomplete": blurry_photos,
            "defects_fully_disclosed": fully_disclosed,
            "suspect_condition_tag": suspect_tag,
            "warehouse_focus_points": focus_points,
            "buyer_note_to_warehouse": note_to_wh,
        }
    )


def make_bargain_flow(
    hit_prebuy_tag: bool = True,
    prebuy_focus: str = "",
    step1_done: bool = True,
    route_choice: str = "bargain_keep",
    return_mode: str = "station_refuse",
    step3_signal: str = "",
    seller_proactive_words: str = "",
    step4_calc_done: bool = False,
    step5_round1_done: bool = False,
    silence_6s_done: bool = False,
    step6_round2_done: bool = False,
    selected_meso: str = "",
    step7_cooldown_done: bool = False,
    cooldown_mins: int = 35,
    cooldown_outcome: str = "",
    disclosure_complete: bool = False,
    erp_material_archived: bool = False,
    wh_10m_result_mins: int = 6,
    waybill_refused_verified: bool = False,
    seller_wechat_added: bool = False,
    seller_wechat_id: str = "",
    sf_95338_status: str = "station_hold",
    wechat_4elem_confirmed: bool = False,
    arrival_track: str = "",
) -> str:
    resolved_track = arrival_track or ("signed_platform_return" if return_mode == "platform_return" else "sf_express_refuse")
    return json_dumps(
        {
            "hit_prebuy_tag": hit_prebuy_tag,
            "prebuy_focus": prebuy_focus,
            "step1_triage_done": step1_done,
            "route_choice": route_choice,
            "return_mode": return_mode,
            "arrival_track": resolved_track,
            "wh_10m_result_mins": wh_10m_result_mins,
            "waybill_refused_verified": waybill_refused_verified,
            "seller_wechat_added": seller_wechat_added,
            "seller_wechat_id": seller_wechat_id,
            "sf_95338_status": sf_95338_status,
            "wechat_4elem_confirmed": wechat_4elem_confirmed,
            "step3_signal": step3_signal,
            "step3_signal_done": bool(step3_signal),
            "seller_proactive_words": seller_proactive_words,
            "step4_calc_done": step4_calc_done,
            "step5_round1_done": step5_round1_done,
            "silence_6s_done": silence_6s_done,
            "step6_round2_done": step6_round2_done,
            "selected_meso": selected_meso,
            "step7_cooldown_done": step7_cooldown_done,
            "cooldown_mins": cooldown_mins,
            "cooldown_outcome": cooldown_outcome,
            "disclosure_complete": disclosure_complete,
            "erp_material_archived": erp_material_archived,
        }
    )


def seed_cases_and_governance(conn: sqlite3.Connection) -> None:
    ts = now_iso()
    cases = [
        # ---------------- 今天采购的 (4单：突出「二次议价潜力研判 + 别多嘴追问 + 给仓管打重点验机标」) ----------------
        (
            "CASE-003", "今日第1单", "MacBook Pro 14 M3 16+512（卖家写『几乎全新』且底壳图模糊 · 沉底老帖）",
            "电脑办公", "笔记本电脑", "MBP14-M3-16-512", "几乎全新 · 底壳图模糊", "闲鱼", "沉底老帖捡漏", "闲鱼主号1",
            "极客小林", "liming", "", "卖家模糊远景图",
            "LEAD-901", "CONV-005", None, None, "PB-004", None,
            make_capture("ok", "链接原话已锁死：成色栏写『几乎全新』，正文写『自用爱惜无磕碰，配件全』（记住：千万别追问有没有划痕！）",
                         "ok", "已原样保存卖家 2 张昏暗远景图（底壳和四角没拍清——别让卖家补拍，留作到货核验底牌！）",
                         "ok", "型号配置已从关于本机截图确认为 M3 16+512",
                         "missing", "待研判二次议价空间并谈价"),
            "pending", "待采购打上『质疑成色·重点验机』标记后谈价", "继续", "典型二次议价肥单：卖家写几乎全新但图模糊，千万别追问，直接按链接标准买并给仓管打重点验机标", ts,
            make_prebuy_eval(
                False, True, True, False, True,
                ["强光查屏幕划痕/亮斑坏点", "查底壳与四角磕碰露白", "核充电器与磁吸线是否原装", "核电池循环次数是否虚标"],
                "【高危-几乎全新·质疑成色】卖家标几乎全新但照片昏暗没拍底壳，买前按规矩未追问，到货请赵仓管一镜到底重点抓外观划痕与配件真伪！",
            ),
        ),
        (
            "CASE-004", "今日第2单", "华硕 TUF 27寸 2K 240Hz 电竞显示器（顺丰正在派送 · 仓管 10 分钟内极速返回结果！）",
            "电脑外设", "显示器", "ASUS-VG27AQML1A", "派送中 · 仓管10分钟极速验", "闲鱼", "常备款批量扫盘", "闲鱼副号2",
            "上海玩家大刘", "liming", "./evidence/IMG_5881.PNG", "买前模糊商品图",
            None, "CONV-003", "PO-20261114-04", None, "PB-003", None,
            make_capture("ok", "链接原话已锁死：『99新几乎全新，原盒包装在，完美屏无坏点』",
                         "ok", "卖家只拍了关机黑屏正面照，没拍箱内泡沫和纯白亮屏（买前未追问已直接拍下）",
                         "partial", "背面铭牌序列号待仓管派送现场核对（买前可随时补录）",
                         "ok", "顺丰派送员刚到仓库门口！启动【仓管 10 分钟极速验货 SLA】速战速决"),
            "pending", "⚡ 顺丰正在派送！赵仓管必须在 10 分钟内速战速决返回结果（缺件/无泡沫当场拒签并拍面单拒签状态！）", "继续", "派送触发仓管10分钟极速出结果 + 拒签后采购10分钟加微无缝衔接样板", ts,
            make_prebuy_eval(
                True, True, True, False, True,
                ["核原盒内是否有原厂泡沫内衬（只有外纸箱当场拒签）", "纯白/纯黑/红绿蓝背景测屏幕划痕亮斑", "清点原装DP线/电源砖/底座支架螺丝齐全"],
                "【派送10分钟极速验】卖家写『几乎全新原盒』但没拍泡沫和亮屏细节，派送员在场请赵仓管 10 分钟内返回结果，不符当场拒签并拍面单！",
            ),
        ),
        (
            "CASE-001", "今日第3单", "iPhone 15 Pro 256G 国行原色（卖家标充新99新 · 已谈妥待核改价付钱）",
            "手机数码", "智能手机", "IP15P-256-NAT", "99新充新 · 已标仓管重点验", "闲鱼", "按客户单去买", "闲鱼主号1",
            "诚实果粉阿Ken", "liming", "./evidence/IMG_5878.PNG", "卖家实拍图",
            "LEAD-903", "CONV-001", "PO-20261114-01", None, "PB-001", "RES-1001",
            make_capture("ok", "卖家原话：国行双卡，充新零划痕，电池93%，原盒配件都在",
                         "ok", "已存 2 张正面与关于本机图（边框细节光线偏暗，未多问）",
                         "ok", "爱思截图已存，到仓需二次实测",
                         "ok", "卖家已把闲鱼链接改成 ¥4,620，核对无误待付钱"),
            "pending", "还没到货验机", "继续", "已打成色质疑标交仓管重点查屏幕微划痕与气密", ts,
            make_prebuy_eval(
                True, True, False, False, True,
                ["强光侧照查屏幕微划痕与疏油层", "查钛金属边框磕碰掉漆", "实测爱思全绿与面容原彩"],
                "卖家标充新零划痕，买前未追问边框细节，到仓请重点强光验外观成色。",
            ),
        ),
        (
            "CASE-002", "今日第4单", "Sony A7M4 全画幅微单机身（卖家已拍清瑕疵 · 买前严守上限谈价）",
            "摄影器材", "微单相机", "SONY-A7M4-BODY", "93新 · 卖家已披露掉漆", "闲鱼", "常备款批量扫盘", "闲鱼主号1",
            "杭州影像老周", "liming", "./evidence/IMG_5881.PNG", "卖家高清瑕疵图",
            None, "CONV-002", None, None, "PB-002", None,
            make_capture("ok", "卖家原话：快门1.1万，军舰部和底角有两处掉漆已拍微距特写，功能全好",
                         "ok", "卖家高清拍齐了每一处掉漆（瑕疵已全披露，到货无法拿掉漆二次议价！）",
                         "ok", "快门数与底壳序列号清晰可见",
                         "partial", "卖家咬住 10300 比上限高 100，待压价或问主管"),
            "pending", "还没拍下", "调整", "反例教学：卖家已把瑕疵拍得一清二楚，到货没法二次议价，买前价格绝不能松口超上限！", ts,
            make_prebuy_eval(
                True, False, False, True, False,
                ["常规核对 CMOS 无坏点进灰与快门数一致"],
                "卖家买前已高清披露全部掉漆瑕疵，到货无二次议价空间，买前严控出价上限。",
            ),
        ),

        # ---------------- 二次议价 · 问题订单 (6单：完整覆盖双10分钟拒签加微 + 首刀对半砍 + 假装不在意游说 + 强硬勉强收下 + 整单退对公T+1！) ----------------
        (
            "CASE-005", "二次议价1", "iPad Pro 11 M2 256G（派送6分钟验出2cm亮斑当场拒签 → 业务员10分钟内确认面单拒签+加微信！）",
            "平板数码", "平板电脑", "IPADP11-M2-256", "拒签10分钟响应 · 确认面单+加微", "闲鱼", "派送拒签闪电战", "闲鱼主号1",
            "合肥二手电子", "liming", "./evidence/IMG_5881.PNG", "仓管拒签现场实拍",
            "LEAD-902", None, "PO-20261110-03", "TK-2401", None, None,
            make_capture("ok", "买前锁死快照：卖家写『几乎全新，屏幕完美无亮斑无磕碰』（买前未多问）",
                         "ok", "买前模糊原图已锁死存档",
                         "ok", "机身序列号 SN-DLX9203 核对一致",
                         "ok", "⚡ 赵仓管派送 6 分钟极速返回结果：纯白屏左下角 2cm 亮斑，已当场拒签并拍拒签视频！"),
            "defect", "⚡ 黄金10分钟倒计时中：请李明在 10 分钟内①确认面单上已显示『拒签』+ ②第一时间电联加上卖家微信速战速决！", "调整", "拒签后第一时间加对方微信，10分钟内响应并确认面单显示拒签", ts,
            make_prebuy_eval(True, True, True, False, True, ["纯白背景查屏幕亮斑老化", "查四角磕碰"], "买前已打几乎全新成色质疑标，派送6分钟抓出2cm亮斑当场拒签！"),
        ),
        (
            "CASE-011", "二次议价2", "ROG 27寸 2K 电竞显示器（拒签已加卖家微信 laze · 首刀半价砍 ¥700 逼卖家着急挽留）",
            "电脑外设", "显示器", "ROG-XG27ACS-2K", "二次议价 · 首刀半价砍+假装不在意", "闲鱼", "还原laze实战录像", "闲鱼主号1",
            "个人卖家 laze", "liming", "./evidence/IMG_5881.PNG", "拒签无泡沫实拍",
            None, None, "PO-20261113-11", "TK-2404", None, None,
            make_capture("ok", "买前锁死快照：卖家写『99新原盒全套无划痕』（原单实付 ¥1,400）",
                         "ok", "面单已显示拒签 + 8分钟内已加上卖家微信 laze",
                         "ok", "屏幕未碎亮屏正常，序列号一致",
                         "ok", "赵仓管7分钟极速拒签实拍：无原厂泡沫内衬 + 缺DP线 + 右边框2处磕碰掉漆"),
            "defect", "面单已显拒签并加上微信 laze！准备首刀直接半价砍（报『700可以接受』），若卖家急问退200行不行，假装毫不在意回『不用了，谢谢』游说！", "继续", "1:1还原实战录屏：首刀半价大砍，卖家急问便宜点别退时假装不在意推开，砍得越多10%到货提成越多！", ts,
            make_prebuy_eval(True, True, True, False, True, ["查原盒泡沫内衬", "查DP线与屏幕边框"], "派送当场抓出无泡沫缺DP线拒签加微"),
        ),
        (
            "CASE-006", "二次议价3", "MacBook Pro 14 M3 16+512（卖家急问『退250行不行别退了』· 欲擒故纵游说拆招中）",
            "电脑办公", "笔记本电脑", "MBP14-M3-16-512", "二次议价 · 第6步欲擒故纵游说", "闲鱼", "买前打标命中", "闲鱼主号1",
            "苏州数码工作室", "liming", "./evidence/IMG_5881.PNG", "仓库瑕疵实拍",
            None, None, "PO-20261112-08", "TK-2402", "PB-004", "RES-1002",
            make_capture("ok", "买前锁死快照：『几乎全新，原装充电器，几乎无划痕，循环18次』",
                         "ok", "已加卖家微信并发去杂牌头+底壳深划痕原片",
                         "ok", "序列号 SN-C02XY771 核对无拆修",
                         "ok", "赵仓管实拍：配的是第三方杂牌头（换原装头成本 ¥80）+ 底壳 2.5cm 露白深划痕"),
            "defect", "卖家怕退回折腾着急问『退250行不行别退回来了』——先假装不在意说『不用了谢谢』再算清退回三笔亏本账往目标价收口！", "继续", "卖家越着急挽留越要稳住高位游说，叠加到货10%提成", ts,
            make_prebuy_eval(True, True, True, False, True, ["查底壳划痕", "核充电头是否原装"], "买前打标精准抓出杂牌头与底壳深划痕"),
        ),
        (
            "CASE-009", "二次议价4", "Steam Deck OLED 1TB 掌机（卖家极强硬打 95338 退回 ·『嫌弃式勉强收下』保利润 vs 二次回拨）",
            "游戏设备", "掌上游戏机", "STEAMDECK-OLED-1T", "二次议价 · 第7步强硬95338应对", "闲鱼", "强硬95338双路线样板", "闲鱼主号1",
            "南京强硬卖家阿强", "liming", "./evidence/IMG_5878.PNG", "仓库磕碰实拍",
            None, None, "PO-20261113-06", "TK-2403", None, None,
            make_capture("ok", "买前锁死快照：卖家写『95新无明显磕碰』（买前 ¥3,400 捡漏拍下，市场稳卖 ¥3,950！）",
                         "ok", "已加微信，卖家嘴硬回：『我打 95338 已经让顺丰退回了』",
                         "ok", "序列号核对一致，顺丰 95338 召回拦截监控中",
                         "ok", "赵仓管实拍：右上角磕碰 + 背壳划痕（💎 算账发现：哪怕0退差留货仍净赚 ¥530！）"),
            "defect", "卖家态度极强硬已打 95338 喊退！本单属急用捡漏盈利单（保底净赚 ¥530）：可用『算了吧太急了，虽然这么烂我也勉强收下』保面子留货并撤 95338，或打二次回拨压底线！", "调整", "完美落地老板双杀策略：强硬卖家既可二次回拨，又可嫌弃式勉强收下吃稳保底利润（严禁赌气退走肥肉！）", ts,
            make_prebuy_eval(True, False, True, False, True, ["查机身四角磕碰", "查摇杆漂移与背壳划痕"], "背壳图模糊打标命中"),
        ),
        (
            "CASE-012", "二次议价5", "戴尔 U2723QE 27寸 4K 显示器（原单 ¥2,000 议价 ¥800 成交 · 整单退关单+支付宝对公登记）",
            "电脑外设", "4K专业显示器", "DELL-U2723QE-4K", "二次议价 · 第8步整单退+对公登记", "闲鱼", "2000砍到800主推样板", "闲鱼主号1",
            "设计师老周", "liming", "./evidence/IMG_5881.PNG", "仓库瑕疵实拍",
            None, None, "PO-20261116-12", "TK-2412", None, None,
            make_capture("ok", "买前锁死快照：卖家标『几乎全新无暗病，原装全套线材在』（原单实付 ¥2,000）",
                         "ok", "买前模糊原图与完整议价录屏已锁存",
                         "ok", "面板未碎正常点亮，序列号 SN-DL2723Q99 一致",
                         "ok", "仓检实拍：右侧大块发红暗斑 + 缺原装雷电4线 + 支架明显磕碰；电话已谈妥 ¥800 留货（省 ¥1,200！）"),
            "defect", "已谈妥 ¥800 成交！大额折让严禁走平台部分退款（防账号红标/防卖家差评/防平台二次申诉），请去第 8 步整单全退关单并登记支付宝对公支付（财务次日10:00 T+1审批）", "继续", "核心风控锚点：2000谈成800不走部分退款，整单退掉关闭脱离平台管辖 + 支付宝对公支付登记交财务次日10点T+1审批", ts,
            make_prebuy_eval(True, True, True, False, True, ["纯白屏测四角发红暗斑", "核原装雷电4线与支架"], "买前写几乎全新未追问，到货抓出暗斑从 ¥2,000 谈到 ¥800 成交！"),
        ),
        (
            "CASE-007", "二次议价6", "Apple iMac 27寸 一体机（整单全退关单 + 已登记支付宝对公支付 ¥850 · 待次日10:00财务T+1审批）",
            "电脑办公", "台式一体机", "IMAC27-5K-SSD", "二次议价 · 第9步T+1审批入库", "闲鱼", "整单退+对公支付样板", "闲鱼主号1",
            "同城卖家阿哲", "liming", "./evidence/IMG_5878.PNG", "真实聊天与实拍",
            None, None, "PO-20261108-01", "TK-SAMPLE", None, None,
            make_capture("ok", "买前卖家声明：『27寸办公用没啥磕碰，500G固态硬盘，带键鼠』",
                         "ok", "已留存完整 16 张真实议价过程截图（完整披露不截半截）",
                         "ok", "机身序列号 SN-F2LX8801 已绑定 ERP 单件",
                         "ok", "到货实测机械盘开机两分多钟 → 谈妥 ¥850 留货 → 闲鱼整单全退关闭脱离平台管辖 + 已登记支付宝对公支付 ¥850（次日10:00 T+1审批）"),
            "defect", "闲鱼整单全退关单已核实（零差评零二次申诉风险）；已做好支付宝对公支付 ¥850 订单登记，待陈会计次日 10:00 按 T+1 账单审批打款 + 赵仓管入库", "继续", "整单全退脱离平台管辖 + 支付宝对公支付 T+1（次日10:00）财务审批双闭环样板", ts,
            make_prebuy_eval(True, False, True, False, True, ["实测硬盘读写是否为真固态", "查屏幕老化红边"], "买前未追问硬盘截图，到货实测抓出机械盘大砍成功"),
        ),

        # ---------------- 已经完结的 (2单：正常入库10%样板 + 二次议价两段各10%独立核算+ERP自取样板) ----------------
        (
            "CASE-008", "完结单1", "AirPods Pro 2 USB-C 国行在保（验机全对 · 已入良品库 · 买前10%提成已发）",
            "智能音频", "蓝牙耳机", "APP2-USBC-CN", "充新全套 · 已入良品库", "闲鱼", "常备款批量扫盘", "闲鱼主号1",
            "滨江果粉小陈", "liming", "./evidence/IMG_5878.PNG", "入库实拍图",
            None, None, "PO-20261111-09", None, None, None,
            make_capture("ok", "卖家原话：直营店购入带电子票，耳塞未拆封，零磕碰",
                         "ok", "充电盒与耳机微距实拍齐全",
                         "ok", "官网保修至 2027-03，三码合一通过",
                         "ok", "改价 ¥1,120 核对无误，仓库验机全对已入良品库 A-03-12"),
            "passed", "仓库验机跟卖家说的一模一样，已入良品库 A-03-12", "扩大", "买前比参考价省 ¥180，10% 提成 ¥18 已发放", ts,
            make_prebuy_eval(True, False, False, True, False, ["核三码合一与降噪通透"], "实拍清晰如实入库"),
        ),
        (
            "CASE-010", "完结单2", "ROG 27寸 2K 180Hz 电竞显示器（买前省¥300拿10% + 到货谈退¥300再拿10% · 合计¥60已发）",
            "电脑外设", "显示器", "ROG-XG27ACS-2K", "二次议价完结 · 两段10%提成已发", "闲鱼", "两段各10%样板", "闲鱼主号1",
            "武汉电竞玩家小凯", "liming", "./evidence/IMG_5881.PNG", "ERP归档瑕疵实拍",
            None, None, "PO-20261109-05", "TK-2409", None, None,
            make_capture("ok", "买前卖家写『几乎全新无划痕』，采购未追问并打质疑标",
                         "ok", "买前快照与完整议价录屏已归档 ERP",
                         "ok", "屏幕面板零坏点，序列号一致",
                         "ok", "底座 3cm 划痕 → 先点退货 → 卖家主动求和 → 3轮谈退 ¥300 到账入库（销售已直接从ERP自取瑕疵图上架！）"),
            "defect", "退差 ¥300 会计已核销到账，机器与瑕疵实拍已归档 ERP 可售库 B-02-08（销售自取免问采购）", "扩大", "买前省¥300×10%=¥30 + 到货退回¥300×10%=¥30（独立计提不重算，合计¥60已发！）", ts,
            make_prebuy_eval(True, True, True, False, True, ["查屏幕划痕坏点", "查底座支架划痕与DP线"], "买前几乎全新打标，到货成功谈退 ¥300 转化高毛利"),
        ),
    ]
    conn.executemany("INSERT OR IGNORE INTO procurement_cases VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", cases)

    # Extra completed, warehouse-arrived & intercept orders/ledger/commissions
    conn.executemany(
        "INSERT OR IGNORE INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
            ("PO-20261114-04", "GF-ORD-778104", "CONV-003", "ASUS-VG27AQML1A", "华硕 TUF 27寸 2K 240Hz 电竞显示器", "上海玩家大刘",
             "shipped", 105000, 105000, "SNAP-CONV003-V2", 2,
             json_dumps({"snapshot_id": "SNAP-CONV003-V2", "snapshot_version": 2, "seller_declaration": "99新几乎全新，原盒包装在，完美屏无坏点"}),
             "PAY-ALI-992104", "SF1488990441", None, "manual", "[]", 5, "seed-po-4", ts, ts),
            ("PO-20261113-11", "GF-ORD-777311", None, "ROG-XG27ACS-2K", "ROG 27寸 2K 电竞显示器", "宁波个人玩家阿杰",
             "shipped", 140000, 140000, "SNAP-PO777311-V2", 2,
             json_dumps({"snapshot_id": "SNAP-PO777311-V2", "snapshot_version": 2, "seller_declaration": "99新原盒全套无划痕"}),
             "PAY-ALI-991811", "SF1488990311", None, "manual", "[]", 5, "seed-po-11", ts, ts),
            ("PO-20261111-09", "GF-ORD-773108", None, "APP2-USBC-CN", "AirPods Pro 2 USB-C 国行在保", "滨江果粉小陈",
             "completed", 112000, 112000, "SNAP-PO773108-V2", 2,
             json_dumps({"snapshot_id": "SNAP-PO773108-V2", "snapshot_version": 2, "seller_declaration": "直营店购入带电子票，三码合一零磕碰"}),
             "PAY-ALI-971209", "SF1488661022", None, "manual", "[]", 6, "seed-po-8", ts, ts),
            ("PO-20261108-01", "GF-ORD-769002", None, "IMAC27-5K-SSD", "Apple iMac 27寸 一体机", "同城卖家阿哲",
             "shipped", 139785, 139785, "SNAP-PO769002-V2", 2,
             json_dumps({"snapshot_id": "SNAP-PO769002-V2", "snapshot_version": 2, "seller_declaration": "27寸办公用没啥磕碰，500G固态硬盘，带键鼠"}),
             "PAY-ALI-960118", "HLL-20261108-01", None, "manual", "[]", 5, "seed-po-7", ts, ts),
            ("PO-20261113-06", "GF-ORD-776890", None, "STEAMDECK-OLED-1T", "Steam Deck OLED 1TB 掌机", "南京玩家阿强",
             "shipped", 340000, 340000, "SNAP-PO776890-V2", 2,
             json_dumps({"snapshot_id": "SNAP-PO776890-V2", "snapshot_version": 2, "seller_declaration": "95新无明显磕碰，摇杆按键完美"}),
             "PAY-ALI-991502", "SF1488990021", None, "manual", "[]", 5, "seed-po-9", ts, ts),
            ("PO-20261116-12", "GF-ORD-779012", None, "DELL-U2723QE-4K", "戴尔 U2723QE 27寸 4K 显示器", "设计师老周",
             "shipped", 200000, 200000, "SNAP-PO779012-V2", 2,
             json_dumps({"snapshot_id": "SNAP-PO779012-V2", "snapshot_version": 2, "seller_declaration": "几乎全新无暗病，原装全套线材在"}),
             "PAY-ALI-998200", "SF1488992000", None, "manual", "[]", 5, "seed-po-12", ts, ts),
            ("PO-20261109-05", "GF-ORD-770315", None, "ROG-XG27ACS-2K", "ROG 27寸 2K 180Hz 电竞显示器", "武汉电竞玩家小凯",
             "completed", 135000, 135000, "SNAP-PO770315-V2", 2,
             json_dumps({"snapshot_id": "SNAP-PO770315-V2", "snapshot_version": 2, "seller_declaration": "箱说全，几乎全新屏幕完美无划痕"}),
             "PAY-ALI-968831", "SF1488603312", None, "manual", "[]", 6, "seed-po-10", ts, ts),
        ],
    )
    conn.executemany(
        "INSERT OR IGNORE INTO finance_ledger VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [
            ("FIN-1004", None, "PO-20261114-04", "ASUS-VG27AQML1A", "po_payment", "闲鱼实付货款", 105000, "outflow", "PAY-ALI-992104", "chenkj", "verified", "华硕27寸显示器买前实付1050元", ts),
            ("FIN-1011", "TK-2404", "PO-20261113-11", "ROG-XG27ACS-2K", "po_payment", "闲鱼实付货款", 140000, "outflow", "PAY-ALI-991811", "chenkj", "verified", "ROG显示器实付1400元", ts),
            ("FIN-1012", "TK-2412", "PO-20261116-12", "DELL-U2723QE-4K", "po_payment", "闲鱼原单实付货款", 200000, "outflow", "PAY-ALI-998200", "chenkj", "verified", "戴尔U2723QE买前实付2000元（已谈妥800元留货，待第8步整单全退关单+登记支付宝对公支付）", ts),
            ("FIN-1008", None, "PO-20261111-09", "APP2-USBC-CN", "po_payment", "闲鱼实付货款", 112000, "outflow", "PAY-ALI-971209", "chenkj", "verified", "AirPods Pro 2 实付核销完结", ts),
            ("FIN-1009", "TK-2409", "PO-20261109-05", "ROG-XG27ACS-2K", "po_payment", "闲鱼实付货款", 135000, "outflow", "PAY-ALI-968831", "chenkj", "verified", "ROG 显示器原实付 1350 元", ts),
            ("FIN-1010", "TK-2409", "PO-20261109-05", "ROG-XG27ACS-2K", "partial_refund", "卖家退回瑕疵差价", 30000, "inflow", "REF-GF-99210", "chenkj", "verified", "底座划痕二次议价退回 300 元已到账", ts),
        ],
    )
    conn.executemany(
        "INSERT OR IGNORE INTO commissions VALUES (?,?,?,?,?,?,?,?,?,?)",
        [
            ("COM-108", "liming", "PO-20261111-09", None, "pre_buy_10_pct", 1800, 1800, "paid", "买前谈价省 ¥180 × 10% = ¥18（验机入库已确认发放）", ts),
            ("COM-109-PRE", "liming", "PO-20261109-05", None, "pre_buy_10_pct", 3000, 3000, "paid", "ROG显示器买前谈价省 ¥300（参考 ¥1,650 − 首轮成交 ¥1,350）× 10% = ¥30（已发放）", ts),
            ("COM-110", "liming", "PO-20261109-05", "TK-2409", "post_arrival_10_pct", 3000, 3000, "paid", "到货瑕疵二次议价退回 ¥300 × 10% = ¥30（钱货两清已发放，两段独立核算不重算）", ts),
            ("COM-112", "liming", "PO-20261116-12", "TK-2412", "post_arrival_10_pct", 12000, 0, "estimated", "戴尔4K显示器原单 ¥2,000 议价至 ¥800 成交（返款差额 ¥1,200 × 10% = 预计 ¥120，待整单退+支付宝对公T+1审批入库确认）", ts),
            ("COM-107", "liming", "PO-20261108-01", "TK-SAMPLE", "post_arrival_10_pct", 5479, 0, "estimated", "27寸一体机二次议价（整单全退关单+支付宝对公支付 ¥850，折让差额 ¥547.85 × 10% = 预计 ¥54.79，待次日10:00 T+1审批确认）", ts),
        ],
    )
    conn.execute(
        "INSERT OR IGNORE INTO corp_alipay_registrations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (
            "ALIPAY-REG-1001", "TK-SAMPLE", "PO-20261108-01", "CASE-007",
            139785, 85000, 54785, "GF-CLOSE-20261108",
            "00038155728", "张哲",
            "闲鱼原单全额退掉关闭交易（防红标/防差评/防二次申诉），改走公司支付宝对公支付 ¥850 给卖家，已随单上传完整16张议价记录供T+1对账审批",
            "liming", "T+1 账单核对 · 次日 10:00 财务审批", "次日 10:00（T+1 账单核对）",
            "pending_t1_10am", None, None, None, ts,
        ),
    )

    stage_names = [(1, "寻源摸底"), (2, "价格核验"), (3, "实操取证"), (4, "结算核销"), (5, "复盘沉淀")]
    for c in cases:
        cid = c[0]
        for sno, sname in stage_names:
            if cid in ("CASE-008", "CASE-010"):
                st, ver, note, sub_by, verd = "done", 1, f"{sname}已归档", "liming", "通过"
            elif cid in ("CASE-006", "CASE-007"):
                if sno <= 3:
                    st, ver, note, sub_by, verd = "done", (2 if sno == 2 and cid == "CASE-006" else 1), f"{sname}已留痕", "liming", "通过"
                elif sno == 4:
                    st, ver, note, sub_by, verd = "doing", 1, "等待核销完结", "liming", ""
                else:
                    st, ver, note, sub_by, verd = "todo", 0, "", None, ""
            elif cid == "CASE-001":
                if sno <= 2:
                    st, ver, note, sub_by, verd = "done", 1, f"{sname}已核对", "liming", "通过"
                elif sno == 3:
                    st, ver, note, sub_by, verd = "submitted", 2, "已补齐爱思报告与卖家改价截图", "liming", ""
                else:
                    st, ver, note, sub_by, verd = "todo", 0, "", None, ""
            else:
                st, ver, note, sub_by, verd = ("doing", 1, "跟进中", "liming", "") if sno == 1 else ("todo", 0, "", None, "")
            conn.execute(
                "INSERT OR IGNORE INTO case_governance_stages VALUES (?,?,?,?,?,?,?,?,?)",
                (cid, sno, sname, st, ver, note, sub_by, verd, ts),
            )

    hist_reviews = [
        ("REV-101", "CASE-001", 3, 1, "wangzg", "王主管", "退回", "v1 缺少爱思验机截图，补齐后再提", ts),
        ("REV-102", "CASE-006", 2, 1, "wangzg", "王主管", "退回", "v1 请补充更换原装充电头 ¥80 折算说明", ts),
        ("REV-103", "CASE-006", 2, 2, "wangzg", "王主管", "通过", "v2 已补齐原装充电头 ¥80 折算依据，准予推进", ts),
    ]
    conn.executemany("INSERT OR IGNORE INTO case_governance_reviews VALUES (?,?,?,?,?,?,?,?,?)", hist_reviews)


def seed_db(conn: sqlite3.Connection) -> None:
    ts = now_iso()
    conn.execute(
        "INSERT INTO quota_pool VALUES (?, ?, ?, ?, ?, ?)",
        ("POOL-202611", "采购组本月买货预算池（2026年11月）", 5000000, 320000, 1260000, ts),
    )

    reservations = [
        ("RES-1001", "PO-20261114-01", "CONV-001", "liming", 320000, "reserved", "seed-res-1001", "iPhone 15 Pro 谈价预留预算", ts, ts),
        ("RES-1002", "PO-20261112-08", "CONV-004", "liming", 480000, "converted", "seed-res-1002", "MacBook Pro M3 已付款", ts, ts),
    ]
    conn.executemany("INSERT INTO quota_reservations VALUES (?,?,?,?,?,?,?,?,?,?)", reservations)

    leads = [
        ("LEAD-901", "goofish", "GF-8812034", "ACC-GF-01", "MacBook Pro 14 M3 16+512 自用无拆修 电池96%", "MBP14-M3-16-512", "98新·准新无磕", "极客小林", 745000, 760000, "new", None, "https://goofish.local/item/8812034", ts),
        ("LEAD-902", "goofish", "GF-8812099", "ACC-GF-01", "iPad Pro 11 M2 256G WiFi 原盒发票在", "IPADP11-M2-256", "95新·轻微痕迹", "杭州数码君", 385000, 390000, "new", None, "https://goofish.local/item/8812099", ts),
        ("LEAD-903", "goofish", "GF-8811801", "ACC-GF-02", "iPhone 15 Pro 256G 原色 24年4月激活", "IP15P-256-NAT", "95新·电池93%", "诚实果粉阿Ken", 485000, 505000, "promoted", "CONV-001", "https://goofish.local/item/8811801", ts),
    ]
    conn.executemany("INSERT INTO discovery_leads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", leads)

    windows = [
        ("WIN-FG-01", "前台人工监督主窗 #1（看真实闲鱼聊天 · 暂停接管 · 核对改价人工下单）", "闲鱼主号1", "active", "正在监督 iPhone 15 Pro / 索尼 A7M4 等 6 个活跃会话", ts, "前台人工主窗 · 单人独占锁"),
        ("WIN-BG-01", "后台执行窗 #1（新链接静默抓多图快照 & 自动首报）", "闲鱼主号1", "active", "已抓 12 份商品原始多图快照，队列待首报 1 条", ts, "后台自动执行 · 幂等去重"),
        ("WIN-BG-02", "后台执行窗 #2（卖家回复持续议价 & 慢慢压价定时巡检）", "闲鱼副号2", "active", "正在按阶梯规则跟进 4 条会话，慢压池低频巡检中", ts, "后台自动执行 · 支持单会话暂停"),
        ("WIN-BG-03", "后台执行窗 #3（已拍订单物流/顺丰派送盯梢专窗 · 触发仓管10m验货）", "闲鱼主号1", "active", "实时盯梢已拍订单顺丰轨迹：一旦进入『派送中』秒推赵仓管 10 分钟极速验货倒计时！", ts, "顺丰派送盯梢专窗 · 已拍板定责"),
    ]
    conn.executemany("INSERT INTO window_leases VALUES (?,?,?,?,?,?,?)", windows)

    snap1 = {
        "snapshot_id": "SNAP-CONV001-V1",
        "snapshot_version": 1,
        "captured_at": ts,
        "seller_title": "iPhone 15 Pro 256G 原色 24年4月激活 无拆修无暗病",
        "seller_declaration": "国行双卡，屏幕原装零划痕，电池93%，原盒配件都在",
        "pricebook_ref_version": "v2",
        "source_type": "卖家实拍截图",
    }
    snap2 = {
        "snapshot_id": "SNAP-CONV002-V1",
        "snapshot_version": 1,
        "captured_at": ts,
        "seller_title": "Sony A7M4 单机身 2024年初购入 快门1.1万",
        "seller_declaration": "CMOS 干净无进灰，包装背带都在，顺丰保价发",
        "pricebook_ref_version": "v2",
        "source_type": "卖家商品图",
    }
    snap3 = {
        "snapshot_id": "SNAP-CONV003-V1",
        "snapshot_version": 1,
        "captured_at": ts,
        "seller_title": "华硕 TUF 27寸 2K 240Hz 电竞显示器 99新几乎全新原盒",
        "seller_declaration": "99新几乎全新，原盒包装在，完美屏无坏点",
        "pricebook_ref_version": "v2",
        "source_type": "卖家模糊商品图",
    }
    snap5 = {
        "snapshot_id": "SNAP-CONV005-V1",
        "snapshot_version": 1,
        "captured_at": ts,
        "seller_title": "MacBook Pro 14 M3 16+512 几乎全新 自用电池96%",
        "seller_declaration": "成色栏：几乎全新；正文：自用爱惜无磕碰，配件全（底壳图模糊未拍清）",
        "pricebook_ref_version": "v2",
        "source_type": "买前锁死快照",
    }

    convs = [
        ("CONV-001", "ACC-GF-01", "GF-TH-901", "bargaining", "诚实果粉阿Ken", "IP15P-256-NAT",
         "iPhone 15 Pro 256G 原色 充新零划痕 电池93%", 485000, 505000, 445000, 460000, 475000, 462000,
         "auto", 0, 2, "卖家确认原装盒在，已在 ¥4,750 上限内谈妥 ¥4,620", json_dumps(snap1),
         "willing_drop", 88, "卖家爽快从 ¥4,850 让到 ¥4,620 并已改好闲鱼链接价（买前已打质疑成色标交仓管重点验）",
         0, 4, 2, json_dumps(["./evidence/IMG_5878.PNG", "./evidence/IMG_5881.PNG"]), ts,
         "SELLER-GF-001", 0, 52, "matched"),
        ("CONV-002", "ACC-GF-01", "GF-TH-902", "urgent_10m", "杭州影像老周", "SONY-A7M4-BODY",
         "Sony A7M4 单机身 快门1.1万（已拍清掉漆瑕疵）", 1080000, 1060000, 960000, 990000, 1020000, None,
         "auto", 0, 1, None, json_dumps(snap2),
         "firm", 76, "卖家已高清披露掉漆，无二次议价空间！卖家最新还价 ¥10,300 仍超上限 ¥100，严守上限或找主管",
         1, 8, 1, json_dumps(["./evidence/IMG_5881.PNG", "./evidence/IMG_5878.PNG"]), ts,
         "SELLER-GF-002", 0, 38, "matched"),
        ("CONV-003", "ACC-GF-02", "GF-TH-903", "bargaining", "上海玩家大刘", "ASUS-VG27AQML1A",
         "华硕 TUF 27寸 2K 240Hz 几乎全新原盒", 120000, 135000, 95000, 105000, 112000, 105000,
         "paused", 0, 1, "按『不追问成色』纪律直接按链接标准 1050 元拍下，后台窗#3盯到派送已推仓管10m验货", json_dumps(snap3),
         "willing_drop", 82, "卖家急出已按 ¥1,050 发货派送中，赵仓管正在 10 分钟极速验货",
         0, 35, 0, json_dumps(["./evidence/IMG_5881.PNG"]), ts,
         "SELLER-GF-003", 0, 140, "matched"),
        ("CONV-005", "ACC-GF-01", "GF-TH-905", "urgent_10m", "极客小林", "MBP14-M3-16-512",
         "MacBook Pro 14 M3 16+512 几乎全新（底壳图模糊）", 745000, 760000, 680000, 710000, 735000, None,
         "auto", 0, 1, None, json_dumps(snap5),
         "willing_drop", 79, "老链接连降3次且标『几乎全新』图很糊——别多嘴问划痕！先打成色质疑标再按链接标准谈价",
         1, 6, 1, json_dumps(["./evidence/IMG_5878.PNG"]), ts,
         "SELLER-GF-005", 1, 29, "matched"),
        ("CONV-006", "ACC-GF-01", "GF-TH-906", "slow_bargain", "阿远的器材柜", "SONY-A7M4-BODY",
         "Sony A7M4 工作室备用机身（不急出 · 慢慢压价跟进中）", 1050000, 1060000, 950000, 980000, 1020000, None,
         "auto", 0, 1, None, json_dumps({
             "snapshot_id": "SNAP-CONV006-V1", "snapshot_version": 1, "captured_at": ts,
             "seller_title": "Sony A7M4 工作室备用机身 快门6500 原盒双电",
             "seller_declaration": "室内备用机，屏幕贴膜，双原装电池+充电器在，不急出慢慢卖",
             "pricebook_ref_version": "v2", "source_type": "商品页多图快照",
         }),
         "firm", 84, "卖家回复『不着急出，低于10300先挂着』，适合移入慢慢压价每 48h 低频跟进",
         0, 125, 0, json_dumps(["./evidence/IMG_5881.PNG", "./evidence/IMG_5878.PNG"]), ts,
         "SELLER-GF-006", 1, 0, "matched"),
        ("CONV-007", "ACC-GF-02", "GF-TH-907", "urgent_10m", "林先生的器材铺", "SONY-A7M4-BODY",
         "Sony A7M4 套机或单机描述冲突（待核对规格后再报价）", 1120000, 1060000, 960000, 990000, 1020000, None,
         "paused", 0, 1, "标题写单机身但正文写含 28-70 套机头，已自动转待核阻止误报价", json_dumps({
             "snapshot_id": "SNAP-CONV007-V1", "snapshot_version": 1, "captured_at": ts,
             "seller_title": "Sony A7M4 国行微单（含28-70镜头可单出）",
             "seller_declaration": "单机身或带28-70镜头都行，先私聊确认要哪套",
             "pricebook_ref_version": "v2", "source_type": "商品页多图快照",
         }),
         "uncertain", 55, "页面同时出现单机身与套机描述，按防错规范停在『规格冲突待核』不乱套价格",
         1, 9, 1, json_dumps(["./evidence/IMG_5878.PNG"]), ts,
         "SELLER-GF-007", 0, 64, "conflict_pending"),
    ]
    conn.executemany("INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", convs)

    msgs = [
        ("MSG-101", "CONV-001", "seller", "诚实果粉阿Ken（卖家）", "国行原色 256G，屏幕零划痕，挂 4850 诚心要可小刀", 485000, 1, "sent", "seed-msg-101", ts),
        ("MSG-102", "CONV-001", "buyer_ai", "自动报价助手", "哥看你机器确实爱惜，原装盒和爱思报告能拍一眼吗？诚心收先报 4450 元看能不能聊。", 445000, 1, "sent", "seed-msg-102", ts),
        ("MSG-103", "CONV-001", "seller", "诚实果粉阿Ken（卖家）", "盒都在，刚发了两张实拍，4450 太低了，最少 4680。", 468000, 2, "sent", "seed-msg-103", ts),
        ("MSG-104", "CONV-001", "buyer_human", "李明（采购员）", "实拍很清楚，我们到货当天就验机打款绝不墨迹，4620 包顺丰保价我现在直接拍？", 462000, 2, "sent", "seed-msg-104", ts),
        ("MSG-105", "CONV-001", "seller", "诚实果粉阿Ken（卖家）", "行，看你爽快，4620 我改好链接价格了，你核对一下直接拍吧。", 462000, 2, "sent", "seed-msg-105", ts),
        ("MSG-201", "CONV-002", "seller", "杭州影像老周（卖家）", "A7M4 快门一万一，两处掉漆特写我都拍得清清楚楚了，挂 10800 诚心要小刀。", 1080000, 1, "sent", "seed-msg-201", ts),
        ("MSG-202", "CONV-002", "buyer_ai", "自动报价助手", "理解老师，看到掉漆实拍了，我们诚心收首报 9600 元今天直接拍下付款。", 960000, 1, "sent", "seed-msg-202", ts),
        ("MSG-203", "CONV-002", "seller", "杭州影像老周（卖家）", "9600 不可能，最少 10500。", 1050000, 1, "sent", "seed-msg-203", ts),
        ("MSG-204", "CONV-002", "buyer_human", "李明（采购员）", "老师两处掉漆二次销售得折一点，9900 元包顺丰保价能走我现在秒拍。", 990000, 1, "sent", "seed-msg-204", ts),
        ("MSG-205", "CONV-002", "seller", "杭州影像老周（卖家）", "最低 10300，少一分不卖，刚还有同城自提问我。", 1030000, 1, "sent", "seed-msg-205", ts),
        ("MSG-301", "CONV-003", "seller", "上海玩家大刘（卖家）", "华硕 27寸 240Hz 原盒都在，挂 1200 急出腾桌子。", 120000, 1, "sent", "seed-msg-301", ts),
        ("MSG-302", "CONV-003", "buyer_human", "李明（采购员）", "老板看你写了原盒完美屏，1050 包顺丰我现在直接拍下（买前不追问成色细节）。", 105000, 1, "sent", "seed-msg-302", ts),
        ("MSG-303", "CONV-003", "seller", "上海玩家大刘（卖家）", "行 1050 改好了，今天给你发顺丰！", 105000, 1, "sent", "seed-msg-303", ts),
        ("MSG-501", "CONV-005", "seller", "极客小林（卖家）", "MacBook Pro 14 M3 16+512 自用几乎全新，从 7900 连降三次到 7450 了。", 745000, 1, "sent", "seed-msg-501", ts),
        ("MSG-502", "CONV-005", "buyer_ai", "自动报价助手", "哥诚心收这台 M3，6800 元包顺丰今天秒拍秒付可以吗？", 680000, 1, "sent", "seed-msg-502", ts),
        ("MSG-503", "CONV-005", "seller", "极客小林（卖家）", "6800 有点低，7250 差不多。", 725000, 1, "sent", "seed-msg-503", ts),
        ("MSG-601", "CONV-006", "seller", "阿远的器材柜（卖家）", "工作室备用 A7M4 快门才 6500，挂 10500 不急出慢慢卖。", 1050000, 1, "sent", "seed-msg-601", ts),
        ("MSG-602", "CONV-006", "buyer_ai", "自动报价助手", "老板成色确实好，9500 元现款秒结考虑吗？长期收工作室退下来的器材。", 950000, 1, "sent", "seed-msg-602", ts),
        ("MSG-603", "CONV-006", "seller", "阿远的器材柜（卖家）", "不着急出哈，低于 10300 我先挂着，过阵子再看。", 1030000, 1, "sent", "seed-msg-603", ts),
        ("MSG-701", "CONV-007", "seller", "林先生的器材铺（卖家）", "A7M4 单机身或者带 28-70 套头都行，标价 11200 先问清楚要哪套再拍。", 1120000, 1, "sent", "seed-msg-701", ts),
        ("MSG-702", "CONV-007", "system", "防呆拦截卫士", "⚠️ 检测到标题写『单机身』但正文写『含28-70套头』，已暂停自动报价转人工核对规格！", None, 1, "sent", "seed-msg-702", ts),
    ]
    conn.executemany("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?)", msgs)

    rounds = [
        ("RND-100", "CONV-001", 1, "卖家挂牌", 485000, 505000, "初始挂价", "卖家原挂 ¥4,850", ts),
        ("RND-101", "CONV-001", 2, "买方首报", 445000, 505000, "正常", "比公司参考价低 600 元开口", ts),
        ("RND-102", "CONV-001", 3, "卖家还价", 468000, 505000, "接近上限", "卖家从 4850 让到 4680", ts),
        ("RND-103", "CONV-001", 4, "买方拍板", 462000, 505000, "口头谈妥", "低于最高出价线 4750，省了 430 元（预计10%提成 ¥43）", ts),
        ("RND-200", "CONV-002", 1, "卖家挂牌", 1080000, 1060000, "初始挂价", "卖家初始挂 ¥10,800", ts),
        ("RND-201", "CONV-002", 2, "买方首报", 960000, 1060000, "首轮试探", "AI 首轮报 ¥9,600", ts),
        ("RND-202", "CONV-002", 3, "卖家还价", 1050000, 1060000, "高于上限", "卖家首轮松口到 ¥10,500", ts),
        ("RND-203", "CONV-002", 4, "买方二报", 990000, 1060000, "目标价试探", "人工跟进报 ¥9,900", ts),
        ("RND-204", "CONV-002", 5, "卖家咬死", 1030000, 1060000, "超上限待批", "卖家咬住 10300，比上限 10200 高 100", ts),
        ("RND-301", "CONV-003", 1, "卖家挂牌", 120000, 135000, "初始挂价", "卖家急出挂 ¥1,200", ts),
        ("RND-302", "CONV-003", 2, "买方拍板", 105000, 135000, "口头谈妥", "不追问成色直接按 ¥1,050 拍下", ts),
        ("RND-501", "CONV-005", 1, "卖家挂牌", 745000, 760000, "连降老帖", "卖家连降三次挂 ¥7,450", ts),
        ("RND-502", "CONV-005", 2, "买方首报", 680000, 760000, "首轮试探", "后台窗 #1 自动首报 ¥6,800", ts),
        ("RND-503", "CONV-005", 3, "卖家还价", 725000, 760000, "可继续压", "卖家回 ¥7,250，已进上限内可继续往 ¥7,100 压", ts),
        ("RND-601", "CONV-006", 1, "卖家挂牌", 1050000, 1060000, "不急出", "工作室备用机挂 ¥10,500", ts),
        ("RND-602", "CONV-006", 2, "买方首报", 950000, 1060000, "慢压首探", "报 ¥9,500 铺垫长期收货", ts),
        ("RND-603", "CONV-006", 3, "卖家暂挂", 1030000, 1060000, "慢慢压价", "卖家回低于10300先挂着，已入慢压池每48h回访", ts),
    ]
    conn.executemany("INSERT INTO negotiation_rounds VALUES (?,?,?,?,?,?,?,?,?)", rounds)

    pricebooks = [
        ("PB-001-V1", "IP15P-256-NAT", "iPhone 15 Pro 256G 国行原色", "95新·电池90%以上无拆修", 1, 520000, 458000, 475000, 490000, "archived", "wangzg", "wangzg", ts),
        ("PB-001", "IP15P-256-NAT", "iPhone 15 Pro 256G 国行原色", "95新·电池90%以上无拆修", 2, 505000, 445000, 460000, 475000, "published", "wangzg", "wangzg", ts),
        ("PB-002-V1", "SONY-A7M4-BODY", "Sony A7M4 单机身 快门<2万", "95新·CMOS干净原盒", 1, 1090000, 985000, 1015000, 1045000, "archived", "wangzg", "wangzg", ts),
        ("PB-002", "SONY-A7M4-BODY", "Sony A7M4 单机身 快门<2万", "95新·CMOS干净原盒", 2, 1060000, 960000, 990000, 1020000, "published", "wangzg", "wangzg", ts),
        ("PB-003", "TP-X1C-G11-1T", "ThinkPad X1 Carbon G11 i7 16+1T", "98新·屏幕无压痕", 2, 690000, 610000, 635000, 650000, "published", "wangzg", "wangzg", ts),
        ("PB-004", "MBP14-M3-16-512", "MacBook Pro 14 M3 16+512", "98新·电池92%以上", 1, 760000, 680000, 710000, 735000, "draft_pending_review", "liming", None, ts),
        ("PB-005", "ASUS-VG27AQML1A", "华硕 TUF 27寸 2K 240Hz 电竞屏", "99新·原盒完美屏", 1, 135000, 95000, 105000, 112000, "published", "wangzg", "wangzg", ts),
    ]
    conn.executemany("INSERT INTO pricebook_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", pricebooks)

    policies = [
        ("daily_clear_hour", "当天问题单清零截止时间", json_dumps({"value": "22:00", "options": ["22:00", "次日00:00", "次日24:00"]}), "制度待定", 1, "默认每天 22:00 前把当天到货的问题单点完退货或谈出结果", "wangzg", ts),
        ("plan_b_cooldown_mins", "点完退货后晾卖家多久再回拨", json_dumps({"value": 30, "min": 15, "max": 60, "unit": "分钟"}), "先退后回SOP", 1, "在闲鱼点完退货退款后，先冷静等 15–60 分钟看卖家会不会主动心疼运费来求和", "wangzg", ts),
        ("commission_mode", "采购两段 10% 提成独立核算规则", json_dumps({"value": "pre_10_post_10", "options": ["pre_10_post_10", "arrival_10_pct"]}), "老板拍板定案", 0, "买前省钱提成 =（冻结参考价 M − 首轮成交价 P）× 10%；到货提成 = 到货实际退回/折让差价 R × 10%（两段独立核算绝不重复计提，财务 T+1 核销确认）", "wangzg", ts),
        ("daily_comm_target", "个人单日预计提成目标", json_dumps({"value": 100000, "min": 20000, "max": 500000, "unit": "分"}), "个人收益看板", 0, "默认每日个人预计提成目标 ¥1,000（预计/已确认/已发放三栏独立展示，绝不混加）", "wangzg", ts),
        ("se_condition_gap", "小毛病与大暗病判定红线", json_dumps({"S1_allow_E1": True, "S2_max_repair_cents": 15000, "undisclosed_always_return_first": True}), "仓检标准", 1, "顺丰到仓件走派送 10m 当场拒签闪电战；已签收件或同城件先提平台退货锁时效、等卖家先提留货或走 Plan B", "wangzg", ts),
    ]
    conn.executemany("INSERT INTO policy_configs VALUES (?,?,?,?,?,?,?,?)", policies)

    orders = [
        ("PO-20261114-01", "GF-ORD-778001", "CONV-001", "IP15P-256-NAT", "iPhone 15 Pro 256G 原色 电池93%", "诚实果粉阿Ken",
         "price_checked", 462000, None, "SNAP-CONV001-V1", 1, json_dumps(snap1), None, None, "RES-1001", "manual", "[]", 2, "seed-po-1", ts, ts),
        ("PO-20261112-08", "GF-ORD-775210", "CONV-004", "MBP14-M3-16-512", "MacBook Pro 14 M3 16+512 98新", "苏州数码工作室",
         "shipped", 720000, 720000, "SNAP-CONV004-V1", 1, json_dumps({"snapshot_id": "SNAP-CONV004-V1", "seller_declaration": "原装充电器，几乎无划痕，电池循环18次"}),
         "PAY-ALI-990812", "SF1488990021", "RES-1002", "rpa", "[]", 5, "seed-po-2", ts, ts),
        ("PO-20261110-03", "GF-ORD-771009", None, "IPADP11-M2-256", "iPad Pro 11 M2 256G 深空灰", "合肥二手电子",
         "manual_paid", 365000, 365000, "SNAP-PO771009-V1", 1, json_dumps({"snapshot_id": "SNAP-PO771009-V1", "seller_declaration": "屏幕完美无亮斑无磕碰，全原未拆"}),
         "PAY-ALI-980102", "SF1488770019", None, "manual", "[]", 4, "seed-po-3", ts, ts),
    ]
    conn.executemany("INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", orders)

    dl = plus_hours_iso(48)
    s_1, k_1, r_1 = 390000, 385000, 375000
    tickets = [
        (
            "TK-SAMPLE", "PO-20261108-01", "IMAC27-5K-SSD", "SN-F2LX8801", "liming", "chenkj", "accepted",
            "【轨道② 已签收同城件】27寸一体机真实案例：卖家称500G固态，签收后实测机械盘开机两分多钟；先提平台退货锁时效后卖家主动提留货，谈妥 ¥850 成交，整单全退关单 + 已做好支付宝对公支付 ¥850 登记，待陈会计次日 10:00 T+1 审批打款",
            "undisclosed", "waiting_finance",
            175000, 139785, 85000, 145000, 54785, calc_plan_b_hash(175000, 85000, 145000, dl), 90000, 30000,
            "GF-CLOSE-20261108", dl, "none", "pending",
            plus_hours_iso(1), "次日 10:00 (T+1)", dl,
            "买前卖家原话：『27寸办公用没啥磕碰，500G固态硬盘，附带键鼠』",
            "仓检实拍与连续视频：开机耗时2分18秒，硬盘检测非标称固态（换500G固态¥345+工时¥200）",
            0, "./evidence/IMG_5878.PNG", ts,
            make_bargain_flow(True, "核实硬盘是否为真500G固态", True, "bargain_keep", "platform_return",
                              "green_proactive", "卖家主动发来：『或者你自己换个固态？合适就把差价抹了不用退回来』",
                              True, True, True, True, "整单全退关单 + 支付宝对公支付 ¥850（T+1次日10点审批）", True, 20, "skip_already_agreed", True, True,
                              arrival_track="signed_platform_return"),
        ),
        (
            "TK-2412", "PO-20261116-12", "DELL-U2723QE-4K", "SN-DL2723Q99", "liming", None, "accepted",
            "原单 ¥2,000 议价至 ¥800 成交核心锚点：到货抓出右侧大块发红暗斑+缺原装雷电4线，电话谈妥 ¥800 留货（差额 ¥1,200 × 10% = 预计提成 ¥120）！因大额折让走平台部分退款易触发账号红标、卖家恶意差评及平台二次申诉，当前在第 8 步走『整单全退关闭交易 + 支付宝对公支付 ¥800 订单登记（财务次日 10:00 T+1 审批）』",
            "undisclosed", "plan_b_ready",
            165000, 200000, 80000, 152000, 120000, calc_plan_b_hash(165000, 80000, 152000, dl), 85000, 13000,
            "GF-CLOSE-20261116-12", dl, "none", "defect_hold",
            plus_hours_iso(2), "次日 10:00 (T+1)", dl,
            "买前锁死快照：『几乎全新无暗病，原装全套线材在』（原单实付 ¥2,000）",
            "仓库质检实拍：右侧大块发红暗斑 + 缺原装雷电4线 + 支架明显磕碰（已电话谈妥 ¥800 成交，省 ¥1,200！）",
            0, "./evidence/IMG_5881.PNG", ts,
            make_bargain_flow(True, "纯白屏测四角发红暗斑与雷电4线", True, "bargain_keep", "station_refuse",
                              "green_proactive", "卖家心疼27寸显示器顺丰保价费且自知屏幕暗斑难重卖，答应 ¥800 留货",
                              True, True, True, True, "整单全退关单 + 支付宝对公支付 ¥800", True, 25, "skip_already_agreed", False, True,
                              arrival_track="sf_express_refuse"),
        ),
        (
            "TK-2401", "PO-20261110-03", "IPADP11-M2-256", "SN-DLX9203", "liming", None, "accepted",
            "顺丰派送中赵仓管 6 分钟极速验货抓出屏幕左下角 2cm 明显亮斑，已当场拒签！进入【拒签 10 分钟黄金响应窗】：请业务员确认面单已显示拒签并第一时间加上卖家微信！",
            "undisclosed", "issue",
            s_1, 365000, k_1, r_1, 0, None, None, None,
            None, dl, "none", "defect_hold",
            plus_hours_iso(1), "10分钟极速响应", dl,
            "买前锁死快照：卖家标『几乎全新，屏幕完美无亮斑无磕碰』",
            "仓管派送6分钟拒签实拍：纯白底左下角 2cm 明显亮斑，快递员现场标注拒签（原片已进ERP）",
            0, "./evidence/IMG_5881.PNG", ts,
            make_bargain_flow(True, "纯白背景重点查屏幕亮斑老化", True, "bargain_keep", "station_refuse",
                              "", "", False, False, False, False, "", False, 30, "", False, True,
                              6, False, False, "", "station_hold", False, arrival_track="sf_express_refuse"),
        ),
        (
            "TK-2404", "PO-20261113-11", "ROG-XG27ACS-2K", "SN-ROG90311", "liming", None, "accepted",
            "还原实战录屏(laze)：派送7分钟抓出无原厂泡沫+缺DP线当场拒签，8分钟内已确认面单显示拒签并加上卖家微信(wx_laze)！下一步首刀直接按半价大砍（报『700可以接受』，省700拿10%提成¥70），卖家若急问退200行不行，假装毫不在意回『不用了，谢谢』！",
            "undisclosed", "return_requested",
            175000, 140000, 115000, 148000, 0, None, None, None,
            "SF-REFUSE-8821", dl, "none", "defect_hold",
            plus_hours_iso(2), "今日 22:00", dl,
            "买前锁死快照：『99新原盒全套无划痕』（实付 ¥1,400）",
            "仓管7分钟当场拒签实拍：只有外纸箱无原厂泡沫内衬 + 缺原装DP线 + 右边框2处磕碰掉漆（屏幕未碎）",
            0, "./evidence/IMG_5881.PNG", ts,
            make_bargain_flow(True, "重点核原盒泡沫内衬与DP线", True, "bargain_keep", "station_refuse",
                              "", "", False, False, False, False, "", False, 30, "", False, True,
                              7, True, True, "laze_wx88", "station_hold", False, arrival_track="sf_express_refuse"),
        ),
        (
            "TK-2402", "PO-20261112-08", "MBP14-M3-16-512", "SN-C02XY771", "liming", "zhaocg", "pending_accept",
            "杂牌充电头+底壳深划痕；微信发原片并首刀狠砍后，卖家很着急问『退250行不行，别退回来了』——正用『假装毫不在意说不用了谢谢 + 游说退回三笔亏本账』往高补差压进！",
            "undisclosed", "seller_offer",
            760000, 720000, 720000 - 25000 + 8000, 735000, 25000, calc_plan_b_hash(760000, 720000 - 25000 + 8000, 735000, dl), 57000, 25000,
            "SF-REFUSE-7752", dl, "none", "defect_hold",
            plus_hours_iso(2), "今日 22:00", dl,
            "买前锁死快照：『几乎全新，原装充电器，几乎无划痕，循环18次』",
            "仓库质检实拍：第三方杂牌充电头（配原装头成本 ¥80）+ 底壳 2.5cm 深划痕（成色降档折损约 ¥220）",
            0, "./evidence/IMG_5881.PNG", ts,
            make_bargain_flow(True, "重点查底壳划痕与原装充电头", True, "bargain_keep", "station_refuse",
                              "green_proactive", "卖家在微信着急挽留：『250 行不行？别退回来了太折腾了』",
                              True, True, True, False, "", False, 30, "", False, True,
                              8, True, True, "suzhou_mac01", "station_hold", False, arrival_track="sf_express_refuse"),
        ),
        (
            "TK-2403", "PO-20261113-06", "STEAMDECK-OLED-1T", "SN-SD88921", "liming", "zhaocg", "accepted",
            "右上角磕碰+背壳划痕；首刀半价试探后卖家态度极强硬：『那你给我退回吧，我打 95338 已经让他退了』！但本单买前 ¥3,400 捡漏（保底留货仍净赚 ¥530 且客户急等）：既可二次回拨压底线，也可直接用『算了吧太急了，虽然这么烂我也勉强收下了』保面子留货并撤 95338！",
            "undisclosed", "returning",
            395000, 340000, 340000 - 35000 + 2000, 373000, 0, calc_plan_b_hash(395000, 307000, 373000, dl), 88000, 22000,
            "SF-REFUSE-95338", dl, "requested", "defect_hold",
            plus_hours_iso(4), "今日 22:00", dl,
            "买前锁死快照：『95新无明显磕碰，摇杆按键完美』",
            "仓库质检实拍：右上角明显磕碰凹痕 + 背壳深划痕（⚠️ 卖家已打 95338 召回中，确认截留前锁死禁入库）",
            0, "./evidence/IMG_5878.PNG", ts,
            make_bargain_flow(True, "重点查机身四角磕碰与背壳", True, "bargain_keep", "station_refuse",
                              "red_hard_address", "卖家微信强硬回复：『那你给我退回吧，我打 95338 已经让他退了』",
                              True, True, True, True, "", False, 35, "", False, True,
                              5, True, True, "nj_aqiang99", "seller_called_95338_return", False, arrival_track="sf_express_refuse"),
        ),
        (
            "TK-2409", "PO-20261109-05", "ROG-XG27ACS-2K", "SN-ROG88219", "liming", None, "accepted",
            "买前标几乎全新打质疑标 → 到货抓底座3cm划痕 → 9步二次议价谈退 ¥300 留货完结，两段各10%提成已发，瑕疵实拍已进ERP供销售自取",
            "undisclosed", "done",
            165000, 135000, 105000, 140000, 30000, calc_plan_b_hash(165000, 105000, 140000, dl), 60000, 25000,
            "GF-RET-20261109-05", dl, "none", "restocked_good",
            plus_hours_iso(1), "已清零", dl,
            "买前锁死快照：『几乎全新，箱说全屏幕完美无划痕』",
            "仓库实拍底座划痕（已沉淀ERP供销售直接调取上架），谈退 ¥300 入库 B-02-08",
            0, "./evidence/IMG_5881.PNG", ts,
            make_bargain_flow(True, "重点查底座支架与屏幕", True, "bargain_keep", "platform_return",
                              "green_proactive", "卖家怕显示器来回运费百元主动求留货",
                              True, True, True, True, "平台直接退差 ¥300", True, 25, "skip_already_agreed", True, True,
                              arrival_track="signed_platform_return"),
        ),
    ]
    conn.executemany("INSERT INTO aftersales_tickets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", tickets)

    bargain_logs = [
        ("BLOG-101", "TK-2402", 1, "buyer", "李明（第5步首通电话·报首锚 ¥450 + 沉默6秒）", "defensive", 45000,
         "哎哟哥，我本来这边都等着用这台 MacBook 了，刚开箱测完主板还行，但你链接写的是几乎全新原装充电器，现在实物是个杂牌头，底壳还有道 2.5cm 露白深划痕！这个状态按原价我肯定不会收。现在要么退回，要么按真实成色重算——补 450 块，我勉强留下马上撤退货点收货。（报完沉默6秒）", ts),
        ("BLOG-102", "TK-2402", 1, "seller", "苏州数码工作室（卖家顶嘴还价）", "defensive", 25000,
         "兄弟充电头可能是拿错了，二手东西哪有完美的，底壳放桌上又看不见！450太多了，最多退你 250 块，行的话你就留着。", ts),
        ("BLOG-301", "TK-2403", 1, "buyer", "李明（首通电话·报首锚 ¥600 + 干脆退出立威）", "tough", 60000,
         "你原来说的是95新无磕碰，现在右上角磕碰和背壳划痕都很明显，按原价我肯定不收。补 600 我留下，不然我就按退货走。", ts),
        ("BLOG-302", "TK-2403", 1, "seller", "南京玩家阿强（强硬秒给地址）", "tough", 0,
         "一分不退！别人都能接受就你事多，地址发你了你退回来吧！（李明已干脆挂断进入 35 分钟战略冷却重算）", ts),
        ("BLOG-201", "TK-2409", 1, "buyer", "李明（首通电话·对半砍气势报首锚 ¥450）", "urgent_cash", 45000,
         "哎哟兄弟，我电脑都装好就差这块屏幕了，结果底座支架这么明显一道 3cm 露底漆划痕，跟你写的几乎全新完全不是一回事！按原价我肯定不收，补 450 我按瑕疵货勉强收下。", ts),
        ("BLOG-202", "TK-2409", 2, "seller", "武汉电竞玩家小凯（卖家还价）", "urgent_cash", 22000,
         "哥们大件退回来顺丰保价太贵了，我也急回血，450肉疼，退你 220 行不行？", ts),
        ("BLOG-203", "TK-2409", 3, "buyer", "李明（阶梯带条件让步·谈成 ¥300）", "urgent_cash", 30000,
         "220 解决不了二次销售折价。看你也爽快我跟主管磨了最后一步：退 300 块！但前提是你现在点同意，我这一分钟马上确认收货让你钱秒到账。", ts),
    ]
    conn.executemany("INSERT INTO aftersales_bargain_logs VALUES (?,?,?,?,?,?,?,?,?)", bargain_logs)

    ledger = [
        ("FIN-1001", "TK-SAMPLE", "PO-20261108-01", "IMAC27-5K-SSD", "platform_refund", "闲鱼整单全额退回关单（脱离平台管辖）", 139785, "inflow", "REF-GF-8801", "chenkj", "verified", "27寸一体机闲鱼整单全退关闭交易（零差评/零二次申诉风险）", ts),
        ("FIN-1002", "TK-SAMPLE", "PO-20261108-01", "IMAC27-5K-SSD", "corp_alipay_payout", "支付宝对公支付直转卖家（T+1次日10:00财务审批）", 85000, "outflow", None, None, "pending_finance", "已登记卖家张哲(00038155728)对公打款 ¥850，待陈会计次日 10:00 核对 T+1 账单审批并填电子回单", ts),
        ("FIN-1003", "TK-2402", "PO-20261112-08", "MBP14-M3-16-512", "po_payment", "闲鱼实付货款", 720000, "outflow", "PAY-ALI-990812", "chenkj", "verified", "MacBook Pro 采购实付 7200 元", ts),
    ]
    conn.executemany("INSERT INTO finance_ledger VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", ledger)

    comms = [
        ("COM-100-PRE", "liming", "PO-20261112-08", None, "pre_buy_10_pct", 4000, 4000, "confirmed", "MacBook Pro 买前谈价省 ¥400（参考 ¥7,600 − 首轮实付 ¥7,200）× 10% = ¥40（与到货差价独立核算不重算）", ts),
        ("COM-101", "liming", "PO-20261112-08", "TK-2402", "post_arrival_10_pct", 3000, 2500, "confirmed", "MacBook Pro 到货二次议价：卖家已松口退 ¥250（10% 提成保底 ¥25，谈到 ¥300 拿 ¥30）", ts),
        ("COM-102", "liming", "PO-20261114-01", None, "pre_buy_10_pct", 4300, 0, "estimated", "iPhone 15 Pro 买前谈妥省 ¥430 × 10% = 预计 ¥43（等付完钱验机入库后发放）", ts),
    ]
    conn.executemany("INSERT INTO commissions VALUES (?,?,?,?,?,?,?,?,?,?)", comms)

    fav_sellers = [
        ("SELLER-GF-001", "诚实果粉阿Ken", "liming", "team", json_dumps(["沟通顺畅", "长期供货", "苹果主力"]), "改价爽快、包装仔细，已共享给采购组全员跟进", "https://www.goofish.com/personal?userId=gf_ken01", ts, ts),
        ("SELLER-GF-006", "阿远的器材柜", "liming", "team", json_dumps(["同行白名单", "长期供货", "摄影器材"]), "摄影工作室定期退下来的备用机，适合慢压长期收货", "https://www.goofish.com/personal?userId=gf_ayuan06", ts, ts),
        ("SELLER-GF-002", "杭州影像老周", "liming", "personal", json_dumps(["重点关注", "瑕疵全披露"]), "瑕疵拍得极清楚无二次议价空间，买前必须严守出价上限", "https://www.goofish.com/personal?userId=gf_zhou02", ts, ts),
        ("SELLER-GF-005", "极客小林", "liming", "personal", json_dumps(["数码发烧友", "换新频繁"]), "个人私藏卖家，每年换新款苹果全家桶，老帖降价时果断收", "https://www.goofish.com/personal?userId=gf_xiaolin05", ts, ts),
    ]
    conn.executemany("INSERT OR IGNORE INTO favorite_sellers VALUES (?,?,?,?,?,?,?,?,?)", fav_sellers)

    exec_jobs = [
        ("JOB-9001", "WIN-BG-01", "ACC-GF-01", "CONV-005", "GF-8812034", "first_offer", "completed", 1,
         json_dumps({"quote_cents": 680000, "snapshot_images": 2, "summary": "静默抓完2张原始商品图并自动发出首报 ¥6,800"}),
         "PM-GF-99101", None, "idem-job-9001", ts, ts),
        ("JOB-9002", "WIN-BG-02", "ACC-GF-01", "CONV-006", "GF-TH-906", "slow_followup", "queued", 1,
         json_dumps({"quote_cents": 980000, "cadence": "48h低频巡检", "summary": "慢慢压价池定时回访：试探 ¥9,800 现款秒结"}),
         None, None, "idem-job-9002", ts, ts),
        ("JOB-9003", "WIN-BG-03", "ACC-GF-02", "CONV-003", "GF-TH-903", "sf_delivery_watch", "triggered_10m_sla", 2,
         json_dumps({"sf_waybill": "SF1488990441", "sf_state": "派送中", "sla_mins": 10, "summary": "顺丰刚进『派送中』→ 秒推赵仓管 10 分钟极速验货倒计时！"}),
         "SF-PUSH-0441", None, "idem-job-9003", ts, ts),
        ("JOB-9004", "WIN-BG-01", "ACC-GF-02", "CONV-007", "GF-TH-907", "first_offer", "blocked_conflict", 1,
         json_dumps({"reason": "标题单机身与正文28-70套头冲突，防错自动拦截首报转人工待核", "summary": "规格冲突拦截成功（0误报风险）"}),
         None, "SPEC_CONFLICT_BLOCKED", "idem-job-9004", ts, ts),
    ]
    conn.executemany("INSERT OR IGNORE INTO executor_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", exec_jobs)

    seed_snaps = [
        ("GF-TH-901", 1, "https://www.goofish.com/item?id=GF-TH-901",
         "iPhone 15 Pro 256G 原色 24年4月激活 无拆修无暗病",
         "国行双卡，充新零划痕，电池93%，原盒配件都在，诚心要可小刀（边框光线偏暗，买前未多嘴追问）",
         "99新充新 · 电池93%", "国行双卡 / 256G / 原色钛金属 / 原盒全套", "¥4,850",
         json_dumps(["./evidence/IMG_5878.PNG", "./evidence/IMG_5881.PNG"]), ts),
        ("GF-TH-902", 1, "https://www.goofish.com/item?id=GF-TH-902",
         "Sony A7M4 单机身 2024年初购入 快门1.1万",
         "快门1.1万，军舰部和底角有两处掉漆已拍微距特写，CMOS干净无进灰，包装背带都在",
         "93新 · 已高清披露掉漆", "国行单机身 / 快门11200 / 原盒单电", "¥10,800",
         json_dumps(["./evidence/IMG_5881.PNG", "./evidence/IMG_5878.PNG"]), ts),
        ("GF-TH-903", 1, "https://www.goofish.com/item?id=GF-TH-903",
         "华硕 TUF 27寸 2K 240Hz 电竞显示器 99新几乎全新原盒",
         "99新几乎全新，原盒包装在，完美屏无坏点（只拍关机正面照，未拍箱内泡沫）",
         "几乎全新 · 原盒", "VG27AQML1A / 27寸 2K 240Hz / IPS", "¥1,200",
         json_dumps(["./evidence/IMG_5881.PNG"]), ts),
        ("GF-TH-905", 1, "https://www.goofish.com/item?id=GF-TH-905",
         "MacBook Pro 14 M3 16+512 几乎全新 自用电池96%",
         "自用爱惜无磕碰，配件全，电池健康96%（底壳远景昏暗模糊，买前锁死不追问）",
         "几乎全新 · 底壳模糊", "M3芯片 / 16GB内存 / 512GB固态 / 深空灰", "¥7,450",
         json_dumps(["./evidence/IMG_5878.PNG", "./evidence/IMG_5881.PNG"]), ts),
        ("GF-TH-906", 1, "https://www.goofish.com/item?id=GF-TH-906",
         "Sony A7M4 工作室备用机身 快门6500 原盒双电",
         "室内备用机，屏幕贴膜，双原装电池+座充都在，不急出慢慢卖",
         "97新 · 工作室备用", "国行单机身 / 快门6500 / 双原装电", "¥10,500",
         json_dumps(["./evidence/IMG_5881.PNG", "./evidence/IMG_5878.PNG"]), ts),
        ("GF-TH-907", 1, "https://www.goofish.com/item?id=GF-TH-907",
         "Sony A7M4 国行微单（含28-70镜头可单出）",
         "单机身或带28-70镜头都行，先私聊确认要哪套再改价",
         "规格冲突待核", "单机身 vs 28-70套机混合描述", "¥11,200",
         json_dumps(["./evidence/IMG_5878.PNG"]), ts),
    ]
    conn.executemany("INSERT OR IGNORE INTO item_snapshots VALUES (?,?,?,?,?,?,?,?,?,?)", seed_snaps)

    log_audit(conn, "wangzg", "初始化工作台", "WORKBENCH", "加载今天采购的 / 问题订单 / 已经完结的及收藏慢压/专窗队列完整演示数据")
    seed_onboarding(conn)
    seed_cases_and_governance(conn)
    seed_statement_reconciliation(conn)
    seed_account_risk_stats(conn)


def seed_account_risk_stats(conn: sqlite3.Connection) -> None:
    ts = now_iso()
    rows = [
        (
            "闲鱼主号1",
            "闲鱼主号1（ACC-GF-01 · 前台主号）",
            "WIN-FG-01",
            120,
            4,
            1,
            5.0,
            3.8,
            "近30天120单：退款率 3.33%（距5%红标剩2单缓冲）· 纠纷率 0.83%，健康可控",
            ts,
        ),
        (
            "闲鱼副号2",
            "闲鱼副号2（ACC-GF-02 · 临近5%预警）",
            "WIN-BG-01 / WIN-BG-02",
            85,
            4,
            1,
            5.0,
            3.8,
            "⚠️ 近30天85单已退4单（退款率 4.71%）：再退 1 单即破 5.88% 触发平台红标！优先走『零退款率留货』或切闲鱼3号拍单",
            ts,
        ),
        (
            "闲鱼3号",
            "闲鱼3号（ACC-GF-03 · 低退款率安全号）",
            "WIN-BG-03",
            60,
            1,
            0,
            5.0,
            3.8,
            "近30天60单仅退1单（退款率 1.67% · 纠纷率 0%）：额度充裕，推荐承接『质疑成色/高概率二次议价』链接",
            ts,
        ),
    ]
    conn.executemany("INSERT OR IGNORE INTO account_risk_stats VALUES (?,?,?,?,?,?,?,?,?,?)", rows)


def build_account_risk_shield(conn: sqlite3.Connection, cases: list[dict[str, Any]]) -> dict[str, Any]:
    raw_accts = [dict(r) for r in conn.execute("SELECT * FROM account_risk_stats ORDER BY account_id ASC")]
    aliases = {
        "ACC-GF-01": "闲鱼主号1",
        "ACC-GF-02": "闲鱼副号2",
        "ACC-GF-03": "闲鱼3号",
    }
    accounts_out: list[dict[str, Any]] = []
    by_key: dict[str, dict[str, Any]] = {}
    tot_orders = 0
    tot_refunds = 0
    tot_disputes = 0
    at_risk_cnt = 0
    red_cnt = 0

    for a in raw_accts:
        ords = max(1, int(a["rolling_30d_orders"]))
        refs = int(a["rolling_30d_refunds"])
        disps = int(a["rolling_30d_disputes"])
        redline = float(a["redline_pct"] or 5.0)
        warnline = float(a["warn_pct"] or 3.8)

        ref_pct = round(refs * 100.0 / ords, 2)
        disp_pct = round(disps * 100.0 / ords, 2)
        next_ref_pct = round((refs + 1) * 100.0 / ords, 2)
        next_disp_pct = round((disps + 1) * 100.0 / ords, 2)
        max_safe_refs = int(ords * (redline / 100.0))
        max_safe_disps = int(ords * (redline / 100.0))
        rem_refs = max(0, max_safe_refs - refs)
        rem_disps = max(0, max_safe_disps - disps)

        if ref_pct > redline or disp_pct > redline:
            lvl = "red"
            badge = "🚨 已破 5% 红标熔断线"
            at_risk_cnt += 1
            red_cnt += 1
        elif ref_pct >= warnline or disp_pct >= 3.0 or next_ref_pct > redline:
            lvl = "amb"
            badge = f"⚠️ 逼近 5% 预警（再退1单升至 {next_ref_pct}%）"
            at_risk_cnt += 1
        else:
            lvl = "grn"
            badge = f"🟢 安全（距5%红标还剩 {rem_refs} 单额度）"

        item = {
            **a,
            "refund_rate_pct": ref_pct,
            "dispute_rate_pct": disp_pct,
            "next_refund_rate_pct": next_ref_pct,
            "next_dispute_rate_pct": next_disp_pct,
            "remaining_refund_quota": rem_refs,
            "remaining_dispute_quota": rem_disps,
            "will_breach_on_next_refund": next_ref_pct > redline,
            "will_breach_on_next_dispute": next_disp_pct > redline,
            "risk_level": lvl,
            "status_badge": badge,
        }
        accounts_out.append(item)
        by_key[a["account_id"]] = item
        tot_orders += ords
        tot_refunds += refs
        tot_disputes += disps

    for k_alias, target_name in aliases.items():
        if target_name in by_key:
            by_key[k_alias] = by_key[target_name]

    safest = min(accounts_out, key=lambda x: (x["refund_rate_pct"], x["dispute_rate_pct"])) if accounts_out else None

    for c in cases:
        acct_name = c.get("account_id") or "闲鱼主号1"
        matched_acct = by_key.get(acct_name) or (accounts_out[0] if accounts_out else None)
        c["account_risk"] = matched_acct

    return {
        "redline_pct": 5.0,
        "anti_bickering_rule": "退款率与纠纷率均严禁超过 5.0%（超线必弹平台红标）！非必要绝不扯皮、绝不点小二介入/闲鱼小法庭：能保底赚钱优先零退款率留货，谈不拢痛快退回。",
        "accounts": accounts_out,
        "summary": {
            "total_30d_orders": tot_orders,
            "total_30d_refunds": tot_refunds,
            "total_30d_disputes": tot_disputes,
            "overall_refund_rate_pct": round(tot_refunds * 100.0 / max(1, tot_orders), 2),
            "overall_dispute_rate_pct": round(tot_disputes * 100.0 / max(1, tot_orders), 2),
            "at_risk_account_count": at_risk_cnt,
            "red_account_count": red_cnt,
            "recommended_safe_account": safest["account_id"] if safest else "闲鱼3号",
            "recommended_safe_refund_pct": safest["refund_rate_pct"] if safest else 1.67,
        },
    }


def seed_statement_reconciliation(conn: sqlite3.Connection) -> None:
    ts = now_iso()
    conn.execute(
        "INSERT OR IGNORE INTO statement_batches VALUES (?,?,?,?,?,?,?,?,?)",
        (
            "STMT-20261117",
            "昨日对账单（11月17日全天流水）",
            "chenkj",
            "今日 09:25 自动同步到位（次日 10:00 前财务账单接口推入）",
            "企业支付宝主号 + 闲鱼主号1/副号2 绑定扣款户",
            "open_diff",
            None,
            None,
            ts,
        ),
    )
    stmt_rows = [
        # 5 笔已抓全且金额完全一致
        ("ST-01", "STMT-20261117", "PAY-ALI-992104", "GF-ORD-778104", "闲鱼副号2", "上海玩家大刘",
         "华硕 TUF 27寸 2K 240Hz 电竞显示器", "ASUS-VG27AQML1A", 105000, "outflow", "昨日 10:15", "auto", None, None, "", ts),
        ("ST-02", "STMT-20261117", "PAY-ALI-991811", "GF-ORD-777311", "闲鱼主号1", "个人卖家 laze",
         "ROG 27寸 2K 电竞显示器 99新原盒", "ROG-XG27ACS-2K", 140000, "outflow", "昨日 11:42", "auto", None, None, "", ts),
        ("ST-03", "STMT-20261117", "PAY-ALI-998200", "GF-ORD-779012", "闲鱼主号1", "设计师老周",
         "戴尔 U2723QE 27寸 4K 专业显示器", "DELL-U2723QE-4K", 200000, "outflow", "昨日 14:08", "auto", None, None, "", ts),
        ("ST-04", "STMT-20261117", "PAY-ALI-990812", "GF-ORD-775210", "闲鱼主号1", "苏州数码工作室",
         "MacBook Pro 14 M3 16+512 98新", "MBP14-M3-16-512", 720000, "outflow", "昨日 16:30", "auto", None, None, "", ts),
        ("ST-05", "STMT-20261117", "PAY-ALI-991502", "GF-ORD-776890", "闲鱼主号1", "南京强硬卖家阿强",
         "Steam Deck OLED 1TB 掌机", "STEAMDECK-OLED-1T", 340000, "outflow", "昨日 17:55", "auto", None, None, "", ts),
        # 2 笔典型【漏抓采购单】：财务昨日账单真扣了钱，但工作台里没抓到/漏登记！
        ("ST-06", "STMT-20261117", "PAY-ALI-999501", "GF-ORD-779501", "闲鱼主号1", "西湖果粉小陆",
         "iPhone 15 Pro 256G 国行白色 几乎全新（昨日晚间拍下漏抓单）", "IP15P-256-NAT", 458000, "outflow", "昨日 19:18", "auto", None, None, "", ts),
        ("ST-07", "STMT-20261117", "PAY-ALI-999588", "GF-ORD-779588", "闲鱼副号2", "深圳电竞老K",
         "ROG 27寸 2K 180Hz 电竞显示器 原盒全套（副号拍下漏同步）", "ROG-XG27ACS-2K", 128000, "outflow", "昨日 21:46", "auto", None, None, "", ts),
        # 1 笔典型【抓到但实付金额有差额】：账单实扣 ¥3,665（含 ¥15 顺丰保价运费），系统只记了 ¥3,650
        ("ST-08", "STMT-20261117", "PAY-ALI-980102", "GF-ORD-771009", "闲鱼主号1", "合肥二手电子",
         "iPad Pro 11 M2 256G 深空灰（含代付顺丰保价费 ¥15）", "IPADP11-M2-256", 366500, "outflow", "昨日 15:10", "auto", None, None, "", ts),
    ]
    conn.executemany("INSERT OR IGNORE INTO statement_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", stmt_rows)


def infer_model_from_title(title: str) -> str:
    up = title.upper()
    if "A7M4" in up or "SONY" in up:
        return "SONY-A7M4-BODY"
    if "MBP" in up or "MACBOOK" in up or "M3" in up:
        return "MBP14-M3-16-512"
    if "IPAD" in up:
        return "IPADP11-M2-256"
    if "U2723" in up or "DELL" in up or "戴尔" in title:
        return "DELL-U2723QE-4K"
    if "ROG" in up:
        return "ROG-XG27ACS-2K"
    if "ASUS" in up or "华硕" in title or "TUF" in up:
        return "ASUS-VG27AQML1A"
    return "IP15P-256-NAT"


def build_statement_reconciliation(
    conn: sqlite3.Connection,
    orders: list[dict[str, Any]],
    cases: list[dict[str, Any]],
) -> dict[str, Any]:
    batch_row = conn.execute("SELECT * FROM statement_batches ORDER BY created_at DESC LIMIT 1").fetchone()
    if not batch_row:
        return {
            "batch": None,
            "items": [],
            "summary": {
                "total_count": 0,
                "matched_count": 0,
                "missing_count": 0,
                "amount_diff_count": 0,
                "ignored_count": 0,
                "total_statement_cents": 0,
                "missing_amount_cents": 0,
                "all_clear": True,
            },
            "unbilled_orders": [],
        }

    batch = dict(batch_row)
    raw_items = [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM statement_items WHERE batch_id=? ORDER BY stmt_item_id ASC",
            (batch["batch_id"],),
        )
    ]

    po_by_receipt: dict[str, dict[str, Any]] = {}
    po_by_ext: dict[str, dict[str, Any]] = {}
    for o in orders:
        if o.get("payment_receipt_no"):
            po_by_receipt[o["payment_receipt_no"]] = o
        if o.get("external_order_no"):
            po_by_ext[o["external_order_no"]] = o

    case_by_po = {c["po_id"]: c for c in cases if c.get("po_id")}

    matched_po_ids: set[str] = set()
    enriched_items: list[dict[str, Any]] = []
    matched_cnt = 0
    missing_cnt = 0
    diff_cnt = 0
    ignored_cnt = 0
    missing_amt_cents = 0
    total_stmt_cents = 0

    for it in raw_items:
        amt = int(it["amount_cents"] or 0)
        if it["direction"] == "outflow":
            total_stmt_cents += amt

        if it["resolution_state"] == "ignored_non_po":
            match_status = "ignored_non_po"
            status_label = "⚪ 非采购支出已排除"
            ignored_cnt += 1
            enriched_items.append({
                **it,
                "match_status": match_status,
                "status_label": status_label,
                "matched_po_id": None,
                "matched_case_id": None,
                "matched_case_title": "",
                "system_paid_cents": None,
                "diff_cents": 0,
            })
            continue

        po = po_by_receipt.get(it["alipay_tx_no"]) or po_by_ext.get(it["external_order_no"])
        if not po and it.get("resolved_po_id"):
            po = next((x for x in orders if x["po_id"] == it["resolved_po_id"]), None)

        if not po:
            match_status = "missing_order"
            status_label = "🚨 漏抓采购单（账单已扣款·系统无单）"
            missing_cnt += 1
            missing_amt_cents += amt
            enriched_items.append({
                **it,
                "match_status": match_status,
                "status_label": status_label,
                "matched_po_id": None,
                "matched_case_id": None,
                "matched_case_title": "",
                "system_paid_cents": None,
                "diff_cents": amt,
            })
        else:
            matched_po_ids.add(po["po_id"])
            sys_paid = int(po["paid_cents"] or po["agreed_cents"] or 0)
            diff_c = amt - sys_paid
            linked_case = case_by_po.get(po["po_id"])
            if diff_c == 0 or it["resolution_state"] in ("amount_adjusted", "backfilled"):
                match_status = "matched"
                status_label = "✅ 已抓全·金额一致" if it["resolution_state"] != "backfilled" else "✅ 已一键补抓入库"
                matched_cnt += 1
            else:
                match_status = "amount_diff"
                sign = "+" if diff_c > 0 else ""
                status_label = f"⚠️ 金额不符（账单差 {sign}¥{diff_c/100:.0f}）"
                diff_cnt += 1
            enriched_items.append({
                **it,
                "match_status": match_status,
                "status_label": status_label,
                "matched_po_id": po["po_id"],
                "matched_case_id": linked_case["case_id"] if linked_case else it.get("resolved_case_id"),
                "matched_case_title": linked_case["title"] if linked_case else po["title"],
                "system_paid_cents": sys_paid,
                "diff_cents": diff_c,
            })

    # Sort so red missing_order first, amber amount_diff second, matched/ignored below
    rank_map = {"missing_order": 0, "amount_diff": 1, "matched": 2, "ignored_non_po": 3}
    enriched_items.sort(key=lambda x: (rank_map.get(x["match_status"], 9), x["stmt_item_id"]))

    # Bidirectional check: orders marked paid in system but not in yesterday's statement
    unbilled_orders = []
    for o in orders:
        if o.get("paid_cents") and o["po_id"] not in matched_po_ids:
            lc = case_by_po.get(o["po_id"])
            unbilled_orders.append({
                "po_id": o["po_id"],
                "external_order_no": o["external_order_no"],
                "case_id": lc["case_id"] if lc else None,
                "title": lc["title"] if lc else o["title"],
                "paid_cents": o["paid_cents"],
                "payment_receipt_no": o["payment_receipt_no"],
                "stage": o["stage"],
                "hint": "历史已完结批次（非昨日流水）" if o["stage"] == "completed" else "今日新付款或跨日流水（进入明日 10:00 对账单）",
            })

    all_clear = (missing_cnt == 0 and diff_cnt == 0)
    return {
        "batch": batch,
        "sla_rule": "财务每日早上 10:00 前发送昨日对账单 → 采购核对订单是否 100% 抓全，漏单当场一键补抓，差额当场核平",
        "items": enriched_items,
        "summary": {
            "total_count": len(enriched_items),
            "matched_count": matched_cnt,
            "missing_count": missing_cnt,
            "amount_diff_count": diff_cnt,
            "ignored_count": ignored_cnt,
            "total_statement_cents": total_stmt_cents,
            "missing_amount_cents": missing_amt_cents,
            "all_clear": all_clear,
            "signed_off": batch["status"] == "all_reconciled" and all_clear,
        },
        "unbilled_orders": unbilled_orders,
    }


def compute_g06_map(ledger: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    cost_summary: dict[str, dict[str, Any]] = {}
    for row in ledger:
        po = row["po_id"]
        cur = cost_summary.setdefault(
            po,
            {
                "po_id": po,
                "model_code": row["model_code"],
                "po_paid_cents": 0,
                "refund_cents": 0,
                "pending_refund_cents": 0,
                "repair_cents": 0,
                "wechat_extra_cents": 0,
                "pending_wechat_cents": 0,
                "net_cost_cents": 0,
            },
        )
        et = row["entry_type"]
        amt = row["amount_cents"]
        verified = row["status"] == "verified"
        if et == "po_payment":
            cur["po_paid_cents"] += amt
        elif et in ("platform_refund", "partial_refund"):
            if verified:
                cur["refund_cents"] += amt
            else:
                cur["pending_refund_cents"] += amt
        elif et == "repair_cost":
            cur["repair_cents"] += amt
        elif et in ("corp_alipay_payout", "wechat_split"):
            if verified:
                cur["wechat_extra_cents"] += amt
            else:
                cur["pending_wechat_cents"] += amt
        cur["net_cost_cents"] = (
            cur["po_paid_cents"] - cur["refund_cents"] + cur["repair_cents"] + cur["wechat_extra_cents"] + cur["pending_wechat_cents"]
        )
    return cost_summary


def build_bargain_plan(ticket: dict[str, Any] | None, bargain_logs: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not ticket:
        return None
    s_c = int(ticket["s_market_cents"] or 0)
    paid_c = int(ticket["paid_cents"] or 0)
    r_c = int(ticket["r_replace_cost_cents"] or paid_c)
    offer_c = int(ticket["partial_refund_cents"] or 0)
    # Infer repair/refurbish extra cost from k_keep_cost_cents = paid - offer + repair
    implied_repair = max(0, int(ticket["k_keep_cost_cents"]) - (paid_c - offer_c))
    if ticket["ticket_id"] == "TK-2401":
        implied_repair = 8000  # 清洁/检测与亮斑折损基础整备
    elif ticket["ticket_id"] == "TK-2403":
        implied_repair = 2000  # 掌机外壳清洁与贴膜基础整备
    # Minimum refund C where keeping beats returning & rebuying:
    # s - (paid - C + repair) > s - r  =>  paid - C + repair < r  =>  C > paid + repair - r
    raw_floor_c = max(10000, paid_c + implied_repair - r_c + 5000)
    if ticket["ticket_id"] == "TK-2402":
        anchor_a, target_b, floor_c = 45000, 30000, 18000
    elif ticket["ticket_id"] == "TK-2401":
        anchor_a, target_b, floor_c = 180000, 60000, 20000
    elif ticket["ticket_id"] == "TK-2404":
        anchor_a, target_b, floor_c = 70000, 45000, 18000  # 原单1400首刀直接对半砍700（报“700可以接受”）！
    elif ticket["ticket_id"] == "TK-2403":
        anchor_a, target_b, floor_c = 170000, 60000, 30000  # 原单3400首刀半价1700试探！
    elif ticket["ticket_id"] == "TK-SAMPLE":
        anchor_a, target_b, floor_c = 70000, 54785, 40000
    elif ticket["ticket_id"] == "TK-2412":
        anchor_a, target_b, floor_c = 120000, 120000, 85000  # 原单2000首刀半价/6折狠砍至800成交！
    elif ticket["ticket_id"] == "TK-2409":
        anchor_a, target_b, floor_c = 67500, 30000, 18000
    else:
        floor_c = int((raw_floor_c + 4999) // 5000 * 5000)
        target_b = int(max(floor_c * 1.5, paid_c * 0.30) // 5000 * 5000)
        anchor_a = max(int(paid_c // 2), int(target_b * 1.35 // 5000 * 5000))  # 默认首刀直接按原单半价（50%）对半大砍！

    half_price_slash_cents = int(paid_c // 2)
    half_price_keep_cents = max(0, paid_c - half_price_slash_cents)
    half_price_comm_cents = int(round(half_price_slash_cents * 0.10))
    salvage_zero_refund_net_cents = s_c - (paid_c + implied_repair)
    is_salvage_profitable = bool(salvage_zero_refund_net_cents >= 15000)

    eval_refund = offer_c if offer_c > 0 else target_b
    keep_cost_at_eval = paid_c - eval_refund + implied_repair
    keep_net = s_c - keep_cost_at_eval
    replace_net = s_c - r_c
    comm_10_cents = int(round(eval_refund * 0.10))

    a_yuan = int(anchor_a // 100)
    b_yuan = int(target_b // 100)
    c_yuan = int(floor_c // 100)
    mid_step_yuan = int((anchor_a + target_b) // 200)
    defect_short = ticket["evidence_warehouse"].replace("仓库质检实拍：", "").replace("仓检实拍与连续视频：", "").replace("仓检实拍：", "")
    bf = json.loads(ticket.get("bargain_flow_json") or "{}")

    scripts = {
        "round1": {
            "title": f"第 1 轮（第 5 步）：宣布原价失效 + 报首刀锚点 ¥{a_yuan}（报完闭嘴沉默 6 秒！）",
            "coach": f"先用『哎哟』讲期待落差，第一句直接打掉原价前提（绝不说“能不能便宜点好不好”求句！），摆出本地重买退路，报出准数 ¥{a_yuan} 后立刻闭嘴沉默 3–6 秒！",
            "by_style": {
                "urgent_cash": f"哎哟哥，我这边本来都安排好等着用这台机器了，刚开箱测完主板核心还行，但你链接写的是几乎全新，现在实物 {defect_short}（实拍图发你看了）。这个状态按原价我肯定不会收！大件退回去来回顺丰保价费不少，还耽误你好几天回款。现在要么退回，要么按真实成色重算——补 {a_yuan} 块，我勉强留下马上撤退货点确认收货。",
                "defensive": f"老板，机器仓库刚录了一镜到底开箱视频，主体功能没毛病。但对照你页面写的承诺，实测 {defect_short}。我不评价整台值多少，只处理这次描述和实物的差价——按原价肯定收不了，补 {a_yuan} 块整备折损，我立马撤掉退货给你结清，免得来回寄快递折腾。",
                "tough": f"我刚验完货，你原来页面写无瑕疵，现在实物 {defect_short}，原成交条件已经不成立了。我急用归急用，没必要按原价硬拿，不行我退回本地重新买一台就是了。你要不想折腾退回重卖，按实际状态补 {a_yuan} 块我留下；不然就按退货走。",
                "merchant": f"老板同行不说虚话，仓库一镜到底实测 {defect_short}，跟出货描述差了一档。正常这项折损加整备在 {b_yuan}~{a_yuan+50} 之间，按 {a_yuan} 元补差我马上撤退货秒结账，以后对路好货长期拿；合不上今天顺丰保价原样退回。",
            },
        },
        "round2": {
            "title": f"第 2 轮（第 6 步）：递减阶梯让步（¥{a_yuan} → ¥{mid_step_yuan} → ¥{b_yuan}，每让一步必换当场确认！）",
            "coach": f"严禁无条件暴跌（如 {a_yuan} 直接跳到 {c_yuan}）！每次让步幅度要越来越小，且必须带交换条件：“我求主管内部扛一点让到 ¥{b_yuan}，但前提是你现在点同意，这一单马上结束！”",
            "by_style": {
                "urgent_cash": f"你说的那个数解决不了这个折损，我还不如直接退。看你也急着回款，我刚拿实拍图跟主管硬磨了一步——手工费我们内部扛了，退 {b_yuan} 块！前提是你现在点同意，我这一分钟马上确认收货让你支付宝秒到账。",
                "defensive": f"哥我理解你发货前可能没注意，但二次销售有这道瑕疵买家一样压价。我们各退一步，公司内部消化一半包装折损，按 {b_yuan} 块补差——现在确认我就撤掉售后直接结清！",
                "tough": f"那个数对这个差价没意义。我最多再让一步到 {b_yuan} 块，到这个数我现在就把售后结掉留下；再低就不用磨了，直接按平台退货走。",
                "merchant": f"老板各让一步交个长期朋友，系统核准 {b_yuan} 元补差，现在点同意我马上销单打款，不耽误两边资金周转！",
            },
        },
        "round3": {
            "title": f"第 3 轮（第 7 步）：亮硬底线 ¥{c_yuan} &「先退后回」二次回拨救单",
            "coach": f"低于底线 ¥{c_yuan} 先干脆挂断真走退货（能真退才有谈判权力！）；冷却 15–60 分钟让卖家体会『煮熟鸭子飞了』，重算留货仍划算再打第二通电话给最后窗口！",
            "by_style": {
                "urgent_cash": f"喂哥，仓库打包贴单前我又重新算了一遍。这成色我确实不满意，但重新调货也费时间——给你最后一个恢复成交的窗口：补 {c_yuan} 块，我把退货撤掉把这单接回来，钱秒到你账；不行我现在就让快递发走了。",
                "defensive": f"老板，刚财务核死最低留货底线是补 {c_yuan} 块，少一分系统锁死入不了库。你看能行我现在接回来当场结清，不行我就让顺丰保价稳妥给你寄出了哈。",
                "tough": f"我刚重新算过了，本来这状态我肯定退的。最后给你留个准数：补 {c_yuan} 块我把这单重新接回来，行我现在撤单，不行就不用再来回聊了，按退货继续走。",
                "merchant": f"老板打包前最后通个气，主管批死底线 {c_yuan} 元能留，可走现在撤单秒结，走不了顺丰马上揽收寄回，下次好机再合作！",
            },
        },
    }

    objection_routes = [
        {
            "key": "blame_express",
            "label": "防御型：「发前好好的，肯定是快递摔的！」",
            "tip": "不争是谁弄坏的（避免防御升级）！只盯当前收到的客观状态，提醒他走快递理赔扯皮半个月、退回去路上再颠一次更亏。",
            "reply": f"我不跟你争发货前是什么状态，仓库是一镜到底开箱录像（外箱完好），我现在收到的实物就是这个状态，原价肯定收不了。真扯快递理赔半个月没结果，退回去再颠一次你更亏——补 {b_yuan} 块整备费，我现在秒点收货把钱打给你最省心。",
        },
        {
            "key": "minor_used",
            "label": "弱化型：「二手哪有完美的，又不影响用！」",
            "tip": "用『反向校准提问』把“能用”和“能按几乎全新卖”拆开！问他：如果退回重卖，下一位买家看到这道瑕疵会按原价收吗？",
            "reply": f"哥，能正常用和能按『几乎全新』价格收是两回事！正常细微痕迹我们从不挑，但这次 {defect_short}，如果退回去你重新挂闲鱼，下一位买家看到一样会压价。我向主管申请内部贴一点，补 {b_yuan} 块今天痛快结清！",
        },
        {
            "key": "just_return",
            "label": "高反抗嘴硬：「一分不退，你寄回来吧！」",
            "tip": "千万别慌、别求他！一口答应配合退回（建立真实退出可信度），然后进第 7 步冷却 15–60 分钟，等他心疼运费或打二次回拨电话救单！",
            "reply": f"可以，那就不继续磨了，按平台退货走，下午顺丰保价给你原样寄回。（提示：发完这句立刻停住进入第 7 步冷却 15–60 分钟！不要追发第二句求他！）",
        },
        {
            "key": "peer_merchant",
            "label": "同行专家：「我也是同行，别拿到手刀套路我！」",
            "tip": "对同行收起假精确和客套，直接甩一镜到底原片 + 市场折损区间 + MESO 等价方案，强调长期稳定收货关系。",
            "reply": f"原来是老板同行，那咱们直接看开箱原片：{defect_short}。同行行情这项折损在 {c_yuan}~{b_yuan+80} 之间，按 {b_yuan} 元补差（或补 {max(50, b_yuan-80)} 元再寄个原装配件过来）我立马来销单，以后对路硬通货长期顺畅拿！",
        },
        {
            "key": "angry_seller",
            "label": "情绪失控：「开始骂人 / 狂打电话催闹」",
            "tip": "受控不满，严禁镜像对骂（对骂闲鱼必判输）！统一拉回文字留痕，把底线推给公司财务系统硬规定。",
            "reply": f"哥先消消气，咱们只说货和价格，不伤和气。仓库全程监控开箱有据可查，公司系统核死最少补 {c_yuan} 块才能入库；你觉得不划算咱们一点不勉强，今天顺丰厚泡沫保价给你稳妥退回。",
        },
    ]

    meso_options = [
        {
            "key": "cash_only",
            "title": f"方案 A（纯退差，最干脆）：直接退差价 ¥{b_yuan}",
            "desc": "闲鱼售后内直接同意部分退款，原单马上确认收货结清。",
            "script": f"方案一：你直接在平台点退差价 {b_yuan} 元，我现在当场确认收货，钱秒到你支付宝。",
        },
        {
            "key": "cash_plus_part",
            "title": f"方案 B（少退钱+补配件）：退 ¥{max(50, b_yuan - 80)} + 卖家补寄原装配件",
            "desc": "适合卖家手头有原装充电器/DP线/底座支架但舍不得多退现金。",
            "script": f"方案二：如果你手头还有原装配件/线材，你包邮补寄过来，现金只需要补 {max(50, b_yuan - 80)} 元差价就行。",
        },
        {
            "key": "corp_alipay_close",
            "title": f"方案 C（大额议价主推！防红标/防差评/防申诉）：整单全退关单 + 支付宝对公支付直转 ¥{max(50, int(paid_c//100) - (int(offer_c//100) if offer_c > 0 else b_yuan))}",
            "desc": "如 2000 元议价到 800 元：绝不在平台点部分退款（防平台一刀切弹账号红标、防卖家刷差评及二次申诉），先把闲鱼整单退掉关闭脱离平台管辖，做好订单登记由公司财务次日 10:00（T+1账单）支付宝对公支付直转卖家！",
            "script": f"哥，咱们谈好 {max(50, int(paid_c//100) - (int(offer_c//100) if offer_c > 0 else b_yuan))} 元留货，为了走公司正规账且不影响两边闲鱼账号权重，咱们不在平台点部分退款——你直接点同意这笔整单全额退款把平台订单关掉。我这边同步做好公司订单登记，走我们公司【支付宝对公支付】直接转到你支付宝（公司 T+1 账单核对，统一在明天早上 10:00 财务审批打款到账，电子回单出来第一时间发你），麻烦发下你的支付宝账号和实名姓名哈！",
        },
    ]

    corp_payout_yuan = max(50, int(paid_c // 100) - (int(offer_c // 100) if offer_c > 0 else b_yuan))
    corp_alipay_seller_script = (
        f"哥，咱们敲定 {corp_payout_yuan} 元留货！因为闲鱼平台对部分退款一刀切风控很严，为了保护咱们双方账号，不在平台点部分退款——"
        f"麻烦你直接同意整单全额退款把闲鱼单子关掉。我现在就给你做好公司内部订单登记，走公司【支付宝对公支付】直接把 {corp_payout_yuan} 元转给你！"
        f"因为公司对公账单是 T+1 结算核对，财务统一在明天上午 10:00 完成审批打款，电子回单出来我第一时间发你，麻烦把收款支付宝账号和实名姓名发我登记一下哈！"
    )

    ladder_steps = [
        {"round": "首刀开口锚点 A", "yuan": a_yuan, "rule": "敢下重锚（中等瑕疵按50%对半砍气势），报完闭嘴沉默 6 秒"},
        {"round": "第 1 次带条件小让", "yuan": mid_step_yuan, "rule": f"降幅收窄（让 ¥{a_yuan - mid_step_yuan}），要求卖家先认瑕疵事实"},
        {"round": "理想目标成交 B", "yuan": b_yuan, "rule": f"再小让（让 ¥{mid_step_yuan - b_yuan}），必须换卖家当场点同意确认"},
        {"round": "系统锁死底线 C", "yuan": c_yuan, "rule": "低于此数留货不如退货重买，果断真退进冷却期！"},
    ]

    seller_signals = [
        {
            "key": "green_proactive",
            "color": "grn",
            "title": "🟢 绿灯最肥窗口：卖家主动提留货补差 / 迟迟不给退货地址",
            "advice": f"卖家极怕退回运费和重卖折腾！稳住高位节奏进第 4~5 步，首刀报 ¥{a_yuan} 报完闭嘴 6 秒，大概率谈到 ¥{b_yuan} 以上。",
        },
        {
            "key": "amber_anxious",
            "color": "amb",
            "title": "🟡 黄灯现金流急迫：电话/消息密集辩解催问，但没操作退回",
            "advice": f"嘴上辩解但行动没退，说明急着回款！进第 5~6 步先打掉原价前提，用顶嘴拆招器带条件让到 ¥{b_yuan}。",
        },
        {
            "key": "red_hard_address",
            "color": "red",
            "title": "🔴 红灯强硬秒退：一声不吭秒给退货地址 / 喊「一分不退寄回来」",
            "advice": f"别求他！先干脆答应退货立威，直接进第 7 步战略冷却 15–60 分钟重算，留货仍划算再打『二次回拨救单电话』报底线 ¥{c_yuan}！",
        },
    ]

    phone_6step = [
        "①『哎哟』期待落差开场：本来电脑/设备都配好等着用（只表落差，绝不低声下气求优惠）",
        f"② 第一句打掉原价前提：你链接写无瑕疵，现在实物「{defect_short}」，原价我肯定不收",
        "③ 急用但随时能退（亮退路）：急归急绝不硬吞，不行退回本地重新买一台就是了",
        "④ 帮卖家算退回三笔账：来回顺丰保价费 + 耽误一周回款 + 重挂下家看到划痕一样压价",
        f"⑤ 二选一架构报单一准数 A：要么退回，要么补 ¥{a_yuan} 我勉强留下马上撤单收货",
        "⑥ ⏱️ 黄金 3–6 秒闭嘴铁律：报完数字立刻停住不说话！谁先心虚接话谁输钱",
    ]

    callback_script = (
        f"喂哥，仓库打包贴顺丰面单前我刚重新核算了一遍。说实话这机器状态我还是不满意，本来肯定退走了；"
        f"但重新调货确实也耽误工夫，你退回去来回保价运费加重新上架也不止这个数。"
        f"给你留最后一个恢复成交窗口：补 {c_yuan} 块差价，我现在把退货撤掉把这单接回来，对公打款给你；"
        f"行我现在处理，不行我就让快递员直接发走了。"
    )

    keep_at_a_yuan = max(50, int((paid_c - anchor_a) // 100))
    keep_at_b_yuan = max(50, int((paid_c - target_b) // 100))
    half_keep_yuan = max(50, int(half_price_keep_cents // 100))

    # =========================================================================
    # 增量引擎：6 大行为心理学锚点 (P1-P6) + 6 大动态博弈论锚点 (G1-G6) 动态测算
    # =========================================================================
    model_upper = (ticket.get("model_code") or "").upper()
    if any(k in model_upper for k in ("ASUS", "ROG", "IMAC", "27", "32", "DISPLAY")):
        roundtrip_freight_yuan = 135
    elif any(k in model_upper for k in ("MBP", "MACBOOK", "THINKPAD", "LAPTOP")):
        roundtrip_freight_yuan = 95
    else:
        roundtrip_freight_yuan = 68

    # P3 零整非对称精确锚定：把拍脑袋整数拆成 3 项有零头的工程定损（如 ¥685 / ¥465，避免整百拍脑袋感）
    raw_slash_yuan = max(120, a_yuan)
    part2_part_yuan = max(45, int(implied_repair // 100) if implied_repair > 0 else 85)
    if part2_part_yuan % 10 == 0:
        part2_part_yuan += 5  # 造出 ¥85 / ¥135 精确配件工料零头
    part3_labor_yuan = 65 if raw_slash_yuan < 500 else 85
    part1_dep_yuan = max(55, raw_slash_yuan - part2_part_yuan - part3_labor_yuan - 15)
    if (part1_dep_yuan + part2_part_yuan + part3_labor_yuan) % 10 == 0:
        part1_dep_yuan += 5
    precise_slash_yuan = part1_dep_yuan + part2_part_yuan + part3_labor_yuan
    precise_keep_yuan = max(50, int(paid_c // 100) - precise_slash_yuan)
    precise_comm_yuan = int(round(precise_slash_yuan * 0.10))

    # P5 红白脸双人权力隔离：脱敏《仓检系统核定上限单》（比目标价再严 50 元，留 50 元给采购员演“好人私人贴补”！）
    good_cop_bonus_yuan = 50 if keep_at_b_yuan > 200 else 30
    bad_cop_sys_cap_yuan = max(50, keep_at_b_yuan - good_cop_bonus_yuan)
    red_face_voucher = {
        "voucher_no": f"QC-CAP-{ticket['ticket_id'].replace('TK-', '')}",
        "model_code": ticket.get("model_code") or "二手数码设备",
        "defect_summary": defect_short,
        "part1_dep_yuan": part1_dep_yuan,
        "part2_part_yuan": part2_part_yuan,
        "part3_labor_yuan": part3_labor_yuan,
        "system_locked_max_yuan": bad_cop_sys_cap_yuan,
        "good_cop_bonus_yuan": good_cop_bonus_yuan,
        "final_ally_offer_yuan": keep_at_b_yuan,
        "desensitized_copy_card": (
            f"【仓检定损核价回执 {ticket['ticket_id']}】\n"
            f"核验机型：{ticket.get('model_code')}\n"
            f"实测未披露差异：{defect_short}\n"
            f"定损扣减：成色降档折损 ¥{part1_dep_yuan} + 配件/耗材补配 ¥{part2_part_yuan} + 拆检整备质保金 ¥{part3_labor_yuan}\n"
            f"ERP 系统锁死最高收购红线：¥{bad_cop_sys_cap_yuan}（超限无法入库，默认按拒签原路退回）"
        ),
    }

    # G2 鲁宾斯坦贴现因子 (δ) 诊断：根据卖家信号动态计算双方耐心指数与战略晾单时长
    cur_sig = bf.get("seller_signal") or "green_proactive"
    if cur_sig == "green_proactive":
        delta_seller = 0.58
        wait_advice = "⏳ 卖家急于回血（耐心值极低 δ=0.58 < 我方 δ=0.96）：切忌秒回暴露急切！故意晾他 8–12 分钟，等他追问时冷淡甩出『不用啦，谢谢』+ 重估价，对方极大概率主动大让步！"
        wait_badge = "战略晾单 8–12 分钟压制"
    elif cur_sig == "amber_anxious":
        delta_seller = 0.72
        wait_advice = "⏳ 卖家嘴硬但频繁回信（耐心值中低 δ=0.72 < 我方 δ=0.96）：保持慢半拍回复（每轮间隔 5 分钟），用拆项精确锚 + 柠檬市场推演瓦解防线！"
        wait_badge = "慢半拍 5 分钟节奏压制"
    else:
        delta_seller = 0.88
        wait_advice = "⏳ 卖家表面强硬（δ=0.88 vs 我方 δ=0.96）：立刻停止纠缠，启动 15–45 分钟真退冷却 + 顺丰 17:30 封车截单通牒（若本单保底净赚则切『嫌弃式勉强收下』）！"
        wait_badge = "冷却 35 分钟 + 封车截单通牒"

    rubinstein_model = {
        "buyer_delta": 0.96,
        "seller_delta": delta_seller,
        "wait_badge": wait_badge,
        "wait_advice": wait_advice,
    }

    psych_anchors = [
        {
            "code": "P1",
            "name": "塞勒心理账户重置（废单重估法）",
            "theory": "Thaler Mental Accounting & 剥离伪禀赋效应",
            "when": "首刀开口时必用：绝不说『你退我多少钱』（触发卖家割肉痛感 2.25 倍），改为『原单已拒签作废，按现状旧货重新估价』！",
            "highlight": f"禁说『退 ¥{a_yuan}』→ 改说『原单作废，现状重估 ¥{keep_at_a_yuan} 可收』",
            "script": (
                f"哥，因为实物『{defect_short}』跟原链接描述不一致，顺丰现场已经按拒签走原单作废了。"
                f"咱们不谈原单退多少钱的事——就按这台机器现在的真实瑕疵状态重新估个价，如果按 ¥{keep_at_a_yuan} 出，我可以向仓库申请按瑕疵机重新接下；不合适就让顺丰正常退回。"
            ),
        },
        {
            "code": "P2",
            "name": "沃斯预防性指控审计（先替卖家骂完防炸毛）",
            "theory": "FBI Voss Accusation Audit & 承诺一致性拆雷",
            "when": "遇到脾气冲、容易喊『你是不是到手刀』的个人卖家，抢在他发火前先把他的潜台词替他说出来，直接拔掉引信！",
            "highlight": "抢先说出『我知道你肯定觉得我挑刺/到手刀』→ 卖家瞬间哑火下不来狠手",
            "script": (
                f"哥，跟你说实话，我知道你看到面单拒签和这个价，第一反应肯定觉得我吹毛求疵、甚至怀疑是不是遇到到手刀了——换我卖东西碰到拒签我心里肯定也烦。"
                f"但你点开刚发你的仓库一镜到底拆箱原片看一眼，封条刚划开就是『{defect_short}』，我交不了差确实没法按原价入库，咱们对事不对人看怎么省心解决。"
            ),
        },
        {
            "code": "P3",
            "name": "零整非对称精确锚定（三项有零头核价单）",
            "theory": "Janiszewski Precise Anchor & 客观成本归因效应",
            "when": "遇到精明较真卖家或数码老手：报整数『砍700』会被当成拍脑袋乱砍，改报拆成 3 项带零头的精确核算数，锚定留存率暴增！",
            "highlight": f"拆项精确核减 ¥{precise_slash_yuan}（重估实收 ¥{precise_keep_yuan} · 拿提成 ¥{precise_comm_yuan}）",
            "script": (
                f"哥这价格真不是我拍脑袋随便砍一半的，仓库定损表刚算出来三项硬成本：①『{defect_short}』二次销售成色降档折损 ¥{part1_dep_yuan}；"
                f"② 补配原装配件/耗材成本 ¥{part2_part_yuan}；③ 拆检整备与质保风险金 ¥{part3_labor_yuan}，三项加起来正好扣 ¥{precise_slash_yuan}。"
                f"按现状实收 ¥{precise_keep_yuan} 我现在就能签字留货，不然真没法入账。"
            ),
            "breakdown": {
                "part1_dep_yuan": part1_dep_yuan,
                "part2_part_yuan": part2_part_yuan,
                "part3_labor_yuan": part3_labor_yuan,
                "precise_slash_yuan": precise_slash_yuan,
                "precise_keep_yuan": precise_keep_yuan,
                "precise_comm_yuan": precise_comm_yuan,
            },
        },
        {
            "code": "P4",
            "name": "具象三倍痛感叠加框架（运费+二次战损+链接降权）",
            "theory": "Kahneman 损失厌恶 (λ=2.25) × 具象可得性启发",
            "when": "卖家犹豫不决觉得『大不了退回来』时，把抽象麻烦变成三笔肉疼的具象损失！",
            "highlight": f"立亏往返保价费 ¥{roundtrip_freight_yuan} + 拆封回程二次磕碰 + 闲鱼拒签记录限流",
            "script": (
                f"哥你冷静算三笔实在账：① 这机器退回去来回顺丰保价运费你得净掏 ¥{roundtrip_freight_yuan} 左右直接打水漂；"
                f"② 包装泡沫已经拆开过了，顺丰退回去路上再颠簸一趟，万一多道划痕更说不清；"
                f"③ 闲鱼后台留一条『描述不符拒签退回』记录，同链接再挂上去流量直接腰斩。现在按 ¥{keep_at_b_yuan} 痛快结清，明早钱就到你账上了！"
            ),
        },
        {
            "code": "P5",
            "name": "红白脸双人权力隔离（系统黑脸卡死 + 采购白脸私人贴补）",
            "theory": "Higher-Authority Constraint & 归因转移同盟效应",
            "when": "卖家死缠烂打逼你再多给一两百时：把拒绝责任全推给冷酷的 ERP 系统红线，你演『站在卖家这边的自己人』收口！",
            "highlight": f"系统黑脸锁死 ¥{bad_cop_sys_cap_yuan} + 你唱白脸私人权限贴 ¥{good_cop_bonus_yuan} 收口 ¥{keep_at_b_yuan}",
            "script": (
                f"哥我个人真挺想帮你把这单成了省得你折腾，但我们仓管开箱视频是直传公司 ERP 的，定损系统直接锁死这台最高只能批 ¥{bad_cop_sys_cap_yuan}（截图发你看了，高一分我都点不了提交）。"
                f"这样，我拿我自己这个月的议价机动权限私人帮你多顶 ¥{good_cop_bonus_yuan} 凑到 ¥{keep_at_b_yuan}！这是我能帮你的极限了，能行我现在锁单，不行系统今晚自动退回了。"
            ),
        },
        {
            "code": "P6",
            "name": "卡尼曼峰终定律·面子补偿防反水术",
            "theory": "Kahneman Peak-End Rule & 自我服务归因保护",
            "when": "大刀砍成（如 2000→800）准备关闲鱼单前必发！给卖家找无辜台阶把面子捧足，彻底杜绝半夜越想越气打 95338 反水！",
            "highlight": "砍最狠的价，递最暖的无辜台阶 → 消除屈辱感实现 0 反水率",
            "script": (
                f"哥，说心里话这处『{defect_short}』大概率也是快递路上震的或者平时光线暗真没留意，肯定不是你故意瞒我的。"
                f"看你处事这么爽快大气，我刚特意找财务主管打了招呼，把你这笔 ¥{corp_payout_yuan} 排进明早 10:00 第一批优先对公打款！交个朋友，以后你换设备出闲置直接微信发我，给你走熟人高价免验通道🤝"
            ),
        },
    ]

    game_anchors = [
        {
            "code": "G1",
            "name": "谢林可信承诺·破釜沉舟默认退件锁",
            "theory": "Schelling Credible Threat & 默认均衡反转 (Default Reversal)",
            "when": "面单打上『已拒签』那一刻：把『你不降价我就退』的空口威胁，变成『你不行动包裹就会自动退回亏运费』的既成事实！",
            "highlight": "已拒签 = 球在卖家脚下（卖家不妥协就 100% 自动亏运费收退货）",
            "script": (
                f"哥跟你说声，因为现场验出差异，顺丰面单已经录完拒签进退件池了（默认自动原路退回）。"
                f"如果你觉得退回去自己卖更合适，完全不用回复我，顺丰按流程自动给你拉回去就行；如果你不想折腾来回运费，按 ¥{keep_at_a_yuan} 告诉我一声，我再去帮你找仓管撤回拒签拦下来。"
            ),
        },
        {
            "code": "G2",
            "name": "鲁宾斯坦贴现因子压制（δ 耐心差晾单术）",
            "theory": "Rubinstein Alternating-Offers Patience (δ_B=0.96 > δ_S)",
            "when": "卖家主动问『少退点行不行』暴露急用钱底牌时：用我方无限货源耐心压制卖家现金流焦虑，严禁秒回！",
            "highlight": f"我方 δ=0.96 vs 卖家 δ={delta_seller} · {wait_badge}",
            "script": wait_advice,
        },
        {
            "code": "G3",
            "name": "阿克洛夫柠檬市场推演（击碎重卖给散客幻想）",
            "theory": "Akerlof Market for Lemons & 外部期权 (BATNA) 证伪",
            "when": "卖家嘴硬说『不卖你我退回去卖别人也一样』时，一针见血帮他推演退回重挂闲鱼的两条死胡同！",
            "highlight": "诚实标瑕疵散客砍更狠 vs 隐瞒标充新被散客闹小二退一赔三",
            "script": (
                f"哥你可以算算退回去重挂闲鱼就两条路：① 你实话实说把『{defect_short}』写进标题拍特写，一旦变成明牌瑕疵机，闲鱼散客出价比我给你的 ¥{keep_at_b_yuan} 还得再砍两三百，挂半个月没人问；"
                f"② 你要是不写继续发给普通散客，散客不像我们有自己整备师傅能消化，到手绝对跟你大闹闲鱼小二法庭扯皮半个月！卖给我们同行一次买断永无售后，其实是你最划算的出路。"
            ),
        },
        {
            "code": "G4",
            "name": "赫维茨信息甄别菜单（三契约测谎仪）",
            "theory": "Mechanism Design Screening & 分离均衡测谎",
            "when": "卖家狡辩『原装配件在老家忘寄了』或『这暗病绝对用不坏』时，抛出等价三契约直接测出真假！",
            "highlight": "现金折让买断 vs 24h顺丰补寄原装件测谎 vs 30天书面质保对赌",
            "script": (
                f"哥咱们最公平给你三个选择你自己挑：① 嫌麻烦直接按 ¥{keep_at_b_yuan} 买断结清，以后啥问题都不用你管；"
                f"② 如果原装配件真在你手头，你今天顺丰包邮补寄出来发我单号，那配件钱我一分不扣你，只扣外观折损按 ¥{min(int(paid_c//100)-50, keep_at_b_yuan + part2_part_yuan)} 结；"
                f"③ 如果你打包票这处隐患绝不影响后续使用，咱们签个 30 天内出故障包退全款协议。你看选哪个最顺手？"
            ),
        },
        {
            "code": "G5",
            "name": "子博弈完美最后通牒·顺丰封车物理截单锚",
            "theory": "Subgame-Perfect Ultimatum & 外部不可逆时钟焦点",
            "when": "卖家磨磨唧唧犹豫差最后一口气时：绑定顺丰网点 17:30 / 20:00 退件装车物理死线，20 分钟内逼出成交！",
            "highlight": "绑定顺丰班车扫码封车死线 · 最后 20 分钟过时不候",
            "script": (
                f"哥提醒一下，顺丰驻仓小哥再过 20 分钟（本班次退件截单点）准时扫退件码封车拉走，一旦扫上发车码我们系统也拦不回来了。"
                f"最后 20 分钟窗口：按实收 ¥{max(keep_at_b_yuan, int((paid_c - floor_c)//100))} 能定你回个准话，我马上让赵仓管把件从退件筐抱出来；过点没回我就让顺丰正常发走了哈。"
            ),
        },
        {
            "code": "G6",
            "name": "重复博弈无名氏定理·多机/同行卖家长期收编",
            "theory": "Repeated Game Folk Theorem & 未来收益折现 (Shadow of Future)",
            "when": "看卖家闲鱼主页还挂着多台镜头/电脑/掌机（发烧友或小同行）时：把一次性零和砍价转成长期免挂闲鱼秒回款大客户收编！",
            "highlight": "用『长期免上架直收 VIP 通道』换取本单痛快让步",
            "script": (
                f"老板刚看你闲鱼主页经常出高品质器材，咱们就不按一次性散客磨嘴皮了——我们仓库每天稳定收几十台，验完次日 10 点准时企业支付宝打款从不扯皮。"
                f"今天这台瑕疵咱们按同行公允价 ¥{keep_at_b_yuan} 痛快抹平交个朋友，我把你微信标进我们长期直收白名单，以后你有机器不用挂闲鱼应付到手刀散客，直接发我顺丰到仓秒结！"
            ),
        },
    ]

    psychology_arsenal = {
        "safe_add_wechat": {
            "phone_script": "喂哥，我是闲鱼买你机器的！刚顺丰派送到现场核对发现跟链接描述有出入（面单已先做拒签暂存快递员这），闲鱼发高清测试原片会吞画质看不清，你这个手机号能加微信吗？我马上加你把现场视频发你看下，咱们速战速决！",
            "xianyu_safe_note": "您好，包裹派送现场核验实物外观/配件与页面描述存在客观差异已暂缓拒签，高清检测原片较大，麻烦看下电联沟通核实处理，感谢。",
            "ban_warning": "🚫 闲鱼封号铁律：严禁在闲鱼聊天打字发『微信号/wx/V信/便宜点/退差价』！一律先拨打面单电话口头加微信转私域速战速决！",
        },
        "half_price_first_cut": {
            "short_wechat_quote": f"不用了，这成色跟链接写的差太多了。如果按 {half_keep_yuan} 可以接受，不行就直接退回吧。",
            "precise_reframe_quote": psych_anchors[2]["script"],
            "mental_reset_quote": psych_anchors[0]["script"],
            "coach": f"《首轮双模定锚》：散客直接甩 50% 半价『¥{half_keep_yuan} 可以接受』（省 ¥{int(half_price_slash_cents//100)} → 拿 10% 到货提成 ¥{int(half_price_comm_cents//100)}）；较真老手切『P3 三项带零头精确锚（实收 ¥{precise_keep_yuan}）』+『P1 废单重估法』！",
        },
        "indifferent_pushback": {
            "title": "🎯 卖家着急问『退你几十/200行不行，别退回来了』→ 欲擒故纵『假装毫不在意』三连游说（还原 laze 实战）",
            "step1_brush_off": "不用啦，谢谢，差这点解决不了问题，直接让顺丰退回给你吧。",
            "step2_reanchor": f"我本来等着用，但这状态原价肯定不收，{keep_at_a_yuan} 可以接受，不行真不用勉强。",
            "step3_persuade": f"哥我也跟你算句实在账：现在面单已经拒签了，真退回去一来一回顺丰保价费 ¥{roundtrip_freight_yuan} 直接打水漂，还得再等一周重新挂闲鱼，关键『{defect_short}』下个买家收到照样拒签砍更狠！按实收 ¥{keep_at_b_yuan}（少 ¥{b_yuan}）我现在让仓管把件扣下不退了，咱们整单关掉明天财务对公直接转你，大家都省心！",
        },
        "reluctant_accept_tough": {
            "title": "🛡️ 卖家态度极强硬（打 95338 真召回）+ 本单仍有利润/急用 →『嫌弃式勉强收下』保面子留货术",
            "script": "唉，算了吧，主要我这边装机/客户实在太急等着用了，重新买来不及——虽然你这机器成色确实这么烂，我也只能勉为其难先收下了。你给 95338 打个电话撤回退回指令让快递员正常派送吧（要不顺手抹个 50 块清洁费算了）。",
            "salvage_profit_yuan": int(salvage_zero_refund_net_cents // 100),
            "coach": (
                f"💎 系统测算：这台买前价格够香，哪怕卖家一分钱不退原价留下，扣掉整备后公司依然净赚 ¥{int(salvage_zero_refund_net_cents//100)}！"
                "千万别因为卖家态度硬就赌气真退把到嘴利润放飞！用这句『嫌弃式勉强收下』既不跌份，又能让卖家心甘情愿撤回 95338！"
                if is_salvage_profitable
                else "⚠️ 注意：本单原价留货无保底利润，若卖家强硬到底一分不退，请勿硬吞，按底线 C 判断真退即可！"
            ),
        },
        "wechat_4elem_lock": {
            "title": "📝 微信防反水《四要素文字定案确认卡》（谈妥必发，等卖家回『确认同意』再关闲鱼单！）",
            "script": (
                f"哥，刚咱们语音聊妥了，发文字核对留个底哈：① 这台机器因实物成色/配件差异，双方协商一致按实收总价 ¥{corp_payout_yuan} 成交留下（我方撤回拒签收下）；"
                f"② 闲鱼原单 ¥{int(paid_c//100)} 麻烦你点同意『整单全额退款』把平台交易关掉；"
                f"③ 成交款 ¥{corp_payout_yuan} 我现在登记进公司财务系统，走【支付宝对公支付】在明早 10:00（T+1账单核对）直转你本人实名支付宝，结清后双方无任何后续争议。"
                f"核对没问题麻烦回个『确认同意』，并发一下你本人的支付宝账号+实名姓名哈🤝"
            ),
            "peak_end_face_saver": psych_anchors[5]["script"],
        },
    }

    return {
        "anchor_a_cents": anchor_a,
        "target_b_cents": target_b,
        "floor_c_cents": floor_c,
        "half_price_slash_cents": half_price_slash_cents,
        "half_price_keep_cents": half_price_keep_cents,
        "half_price_comm_cents": half_price_comm_cents,
        "salvage_zero_refund_net_cents": salvage_zero_refund_net_cents,
        "is_salvage_profitable": is_salvage_profitable,
        "repair_cost_cents": implied_repair,
        "seller_offer_cents": offer_c,
        "eval_refund_cents": eval_refund,
        "keep_net_cents": keep_net,
        "replace_net_cents": replace_net,
        "better_to_keep": keep_net > replace_net,
        "comm_rate_pct": 10,
        "estimated_comm_cents": comm_10_cents,
        "arrival_track": bf.get("arrival_track") or ("signed_platform_return" if bf.get("return_mode") == "platform_return" else "sf_express_refuse"),
        "batna_label": f"退回卖家 + 同平台/本地 ¥{int(r_c//100)} 重买同款（净赚 ¥{int(replace_net//100)}）",
        "flow_state": bf,
        "logs": bargain_logs,
        "scripts": scripts,
        "objection_routes": objection_routes,
        "meso_options": meso_options,
        "ladder_steps": ladder_steps,
        "seller_signals": seller_signals,
        "phone_6step": phone_6step,
        "callback_script": callback_script,
        "corp_alipay_seller_script": corp_alipay_seller_script,
        "psychology_arsenal": psychology_arsenal,
        "psych_anchors": psych_anchors,
        "game_anchors": game_anchors,
        "red_face_voucher": red_face_voucher,
        "rubinstein_model": rubinstein_model,
    }


def build_case_object(
    case_row: dict[str, Any],
    leads_by_id: dict[str, dict[str, Any]],
    convs_by_id: dict[str, dict[str, Any]],
    orders_by_id: dict[str, dict[str, Any]],
    tickets_by_id: dict[str, dict[str, Any]],
    pb_by_id: dict[str, dict[str, Any]],
    res_by_id: dict[str, dict[str, Any]],
    msgs_by_conv: dict[str, list[dict[str, Any]]],
    rounds_by_conv: dict[str, list[dict[str, Any]]],
    ledger_by_po: dict[str, list[dict[str, Any]]],
    ledger_by_ticket: dict[str, list[dict[str, Any]]],
    comms_by_po: dict[str, list[dict[str, Any]]],
    gov_stages_by_case: dict[str, list[dict[str, Any]]],
    gov_reviews_by_case: dict[str, list[dict[str, Any]]],
    bargain_logs_by_ticket: dict[str, list[dict[str, Any]]],
    g06_map: dict[str, dict[str, Any]],
    corp_regs_by_ticket: dict[str, dict[str, Any]] | None = None,
) -> dict[str, Any]:
    cid = case_row["case_id"]
    lead = leads_by_id.get(case_row["lead_id"] or "")
    conv = convs_by_id.get(case_row["conv_id"] or "")
    order = orders_by_id.get(case_row["po_id"] or "")
    ticket = tickets_by_id.get(case_row["ticket_id"] or "")
    pb = pb_by_id.get(case_row["pricebook_id"] or "")
    res = res_by_id.get(case_row["quota_res_id"] or "")
    capture = json.loads(case_row["capture_json"])

    # 12-node internal state flags (for full API compatibility)
    has_conv_or_po = bool(conv or order or ticket or case_row["warehouse_check_state"] == "passed")
    s1_done = has_conv_or_po
    ev_ready = all(capture[k]["state"] in ("ok", "unknown") for k in ("declaration", "photos", "serial_report"))
    s2_done = s1_done and (ev_ready or bool(order or ticket or (conv and conv.get("agreed_price_cents"))))
    s3_done = s2_done and bool(
        order or ticket or (conv and 0 < conv["first_offer_cents"] <= conv["target_price_cents"] <= conv["ceiling_price_cents"])
    )
    s4_done = s3_done and bool(order or ticket or (conv and conv["pause_state"] != "pausing"))
    s5_done = s4_done and bool(order or ticket or (conv and conv.get("agreed_price_cents")))
    s6_done = s5_done and bool(
        ticket or (order and order["stage"] in ("price_checked", "manual_paid", "shipped", "completed"))
    )
    s7_done = s6_done and bool(
        ticket or (order and order["stage"] in ("manual_paid", "shipped", "completed"))
    )
    wh_passed = case_row["warehouse_check_state"] == "passed"
    s8_done = s7_done and (wh_passed or bool(ticket))

    if wh_passed and not ticket:
        s9_done = True
        s10_done = True
        s11_done = True
        s12_done = True
    else:
        s9_done = s8_done and bool(ticket and ticket.get("platform_return_no"))
        s10_done = s9_done and bool(
            ticket and ticket["stage"] in ("keep_partial_refund", "waiting_finance", "done", "full_return_shipping")
        )
        t_ledger = ledger_by_ticket.get(ticket["ticket_id"], []) if ticket else []
        pending_fin = sum(1 for x in t_ledger if x["status"] != "verified")
        s11_done = s10_done and bool(ticket and pending_fin == 0 and ticket["stock_disposition"] != "pending")
        s12_done = s11_done and bool(ticket and ticket["stage"] == "done")

    done_flags = [False, s1_done, s2_done, s3_done, s4_done, s5_done, s6_done, s7_done, s8_done, s9_done, s10_done, s11_done, s12_done]
    cur_step = 12
    for idx in range(1, 13):
        if not done_flags[idx]:
            cur_step = idx
            break

    nodes = []
    for n, short, title, p_cls, role_txt, desc in NODE_METAS:
        if wh_passed and not ticket and n in (9, 10, 11):
            st = "done"
            note = "验机全对，免走售后"
        elif done_flags[n]:
            st = "done"
            note = "已做好"
        elif n == cur_step:
            st = "cur"
            note = "现在做这步"
        else:
            st = "todo"
            note = "还没到"
        nodes.append({"n": n, "short": short, "title": title, "phase": p_cls, "role": role_txt, "desc": desc, "state": st, "note": note})

    raw_eval = json.loads(case_row.get("prebuy_eval_json") or "{}")
    wrote_ln = bool(raw_eval.get("seller_wrote_like_new", "几乎全新" in (case_row.get("condition_grade") or "")))
    blurry_ph = bool(raw_eval.get("photos_blurry_incomplete", False))
    full_disc = bool(raw_eval.get("defects_fully_disclosed", False))
    suspect_tag = bool(raw_eval.get("suspect_condition_tag", wrote_ln or blurry_ph))
    eval_done = bool(raw_eval.get("evaluated", False))
    can_sec_bargain = bool(wrote_ln or blurry_ph or not full_disc)
    focus_pts = list(raw_eval.get("warehouse_focus_points") or [])
    wh_buyer_note = str(raw_eval.get("buyer_note_to_warehouse") or "")

    if can_sec_bargain:
        potential_badge = "🎯 已标质疑成色·仓管重点验" if (eval_done and suspect_tag) else "🎯 可做二次议价（别追问·快打标）"
        coaching_rule = (
            "🤫 黄金铁律：卖家写了『几乎全新/99新』或照片模糊没披露全——千万别仔细问划痕！别让卖家补拍！"
            "直接按链接写的标准采购锁死快照，并打上『质疑成色』标让赵仓管到货重点抓未披露瑕疵！"
        )
    else:
        potential_badge = "瑕疵已全披露 · 买前严守上限"
        coaching_rule = "⚠️ 卖家已把每处瑕疵高清拍齐写清，到货基本没有二次议价空间！买前谈价必须严守上限，不能指望到货再砍。"

    prebuy_eval = {
        "evaluated": eval_done,
        "seller_wrote_like_new": wrote_ln,
        "photos_blurry_incomplete": blurry_ph,
        "defects_fully_disclosed": full_disc,
        "can_secondary_bargain": can_sec_bargain,
        "suspect_condition_tag": suspect_tag,
        "warehouse_focus_points": focus_pts,
        "buyer_note_to_warehouse": wh_buyer_note,
        "potential_badge": potential_badge,
        "coaching_rule": coaching_rule,
    }

    # Three crystal-clear order categories requested by user:
    # 1) completed = 已经完结的
    # 2) issue     = 二次议价 · 问题订单（核心利润锚点：9步手把手陪走二次议价）
    # 3) today     = 今天采购的（买前6步：含二次议价空间研判+给仓管打重点验机标）
    if s12_done:
        order_bucket = "completed"
        bucket_label = "已经完结的"
    elif ticket is not None or case_row["warehouse_check_state"] == "defect":
        order_bucket = "issue"
        bucket_label = "二次议价 · 问题订单"
    else:
        order_bucket = "today"
        bucket_label = "今天采购的"

    b_logs = bargain_logs_by_ticket.get(ticket["ticket_id"], []) if ticket else []

    # Step-In Accompaniment Progress:
    # - Pre-Buy Buying Flow = 6 Steps (explicitly separating Step 2: Assess Secondary Bargaining Potential & Tag Warehouse Focus!)
    # - Post-Arrival Secondary Bargaining Flow = 9 Granular Steps (never oversimplifying the core profit engine!)
    is_issue_flow = bool(ticket is not None or case_row["warehouse_check_state"] == "defect")
    if not is_issue_flow:
        b1_done = bool(capture["declaration"]["state"] == "ok" or s1_done)
        b2_done = bool(eval_done or order is not None or wh_passed)
        b3_done = bool(s5_done)
        b4_done = bool(s7_done)
        b5_done = bool(s8_done)
        b6_done = bool(s12_done)
        b_flags = [b1_done, b2_done, b3_done, b4_done, b5_done, b6_done]
        ui_cur = 6
        for idx_b, flg in enumerate(b_flags, start=1):
            if not flg:
                ui_cur = idx_b
                break
        buy_titles = [
            "看清货况锁快照",
            "判二次议价·打标",
            "按打法谈拢价格",
            "核对改价付款",
            "派送10m验·拒签",
            "入库拿10%提成",
        ]
        ui_steps = []
        for idx_b, bt in enumerate(buy_titles, start=1):
            st_b = "done" if (b_flags[idx_b - 1] and (idx_b < ui_cur or s12_done)) else ("cur" if idx_b == ui_cur and not s12_done else ("done" if s12_done else "todo"))
            ui_steps.append({"n": idx_b, "t": bt, "state": st_b})
        step_progress = {
            "mode": "buying",
            "cur": ui_cur,
            "total": 6,
            "summary": "全部做完 · 已入良品库" if s12_done else f"买前采购 · 第 {ui_cur}/6 步：{ui_steps[ui_cur - 1]['t']}",
            "steps": ui_steps,
        }
    else:
        bf = json.loads((ticket.get("bargain_flow_json") if ticket else None) or "{}")
        has_ret_no = bool(ticket and ticket.get("platform_return_no"))
        has_r1_log = any(x["role_side"] == "buyer" and x["round_no"] == 1 for x in b_logs)
        has_r2_log = any(x["round_no"] >= 2 for x in b_logs)
        settled_stage = bool(ticket and ticket["stage"] in ("keep_partial_refund", "waiting_finance", "full_return_shipping", "done"))

        i1 = bool(bf.get("step1_triage_done", True) or has_ret_no or s12_done)
        i2 = bool(has_ret_no or s12_done)
        i3 = bool(i2 and (bf.get("step3_signal_done") or has_r1_log or settled_stage or s12_done))
        i4 = bool(i3 and (bf.get("step4_calc_done") or (ticket and ticket.get("plan_b_calc_hash")) or has_r1_log or settled_stage or s12_done))
        i5 = bool(i4 and (bf.get("step5_round1_done") or has_r1_log or settled_stage or s12_done))
        i6 = bool(i5 and (bf.get("step6_round2_done") or has_r2_log or settled_stage or s12_done))
        i7 = bool(i6 and (bf.get("step7_cooldown_done") or settled_stage or s12_done))
        i8 = bool(i7 and (settled_stage or s12_done))
        i9 = bool(s12_done)

        i_flags = [i1, i2, i3, i4, i5, i6, i7, i8, i9]
        ui_cur = 9
        for idx_i, flg in enumerate(i_flags, start=1):
            if not flg:
                ui_cur = idx_i
                break
        cur_track = bf.get("arrival_track") or ("signed_platform_return" if bf.get("return_mode") == "platform_return" else "sf_express_refuse")
        if cur_track == "signed_platform_return":
            iss_titles = [
                "验货抓差·判路线",
                "先提退货锁48h",
                "等卖家先提留货",
                "PlanB重算·报首锚",
                "沉默施压·稳高位",
                "阶梯让步·拆顶嘴",
                "先退后回·冷却救单",
                "整单退·对公登记",
                "T+1审批·入库完结",
            ]
        else:
            iss_titles = [
                "派送10m验·判路线",
                "拒签10m+加微信",
                "盯95338·看急不急",
                "首刀直接半价砍",
                "假装不在意·不用啦",
                "顶嘴拆招·游说收网",
                "强硬兜底·勉强收下",
                "微信定案·对公登记",
                "撤95338·T+1完结",
            ]
        ui_steps = []
        for idx_i, it in enumerate(iss_titles, start=1):
            st_i = "done" if (i_flags[idx_i - 1] and (idx_i < ui_cur or s12_done)) else ("cur" if idx_i == ui_cur and not s12_done else ("done" if s12_done else "todo"))
            ui_steps.append({"n": idx_i, "t": it, "state": st_i})
        step_progress = {
            "mode": "issue",
            "arrival_track": cur_track,
            "cur": ui_cur,
            "total": 9,
            "summary": "二次议价完结 · 两段10%提成已确认" if s12_done else f"二次议价 · 第 {ui_cur}/9 步：{ui_steps[ui_cur - 1]['t']}",
            "steps": ui_steps,
        }

    # Plain-Chinese Action Prompts (Zero jargon, jump straight to exact UI step!)
    issues: list[dict[str, Any]] = []
    missing_ev = [k for k, v in capture.items() if v["state"] == "missing" and k != "price_shot"]
    unknown_ev = [v["name"] for v in capture.values() if v["state"] == "unknown"]

    if not is_issue_flow and not s12_done:
        if not eval_done:
            issues.append({
                "lvl": "red",
                "text": "收货前进阶必做：卖家写了『几乎全新』且图片模糊——千万别仔细追问划痕！快去第 2 步给赵仓管打上『质疑成色·重点深检』标记，直接按链接标准买！",
                "go": "flow",
                "step": 2,
            })
        if conv and conv["pause_state"] == "pausing":
            issues.append({"lvl": "red", "text": "自动助手刚发了一句话还在路上——先点「让自动助手停嘴」再打字，免得同时报两个价穿帮", "go": "flow", "step": 3})
        if conv and conv["needs_manual"] and conv["idle_minutes"] >= 10 and conv["pause_state"] == "auto" and eval_done:
            extra_warn = "（卖家已全披露瑕疵无二次议价空间，严守上限！）" if full_disc else ""
            issues.append({"lvl": "red", "text": f"卖家咬住 ¥{conv['seller_price_cents']/100:.0f} 不降{extra_warn}——去第 3 步压价或问王主管能不能特批", "go": "flow", "step": 3})
        if order and order["stage"] == "verbal_agreed":
            issues.append({"lvl": "red", "text": f"口头聊好了 ¥{order['agreed_cents']/100:.0f}，去第 4 步核对闲鱼页面真改好价格没有——没改好千万别付款", "go": "flow", "step": 4})
        if order and order["stage"] == "price_checked":
            issues.append({"lvl": "red", "text": f"闲鱼价格已改成 ¥{order['agreed_cents']/100:.0f}，去第 4 步填企业支付宝单号，锁死买前快照与仓管重点验机标", "go": "flow", "step": 4})
        if order and order["stage"] in ("manual_paid", "shipped") and case_row["warehouse_check_state"] == "pending":
            tag_hint = "（带『🎯 质疑成色』重点深检红靶子！）" if suspect_tag else ""
            issues.append({"lvl": "red", "text": f"⚡ 快递正在派送{tag_hint}——请【赵仓管】必须在 10 分钟内速战速决返回结果（不符当场拒签并拍面单状态）！", "go": "flow", "step": 5})
        if missing_ev and ui_cur == 1:
            issues.append({"lvl": "amb", "text": "先在第 1 步确认型号并锁死商品页原始描述与图片快照", "go": "flow", "step": 1})
        if unknown_ev:
            issues.append({"lvl": "amb", "text": f"有「暂时拿不到」的项（{'、'.join(unknown_ev)}）——后续随时可补录", "go": "flow", "step": 1})
    elif is_issue_flow and not s12_done and ticket:
        if ui_cur == 2:
            issues.append({"lvl": "red", "text": "⚡ 仓管派送 6 分钟已拒签！业务员必须在 10 分钟内响应：①确认快递面单已显示『拒签』+ ②第一时间电联加上卖家微信速战速决！", "go": "flow", "step": 2})
        elif ui_cur == 3:
            issues.append({"lvl": "red", "text": "已确认面单拒签并加上卖家微信！去第 3 步发实拍原片，盯顺丰 95338 状态看卖家急不急（首刀准备直接半价大砍！）", "go": "flow", "step": 3})
        elif ui_cur in (4, 5, 6):
            offer_txt = f"卖家很着急问『退 ¥{ticket['partial_refund_cents']/100:.0f} 行不行别退回来了』" if ticket["partial_refund_cents"] > 0 else "首刀直接半价（50%）大刀定锚"
            issues.append({"lvl": "red", "text": f"{offer_txt}——去第 {ui_cur} 步假装毫不在意回『不用了，谢谢』+ 游说退回三笔亏本账（砍得越多10%到货提成越多！）", "go": "flow", "step": ui_cur})
        elif ui_cur == 7:
            issues.append({"lvl": "red", "text": "卖家态度极强硬打 95338 喊退！去第 7 步选『嫌弃式勉强收下（算了吧太急了勉强收下+撤95338）』保住 ¥530 保底肥肉，或打二次回拨压底线！", "go": "flow", "step": 7})
        elif ui_cur == 8:
            payout_y = max(50, int((ticket["paid_cents"] - (ticket["partial_refund_cents"] or 0)) // 100))
            issues.append({
                "lvl": "red",
                "text": f"已谈妥 ¥{payout_y} 留货！为防平台一刀切弹账号红标、防卖家恶意差评及二次申诉，请去第 8 步走『闲鱼整单全退关单 + 支付宝对公支付登记』（交财务次日 10:00 T+1 审批）！",
                "go": "flow",
                "step": 8,
            })
        if ticket["carrier_intercept_status"] == "requested":
            issues.append({"lvl": "red", "text": "顺丰包裹还在半路拦截中——确认截回前锁死严禁入库上架！", "go": "flow", "step": 9})
        if ui_cur == 9:
            t_ledger = ledger_by_ticket.get(ticket["ticket_id"], [])
            unv = sum(1 for x in t_ledger if x["status"] != "verified")
            if unv > 0:
                issues.append({
                    "lvl": "red",
                    "text": f"已做好支付宝对公支付登记（共 {unv} 笔待核），因账单 T+1 结算，待【陈会计】次日 10:00 审批完成并填支付宝对公电子回单",
                    "go": "flow",
                    "step": 9,
                })
            if ticket["stock_disposition"] == "pending":
                issues.append({"lvl": "red", "text": "待【赵仓管】确认实物入库并把瑕疵实拍开放给销售从 ERP 自取，双清后立即发到货 10% 提成", "go": "flow", "step": 9})

    issues.sort(key=lambda x: 0 if x["lvl"] == "red" else 1)
    lvl = "red" if any(x["lvl"] == "red" for x in issues) else ("amb" if issues else "grn")

    seller_cents = (
        (order["paid_cents"] or order["agreed_cents"]) if order else
        (conv["agreed_price_cents"] or conv["seller_price_cents"]) if conv else
        (lead["seller_price_cents"] if lead else 0)
    )
    ref_cents = (
        conv["ref_price_cents"] if conv else
        (pb["ref_price_cents"] if pb else (lead["ref_price_cents"] if lead else (ticket["s_market_cents"] if ticket else seller_cents)))
    )
    first_cents = conv["first_offer_cents"] if conv else (pb["first_offer_cents"] if pb else int(ref_cents * 0.88 // 100 * 100))
    target_cents = conv["target_price_cents"] if conv else (pb["target_cents"] if pb else int(ref_cents * 0.91 // 100 * 100))
    ceiling_cents = conv["ceiling_price_cents"] if conv else (pb["ceiling_cents"] if pb else int(ref_cents * 0.94 // 100 * 100))

    po_id = order["po_id"] if order else (ticket["po_id"] if ticket else None)
    g06_entry = g06_map.get(po_id) if po_id else None
    net_cost_cents = g06_entry["net_cost_cents"] if g06_entry else (order["paid_cents"] if order and order["paid_cents"] else None)

    po_ledger = ledger_by_po.get(po_id, []) if po_id else []
    po_comms = comms_by_po.get(po_id, []) if po_id else []
    b_logs = bargain_logs_by_ticket.get(ticket["ticket_id"], []) if ticket else []
    bargain_plan = build_bargain_plan(ticket, b_logs)

    # Estimated / confirmed commission for hero card
    if po_comms:
        est_comm_cents = sum(x["confirmed_cents"] if x["status"] == "paid" else x["estimated_cents"] for x in po_comms if x["status"] != "reversed")
    elif bargain_plan:
        est_comm_cents = bargain_plan["estimated_comm_cents"]
    else:
        saving_c = max(0, ref_cents - seller_cents)
        est_comm_cents = int(round(saving_c * 0.10))

    owner_info = ROLES.get(case_row["owner_id"], {"name": case_row["owner_id"], "role_label": "采购业务员"})
    return {
        **case_row,
        "owner_name": owner_info["name"],
        "owner_role_label": owner_info["role_label"],
        "order_bucket": order_bucket,
        "bucket_label": bucket_label,
        "prebuy_eval": prebuy_eval,
        "step_progress": step_progress,
        "bargain_plan": bargain_plan,
        "lvl": lvl,
        "issues": issues,
        "current_step": cur_step,
        "all_done": s12_done,
        "nodes": nodes,
        "capture": capture,
        "prices": {
            "seller_or_agreed_cents": seller_cents,
            "has_agreed": bool((order and order["agreed_cents"]) or (conv and conv.get("agreed_price_cents"))),
            "has_paid": bool((order and order["paid_cents"]) or (ticket and ticket["paid_cents"])),
            "ref_price_cents": ref_cents,
            "first_offer_cents": first_cents,
            "target_price_cents": target_cents,
            "ceiling_price_cents": ceiling_cents,
            "saving_vs_ref_cents": ref_cents - seller_cents if ref_cents and seller_cents else 0,
            "net_cost_cents": net_cost_cents,
            "est_comm_cents": est_comm_cents,
        },
        "lead": lead,
        "conversation": conv,
        "messages": msgs_by_conv.get(conv["conv_id"], []) if conv else [],
        "rounds": rounds_by_conv.get(conv["conv_id"], []) if conv else [],
        "order": order,
        "ticket": ticket,
        "corp_alipay_reg": (corp_regs_by_ticket or {}).get(ticket["ticket_id"]) if ticket else None,
        "pricebook_item": pb,
        "quota_reservation": res,
        "ledger_entries": po_ledger,
        "commissions": po_comms,
        "governance_stages": gov_stages_by_case.get(cid, []),
        "governance_reviews": gov_reviews_by_case.get(cid, []),
    }


def fetch_dashboard() -> dict[str, Any]:
    with DB_LOCK:
        conn = get_conn()
        try:
            pool = dict(conn.execute("SELECT * FROM quota_pool WHERE pool_id='POOL-202611'").fetchone())
            pool["available_cents"] = pool["total_cents"] - pool["reserved_cents"] - pool["spent_cents"]
            reservations = [dict(r) for r in conn.execute("SELECT * FROM quota_reservations ORDER BY created_at DESC")]
            leads = [dict(r) for r in conn.execute("SELECT * FROM discovery_leads ORDER BY created_at DESC")]
            windows = [dict(r) for r in conn.execute("SELECT * FROM window_leases ORDER BY window_id")]
            convs = [dict(r) for r in conn.execute("SELECT * FROM conversations ORDER BY updated_at DESC")]
            fav_sellers = [dict(r) for r in conn.execute("SELECT * FROM favorite_sellers ORDER BY updated_at DESC")]
            for fs in fav_sellers:
                fs["tags"] = json.loads(fs.get("tags_json") or "[]")
            fav_by_seller = {fs["seller_id"]: fs for fs in fav_sellers}

            exec_jobs = [dict(r) for r in conn.execute("SELECT * FROM executor_jobs ORDER BY updated_at DESC LIMIT 50")]
            for jb in exec_jobs:
                jb["payload"] = json.loads(jb.get("payload_json") or "{}")

            snaps_rows = [dict(r) for r in conn.execute("SELECT * FROM item_snapshots ORDER BY product_id, version_no DESC")]
            latest_snap_by_pid: dict[str, dict[str, Any]] = {}
            for sp in snaps_rows:
                sp["images"] = json.loads(sp.get("images_json") or "[]")
                if sp["product_id"] not in latest_snap_by_pid:
                    latest_snap_by_pid[sp["product_id"]] = sp

            for c in convs:
                c["snapshot"] = json.loads(c["snapshot_json"])
                c["evidence_urls"] = json.loads(c["evidence_urls_json"])
                sid = c.get("seller_id") or ""
                c["is_favorite_seller"] = sid in fav_by_seller
                c["favorite_info"] = fav_by_seller.get(sid)
                c["item_snapshot"] = latest_snap_by_pid.get(c.get("external_thread_id") or "")
            msgs = [dict(r) for r in conn.execute("SELECT * FROM messages ORDER BY created_at ASC")]
            rounds = [dict(r) for r in conn.execute("SELECT * FROM negotiation_rounds ORDER BY round_no ASC")]
            pricebook = [dict(r) for r in conn.execute("SELECT * FROM pricebook_items ORDER BY model_code, version_no DESC")]
            policies = [dict(r) for r in conn.execute("SELECT * FROM policy_configs ORDER BY key")]
            for p in policies:
                p["value"] = json.loads(p["value_json"])
            orders = [dict(r) for r in conn.execute("SELECT * FROM orders ORDER BY updated_at DESC")]
            for o in orders:
                o["snapshot"] = json.loads(o["snapshot_json"])
                o["rpa_missing_fields"] = json.loads(o["rpa_missing_fields_json"])
            rpa_events = [dict(r) for r in conn.execute("SELECT * FROM rpa_events ORDER BY created_at DESC LIMIT 30")]
            tickets = [dict(r) for r in conn.execute("SELECT * FROM aftersales_tickets ORDER BY ticket_id")]
            bargain_logs = [dict(r) for r in conn.execute("SELECT * FROM aftersales_bargain_logs ORDER BY created_at ASC")]
            ledger = [dict(r) for r in conn.execute("SELECT * FROM finance_ledger ORDER BY created_at DESC")]
            commissions = [dict(r) for r in conn.execute("SELECT * FROM commissions ORDER BY created_at DESC")]
            audits = [dict(r) for r in conn.execute("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50")]
            onb_rows = {r["actor_id"]: dict(r) for r in conn.execute("SELECT * FROM onboarding_progress")}
            help_reqs = [dict(r) for r in conn.execute("SELECT * FROM help_requests ORDER BY created_at DESC LIMIT 30")]
            dev_reqs = [dict(r) for r in conn.execute("SELECT * FROM dev_requests ORDER BY updated_at DESC LIMIT 30")]
            corp_regs = [dict(r) for r in conn.execute("SELECT * FROM corp_alipay_registrations ORDER BY created_at DESC")]
            corp_regs_by_ticket = {r["ticket_id"]: r for r in corp_regs}

            g06_map = compute_g06_map(ledger)

            leads_by_id = {x["lead_id"]: x for x in leads}
            convs_by_id = {x["conv_id"]: x for x in convs}
            orders_by_id = {x["po_id"]: x for x in orders}
            tickets_by_id = {x["ticket_id"]: x for x in tickets}
            pb_by_id = {x["item_id"]: x for x in pricebook}
            res_by_id = {x["res_id"]: x for x in reservations}

            msgs_by_conv: dict[str, list[dict[str, Any]]] = {}
            for m in msgs:
                msgs_by_conv.setdefault(m["conv_id"], []).append(m)
            rounds_by_conv: dict[str, list[dict[str, Any]]] = {}
            for r in rounds:
                rounds_by_conv.setdefault(r["conv_id"], []).append(r)
            ledger_by_po: dict[str, list[dict[str, Any]]] = {}
            ledger_by_ticket: dict[str, list[dict[str, Any]]] = {}
            for l in ledger:
                ledger_by_po.setdefault(l["po_id"], []).append(l)
                if l["ticket_id"]:
                    ledger_by_ticket.setdefault(l["ticket_id"], []).append(l)
            comms_by_po: dict[str, list[dict[str, Any]]] = {}
            for cm in commissions:
                comms_by_po.setdefault(cm["po_id"], []).append(cm)
            bargain_logs_by_ticket: dict[str, list[dict[str, Any]]] = {}
            for bl in bargain_logs:
                bargain_logs_by_ticket.setdefault(bl["ticket_id"], []).append(bl)

            gov_stages_by_case: dict[str, list[dict[str, Any]]] = {}
            for gs in conn.execute("SELECT * FROM case_governance_stages ORDER BY case_id, stage_no ASC"):
                gov_stages_by_case.setdefault(gs["case_id"], []).append(dict(gs))
            gov_reviews_by_case: dict[str, list[dict[str, Any]]] = {}
            for gr in conn.execute("SELECT * FROM case_governance_reviews ORDER BY created_at DESC"):
                gov_reviews_by_case.setdefault(gr["case_id"], []).append(dict(gr))

            raw_cases = [dict(r) for r in conn.execute("SELECT * FROM procurement_cases ORDER BY case_id ASC")]
            cases = [
                build_case_object(
                    c, leads_by_id, convs_by_id, orders_by_id, tickets_by_id, pb_by_id, res_by_id,
                    msgs_by_conv, rounds_by_conv, ledger_by_po, ledger_by_ticket, comms_by_po,
                    gov_stages_by_case, gov_reviews_by_case, bargain_logs_by_ticket, g06_map, corp_regs_by_ticket
                )
                for c in raw_cases
            ]
            lvl_rank = {"red": 0, "amb": 1, "grn": 2}
            cases.sort(key=lambda x: (lvl_rank.get(x["lvl"], 9), x["case_id"]))

            target_pol = next((p for p in policies if p["key"] == "daily_comm_target"), None)
            daily_target_cents = int((target_pol["value"].get("value") if target_pol else None) or 100000)

            pre_buy_expected_cents = sum(
                int(cm["estimated_cents"]) for cm in commissions
                if cm["status"] != "reversed" and str(cm["policy_mode"]).startswith("pre_buy")
            )
            post_arrival_expected_cents = sum(
                int(cm["estimated_cents"]) for cm in commissions
                if cm["status"] != "reversed" and str(cm["policy_mode"]).startswith("post_arrival")
            )
            # Include open Tickets not yet written into commissions table (e.g. TK-2404 / TK-2401 target estimate)
            comm_ticket_ids = {cm["ticket_id"] for cm in commissions if cm.get("ticket_id")}
            for c_item in cases:
                tk_item = c_item.get("ticket")
                bp_item = c_item.get("bargain_plan")
                if tk_item and bp_item and tk_item["ticket_id"] not in comm_ticket_ids and tk_item["stage"] != "full_return_shipping":
                    post_arrival_expected_cents += int(bp_item.get("estimated_comm_cents") or 0)

            today_expected_cents = pre_buy_expected_cents + post_arrival_expected_cents
            confirmed_only_cents = sum(int(cm["confirmed_cents"]) for cm in commissions if cm["status"] == "confirmed")
            paid_only_cents = sum(int(cm["confirmed_cents"]) for cm in commissions if cm["status"] == "paid")
            reversed_only_cents = sum(int(cm["estimated_cents"]) for cm in commissions if cm["status"] == "reversed")

            daily_earnings = {
                "daily_target_cents": daily_target_cents,
                "today_expected_cents": today_expected_cents,
                "pre_buy_expected_cents": pre_buy_expected_cents,
                "post_arrival_expected_cents": post_arrival_expected_cents,
                "remaining_to_target_cents": max(0, daily_target_cents - today_expected_cents),
                "progress_pct": min(100, int(round(today_expected_cents * 100 / max(1, daily_target_cents)))),
                "confirmed_cents": confirmed_only_cents,
                "paid_cents": paid_only_cents,
                "reversed_cents": reversed_only_cents,
                "formula_summary": "买前(参考价M − 首轮成交P)×10% + 到货实际退回差价R×10%（独立核算不重算）",
            }

            stmt_rec = build_statement_reconciliation(conn, orders, cases)
            acct_shield = build_account_risk_shield(conn, cases)

            return {
                "roles": list(ROLES.values()),
                "cases": cases,
                "statement_reconciliation": stmt_rec,
                "account_risk_shield": acct_shield,
                "corp_alipay_registrations": corp_regs,
                "favorite_sellers": fav_sellers,
                "executor_jobs": exec_jobs,
                "item_snapshots": snaps_rows,
                "daily_earnings": daily_earnings,
                "quota_pool": pool,
                "quota_reservations": reservations,
                "discovery_leads": leads,
                "window_leases": windows,
                "conversations": convs,
                "messages": msgs,
                "negotiation_rounds": rounds,
                "pricebook": pricebook,
                "policies": policies,
                "orders": orders,
                "rpa_events": rpa_events,
                "aftersales_tickets": tickets,
                "aftersales_bargain_logs": bargain_logs,
                "finance_ledger": ledger,
                "g06_net_costs": list(g06_map.values()),
                "commissions": commissions,
                "audit_logs": audits,
                "onboarding_progress": onb_rows,
                "help_requests": help_reqs,
                "dev_requests": dev_reqs,
                "kpi_meta": {
                    "metric": "采购两段 10% 提成（买前差额×10% + 到货实际退回差价×10%） & 一次验机合格率",
                    "formula": "买前省钱提成 =（冻结参考价 M − 首轮成交价 P）× 10%；到货提成 = 实际退回/折让差价 R × 10%（两段独立核算绝不把 R 代回 M−(P−R) 重复计提）",
                    "window": "个人单日目标默认 ¥1,000；预计、已确认、已发放三栏严格独立展示，绝不混加",
                    "viewer": "采购业务员本人、采购主管、财务对账会计",
                    "anti_gaming": "若买前隐瞒卖家已告知的瑕疵虚报省钱，或订单最终全额退货未留成，预计提成自动冲销归零。",
                },
                "server_time": now_iso(),
            }
        finally:
            conn.close()


def fetch_single_case(case_id: str) -> tuple[int, dict[str, Any]]:
    dash = fetch_dashboard()
    for c in dash["cases"]:
        if c["case_id"] == case_id:
            return 200, {"ok": True, "case": c}
    return 404, {"ok": False, "code": "CASE_NOT_FOUND", "error": f"找不到这笔采购订单: {case_id}"}


def handle_api_post(path: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    actor = require_actor(body)
    ts = now_iso()

    with DB_LOCK:
        conn = get_conn()
        try:
            conn.execute("BEGIN IMMEDIATE")

            if path == "/api/demo/reset":
                conn.rollback()
                conn.close()
                init_db(force_reset=True)
                return 200, {"ok": True, "message": "已恢复到初始演示数据", "data": fetch_dashboard()}

            if path == "/api/onboarding/practice":
                aid = actor["id"]
                conn.execute(
                    "INSERT OR IGNORE INTO onboarding_progress (actor_id, chat_guard, price_pay, return_planb, tour_done_json, first_order_checklist_done, updated_at) VALUES (?,?,?,?,?,?,?)",
                    (aid, 0, 0, 0, "[]", 0, ts),
                )
                if body.get("reset"):
                    conn.execute(
                        "UPDATE onboarding_progress SET chat_guard=0, price_pay=0, return_planb=0, tour_done_json='[]', first_order_checklist_done=0, updated_at=? WHERE actor_id=?",
                        (ts, aid),
                    )
                    log_audit(conn, aid, "重置新手练习进度", aid, "只重置练习进度，不动任何真实订单")
                elif body.get("unlock_all"):
                    conn.execute(
                        "UPDATE onboarding_progress SET chat_guard=3, price_pay=3, return_planb=3, updated_at=? WHERE actor_id=?",
                        (ts, aid),
                    )
                    log_audit(conn, aid, "解锁实操权限", aid, "已完成全部新手练习")
                elif body.get("complete_first_checklist"):
                    conn.execute(
                        "UPDATE onboarding_progress SET first_order_checklist_done=1, updated_at=? WHERE actor_id=?",
                        (ts, aid),
                    )
                    log_audit(conn, aid, "完成首单核对清单", aid, "首单防错核对完成")
                else:
                    k = str(body.get("key") or "")
                    if k not in ("chat_guard", "price_pay", "return_planb"):
                        raise ApiError(400, f"找不到这个练习关卡: {k}")
                    step_val = max(0, min(3, int(body.get("step") or 3)))
                    conn.execute(f"UPDATE onboarding_progress SET {k} = MAX({k}, ?), updated_at=? WHERE actor_id=?", (step_val, ts, aid))
                    log_audit(conn, aid, "完成防呆练习关卡", k, f"进度 {step_val}/3")
                conn.execute("COMMIT")
                cur_onb = dict(conn.execute("SELECT * FROM onboarding_progress WHERE actor_id=?", (aid,)).fetchone())
                return 200, {"ok": True, "onboarding": cur_onb}

            if path == "/api/help-requests":
                note = str(body.get("note") or "").strip()
                if len(note) < 2:
                    raise ApiError(400, "请用一句话写清遇到了什么拿不准的情况（至少 2 个字）")
                hid = f"HELP-{int(time.time()*1000)%100000}"
                conn.execute(
                    "INSERT INTO help_requests (help_id, actor_id, page_key, category, note, conv_id, status, resolved_by, rule_draft, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (hid, actor["id"], str(body.get("page_key") or "采购工作台"), str(body.get("category") or "没见过的情况"), note, body.get("conv_id"), "open", None, 0, ts),
                )
                log_audit(conn, actor["id"], "上报没见过的情况", hid, note[:60])
                conn.execute("COMMIT")
                return 200, {"ok": True, "help_id": hid}

            if path.startswith("/api/help-requests/") and path.endswith("/resolve"):
                if actor["role"] != "supervisor":
                    raise ApiError(403, "只有【采购主管】可以回复处理并记成新规则", "ROLE_FORBIDDEN")
                hid = path.split("/")[3]
                row_h = conn.execute("SELECT * FROM help_requests WHERE help_id=?", (hid,)).fetchone()
                if not row_h:
                    raise ApiError(404, f"找不到这条求助记录: {hid}")
                make_rule = 1 if body.get("make_rule", True) else 0
                conn.execute("UPDATE help_requests SET status='resolved', resolved_by=?, rule_draft=? WHERE help_id=?", (actor["id"], make_rule, hid))
                log_audit(conn, actor["id"], "主管处理求助并沉淀规则", hid, "主管已回复处理办法")
                conn.execute("COMMIT")
                return 200, {"ok": True, "help_id": hid}

            if path == "/api/dev-requests":
                title = str(body.get("title") or "").strip()
                detail = str(body.get("detail") or "").strip()
                kind = str(body.get("kind") or "bug")
                if len(title) < 3 or len(detail) < 4:
                    raise ApiError(400, "标题至少 3 个字、说明至少 4 个字，写清哪一页不好用就行")
                rid = f"DEV-{int(time.time()*1000)%100000}"
                conn.execute(
                    "INSERT INTO dev_requests VALUES (?,?,?,?,?,?,?,?,?)",
                    (rid, actor["id"], actor["name"], kind, title, str(body.get("page_key") or "采购工作台"), detail, "待评审", ts),
                )
                log_audit(conn, actor["id"], "提给开发改进建议", rid, f"[{kind}] {title}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "req_id": rid}

            if path.startswith("/api/dev-requests/") and path.endswith("/status"):
                rid = path.split("/")[3]
                row_d = conn.execute("SELECT * FROM dev_requests WHERE req_id=?", (rid,)).fetchone()
                if not row_d:
                    raise ApiError(404, f"找不到这条反馈: {rid}")
                new_st = str(body.get("status") or "")
                if new_st in ("开发中", "待提需求的人验收") and actor["role"] != "supervisor":
                    raise ApiError(403, "只有【采购主管】可评审推进开发进度", "ROLE_FORBIDDEN")
                if new_st in ("已验收", "打回重改") and row_d["actor_id"] != actor["id"] and actor["role"] != "supervisor":
                    raise ApiError(403, "谁提的建议谁验收：请原提交人或主管点确认", "ROLE_FORBIDDEN")
                conn.execute("UPDATE dev_requests SET status=?, updated_at=? WHERE req_id=?", (new_st, ts, rid))
                log_audit(conn, actor["id"], "更新开发反馈状态", rid, f"状态改为 {new_st}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "req_id": rid, "status": new_st}

            if path == "/api/snapshots/save":
                product_id = str(body.get("product_id") or "").strip()
                if not product_id:
                    raise ApiError(400, "product_id 不能为空")
                source_url = str(body.get("source_url") or f"https://www.goofish.com/item?id={product_id}")
                title_raw = str(body.get("title_raw") or body.get("title") or f"闲鱼商品 {product_id}")
                desc_raw = str(body.get("description_raw") or body.get("description") or "")
                qual_raw = str(body.get("quality_raw") or body.get("quality") or "")
                specs_raw = str(body.get("specs_raw") or body.get("specs") or "")
                price_txt = str(body.get("asking_price_text") or body.get("askingPriceText") or "")
                imgs = [str(u) for u in (body.get("images") or []) if str(u).strip()][:10]
                v_row = conn.execute("SELECT COALESCE(MAX(version_no), 0) AS v FROM item_snapshots WHERE product_id=?", (product_id,)).fetchone()
                next_ver = int(v_row["v"]) + 1
                conn.execute(
                    "INSERT INTO item_snapshots VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (product_id, next_ver, source_url, title_raw, desc_raw, qual_raw, specs_raw, price_txt, json_dumps(imgs), ts),
                )
                log_audit(conn, actor["id"], "抓取/更新商品页原始多图快照", product_id, f"v{next_ver} · {len(imgs)}张图 · {title_raw[:36]}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "product_id": product_id, "version_no": next_ver, "image_count": len(imgs)}

            # Enforce Server-Side Practice Gate on ALL Real Business Write Endpoints
            check_practice_gate(conn, actor)

            # Backward-compatible governance endpoints
            if path.startswith("/api/cases/") and "/governance/" in path:
                parts = path.split("/")
                case_id = parts[3]
                gov_act = parts[5]
                crow = conn.execute("SELECT * FROM procurement_cases WHERE case_id=?", (case_id,)).fetchone()
                if not crow:
                    raise ApiError(404, f"找不到这笔订单: {case_id}")

                if gov_act == "submit":
                    stage_no = int(body.get("stage_no") or 0)
                    note = str(body.get("note") or "").strip()
                    validate_no_zero_placeholder({"材料说明": note})
                    if len(note) < 4:
                        raise ApiError(400, "说明至少写 4 个字")
                    gs = conn.execute("SELECT * FROM case_governance_stages WHERE case_id=? AND stage_no=?", (case_id, stage_no)).fetchone()
                    if not gs:
                        raise ApiError(404, f"阶段 {stage_no} 不存在")
                    new_ver = int(gs["version_no"]) + 1
                    conn.execute(
                        "UPDATE case_governance_stages SET state='submitted', version_no=?, note=?, submitted_by=?, updated_at=? WHERE case_id=? AND stage_no=?",
                        (new_ver, note, actor["id"], ts, case_id, stage_no),
                    )
                    log_audit(conn, actor["id"], "提交复核材料", f"{case_id}#S{stage_no}", f"第{new_ver}版: {note}")
                    conn.execute("COMMIT")
                    return 200, {"ok": True, "case_id": case_id, "stage_no": stage_no, "version_no": new_ver}

                if gov_act == "review":
                    stage_no = int(body.get("stage_no") or 0)
                    verdict = str(body.get("verdict") or "")
                    comment = str(body.get("comment") or "").strip()
                    if verdict not in ("通过", "退回"):
                        raise ApiError(400, "结论只能选「通过」或「退回」")
                    gs = conn.execute("SELECT * FROM case_governance_stages WHERE case_id=? AND stage_no=?", (case_id, stage_no)).fetchone()
                    if not gs:
                        raise ApiError(404, f"阶段 {stage_no} 不存在")
                    if gs["state"] != "submitted":
                        raise ApiError(409, "还没提交材料，不能直接复核")
                    if gs["submitted_by"] == actor["id"] and actor["role"] != "supervisor":
                        raise ApiError(403, "自己交的材料不能自己批通过，请切到【王主管】复核！", "SELF_APPROVAL_BLOCKED")
                    if verdict == "退回" and len(comment) < 4:
                        raise ApiError(400, "退回时请写清哪里要补（至少 4 个字）")
                    if not comment:
                        comment = "核对无误，通过"
                    rev_id = f"REV-{int(time.time()*1000)%1000000}"
                    conn.execute(
                        "INSERT INTO case_governance_reviews VALUES (?,?,?,?,?,?,?,?,?)",
                        (rev_id, case_id, stage_no, gs["version_no"], actor["id"], actor["name"], verdict, comment, ts),
                    )
                    next_state = "done" if verdict == "通过" else "doing"
                    conn.execute(
                        "UPDATE case_governance_stages SET state=?, latest_verdict=?, updated_at=? WHERE case_id=? AND stage_no=?",
                        (next_state, verdict, ts, case_id, stage_no),
                    )
                    if verdict == "通过" and stage_no < 5:
                        conn.execute(
                            "UPDATE case_governance_stages SET state='doing', updated_at=? WHERE case_id=? AND stage_no=? AND state='todo'",
                            (ts, case_id, stage_no + 1),
                        )
                    log_audit(conn, actor["id"], f"主管复核({verdict})", f"{case_id}#S{stage_no}", comment)
                    conn.execute("COMMIT")
                    return 200, {"ok": True, "review_id": rev_id, "verdict": verdict}

                if gov_act == "weekly-decision":
                    dec = str(body.get("decision") or "继续")
                    note = str(body.get("note") or "").strip()
                    if dec not in ("继续", "扩大", "调整", "暂停", "退出"):
                        raise ApiError(400, "无效的复盘决定")
                    validate_no_zero_placeholder({"复盘备注": note})
                    conn.execute(
                        "UPDATE procurement_cases SET review_decision=?, review_note=?, updated_at=? WHERE case_id=?",
                        (dec, note, ts, case_id),
                    )
                    conn.execute("COMMIT")
                    return 200, {"ok": True, "decision": dec}

                raise ApiError(404, f"未知动作: {gov_act}")

            if path.startswith("/api/cases/") and "/step/" in path:
                parts = path.split("/")
                case_id = parts[3]
                step_act = parts[5]
                crow = conn.execute("SELECT * FROM procurement_cases WHERE case_id=?", (case_id,)).fetchone()
                if not crow:
                    raise ApiError(404, f"找不到这笔订单: {case_id}")
                cdict = dict(crow)
                capture = json.loads(cdict["capture_json"])

                if step_act == "init":
                    model_code = str(body.get("model_code") or cdict["model_code"]).strip()
                    cond = str(body.get("condition_grade") or cdict["condition_grade"]).strip()
                    decl = str(body.get("seller_declaration") or "").strip()
                    seller_price = int(body.get("seller_price_cents") or 0)
                    validate_no_zero_placeholder({"机型": model_code, "卖家说的成色": cond, "卖家成色与配件原话": decl})
                    if len(decl) < 6:
                        raise ApiError(400, "卖家原话至少记 6 个字（比如：『国行原盒无拆修，电池96%』）")
                    if seller_price <= 0:
                        raise ApiError(400, "卖家挂价必须大于 0 元")

                    conv_id = cdict["conv_id"]
                    if not conv_id:
                        conv_id = f"CONV-{case_id.split('-')[1]}"
                        ref_c = 760000 if "MBP14" in model_code else int(seller_price * 1.04 // 100 * 100)
                        first_c = int(ref_c * 0.88 // 100 * 100)
                        target_c = int(ref_c * 0.92 // 100 * 100)
                        ceil_c = int(ref_c * 0.95 // 100 * 100)
                        snap = {
                            "snapshot_id": f"SNAP-{conv_id}-V1",
                            "snapshot_version": 1,
                            "captured_at": ts,
                            "seller_title": cdict["title"],
                            "seller_declaration": decl,
                            "pricebook_ref_version": "v2",
                            "source_type": "买前卖家原话留底",
                        }
                        conn.execute(
                            "INSERT OR REPLACE INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (
                                conv_id, cdict["account_id"], f"GF-TH-{case_id}", "bargaining",
                                cdict["seller_name"], model_code, cdict["title"], seller_price,
                                ref_c, first_c, target_c, ceil_c, None,
                                "auto", 0, 1, None, json_dumps(snap),
                                "waiting", 75, "已记下卖家成色原话，准备发第一轮报价",
                                0, 0, 0, json_dumps([]), ts,
                                f"SELLER-{case_id}", 0, 45, "matched",
                            ),
                        )
                        if cdict["lead_id"]:
                            conn.execute("UPDATE discovery_leads SET status='promoted', conversation_id=? WHERE lead_id=?", (conv_id, cdict["lead_id"]))
                    capture["declaration"] = {"name": "卖家成色与瑕疵原话", "state": "ok", "detail": decl}
                    conn.execute(
                        "UPDATE procurement_cases SET model_code=?, condition_grade=?, conv_id=?, capture_json=?, updated_at=? WHERE case_id=?",
                        (model_code, cond, conv_id, json_dumps(capture), ts, case_id),
                    )
                    log_audit(conn, actor["id"], "看货留底开聊", case_id, f"已记下卖家原话：{decl[:40]}")
                    conn.execute("COMMIT")
                    return 200, {"ok": True, "conv_id": conv_id}

                if step_act == "supplement":
                    ch = str(body.get("channel") or "")
                    if ch not in capture:
                        raise ApiError(400, f"找不到这个留底项: {ch}")
                    unavailable = bool(body.get("unavailable"))
                    if unavailable:
                        capture[ch]["state"] = "unknown"
                        capture[ch]["detail"] = f"卖家暂时拍不出，已诚实标「暂时拿不到」（{ts[11:16]} {actor['name']} 标记；拿到后随时可补）"
                        log_audit(conn, actor["id"], "诚实标记暂时拿不到", f"{case_id}:{ch}", capture[ch]["detail"])
                    else:
                        content = str(body.get("content") or "").strip()
                        validate_no_zero_placeholder({capture[ch]["name"]: content})
                        if len(content) < 6:
                            raise ApiError(400, f"「{capture[ch]['name']}」至少写 6 个字说明情况")
                        capture[ch]["state"] = "ok"
                        capture[ch]["detail"] = content
                        log_audit(conn, actor["id"], "补齐买前底牌", f"{case_id}:{ch}", content[:60])
                    conn.execute("UPDATE procurement_cases SET capture_json=?, updated_at=? WHERE case_id=?", (json_dumps(capture), ts, case_id))
                    conn.execute("COMMIT")
                    return 200, {"ok": True, "capture": capture}

                if step_act == "assess-bargain":
                    wrote_ln = bool(body.get("seller_wrote_like_new"))
                    blurry_ph = bool(body.get("photos_blurry_incomplete"))
                    full_disc = bool(body.get("defects_fully_disclosed"))
                    suspect_tag = bool(body.get("suspect_condition_tag", wrote_ln or blurry_ph or not full_disc))
                    focus_pts = [str(x).strip() for x in (body.get("warehouse_focus_points") or []) if str(x).strip()]
                    note_wh = str(body.get("buyer_note_to_warehouse") or "").strip()
                    if suspect_tag and not focus_pts:
                        raise ApiError(400, "打『质疑成色·重点深检』标记时，请至少勾选 1 项让赵仓管重点检查的部位（反对撒胡椒面）！", "WAREHOUSE_FOCUS_REQUIRED")
                    if not note_wh:
                        if suspect_tag:
                            note_wh = f"【质疑成色·重点深检】买前未追问，请赵仓管一镜到底重点查：{'、'.join(focus_pts)}"
                        else:
                            note_wh = "卖家已高清完整披露瑕疵，常规按单核对型号功能入库"
                    new_eval = make_prebuy_eval(True, wrote_ln, blurry_ph, full_disc, suspect_tag, focus_pts, note_wh)
                    new_cond = cdict["condition_grade"]
                    if suspect_tag and "重点验" not in new_cond and "质疑" not in new_cond:
                        new_cond = f"{new_cond} · 已标仓管重点验"
                    conn.execute(
                        "UPDATE procurement_cases SET prebuy_eval_json=?, condition_grade=?, warehouse_check_note=?, updated_at=? WHERE case_id=?",
                        (new_eval, new_cond, note_wh, ts, case_id),
                    )
                    log_audit(conn, actor["id"], "完成二次议价潜力研判与仓管重点验机打标", case_id, note_wh[:80])
                    conn.execute("COMMIT")
                    return 200, {"ok": True, "prebuy_eval": json.loads(new_eval)}

                if step_act == "warehouse-inspect":
                    if actor["role"] not in ("warehouse", "supervisor"):
                        raise ApiError(403, "买货和验货要分开：到货开箱须由【赵仓管】或【王主管】点确认！", "ROLE_FORBIDDEN")
                    po_id = cdict["po_id"]
                    po = conn.execute("SELECT * FROM orders WHERE po_id=?", (po_id,)).fetchone() if po_id else None
                    if not po or po["stage"] not in ("manual_paid", "shipped", "completed"):
                        raise ApiError(409, "还没登记付款单号呢，付完钱收到货后仓管才能点开箱验机！")
                    result = str(body.get("result") or "pass")
                    note = str(body.get("note") or "").strip()
                    validate_no_zero_placeholder({"验机情况说明": note})
                    if len(note) < 6:
                        raise ApiError(400, "验机说明至少写 6 个字（比如『序列号一致，屏幕外观跟卖家说的一样』）")
                    if result == "pass":
                        conn.execute("UPDATE orders SET stage='completed', updated_at=? WHERE po_id=?", (ts, po_id))
                        capture["price_shot"] = {"name": "闲鱼改价 / 仓库开箱图", "state": "ok", "detail": f"仓库验机全对：{note}"}
                        conn.execute(
                            "UPDATE procurement_cases SET warehouse_check_state='passed', warehouse_check_note=?, capture_json=?, updated_at=? WHERE case_id=?",
                            (note, json_dumps(capture), ts, case_id),
                        )
                        conn.execute("UPDATE commissions SET status='paid', confirmed_cents=estimated_cents WHERE po_id=? AND status!='reversed'", (po_id,))
                        log_audit(conn, actor["id"], "仓库验机合格入良品库", case_id, note)
                        conn.execute("COMMIT")
                        return 200, {"ok": True, "result": "pass"}
                    else:
                        tid = f"TK-{int(time.time()*1000)%100000}"
                        dl = plus_hours_iso(48)
                        paid_c = po["paid_cents"] or po["agreed_cents"]
                        snap = json.loads(po["snapshot_json"])
                        pe = json.loads(cdict.get("prebuy_eval_json") or "{}")
                        bf_new = make_bargain_flow(
                            bool(pe.get("suspect_condition_tag")),
                            "、".join(pe.get("warehouse_focus_points") or []),
                            True, "bargain_keep", "platform_return", "", "", False, False, False, False, "", False, 30, "", False, True,
                        )
                        conn.execute(
                            "INSERT INTO aftersales_tickets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (
                                tid, po_id, po["model_code"], str(body.get("sku_sn") or f"SN-{po_id[-4:]}"),
                                cdict["owner_id"], None, "accepted", note, "undisclosed", "issue",
                                int(paid_c * 1.25 // 100 * 100), paid_c, paid_c, int(paid_c * 1.05 // 100 * 100), 0, None, None, None,
                                None, dl, "none", "defect_hold", plus_hours_iso(1), "今日 22:00", dl,
                                snap.get("seller_declaration", "见买前卖家原话"), f"仓库质检实拍：{note}", 0, "./evidence/IMG_5881.PNG", ts, bf_new,
                            ),
                        )
                        conn.execute(
                            "UPDATE procurement_cases SET ticket_id=?, warehouse_check_state='defect', warehouse_check_note=?, updated_at=? WHERE case_id=?",
                            (tid, note, ts, case_id),
                        )
                        log_audit(conn, actor["id"], "仓管按预埋标记抓出未披露瑕疵 · 转入9步二次议价", tid, note)
                        conn.execute("COMMIT")
                        return 200, {"ok": True, "result": "defect", "ticket_id": tid}

                raise ApiError(404, f"未知步骤动作: {step_act}")

            if path == "/api/quota/reserve":
                amount_cents = int(body.get("amount_cents") or 0)
                order_ref = str(body.get("order_ref") or f"DRAFT-{int(time.time())}")
                conv_id = body.get("conversation_id")
                idem = body.get("idempotency_key")
                if amount_cents <= 0:
                    raise ApiError(400, "预留预算金额必须大于 0")
                if idem:
                    existing = conn.execute("SELECT * FROM quota_reservations WHERE idempotency_key=?", (idem,)).fetchone()
                    if existing:
                        conn.rollback()
                        return 200, {"ok": True, "idempotent_replay": True, "reservation": dict(existing)}

                if actor["role"] == "purchaser" and amount_cents > actor["max_single_cents"]:
                    raise ApiError(403, f"单台超过采购员权限上限（¥{actor['max_single_cents']/100:.0f}），请找王主管审批", "QUOTA_ROLE_LIMIT")

                pool = conn.execute("SELECT * FROM quota_pool WHERE pool_id='POOL-202611'").fetchone()
                avail = pool["total_cents"] - pool["reserved_cents"] - pool["spent_cents"]
                if amount_cents > avail:
                    raise ApiError(409, f"组里买货预算不够了：只剩 ¥{avail/100:.2f}，这单要 ¥{amount_cents/100:.2f}", "QUOTA_EXCEEDED")

                res_id = f"RES-{int(time.time()*1000) % 1000000}-{hashlib.md5(order_ref.encode()).hexdigest()[:4]}"
                conn.execute(
                    "UPDATE quota_pool SET reserved_cents = reserved_cents + ?, updated_at=? WHERE pool_id='POOL-202611'",
                    (amount_cents, ts),
                )
                conn.execute(
                    "INSERT INTO quota_reservations VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (res_id, order_ref, conv_id, actor["id"], amount_cents, "reserved", idem, body.get("note") or "谈价预留买货预算", ts, ts),
                )
                if body.get("case_id"):
                    conn.execute("UPDATE procurement_cases SET quota_res_id=?, updated_at=? WHERE case_id=?", (res_id, ts, str(body["case_id"])))
                log_audit(conn, actor["id"], "预留买货预算", res_id, f"预留 ¥{amount_cents/100:.2f}")
                conn.execute("COMMIT")
                res = dict(conn.execute("SELECT * FROM quota_reservations WHERE res_id=?", (res_id,)).fetchone())
                return 200, {"ok": True, "reservation": res}

            if path == "/api/quota/release":
                res_id = str(body.get("res_id") or "")
                res = conn.execute("SELECT * FROM quota_reservations WHERE res_id=?", (res_id,)).fetchone()
                if not res:
                    raise ApiError(404, f"找不到这笔预留记录: {res_id}")
                if res["status"] != "reserved":
                    raise ApiError(409, "这笔预算已经退回或已转成实付货款，不能重复退回")
                conn.execute("UPDATE quota_reservations SET status='released', updated_at=? WHERE res_id=?", (ts, res_id))
                conn.execute("UPDATE quota_pool SET reserved_cents = MAX(0, reserved_cents - ?), updated_at=? WHERE pool_id='POOL-202611'", (res["amount_cents"], ts))
                log_audit(conn, actor["id"], "退回预留预算", res_id, f"退回 ¥{res['amount_cents']/100:.2f} 到组里预算池")
                conn.execute("COMMIT")
                return 200, {"ok": True, "res_id": res_id}

            if path == "/api/discovery/leads":
                platform = str(body.get("platform") or "goofish").strip()
                product_id = str(body.get("product_id") or "").strip()
                account_id = str(body.get("account_id") or "ACC-GF-01").strip()
                if not product_id:
                    raise ApiError(400, "商品链接编号不能为空")
                dup = conn.execute(
                    "SELECT * FROM discovery_leads WHERE platform=? AND product_id=? AND account_id=?",
                    (platform, product_id, account_id),
                ).fetchone()
                if dup:
                    conn.rollback()
                    return 200, {"ok": True, "deduplicated": True, "message": "这台机器已经有同事加进清单了，系统已自动防撞单合并", "lead": dict(dup)}

                lead_id = f"LEAD-{int(time.time()*1000)%100000}"
                title_s = str(body.get("title") or f"闲鱼待收商品 {product_id}")
                model_s = str(body.get("model_code") or "IP15P-256-NAT")
                cond_s = str(body.get("condition_grade") or "95新·待核成色")
                seller_s = str(body.get("seller_name") or "闲鱼个人卖家")
                sp_c = int(body.get("seller_price_cents") or 480000)
                rp_c = int(body.get("ref_price_cents") or 505000)
                conn.execute(
                    "INSERT INTO discovery_leads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (lead_id, platform, product_id, account_id, title_s, model_s, cond_s, seller_s, sp_c, rp_c, "new", None, f"https://goofish.local/item/{product_id}", ts),
                )
                case_id = f"CASE-{int(time.time()*1000)%10000:04d}"
                conn.execute(
                    "INSERT INTO procurement_cases VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        case_id, "今日新加", title_s, "数码好货", "新增寻源", model_s, cond_s, "闲鱼", "人工添加",
                        account_id, seller_s, actor["id"], "", "待补实拍图", lead_id, None, None, None, None, None,
                        make_capture("partial", f"商品页写：{cond_s}（待锁死原话快照）", "missing", "待存原图", "missing", "待确认型号", "missing", "未开聊"),
                        "pending", "尚未到货", "继续", "新加入今日采购清单", ts,
                        make_prebuy_eval(False, "几乎全新" in cond_s or "99" in cond_s, True, False, True, ["强光查屏幕与机身划痕磕碰", "核原装配件齐全"], ""),
                    ),
                )
                for sno, sname in [(1, "寻源摸底"), (2, "价格核验"), (3, "实操取证"), (4, "结算核销"), (5, "复盘沉淀")]:
                    conn.execute("INSERT INTO case_governance_stages VALUES (?,?,?,?,?,?,?,?,?)", (case_id, sno, sname, "doing" if sno == 1 else "todo", 1 if sno == 1 else 0, "", None, "", ts))
                log_audit(conn, actor["id"], "添加今日待买机器", lead_id, f"{title_s} -> {case_id}")
                conn.execute("COMMIT")
                lead = dict(conn.execute("SELECT * FROM discovery_leads WHERE lead_id=?", (lead_id,)).fetchone())
                return 200, {"ok": True, "deduplicated": False, "lead": lead, "case_id": case_id}

            if path == "/api/discovery/promote":
                lead_id = str(body.get("lead_id") or "")
                lead = conn.execute("SELECT * FROM discovery_leads WHERE lead_id=?", (lead_id,)).fetchone()
                if not lead:
                    raise ApiError(404, "找不到这条商品线索")
                if lead["conversation_id"]:
                    conn.rollback()
                    return 200, {"ok": True, "conversation_id": lead["conversation_id"], "already_promoted": True}

                conv_id = f"CONV-{int(time.time()*1000)%100000}"
                first_c = int(lead["ref_price_cents"] * 0.88 // 100 * 100)
                target_c = int(lead["ref_price_cents"] * 0.91 // 100 * 100)
                ceil_c = int(lead["ref_price_cents"] * 0.94 // 100 * 100)
                snap = {
                    "snapshot_id": f"SNAP-{conv_id}-V1",
                    "snapshot_version": 1,
                    "captured_at": ts,
                    "seller_title": lead["title"],
                    "seller_declaration": f"商品页描述 {lead['condition_grade']}（待卖家聊天确认）",
                    "pricebook_ref_version": "v2",
                    "source_type": "买前商品快照",
                }
                conn.execute(
                    "INSERT INTO conversations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        conv_id, lead["account_id"], f"GF-TH-{lead['product_id']}", "bargaining",
                        lead["seller_name"], lead["model_code"], lead["title"], lead["seller_price_cents"],
                        lead["ref_price_cents"], first_c, target_c, ceil_c, None,
                        "auto", 0, 1, None, json_dumps(snap),
                        "waiting", 65, "刚开启聊天，等卖家回成色细节",
                        0, 0, 1, json_dumps([]), ts,
                        f"SELLER-{lead['product_id']}", 0, 35, "matched",
                    ),
                )
                conn.execute("UPDATE discovery_leads SET status='promoted', conversation_id=? WHERE lead_id=?", (conv_id, lead_id))
                conn.execute("UPDATE procurement_cases SET conv_id=?, updated_at=? WHERE lead_id=?", (conv_id, ts, lead_id))
                conn.execute(
                    "INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (f"MSG-{conv_id}-0", conv_id, "system", "系统留底", f"已保存卖家商品页原话快照，可以发第一句问候试探啦", None, 1, "sent", f"promote-{lead_id}", ts),
                )
                log_audit(conn, actor["id"], "开始跟卖家聊价", conv_id, lead["title"])
                conn.execute("COMMIT")
                return 200, {"ok": True, "conversation_id": conv_id}

            if path == "/api/leads/ingest":
                platform = str(body.get("platform") or "goofish").strip()
                product_id = str(body.get("product_id") or "").strip()
                account_id = str(body.get("account_id") or "ACC-GF-01").strip()
                if not product_id:
                    raise ApiError(400, "监听投递商品链接编号 product_id 不能为空")
                dup = conn.execute(
                    "SELECT * FROM discovery_leads WHERE platform=? AND product_id=? AND account_id=?",
                    (platform, product_id, account_id),
                ).fetchone()
                if dup:
                    conn.rollback()
                    return 200, {"ok": True, "deduplicated": True, "message": "幂等拦截：同平台+商品ID+账号已存在，不重复派发首报任务", "lead": dict(dup)}

                title_s = str(body.get("title") or f"监听新上架商品 {product_id}").strip()
                model_s = str(body.get("model_code") or "IP15P-256-NAT").strip()
                cond_s = str(body.get("condition_grade") or "几乎全新·待深检").strip()
                seller_s = str(body.get("seller_name") or "闲鱼新上架卖家").strip()
                seller_id = str(body.get("seller_id") or f"SELLER-{product_id}").strip()
                sp_c = int(body.get("seller_price_cents") or 480000)
                pb_row = conn.execute("SELECT * FROM pricebook_items WHERE model_code=? AND status='published' ORDER BY version_no DESC LIMIT 1", (model_s,)).fetchone()
                rp_c = int(body.get("ref_price_cents") or (pb_row["ref_price_cents"] if pb_row else int(sp_c * 1.05 // 100 * 100)))
                first_c = int(pb_row["first_offer_cents"]) if pb_row else int(rp_c * 0.88 // 100 * 100)
                lead_id = f"LEAD-{int(time.time()*1000)%100000}"
                src_url = str(body.get("source_url") or f"https://www.goofish.com/item?id={product_id}")
                conn.execute(
                    "INSERT INTO discovery_leads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (lead_id, platform, product_id, account_id, title_s, model_s, cond_s, seller_s, sp_c, rp_c, "new", None, src_url, ts),
                )
                imgs = [str(u) for u in (body.get("images") or ["./evidence/IMG_5878.PNG"]) if str(u).strip()][:10]
                conn.execute(
                    "INSERT OR REPLACE INTO item_snapshots VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (product_id, 1, src_url, title_s, str(body.get("description_raw") or cond_s), cond_s, model_s, f"¥{sp_c/100:.0f}", json_dumps(imgs), ts),
                )
                job_id = f"JOB-{int(time.time()*1000)%100000}"
                has_conflict = bool(body.get("spec_conflict", False))
                job_status = "blocked_conflict" if has_conflict else "queued"
                conn.execute(
                    "INSERT INTO executor_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        job_id, "WIN-BG-01", account_id, None, product_id, "first_offer", job_status, 1,
                        json_dumps({
                            "quote_cents": first_c,
                            "seller_id": seller_id,
                            "summary": "规格冲突已拦截转人工待核" if has_conflict else f"派发后台窗#1静默抓图并首报 ¥{first_c/100:.0f}",
                        }),
                        None, "SPEC_CONFLICT_BLOCKED" if has_conflict else None, f"ingest-{platform}-{product_id}-{account_id}", ts, ts,
                    ),
                )
                log_audit(conn, actor["id"], "独立监听端投递新商品链接", lead_id, f"{product_id} -> {job_id} ({job_status})")
                conn.execute("COMMIT")
                return 200, {
                    "ok": True,
                    "deduplicated": False,
                    "lead_id": lead_id,
                    "job_id": job_id,
                    "job_status": job_status,
                    "first_offer_cents": first_c,
                }

            if path == "/api/executor/jobs/ack":
                job_id = str(body.get("job_id") or "").strip()
                jb = conn.execute("SELECT * FROM executor_jobs WHERE job_id=?", (job_id,)).fetchone()
                if not jb:
                    raise ApiError(404, f"找不到执行队列任务: {job_id}")
                new_status = str(body.get("status") or "completed").strip()
                pm_id = str(body.get("platform_message_id") or f"PM-{int(time.time()*1000)%100000}")
                err_msg = body.get("error_msg")
                conn.execute(
                    "UPDATE executor_jobs SET status=?, platform_message_id=?, error_msg=?, updated_at=? WHERE job_id=?",
                    (new_status, pm_id if new_status in ("completed", "triggered_10m_sla") else jb["platform_message_id"], err_msg, ts, job_id),
                )
                log_audit(conn, actor["id"], f"执行器任务回执({new_status})", job_id, f"窗口 {jb['window_id']} · 回执 {pm_id}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "job_id": job_id, "status": new_status, "platform_message_id": pm_id}

            if path == "/api/sellers/favorite":
                seller_id = str(body.get("seller_id") or "").strip()
                if not seller_id:
                    raise ApiError(400, "卖家稳定标识 seller_id 不能为空")
                if body.get("remove"):
                    conn.execute("DELETE FROM favorite_sellers WHERE seller_id=?", (seller_id,))
                    log_audit(conn, actor["id"], "取消收藏卖家", seller_id, "已从收藏列表移除（不影响任何聊天状态）")
                    conn.execute("COMMIT")
                    return 200, {"ok": True, "seller_id": seller_id, "favorited": False}
                existing_fs = conn.execute("SELECT * FROM favorite_sellers WHERE seller_id=?", (seller_id,)).fetchone()
                seller_name = str(body.get("seller_name") or (existing_fs["seller_name"] if existing_fs else seller_id)).strip()
                scope = str(body.get("scope") or (existing_fs["scope"] if existing_fs else "personal")).strip()
                if scope not in ("personal", "team"):
                    scope = "personal"
                raw_tags = body.get("tags")
                if raw_tags is None:
                    tags_list = json.loads(existing_fs["tags_json"]) if existing_fs else ["沟通顺畅"]
                else:
                    tags_list = [str(x).strip() for x in raw_tags if str(x).strip()]
                note = str(body.get("note") if body.get("note") is not None else (existing_fs["note"] if existing_fs else "")).strip()
                purl = str(body.get("platform_url") or (existing_fs["platform_url"] if existing_fs else f"https://www.goofish.com/personal?userId={seller_id}"))
                conn.execute(
                    """INSERT INTO favorite_sellers VALUES (?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(seller_id) DO UPDATE SET
                         seller_name=excluded.seller_name,
                         scope=excluded.scope,
                         tags_json=excluded.tags_json,
                         note=excluded.note,
                         platform_url=excluded.platform_url,
                         updated_at=excluded.updated_at""",
                    (seller_id, seller_name, actor["id"], scope, json_dumps(tags_list), note, purl, existing_fs["created_at"] if existing_fs else ts, ts),
                )
                log_audit(conn, actor["id"], "收藏/更新卖家标签", seller_id, f"{seller_name} · {'团队共享' if scope == 'team' else '个人私藏'} · {','.join(tags_list)}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "seller_id": seller_id, "favorited": True, "scope": scope, "tags": tags_list}

            if path == "/api/earnings/target":
                target_cents = int(body.get("target_cents") or 100000)
                if target_cents < 10000 or target_cents > 2000000:
                    raise ApiError(400, "单日预计提成目标请在 ¥100 ~ ¥20,000 之间设置")
                val_obj = {"value": target_cents, "min": 20000, "max": 500000, "unit": "分"}
                conn.execute(
                    "UPDATE policy_configs SET value_json=?, updated_by=?, updated_at=? WHERE key='daily_comm_target'",
                    (json_dumps(val_obj), actor["id"], ts),
                )
                log_audit(conn, actor["id"], "调整个人单日提成目标", "daily_comm_target", f"目标更新为 ¥{target_cents/100:.0f}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "daily_target_cents": target_cents}

            if path.startswith("/api/conversations/") and path.endswith("/group"):
                conv_id = path.split("/")[3]
                conv = conn.execute("SELECT * FROM conversations WHERE conv_id=?", (conv_id,)).fetchone()
                if not conv:
                    raise ApiError(404, "找不到这段会话")
                slow = 1 if body.get("slow_group", True) else 0
                new_cat = "slow_bargain" if slow else ("urgent_10m" if conv["needs_manual"] else "bargaining")
                conn.execute(
                    "UPDATE conversations SET slow_group=?, category_group=?, updated_at=? WHERE conv_id=?",
                    (slow, new_cat, ts, conv_id),
                )
                log_audit(conn, actor["id"], "移入慢慢压价长线池" if slow else "移回常规会话跟进", conv_id, conv["title"][:40])
                conn.execute("COMMIT")
                return 200, {"ok": True, "conv_id": conv_id, "slow_group": slow, "category_group": new_cat}

            if path.startswith("/api/conversations/") and path.endswith("/correct-match"):
                conv_id = path.split("/")[3]
                conv = conn.execute("SELECT * FROM conversations WHERE conv_id=?", (conv_id,)).fetchone()
                if not conv:
                    raise ApiError(404, "找不到这段会话")
                model_code = str(body.get("model_code") or conv["model_code"]).strip()
                pb_row = conn.execute("SELECT * FROM pricebook_items WHERE model_code=? AND status IN ('published','draft_pending_review') ORDER BY version_no DESC LIMIT 1", (model_code,)).fetchone()
                ref_c = int(body.get("ref_price_cents") or (pb_row["ref_price_cents"] if pb_row else conv["ref_price_cents"]))
                first_c = int(body.get("first_offer_cents") or (pb_row["first_offer_cents"] if pb_row else conv["first_offer_cents"]))
                target_c = int(body.get("target_price_cents") or (pb_row["target_cents"] if pb_row else conv["target_price_cents"]))
                ceil_c = int(body.get("ceiling_price_cents") or (pb_row["ceiling_cents"] if pb_row else conv["ceiling_price_cents"]))
                resume_auto = bool(body.get("resume_auto", False))
                new_pause = "auto" if resume_auto else conv["pause_state"]
                conn.execute(
                    """UPDATE conversations
                       SET model_code=?, ref_price_cents=?, first_offer_cents=?, target_price_cents=?, ceiling_price_cents=?,
                           matched_status='matched', pause_state=?, context_version=context_version+1,
                           context_changed_note=?, updated_at=?
                       WHERE conv_id=?""",
                    (model_code, ref_c, first_c, target_c, ceil_c, new_pause, f"已人工修正匹配为 {model_code}（参考价 ¥{ref_c/100:.0f}）", ts, conv_id),
                )
                log_audit(conn, actor["id"], "人工修正会话型号与参考价匹配", conv_id, f"{model_code} · 参考 ¥{ref_c/100:.0f} / 上限 ¥{ceil_c/100:.0f}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "conv_id": conv_id, "model_code": model_code, "matched_status": "matched"}

            if path.startswith("/api/conversations/") and path.endswith("/quotes"):
                conv_id = path.split("/")[3]
                conv = conn.execute("SELECT * FROM conversations WHERE conv_id=?", (conv_id,)).fetchone()
                if not conv:
                    raise ApiError(404, "找不到这段聊天")
                first_c = int(body.get("first_offer_cents", conv["first_offer_cents"]))
                target_c = int(body.get("target_price_cents", conv["target_price_cents"]))
                ceil_c = int(body.get("ceiling_price_cents", conv["ceiling_price_cents"]))
                if not (0 < first_c <= target_c <= ceil_c):
                    raise ApiError(400, "价格顺序不对哦：必须满足「首轮试探价 ≤ 目标成交价 ≤ 最高出价线」", "QUOTE_HIERARCHY_INVALID")
                new_ver = conv["context_version"] + (1 if body.get("simulate_context_change") else 0)
                note = "卖家刚刚改了价格或补了瑕疵说明，之前没发出去的草稿已自动作废，请看一眼新情况再发" if body.get("simulate_context_change") else conv["context_changed_note"]
                new_seller_price = int(body.get("seller_price_cents") or conv["seller_price_cents"])
                conn.execute(
                    "UPDATE conversations SET first_offer_cents=?, target_price_cents=?, ceiling_price_cents=?, seller_price_cents=?, context_version=?, context_changed_note=?, updated_at=? WHERE conv_id=?",
                    (first_c, target_c, ceil_c, new_seller_price, new_ver, note, ts, conv_id),
                )
                log_audit(conn, actor["id"], "确认三档谈价线", conv_id, f"首报¥{first_c/100:.0f} / 目标¥{target_c/100:.0f} / 上限¥{ceil_c/100:.0f}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "context_version": new_ver}

            if path.startswith("/api/conversations/") and path.endswith("/pause"):
                conv_id = path.split("/")[3]
                conv = conn.execute("SELECT * FROM conversations WHERE conv_id=?", (conv_id,)).fetchone()
                if not conv:
                    raise ApiError(404, "找不到这段聊天")
                if body.get("simulate_inflight"):
                    seq = conv["in_flight_seq"] + 1
                    conn.execute(
                        "UPDATE conversations SET pause_state='pausing', in_flight_seq=?, needs_manual=1, updated_at=? WHERE conv_id=?",
                        (seq, ts, conv_id),
                    )
                    inflight_id = f"MSG-INFLIGHT-{conv_id}-{seq}"
                    conn.execute(
                        "INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (inflight_id, conv_id, "buyer_ai", "自动助手（正在路上…）",
                         f"老板看您成色不错，请问 4550 元能包顺丰吗？", 455000, conv["context_version"], "sending", None, ts),
                    )
                    log_audit(conn, actor["id"], "检测到自动助手正在发消息", conv_id, "已锁住重复发送，等员工点撤回或确认发完")
                    conn.execute("COMMIT")
                    return 200, {"ok": True, "pause_state": "pausing", "in_flight_msg_id": inflight_id}
                else:
                    conn.execute("UPDATE conversations SET pause_state='paused', needs_manual=1, updated_at=? WHERE conv_id=?", (ts, conv_id))
                    log_audit(conn, actor["id"], "人工接手聊天", conv_id, "自动助手已停嘴")
                    conn.execute("COMMIT")
                    return 200, {"ok": True, "pause_state": "paused"}

            if path.startswith("/api/conversations/") and path.endswith("/pause-resolve"):
                conv_id = path.split("/")[3]
                conv = conn.execute("SELECT * FROM conversations WHERE conv_id=?", (conv_id,)).fetchone()
                if not conv:
                    raise ApiError(404, "找不到这段聊天")
                resolution = str(body.get("resolution") or "abort_inflight")
                target_msg_status = "cancelled" if resolution == "abort_inflight" else "sent"
                conn.execute("UPDATE messages SET status=? WHERE conv_id=? AND status='sending'", (target_msg_status, conv_id))
                conn.execute("UPDATE conversations SET pause_state='paused', updated_at=? WHERE conv_id=?", (ts, conv_id))
                log_audit(conn, actor["id"], "处理完在路上的自动消息", conv_id, f"已设为 {target_msg_status}，现在人工可放心打字")
                conn.execute("COMMIT")
                return 200, {"ok": True, "pause_state": "paused", "resolved_status": target_msg_status}

            if path.startswith("/api/conversations/") and path.endswith("/resume"):
                conv_id = path.split("/")[3]
                row_c = conn.execute("SELECT * FROM conversations WHERE conv_id=?", (conv_id,)).fetchone()
                if not row_c:
                    raise ApiError(404, "找不到这段聊天")
                conn.execute("UPDATE conversations SET pause_state='auto', updated_at=? WHERE conv_id=?", (ts, conv_id))
                log_audit(conn, actor["id"], "恢复自动助手跟进", conv_id, "已交回自动助手")
                conn.execute("COMMIT")
                return 200, {"ok": True, "pause_state": "auto"}

            if path.startswith("/api/conversations/") and path.endswith("/send"):
                conv_id = path.split("/")[3]
                conv = conn.execute("SELECT * FROM conversations WHERE conv_id=?", (conv_id,)).fetchone()
                if not conv:
                    raise ApiError(404, "找不到这段聊天")
                text = str(body.get("text") or "").strip()
                quote_cents = body.get("quote_cents")
                quote_cents = int(quote_cents) if quote_cents is not None and str(quote_cents) != "" else None
                expected_ver = body.get("expected_context_version")
                sender = str(body.get("sender") or "buyer_human")
                idem = body.get("idempotency_key")

                if not text:
                    raise ApiError(400, "还没写要发的话呢")
                if idem:
                    old = conn.execute("SELECT * FROM messages WHERE idempotency_key=?", (idem,)).fetchone()
                    if old:
                        conn.rollback()
                        return 200, {"ok": True, "idempotent_replay": True, "message": dict(old)}

                if conv["pause_state"] == "pausing":
                    raise ApiError(409, "自动助手刚发了一句话还在路上，请先点「撤回」或「确认已发出」，再发你的话！", "PAUSE_IN_FLIGHT_LOCK")
                if sender == "buyer_ai" and conv["pause_state"] != "auto":
                    raise ApiError(409, "你已经接手这段聊天了，自动助手不会再乱插嘴", "AI_PAUSED_GUARD")
                if expected_ver is not None and int(expected_ver) != conv["context_version"]:
                    raise ApiError(409, "卖家刚刚改了价格或新说了情况，你手里的旧草稿已作废，刷新看一眼再发哦", "CONTEXT_STALE")

                if sender != "seller":
                    for kw in CONFIDENTIAL_KEYWORDS:
                        if kw in text:
                            raise ApiError(422, f"差点漏底啦！你写的话里有内部词「{kw}」，发给卖家他就死咬高价不降了，删掉这个词再发。", "OUTBOUND_LEAK_BLOCKED")
                    for bkw in ANTI_BICKERING_KEYWORDS:
                        if bkw in text:
                            raise ApiError(
                                422,
                                f"🚫 5% 纠纷率防红标拦截：检测到扯皮/引战词「{bkw}」！非必要严禁跟卖家扯皮或威胁小二介入（纠纷率超 5% 账号必弹红标）！",
                                "ANTI_BICKERING_BLOCKED",
                            )
                    if quote_cents is not None and quote_cents > conv["ceiling_price_cents"] and actor["role"] != "supervisor":
                        raise ApiError(403, f"你报的 ¥{quote_cents/100:.0f} 超过了这台最高出价线 ¥{conv['ceiling_price_cents']/100:.0f}！请改低一点，或者点「问主管」请王主管特批。", "ABOVE_CEILING")

                msg_id = f"MSG-{int(time.time()*1000)%1000000}"
                sender_label = "卖家回复" if sender == "seller" else (f"{actor['name']}（采购员）" if sender == "buyer_human" else "自动报价助手")
                conn.execute(
                    "INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (msg_id, conv_id, sender, sender_label, text, quote_cents, conv["context_version"], "sent", idem, ts),
                )
                if quote_cents is not None:
                    r_cnt = conn.execute("SELECT COUNT(*) AS c FROM negotiation_rounds WHERE conv_id=?", (conv_id,)).fetchone()["c"]
                    verdict = "口头谈妥" if body.get("mark_agreed") else ("人工报价" if sender == "buyer_human" else ("首轮试探" if sender == "buyer_ai" else "卖家还价"))
                    conn.execute(
                        "INSERT INTO negotiation_rounds VALUES (?,?,?,?,?,?,?,?,?)",
                        (f"RND-{int(time.time()*1000)%1000000}", conv_id, r_cnt + 1, sender_label, quote_cents, conv["ref_price_cents"], verdict, text[:48], ts),
                    )
                if body.get("mark_agreed") and quote_cents is not None:
                    conn.execute("UPDATE conversations SET agreed_price_cents=?, needs_manual=0, idle_minutes=0, category_group='bargaining', updated_at=? WHERE conv_id=?", (quote_cents, ts, conv_id))
                else:
                    conn.execute("UPDATE conversations SET updated_at=? WHERE conv_id=?", (ts, conv_id))
                log_audit(conn, actor["id"], "发送闲鱼聊天消息", conv_id, f"{sender_label}: {text[:40]}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "msg_id": msg_id}

            if path.startswith("/api/pricebook/") and path.endswith("/draft"):
                item_id = path.split("/")[3]
                item = conn.execute("SELECT * FROM pricebook_items WHERE item_id=?", (item_id,)).fetchone()
                if not item:
                    raise ApiError(404, "找不到这条机型价格")
                first_c = int(body.get("first_offer_cents", item["first_offer_cents"]))
                target_c = int(body.get("target_cents", item["target_cents"]))
                ceil_c = int(body.get("ceiling_cents", item["ceiling_cents"]))
                ref_c = int(body.get("ref_price_cents", item["ref_price_cents"]))
                if not (0 < first_c <= target_c <= ceil_c <= ref_c * 1.1):
                    raise ApiError(400, "价格必须满足：首轮试探价 ≤ 目标价 ≤ 最高上限 ≤ 行情参考价×110%")
                new_id = f"{item_id.split('-V')[0]}-V{item['version_no']+1}"
                existing_draft = conn.execute("SELECT item_id FROM pricebook_items WHERE item_id=?", (new_id,)).fetchone()
                if existing_draft:
                    conn.execute(
                        "UPDATE pricebook_items SET ref_price_cents=?, first_offer_cents=?, target_cents=?, ceiling_cents=?, status='draft_pending_review', updated_by=?, updated_at=? WHERE item_id=?",
                        (ref_c, first_c, target_c, ceil_c, actor["id"], ts, new_id),
                    )
                else:
                    conn.execute(
                        "INSERT INTO pricebook_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (new_id, item["model_code"], item["spec_label"], item["condition_grade"], item["version_no"] + 1,
                         ref_c, first_c, target_c, ceil_c, "draft_pending_review", actor["id"], None, ts),
                    )
                log_audit(conn, actor["id"], "提交价格表修改草稿", new_id, "等待主管审批生效")
                conn.execute("COMMIT")
                return 200, {"ok": True, "draft_item_id": new_id}

            if path.startswith("/api/pricebook/") and path.endswith("/publish"):
                if actor["role"] != "supervisor":
                    raise ApiError(403, "只有【采购主管】能正式发布新价格表", "ROLE_FORBIDDEN")
                item_id = path.split("/")[3]
                item = conn.execute("SELECT * FROM pricebook_items WHERE item_id=?", (item_id,)).fetchone()
                if not item:
                    raise ApiError(404, "找不到这条价格草稿")
                conn.execute("UPDATE pricebook_items SET status='archived', updated_at=? WHERE model_code=? AND status='published'", (ts, item["model_code"]))
                conn.execute("UPDATE pricebook_items SET status='published', approved_by=?, updated_at=? WHERE item_id=?", (actor["id"], ts, item_id))
                open_convs = [dict(r) for r in conn.execute("SELECT conv_id, title, ceiling_price_cents FROM conversations WHERE model_code=?", (item["model_code"],))]
                open_orders = [dict(r) for r in conn.execute("SELECT po_id, stage, agreed_cents, snapshot_id FROM orders WHERE model_code=?", (item["model_code"],))]
                open_tickets = [dict(r) for r in conn.execute("SELECT ticket_id, stage FROM aftersales_tickets WHERE model_code=?", (item["model_code"],))]
                log_audit(conn, actor["id"], "主管发布新价格表", item_id, f"{item['spec_label']} 新价格已生效（正在聊的老单子不受干扰）")
                conn.execute("COMMIT")
                return 200, {
                    "ok": True,
                    "published_id": item_id,
                    "g11_impact_checklist": {
                        "model_code": item["model_code"],
                        "historical_snapshots_untouched": True,
                        "impacted_open_conversations": open_convs,
                        "impacted_orders_reference_only": open_orders,
                        "impacted_tickets": open_tickets,
                    },
                }

            if path == "/api/policies/update":
                if actor["role"] != "supervisor":
                    raise ApiError(403, "只有【采购主管】能修改组内规则参数", "ROLE_FORBIDDEN")
                key = str(body.get("key") or "")
                row = conn.execute("SELECT * FROM policy_configs WHERE key=?", (key,)).fetchone()
                if not row:
                    raise ApiError(404, f"找不到这项规则: {key}")
                cur_val = json.loads(row["value_json"])
                cur_val["value"] = body.get("value")
                conn.execute("UPDATE policy_configs SET value_json=?, updated_by=?, updated_at=? WHERE key=?", (json_dumps(cur_val), actor["id"], ts, key))
                log_audit(conn, actor["id"], "调整采购规则", key, f"更新为 {body.get('value')}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "key": key, "value": cur_val}

            if path == "/api/orders/create":
                idem = body.get("idempotency_key")
                if idem:
                    old = conn.execute("SELECT * FROM orders WHERE idempotency_key=?", (idem,)).fetchone()
                    if old:
                        conn.rollback()
                        return 200, {"ok": True, "idempotent_replay": True, "order": dict(old)}
                conv_id = str(body.get("conv_id") or "CONV-001")
                conv = conn.execute("SELECT * FROM conversations WHERE conv_id=?", (conv_id,)).fetchone()
                if not conv:
                    raise ApiError(404, "找不到关联聊天")
                agreed = int(body.get("agreed_cents") or conv["agreed_price_cents"] or conv["target_price_cents"])
                if agreed > conv["ceiling_price_cents"] and actor["role"] != "supervisor":
                    raise ApiError(403, "谈妥价超过了最高出价线，请先让王主管审批再建单")

                pool = conn.execute("SELECT * FROM quota_pool WHERE pool_id='POOL-202611'").fetchone()
                avail = pool["total_cents"] - pool["reserved_cents"] - pool["spent_cents"]
                if agreed > avail:
                    raise ApiError(409, f"组里买货预算不够了（可用 ¥{avail/100:.2f}）", "QUOTA_EXCEEDED")

                po_id = f"PO-{datetime.now().strftime('%Y%m%d')}-{int(time.time()*1000)%1000:03d}"
                ext_no = str(body.get("external_order_no") or f"GF-ORD-{int(time.time()*1000)%1000000}")
                res_id = f"RES-{po_id}"
                conn.execute("UPDATE quota_pool SET reserved_cents = reserved_cents + ?, updated_at=? WHERE pool_id='POOL-202611'", (agreed, ts))
                conn.execute(
                    "INSERT INTO quota_reservations VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (res_id, po_id, conv_id, actor["id"], agreed, "reserved", f"po-res-{po_id}", "建单自动锁住预算", ts, ts),
                )
                snap = json.loads(conv["snapshot_json"])
                snap["frozen_for_po"] = po_id
                conn.execute(
                    "INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (po_id, ext_no, conv_id, conv["model_code"], conv["title"], conv["seller_name"],
                     "verbal_agreed", agreed, None, snap["snapshot_id"], snap["snapshot_version"], json_dumps(snap),
                     None, None, res_id, "manual", "[]", 1, idem, ts, ts),
                )
                conn.execute("UPDATE procurement_cases SET po_id=?, quota_res_id=?, updated_at=? WHERE conv_id=? AND po_id IS NULL", (po_id, res_id, ts, conv_id))
                log_audit(conn, actor["id"], "记下谈妥价准备核对改价", po_id, f"谈妥 ¥{agreed/100:.0f}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "po_id": po_id, "external_order_no": ext_no}

            if path.startswith("/api/orders/") and path.endswith("/advance"):
                po_id = path.split("/")[3]
                po = conn.execute("SELECT * FROM orders WHERE po_id=?", (po_id,)).fetchone()
                if not po:
                    raise ApiError(404, "找不到这笔订单")
                target_stage = str(body.get("target_stage") or "")
                cur = po["stage"]
                if target_stage == "price_checked":
                    if cur != "verbal_agreed":
                        raise ApiError(409, "这笔订单已经核对过改价啦")
                    listed = int(body.get("platform_listed_cents") or 0)
                    if listed != po["agreed_cents"]:
                        raise ApiError(400, f"先别付钱！闲鱼链接上挂的还是 ¥{listed/100:.0f}，跟谈好的 ¥{po['agreed_cents']/100:.0f} 不一样，快催卖家改好价格再拍！", "PRICE_MISMATCH")
                    conn.execute("UPDATE orders SET stage='price_checked', last_event_seq=last_event_seq+1, updated_at=? WHERE po_id=?", (ts, po_id))
                    log_audit(conn, actor["id"], "核对闲鱼改价一致", po_id, f"闲鱼挂价已改为 ¥{po['agreed_cents']/100:.0f}")
                elif target_stage == "manual_paid":
                    if cur != "price_checked":
                        raise ApiError(409, "防多付钱保护：必须先确认卖家把闲鱼链接改成了谈妥价，才能登记付款！", "SKIP_PRICE_CHECK")
                    paid = int(body.get("paid_cents") or 0)
                    receipt = str(body.get("payment_receipt_no") or "").strip()
                    validate_no_zero_placeholder({"支付宝/闲鱼付款单号": receipt})
                    if paid <= 0:
                        raise ApiError(400, "实付金额必须大于 0 元")
                    if po["quota_res_id"]:
                        res = conn.execute("SELECT * FROM quota_reservations WHERE res_id=?", (po["quota_res_id"],)).fetchone()
                        if res and res["status"] == "reserved":
                            conn.execute("UPDATE quota_reservations SET status='converted', updated_at=? WHERE res_id=?", (ts, res["res_id"]))
                            conn.execute(
                                "UPDATE quota_pool SET reserved_cents = MAX(0, reserved_cents - ?), spent_cents = spent_cents + ?, updated_at=? WHERE pool_id='POOL-202611'",
                                (res["amount_cents"], paid, ts),
                            )
                    snap = json.loads(po["snapshot_json"])
                    new_ver = po["snapshot_version"] + 1
                    snap["snapshot_id"] = f"{snap.get('snapshot_id','SNAP').split('-V')[0]}-V{new_ver}"
                    snap["snapshot_version"] = new_ver
                    snap["frozen_paid_at"] = ts
                    conn.execute(
                        "UPDATE orders SET stage='manual_paid', paid_cents=?, payment_receipt_no=?, snapshot_id=?, snapshot_version=?, snapshot_json=?, last_event_seq=last_event_seq+1, updated_at=? WHERE po_id=?",
                        (paid, receipt, snap["snapshot_id"], new_ver, json_dumps(snap), ts, po_id),
                    )
                    conn.execute(
                        "INSERT INTO finance_ledger VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (f"FIN-PO-{int(time.time()*1000)%1000000}", None, po_id, po["model_code"], "po_payment", "闲鱼实付货款", paid, "outflow", receipt, None, "verified", f"已付款并锁死卖家原话", ts),
                    )
                    log_audit(conn, actor["id"], "完成付款并锁死卖家原话", po_id, f"实付 ¥{paid/100:.0f}，单号 {receipt}")
                else:
                    raise ApiError(400, f"不支持的步骤: {target_stage}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "po_id": po_id, "stage": target_stage}

            if path == "/api/orders/rpa-simulate":
                scenario = str(body.get("scenario_code") or "")
                ext_no = str(body.get("external_order_no") or f"GF-ORD-RPA-{int(time.time())%10000}")
                idem = str(body.get("idempotency_key") or f"rpa-{scenario}-{int(time.time()*1000)}")
                old_evt = conn.execute("SELECT * FROM rpa_events WHERE idempotency_key=?", (idem,)).fetchone()
                if old_evt:
                    conn.rollback()
                    return 200, {"ok": True, "outcome": "idempotent_replay", "detail": f"重复抓单已自动过滤（结果：{old_evt['outcome']}）", "event": dict(old_evt)}

                outcome = "accepted"
                detail = ""
                seq = int(body.get("event_seq") or 1)
                if scenario == "W10-01":
                    po_id = f"PO-RPA-{int(time.time()*1000)%10000}"
                    missing = ["paid_cents", "shipping_address", "tracking_no"]
                    conn.execute(
                        "INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (po_id, ext_no, None, "IP15P-256-NAT", "自动抓回待补信息订单", "闲鱼个人卖家",
                         "verbal_agreed", 455000, None, f"SNAP-{po_id}-V1", 1, json_dumps({"snapshot_id": f"SNAP-{po_id}-V1", "seller_declaration": "待补实付单号与快递单号"}),
                         None, None, None, "rpa", json_dumps(missing), seq, f"rpa-po-{ext_no}", ts, ts),
                    )
                    outcome = "flagged_incomplete"
                    detail = f"抓到缺快递号/实付金额的单子 {po_id}，已标黄提醒补齐"
                elif scenario == "W10-02":
                    po = conn.execute("SELECT * FROM orders ORDER BY created_at DESC LIMIT 1").fetchone()
                    ext_no = po["external_order_no"]
                    outcome = "merged"
                    detail = f"闲鱼单号 {ext_no} 已存在，自动合并到原单，没建重复单"
                elif scenario == "W10-03":
                    outcome = "backfilled"
                    detail = f"漏抓老订单 {ext_no} 已自动补抓进系统"
                elif scenario == "W10-04":
                    po = conn.execute("SELECT * FROM orders WHERE stage IN ('verbal_agreed','price_checked') LIMIT 1").fetchone()
                    if po:
                        conn.execute("UPDATE orders SET stage='cancelled_unpaid', updated_at=? WHERE po_id=?", (ts, po["po_id"]))
                        if po["quota_res_id"]:
                            res = conn.execute("SELECT * FROM quota_reservations WHERE res_id=?", (po["quota_res_id"],)).fetchone()
                            if res and res["status"] == "reserved":
                                conn.execute("UPDATE quota_reservations SET status='released', updated_at=? WHERE res_id=?", (ts, res["res_id"]))
                                conn.execute("UPDATE quota_pool SET reserved_cents = MAX(0, reserved_cents - ?), updated_at=? WHERE pool_id='POOL-202611'", (res["amount_cents"], ts))
                        detail = f"未付款取消单 {po['po_id']} 已自动把预留预算退回池子"
                    else:
                        detail = "当前没有未付款单"
                elif scenario == "W10-05":
                    po = conn.execute("SELECT * FROM orders WHERE stage='manual_paid' LIMIT 1").fetchone()
                    if po:
                        conn.execute("UPDATE orders SET stage='cancelled_paid_refunding', updated_at=? WHERE po_id=?", (ts, po["po_id"]))
                        conn.execute(
                            "INSERT INTO finance_ledger VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (f"FIN-REF-{int(time.time()*1000)%100000}", None, po["po_id"], po["model_code"], "platform_refund", "付款后未发货取消待退款",
                             po["paid_cents"] or po["agreed_cents"], "inflow", None, None, "pending_finance", "等待卖家退款到账", ts),
                        )
                        detail = f"已付款未发货取消单 {po['po_id']}，已生成待会计查账退款单"
                    else:
                        detail = "当前没有已付款未发货单"
                elif scenario == "W10-06":
                    t = conn.execute("SELECT * FROM aftersales_tickets WHERE ticket_id='TK-2403'").fetchone()
                    detail = f"已发货半路取消单：顺丰拦截状态为 {t['carrier_intercept_status']}，确认截回前锁死不准入库"
                elif scenario == "W10-07":
                    po = conn.execute("SELECT * FROM orders WHERE stage IN ('shipped','manual_paid') LIMIT 1").fetchone()
                    cur_seq = po["last_event_seq"] if po else 5
                    outcome = "ignored_stale"
                    detail = f"收到迟到的旧状态消息（比当前进度 {cur_seq} 老），已自动忽略，不会把已付款单退回未付款"
                elif scenario == "W10-08":
                    outcome = "idempotent_replay"
                    detail = "连发两次一样的同步通知只记一次账"
                else:
                    raise ApiError(400, f"未知同步测试项: {scenario}")

                evt_id = f"EVT-{int(time.time()*1000)%1000000}"
                conn.execute("INSERT INTO rpa_events VALUES (?,?,?,?,?,?,?,?)", (evt_id, scenario, ext_no, seq, idem, outcome, detail, ts))
                log_audit(conn, actor["id"], f"抓单巡检测试", ext_no, detail)
                conn.execute("COMMIT")
                return 200, {"ok": True, "outcome": outcome, "detail": detail}

            # ---------------- Aftersales & Step-by-Step Post-Arrival Bargaining ----------------
            if path.startswith("/api/aftersales/") and path.endswith("/handoff"):
                tid = path.split("/")[3]
                t = conn.execute("SELECT * FROM aftersales_tickets WHERE ticket_id=?", (tid,)).fetchone()
                if not t:
                    raise ApiError(404, "找不到这笔问题单")
                target_owner = str(body.get("next_owner_id") or "")
                if target_owner not in ROLES:
                    raise ApiError(400, "找不到要转交的同事")
                conn.execute(
                    "UPDATE aftersales_tickets SET next_owner_id=?, handoff_status='pending_accept', updated_at=? WHERE ticket_id=?",
                    (target_owner, ts, tid),
                )
                log_audit(conn, actor["id"], "转交同事接力", tid, f"转给 {ROLES[target_owner]['name']}（对方点接手前仍由原负责人盯紧）")
                conn.execute("COMMIT")
                return 200, {"ok": True, "handoff_status": "pending_accept", "owner_retained": t["owner_id"]}

            if path.startswith("/api/aftersales/") and path.endswith("/accept-handoff"):
                tid = path.split("/")[3]
                t = conn.execute("SELECT * FROM aftersales_tickets WHERE ticket_id=?", (tid,)).fetchone()
                if not t:
                    raise ApiError(404, "找不到这笔问题单")
                if t["next_owner_id"] != actor["id"] and actor["role"] != "supervisor":
                    raise ApiError(403, "只有被转交的同事本人或主管能点接手", "HANDOFF_WRONG_ACTOR")
                new_owner = t["next_owner_id"] or actor["id"]
                conn.execute(
                    "UPDATE aftersales_tickets SET owner_id=?, next_owner_id=NULL, handoff_status='accepted', updated_at=? WHERE ticket_id=?",
                    (new_owner, ts, tid),
                )
                log_audit(conn, actor["id"], "确认接手问题单", tid, f"{ROLES[new_owner]['name']} 已接手")
                conn.execute("COMMIT")
                return 200, {"ok": True, "owner_id": new_owner}

            if path.startswith("/api/aftersales/") and path.endswith("/step1-triage"):
                tid = path.split("/")[3]
                t = conn.execute("SELECT * FROM aftersales_tickets WHERE ticket_id=?", (tid,)).fetchone()
                if not t:
                    raise ApiError(404, "找不到这笔问题单")
                bf = json.loads(t["bargain_flow_json"] or "{}")
                route_choice = str(body.get("route_choice") or "bargain_keep")
                arrival_track = str(body.get("arrival_track") or bf.get("arrival_track") or "sf_express_refuse")
                if arrival_track not in ("sf_express_refuse", "signed_platform_return"):
                    arrival_track = "sf_express_refuse"
                bf["step1_triage_done"] = True
                bf["route_choice"] = route_choice
                bf["arrival_track"] = arrival_track
                bf["return_mode"] = "platform_return" if arrival_track == "signed_platform_return" else "station_refuse"
                bf["erp_material_archived"] = True
                conn.execute("UPDATE aftersales_tickets SET bargain_flow_json=?, updated_at=? WHERE ticket_id=?", (json_dumps(bf), ts, tid))
                log_audit(conn, actor["id"], "完成第1步验货抓差分流", tid, f"路线：{route_choice} · 轨道：{arrival_track}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "flow_state": bf}

            if path.startswith("/api/aftersales/") and path.endswith("/submit-return"):
                tid = path.split("/")[3]
                t = conn.execute("SELECT * FROM aftersales_tickets WHERE ticket_id=?", (tid,)).fetchone()
                if not t:
                    raise ApiError(404, "找不到这笔问题单")
                ret_no = str(body.get("platform_return_no") or "").strip()
                ret_mode = str(body.get("return_mode") or "station_refuse")
                dl = str(body.get("platform_deadline_at") or plus_hours_iso(48)).strip()
                validate_no_zero_placeholder({"面单拒签回执号/闲鱼退货单号": ret_no, "平台超时时间": dl})
                waybill_ok = bool(body.get("waybill_refused_verified", True))
                wx_added = bool(body.get("seller_wechat_added", True))
                wx_id = str(body.get("seller_wechat_id") or "").strip()
                resp_mins = int(body.get("buyer_response_mins") or 8)
                if ret_mode == "station_refuse" and not waybill_ok:
                    raise ApiError(400, "拒签单必须先确认快递面单/物流轨迹上已经显示『拒签』！", "WAYBILL_REFUSE_UNVERIFIED")
                bf = json.loads(t["bargain_flow_json"] or "{}")
                bf["step1_triage_done"] = True
                bf["return_mode"] = ret_mode
                bf["arrival_track"] = str(body.get("arrival_track") or ("signed_platform_return" if ret_mode == "platform_return" else "sf_express_refuse"))
                bf["waybill_refused_verified"] = waybill_ok
                bf["seller_wechat_added"] = wx_added
                bf["buyer_response_mins"] = resp_mins
                if wx_id:
                    bf["seller_wechat_id"] = wx_id
                conn.execute(
                    "UPDATE aftersales_tickets SET stage='return_requested', platform_return_no=?, platform_deadline_at=?, sla_platform_deadline=?, bargain_flow_json=?, updated_at=? WHERE ticket_id=?",
                    (ret_no, dl, dl, json_dumps(bf), ts, tid),
                )
                log_audit(conn, actor["id"], "完成第2步拒签响应或锁平台退货时效", tid, f"单号 {ret_no} · 轨道 {bf['arrival_track']} · 卖家微信 {wx_id or '已加'}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "stage": "return_requested", "flow_state": bf}

            if path.startswith("/api/aftersales/") and path.endswith("/observe-signal"):
                tid = path.split("/")[3]
                t = conn.execute("SELECT * FROM aftersales_tickets WHERE ticket_id=?", (tid,)).fetchone()
                if not t:
                    raise ApiError(404, "找不到这笔问题单")
                if not t["platform_return_no"]:
                    raise ApiError(409, "请先完成第 2 步确认面单拒签/锁退货倒计时，再观察卖家信号！", "RETURN_FIRST_REQUIRED")
                sig = str(body.get("signal") or "green_proactive")
                if sig not in ("green_proactive", "amber_anxious", "red_hard_address"):
                    raise ApiError(400, "请选择有效的卖家三色行为信号")
                s_words = str(body.get("seller_words") or "").strip()
                sf_95338 = str(body.get("sf_95338_status") or ("seller_called_95338_return" if sig == "red_hard_address" else "station_hold"))
                bf = json.loads(t["bargain_flow_json"] or "{}")
                bf["step3_signal"] = sig
                bf["step3_signal_done"] = True
                bf["sf_95338_status"] = sf_95338
                if s_words:
                    bf["seller_proactive_words"] = s_words
                intercept_st = "requested" if sf_95338 == "seller_called_95338_return" else t["carrier_intercept_status"]
                conn.execute("UPDATE aftersales_tickets SET carrier_intercept_status=?, bargain_flow_json=?, updated_at=? WHERE ticket_id=?", (intercept_st, json_dumps(bf), ts, tid))
                log_audit(conn, actor["id"], "登记第3步卖家反应与顺丰95338信号", tid, f"信号={sig} 95338={sf_95338} {s_words[:40]}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "flow_state": bf}

            if path.startswith("/api/aftersales/") and path.endswith("/bargain-round"):
                tid = path.split("/")[3]
                t = conn.execute("SELECT * FROM aftersales_tickets WHERE ticket_id=?", (tid,)).fetchone()
                if not t:
                    raise ApiError(404, "找不到这笔问题单")
                if t["stage"] == "issue" or not t["platform_return_no"]:
                    raise ApiError(409, "防超时与防到手刀铁律：必须先完成第 2 步「去闲鱼点退货退款锁住倒计时」，才能跟卖家发二次议价话术！", "RETURN_FIRST_REQUIRED")
                role_side = str(body.get("role_side") or "buyer")
                seller_style = str(body.get("seller_style") or "defensive")
                round_no = int(body.get("round_no") or 1)
                ask_refund_cents = int(body.get("ask_refund_cents") or 0)
                text = str(body.get("text") or "").strip()
                if not text:
                    raise ApiError(400, "话术内容不能为空")
                if role_side == "buyer":
                    for kw in CONFIDENTIAL_KEYWORDS:
                        if kw in text:
                            raise ApiError(422, f"话术里含内部词「{kw}」，删掉后再发给卖家哦", "OUTBOUND_LEAK_BLOCKED")
                    plan_tmp = build_bargain_plan(dict(t), [])
                    if plan_tmp and ask_refund_cents > 0 and ask_refund_cents < plan_tmp["floor_c_cents"] and actor["role"] != "supervisor":
                        raise ApiError(
                            409,
                            f"让步纪律拦截：你报的退差 ¥{ask_refund_cents/100:.0f} 已经跌穿系统最低留货底线 ¥{plan_tmp['floor_c_cents']/100:.0f}！低于底线留下来不如直接退货重买，严禁一刀跳穿底线！",
                            "BELOW_FLOOR_C",
                        )
                tactic_code = str(body.get("tactic_code") or "").strip()
                tactic_tag = f" · 锚点 {tactic_code}" if tactic_code else ""
                speaker = f"{actor['name']}（第{round_no}轮议价{tactic_tag}）" if role_side == "buyer" else "卖家最新回复"
                lid = f"BLOG-{int(time.time()*1000)%1000000}"
                conn.execute(
                    "INSERT INTO aftersales_bargain_logs VALUES (?,?,?,?,?,?,?,?,?)",
                    (lid, tid, round_no, role_side, speaker, seller_style, ask_refund_cents, text, ts),
                )
                bf = json.loads(t["bargain_flow_json"] or "{}")
                if tactic_code:
                    used_list = list(bf.get("tactics_used") or [])
                    if tactic_code not in used_list:
                        used_list.append(tactic_code)
                    bf["tactics_used"] = used_list
                bf["step3_signal_done"] = True
                bf["step4_calc_done"] = True
                if round_no == 1 and role_side == "buyer":
                    bf["step5_round1_done"] = True
                    if body.get("silence_6s_done"):
                        bf["silence_6s_done"] = True
                if round_no >= 2 or role_side == "seller":
                    bf["step5_round1_done"] = True
                    bf["step6_round2_done"] = True
                if body.get("selected_meso"):
                    bf["selected_meso"] = str(body.get("selected_meso"))

                if role_side == "seller" and ask_refund_cents > 0:
                    old_offer = int(t["partial_refund_cents"] or 0)
                    implied_repair = max(0, int(t["k_keep_cost_cents"]) - (int(t["paid_cents"]) - old_offer))
                    new_k = int(t["paid_cents"]) - ask_refund_cents + implied_repair
                    s_c = int(t["s_market_cents"])
                    r_c = int(t["r_replace_cost_cents"])
                    keep_net = s_c - new_k
                    replace_net = s_c - r_c
                    h = calc_plan_b_hash(s_c, new_k, r_c, t["platform_deadline_at"] or t["sla_platform_deadline"])
                    conn.execute(
                        """UPDATE aftersales_tickets
                           SET partial_refund_cents=?, k_keep_cost_cents=?, plan_b_calc_hash=?,
                               plan_b_keep_net_cents=?, plan_b_replace_net_cents=?, stage='plan_b_ready', bargain_flow_json=?, updated_at=?
                           WHERE ticket_id=?""",
                        (ask_refund_cents, new_k, h, keep_net, replace_net, json_dumps(bf), ts, tid),
                    )
                else:
                    conn.execute("UPDATE aftersales_tickets SET bargain_flow_json=?, updated_at=? WHERE ticket_id=?", (json_dumps(bf), ts, tid))
                log_audit(conn, actor["id"], "记录到货二次议价对话", tid, f"{speaker}: {text[:45]}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "log_id": lid}

            if path.startswith("/api/aftersales/") and path.endswith("/cooldown-callback"):
                tid = path.split("/")[3]
                t = conn.execute("SELECT * FROM aftersales_tickets WHERE ticket_id=?", (tid,)).fetchone()
                if not t:
                    raise ApiError(404, "找不到这笔问题单")
                if not t["platform_return_no"]:
                    raise ApiError(409, "请先完成第 2 步锁住退货倒计时", "RETURN_FIRST_REQUIRED")
                outcome = str(body.get("outcome") or "rescued_keep")
                cooldown_mins = int(body.get("cooldown_mins") or 35)
                bf = json.loads(t["bargain_flow_json"] or "{}")
                if outcome == "rescued_keep":
                    rescued_c = int(body.get("agreed_refund_cents") or 0)
                    plan_tmp = build_bargain_plan(dict(t), [])
                    floor_c = plan_tmp["floor_c_cents"] if plan_tmp else 10000
                    if rescued_c <= 0:
                        rescued_c = floor_c
                    if rescued_c < floor_c and actor["role"] != "supervisor":
                        raise ApiError(
                            409,
                            f"二次回拨救单金额 ¥{rescued_c/100:.0f} 低于留货底线 ¥{floor_c/100:.0f}（不如退货重买划算）！请直接走全额退货或请王主管特批。",
                            "BELOW_FLOOR_C",
                        )
                    bf["step3_signal_done"] = True
                    bf["step4_calc_done"] = True
                    bf["step5_round1_done"] = True
                    bf["step6_round2_done"] = True
                    bf["step7_cooldown_done"] = True
                    bf["cooldown_mins"] = cooldown_mins
                    bf["cooldown_outcome"] = outcome
                    old_offer = int(t["partial_refund_cents"] or 0)
                    implied_repair = max(0, int(t["k_keep_cost_cents"]) - (int(t["paid_cents"]) - old_offer))
                    new_k = int(t["paid_cents"]) - rescued_c + implied_repair
                    s_c = int(t["s_market_cents"])
                    r_c = int(t["r_replace_cost_cents"])
                    h = calc_plan_b_hash(s_c, new_k, r_c, t["platform_deadline_at"] or t["sla_platform_deadline"])
                    conn.execute(
                        """UPDATE aftersales_tickets
                           SET partial_refund_cents=?, k_keep_cost_cents=?, plan_b_calc_hash=?,
                               plan_b_keep_net_cents=?, plan_b_replace_net_cents=?, stage='plan_b_ready', bargain_flow_json=?, updated_at=?
                           WHERE ticket_id=?""",
                        (rescued_c, new_k, h, s_c - new_k, s_c - r_c, json_dumps(bf), ts, tid),
                    )
                    conn.execute(
                        "INSERT INTO aftersales_bargain_logs VALUES (?,?,?,?,?,?,?,?,?)",
                        (f"BLOG-CB-{int(time.time()*1000)%100000}", tid, 3, "buyer", f"{actor['name']}（冷却{cooldown_mins}分钟·二次回拨救单成功）", "tough", rescued_c,
                         f"战略冷却 {cooldown_mins} 分钟重算留货仍划算，拨打第二通电话给最后恢复窗口，卖家松口同意补差 ¥{rescued_c/100:.0f} 留货！", ts),
                    )
                    log_audit(conn, actor["id"], "完成先退后回二次回拨救单", tid, f"冷却{cooldown_mins}分钟后救回成交，退差 ¥{rescued_c/100:.0f}")
                elif outcome == "reluctant_salvage_keep":
                    plan_tmp = build_bargain_plan(dict(t), [])
                    token_wipe_c = max(0, int(body.get("agreed_refund_cents") or 0))
                    old_offer = int(t["partial_refund_cents"] or 0)
                    implied_repair = max(0, int(t["k_keep_cost_cents"]) - (int(t["paid_cents"]) - old_offer))
                    new_k = int(t["paid_cents"]) - token_wipe_c + implied_repair
                    s_c = int(t["s_market_cents"])
                    r_c = int(t["r_replace_cost_cents"])
                    salvage_net = s_c - new_k
                    if salvage_net <= 0 and actor["role"] != "supervisor":
                        raise ApiError(409, "本单原价/微降留货会亏损，不符合『嫌弃式勉强收下』保底盈利条件！请直接真退或请王主管特批。", "SALVAGE_LOSS_BLOCKED")
                    bf["step3_signal_done"] = True
                    bf["step4_calc_done"] = True
                    bf["step5_round1_done"] = True
                    bf["step6_round2_done"] = True
                    bf["step7_cooldown_done"] = True
                    bf["cooldown_mins"] = cooldown_mins
                    bf["cooldown_outcome"] = outcome
                    h = calc_plan_b_hash(s_c, new_k, r_c, t["platform_deadline_at"] or t["sla_platform_deadline"])
                    conn.execute(
                        """UPDATE aftersales_tickets
                           SET partial_refund_cents=?, k_keep_cost_cents=?, plan_b_calc_hash=?,
                               plan_b_keep_net_cents=?, plan_b_replace_net_cents=?, stage='plan_b_ready', bargain_flow_json=?, updated_at=?
                           WHERE ticket_id=?""",
                        (token_wipe_c, new_k, h, salvage_net, s_c - r_c, json_dumps(bf), ts, tid),
                    )
                    conn.execute(
                        "INSERT INTO aftersales_bargain_logs VALUES (?,?,?,?,?,?,?,?,?)",
                        (f"BLOG-SLV-{int(time.time()*1000)%100000}", tid, 3, "buyer", f"{actor['name']}（强硬卖家·嫌弃式勉强收下保利润）", "tough", token_wipe_c,
                         f"卖家极强硬已打 95338，因本单急用且保底净赚 ¥{salvage_net/100:.0f}，发出台阶话术：『算了吧太急了，虽然这么烂我也勉强收下了，请撤回 95338』（抹零 ¥{token_wipe_c/100:.0f}）！", ts),
                    )
                    log_audit(conn, actor["id"], "执行嫌弃式勉强收下保底吃肉", tid, f"保住净利 ¥{salvage_net/100:.0f}，抹零 ¥{token_wipe_c/100:.0f}")
                else:
                    bf["step3_signal_done"] = True
                    bf["step4_calc_done"] = True
                    bf["step5_round1_done"] = True
                    bf["step6_round2_done"] = True
                    bf["step7_cooldown_done"] = True
                    bf["cooldown_mins"] = cooldown_mins
                    bf["cooldown_outcome"] = outcome
                    conn.execute("UPDATE aftersales_tickets SET bargain_flow_json=?, updated_at=? WHERE ticket_id=?", (json_dumps(bf), ts, tid))
                    log_audit(conn, actor["id"], "完成第7步冷却复算确认", tid, f"结果：{outcome}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "flow_state": bf}

            if path.startswith("/api/aftersales/") and path.endswith("/plan-b-calc"):
                tid = path.split("/")[3]
                t = conn.execute("SELECT * FROM aftersales_tickets WHERE ticket_id=?", (tid,)).fetchone()
                if not t:
                    raise ApiError(404, "找不到这笔问题单")
                if t["stage"] == "issue" or not t["platform_return_no"]:
                    raise ApiError(409, "防吃亏铁律：发现货不对板必须先去闲鱼点「退货退款」锁住 48 小时倒计时，没点退货前严禁算留货！", "RETURN_FIRST_REQUIRED")
                s_c = int(body.get("s_market_cents", t["s_market_cents"]))
                k_c = int(body.get("k_keep_cost_cents", t["k_keep_cost_cents"]))
                r_c = int(body.get("r_replace_cost_cents", t["r_replace_cost_cents"]))
                partial_c = int(body.get("partial_refund_cents", t["partial_refund_cents"]))
                keep_net = s_c - k_c
                replace_net = s_c - r_c
                h = calc_plan_b_hash(s_c, k_c, r_c, t["platform_deadline_at"] or t["sla_platform_deadline"])
                bf = json.loads(t["bargain_flow_json"] or "{}")
                bf["step3_signal_done"] = True
                bf["step4_calc_done"] = True
                conn.execute(
                    """UPDATE aftersales_tickets
                       SET s_market_cents=?, k_keep_cost_cents=?, r_replace_cost_cents=?, partial_refund_cents=?,
                           plan_b_calc_hash=?, plan_b_keep_net_cents=?, plan_b_replace_net_cents=?,
                           stage='plan_b_ready', bargain_flow_json=?, updated_at=?
                       WHERE ticket_id=?""",
                    (s_c, k_c, r_c, partial_c, h, keep_net, replace_net, json_dumps(bf), ts, tid),
                )
                log_audit(conn, actor["id"], "算清四组底牌与留货净赚对比", tid, f"留货净赚 ¥{keep_net/100:.0f} vs 退货重买净赚 ¥{replace_net/100:.0f}")
                conn.execute("COMMIT")
                return 200, {
                    "ok": True,
                    "plan_b_keep_net_cents": keep_net,
                    "plan_b_replace_net_cents": replace_net,
                    "better_to_keep": keep_net > replace_net,
                    "calc_hash": h,
                }

            if path.startswith("/api/aftersales/") and path.endswith("/confirm-intercept"):
                tid = path.split("/")[3]
                t = conn.execute("SELECT * FROM aftersales_tickets WHERE ticket_id=?", (tid,)).fetchone()
                if not t:
                    raise ApiError(404, "找不到这笔问题单")
                if actor["role"] not in ("warehouse", "supervisor"):
                    raise ApiError(403, "只有【赵仓管】或【王主管】能确认顺丰已撤回 95338 退回并把包裹扣留在库", "ROLE_FORBIDDEN")
                bf = json.loads(t["bargain_flow_json"] or "{}")
                bf["sf_95338_status"] = "recalled_keep"
                conn.execute("UPDATE aftersales_tickets SET carrier_intercept_status='confirmed', bargain_flow_json=?, updated_at=? WHERE ticket_id=?", (json_dumps(bf), ts, tid))
                log_audit(conn, actor["id"], "确认卖家已撤95338且包裹扣回仓库", tid, "包裹已确认物理扣留仓库")
                conn.execute("COMMIT")
                return 200, {"ok": True, "carrier_intercept_status": "confirmed", "sf_95338_status": "recalled_keep"}

            if path.startswith("/api/aftersales/") and path.endswith("/confirm-keep"):
                tid = path.split("/")[3]
                t = conn.execute("SELECT * FROM aftersales_tickets WHERE ticket_id=?", (tid,)).fetchone()
                if not t:
                    raise ApiError(404, "找不到这笔问题单")
                if not t["platform_return_no"]:
                    raise ApiError(409, "还没在闲鱼点退货锁住倒计时呢，不能直接点留货", "RETURN_FIRST_REQUIRED")
                if t["carrier_intercept_status"] == "requested":
                    raise ApiError(409, "包裹还在顺丰半路拦截中，没确认截回前不能点留货！", "INTERCEPT_UNCONFIRMED")
                s_c = int(body.get("s_market_cents", t["s_market_cents"]))
                k_c = int(body.get("k_keep_cost_cents", t["k_keep_cost_cents"]))
                r_c = int(body.get("r_replace_cost_cents", t["r_replace_cost_cents"]))
                cur_hash = calc_plan_b_hash(s_c, k_c, r_c, t["platform_deadline_at"] or t["sla_platform_deadline"])
                if not t["plan_b_calc_hash"] or cur_hash != t["plan_b_calc_hash"]:
                    raise ApiError(409, "刚改了退差价金额，请先点一下「算算划不划算」刷新结果再定留货！", "PLAN_B_HASH_STALE")
                keep_net = s_c - k_c
                replace_net = s_c - r_c
                if keep_net <= replace_net:
                    raise ApiError(409, f"不划算拦截：留下来只赚 ¥{keep_net/100:.0f}，还不如退掉重买赚 ¥{replace_net/100:.0f}！别硬留，请直接走全额退货。", "PLAN_B_NOT_BETTER")

                partial_refund = int(body.get("partial_refund_cents") or t["partial_refund_cents"] or 0)
                settle_mode = str(body.get("settle_mode") or "platform_partial")
                bf = json.loads(t["bargain_flow_json"] or "{}")
                bf["step7_cooldown_done"] = True
                bf["disclosure_complete"] = bool(body.get("disclosure_complete", True))
                bf["wechat_4elem_confirmed"] = bool(body.get("wechat_4elem_confirmed", True))
                bf["erp_material_archived"] = True

                if settle_mode in ("corp_alipay_close", "wechat_split"):
                    payout_cents = int(
                        body.get("agreed_payout_cents")
                        or body.get("wechat_pay_cents")
                        or max(5000, t["paid_cents"] - partial_refund)
                    )
                    partial_refund = max(0, int(t["paid_cents"]) - payout_cents)
                    seller_alipay_acc = str(body.get("seller_alipay_account") or "").strip()
                    seller_alipay_name = str(body.get("seller_alipay_name") or "").strip()
                    close_no = str(body.get("platform_close_no") or t["platform_return_no"] or "").strip()
                    reg_note = str(body.get("register_note") or f"闲鱼原单 ¥{t['paid_cents']/100:.0f} 整单全退关闭脱离平台管辖，改走支付宝对公支付 ¥{payout_cents/100:.0f}（次日 10:00 T+1 财务审批）").strip()
                    if settle_mode == "corp_alipay_close":
                        validate_no_zero_placeholder({
                            "卖家收款支付宝账号": seller_alipay_acc,
                            "卖家支付宝实名姓名": seller_alipay_name,
                            "闲鱼整单全退关单号": close_no,
                        })
                    else:
                        seller_alipay_acc = seller_alipay_acc or "待补卖家支付宝号"
                        seller_alipay_name = seller_alipay_name or "卖家实名"

                    bf["selected_meso"] = f"整单全退关单 + 支付宝对公支付 ¥{payout_cents/100:.0f}（T+1次日10:00审批）"
                    conn.execute(
                        "UPDATE aftersales_tickets SET stage='waiting_finance', stock_disposition='pending', partial_refund_cents=?, sla_daily_clear='次日 10:00 (T+1)', bargain_flow_json=?, updated_at=? WHERE ticket_id=?",
                        (partial_refund, json_dumps(bf), ts, tid),
                    )
                    case_row_ref = conn.execute("SELECT case_id FROM procurement_cases WHERE ticket_id=?", (tid,)).fetchone()
                    cid_ref = case_row_ref["case_id"] if case_row_ref else None
                    reg_id = f"ALIPAY-REG-{int(time.time()*1000)%1000000}"
                    conn.execute(
                        """INSERT INTO corp_alipay_registrations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                           ON CONFLICT(ticket_id) DO UPDATE SET
                             agreed_payout_cents=excluded.agreed_payout_cents,
                             bargain_saved_cents=excluded.bargain_saved_cents,
                             platform_close_no=excluded.platform_close_no,
                             seller_alipay_account=excluded.seller_alipay_account,
                             seller_alipay_name=excluded.seller_alipay_name,
                             register_note=excluded.register_note,
                             approval_status='pending_t1_10am'""",
                        (
                            reg_id, tid, t["po_id"], cid_ref,
                            int(t["paid_cents"]), payout_cents, partial_refund, close_no,
                            seller_alipay_acc, seller_alipay_name, reg_note, actor["id"],
                            "T+1 账单核对 · 次日 10:00 财务审批", "次日 10:00（T+1 账单核对）",
                            "pending_t1_10am", None, None, None, ts,
                        ),
                    )
                    existing_rf = conn.execute("SELECT entry_id FROM finance_ledger WHERE ticket_id=? AND entry_type='platform_refund'", (tid,)).fetchone()
                    if not existing_rf:
                        conn.execute(
                            "INSERT INTO finance_ledger VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (f"FIN-RF-{int(time.time()*1000)%1000000}", tid, t["po_id"], t["model_code"], "platform_refund",
                             "闲鱼整单全额退回关单（脱离平台管辖·防差评）",
                             t["paid_cents"], "inflow", None, None, "pending_finance",
                             f"整单全退 ¥{t['paid_cents']/100:.0f} 关闭交易（单号 {close_no}）", ts),
                        )
                    existing_cp = conn.execute("SELECT entry_id FROM finance_ledger WHERE ticket_id=? AND entry_type IN ('corp_alipay_payout','wechat_split')", (tid,)).fetchone()
                    if not existing_cp:
                        conn.execute(
                            "INSERT INTO finance_ledger VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (f"FIN-ALI-{int(time.time()*1000)%1000000}", tid, t["po_id"], t["model_code"], "corp_alipay_payout",
                             "支付宝对公支付直转卖家（T+1次日10:00财务审批）",
                             payout_cents, "outflow", None, None, "pending_finance",
                             f"对公转卖家 {seller_alipay_name}({seller_alipay_acc}) ¥{payout_cents/100:.0f} · 预计次日10:00 T+1账单审批", ts),
                        )
                else:
                    conn.execute(
                        "UPDATE aftersales_tickets SET stage='keep_partial_refund', stock_disposition='pending', partial_refund_cents=?, bargain_flow_json=?, updated_at=? WHERE ticket_id=?",
                        (partial_refund, json_dumps(bf), ts, tid),
                    )
                    if partial_refund > 0:
                        existing_pr = conn.execute("SELECT entry_id FROM finance_ledger WHERE ticket_id=? AND entry_type='partial_refund'", (tid,)).fetchone()
                        if not existing_pr:
                            conn.execute(
                                "INSERT INTO finance_ledger VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                (f"FIN-PR-{int(time.time()*1000)%1000000}", tid, t["po_id"], t["model_code"], "partial_refund", "卖家退回瑕疵差价（待会计查到账）",
                                 partial_refund, "inflow", None, None, "pending_finance", f"谈妥退差价 ¥{partial_refund/100:.0f} 留货", ts),
                            )
                # Update 10% post-arrival commission estimate (independent from pre-buy 10%, zero double-counting)
                comm_10 = int(round(partial_refund * 0.10))
                if comm_10 > 0:
                    existing_cm = conn.execute("SELECT comm_id FROM commissions WHERE ticket_id=?", (tid,)).fetchone()
                    if existing_cm:
                        conn.execute(
                            "UPDATE commissions SET policy_mode='post_arrival_10_pct', estimated_cents=?, confirmed_cents=?, note=? WHERE comm_id=?",
                            (comm_10, comm_10, f"到货二次议价实际退回/折让 ¥{partial_refund/100:.0f} × 10% = ¥{comm_10/100:.0f}（等会计T+1核销确认发放）", existing_cm["comm_id"]),
                        )
                    else:
                        conn.execute(
                            "INSERT INTO commissions VALUES (?,?,?,?,?,?,?,?,?,?)",
                            (f"COM-{int(time.time()*1000)%100000}", t["owner_id"], t["po_id"], tid, "post_arrival_10_pct", comm_10, 0, "estimated",
                             f"到货二次议价实际退回/折让 ¥{partial_refund/100:.0f} × 10% = ¥{comm_10/100:.0f}（与买前差额独立核算不重算）", ts),
                        )
                log_audit(conn, actor["id"], "谈妥退差价留货", tid, f"谈退 ¥{partial_refund/100:.0f} 留货，转会计查账与仓管入库")
                conn.execute("COMMIT")
                return 200, {"ok": True, "stage": "keep_partial_refund"}

            if path.startswith("/api/aftersales/") and path.endswith("/full-return"):
                tid = path.split("/")[3]
                t = conn.execute("SELECT * FROM aftersales_tickets WHERE ticket_id=?", (tid,)).fetchone()
                if not t:
                    raise ApiError(404, "找不到这笔问题单")
                if not t["platform_return_no"]:
                    raise ApiError(409, "请先在第 2 步填入闲鱼退货申请号，再寄回退货", "RETURN_FIRST_REQUIRED")
                conn.execute(
                    "UPDATE aftersales_tickets SET stage='full_return_shipping', stock_disposition='pending', updated_at=? WHERE ticket_id=?",
                    (ts, tid),
                )
                existing_rf = conn.execute("SELECT entry_id FROM finance_ledger WHERE ticket_id=? AND entry_type='platform_refund'", (tid,)).fetchone()
                if not existing_rf:
                    conn.execute(
                        "INSERT INTO finance_ledger VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (f"FIN-RF-{int(time.time()*1000)%1000000}", tid, t["po_id"], t["model_code"], "platform_refund", "闲鱼全额退货退款（待会计查到账）",
                         t["paid_cents"], "inflow", None, None, "pending_finance", f"按退货单 {t['platform_return_no']} 寄回等退款", ts),
                    )
                log_audit(conn, actor["id"], "谈不拢转全额退货寄回", tid, f"退货单号 {t['platform_return_no']}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "stage": "full_return_shipping"}

            if path == "/api/finance/verify-receipt":
                if actor["role"] not in ("finance", "supervisor"):
                    raise ApiError(403, "管钱和买货要分开：只有【陈会计】或【王主管】能完成 T+1 账单核对与支付宝对公支付审批！", "ROLE_FORBIDDEN")
                entry_id = str(body.get("entry_id") or "")
                receipt_id = str(body.get("receipt_id") or "").strip()
                validate_no_zero_placeholder({"支付宝对公/退款回执单号": receipt_id})
                entry = conn.execute("SELECT * FROM finance_ledger WHERE entry_id=?", (entry_id,)).fetchone()
                if not entry:
                    raise ApiError(404, "找不到这笔资金记录")
                conn.execute("UPDATE finance_ledger SET receipt_id=?, verified_by=?, status='verified' WHERE entry_id=?", (receipt_id, actor["id"], entry_id))
                if entry["ticket_id"] and entry["entry_type"] in ("corp_alipay_payout", "wechat_split"):
                    conn.execute(
                        "UPDATE corp_alipay_registrations SET approval_status='approved_paid', approved_by=?, approved_at=?, alipay_corp_receipt_no=? WHERE ticket_id=?",
                        (actor["id"], ts, receipt_id, entry["ticket_id"]),
                    )
                log_audit(conn, actor["id"], "会计完成T+1账单审批与回执核销", entry_id, f"回执号 {receipt_id}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "entry_id": entry_id, "receipt_id": receipt_id}

            if path.startswith("/api/aftersales/") and path.endswith("/warehouse-dispose"):
                if actor["role"] not in ("warehouse", "supervisor"):
                    raise ApiError(403, "只有【赵仓管】或【王主管】能确认机器入库或寄回状态！", "ROLE_FORBIDDEN")
                tid = path.split("/")[3]
                disp = str(body.get("stock_disposition") or "")
                if disp not in ("restocked_good", "defect_hold", "defect_shelf", "returned_to_seller", "scrapped"):
                    raise ApiError(400, "请选择正确的机器去向")
                t = conn.execute("SELECT * FROM aftersales_tickets WHERE ticket_id=?", (tid,)).fetchone()
                if not t:
                    raise ApiError(404, "找不到这笔问题单")
                if disp == "restocked_good" and t["carrier_intercept_status"] == "requested":
                    raise ApiError(409, "包裹还在顺丰半路拦截中，没拿到机器前严禁点入良品库！", "INTERCEPT_UNCONFIRMED")
                conn.execute("UPDATE aftersales_tickets SET stock_disposition=?, updated_at=? WHERE ticket_id=?", (disp, ts, tid))
                log_audit(conn, actor["id"], "仓管确认机器去向", tid, f"去向：{disp}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "stock_disposition": disp}

            if path.startswith("/api/aftersales/") and path.endswith("/close-ticket"):
                tid = path.split("/")[3]
                t = conn.execute("SELECT * FROM aftersales_tickets WHERE ticket_id=?", (tid,)).fetchone()
                if not t:
                    raise ApiError(404, "找不到这笔问题单")
                pending_fin = conn.execute("SELECT COUNT(*) AS c FROM finance_ledger WHERE ticket_id=? AND status!='verified'", (tid,)).fetchone()["c"]
                if pending_fin > 0:
                    raise ApiError(409, f"钱还没查清：还有 {pending_fin} 笔退款或微信补款没由陈会计核对到账，不能提前关单！", "FINANCE_NOT_CLOSED")
                if t["stock_disposition"] == "pending":
                    raise ApiError(409, "货还没落定：赵仓管还没点机器去向（入良品库 / 放次品架 / 已寄回卖家），不能提前关单！", "STOCK_NOT_CLOSED")
                conn.execute("UPDATE aftersales_tickets SET stage='done', updated_at=? WHERE ticket_id=?", (ts, tid))
                if t["stage"] == "full_return_shipping":
                    conn.execute("UPDATE commissions SET status='reversed', confirmed_cents=0, note=note||'（全额退货冲回）' WHERE po_id=?", (t["po_id"],))
                else:
                    conn.execute("UPDATE commissions SET status='paid', confirmed_cents=estimated_cents WHERE ticket_id=?", (tid,))
                log_audit(conn, actor["id"], "钱货两清正式完结问题单", tid, "已移入【已经完结的】订单")
                conn.execute("COMMIT")
                return 200, {"ok": True, "stage": "done"}

            if path.startswith("/api/commissions/") and path.endswith("/action"):
                if actor["role"] not in ("finance", "supervisor"):
                    raise ApiError(403, "只有【陈会计】或【王主管】能确认发放或冲回提成", "ROLE_FORBIDDEN")
                comm_id = path.split("/")[3]
                act = str(body.get("action") or "")
                c = conn.execute("SELECT * FROM commissions WHERE comm_id=?", (comm_id,)).fetchone()
                if not c:
                    raise ApiError(404, "找不到这笔提成记录")
                if act == "pay":
                    if c["status"] == "reversed":
                        raise ApiError(409, "已退货冲回的提成不能再发放")
                    conn.execute("UPDATE commissions SET status='paid', confirmed_cents=estimated_cents WHERE comm_id=?", (comm_id,))
                    log_audit(conn, actor["id"], "确认发放提成", comm_id, f"发放 ¥{c['estimated_cents']/100:.2f}")
                elif act == "reverse":
                    conn.execute("UPDATE commissions SET status='reversed', confirmed_cents=0, note=? WHERE comm_id=?", (c["note"] + " -> 订单全退已冲回", comm_id))
                    log_audit(conn, actor["id"], "退货冲回提成", comm_id, "订单退款取消，冲回提成")
                else:
                    raise ApiError(400, f"未知操作: {act}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "comm_id": comm_id, "action": act}

            if path == "/api/adspower/launch-copilot":
                user_id = str(body.get("user_id") or "").strip()
                if not user_id:
                    raise ApiError(400, "请先选一个闲鱼窗口")
                ext_dir = os.path.realpath(os.path.join(os.path.dirname(HERE), "AdsPower扩展-采购Copilot"))
                if not os.path.isdir(ext_dir):
                    raise ApiError(404, f"找不到插件目录: {ext_dir}")
                launch_args = json_dumps([f"--load-extension={ext_dir}"])
                qs = urllib.parse.urlencode({"user_id": user_id, "launch_args": launch_args, "open_tabs": 0})
                url = f"http://local.adspower.net:50325/api/v1/browser/start?{qs}"
                try:
                    with urllib.request.urlopen(url, timeout=35) as resp:
                        res_data = json.loads(resp.read().decode("utf-8"))
                except Exception as exc:
                    raise ApiError(502, f"没连上 AdsPower 桌面端（请先打开 AdsPower 软件并登录）: {exc}", "ADSPOWER_UNREACHABLE")
                if res_data.get("code") != 0:
                    raise ApiError(502, f"AdsPower 提示: {res_data.get('msg')}", "ADSPOWER_START_ERR")
                log_audit(conn, actor["id"], "打开带采购助手的闲鱼窗口", user_id, "已挂载悬浮助手启动")
                conn.execute("COMMIT")
                return 200, {"ok": True, "user_id": user_id, "adspower_result": res_data}

            # ---------------- 次日 10:00 前昨日财务对账单 × 采购订单抓全核对闭环 ----------------
            if path == "/api/reconcile/import":
                raw_text = str(body.get("raw_text") or "").strip()
                rows_in = body.get("rows") or []
                batch_row = conn.execute("SELECT * FROM statement_batches ORDER BY created_at DESC LIMIT 1").fetchone()
                batch_id = batch_row["batch_id"] if batch_row else "STMT-20261117"
                if not batch_row:
                    conn.execute(
                        "INSERT INTO statement_batches VALUES (?,?,?,?,?,?,?,?,?)",
                        (batch_id, "昨日财务对账单", actor["id"], "今日 09:40（次日10:00前导入）", "企业支付宝采购专户", "open_diff", None, None, ts),
                    )

                parsed_rows: list[dict[str, Any]] = []
                if isinstance(rows_in, list) and rows_in:
                    for r in rows_in:
                        if isinstance(r, dict):
                            parsed_rows.append(r)
                elif raw_text:
                    for ln in raw_text.splitlines():
                        line = ln.strip()
                        if not line or line.startswith("#") or ("流水号" in line and "金额" in line):
                            continue
                        parts = [p.strip() for p in (line.split("\t") if "\t" in line else line.replace("，", ",").split(","))]
                        if len(parts) < 3:
                            continue
                        tx_no = parts[0]
                        ext_no = parts[1] if len(parts) > 1 and parts[1] else f"GF-ORD-{int(time.time()*1000)%100000}"
                        seller_nm = parts[2] if len(parts) > 2 and parts[2] else "闲鱼卖家"
                        item_t = parts[3] if len(parts) > 3 and parts[3] else f"昨日账单待核商品 {ext_no}"
                        amt_raw = parts[4] if len(parts) > 4 else parts[-1]
                        amt_clean = amt_raw.replace("¥", "").replace("￥", "").replace("元", "").replace("-", "").replace("+", "").strip()
                        try:
                            amt_c = int(round(float(amt_clean) * 100))
                        except ValueError:
                            raise ApiError(400, f"账单金额格式无法识别：{amt_raw}（请填数字金额，如 3280）")
                        tx_tm = parts[5] if len(parts) > 5 and parts[5] else "昨日流水"
                        acc_nm = parts[6] if len(parts) > 6 and parts[6] else "闲鱼主号1"
                        parsed_rows.append({
                            "alipay_tx_no": tx_no,
                            "external_order_no": ext_no,
                            "counterparty_name": seller_nm,
                            "item_title": item_t,
                            "amount_cents": amt_c,
                            "tx_time": tx_tm,
                            "account_id": acc_nm,
                        })

                if not parsed_rows:
                    raise ApiError(400, "请粘贴或上传至少 1 行有效的昨日对账单流水（格式：支付宝流水号, 闲鱼订单号, 卖家昵称, 商品说明, 金额元）")

                imported_cnt = 0
                dedup_cnt = 0
                for idx_r, pr in enumerate(parsed_rows):
                    tx_no = str(pr.get("alipay_tx_no") or "").strip()
                    amt_c = int(pr.get("amount_cents") or 0)
                    if not tx_no or amt_c <= 0:
                        raise ApiError(400, "每行账单必须包含真实的支付宝流水号且金额大于 0")
                    exists = conn.execute("SELECT stmt_item_id FROM statement_items WHERE alipay_tx_no=?", (tx_no,)).fetchone()
                    if exists:
                        dedup_cnt += 1
                        continue
                    sid = f"ST-{int(time.time()*1000)%100000}-{idx_r}"
                    title_s = str(pr.get("item_title") or "昨日财务账单采购商品").strip()
                    conn.execute(
                        "INSERT INTO statement_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            sid,
                            batch_id,
                            tx_no,
                            str(pr.get("external_order_no") or f"GF-ORD-{tx_no[-6:]}").strip(),
                            str(pr.get("account_id") or "闲鱼主号1").strip(),
                            str(pr.get("counterparty_name") or "闲鱼个人卖家").strip(),
                            title_s,
                            str(pr.get("model_guess") or infer_model_from_title(title_s)),
                            amt_c,
                            "outflow",
                            str(pr.get("tx_time") or "昨日流水"),
                            "auto",
                            None,
                            None,
                            "",
                            ts,
                        ),
                    )
                    imported_cnt += 1

                if imported_cnt > 0:
                    conn.execute(
                        "UPDATE statement_batches SET status='open_diff', signed_off_by=NULL, signed_off_at=NULL, uploaded_by=?, uploaded_at_label=? WHERE batch_id=?",
                        (actor["id"], f"今日 {datetime.now().strftime('%H:%M')} 更新导入", batch_id),
                    )
                log_audit(conn, actor["id"], "导入次日10点前昨日财务对账单", batch_id, f"新增 {imported_cnt} 笔，幂等去重跳过 {dedup_cnt} 笔")
                conn.execute("COMMIT")
                return 200, {"ok": True, "batch_id": batch_id, "imported_count": imported_cnt, "deduplicated_count": dedup_cnt}

            if path == "/api/reconcile/backfill":
                backfill_all = bool(body.get("backfill_all", False))
                target_stmt_id = str(body.get("stmt_item_id") or "").strip()
                orders_now = [dict(r) for r in conn.execute("SELECT * FROM orders")]
                po_receipts = {o["payment_receipt_no"] for o in orders_now if o.get("payment_receipt_no")}
                po_exts = {o["external_order_no"] for o in orders_now if o.get("external_order_no")}

                if backfill_all:
                    cand_rows = [dict(r) for r in conn.execute("SELECT * FROM statement_items WHERE resolution_state!='ignored_non_po' ORDER BY stmt_item_id ASC")]
                    targets = [r for r in cand_rows if r["alipay_tx_no"] not in po_receipts and r["external_order_no"] not in po_exts]
                else:
                    if not target_stmt_id:
                        raise ApiError(400, "请指定要补抓的对账单明细编号 stmt_item_id")
                    one = conn.execute("SELECT * FROM statement_items WHERE stmt_item_id=?", (target_stmt_id,)).fetchone()
                    if not one:
                        raise ApiError(404, f"找不到这条对账单记录: {target_stmt_id}")
                    one_d = dict(one)
                    if one_d["alipay_tx_no"] in po_receipts or one_d["external_order_no"] in po_exts:
                        conn.rollback()
                        return 200, {"ok": True, "already_captured": True, "message": "该笔账单已有对应采购单，无需重复补抓"}
                    targets = [one_d]

                if not targets:
                    conn.rollback()
                    return 200, {"ok": True, "backfilled_count": 0, "message": "当前没有需要补抓的漏单"}

                created_cases: list[str] = []
                for idx_t, st_it in enumerate(targets):
                    amt_c = int(st_it["amount_cents"])
                    po_id = f"PO-BF-{int(time.time()*1000)%100000}-{idx_t}"
                    case_id = f"CASE-BF{int(time.time()*1000)%10000:04d}{idx_t}"
                    snap_id = f"SNAP-{po_id}-V1"
                    snap_obj = {
                        "snapshot_id": snap_id,
                        "snapshot_version": 1,
                        "captured_at": ts,
                        "seller_title": st_it["item_title"],
                        "seller_declaration": f"【次日10点财务对账补抓单】账单流水 {st_it['alipay_tx_no']}，请采购尽快补传闲鱼原链接截图",
                        "source_type": "财务昨日账单防漏补抓",
                    }
                    conn.execute(
                        "INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            po_id, st_it["external_order_no"], None, st_it["model_guess"], st_it["item_title"],
                            st_it["counterparty_name"], "manual_paid", amt_c, amt_c, snap_id, 1, json_dumps(snap_obj),
                            st_it["alipay_tx_no"], None, None, "stmt_backfill", '["tracking_no","item_photos"]', 4,
                            f"bf-{st_it['alipay_tx_no']}", ts, ts,
                        ),
                    )
                    conn.execute(
                        "INSERT INTO procurement_cases VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            case_id, "账单补抓", f"【昨日账单补抓】{st_it['item_title']}",
                            "数码设备", "账单防漏补抓", st_it["model_guess"], "待补快照 · 重点验机", "闲鱼", "次日10点账单补抓",
                            st_it["account_id"], st_it["counterparty_name"], "liming", "./evidence/IMG_5878.PNG", "账单补抓待核图",
                            None, None, po_id, None, None, None,
                            make_capture(
                                "ok", f"财务次日10点前昨日对账单核出漏抓并补建（实付 ¥{amt_c/100:.0f}，支付宝单号 {st_it['alipay_tx_no']}）",
                                "partial", "请经办采购员尽快补齐闲鱼原始页面截图留证",
                                "partial", "待到货赵仓管一镜到底核验序列号",
                                "ok", f"企业支付宝账单已核实扣款 ¥{amt_c/100:.0f}",
                            ),
                            "pending", "⚠️ 昨日财务账单补抓单：包裹派送时请赵仓管 10 分钟内重点严查成色与配件！", "调整",
                            "由次日10:00前财务昨日对账单自动防漏补抓入库", ts,
                            make_prebuy_eval(
                                True, True, True, False, True,
                                ["强光查屏幕划痕/亮斑坏点", "查机身磕碰与原装配件齐全"],
                                "【财务对账补抓单·重点深检】昨日拍下漏同步订单，到仓请赵仓管一镜到底重点查验！",
                            ),
                        ),
                    )
                    for sno, sname in [(1, "寻源摸底"), (2, "价格核验"), (3, "实操取证"), (4, "结算核销"), (5, "复盘沉淀")]:
                        conn.execute(
                            "INSERT INTO case_governance_stages VALUES (?,?,?,?,?,?,?,?,?)",
                            (case_id, sno, sname, "done" if sno <= 2 else ("doing" if sno == 3 else "todo"), 1 if sno <= 3 else 0, "财务账单补抓建档" if sno <= 2 else "", "liming" if sno <= 2 else None, "通过" if sno <= 2 else "", ts),
                        )
                    conn.execute(
                        "INSERT INTO finance_ledger VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            f"FIN-BF-{int(time.time()*1000)%100000}-{idx_t}", None, po_id, st_it["model_guess"],
                            "po_payment", "昨日支付宝对账单补抓实付", amt_c, "outflow", st_it["alipay_tx_no"],
                            "chenkj", "verified", f"次日10点前昨日财务账单核对补抓入账（闲鱼单号 {st_it['external_order_no']}）", ts,
                        ),
                    )
                    conn.execute("UPDATE quota_pool SET spent_cents = spent_cents + ?, updated_at=? WHERE pool_id='POOL-202611'", (amt_c, ts))
                    conn.execute(
                        "UPDATE statement_items SET resolution_state='backfilled', resolved_po_id=?, resolved_case_id=?, resolution_note=?, updated_at=? WHERE stmt_item_id=?",
                        (po_id, case_id, f"已一键补抓生成采购单 {case_id}", ts, st_it["stmt_item_id"]),
                    )
                    created_cases.append(case_id)

                log_audit(conn, actor["id"], "昨日对账单漏单一键补抓", ",".join(created_cases), f"成功补抓 {len(created_cases)} 笔漏单进采购订单库")
                conn.execute("COMMIT")
                return 200, {"ok": True, "backfilled_count": len(created_cases), "created_case_ids": created_cases}

            if path == "/api/reconcile/resolve-diff":
                stmt_item_id = str(body.get("stmt_item_id") or "").strip()
                action = str(body.get("action") or "sync_to_statement").strip()
                note = str(body.get("note") or "").strip()
                st_it = conn.execute("SELECT * FROM statement_items WHERE stmt_item_id=?", (stmt_item_id,)).fetchone()
                if not st_it:
                    raise ApiError(404, f"找不到这条对账单记录: {stmt_item_id}")

                if action == "ignore_non_po":
                    validate_no_zero_placeholder({"非采购支出说明": note})
                    if len(note) < 4:
                        raise ApiError(400, "排除非采购支出时，请至少写 4 个字说明用途（如『仓库顺丰包材月结费』）")
                    conn.execute(
                        "UPDATE statement_items SET resolution_state='ignored_non_po', resolution_note=?, updated_at=? WHERE stmt_item_id=?",
                        (note, ts, stmt_item_id),
                    )
                    log_audit(conn, actor["id"], "标记账单流水为非采购支出", stmt_item_id, note)
                    conn.execute("COMMIT")
                    return 200, {"ok": True, "stmt_item_id": stmt_item_id, "resolution_state": "ignored_non_po"}

                if action == "sync_to_statement":
                    po = conn.execute(
                        "SELECT * FROM orders WHERE payment_receipt_no=? OR external_order_no=?",
                        (st_it["alipay_tx_no"], st_it["external_order_no"]),
                    ).fetchone()
                    if not po:
                        raise ApiError(404, "系统尚未找到关联采购单，请先使用『一键补抓』创建订单")
                    old_paid = int(po["paid_cents"] or po["agreed_cents"] or 0)
                    real_amt = int(st_it["amount_cents"])
                    delta = real_amt - old_paid
                    fix_note = note or f"按财务次日10点昨日对账单实扣金额核平（差额 {'+' if delta >= 0 else ''}¥{delta/100:.2f} 顺丰保价/运费）"
                    conn.execute("UPDATE orders SET paid_cents=?, updated_at=? WHERE po_id=?", (real_amt, ts, po["po_id"]))
                    led_row = conn.execute("SELECT entry_id FROM finance_ledger WHERE po_id=? AND entry_type='po_payment'", (po["po_id"],)).fetchone()
                    if led_row:
                        conn.execute("UPDATE finance_ledger SET amount_cents=?, status='verified', note=? WHERE entry_id=?", (real_amt, fix_note, led_row["entry_id"]))
                    else:
                        conn.execute(
                            "INSERT INTO finance_ledger VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (f"FIN-FIX-{int(time.time()*1000)%100000}", None, po["po_id"], po["model_code"], "po_payment", "实付货款(对账单核平)", real_amt, "outflow", st_it["alipay_tx_no"], actor["id"], "verified", fix_note, ts),
                        )
                    if delta != 0:
                        conn.execute("UPDATE quota_pool SET spent_cents = MAX(0, spent_cents + ?), updated_at=? WHERE pool_id='POOL-202611'", (delta, ts))
                    conn.execute(
                        "UPDATE statement_items SET resolution_state='amount_adjusted', resolved_po_id=?, resolution_note=?, updated_at=? WHERE stmt_item_id=?",
                        (po["po_id"], fix_note, ts, stmt_item_id),
                    )
                    log_audit(conn, actor["id"], "按昨日财务账单核平订单实付差额", po["po_id"], f"¥{old_paid/100:.2f} -> ¥{real_amt/100:.2f} ({fix_note})")
                    conn.execute("COMMIT")
                    return 200, {"ok": True, "po_id": po["po_id"], "new_paid_cents": real_amt}

                raise ApiError(400, f"不支持的对账处理动作: {action}")

            if path == "/api/reconcile/signoff":
                orders_now = [dict(r) for r in conn.execute("SELECT * FROM orders")]
                raw_cases_now = [dict(r) for r in conn.execute("SELECT * FROM procurement_cases")]
                rec_check = build_statement_reconciliation(conn, orders_now, raw_cases_now)
                sm = rec_check["summary"]
                if sm["missing_count"] > 0 or sm["amount_diff_count"] > 0:
                    raise ApiError(
                        409,
                        f"对账未清零拦截：昨日财务对账单还有 {sm['missing_count']} 笔漏抓订单、{sm['amount_diff_count']} 笔金额差额没处理完，严禁提前签字确认抓全！",
                        "UNRESOLVED_STATEMENT_DIFFS",
                    )
                batch_id = rec_check["batch"]["batch_id"]
                conn.execute(
                    "UPDATE statement_batches SET status='all_reconciled', signed_off_by=?, signed_off_at=? WHERE batch_id=?",
                    (actor["name"], f"今日 {datetime.now().strftime('%H:%M')}", batch_id),
                )
                log_audit(conn, actor["id"], "完成次日10点昨日账单100%抓全签字确认", batch_id, f"共核对 {sm['total_count']} 笔流水零漏单零差额")
                conn.execute("COMMIT")
                return 200, {"ok": True, "batch_id": batch_id, "status": "all_reconciled"}

            # ---------------- 5% 退款率 & 纠纷率防红标风控与反扯皮/反介入闭环 ----------------
            if path.startswith("/api/cases/") and path.endswith("/switch-safe-account"):
                case_id = path.split("/")[3]
                crow = conn.execute("SELECT * FROM procurement_cases WHERE case_id=?", (case_id,)).fetchone()
                if not crow:
                    raise ApiError(404, f"找不到这笔采购单: {case_id}")
                target_acct = str(body.get("target_account_id") or "闲鱼3号").strip()
                acct_row = conn.execute("SELECT * FROM account_risk_stats WHERE account_id=?", (target_acct,)).fetchone()
                if not acct_row:
                    raise ApiError(404, f"找不到目标闲鱼账号: {target_acct}")
                old_acct = crow["account_id"]
                conn.execute("UPDATE procurement_cases SET account_id=?, updated_at=? WHERE case_id=?", (target_acct, ts, case_id))
                if crow["conv_id"]:
                    conn.execute("UPDATE conversations SET account_id=?, updated_at=? WHERE conv_id=?", (target_acct, ts, crow["conv_id"]))
                log_audit(conn, actor["id"], "买前防5%红标切换安全采购号", case_id, f"{old_acct} -> {target_acct}（保护高退款率账号不破5%红线）")
                conn.execute("COMMIT")
                return 200, {"ok": True, "case_id": case_id, "old_account_id": old_acct, "new_account_id": target_acct}

            if path.startswith("/api/aftersales/") and path.endswith("/request-intervention"):
                tid = path.split("/")[3]
                t = conn.execute("SELECT * FROM aftersales_tickets WHERE ticket_id=?", (tid,)).fetchone()
                if not t:
                    raise ApiError(404, "找不到这笔问题单")
                severe_fraud = bool(body.get("severe_fraud_confirmed", False))
                reason = str(body.get("reason") or "").strip()
                force_override = bool(body.get("force_override", False))

                if actor["role"] != "supervisor" or not severe_fraud:
                    raise ApiError(
                        409,
                        "🚫 5% 纠纷率防红标硬锁：公司铁律「非不必要，绝不扯皮或申请小二介入」（纠纷率或退款率超 5% 平台必弹红标）！一般成色/配件分歧请走『零退款率留货』或『痛快和平退回』；仅遇假货/空包诈骗且沟通无效时，由【王主管】核实特批介入！",
                        "DISPUTE_INTERVENTION_FORBIDDEN",
                    )
                validate_no_zero_placeholder({"恶意诈骗/假货特批介入原因": reason})

                crow = conn.execute("SELECT account_id FROM procurement_cases WHERE ticket_id=?", (tid,)).fetchone()
                acct_id = crow["account_id"] if crow else "闲鱼主号1"
                acct_row = conn.execute("SELECT * FROM account_risk_stats WHERE account_id=?", (acct_id,)).fetchone()
                if acct_row:
                    ords = max(1, int(acct_row["rolling_30d_orders"]))
                    next_disp_pct = round((int(acct_row["rolling_30d_disputes"]) + 1) * 100.0 / ords, 2)
                    if next_disp_pct > float(acct_row["redline_pct"] or 5.0) and not force_override:
                        raise ApiError(
                            409,
                            f"🚨 5% 红标熔断拦截：【{acct_id}】申请本次介入后近30天纠纷率将升至 {next_disp_pct}%（超过 5.0% 红标线）！请优先私下止损或由主管显式强制熔断豁免。",
                            "ACCOUNT_5PCT_REDLINE_EXCEEDED",
                        )
                    conn.execute(
                        "UPDATE account_risk_stats SET rolling_30d_disputes = rolling_30d_disputes + 1, updated_at=? WHERE account_id=?",
                        (ts, acct_id),
                    )
                bf = json.loads(t["bargain_flow_json"] or "{}")
                bf["platform_intervention_approved"] = True
                bf["platform_intervention_reason"] = reason
                conn.execute("UPDATE aftersales_tickets SET bargain_flow_json=?, updated_at=? WHERE ticket_id=?", (json_dumps(bf), ts, tid))
                log_audit(conn, actor["id"], "主管特批重大诈骗单平台介入", tid, f"账号 {acct_id} · 原因: {reason}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "ticket_id": tid, "account_id": acct_id, "approved_by": actor["name"]}

            if path.startswith("/api/aftersales/") and path.endswith("/zero-refund-keep"):
                tid = path.split("/")[3]
                t = conn.execute("SELECT * FROM aftersales_tickets WHERE ticket_id=?", (tid,)).fetchone()
                if not t:
                    raise ApiError(404, "找不到这笔问题单")
                private_comp_cents = max(0, int(body.get("private_comp_cents") or 0))
                note = str(body.get("note") or "原单照常确认收货不走平台退款（0%退款率占用·0%纠纷率），避免逼近5%红标线").strip()
                bf = json.loads(t["bargain_flow_json"] or "{}")
                bf["step1_triage_done"] = True
                bf["zero_refund_rate_protected"] = True
                bf["settle_mode"] = "zero_refund_direct_keep"
                bf["private_comp_cents"] = private_comp_cents
                bf["disclosure_complete"] = True
                new_keep_cost = max(0, int(t["paid_cents"]) - private_comp_cents)
                conn.execute(
                    "UPDATE aftersales_tickets SET stage='keep_agreed', partial_refund_cents=?, k_keep_cost_cents=?, bargain_flow_json=?, updated_at=? WHERE ticket_id=?",
                    (private_comp_cents, new_keep_cost, json_dumps(bf), ts, tid),
                )
                if private_comp_cents > 0:
                    comm_c = int(round(private_comp_cents * 0.10))
                    conn.execute(
                        "INSERT OR REPLACE INTO commissions VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (
                            f"COMM-ZR-{tid}",
                            actor["id"],
                            t["po_id"],
                            tid,
                            "post_arrival_10pct",
                            comm_c,
                            0,
                            "estimated",
                            f"零退款率保号留货：卖家直补差价 ¥{private_comp_cents/100:.0f} × 10%（不占平台5%退款率额度）",
                            ts,
                        ),
                    )
                    conn.execute(
                        "INSERT INTO finance_ledger VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            f"FIN-ZR-{int(time.time()*1000)%100000}",
                            tid,
                            t["po_id"],
                            t["model_code"],
                            "partial_refund",
                            "零退款率保号直补回款",
                            private_comp_cents,
                            "inflow",
                            None,
                            None,
                            "pending_finance",
                            note,
                            ts,
                        ),
                    )
                log_audit(conn, actor["id"], "启用零退款率保号留货（严控5%红标线）", tid, f"直补 ¥{private_comp_cents/100:.0f} · {note[:40]}")
                conn.execute("COMMIT")
                return 200, {"ok": True, "ticket_id": tid, "zero_refund_rate_protected": True, "private_comp_cents": private_comp_cents}

            raise ApiError(404, f"未知接口: {path}")

        except ApiError as e:
            try:
                conn.rollback()
            except Exception:
                pass
            return e.status, {"ok": False, "code": e.code, "error": e.message}
        except Exception as e:
            try:
                conn.rollback()
            except Exception:
                pass
            return 500, {"ok": False, "code": "INTERNAL_ERROR", "error": str(e)}
        finally:
            conn.close()


def get_adspower_status() -> dict[str, Any]:
    root_dir = os.path.dirname(HERE)
    ext_dir = os.path.join(root_dir, "AdsPower扩展-采购Copilot")
    zip_path = os.path.join(root_dir, "采购Copilot-AdsPower插件.zip")
    info: dict[str, Any] = {
        "local_api_connected": False,
        "profiles": [],
        "ext_dir": ext_dir,
        "zip_path": zip_path,
        "ext_ready": os.path.isfile(os.path.join(ext_dir, "manifest.json")),
        "zip_ready": os.path.isfile(zip_path),
    }
    try:
        with urllib.request.urlopen("http://local.adspower.net:50325/status", timeout=2) as r:
            st = json.loads(r.read().decode("utf-8"))
        if st.get("code") == 0:
            info["local_api_connected"] = True
            with urllib.request.urlopen("http://local.adspower.net:50325/api/v1/user/list?page=1&page_size=50", timeout=3) as ur:
                ul = json.loads(ur.read().decode("utf-8"))
            raw_profiles = [
                {
                    "user_id": x.get("user_id"),
                    "serial_number": x.get("serial_number"),
                    "name": x.get("name"),
                    "group_name": x.get("group_name") or "未分组",
                }
                for x in ul.get("data", {}).get("list", [])
            ]
            raw_profiles.sort(
                key=lambda p: (
                    0 if p["group_name"] == "采购" or "采购" in (p["name"] or "") else 1,
                    -int(p["serial_number"]) if str(p.get("serial_number") or "").isdigit() else 0,
                )
            )
            info["profiles"] = raw_profiles
    except Exception as exc:
        info["error"] = str(exc)
    return info


def fetch_executor_jobs(query_str: str = "") -> dict[str, Any]:
    qs = urllib.parse.parse_qs(query_str)
    win_filter = (qs.get("window_id") or [""])[0].strip()
    st_filter = (qs.get("status") or [""])[0].strip()
    with DB_LOCK:
        conn = get_conn()
        try:
            sql = "SELECT * FROM executor_jobs WHERE 1=1"
            params: list[Any] = []
            if win_filter:
                sql += " AND window_id=?"
                params.append(win_filter)
            if st_filter:
                sql += " AND status=?"
                params.append(st_filter)
            sql += " ORDER BY updated_at DESC LIMIT 50"
            rows = [dict(r) for r in conn.execute(sql, params)]
            for r in rows:
                r["payload"] = json.loads(r.get("payload_json") or "{}")
            return {"ok": True, "jobs": rows, "count": len(rows)}
        finally:
            conn.close()


class ProcurementRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:
        return

    def _send_json(self, status: int, payload: Any) -> None:
        raw = json_dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:
        self._send_json(HTTPStatus.NO_CONTENT, {})

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        p = parsed.path
        if p == "/api/health":
            self._send_json(200, {"ok": True, "service": "procurement-workbench-v3", "db": os.path.basename(DB_PATH), "time": now_iso()})
            return
        if p == "/api/dashboard":
            self._send_json(200, {"ok": True, "data": fetch_dashboard()})
            return
        if p == "/api/cases":
            dash = fetch_dashboard()
            self._send_json(200, {"ok": True, "cases": dash["cases"]})
            return
        if p.startswith("/api/cases/"):
            cid = urllib.parse.unquote(p.split("/")[3])
            st, resp = fetch_single_case(cid)
            self._send_json(st, resp)
            return
        if p == "/api/executor/jobs":
            self._send_json(200, fetch_executor_jobs(parsed.query))
            return
        if p == "/api/adspower/status":
            self._send_json(200, {"ok": True, "adspower": get_adspower_status()})
            return
        self._send_json(404, {"ok": False, "error": f"Unknown GET endpoint: {p}"})

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            self._send_json(400, {"ok": False, "error": "Invalid JSON body"})
            return
        status, resp = handle_api_post(parsed.path, body)
        self._send_json(status, resp)


def run_server(port: int = 5361) -> None:
    init_db()
    srv = ThreadingHTTPServer(("127.0.0.1", port), ProcurementRequestHandler)
    print(f"[procurement_server] Listening on http://127.0.0.1:{port}")
    srv.serve_forever()


if __name__ == "__main__":
    run_server(int(os.environ.get("API_PORT", "5361")))

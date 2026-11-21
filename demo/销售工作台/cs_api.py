#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
销售工作台 · 并入外部客服工作台 V3 API 模块 (2026-11-21)
零第三方依赖：SQLite (WAL) + 服务端 RBAC 物理脱敏网关 + 外发守卫校验 + 不可篡改审计流水。
统一挂载于销售工作台 h5_server.py (/cs-build.txt & /api/cs/*)。
"""
from __future__ import annotations

import copy
import datetime
import json
import os
import re
import sqlite3
import threading
from urllib.parse import unquote, urlparse

RELEASE_ID = "cs-workbench-merged-sales-20261121-v3"
RUNTIME_DIR = os.environ.get(
    "CS_RUNTIME_DIR",
    os.path.expanduser("~/Library/Caches/panasia-gallery-stitch-20261113"),
)
os.makedirs(RUNTIME_DIR, exist_ok=True)
DB_PATH = os.path.join(RUNTIME_DIR, "cs_workbench.sqlite")

OUTSOURCE_ACTORS = {"outsource_lu", "outsource_zhang", "outsource_wang", "newbie"}
DB_LOCK = threading.Lock()


def _init_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS cs_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            version TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            actor TEXT NOT NULL,
            payload TEXT NOT NULL
        );
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS cs_audit_log (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            actor TEXT NOT NULL,
            action TEXT NOT NULL,
            summary TEXT NOT NULL
        );
        """
    )
    return conn


CONN = _init_conn()


def desensitize_for_actor(state_obj: dict | None, actor_id: str) -> dict | None:
    """对外包客服角色物理剥离采购成本 costPrice 与上游卖家 supplierNick。"""
    if not state_obj:
        return None
    if actor_id not in OUTSOURCE_ACTORS:
        return state_obj
    safe = copy.deepcopy(state_obj)
    for sku in safe.get("skus", []):
        sku.pop("costPrice", None)
        sku.pop("supplierNick", None)
    return safe


def validate_outbound_text(text: str) -> tuple[bool, str]:
    """服务端二次外发守卫校验，防止绕过前端直调接口。"""
    t = (text or "").strip()
    if not t:
        return True, ""
    if re.fullmatch(r"[1。，.,?？~～!！]", t):
        return False, "服务端拦截：禁止发送无意义单字符刷尾响闭环率"
    if re.search(r"\b1[3-9]\d{9}\b", t):
        return False, "服务端拦截：严禁向外发送 11 位手机号码（防站外引流封店）"
    if re.search(r"(微信|vx|v信|wx|薇信|加我|私下转)", t, re.I) and not re.search(
        r"(不能|不要|平台规定|不加|无法)", t
    ):
        return False, "服务端拦截：命中站外引流敏感词"
    return True, ""


def preserve_internal_secrets(incoming_state: dict, prev_state: dict | None) -> dict:
    """当外包角色提交前端状态同步时，自动回填服务端保存的真实 costPrice 与 supplierNick，防止脱敏副本覆盖底表。"""
    if not prev_state or not incoming_state:
        return incoming_state
    secret_map = {
        s.get("skuCode"): (s.get("costPrice"), s.get("supplierNick"))
        for s in prev_state.get("skus", [])
        if s.get("skuCode")
    }
    merged = copy.deepcopy(incoming_state)
    for sku in merged.get("skus", []):
        code = sku.get("skuCode")
        if code in secret_map:
            cost_val, sup_val = secret_map[code]
            if "costPrice" not in sku and cost_val is not None:
                sku["costPrice"] = cost_val
            if "supplierNick" not in sku and sup_val is not None:
                sku["supplierNick"] = sup_val
    return merged


def _json_resp(code: int, obj: dict) -> tuple[int, str, bytes]:
    return code, "application/json; charset=utf-8", json.dumps(obj, ensure_ascii=False).encode("utf-8")


def _text_resp(code: int, text: str) -> tuple[int, str, bytes]:
    return code, "text/plain; charset=utf-8", text.encode("utf-8")


def handle_cs_request(
    method: str, raw_path: str, headers, body_bytes: bytes = b""
) -> tuple[int, str, bytes] | None:
    """处理 /cs-build.txt 与 /api/cs/* 请求；非客服路由返回 None。"""
    parsed = urlparse(raw_path)
    path = unquote(parsed.path)
    if path != "/cs-build.txt" and not path.startswith("/api/cs/"):
        return None

    actor_id = (headers.get("X-CS-Actor") if headers else None) or "outsource_lu"

    if method == "GET":
        if path == "/cs-build.txt":
            return _text_resp(200, RELEASE_ID)
        if path == "/api/cs/health":
            with DB_LOCK:
                audit_count = CONN.execute("SELECT COUNT(*) FROM cs_audit_log").fetchone()[0]
            return _json_resp(
                200,
                {
                    "ok": True,
                    "release": RELEASE_ID,
                    "mergedInto": "sales-workbench",
                    "db": DB_PATH,
                    "auditCount": audit_count,
                },
            )
        if path == "/api/cs/state":
            with DB_LOCK:
                row = CONN.execute(
                    "SELECT version, updated_at, actor, payload FROM cs_state WHERE id = 1"
                ).fetchone()
                logs = [
                    {
                        "seq": r[0],
                        "createdAt": r[1],
                        "actor": r[2],
                        "action": r[3],
                        "summary": r[4],
                    }
                    for r in CONN.execute(
                        "SELECT seq, created_at, actor, action, summary FROM cs_audit_log ORDER BY seq DESC LIMIT 50"
                    ).fetchall()
                ]
            if not row:
                return _json_resp(200, {"ok": True, "data": None, "logs": logs})
            raw_state = json.loads(row[3])
            safe_state = desensitize_for_actor(raw_state, actor_id)
            return _json_resp(
                200,
                {
                    "ok": True,
                    "version": row[0],
                    "updatedAt": row[1],
                    "actor": row[2],
                    "data": safe_state,
                    "logs": logs,
                },
            )
        return _json_resp(404, {"ok": False, "error": "Unknown GET /api/cs endpoint"})

    if method == "POST":
        raw_body = body_bytes or b"{}"
        try:
            body = json.loads(raw_body.decode("utf-8"))
        except Exception:
            return _json_resp(400, {"ok": False, "error": "Invalid JSON"})

        now_str = datetime.datetime.now().strftime("%H:%M:%S")

        if path == "/api/cs/guard-check":
            ok, err = validate_outbound_text(body.get("text", ""))
            if not ok:
                return _json_resp(400, {"ok": False, "error": err})
            return _json_resp(200, {"ok": True})

        if path == "/api/cs/reset":
            with DB_LOCK:
                CONN.execute("DELETE FROM cs_state WHERE id = 1")
                CONN.execute(
                    "INSERT INTO cs_audit_log (created_at, actor, action, summary) VALUES (?, ?, ?, ?)",
                    (now_str, actor_id, "reset_demo", "重置全站演示数据回初始基线"),
                )
                CONN.commit()
            return _json_resp(200, {"ok": True})

        if path == "/api/cs/sync":
            action = str(body.get("action") or "sync")
            summary = str(body.get("summary") or "状态更新")
            actor_label = str(body.get("actor") or actor_id)
            incoming_state = body.get("state")
            if not isinstance(incoming_state, dict):
                return _json_resp(400, {"ok": False, "error": "Missing state object"})

            with DB_LOCK:
                prev_row = CONN.execute("SELECT payload FROM cs_state WHERE id = 1").fetchone()
                prev_state = json.loads(prev_row[0]) if prev_row else None
                merged_state = preserve_internal_secrets(incoming_state, prev_state)
                ver = str(merged_state.get("version") or RELEASE_ID)
                CONN.execute(
                    """
                    INSERT INTO cs_state (id, version, updated_at, actor, payload)
                    VALUES (1, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        version = excluded.version,
                        updated_at = excluded.updated_at,
                        actor = excluded.actor,
                        payload = excluded.payload;
                    """,
                    (ver, now_str, actor_label, json.dumps(merged_state, ensure_ascii=False)),
                )
                CONN.execute(
                    "INSERT INTO cs_audit_log (created_at, actor, action, summary) VALUES (?, ?, ?, ?)",
                    (now_str, actor_label, action, summary),
                )
                CONN.commit()
            return _json_resp(200, {"ok": True, "updatedAt": now_str})

        return _json_resp(404, {"ok": False, "error": "Unknown POST /api/cs endpoint"})

    return _json_resp(405, {"ok": False, "error": "Method not allowed"})

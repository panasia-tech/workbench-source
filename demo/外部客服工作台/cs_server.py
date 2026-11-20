#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
泛亚外包客服工作台 · C端桌面版 H5 服务端 (2026-11-16)
零第三方依赖：Python 3.12 标准库 ThreadingHTTPServer + SQLite (WAL)
核心后端门禁：
  1. 服务端 RBAC 脱敏网关：当请求者为外包角色 (outsource_* / newbie) 时，物理剥离 costPrice 与 supplierNick；
  2. 服务端外发守卫校验：拦截站外微信号/手机号/单字符刷尾响；
  3. SQLite WAL 状态机持久化与不可篡改审计流水。
"""
from __future__ import annotations

import copy
import datetime
import json
import mimetypes
import os
import re
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

RELEASE_ID = "cs-workbench-desktop-20261116-v1"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DIST_DIR = os.path.join(BASE_DIR, "dist")
RUNTIME_DIR = os.environ.get(
    "CS_RUNTIME_DIR",
    os.path.join(BASE_DIR, ".demo-runtime"),
)
os.makedirs(RUNTIME_DIR, exist_ok=True)
DB_PATH = os.path.join(RUNTIME_DIR, "cs_workbench.sqlite")

OUTSOURCE_ACTORS = {"outsource_lu", "outsource_zhang", "outsource_wang", "newbie"}
DB_LOCK = threading.Lock()


def get_conn():
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


CONN = get_conn()


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


class CsWorkbenchHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def _send_json(self, code: int, obj: dict):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _send_text(self, code: int, text: str, ctype: str = "text/plain; charset=utf-8"):
        raw = text.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        actor_id = self.headers.get("X-CS-Actor", "outsource_lu")

        if path == "/cs-build.txt":
            return self._send_text(200, RELEASE_ID)

        if path == "/api/cs/health":
            with DB_LOCK:
                audit_count = CONN.execute("SELECT COUNT(*) FROM cs_audit_log").fetchone()[0]
            return self._send_json(
                200,
                {
                    "ok": True,
                    "release": RELEASE_ID,
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
                return self._send_json(200, {"ok": True, "data": None, "logs": logs})
            raw_state = json.loads(row[3])
            safe_state = desensitize_for_actor(raw_state, actor_id)
            return self._send_json(
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

        # Serve static assets from dist/
        rel = path.lstrip("/") or "index.html"
        full_path = os.path.normpath(os.path.join(DIST_DIR, rel))
        if not full_path.startswith(DIST_DIR) or not os.path.isfile(full_path):
            full_path = os.path.join(DIST_DIR, "index.html")
        if not os.path.isfile(full_path):
            return self._send_json(404, {"ok": False, "error": "dist not built"})

        ctype, _ = mimetypes.guess_type(full_path)
        with open(full_path, "rb") as f:
            content = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        actor_id = self.headers.get("X-CS-Actor", "outsource_lu")
        length = int(self.headers.get("Content-Length", "0") or "0")
        raw_body = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw_body.decode("utf-8"))
        except Exception:
            return self._send_json(400, {"ok": False, "error": "Invalid JSON"})

        now_str = datetime.datetime.now().strftime("%H:%M:%S")

        if path == "/api/cs/guard-check":
            ok, err = validate_outbound_text(body.get("text", ""))
            if not ok:
                return self._send_json(400, {"ok": False, "error": err})
            return self._send_json(200, {"ok": True})

        if path == "/api/cs/reset":
            with DB_LOCK:
                CONN.execute("DELETE FROM cs_state WHERE id = 1")
                CONN.execute(
                    "INSERT INTO cs_audit_log (created_at, actor, action, summary) VALUES (?, ?, ?, ?)",
                    (now_str, actor_id, "reset_demo", "重置全站演示数据回初始基线"),
                )
                CONN.commit()
            return self._send_json(200, {"ok": True})

        if path == "/api/cs/sync":
            action = str(body.get("action") or "sync")
            summary = str(body.get("summary") or "状态更新")
            actor_label = str(body.get("actor") or actor_id)
            incoming_state = body.get("state")
            if not isinstance(incoming_state, dict):
                return self._send_json(400, {"ok": False, "error": "Missing state object"})

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
            return self._send_json(200, {"ok": True, "updatedAt": now_str})

        return self._send_json(404, {"ok": False, "error": "Unknown endpoint"})


def run_server():
    port = int(os.environ.get("H5_PORT", "5380"))
    server = ThreadingHTTPServer(("127.0.0.1", port), CsWorkbenchHandler)
    print(f"泛亚外包客服工作台(桌面版)已启动: http://127.0.0.1:{port} (SQLite: {DB_PATH})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    run_server()

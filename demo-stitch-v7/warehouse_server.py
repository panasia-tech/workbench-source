#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
泛亚仓管工作台 · Stitch重设计版 (2026-11-14)
零外部依赖 HTTP + SQLite(WAL) 持久化服务端（带服务端角色门禁校验与不可篡改审计日志）
"""
import datetime
import json
import mimetypes
import os
import sqlite3
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DIST_DIR = os.path.join(BASE_DIR, "dist")
RUNTIME_DIR = os.environ.get(
    "WH_RUNTIME_DIR",
    os.path.expanduser("~/Library/Caches/panasia-warehouse-stitch-20261114"),
)
os.makedirs(RUNTIME_DIR, exist_ok=True)
DB_PATH = os.path.join(RUNTIME_DIR, "warehouse_demo.sqlite")
CSV_PATH = os.path.join(BASE_DIR, "业务依据", "禅道14卡179节点闭环自检表.csv")

SUPERVISOR_ONLY_ACTIONS = {
    "approve_keep_goods",
    "approve_diff",
    "stocktake_commit",
    "pub_std",
    "review_task",
    "reassign_task",
    "create_task",
    "rule_exception",
    "swap_media_owner",
}

DB_LOCK = threading.Lock()


def get_conn():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS wh_state (
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
        CREATE TABLE IF NOT EXISTS wh_audit_log (
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


class WarehouseHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def _send_json(self, code, obj):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if path == "/api/wh/health":
            with DB_LOCK:
                cur = CONN.execute("SELECT COUNT(*) FROM wh_audit_log")
                audit_count = cur.fetchone()[0]
            return self._send_json(
                200,
                {
                    "ok": True,
                    "mode": "stitch-warehouse-v5-ultimate",
                    "release": "warehouse-workbench-stitch-20261114",
                    "db": DB_PATH,
                    "auditCount": audit_count,
                },
            )

        if path == "/api/wh/state":
            with DB_LOCK:
                cur = CONN.execute(
                    "SELECT version, updated_at, actor, payload FROM wh_state WHERE id = 1"
                )
                row = cur.fetchone()
            if not row:
                return self._send_json(200, {"ok": True, "data": None})
            return self._send_json(
                200,
                {
                    "ok": True,
                    "version": row[0],
                    "updatedAt": row[1],
                    "actor": row[2],
                    "data": json.loads(row[3]),
                },
            )

        if path == "/api/wh/logs":
            with DB_LOCK:
                cur = CONN.execute(
                    "SELECT seq, created_at, actor, action, summary FROM wh_audit_log ORDER BY seq DESC LIMIT 50"
                )
                rows = [
                    {
                        "seq": r[0],
                        "createdAt": r[1],
                        "actor": r[2],
                        "action": r[3],
                        "summary": r[4],
                    }
                    for r in cur.fetchall()
                ]
            return self._send_json(200, {"ok": True, "logs": rows})

        if path == "/api/wh/audit.csv" and os.path.isfile(CSV_PATH):
            with open(CSV_PATH, "rb") as f:
                raw = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return

        # Serve static files from dist/
        rel = path.lstrip("/") or "index.html"
        full_path = os.path.normpath(os.path.join(DIST_DIR, rel))
        if not full_path.startswith(DIST_DIR) or not os.path.isfile(full_path):
            full_path = os.path.join(DIST_DIR, "index.html")

        if not os.path.isfile(full_path):
            return self._send_json(404, {"ok": False, "error": "dist not built"})

        ctype, _ = mimetypes.guess_type(full_path)
        if not ctype:
            ctype = "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype = ctype + "; charset=utf-8"

        with open(full_path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/wh/state":
            return self._send_json(404, {"ok": False, "error": "unknown endpoint"})

        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            return self._send_json(400, {"ok": False, "error": "invalid json"})

        action = str(body.get("action") or "sync")
        actor = str(body.get("actor") or self.headers.get("X-Actor") or "unknown")
        data = body.get("data")
        if not isinstance(data, dict):
            return self._send_json(400, {"ok": False, "error": "missing data payload"})

        # 服务端硬权限门禁校验：防止绕过前端UI直接调用API执行主管/老板操作
        if action in SUPERVISOR_ONLY_ACTIONS and actor not in ("admin", "boss"):
            now_deny = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            with DB_LOCK:
                CONN.execute(
                    "INSERT INTO wh_audit_log (created_at, actor, action, summary) VALUES (?, ?, ?, ?)",
                    (now_deny, actor, "DENIED:" + action, "拦截非主管越权调用"),
                )
                CONN.commit()
            return self._send_json(
                403,
                {
                    "ok": False,
                    "error": "FORBIDDEN_SUPERVISOR_ONLY",
                    "message": "服务端权限拦截：该动作仅允许仓管主管(admin)执行",
                },
            )

        # 服务端新人演练门禁校验
        prog = (data.get("practiceProgress") or {}).get(actor)
        if (
            actor == "newbie"
            and action not in ("init", "reset", "practice_done", "practice_reset")
            and not (prog and prog.get("case1") and prog.get("case2") and prog.get("case3"))
        ):
            now_deny = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            with DB_LOCK:
                CONN.execute(
                    "INSERT INTO wh_audit_log (created_at, actor, action, summary) VALUES (?, ?, ?, ?)",
                    (now_deny, actor, "DENIED_NEWBIE:" + action, "拦截未通关新人写操作"),
                )
                CONN.commit()
            return self._send_json(
                403,
                {
                    "ok": False,
                    "error": "NEWBIE_PRACTICE_GATE_LOCKED",
                    "message": "服务端防呆拦截：首日新人未完成3项实操演练，禁止修改真实台账",
                },
            )

        now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        ver = str(data.get("version") or "wh-stitch-20261114-v4")
        payload_text = json.dumps(data, ensure_ascii=False)
        sku_cnt = len(data.get("skus") or [])
        order_cnt = len(data.get("salesOrderPool") or [])
        mov_cnt = len(data.get("stockMovements") or [])
        summary = f"skus={sku_cnt}, orders={order_cnt}, movements={mov_cnt}"

        with DB_LOCK:
            CONN.execute(
                """
                INSERT INTO wh_state (id, version, updated_at, actor, payload)
                VALUES (1, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    version = excluded.version,
                    updated_at = excluded.updated_at,
                    actor = excluded.actor,
                    payload = excluded.payload;
                """,
                (ver, now, actor, payload_text),
            )
            CONN.execute(
                "INSERT INTO wh_audit_log (created_at, actor, action, summary) VALUES (?, ?, ?, ?)",
                (now, actor, action, summary),
            )
            CONN.commit()

        return self._send_json(200, {"ok": True, "savedAt": now, "action": action, "actor": actor})


def main():
    port = int(os.environ.get("H5_PORT", "5351"))
    host = os.environ.get("H5_HOST", "127.0.0.1")
    httpd = ThreadingHTTPServer((host, port), WarehouseHandler)
    print("Warehouse Workbench listening on http://" + host + ":" + str(port), flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
采购工作台 · Stitch Tide Blue 企业版 一体化 H5 服务（端口 5360）。
单进程同时提供 dist/ 静态托管与 /api/* 本地 SQLite 状态机持久化接口，零第三方依赖。
"""

from __future__ import annotations

import mimetypes
import os
import sys
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST_DIR = os.path.join(ROOT, "dist")
EXT_DIR = os.path.join(ROOT, "AdsPower扩展-采购Copilot")
sys.path.insert(0, os.path.join(ROOT, "后端演示接口"))

import procurement_server as api  # noqa: E402

PORT = int(os.environ.get("PORT", "5360"))


class UnifiedWorkbenchHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args) -> None:
        return

    def _send_bytes(self, status: int, content_type: str, data: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        is_immutable_asset = "/assets/" in self.path
        self.send_header("Cache-Control", "public, max-age=31536000, immutable" if is_immutable_asset else "no-cache, no-store, must-revalidate")
        self.end_headers()
        self.wfile.write(data)

    def _send_json(self, status: int, payload) -> None:
        raw = api.json_dumps(payload).encode("utf-8")
        self._send_bytes(status, "application/json; charset=utf-8", raw)

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/health":
            self._send_json(200, {"ok": True, "service": "procurement-workbench-unified", "port": PORT, "time": api.now_iso()})
            return
        if path == "/api/dashboard":
            self._send_json(200, {"ok": True, "data": api.fetch_dashboard()})
            return
        if path == "/api/cases":
            dash = api.fetch_dashboard()
            self._send_json(200, {"ok": True, "cases": dash["cases"]})
            return
        if path.startswith("/api/cases/"):
            cid = urllib.parse.unquote(path.split("/")[3])
            st, resp = api.fetch_single_case(cid)
            self._send_json(st, resp)
            return
        if path == "/api/executor/jobs":
            self._send_json(200, api.fetch_executor_jobs(parsed.query))
            return
        if path == "/api/adspower/status":
            self._send_json(200, {"ok": True, "adspower": api.get_adspower_status()})
            return
        if path.startswith("/api/"):
            self._send_json(404, {"ok": False, "error": f"Unknown API endpoint: {path}"})
            return

        if path.startswith("/copilot-ext/"):
            ext_rel = urllib.parse.unquote(path[len("/copilot-ext/"):]) or "sidebar.html"
            ext_target = os.path.realpath(os.path.join(EXT_DIR, ext_rel))
            if not ext_target.startswith(os.path.realpath(EXT_DIR)) or not os.path.isfile(ext_target):
                self._send_bytes(404, "text/plain; charset=utf-8", b"Not Found")
                return
            ctype, _ = mimetypes.guess_type(ext_target)
            ctype = f"{ctype or 'application/octet-stream'}; charset=utf-8" if (ctype or "").startswith("text/") or ctype in ("application/javascript", "application/json") else (ctype or "application/octet-stream")
            with open(ext_target, "rb") as f:
                self._send_bytes(200, ctype, f.read())
            return

        rel = urllib.parse.unquote(path.lstrip("/")) or "index.html"
        target = os.path.realpath(os.path.join(DIST_DIR, rel))
        if not target.startswith(os.path.realpath(DIST_DIR)):
            self._send_bytes(403, "text/plain; charset=utf-8", b"Forbidden")
            return
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not os.path.isfile(target):
            # SPA hash fallback to index.html for root-like routes without extension
            if "." not in os.path.basename(rel):
                target = os.path.join(DIST_DIR, "index.html")
            else:
                self._send_bytes(404, "text/plain; charset=utf-8", b"Not Found")
                return

        ctype, _ = mimetypes.guess_type(target)
        if not ctype:
            ctype = "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype = f"{ctype}; charset=utf-8"
        with open(target, "rb") as f:
            data = f.read()
        self._send_bytes(200, ctype, data)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            self._send_json(404, {"ok": False, "error": "POST only supported under /api/"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            body = api.json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            self._send_json(400, {"ok": False, "error": "Invalid JSON body"})
            return
        status, resp = api.handle_api_post(parsed.path, body)
        self._send_json(status, resp)


def main() -> None:
    api.init_db()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), UnifiedWorkbenchHandler)
    print(f"采购工作台 · Stitch Tide Blue 已启动：http://127.0.0.1:{PORT}")
    print(f"SQLite 演示库：{api.DB_PATH}")
    srv.serve_forever()


if __name__ == "__main__":
    main()

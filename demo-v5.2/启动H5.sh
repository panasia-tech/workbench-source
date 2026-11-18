#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PORT="${PORT:-5360}"
PY_BIN="${PY_BIN:-python3}"
if command -v /Users/user/.local/bin/python3.12 >/dev/null 2>&1; then
  PY_BIN="/Users/user/.local/bin/python3.12"
fi
echo "启动采购工作台 · Stitch Tide Blue 企业版（http://127.0.0.1:${PORT}）"
PORT="$PORT" exec "$PY_BIN" h5_server.py

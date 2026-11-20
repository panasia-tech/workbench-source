#!/usr/bin/env zsh
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$BASE_DIR/AdsPower扩展-采购Copilot"
USER_ID="${1:-k1j1yxdc}"

echo "采购 Copilot 扩展目录: $EXT_DIR"

if ! curl -sf "http://127.0.0.1:5360/api/health" >/dev/null 2>&1; then
  echo "正在后台启动全量采购工作台 (端口 5360)..."
  nohup /Users/user/.local/bin/python3.12 "$BASE_DIR/h5_server.py" >/tmp/procurement_h5_5360.log 2>&1 &
  sleep 1.2
fi

if ! curl -sf "http://local.adspower.net:50325/status" >/dev/null 2>&1; then
  echo "❌ 未检测到运行中的 AdsPower Local API (http://local.adspower.net:50325)。请先打开 AdsPower Global 客户端。"
  exit 1
fi

echo "🚀 正在拉起 AdsPower 采购专窗 (user_id=$USER_ID, 序号 #44 · 闲鱼采购Copilot专窗)..."
curl -sS "http://local.adspower.net:50325/api/v1/browser/start?user_id=${USER_ID}&open_tabs=0&launch_args=$(/Users/user/.local/bin/python3.12 -c 'import urllib.parse, json, sys; print(urllib.parse.quote(json.dumps(["--load-extension=" + sys.argv[1]])))' "$EXT_DIR")"
echo ""

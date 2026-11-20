#!/usr/bin/env bash
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
port="${LEDGER_PORT:-5370}"
runtime="${LEDGER_RUNTIME_DIR:-$HOME/Library/Caches/panasia-boss-master-ledger-20261114}"
py="${LEDGER_PYTHON:-$HOME/.local/bin/python3.12}"
if [[ ! -x "$py" ]]; then py="$(command -v python3)"; fi
mkdir -p "$runtime"

app_url="http://127.0.0.1:$port"
browser_url="http://localhost:$port"
identity="$app_url/ledger-build.txt"
release="anchor-boss-master-ledger-desktop-20261118-v8"

check_id() {
  (curl -fsS --max-time 2 "$identity" 2>/dev/null || true) | tr -d '\r\n'
}

if [[ "$(check_id)" != "$release" ]]; then
  pkill -f "ledger_server.py" 2>/dev/null || true
  sleep 0.3
  LEDGER_PORT="$port" perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' "$py" "$dir/ledger_server.py" </dev/null >"$runtime/ledger.log" 2>&1 &
  for _ in {1..25}; do
    if [[ "$(check_id)" == "$release" ]]; then break; fi
    sleep 0.3
  done
  if [[ "$(check_id)" != "$release" ]]; then
    echo "全量台账桌面服务未启动成功，请查看日志: $runtime/ledger.log" >&2
    exit 1
  fi
fi

echo "$browser_url"
if [[ "${NO_OPEN:-0}" != 1 ]]; then open "$browser_url"; fi

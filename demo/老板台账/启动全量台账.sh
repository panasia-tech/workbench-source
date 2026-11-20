#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd "$(dirname "$0")" && pwd)"
umask 077
export PYTHONDONTWRITEBYTECODE=1
export LEDGER_DB_PATH="$app_dir/.demo-runtime/master_ledger.sqlite"
export LEDGER_KEK_PATH="$app_dir/.demo-runtime/.vault_master.key"
unset LEDGER_VAULT_KEK_HEX
exec "${LEDGER_PYTHON:-python3}" -u "$app_dir/ledger_server.py"

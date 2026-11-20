#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
(
  sleep 1
  open "http://127.0.0.1:${PORT:-5360}/#/today" || true
) &
exec ./启动H5.sh

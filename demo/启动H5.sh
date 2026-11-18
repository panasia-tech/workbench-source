#!/usr/bin/env bash
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
app_port="${H5_PORT:-5380}"
runtime="${CS_RUNTIME_DIR:-$HOME/Library/Caches/panasia-cs-workbench-20261116}"
py="${CS_PYTHON:-$HOME/.local/bin/python3.12}"
if [[ ! -x "$py" ]]; then py="$(command -v python3)"; fi
mkdir -p "$runtime"

app_url="http://127.0.0.1:$app_port"
identity="$app_url/cs-build.txt"
release="cs-workbench-desktop-20261116-v1"

check_id() {
  (curl -fsS --max-time 2 "$identity" 2>/dev/null || true) | tr -d '\r\n'
}

if [[ "$(check_id)" != "$release" ]]; then
  pkill -f "cs_server.py" 2>/dev/null || true
  sleep 0.3
  H5_PORT="$app_port" CS_RUNTIME_DIR="$runtime" perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' "$py" "$dir/cs_server.py" </dev/null >"$runtime/h5.log" 2>&1 &
  for _ in {1..20}; do
    if [[ "$(check_id)" == "$release" ]]; then break; fi
    sleep 0.4
  done
  if [[ "$(check_id)" != "$release" ]]; then
    echo "客服工作台 H5 未启动成功，请查看日志: $runtime/h5.log" >&2
    exit 1
  fi
fi

url="$app_url/?as=outsource_lu#/chat"
echo "=========================================================="
echo "泛亚外包客服工作台 · C端电脑桌面版 H5 已启动 (端口 $app_port)"
echo "1. 外包客服三栏接待台:   $app_url/?as=outsource_lu#/chat"
echo "2. 自动发货与熔断监控池: $app_url/?as=outsource_lu#/autoship"
echo "3. 主管14项全维考核大盘: $app_url/?as=supervisor#/kpi"
echo "4. 外包首日新人保护锁:   $app_url/?as=newbie#/chat"
echo "5. 内部销售接管与锦囊:   $app_url/?as=internal_chen#/chat"
echo "=========================================================="
if [[ "${H5_NO_OPEN:-0}" != 1 ]]; then open "$url"; fi

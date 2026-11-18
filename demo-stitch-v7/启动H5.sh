#!/bin/bash
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
app_port="${H5_PORT:-5351}"
runtime="${WH_RUNTIME_DIR:-$HOME/Library/Caches/panasia-warehouse-stitch-20261114}"
py="${WH_PYTHON:-$HOME/.local/bin/python3.12}"
if [[ ! -x "$py" ]]; then py="$(command -v python3)"; fi
mkdir -p "$runtime"

app_url="http://127.0.0.1:$app_port"
identity="$app_url/stitch-build.txt"
release="warehouse-workbench-stitch-20261114"

check_id() {
  (curl -fsS --max-time 2 "$identity" 2>/dev/null || true) | tr -d '\r\n'
}

if [[ "$(check_id)" != "$release" ]]; then
  H5_PORT="$app_port" WH_RUNTIME_DIR="$runtime" perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' "$py" "$dir/warehouse_server.py" </dev/null >"$runtime/h5.log" 2>&1 &
  for i in {1..20}; do
    if [[ "$(check_id)" == "$release" ]]; then break; fi
    sleep 0.5
  done
  if [[ "$(check_id)" != "$release" ]]; then
    echo "仓管工作台 H5 未启动成功，请查看日志: $runtime/h5.log" >&2
    exit 1
  fi
fi

url="$app_url/?as=linqg#/today"
echo "=========================================================="
echo "泛亚仓管工作台 · v5 终极全闭环电脑版H5 + PDA走动端 已启动"
echo "主力仓管员视角:   $app_url/?as=linqg#/today"
echo "爱回收分级验货:   $app_url/?as=linqg#/inspect"
echo "历史库存阻塞清洗: $app_url/?as=linqg#/legacy-wash"
echo "订单抓取与聚合:   $app_url/?as=linqg#/orders"
echo "波次四码与拦截:   $app_url/?as=linqg#/outbound"
echo "货架盲盘与纠偏:   $app_url/?as=linqg#/stocktake"
echo "流程图与开发蓝图: $app_url/全链路流程图与开发蓝图.html"
echo "=========================================================="
if [[ "${H5_NO_OPEN:-0}" != 1 ]]; then open "$url"; fi

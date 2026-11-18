#!/bin/bash
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
app_port="${H5_PORT:-5341}"
demo_port="${STITCH_DEMO_PORT:-5342}"
cache="${GALLERY_DEMO_CACHE:-$HOME/Library/Caches/panasia-gallery-demo}"
runtime="${STITCH_DEMO_RUNTIME:-$HOME/Library/Caches/panasia-gallery-stitch-20261113}"
py="${STITCH_PYTHON:-$HOME/.local/bin/python3.12}"
if [[ ! -x "$py" ]]; then py="$(command -v python3)"; fi
mkdir -p "$runtime"

demo_url="http://127.0.0.1:$demo_port"
app_url="http://127.0.0.1:$app_port"
identity="$app_url/stitch-build.txt"
release="sales-workbench-stitch-20261113"

demo_ready() {
  curl -fsS --max-time 3 "$demo_url/api/stitch-demo/health" 2>/dev/null | "$py" -c 'import json,sys; assert json.load(sys.stdin)["mode"] == "stitch-sales-demo"' 2>/dev/null
}

if ! demo_ready; then
  if [[ ! -d "$cache/server/app" || ! -d "$cache/pylib/fastapi" || ! -d "$cache/demo-img" ]]; then
    echo "找不到原版演示环境。请在已有演示环境的 Mac 运行，或用 GALLERY_DEMO_CACHE 指定包含 server/app、pylib 和 demo-img 的目录。" >&2
    exit 1
  fi
  mkdir -p "$runtime/server" "$runtime/demo-img"
  if [[ ! -e "$runtime/server/app" ]]; then ln -s "$cache/server/app" "$runtime/server/app"; fi
  if [[ ! -e "$runtime/pylib" ]]; then ln -s "$cache/pylib" "$runtime/pylib"; fi
  rsync -a --exclude='inspection/listing/' "$cache/demo-img/" "$runtime/demo-img/"
  cp "$dir/后端演示接口/"*.py "$runtime/"
  STITCH_DEMO_PORT="$demo_port" perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' "$py" "$runtime/demo_server.py" </dev/null >"$runtime/backend.log" 2>&1 &
  for i in {1..30}; do
    if demo_ready; then break; fi
    sleep 1
  done
  if ! demo_ready; then
    echo "演示后端启动失败，记录在 $runtime/backend.log" >&2
    exit 1
  fi
fi

if [[ "$(curl -fsS --max-time 2 "$identity" 2>/dev/null || true)" != "$release" ]]; then
  H5_PORT="$app_port" H5_BACKEND="$demo_url" perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' "$py" "$dir/h5_server.py" </dev/null >"$runtime/h5.log" 2>&1 &
  for i in {1..20}; do
    if [[ "$(curl -fsS --max-time 2 "$identity" 2>/dev/null || true)" == "$release" ]]; then break; fi
    sleep 1
  done
  if [[ "$(curl -fsS --max-time 2 "$identity" 2>/dev/null || true)" != "$release" ]]; then
    echo "H5 未启动，请检查端口和 $runtime/h5.log" >&2
    exit 1
  fi
fi
url="$app_url/?as=chenxm#/today"
echo "$url"
if [[ "${H5_NO_OPEN:-0}" != 1 ]]; then open "$url"; fi

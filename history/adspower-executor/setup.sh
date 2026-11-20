#!/bin/bash
# AdsPower 群控执行端一键安装（macOS / Linux）
# 做四件事：找/装 Python ≥3.10 → 建 .venv → 装依赖 → 跑 doctor 体检
# 注意：执行端只用 Playwright 的 CDP 接管（连 AdsPower 已开的浏览器），
# 不需要 playwright install 下载浏览器——安装最大的坑天然不存在。
set -e
cd "$(dirname "$0")"

echo "== 1/4 检测 Python =="
PY=""
for c in python3.13 python3.12 python3.11 python3.10 python3 python; do
  if command -v "$c" >/dev/null 2>&1; then
    if "$c" -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" 2>/dev/null; then
      PY="$c"; break
    fi
  fi
done

if [ -z "$PY" ]; then
  echo "未找到 Python ≥3.10，尝试自动安装 ..."
  if command -v brew >/dev/null 2>&1; then
    brew install python@3.13 && PY=python3.13
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y python3 python3-venv && PY=python3
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y python3 && PY=python3
  else
    echo "✗ 无法自动安装 Python。请手动安装 ≥3.10 后重跑本脚本："
    echo "  macOS:  brew install python@3.13   （或官网 https://www.python.org/downloads/）"
    exit 1
  fi
fi
echo "使用: $PY ($($PY --version 2>&1))"

echo "== 2/4 创建虚拟环境 .venv =="
if [ ! -d .venv ]; then
  "$PY" -m venv .venv
  echo "已创建 .venv"
else
  echo ".venv 已存在，跳过"
fi

echo "== 3/4 安装依赖 =="
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r requirements.txt
echo "依赖安装完成（playwright / paho-mqtt / httpx / pyyaml）"

if [ ! -f config.yaml ]; then
  cp config.example.yaml config.yaml
  echo "已生成 config.yaml —— 请编辑填入 server 地址、enroll_secret、environments 环境清单"
fi

echo "== 4/4 体检 =="
.venv/bin/python manage.py doctor

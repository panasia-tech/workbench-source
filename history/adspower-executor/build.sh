#!/bin/bash
# 打包 gc-ads 单文件可执行程序（macOS/Linux）。
# ⚠️ PyInstaller 不能跨平台：Windows 版请在 Windows 上跑 build.bat。
set -e
cd "$(dirname "$0")"

[ -d .venv-build ] || python3 -m venv .venv-build
.venv-build/bin/pip install --quiet --upgrade pip pyinstaller
.venv-build/bin/pip install --quiet -r requirements.txt

# 内置代码版本（热更新只换比它新的；行情台据此判断要不要更新）。用法：./build.sh 2 0.2.0
[ -n "$2" ] || { echo "用法: ./build.sh <codeVersion> <versionName>"; exit 1; }
.venv-build/bin/python scripts/write_builtin_version.py --code-version "$1" --version-name "$2"

# onedir 而非 onefile：onefile 子进程（executor 由 supervisor 拉起）在父进程退出后
# 会读不到已清理的 _MEI 解压目录（2026-09-09 实测 base_library.zip FileNotFoundError）;
# onedir 模块全在磁盘目录里，无解压/清理问题，且多环境拉起时不用每进程解压 50MB。
# --collect-all playwright：把 driver（node 运行时 + 协议层）整个打进包，
# 否则 frozen 后 connect_over_cdp 找不到 driver 直接起不来。
.venv-build/bin/pyinstaller --onedir --name gc-ads \
  --collect-all playwright \
  --exclude-module multiprocessing \
  --add-data "config.example.yaml:." \
  --add-data "build-info/builtin-code-version.json:." \
  --clean --noconfirm gcads.py

echo
echo "产物: dist/gc-ads/（整个目录拷到目标机器；config.yaml 放目录里，与 gc-ads 同级）"
echo "config.yaml 缺失时程序首启会自动从内置模板生成一份。"

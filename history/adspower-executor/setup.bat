@echo off
rem AdsPower 群控执行端一键安装（Windows 10/11）
rem 做四件事：找/装 Python ^>=3.10 → 建 .venv → 装依赖 → 跑 doctor 体检
rem 注意：执行端只用 Playwright 的 CDP 接管（连 AdsPower 已开的浏览器），
rem 不需要 playwright install 下载浏览器。
setlocal
cd /d "%~dp0"

echo == 1/4 检测 Python ==
set PY=
py -3.13 -c "pass" >nul 2>&1 && set PY=py -3.13
if not defined PY ( py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1 && set PY=py -3 )
if not defined PY ( python -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1 && set PY=python )

if not defined PY (
  echo 未找到 Python ^>=3.10，尝试用 winget 自动安装 ...
  winget install -e --id Python.Python.3.13 --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo [X] 自动安装失败。请手动安装 Python 3.13 后重跑本脚本：
    echo     https://www.python.org/downloads/  （安装时务必勾选 Add python.exe to PATH）
    exit /b 1
  )
  rem winget 装完要刷新 PATH 才找得到
  set "PATH=%LOCALAPPDATA%\Programs\Python\Python313;%LOCALAPPDATA%\Programs\Python\Python313\Scripts;%PATH%"
  set PY=python
)
echo 使用: %PY%

echo == 2/4 创建虚拟环境 .venv ==
if not exist .venv (
  %PY% -m venv .venv
  echo 已创建 .venv
) else (
  echo .venv 已存在，跳过
)

echo == 3/4 安装依赖 ==
.venv\Scripts\python.exe -m pip install --quiet --upgrade pip
.venv\Scripts\python.exe -m pip install --quiet -r requirements.txt
echo 依赖安装完成（playwright / paho-mqtt / httpx / pyyaml）

if not exist config.yaml (
  copy config.example.yaml config.yaml >nul
  echo 已生成 config.yaml —— 请编辑填入 server 地址、enroll_secret、environments 环境清单
)

echo == 4/4 体检 ==
.venv\Scripts\python.exe manage.py doctor
endlocal

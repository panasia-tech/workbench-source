@echo off
rem 打包 gc-ads 可执行程序（Windows，onedir 目录形态）。
rem ⚠️ 必须在 Windows 上执行（PyInstaller 不能跨平台）；需先跑过 setup.bat。
setlocal
cd /d "%~dp0"

if not exist .venv-build (
  py -3 -m venv .venv-build 2>nul || python -m venv .venv-build
)
.venv-build\Scripts\python.exe -m pip install --quiet --upgrade pip pyinstaller
.venv-build\Scripts\python.exe -m pip install --quiet -r requirements.txt

rem 内置代码版本（热更新只换比它新的；行情台据此判断工位上的包要不要更新）。
rem 用法：build.bat <codeVersion> <versionName>，例如 build.bat 2 0.2.0
if "%~2"=="" (
  echo 用法: build.bat ^<codeVersion^> ^<versionName^>
  exit /b 1
)
.venv-build\Scripts\python.exe scripts\write_builtin_version.py --code-version %1 --version-name %2 || exit /b 1

rem onedir 而非 onefile：onefile 子进程（executor 由 supervisor 拉起）在父进程退出后
rem 会读不到已清理的 _MEI 解压目录（2026-09-09 实测 base_library.zip FileNotFoundError）;
rem onedir 模块全在磁盘目录里，无解压/清理问题，且多环境拉起时不用每进程解压 50MB。
rem --collect-all playwright：把 driver（node 运行时 + 协议层）整个打进包，
rem 否则 frozen 后 connect_over_cdp 找不到 driver 直接起不来。
rem --exclude-module multiprocessing：执行端是纯 asyncio/线程，不用多进程；
rem 不打掉它 PyInstaller 会挂 mp 运行时钩子，连环缺 _socket/select 等 C 扩展。
rem 注意 Windows 的 --add-data 分隔符是分号。
.venv-build\Scripts\pyinstaller.exe --onedir --name gc-ads ^
  --collect-all playwright ^
  --exclude-module multiprocessing ^
  --add-data "config.example.yaml;." ^
  --add-data "build-info\builtin-code-version.json;." ^
  --clean --noconfirm gcads.py

echo.
echo 产物: dist\gc-ads\（整个目录拷到目标机器；config.yaml 放目录里，与 gc-ads.exe 同级）
echo config.yaml 缺失时程序首启会自动从内置模板生成一份。
endlocal

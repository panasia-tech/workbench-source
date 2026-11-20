@echo off
REM ============================================================
REM  Groupcontrol Guardian - Windows build (single exe, no console)
REM
REM  Pure ASCII + CRLF on purpose: cmd.exe mis-parses UTF-8 batch
REM  files on some Windows builds, and the failure looks like a
REM  broken script rather than an encoding problem.
REM
REM  Needs Python 3.10+ with 'Add Python to PATH' checked.
REM  Run: double-click this file, or 'build.bat' in a cmd here.
REM ============================================================
cd /d "%~dp0"

echo [1/3] installing deps + PyInstaller ...
python -m pip install -r requirements.txt pyinstaller
if errorlevel 1 (
    echo.
    echo [x] dependency install failed - check Python and network.
    pause
    exit /b 1
)

echo.
echo [2/3] building gc-guardian.exe ...
REM  --noconsole: this is the GUI entry (main_gui.py). Packing main.py
REM  instead would ship the console daemon, which opens a black window
REM  and gives the operator nothing to click.
REM  --collect-all adbutils: its submodules are imported lazily.
pyinstaller --onefile --noconsole --name gc-guardian ^
    --collect-all adbutils ^
    --add-data "config.example.yaml;." ^
    main_gui.py
if errorlevel 1 (
    echo.
    echo [x] build failed.
    pause
    exit /b 1
)

echo.
echo [3/3] done. Output: dist\gc-guardian.exe
echo.
echo Next - assemble the distribution folder:
echo   1) make a folder for it
echo   2) copy dist\gc-guardian.exe into it
echo   3) copy config.example.yaml as config.yaml, set adb_path to adb\adb.exe
echo   4) make an 'adb' subfolder with adb.exe + AdbWinApi.dll + AdbWinUsbApi.dll
echo   Copy that folder to any Windows PC and double-click the exe.
echo.
pause

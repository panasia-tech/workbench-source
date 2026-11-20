# 守护运行:OCR 微服务(127.0.0.1:8600) + SSH 反向隧道(把它挂到服务器 127.0.0.1:8600)。
# Windows 没有 systemd / autossh,这两个 while 循环就是替代品:子进程一退就 5s 后重启。
#
# 用法:
#   .\run.ps1                      # 前台跑两者(手动验证用,Ctrl-C 退)
#   .\run.ps1 -Role ocr            # 只跑 OCR 服务(install-task.ps1 用这个)
#   .\run.ps1 -Role tunnel         # 只跑隧道(install-task.ps1 用这个)

param(
    [ValidateSet('both', 'ocr', 'tunnel')] [string]$Role = 'both',
    [string]$ServerHost = '122.51.208.149',
    [string]$SshUser = 'gcocr',
    [int]$Port = 8600,
    [string]$Token = $(if ($env:GC_OCR_HTTP_TOKEN) { $env:GC_OCR_HTTP_TOKEN } else { 'gc-ocr-shared-2026' }),
    # 纯 CPU 跑(GPU 还没弄通时用)。必须由参数传,不能靠交互 shell 里 set 环境变量 ——
    # 计划任务是以 SYSTEM 身份另起进程,继承不到你窗口里的环境变量,
    # 而 GC_OCR_REQUIRE_GPU 默认为 1,拿不到 GPU 就直接启动失败。
    [switch]$Cpu
)

$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

$py      = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
$key     = Join-Path $PSScriptRoot 'ssh\gcocr'
$known   = Join-Path $PSScriptRoot 'ssh\known_hosts'
$ocrLog  = Join-Path $PSScriptRoot 'gc-ocr.log'
$tunLog  = Join-Path $PSScriptRoot 'gc-tunnel.log'

function Write-Log($path, $msg) {
    "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg | Out-File -FilePath $path -Append -Encoding utf8
}

function Trim-Log($path) {
    # 长跑几个月别把盘写满:超过 20MB 就截掉
    if ((Test-Path $path) -and ((Get-Item $path).Length -gt 20MB)) { Clear-Content $path }
}

function Start-OcrLoop {
    if (-not (Test-Path $py)) { throw "没有 venv,先跑 .\setup.ps1" }
    $env:GC_OCR_HTTP_TOKEN = $Token
    if ($Cpu) {
        $env:GC_OCR_USE_GPU = '0'
        $env:GC_OCR_REQUIRE_GPU = '0'
        Write-Log $ocrLog '按 -Cpu 参数以纯 CPU 模式运行(GPU 未启用)'
    }
    while ($true) {
        Trim-Log $ocrLog
        Write-Log $ocrLog "启动 uvicorn 127.0.0.1:$Port (gpu=$($env:GC_OCR_USE_GPU -ne '0'))"
        & $py -m uvicorn ocr_server:app --host 127.0.0.1 --port $Port *>> $ocrLog
        Write-Log $ocrLog "uvicorn 退出(code=$LASTEXITCODE),5s 后重启"
        Start-Sleep -Seconds 5
    }
}

function Start-TunnelLoop {
    if (-not (Test-Path $key)) { throw "没有 SSH 私钥 $key,先跑 .\setup.ps1" }
    # 等 OCR 服务起来再挂隧道(免得服务器那头先看到一个通但打不开的端口)
    for ($i = 0; $i -lt 60; $i++) {
        try {
            Invoke-WebRequest "http://127.0.0.1:$Port/healthy" -TimeoutSec 3 -UseBasicParsing | Out-Null
            break
        } catch { Start-Sleep -Seconds 2 }
    }
    while ($true) {
        Trim-Log $tunLog
        Write-Log $tunLog "连 $SshUser@$ServerHost,反挂 127.0.0.1:$Port"
        # ExitOnForwardFailure:服务器那边端口还被上一个僵尸会话占着时立刻退出让循环重连,
        #   而不是挂着一条「连上了但没有隧道」的连接(那种最难查)。
        # UserKnownHostsFile 指到本目录:任务计划以 SYSTEM 跑,读不到用户 profile 的 ~/.ssh。
        & ssh -N -T -i $key `
            -o IdentitiesOnly=yes `
            -o ExitOnForwardFailure=yes `
            -o ServerAliveInterval=20 `
            -o ServerAliveCountMax=3 `
            -o ConnectTimeout=15 `
            -o StrictHostKeyChecking=accept-new `
            -o "UserKnownHostsFile=$known" `
            -R "127.0.0.1:${Port}:127.0.0.1:${Port}" `
            "$SshUser@$ServerHost" *>> $tunLog
        Write-Log $tunLog "ssh 退出(code=$LASTEXITCODE),5s 后重连"
        Start-Sleep -Seconds 5
    }
}

switch ($Role) {
    'ocr'    { Start-OcrLoop }
    'tunnel' { Start-TunnelLoop }
    'both'   {
        Write-Host "==> 后台起 OCR 服务(日志 gc-ocr.log),前台跑隧道(日志 gc-tunnel.log)" -ForegroundColor Cyan
        $childArgs = @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "$PSScriptRoot\run.ps1",
            '-Role', 'ocr', '-Port', $Port, '-Token', $Token
        )
        if ($Cpu) { $childArgs += '-Cpu' }
        Start-Process powershell -ArgumentList $childArgs
        Start-TunnelLoop
    }
}

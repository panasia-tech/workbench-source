# 注册开机自启(两个计划任务:gc-ocr / gc-ocr-tunnel)+ 关掉睡眠。
# **必须用管理员 PowerShell 跑**:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install-task.ps1
# 卸载: .\install-task.ps1 -Uninstall

param(
    [switch]$Uninstall,
    [string]$ServerHost = '122.51.208.149',
    [string]$SshUser = 'gcocr',
    [int]$Port = 8600,
    [string]$Token = $(if ($env:GC_OCR_HTTP_TOKEN) { $env:GC_OCR_HTTP_TOKEN } else { 'gc-ocr-shared-2026' }),
    # 纯 CPU 模式(GPU 还没弄通时)。必须显式带上:任务以 SYSTEM 身份跑,
    # 继承不到你窗口里的环境变量,而 GC_OCR_REQUIRE_GPU 默认 1 会让服务启动失败。
    [switch]$Cpu
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw '需要管理员权限:右键 PowerShell →「以管理员身份运行」再执行'
}

$tasks = @('gc-ocr', 'gc-ocr-tunnel')

if ($Uninstall) {
    foreach ($t in $tasks) {
        if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
            Unregister-ScheduledTask -TaskName $t -Confirm:$false
            Write-Host "已删除任务 $t" -ForegroundColor Yellow
        }
    }
    return
}

function Register-Loop($name, $role) {
    $arg = '-NoProfile -ExecutionPolicy Bypass -File "{0}\run.ps1" -Role {1} -ServerHost {2} -SshUser {3} -Port {4} -Token {5}' -f `
        $PSScriptRoot, $role, $ServerHost, $SshUser, $Port, $Token
    if ($Cpu -and $role -eq 'ocr') { $arg += ' -Cpu' }
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arg -WorkingDirectory $PSScriptRoot
    $trigger = New-ScheduledTaskTrigger -AtStartup
    # ExecutionTimeLimit=0 表示永不超时杀掉(默认 3 天会被结束掉);失败自动重启兜底 while 循环之外的异常退出
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    # 以 SYSTEM 跑:不用存密码、不用登录也在跑。所以 SSH 私钥/known_hosts 必须放在 win_ocr\ssh\
    # 而不是用户 profile 里(SYSTEM 的 profile 是 C:\Windows\System32\config\systemprofile)。
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
    }
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal | Out-Null
    Write-Host "已注册任务 $name (开机自启, role=$role)" -ForegroundColor Green
}

Register-Loop 'gc-ocr'        'ocr'
Register-Loop 'gc-ocr-tunnel' 'tunnel'

Write-Host '==> 关掉睡眠/休眠(交流电供电时)' -ForegroundColor Cyan
& powercfg /change standby-timeout-ac 0
& powercfg /change hibernate-timeout-ac 0
& powercfg /change disk-timeout-ac 0

Write-Host ''
Write-Host '完成。立刻启动(不用重启):' -ForegroundColor Cyan
Write-Host '  Start-ScheduledTask gc-ocr; Start-ScheduledTask gc-ocr-tunnel' -ForegroundColor White
Write-Host '看状态:  Get-ScheduledTask gc-ocr,gc-ocr-tunnel | Get-ScheduledTaskInfo' -ForegroundColor White
Write-Host '看日志:  Get-Content .\gc-ocr.log -Tail 30 -Wait' -ForegroundColor White
Write-Host ''
Write-Host '⚠️ 还要手动做一件事:设置 → Windows 更新 → 把「活动时间」设成全天,' -ForegroundColor Yellow
Write-Host '   否则系统更新会在半夜自动重启(重启后任务会自己起来,但重启那几分钟 OCR 是断的)' -ForegroundColor Yellow

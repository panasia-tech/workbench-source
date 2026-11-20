# 一次性安装:Python venv + OCR/GPU 依赖 + SSH 密钥,并做 GPU 真实自检。
# 用法(在 win_ocr 目录里,普通 PowerShell 即可,不必管理员):
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
# 可选: -NoMirror 走 PyPI 官方源(默认走清华镜像,国内快很多)

param(
    [switch]$NoMirror,
    [string]$Python = 'python'
)

# ⚠️ 这里**必须**是 Continue,不能用 Stop:本脚本几乎全是原生命令(python/pip/ssh-keygen/
# icacls/cmd)。PowerShell 一旦看到原生命令的 stderr 被**重定向**(2>$null / 2>&1),就会把
# 每行 stderr 包装成 ErrorRecord;配上 Stop 就变终止错误 —— 而 pip 动不动往 stderr 写无害警告
# (如 "WARNING: Skipping onnxruntime as it is not installed."),脚本会莫名死在半路。
# 所以:不用 Stop,改为每一步显式检查 $LASTEXITCODE 后 throw;并且不对原生命令做 stderr 重定向。
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
$ProgressPreference = 'SilentlyContinue'

Write-Host '==> 1/5 检查 Python' -ForegroundColor Cyan
& $Python --version
if ($LASTEXITCODE -ne 0) { throw "找不到 $Python。装 Python 3.12(python.org),安装时勾 Add to PATH" }

Write-Host '==> 2/5 创建 venv' -ForegroundColor Cyan
if (-not (Test-Path '.venv')) { & $Python -m venv .venv }
$py = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $py)) { throw "venv 创建失败,没有 $py。删掉 .venv 目录后重试" }

$pipArgs = @()
if (-not $NoMirror) { $pipArgs = @('-i', 'https://pypi.tuna.tsinghua.edu.cn/simple') }

Write-Host '==> 3/5 装依赖(首次要下 ~1GB 的 CUDA/cuDNN 轮子,慢)' -ForegroundColor Cyan
& $py -m pip install -U pip @pipArgs

# 先修「onnxruntime 半删」状态:CPU 版 onnxruntime 与 onnxruntime-gpu 共用同一个
# site-packages\onnxruntime\ 目录,两个都装过再卸掉一个,共用文件会被一起删掉,
# 剩下的空目录被 Python 当成命名空间包 —— import 能过但没有任何属性
# (典型报错:module 'onnxruntime' has no attribute '__version__')。
# pip 修不了这种状态,只能连目录一起清掉重装。
# 探测放在 cmd 里做 stderr 重定向(在 cmd 内部重定向,PowerShell 就看不到 stderr,
# 不会生成 ErrorRecord),缺包时的 traceback 不用打给用户看。
# Python 代码里只能用**单引号**:整段要嵌进 cmd /c 的双引号命令行里,
# 内层再出现双引号会把 -c 的参数提前截断(结果是每次都误判「ORT 坏了」白重装一遍)。
$ortProbe = "import onnxruntime, sys; sys.exit(0 if hasattr(onnxruntime, 'get_available_providers') else 3)"
& cmd /c "`"$py`" -c `"$ortProbe`" > NUL 2>&1"
if ($LASTEXITCODE -ne 0) {
    Write-Host '    清理 onnxruntime 残留(半删状态 pip 修不了,只能连目录删掉重装)' -ForegroundColor DarkGray
    & $py -m pip uninstall -y onnxruntime onnxruntime-gpu | Out-Null
    $sitePkgs = & $py -c "import sysconfig; print(sysconfig.get_paths()['purelib'])"
    $stray = Join-Path $sitePkgs 'onnxruntime'
    if (Test-Path $stray) {
        Remove-Item -Recurse -Force $stray -ErrorAction SilentlyContinue
        if (Test-Path $stray) {
            throw "删不掉 $stray(可能有进程占用)。先确认没有 python/uvicorn 在跑,再重试"
        }
    }
}

& $py -m pip install -r requirements.txt @pipArgs
if ($LASTEXITCODE -ne 0) { throw 'pip 安装失败' }

# rapidocr 必须 --no-deps 装:它的依赖里写着 onnxruntime(CPU 版),让 pip 自己装就会把
# CPU 版拖进来和 onnxruntime-gpu 抢同一个包目录。它的其余依赖已在 requirements.txt 里手工列出。
Write-Host '    装 rapidocr-onnxruntime==1.2.3 (--no-deps,避免拖入 CPU 版 onnxruntime)' -ForegroundColor DarkGray
& $py -m pip install --no-deps rapidocr-onnxruntime==1.2.3 @pipArgs
if ($LASTEXITCODE -ne 0) { throw 'rapidocr 安装失败' }

# 清掉上一版留下的 -cu12 轮子:和 cu13 并存不冲突(DLL 名字带版本号),但白占 1~2GB,
# 而且 DLL 搜索目录里两套版本混着,排查时容易看错。只在检测到 cu12 残留时才动。
$sitePkgs = & $py -c "import sysconfig; print(sysconfig.get_paths()['purelib'])"
if (Test-Path (Join-Path $sitePkgs 'nvidia\cublas\bin\cublasLt64_12.dll')) {
    Write-Host '    清掉旧的 -cu12 轮子(ORT 1.28 要 CUDA 13,cu12 那套用不上)' -ForegroundColor DarkGray
    & $py -m pip uninstall -y nvidia-cuda-runtime-cu12 nvidia-cublas-cu12 nvidia-cufft-cu12 `
        nvidia-curand-cu12 nvidia-cudnn-cu12 nvidia-nvjitlink-cu12 nvidia-cuda-nvrtc-cu12 | Out-Null
}

Write-Host '==> 4/5 SSH 密钥(放本目录 ssh\,不放用户 profile:任务计划以 SYSTEM 跑,读不到用户 profile)' -ForegroundColor Cyan
$sshDir = Join-Path $PSScriptRoot 'ssh'
New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
$key = Join-Path $sshDir 'gcocr'
if (-not (Test-Path $key)) {
    # 空口令必须走 cmd /c:PowerShell 传空字符串给原生命令的行为跨版本不一致 ——
    # 5.1 下 `-N '""'` 才是空口令,PS7 下同样写法会把字面量 `""` 当成口令,
    # 于是密钥带口令 → 隧道启动时卡在等口令输入(而且没有交互终端,直接失败)。
    & cmd /c "ssh-keygen -t ed25519 -N `"`" -C gc-ocr-win -f `"$key`""
    if (-not (Test-Path $key)) { throw 'ssh-keygen 失败(Win10 1809+ 自带 OpenSSH 客户端;或在「设置→可选功能」里装 OpenSSH 客户端)' }
}
# 校验私钥确实没有口令:带口令的钥匙在计划任务里用不了(没有终端可输入)
& cmd /c "ssh-keygen -y -P `"`" -f `"$key`" > NUL 2>&1"
if ($LASTEXITCODE -ne 0) {
    throw "私钥 $key 带口令,计划任务里用不了。删掉整个 ssh 目录后重跑 setup.ps1"
}
# OpenSSH 会拒绝「权限过松」的私钥(只容许 owner / SYSTEM / Administrators)。
# 用 SID 而不是账户名 —— 中文版 Windows 上 "SYSTEM"/"Administrators" 的本地化名字对不上,
# icacls 会失败。
#   *S-1-5-18     = NT AUTHORITY\SYSTEM   (计划任务以它的身份跑)
#   *S-1-5-32-544 = BUILTIN\Administrators
# 当前用户也必须给:UAC 下非提权的管理员令牌里 Administrators SID 是「仅拒绝」状态,
# 那条 ACL 不生效 —— 少了这一条,你在普通窗口跑 run.ps1 时 ssh 读不到私钥。
$mySid = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
& icacls $key /inheritance:r /grant:r "*${mySid}:(R)" /grant:r '*S-1-5-18:(R)' /grant:r '*S-1-5-32-544:(R)' | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host '    ⚠️ icacls 设置权限失败,若 ssh 报 "permissions are too open" 手动改' -ForegroundColor Yellow }

Write-Host '==> 5/5 GPU 自检(真的跑一次推理,不只看 import)' -ForegroundColor Cyan
$probe = @'
import sys
sys.path.insert(0, ".")
# 顺序要紧:先 import ocr_server(它在模块顶层就把 CUDA DLL 目录登记进搜索路径),
# 再 import onnxruntime。反过来 ORT 已经加载完了才登记,CUDA EP 会因为找不到
# cudnn/cublas 的 DLL 而注册失败 —— 自检误报"没有 GPU",实际跑服务时是好的。
import ocr_server as S
print("nvidia dll dirs:", len(S._DLL_DIRS))

import onnxruntime as ort
if not hasattr(ort, "get_available_providers"):
    print("ORT_BROKEN: onnxruntime 包是残缺的(命名空间包)。删掉 .venv 重跑 setup.ps1")
    sys.exit(4)
print("onnxruntime", getattr(ort, "__version__", "?"), "device:", ort.get_device())
print("providers:", ort.get_available_providers())

S._warmup()                       # 构造三个 session + 真实推理
ok = S._gpu_active()
print("GPU_ACTIVE:", ok)
print("providers per model:", S._SESSION_PROVIDERS)
sys.exit(0 if ok else 3)
'@
$probe | & $py -
$code = $LASTEXITCODE

Write-Host ''
if ($code -eq 0) {
    Write-Host '✅ GPU 自检通过(det/rec/cls 三个模型都在 CUDA 上)' -ForegroundColor Green
} else {
    Write-Host '❌ GPU 自检失败:三个模型没全部拿到 CUDAExecutionProvider' -ForegroundColor Red
    Write-Host ''
    Write-Host '=============== 自动诊断开始(把这里到结尾全部复制发出来)===============' -ForegroundColor Yellow

    # 诊断脚本写成临时文件再跑:避免 -c 的多层引号转义(踩过一次了)
    $diagPy = Join-Path $env:TEMP 'gc_ocr_diag.py'
    @'
import glob, os, pathlib, sys
sys.path.insert(0, ".")

print("### 1. CUDA DLL 目录(已登记进 PATH + add_dll_directory 的)")
import ocr_server as S
if not S._DLL_DIRS:
    print("  (空)—— site-packages 里找不到任何 CUDA 运行时 DLL")
for d in S._DLL_DIRS:
    dlls = sorted(p.name for p in pathlib.Path(d).glob("*.dll"))
    print(f"  {d}\n     {len(dlls)} 个 dll: {dlls}")

import sysconfig
purelib = pathlib.Path(sysconfig.get_paths()["purelib"])
print("  site-packages:", purelib)
# 在**整个** site-packages 里按名字找 ORT 要的那几个(不限于 nvidia/,cuDNN 就不在那儿)
for want in ("cublasLt64_13.dll", "cublas64_13.dll", "cudart64_13.dll",
             "cudnn64_9.dll", "cudnn_graph64_9.dll", "nvrtc64_130_0.dll"):
    hits = [str(p) for p in purelib.rglob(want)]
    print(f"  {want:22} -> {hits if hits else '★未找到★'}")
print("  所有 cudnn*.dll:", [str(p) for p in purelib.rglob("cudnn*.dll")][:12] or "★一个都没有★")
print("  PATH 前 3 段:", os.environ.get("PATH", "").split(os.pathsep)[:3])

print()
print("### 1b. cudnn 包到底装了哪些文件(问包本身,不靠猜路径)")
from importlib.metadata import distributions
found_cudnn_pkg = False
for dist in distributions():
    name = ((dist.metadata["Name"] if dist.metadata else "") or "").lower()
    if "cudnn" not in name:
        continue
    found_cudnn_pkg = True
    files = [str(f) for f in (dist.files or [])]
    dlls = [f for f in files if f.lower().endswith(".dll")]
    print(f"  {name} {dist.version}: 共 {len(files)} 个文件,其中 {len(dlls)} 个 dll")
    for f in dlls[:8]:
        print("     ", f)
    if not dlls:
        print("     ★这个包没带任何 dll★ —— 可能是只有 Linux 产物的包,或是个 meta 包")
        print("      非 dll 文件抽样:", files[:6])
if not found_cudnn_pkg:
    print("  没有装任何 cudnn 包")

print()
print("### 2. onnxruntime 身份")
import onnxruntime as ort
print("  version:", getattr(ort, "__version__", "?"))
print("  file   :", ort.__file__)
print("  device :", ort.get_device())
print("  providers:", ort.get_available_providers())
capi = os.path.join(os.path.dirname(ort.__file__), "capi")
print("  capi 下的 dll:", sorted(os.path.basename(p) for p in glob.glob(os.path.join(capi, "*.dll")))[:12])

print()
print("### 3. 直接用 CUDA EP 建会话(ORT 自己说原因,日志开到最详细)")
ort.set_default_logger_severity(0)
import rapidocr_onnxruntime as R
model = pathlib.Path(R.__file__).parent / "models" / "ch_PP-OCRv3_det_infer.onnx"
print("  模型:", model, "存在:", model.exists())
try:
    s = ort.InferenceSession(str(model), providers=["CUDAExecutionProvider"])
    print("  RESULT providers:", s.get_providers())
except Exception as e:
    print("  SESSION FAILED:", type(e).__name__, e)
'@ | Set-Content -Path $diagPy -Encoding utf8

    # 全部同时打屏 + 落盘 gpu-diag.txt(屏幕滚太快时可以直接发这个文件)
    $diagFile = Join-Path $PSScriptRoot 'gpu-diag.txt'
    & $py $diagPy 2>&1 | Tee-Object -FilePath $diagFile

    '' | Tee-Object -FilePath $diagFile -Append
    '### 4. pip list(onnxruntime / nvidia 相关)' | Tee-Object -FilePath $diagFile -Append
    (& $py -m pip list | Select-String -Pattern 'onnxruntime|nvidia' | ForEach-Object { $_.Line }) |
        Tee-Object -FilePath $diagFile -Append

    '' | Tee-Object -FilePath $diagFile -Append
    '### 5. nvidia-smi' | Tee-Object -FilePath $diagFile -Append
    (& nvidia-smi 2>&1) | Tee-Object -FilePath $diagFile -Append
    if ($LASTEXITCODE -ne 0) {
        '  nvidia-smi 跑不起来(不在 PATH 或驱动没装好)' | Tee-Object -FilePath $diagFile -Append
    }

    Write-Host ''
    Write-Host '=============== 自动诊断结束 ===============' -ForegroundColor Yellow
    Write-Host "(同样内容已存到 $diagFile —— 屏幕滚太快就直接发这个文件)" -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '不想等 GPU 的话,现在就能用纯 CPU 上线(这台 CPU 稳态 200~400ms/张,够用):' -ForegroundColor Cyan
    Write-Host '  .\run.ps1 -Cpu' -ForegroundColor White
}

Write-Host ''
Write-Host '================ 下一步:把这行贴到服务器 ================' -ForegroundColor Cyan
Write-Host '在服务器(122.51.208.149)上执行一次:' -ForegroundColor Gray
Write-Host '  useradd -m gcocr 2>/dev/null; mkdir -p ~gcocr/.ssh && chmod 700 ~gcocr/.ssh' -ForegroundColor White
Write-Host '  然后把下面这一整行追加进 ~gcocr/.ssh/authorized_keys(chown gcocr: ~gcocr/.ssh -R):' -ForegroundColor Gray
$pub = (Get-Content "$key.pub" -Raw).Trim()
Write-Host ''
Write-Host "restrict,port-forwarding,permitlisten=`"127.0.0.1:8600`" $pub" -ForegroundColor White
Write-Host ''
Write-Host '(restrict 关掉一切,只放开端口转发,且只允许挂 127.0.0.1:8600 —— 这把钥匙除了开这条隧道什么都干不了)' -ForegroundColor DarkGray
Write-Host '装好后:先 .\run.ps1 手动跑一次看通不通,再 .\install-task.ps1 设开机自启' -ForegroundColor Cyan

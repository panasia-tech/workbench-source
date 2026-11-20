"""家用 Windows GPU OCR 微服务 —— 群控服务端 OCR 的**唯一**算力端。

对上游的契约与旧 mac_ocr 完全一致(gc-api 侧 app/flow/ocr.py 的 _ocr_remote 一行都不用改):
  GET  /healthy -> {"ok":true,"gpu":true,"providers":{...},"calls":N,"last_ms":123}
  POST /ocr     -> body = 截图原始字节(PNG/JPG),返回 {"items":[{text,score,box,center}]}
                   请求头 X-OCR-Token 与环境变量 GC_OCR_HTTP_TOKEN 校验(弱鉴权)

为什么算力放这台机器:闲鱼是 Flutter,控件无障碍读不到,流程引擎靠截图 OCR 出「文字+坐标」
做锚点点击;而 Linux 生产机没有 GPU,且 onnxruntime 在其上原生内存只涨不返(~20MB/次,
1~2 小时把 gc-api 撑到 OOM)。这台 i5-14600K + RTX 5070 用 CUDA EP 跑同一批 ONNX 模型。

⚠️ 模型版本钉死 `rapidocr-onnxruntime==1.2.3`(PP-OCRv3 det/cls/rec):
   find() 的锚点匹配(「定价」被长句抢、「确定」被问句抢、卡片标题被营销横幅抢那几个坑)
   是按 v3 的检测框切分与分词行为调出来的。**GPU 只换执行后端(CPU EP → CUDA EP),
   模型和输出结构不变,所以对上游完全无感**;要升 PP-OCRv5 是另一件事,必须先做锚点回归。

启动:见同目录 run.ps1 / README.md
  set GC_OCR_HTTP_TOKEN=xxx
  .venv\\Scripts\\uvicorn ocr_server:app --host 127.0.0.1 --port 8600
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import sys
import threading
import time
from pathlib import Path


# ---------------------------------------------------------------------------
# CUDA DLL 目录:必须在 import onnxruntime 之前登记,所以放在模块最顶上执行
# ---------------------------------------------------------------------------
# CUDA/cuDNN 运行时 DLL 的名字前缀。只有含这些的目录才会被加进搜索路径 ——
# 不能把 site-packages 里所有含 dll 的目录都塞进 PATH(opencv/numpy 等也带 dll,
# 无脑加进去会造成 DLL 抢名,是个能引出灵异问题的坑)。
_CUDA_DLL_PREFIXES = (
    "cublas", "cudart", "cudnn", "cufft", "cufftw", "curand",
    "cusparse", "cusolver", "nvrtc", "nvjitlink", "nvblas",
)


def _add_cuda_dll_dirs() -> list[str]:
    """让 onnxruntime-gpu 找得到 CUDA/cuDNN 的 DLL。pip 装的 nvidia-* 轮子把 DLL 埋在
    site-packages 里,不在搜索路径上 —— 不处理就是 CUDA EP 加载失败 → ORT **只 warn
    一句然后静默回落 CPU**(这也是 startup 要做 GPU 硬自检的原因)。

    两个都踩过的坑,所以这里做法很具体:

    ① **必须写 PATH,不能只靠 os.add_dll_directory()**。add_dll_directory 走的是
       AddDllDirectory,只对「以 LOAD_LIBRARY_SEARCH_* 标志发起的 LoadLibraryEx」生效
       (Python 自己加载扩展模块用的就是这条)。而 ORT 的 C++ 侧用**普通 LoadLibrary**
       加载 onnxruntime_providers_cuda.dll,它的隐式依赖按 Windows 传统搜索顺序解析,
       那条路**不看** AddDllDirectory 的列表、但**看 PATH**。
       2026-08-17 实测:只 add_dll_directory 时,DLL 明明就在已登记的目录里,ORT 照样报
       `depends on "cublasLt64_13.dll" which is missing`。两个机制都要加。

    ② **扫描范围不能写死层级、也不能只扫 nvidia/**。轮子布局变过好几次:
       CUDA 12 是 `nvidia/<lib>/bin/`,CUDA 13 变成 `nvidia/cu13/bin/x86_64/`,
       而 cuDNN 的轮子又不一定落在 `nvidia/` 下面。所以直接在整个 site-packages 里
       递归找,再用 _CUDA_DLL_PREFIXES 过滤出真正是 CUDA 运行时的目录。
    """
    added: list[str] = []
    if sys.platform != "win32":
        return added
    import sysconfig
    purelib = sysconfig.get_paths().get("purelib") or ""
    if not purelib or not Path(purelib).is_dir():
        return added

    dirs: set[Path] = set()
    for dll in Path(purelib).rglob("*.dll"):
        if dll.name.lower().startswith(_CUDA_DLL_PREFIXES):
            dirs.add(dll.parent)

    for d in sorted(dirs):
        s = str(d)
        with contextlib.suppress(OSError):
            os.add_dll_directory(s)          # 给 Python 扩展模块/ctypes 用
        path = os.environ.get("PATH", "")    # 给 ORT 那边的普通 LoadLibrary 用
        if s.lower() not in path.lower():
            os.environ["PATH"] = s + os.pathsep + path
        added.append(s)
    return added


_DLL_DIRS = _add_cuda_dll_dirs()


# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
_TOKEN = os.getenv("GC_OCR_HTTP_TOKEN", "")
_USE_GPU = os.getenv("GC_OCR_USE_GPU", "1") not in ("0", "false", "False", "")
# 默认「要 GPU 就必须真拿到 GPU」:拿不到直接启动失败,而不是悄悄用 CPU 跑(慢 3~5 倍还查不出来)
_REQUIRE_GPU = os.getenv("GC_OCR_REQUIRE_GPU", "1") not in ("0", "false", "False", "")
_GPU_ID = int(os.getenv("GC_OCR_GPU_ID", "0"))
# 手机截图永远不会上下颠倒,方向分类器(cls)纯属白跑;置 0 可省一个模型+一段耗时。
# 默认保持 1 = 与旧 CPU 版行为完全一致(先把链路跑通,变量一次只改一个)。
_USE_ANGLE_CLS = os.getenv("GC_OCR_USE_ANGLE_CLS", "1") not in ("0", "false", "False", "")
# 预热用的合成图尺寸,写真实截图分辨率:CUDA 的 conv 算法搜索是按输入 shape 缓存的,
# 启动时先按真尺寸跑一遍,把一次性开销吃在预热期而不是第一个真请求上。
_WARMUP_SIZE = os.getenv("GC_OCR_WARMUP_SIZE", "1080x2400")
# 进程自杀回收(旧 Linux 弱机遗产)。GPU 版默认关:CUDA 冷启动要 5~10s,
# 而服务端那条路没有兜底,频繁回收等于制造失败窗口。要用就配大一点。
_RECYCLE_CALLS = int(os.getenv("OCR_RECYCLE_CALLS", "0"))

_engine = None
_engine_lock = threading.Lock()   # 单 GPU:识别串行化(ORT session 线程安全,但 rapidocr 的
                                  # 前后处理对象不保证;而且并发抢同一张卡只会互相拖慢)
_SESSION_PROVIDERS: dict[str, list[str]] = {}
_calls = 0
_last_ms = 0.0


# ---------------------------------------------------------------------------
# 把 rapidocr 1.2.3 的推理会话换成「强制 CUDA + 记录真实 provider」的版本
# ---------------------------------------------------------------------------
def _install_cuda_session() -> None:
    """替换 rapidocr_onnxruntime.utils.OrtInferSession。

    为什么不用官方姿势 `RapidOCR(det_use_cuda=True, ...)` —— 1.2.3 的 UpdateParameters 有两个坑,
    这条路根本走不通(读源码确认):
      ① update_rec_params / update_cls_params 只对 `rec_model_path` / `cls_model_path|cls_label_list`
         去 `rec_`/`cls_` 前缀,`rec_use_cuda`/`cls_use_cuda` 会**原样**塞进 config;而
         OrtInferSession 读的是 `config['use_cuda']` → 识别(rec)和方向分类(cls)静默留在 CPU,
         只有检测(det)真的上了 GPU。rec 恰恰是最吃算力的那一步。
      ② 只要传了任意 det_/rec_/cls_ 开头的 kwarg,它就无条件访问 dict['model_path'],
         不一起传 `*_model_path` 直接 KeyError。
    另一条路是改 site-packages 里的 config.yaml(三处 use_cuda: true),但 pip 重装即失效、
    且完全看不见。故在这里显式替换,顺带解决两件事:
      - `cudnn_conv_algo_search` 从 EXHAUSTIVE 降为 HEURISTIC:rec 的输入宽度按 batch 变,
        EXHAUSTIVE 每遇到新 shape 就跑一遍算法穷举,表现为「偶发某个请求莫名卡好几秒」;
      - 记录每个 session 实际拿到的 provider,供 /healthy 与启动自检用。

    时序要求:必须在**第一次构造 RapidOCR 之前**调用。rapidocr 的三个子模块是
    `RapidOCR.__init__` 里用 importlib 懒加载的,它们各自 `from rapidocr_onnxruntime.utils
    import OrtInferSession`(from-import 会在导入时把名字绑到自己模块里),所以先打补丁才有效。
    即便某天这个时序被打破,startup 的 GPU 硬自检也会当场喊出来,不会静默降级。
    """
    from onnxruntime import (GraphOptimizationLevel, InferenceSession, SessionOptions,
                             get_available_providers)
    from rapidocr_onnxruntime import utils as ru

    cuda_ok = "CUDAExecutionProvider" in get_available_providers()

    class _CudaInferSession(ru.OrtInferSession):
        def __init__(self, config):
            opt = SessionOptions()
            # 要 GPU 时把日志开到 warning:CUDA EP 加载失败(缺 cudnn DLL / 算力不匹配)的
            # 原因是 ORT 用日志说出来的,压到 4(fatal)就只剩「怎么就回落 CPU 了」的哑谜。
            opt.log_severity_level = 2 if _USE_GPU else 4
            opt.enable_cpu_mem_arena = False
            opt.graph_optimization_level = GraphOptimizationLevel.ORT_ENABLE_ALL

            eps: list = []
            if _USE_GPU and cuda_ok:
                eps.append(("CUDAExecutionProvider", {
                    "device_id": _GPU_ID,
                    "arena_extend_strategy": "kNextPowerOfTwo",
                    "cudnn_conv_algo_search": "HEURISTIC",
                    "do_copy_in_default_stream": True,
                }))
            eps.append(("CPUExecutionProvider", {"arena_extend_strategy": "kSameAsRequested"}))

            self._verify_model(config["model_path"])
            self.session = InferenceSession(config["model_path"], sess_options=opt, providers=eps)
            _SESSION_PROVIDERS[Path(config["model_path"]).name] = list(self.session.get_providers())

    ru.OrtInferSession = _CudaInferSession


def _get_engine():
    global _engine
    if _engine is None:
        _install_cuda_session()
        from rapidocr_onnxruntime import RapidOCR
        # 只传 Global 段的 kwarg(use_angle_cls);det_/rec_/cls_ 前缀的 kwarg 有上面说的 ① ② 两坑,
        # use_cuda 一律走 _install_cuda_session,不从这里传。
        _engine = RapidOCR(use_angle_cls=_USE_ANGLE_CLS)
    return _engine


def _gpu_active() -> bool:
    """三个 session 是否**全部**拿到了 CUDA。缺一个都算没上 GPU(rec 掉回 CPU 最容易被忽略)。"""
    if not _SESSION_PROVIDERS:
        return False
    return all("CUDAExecutionProvider" in p for p in _SESSION_PROVIDERS.values())


def _warmup() -> None:
    """按真实截图分辨率跑一遍合成图,把 CUDA 上下文 + conv 算法搜索的一次性开销吃在启动期。

    合成图用 ASCII(cv2.putText 画不了中文),目的只是让 det 出框、rec 出 batch,
    把两条 GPU 通路都走通 —— 认得对不对无所谓。
    """
    import cv2
    import numpy as np
    try:
        w, h = (int(x) for x in _WARMUP_SIZE.lower().split("x"))
    except ValueError:
        w, h = 1080, 2400
    img = np.full((h, w, 3), 255, dtype=np.uint8)
    for i, y in enumerate(range(160, min(h - 80, 1400), 220)):
        cv2.putText(img, f"OCR warmup {i} 12345", (60, y),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.4 + 0.2 * (i % 3), (20, 20, 20), 3)
    t0 = time.time()
    _get_engine()(img)
    print(f"[gc-ocr] warmup {w}x{h} 完成 {(time.time() - t0) * 1000:.0f}ms "
          f"gpu={_gpu_active()} providers={_SESSION_PROVIDERS}", flush=True)


def _startup() -> None:
    print(f"[gc-ocr] use_gpu={_USE_GPU} require_gpu={_REQUIRE_GPU} gpu_id={_GPU_ID} "
          f"angle_cls={_USE_ANGLE_CLS} recycle={_RECYCLE_CALLS} dll_dirs={len(_DLL_DIRS)}", flush=True)
    # 把 ORT 的身份信息也打进日志:排查「为什么没上 GPU」时,这三项(装的是哪个 ORT、
    # 它认不认 GPU、编进去了哪些 EP)基本能直接定位,免得再去手敲探测命令。
    try:
        import onnxruntime as ort
        print(f"[gc-ocr] onnxruntime={getattr(ort, '__version__', '?')} "
              f"device={ort.get_device()} providers={ort.get_available_providers()}", flush=True)
        if _DLL_DIRS:
            print(f"[gc-ocr] cuda dll dirs={_DLL_DIRS}", flush=True)
    except Exception as e:  # noqa: BLE001 —— 诊断信息拿不到也不该挡住启动
        print(f"[gc-ocr] onnxruntime 信息读取失败: {e!r}", flush=True)
    _warmup()
    if _USE_GPU and _REQUIRE_GPU and not _gpu_active():
        # 宁可起不来,也不要「以为在跑 GPU、其实在 CPU 上慢慢跑」
        raise RuntimeError(
            "要求 GPU 但没拿到 CUDAExecutionProvider(已静默回落 CPU)。"
            f" 实际 providers={_SESSION_PROVIDERS};nvidia dll 目录={_DLL_DIRS or '未找到'}。"
            " 排查:① pip list 里应是 onnxruntime-gpu(不能同时装 onnxruntime);"
            " ② python -c \"import onnxruntime;print(onnxruntime.get_available_providers())\";"
            " ③ nvidia-smi 驱动版本是否够新(RTX 5070/Blackwell 需要 CUDA 12.8+ 的运行时);"
            " ④ 只想先用 CPU 跑通就设 GC_OCR_REQUIRE_GPU=0 GC_OCR_USE_GPU=0"
        )


@contextlib.asynccontextmanager
async def _lifespan(app):
    _startup()
    yield


# fastapi 的 import 放在 CUDA DLL 登记之后(顺序无强制要求,但保持「先环境后框架」的可读性)
from fastapi import FastAPI, Header, HTTPException, Request  # noqa: E402

app = FastAPI(title="GC Win GPU OCR", lifespan=_lifespan)


def _maybe_recycle() -> None:
    global _calls
    _calls += 1
    if _RECYCLE_CALLS and _calls >= _RECYCLE_CALLS:
        # 等响应发完再退;由 run.ps1 的守护循环拉起(Windows 没有 systemd)
        threading.Timer(0.8, os._exit, args=(0,)).start()


@app.get("/healthy")
def healthy() -> dict:
    return {
        "ok": True,
        "engine": "rapidocr_onnxruntime==1.2.3 (PP-OCRv3)",
        "gpu": _gpu_active(),
        "providers": _SESSION_PROVIDERS,
        "angle_cls": _USE_ANGLE_CLS,
        "calls": _calls,
        "last_ms": round(_last_ms, 1),
    }


def _run_ocr(png: bytes) -> list[dict]:
    """解码 + 识别 + 转成上游要的结构。在工作线程里跑(见 /ocr),识别本身由锁串行化。"""
    global _last_ms
    import cv2
    import numpy as np
    arr = np.frombuffer(png, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="decode failed(不是有效图片?)")

    t0 = time.time()
    with _engine_lock:
        result, _ = _get_engine()(img)
    _last_ms = (time.time() - t0) * 1000

    items = []
    for box, text, score in (result or []):
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        items.append({
            "text": text,
            "score": float(score),
            # box 里是 numpy 类型,转成纯 float 才能 JSON 序列化
            "box": [[float(p[0]), float(p[1])] for p in box],
            "center": [int(sum(xs) / 4), int(sum(ys) / 4)],
        })
    return items


@app.post("/ocr")
async def ocr(request: Request, x_ocr_token: str = Header(default="")) -> dict:
    if _TOKEN and x_ocr_token != _TOKEN:
        raise HTTPException(status_code=401, detail="bad token")
    png = await request.body()
    if not png:
        raise HTTPException(status_code=400, detail="empty body")
    # 丢到工作线程:识别是纯 CPU/GPU 阻塞活,放事件循环里跑会把 /healthy 一起堵死
    # (隧道探活和监控都要靠 /healthy 秒回)。
    items = await asyncio.to_thread(_run_ocr, png)
    _maybe_recycle()
    return {"items": items}

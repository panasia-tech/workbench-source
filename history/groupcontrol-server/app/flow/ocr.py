"""服务端 OCR:唯一路径 = 远程 GPU OCR 微服务(家用 Windows,经 SSH 反向隧道回本机)。

从截图字节识别文字+坐标,供 Engine 做锚点定位(闲鱼是 Flutter,大量控件无障碍读不到,
只能截图 OCR 出「文字 + 坐标」再点)。

【2026-08-17 收敛为单一路径】这里历史上并存过四条路,现已全部下掉只留远程 8600:
- 石榴(shiliuai)/ zndjs 两家**付费云 OCR** —— 不再产生调用费;
- **服务器本机 RapidOCR** —— Linux 生产机没 GPU,且 onnxruntime 在其上原生内存只涨不返
  (实测 ~20MB/次,1~2 小时把 gc-api 撑到 OOM,连带杀掉正在跑的任务)。
算力端换成一台家用 Windows(RTX 5070,CUDA 跑同一批 PP-OCRv3 ONNX 模型),`ssh -R` 把它的
127.0.0.1:8600 反挂到本机 127.0.0.1:8600 —— 家宽没有公网 IP/端口映射,靠出网的 SSH 连接
反向打洞,服务器侧不新开任何公网端口。部署见 `groupcontrol-server/win_ocr/README.md`。

**「没有兜底」是刻意的**,不是漏写:那台 Windows 或隧道一挂,ocr() 直接抛错、流程判失败。
别再悄悄加回落引擎 —— 静默换引擎会改变检测框的切分与分词,而 find() 的锚点匹配是按
PP-OCRv3 的行为一次次踩坑调出来的(见 find() 注释里的三个案例),换引擎等于全流程锚点重验。

配置走 pydantic settings(从 .env 读)——**不用 os.getenv**:生产 systemd 不注入环境变量,
os.getenv 恒为 None(旧服务器靠 env 注入才生效,迁移后失效,曾致静默回退本机 OCR)。
  GC_OCR_HTTP_URL=http://127.0.0.1:8600/ocr   # 必填,留空直接抛错
  GC_OCR_HTTP_TOKEN=...                        # 与 Windows 侧同值的弱鉴权(请求头 X-OCR-Token)
  GC_OCR_HTTP_TIMEOUT=30                       # 单次识别超时(秒)
  GC_OCR_HTTP_RETRIES / GC_OCR_HTTP_RETRY_SLEEP  # 连接级失败重试预算
"""

from __future__ import annotations


def _ocr_remote(png: bytes, url: str, token: str = "", timeout: float = 30.0,
                retries: int = 5, retry_sleep: float = 2.0) -> list[dict]:
    """把截图 POST 给远程 OCR 微服务,返回 [{text,score,box,center}]。标准库 urllib,零新依赖。

    只重试**连接级**失败(算力端进程重启 / 家宽抖动 / 隧道重连)。重试预算要盖过
    Windows 侧 uvicorn 被 run.ps1 拉起并预热 CUDA 的窗口(约 5~10s:CUDA 上下文 + 首帧
    conv 算法搜索),又不能太长——这条路没有兜底,拖长只是让整条流程更晚失败:
    默认 5 次 × 2s ≈ 10s。
    (历史值是 8 次 × 5s = 40s,那是为旧 Linux 弱机「每 25 次调用自杀回收 + 20~40s 冷启动」
     定的;Windows 侧不做自杀回收,故收窄。)
    """
    import json
    import time
    import urllib.error
    import urllib.request
    headers = {"Content-Type": "application/octet-stream"}
    if token:
        headers["X-OCR-Token"] = token
    attempts = max(1, retries)
    last_err = None
    for attempt in range(attempts):
        req = urllib.request.Request(url, data=png, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as e:
            # 4xx 是配置/请求问题(401=两侧 token 不一致、400=图片解不开),重试到天亮也一样,
            # 立刻抛出免得白等一整个重试预算。5xx 才当临时故障重试。
            if 400 <= e.code < 500:
                raise RuntimeError(
                    f"远程 GPU OCR 拒绝请求({url},HTTP {e.code} {e.reason})"
                    " —— 401 多半是 GC_OCR_HTTP_TOKEN 两侧不一致;400 是截图字节不是有效图片"
                ) from e
            last_err = e
            if attempt < attempts - 1:
                time.sleep(retry_sleep)
        except Exception as e:  # noqa: BLE001 —— 连接级失败统一重试
            last_err = e
            if attempt < attempts - 1:
                time.sleep(retry_sleep)
    else:
        raise RuntimeError(
            f"远程 GPU OCR 调用失败({url},{attempts} 次): {last_err}"
            " —— 排查顺序:① 那台 Windows 是否开机/未睡眠;② ssh -R 隧道是否在"
            "(服务器上 curl http://127.0.0.1:8600/healthy);③ token 是否两侧一致"
        ) from last_err
    items = data.get("items", data) if isinstance(data, dict) else data
    # center 可能被 JSON 转成 list,统一成 tuple
    for it in items:
        c = it.get("center")
        if isinstance(c, list):
            it["center"] = (int(c[0]), int(c[1]))
    return items


def ocr(png: bytes) -> list[dict]:
    """返回 [{text, score, box(4点), center:(x,y)}]。只有远程 GPU 微服务这一条路(见模块 docstring)。"""
    from app.config import settings
    s = settings
    if not s.gc_ocr_http_url:
        raise RuntimeError(
            "未配置 GC_OCR_HTTP_URL:服务端 OCR 只走远程 GPU 微服务,没有本机/云端兜底。"
            " 在 .env 里配 GC_OCR_HTTP_URL=http://127.0.0.1:8600/ocr(部署见 win_ocr/README.md)"
        )
    return _ocr_remote(
        png, s.gc_ocr_http_url, s.gc_ocr_http_token, s.gc_ocr_http_timeout,
        s.gc_ocr_http_retries, s.gc_ocr_http_retry_sleep,
    )


def find(items: list[dict], target: str, contains: bool = True) -> dict | None:
    """在识别结果里找匹配文字。**精确匹配优先**，其次才按置信度取。

    为什么不能只按 score 排（已三次栽在这，全是同一个模式）：
      ① 定价面板找「定价」→ 命中标题「定价」和长句「补充更多信息，帮你智能定价」(score 0.863)，
         长句胜出 → 基准线被拉到价格下方 → 售价读回恒空，把填对的价格判成失败；
      ② 下架确认框找「确定」→ 命中按钮「确定」和问句「确定要下架这个宝贝吗？」，
         问句胜出 → 点到标题文字上，弹层不动 → 下架静默失效；
      ③ 同理还坑过其他短词锚点。
    OCR 对长句的置信度普遍高于两三个字的按钮，而我们要找的锚点几乎总是那个短的。
    故：存在「文本恰好等于 target」的候选时只在其中选，没有才退回包含匹配。
    """
    if contains:
        cands = [it for it in items if target in it["text"]]
    else:
        cands = [it for it in items if it["text"].strip() == target]
    if not cands:
        return None
    exact = [it for it in cands if it["text"].strip() == target]
    return max(exact or cands, key=lambda it: it["score"])

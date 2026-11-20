"""闲鱼图片右下角平台水印去除(销售工作台 V1 第 9 项 / E02,2026-11-10)。

爬虫同款图里有不少是闲鱼的图,右下角带闲鱼平台水印:一个白底圆角「闲鱼」小标,下面一行白字
「闲鱼号:用户名」,整体右对齐。这里只认这一种(样式固定,能定得很准):
- 定位:两块模板匹配——先在右下角找「闲鱼」小标(多尺度,TM_CCOEFF_NORMED),再按小标的尺寸
  在它正下方找「闲鱼号:」三个字,那一行从「闲」字起、到小标右边止。不靠 OCR、不扫整张图的白字,
  商品本身的字和标识不会被当成水印;两块都对上才动手,只对上一块当没认出。
- 去除:只补小标和那一行两个矩形(各外扩一圈盖住阴影/压缩毛边),用开源 LaMa 补图模型
  (Apache-2.0,ONNX 版 Carve/LaMa-ONNX,CPU 跑,单张约 2 秒,进程约 1 GB 内存)。
  只把补好的这两块贴回去,其余像素一个不改。OpenCV 自带的 inpaint(Telea/NS)在布纹、
  磨砂这类有纹理的背景上会糊成一团白雾,11-10 九张样本对比过,不用。
- 检查:补完在原位置再匹配一次小标和「闲鱼号」,分数还高 = 有残留;补的地方和周围一圈比颜色、
  纹理,差太多(补出灰块、糊一片)= 画质存疑。任一不过 → needs_review,交给人看。
- 没认出(老样式「闲鱼@xxx」一行字、被别的贴纸挡了、根本没水印)→ not_found,原样不动。

原图不覆盖:处理后的图另存一份,旁边放一个同名 .json 记来源、区域、检查结果、谁点的。
去水印后的图和原图算同一张:不能拿来充当「各号图片不同」(上架图判重按 dHash,水印只占一角,
去前去后 dHash 基本一样,本来也判得出来;记录里 same_image_as 写的就是原图地址)。

依赖都是可选的:numpy、opencv-python-headless、onnxruntime 没装或模型文件不在,
available() 说明缺什么,接口返回 503,不影响 ERP 其他功能。
模型文件不进 git(*.onnx 已忽略),默认放 server/models/lama_fp32.onnx,
可用环境变量 DEWATERMARK_MODEL_PATH 改。

生产上补图在京东云跑(11-10):配了 DEWATERMARK_REMOTE_URL 时,定位 → 补图 → 检查整段交给那边的
dewatermark_service(就是把本文件原样拷过去用 process()),ERP 只取图、存图、写记录,不用装依赖。
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import httpx

try:
    from app.config import settings
except ImportError:  # 京东云上单独跑补图(dewatermark_service)时没有 ERP 配置,只用 process()
    settings = None

logger = logging.getLogger("dewatermark")

MODEL_URL = "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx"
MODEL_SHA256 = "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6"  # 208,044,816 字节
MODEL_PATH = os.environ.get("DEWATERMARK_MODEL_PATH") or str(
    Path(__file__).resolve().parents[2] / "models" / "lama_fp32.onnx"
)
# 推理线程数:生产 4 核,留一半给接口
THREADS = int(os.environ.get("DEWATERMARK_THREADS") or 2)
# 模型闲置这么久就卸掉,省下约 1 GB 内存(下一次用再加载,约 1 秒)
IDLE_RELEASE_SECONDS = 600

# 定位阈值(11-10 样本:9 张闲鱼水印图小标 0.72~0.92;约 900 张非闲鱼图最高 0.69)
LOGO_SURE = 0.80
LOGO_MIN = 0.70
PREFIX_MIN = 0.50
PREFIX_WHEN_LOGO_WEAK = 0.60
# 补完再匹配,超过算残留
RESIDUAL_MAX = 0.45
# 补的地方和周围一圈的平均色差(Lab ΔE)超过算「补出色块」
COLOR_SHIFT_MAX = 14.0
# 周围有纹理(细节强度 > 5)而补的地方细节不到周围的这个比例,算「糊了」。
# 11-10 样本:LaMa 0.48~0.98;OpenCV Telea/NS 在布纹上 0.05~0.14
TEXTURE_MIN = 5.0
FLAT_RATIO_MIN = 0.35
# 定位在长边 ≤ 1280 的缩小图上做
DETECT_LONG_EDGE = 1280
MAX_IMAGE_BYTES = 15 * 1024 * 1024
MAX_PIXELS = 40_000_000
# 补图外扩:小标按小标高、那行字按字高
PAD_LOGO = 0.30
PAD_LINE = 0.30

NOT_FOUND = "not_found"
DONE = "done"
NEEDS_REVIEW = "needs_review"
FAILED = "failed"
STATUS_CN = {
    DONE: "已去水印",
    NEEDS_REVIEW: "去过了,但要人看一眼",
    NOT_FOUND: "没认出闲鱼水印,原图没动",
    FAILED: "处理失败,交给人工",
}

# 模板:取自 11-10 一张纯色背景的闲鱼图(800 宽),灰度 PNG。小标 80×44,「闲鱼号:」91×29
_TPL_LOGO_W = 80.0
_TPL_LOGO_B64 = (
    "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")
_TPL_PREFIX_B64 = (
    "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")


class DewatermarkUnavailable(RuntimeError):
    """服务器没装依赖或没放模型。"""


class SourceNotAllowed(ValueError):
    """只处理我们图床和爬虫上的图。"""


@dataclass
class Region:
    kind: str  # logo「闲鱼」小标 / account_line「闲鱼号:xxx」那行
    box: list[int]  # x, y, w, h(原图像素)
    score: float

    def as_dict(self) -> dict:
        return {"kind": self.kind, "box": list(self.box), "score": round(float(self.score), 3)}


@dataclass
class Result:
    status: str
    regions: list[Region] = field(default_factory=list)
    checks: dict = field(default_factory=dict)
    reasons: list[str] = field(default_factory=list)
    image: bytes | None = None  # 处理后的 JPEG;没动就是 None
    width: int = 0
    height: int = 0
    elapsed_ms: int = 0

    def summary(self) -> dict:
        return {
            "status": self.status,
            "status_label": STATUS_CN[self.status],
            "regions": [r.as_dict() for r in self.regions],
            "checks": self.checks,
            "reasons": list(self.reasons),
            "width": self.width,
            "height": self.height,
            "elapsed_ms": self.elapsed_ms,
        }


# ── 依赖与模型 ────────────────────────────────────────────────────────────────

def _libs():
    try:
        import cv2  # noqa: F401
        import numpy  # noqa: F401
    except ImportError as exc:
        raise DewatermarkUnavailable("服务器没装 numpy / opencv-python-headless") from exc
    import cv2
    import numpy as np

    return cv2, np


def available() -> tuple[bool, str]:
    """(能不能用, 不能用的原因)。给前端决定按钮显不显示。"""
    if _remote_base():
        return _remote_available()
    try:
        _libs()
    except DewatermarkUnavailable as exc:
        return False, str(exc)
    try:
        import onnxruntime  # noqa: F401
    except ImportError:
        return False, "服务器没装 onnxruntime"
    if not os.path.isfile(MODEL_PATH):
        return False, f"去水印模型没放:{MODEL_PATH}"
    return True, ""


_session = None
_session_lock = threading.Lock()  # 一个进程同一时间只跑一张,别把 4 核占满
_release_timer: threading.Timer | None = None


def _release_session() -> None:
    global _session
    with _session_lock:
        _session = None
    logger.info("去水印模型闲置 %s 秒,已卸载", IDLE_RELEASE_SECONDS)


def _lama_run(image_512, mask_512):
    """跑一次 LaMa:image (1,3,512,512) 0~1、mask (1,1,512,512) 0/1 → (512,512,3) RGB 0~255。"""
    global _session, _release_timer
    with _session_lock:
        if _session is None:
            try:
                import onnxruntime as ort
            except ImportError as exc:
                raise DewatermarkUnavailable("服务器没装 onnxruntime") from exc
            if not os.path.isfile(MODEL_PATH):
                raise DewatermarkUnavailable(f"去水印模型没放:{MODEL_PATH}")
            so = ort.SessionOptions()
            so.intra_op_num_threads = THREADS
            so.inter_op_num_threads = 1
            _session = ort.InferenceSession(MODEL_PATH, so, providers=["CPUExecutionProvider"])
            logger.info("去水印模型已加载 %s", MODEL_PATH)
        out = _session.run(None, {"image": image_512, "mask": mask_512})[0][0]
        if _release_timer is not None:
            _release_timer.cancel()
        _release_timer = threading.Timer(IDLE_RELEASE_SECONDS, _release_session)
        _release_timer.daemon = True
        _release_timer.start()
    out = out.transpose(1, 2, 0)
    if out.max() <= 1.5:  # 有的导出版本输出 0~1
        out = out * 255.0
    return out


# ── 定位 ──────────────────────────────────────────────────────────────────────

_templates: dict[str, object] = {}


def _template(name: str):
    cv2, np = _libs()
    if name not in _templates:
        raw = base64.b64decode(_TPL_LOGO_B64 if name == "logo" else _TPL_PREFIX_B64)
        _templates[name] = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_GRAYSCALE).astype(np.float32)
    return _templates[name]


def _best_match(roi, tpl, scales):
    """多尺度模板匹配,返回 (分数, (x, y, w, h)),x/y 相对 roi。"""
    cv2, np = _libs()
    best = (-1.0, (0, 0, 0, 0))
    roi = roi.astype(np.float32)
    for s in scales:
        t = cv2.resize(tpl, None, fx=s, fy=s, interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
        th, tw = t.shape[:2]
        if tw < 16 or th < 8 or th >= roi.shape[0] or tw >= roi.shape[1]:
            continue
        r = cv2.matchTemplate(roi, t, cv2.TM_CCOEFF_NORMED)
        _, mx, _, loc = cv2.minMaxLoc(r)
        if mx > best[0]:
            best = (float(mx), (int(loc[0]), int(loc[1]), tw, th))
    return best


def _find_logo(gray):
    cv2, np = _libs()
    h, w = gray.shape[:2]
    short = min(h, w)
    x0, y0 = int(w * 0.55), int(h * 0.6)
    tpl = _template("logo")
    widths = np.linspace(0.06, 0.14, 17) * short
    score, (x, y, bw, bh) = _best_match(gray[y0:, x0:], tpl, [lw / tpl.shape[1] for lw in widths])
    return score, (x + x0, y + y0, bw, bh)


def _find_prefix(gray, logo):
    """在小标正下方找「闲鱼号:」,尺寸按小标换算(上下各放 20%)。"""
    cv2, np = _libs()
    h, w = gray.shape[:2]
    lx, ly, lw, lh = logo
    y0, y1 = ly + lh, min(h, int(ly + lh + 1.5 * lh))
    x0, x1 = max(0, int(lx + lw - 0.95 * w)), min(w, int(lx + lw + 0.2 * lh))
    if y1 - y0 < 8 or x1 - x0 < 16:
        return -1.0, (0, 0, 0, 0)
    s0 = lw / _TPL_LOGO_W
    score, (x, y, bw, bh) = _best_match(gray[y0:y1, x0:x1], _template("prefix"), s0 * np.linspace(0.8, 1.25, 10))
    return score, (x + x0, y + y0, bw, bh)


def detect(img) -> tuple[list[Region] | None, dict]:
    """找闲鱼水印。返回 (区域 | None, 打分明细)。img 是 BGR。"""
    cv2, np = _libs()
    h, w = img.shape[:2]
    scale = min(1.0, DETECT_LONG_EDGE / max(h, w))
    small = img if scale >= 1.0 else cv2.resize(img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    logo_score, logo = _find_logo(gray)
    info = {"logo_score": round(logo_score, 3)}
    if logo_score < LOGO_MIN:
        return None, info
    prefix_score, prefix = _find_prefix(gray, logo)
    info["prefix_score"] = round(prefix_score, 3)
    need = PREFIX_MIN if logo_score >= LOGO_SURE else PREFIX_WHEN_LOGO_WEAK
    if prefix_score < need:
        return None, info
    lx, ly, lw, lh = logo
    px, py, pw, ph = prefix
    right = min(gray.shape[1], int(lx + lw + 0.1 * lh))
    if px + pw > right:  # 「闲鱼号」跑到小标右边去了,不是那个排版
        return None, info
    back = 1.0 / scale

    def up(box):
        return [int(round(v * back)) for v in box]

    regions = [
        Region("logo", up((lx, ly, lw, lh)), logo_score),
        Region("account_line", up((px, py, right - px, ph)), prefix_score),
    ]
    return regions, info


def build_mask(shape, regions: list[Region]):
    cv2, np = _libs()
    h, w = shape[:2]
    mask = np.zeros((h, w), np.uint8)
    for r in regions:
        x, y, bw, bh = r.box
        pad = max(3, int((PAD_LOGO if r.kind == "logo" else PAD_LINE) * bh))
        cv2.rectangle(mask, (max(0, x - pad), max(0, y - pad)), (min(w - 1, x + bw + pad), min(h - 1, y + bh + pad)), 255, -1)
    return mask


# ── 补图 ──────────────────────────────────────────────────────────────────────

def inpaint(img, mask):
    """LaMa 补 mask 里的像素:按 mask 外接框带一圈上下文裁出来,缩到 512 跑,再贴回 mask 里那部分。"""
    cv2, np = _libs()
    h, w = img.shape[:2]
    ys, xs = np.where(mask > 0)
    bx0, bx1, by0, by1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
    bw, bh = bx1 - bx0, by1 - by0
    margin = int(max(bh * 0.6, bw * 0.12, 24))
    X0, X1 = max(0, bx0 - margin), min(w, bx1 + margin)
    Y0, Y1 = max(0, by0 - margin), min(h, by1 + margin)
    need = int((X1 - X0) * 0.5)  # 上下文别太扁
    if Y1 - Y0 < need:
        extra = need - (Y1 - Y0)
        Y0 = max(0, Y0 - extra // 2)
        Y1 = min(h, Y1 + extra - extra // 2)
    crop = img[Y0:Y1, X0:X1]
    mcrop = mask[Y0:Y1, X0:X1]
    ch, cw = crop.shape[:2]
    s = 512.0 / max(ch, cw)
    nw, nh = max(8, min(512, round(cw * s))), max(8, min(512, round(ch * s)))
    ci = cv2.resize(crop, (nw, nh), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
    mi = (cv2.resize(mcrop, (nw, nh), interpolation=cv2.INTER_NEAREST) > 0).astype(np.float32)
    ci = cv2.copyMakeBorder(ci, 0, 512 - nh, 0, 512 - nw, cv2.BORDER_REFLECT)
    mi = cv2.copyMakeBorder(mi, 0, 512 - nh, 0, 512 - nw, cv2.BORDER_CONSTANT, value=0)
    inp = cv2.cvtColor(ci, cv2.COLOR_BGR2RGB).astype(np.float32).transpose(2, 0, 1)[None] / 255.0
    out = _lama_run(inp, mi[None, None])
    out = cv2.cvtColor(np.clip(out, 0, 255).astype(np.uint8), cv2.COLOR_RGB2BGR)[:nh, :nw]
    out = cv2.resize(out, (cw, ch), interpolation=cv2.INTER_CUBIC)
    inside = (mcrop > 0).astype(np.float32)
    # 边上羽化 1 像素免得出硬边;羽化只往 mask 里收,mask 外一个像素不改
    soft = np.minimum(cv2.GaussianBlur(inside, (0, 0), 1.0) * 2.0, 1.0) * inside
    soft = soft[..., None]
    res = img.copy()
    res[Y0:Y1, X0:X1] = (out * soft + crop * (1.0 - soft)).round().clip(0, 255).astype(np.uint8)
    return res


# ── 检查 ──────────────────────────────────────────────────────────────────────

def _score_at(gray, tpl, box) -> float:
    """在 box 附近(外扩半个框)按 box 的尺寸匹配一次模板。"""
    cv2, np = _libs()
    x, y, bw, bh = box
    if bw < 4 or bh < 4:
        return 0.0
    t = cv2.resize(tpl, (bw, bh), interpolation=cv2.INTER_AREA)
    h, w = gray.shape[:2]
    mx, my = bw // 2 + 2, bh // 2 + 2
    roi = gray[max(0, y - my):min(h, y + bh + my), max(0, x - mx):min(w, x + bw + mx)].astype(np.float32)
    if roi.shape[0] <= bh or roi.shape[1] <= bw:
        return 0.0
    r = cv2.matchTemplate(roi, t, cv2.TM_CCOEFF_NORMED)
    return float(np.nan_to_num(r).max())


def check(before, after, mask, regions: list[Region]) -> tuple[dict, list[str]]:
    """残留、画质、有没有改到水印以外。返回 (明细, 不过的原因)。"""
    cv2, np = _libs()
    reasons: list[str] = []
    gray = cv2.cvtColor(after, cv2.COLOR_BGR2GRAY)
    logo = next(r for r in regions if r.kind == "logo")
    line = next(r for r in regions if r.kind == "account_line")
    logo_after = _score_at(gray, _template("logo"), logo.box)
    # 「闲鱼号:」只占那行开头一段:按小标比例换算模板宽
    pw = int(round(logo.box[2] / _TPL_LOGO_W * _template("prefix").shape[1]))
    prefix_after = _score_at(gray, _template("prefix"), [line.box[0], line.box[1], pw, line.box[3]])
    residual_ok = logo_after < RESIDUAL_MAX and prefix_after < RESIDUAL_MAX
    if not residual_ok:
        reasons.append("原位置还认得出水印(残留)")

    # 补的地方 vs 周围一圈:色差、纹理
    lh = logo.box[3]
    k = max(5, int(lh * 0.8)) | 1
    ring = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))) & ~mask
    lab = cv2.cvtColor(after, cv2.COLOR_BGR2LAB).astype(np.float32)
    lab[..., 0] *= 100.0 / 255.0
    lab[..., 1:] -= 128.0
    m_in, m_ring = mask > 0, ring > 0
    color_shift = float(np.linalg.norm(lab[m_in].mean(0) - lab[m_ring].mean(0))) if m_ring.any() else 0.0
    # 细节强度:亮度减去轻微模糊后的绝对值(布纹、颗粒这些);补的地方去掉贴边一圈再算
    light = cv2.cvtColor(after, cv2.COLOR_BGR2LAB)[..., 0].astype(np.float32)
    detail = np.abs(light - cv2.GaussianBlur(light, (0, 0), 1.5))
    core = cv2.erode(mask, np.ones((3, 3), np.uint8)) > 0
    tex_in = float(detail[core].mean()) if core.any() else 0.0
    tex_ring = float(detail[m_ring].mean()) if m_ring.any() else 0.0
    texture_ratio = tex_in / tex_ring if tex_ring > 1e-3 else None
    flat = tex_ring > TEXTURE_MIN and texture_ratio is not None and texture_ratio < FLAT_RATIO_MIN
    if color_shift > COLOR_SHIFT_MAX:
        reasons.append("补的地方颜色和周围差得多(可能补出了色块)")
    if flat:
        reasons.append("补的地方比周围平得多(可能糊了)")

    # 水印以外一个像素都不该变
    changed = np.any(before != after, axis=2) & (mask == 0)
    outside = int(changed.sum())
    if outside:
        reasons.append(f"水印以外改动了 {outside} 个像素")
    return {
        "logo_score_after": round(logo_after, 3),
        "prefix_score_after": round(prefix_after, 3),
        "residual_ok": residual_ok,
        "color_shift": round(color_shift, 1),
        "texture_ratio": round(texture_ratio, 2) if texture_ratio is not None else None,
        "texture_around": round(tex_ring, 1),
        "quality_ok": color_shift <= COLOR_SHIFT_MAX and not flat,
        "changed_outside_mask": outside,
        "mask_ratio": round(float(m_in.mean()), 4),
    }, reasons


# ── 入口 ──────────────────────────────────────────────────────────────────────

def decode(content: bytes):
    cv2, np = _libs()
    if not content or len(content) > MAX_IMAGE_BYTES:
        raise ValueError(f"图片大小不对:{len(content or b'')} 字节")
    img = cv2.imdecode(np.frombuffer(content, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("不是能识别的图片")
    if img.shape[0] * img.shape[1] > MAX_PIXELS:
        raise ValueError("图片像素太多")
    return img


def process(content: bytes) -> Result:
    """一张图走一遍:定位 → 补图 → 检查。没认出水印不动原图。缺依赖/模型抛 DewatermarkUnavailable。"""
    cv2, np = _libs()
    t0 = time.monotonic()
    try:
        img = decode(content)
    except ValueError as exc:
        return Result(FAILED, reasons=[str(exc)], elapsed_ms=int((time.monotonic() - t0) * 1000))
    h, w = img.shape[:2]
    regions, info = detect(img)
    if not regions:
        return Result(NOT_FOUND, checks={"detect": info}, reasons=["没认出「闲鱼」小标 + 「闲鱼号」那一行"],
                      width=w, height=h, elapsed_ms=int((time.monotonic() - t0) * 1000))
    mask = build_mask(img.shape, regions)
    try:
        out = inpaint(img, mask)
    except DewatermarkUnavailable:
        raise
    except Exception as exc:  # noqa: BLE001 - 模型出错也给人一个结果
        logger.exception("去水印补图出错")
        return Result(FAILED, regions=regions, checks={"detect": info}, reasons=[f"补图出错:{exc}"],
                      width=w, height=h, elapsed_ms=int((time.monotonic() - t0) * 1000))
    checks, reasons = check(img, out, mask, regions)
    checks["detect"] = info
    ok, buf = cv2.imencode(".jpg", out, [cv2.IMWRITE_JPEG_QUALITY, 95])
    if not ok:
        return Result(FAILED, regions=regions, checks=checks, reasons=["编码 JPEG 失败"], width=w, height=h,
                      elapsed_ms=int((time.monotonic() - t0) * 1000))
    return Result(NEEDS_REVIEW if reasons else DONE, regions=regions, checks=checks, reasons=reasons,
                  image=buf.tobytes(), width=w, height=h, elapsed_ms=int((time.monotonic() - t0) * 1000))


# ── 京东云远程补图 ────────────────────────────────────────────────────────────

# 远程能不能用缓存一会儿:前端每次打开都问,别每次都去敲京东云
REMOTE_HEALTH_TTL = 60
# 模型冷启动约 1 秒、单张 3~8 秒;两个人同时点要排队
REMOTE_TIMEOUT = httpx.Timeout(90.0, connect=5.0)
_remote_health: tuple[float, bool, str] | None = None


def _remote_base() -> str:
    return (settings.dewatermark_remote_url if settings is not None else "").strip().rstrip("/")


def _remote_headers() -> dict:
    return {"Authorization": f"Bearer {settings.dewatermark_remote_token}"}


def _remote_available() -> tuple[bool, str]:
    global _remote_health
    now = time.monotonic()
    if _remote_health and now - _remote_health[0] < REMOTE_HEALTH_TTL:
        return _remote_health[1], _remote_health[2]
    try:
        with httpx.Client(timeout=httpx.Timeout(5.0)) as c:
            resp = c.get(f"{_remote_base()}/health", headers=_remote_headers())
        resp.raise_for_status()
        data = resp.json()
        ok, reason = bool(data.get("available")), str(data.get("reason") or "")
    except Exception as exc:  # noqa: BLE001 - 连不上就是不能用
        ok, reason = False, f"京东云去水印服务连不上:{exc.__class__.__name__}"
    _remote_health = (now, ok, reason)
    return ok, reason


def to_wire(result: Result) -> dict:
    """京东云那边回给 ERP 的样子:summary 加处理后的图(base64)。"""
    return {**result.summary(), "image_b64": base64.b64encode(result.image).decode() if result.image else None}


def from_wire(data: dict) -> Result:
    image = data.get("image_b64")
    return Result(
        data["status"],
        regions=[Region(r["kind"], list(r["box"]), float(r["score"])) for r in data.get("regions") or []],
        checks=data.get("checks") or {},
        reasons=list(data.get("reasons") or []),
        image=base64.b64decode(image) if image else None,
        width=int(data.get("width") or 0),
        height=int(data.get("height") or 0),
        elapsed_ms=int(data.get("elapsed_ms") or 0),
    )


def process_remote(content: bytes) -> Result:
    """把图片字节交给京东云补。连不上 / 那边没装好算「暂不可用」(503),不当成取图失败。"""
    try:
        with httpx.Client(timeout=REMOTE_TIMEOUT) as c:
            resp = c.post(f"{_remote_base()}/process", content=content,
                          headers={**_remote_headers(), "Content-Type": "application/octet-stream"})
    except httpx.HTTPError as exc:
        raise DewatermarkUnavailable(f"京东云去水印服务连不上:{exc.__class__.__name__}") from exc
    if resp.status_code != 200:
        try:
            detail = resp.json().get("detail")
        except ValueError:
            detail = None
        raise DewatermarkUnavailable(f"京东云去水印服务出错:{detail or f'HTTP {resp.status_code}'}")
    try:
        return from_wire(resp.json())
    except (ValueError, KeyError, TypeError) as exc:
        raise DewatermarkUnavailable("京东云去水印服务回的东西看不懂") from exc


def allowed_hosts() -> set[str]:
    """能拿来处理的图:我们图床(公开域名/桶域名)和图片爬虫。别的地址一律不取(防 SSRF)。"""
    hosts: set[str] = set()
    if settings.oss_public_base:
        hosts.add((urlparse(settings.oss_public_base).hostname or "").lower())
    if settings.oss_bucket and settings.oss_endpoint:
        ep = urlparse(settings.oss_endpoint if "://" in settings.oss_endpoint else f"https://{settings.oss_endpoint}")
        hosts.add(f"{settings.oss_bucket}.{ep.hostname}".lower())
    if settings.product_image_base_url:
        hosts.add((urlparse(settings.product_image_base_url).hostname or "").lower())
    hosts.discard("")
    return hosts


def check_source(url: str) -> None:
    p = urlparse((url or "").strip())
    if p.scheme not in ("http", "https") or not p.hostname:
        raise SourceNotAllowed("图片地址不对")
    if p.hostname.lower() not in allowed_hosts():
        raise SourceNotAllowed("只处理图床或图片爬虫上的图")


def fetch(url: str) -> bytes:
    check_source(url)
    with httpx.Client(timeout=httpx.Timeout(15.0, connect=5.0), follow_redirects=False) as c:
        resp = c.get(url)
    resp.raise_for_status()
    content = resp.content
    if len(content) > MAX_IMAGE_BYTES:
        raise ValueError("图片太大")
    return content


def _folder_for(url: str, spu_code: str | None) -> str:
    """爬虫图(spu-ref/{型号}/...)去完水印仍放 spu-ref/{型号}/dewm/:还是「照爬虫图来的」,
    ai_image_publish 按 /spu-ref/ 认出要人确认那条规矩继续管用。别的图放 dewatermark/{年月}/。"""
    path = urlparse(url).path.strip("/").split("/")
    if len(path) >= 2 and path[0] == "spu-ref" and path[1]:
        return f"spu-ref/{path[1]}/dewm"
    if spu_code:
        safe = "".join(ch for ch in spu_code if ch.isalnum() or ch in "-_")[:64]
        if safe:
            return f"spu-ref/{safe}/dewm"
    return f"dewatermark/{datetime.now():%Y%m}"


def process_url(url: str, *, operator: str, spu_code: str | None = None) -> dict:
    """接口用:取图 → 处理 → 处理过的另存一份 + 旁边一个 .json 记录来源。原图不动。"""
    from app.services.oss import upload_filename, upload_object

    content = fetch(url)
    result = process_remote(content) if _remote_base() else process(content)
    out = {"source_url": url, "result_url": None, "record_url": None, "same_image_as": url, **result.summary()}
    if result.image is None:
        return out
    folder = _folder_for(url, spu_code)
    name = upload_filename("dewm.jpg", result.image)
    saved = upload_object(folder, name, result.image, "image/jpeg")
    out["result_url"] = saved["public_url"]
    record = {
        "kind": "xianyu_watermark_removal",
        "source_url": url,
        "source_md5": hashlib.md5(content).hexdigest(),
        "result_url": saved["public_url"],
        "result_md5": hashlib.md5(result.image).hexdigest(),
        "same_image_as": url,  # 去水印不算新图,不能拿来当「各号图片不同」
        "method": "template-match + LaMa(onnx)",
        "operator": operator,
        "at": datetime.now().isoformat(timespec="seconds"),
        **result.summary(),
    }
    rec = upload_object(folder, name.rsplit(".", 1)[0] + ".json",
                        json.dumps(record, ensure_ascii=False, indent=1).encode("utf-8"), "application/json")
    out["record_url"] = rec["public_url"]
    logger.info("去水印 %s → %s %s %s", url, saved["public_url"], result.status, result.reasons)
    return out

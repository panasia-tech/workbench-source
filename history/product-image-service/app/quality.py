"""上架用图的质量分（2026-11-10，规则版，不接大模型）。

型号对不对由 pipeline.score_candidate 按文字证据判；这里只看「这张图能不能直接挂到闲鱼」：
- 水印：OCR 认出知乎、什么值得买、@某某 这类平台/作者字样；
- 海报：除了品牌型号以外还有大段文字，或者有促销词（包邮、正品保证、到手价……）；
- 拼图：背景不干净、画面中间有一整条贯穿的纯色分隔线；
- 人像：有明显的人脸（模特图、发布会现场），用 OpenCV 自带的 YuNet 人脸检测，模型在 models_data/；
- 长图、小图；
- 白底 / 纯色背景加分（电商主图那种）。

OCR 用 rapidocr（onnxruntime，CPU 本地跑，不花钱）；没装就只做不认字的那几项。
"""

from __future__ import annotations

import io
import logging
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image, ImageOps

logger = logging.getLogger(__name__)

# 平台、作者水印。小写比较；「@」单独判
WATERMARK_TERMS = (
    "知乎", "值得买", "smzdm", "小红书", "抖音", "微博", "weibo", "bilibili", "哔哩", "b站",
    "头条", "百家号", "搜狐", "网易", "中关村在线", "zol", "太平洋", "pconline", "it之家", "ithome",
    "淘宝", "天猫", "京东", "拼多多", "闲鱼", "1688", "快手", "贴吧", "微信", "公众号", "视觉中国",
    "摄图网", "699pic", "千图", "包图", "veer", "图虫", "dreamstime", "shutterstock", "alamy",
)
# 促销、带货文案
PROMO_TERMS = (
    "促销", "包邮", "正品", "保证", "防伪", "特价", "限时", "秒杀", "到手", "赠品", "下单", "抢购",
    "旗舰店", "满减", "现货", "热卖", "爆款", "优惠", "折扣", "领券", "立减", "直降", "活动价",
    "新品上市", "售后", "保修", "顺丰", "￥", "¥",
)

SMALL_EDGE = 800
GOOD_EDGE = 1000
FACE_MODEL = Path(__file__).parent / "models_data" / "face_detection_yunet_2023mar.onnx"
# 时间、里程、百分比这类屏幕读数不算字
_READOUT = re.compile(r"^[\d\s:：.,，%°/\-+kmKMhH周星期一二三四五六日天]*$")


@dataclass
class Quality:
    score: float
    grade: str  # good 能直接用 / ok 凑合 / bad 别自动用
    flags: list[str] = field(default_factory=list)
    text_ratio: float = 0.0
    white_ratio: float = 0.0

    def as_dict(self) -> dict[str, object]:
        return {
            "quality_score": round(self.score, 1),
            "quality_grade": self.grade,
            "quality_flags": list(self.flags),
        }


_ocr_lock = threading.Lock()
_ocr_engine = None
_ocr_failed = False


def _ocr():
    global _ocr_engine, _ocr_failed
    if _ocr_engine is not None or _ocr_failed:
        return _ocr_engine
    with _ocr_lock:
        if _ocr_engine is None and not _ocr_failed:
            try:
                from rapidocr_onnxruntime import RapidOCR

                _ocr_engine = RapidOCR()
            except Exception as exc:  # 没装或模型坏了：退回不认字
                logger.warning("OCR unavailable, quality check skips text: %s", exc)
                _ocr_failed = True
    return _ocr_engine


def _compact(value: str) -> str:
    return re.sub(r"[\s\-_/·.,，。:：()（）]+", "", value or "").lower()


def _border_stats(image: Image.Image) -> tuple[float, float]:
    """四周 6% 宽的边框：接近白色的比例、灰度标准差。"""
    small = image.convert("L").resize((96, 96))
    w, h = small.size
    band = max(2, int(w * 0.06))
    px = small.load()
    values = [px[x, y] for y in range(h) for x in range(w) if x < band or x >= w - band or y < band or y >= h - band]
    white = sum(1 for v in values if v >= 236) / len(values)
    mean = sum(values) / len(values)
    std = (sum((v - mean) ** 2 for v in values) / len(values)) ** 0.5
    return white, std


def _has_split_line(image: Image.Image) -> bool:
    """画面中段有没有一整条贯穿的纯色线（拼图的分隔缝）。只在背景不干净时用。"""
    small = image.convert("L").resize((320, 320))
    w, h = small.size
    px = small.load()

    def flat(values: list[int]) -> bool:
        mean = sum(values) / len(values)
        return max(abs(v - mean) for v in values) <= 8

    lo, hi = int(h * 0.15), int(h * 0.85)
    for y in range(lo, hi):
        if flat([px[x, y] for x in range(w)]):
            if not flat([px[x, y - 12] for x in range(w)]) and not flat([px[x, y + 12] for x in range(w)]):
                return True
    for x in range(lo, hi):
        if flat([px[x, y] for y in range(h)]):
            if not flat([px[x - 12, y] for y in range(h)]) and not flat([px[x + 12, y] for y in range(h)]):
                return True
    return False


_face_lock = threading.Lock()
_face_failed = False


def _has_face(image: Image.Image) -> bool:
    """有没有占画面一定比例的人脸。检测器不是线程安全的，串行跑。"""
    global _face_failed
    if _face_failed:
        return False
    try:
        import cv2
        import numpy as np
    except Exception:
        _face_failed = True
        return False
    view = image.convert("RGB")
    scale = min(1.0, 640 / max(view.size))
    if scale < 1.0:
        view = view.resize((int(view.width * scale), int(view.height * scale)))
    bgr = np.asarray(view)[:, :, ::-1].copy()
    try:
        with _face_lock:
            detector = cv2.FaceDetectorYN.create(str(FACE_MODEL), "", (view.width, view.height), 0.8)
            _, faces = detector.detect(bgr)
    except Exception as exc:
        logger.warning("face detector unavailable: %s", exc)
        _face_failed = True
        return False
    if faces is None:
        return False
    short = min(view.size)
    return any(min(f[2], f[3]) >= short * 0.06 for f in faces)


def _read_text(image: Image.Image) -> list[tuple[str, float]]:
    """返回 [(文字, 这块字占画面的比例)]。长边缩到 960 再认，够认水印和海报字。"""
    engine = _ocr()
    if engine is None:
        return []
    view = image.convert("RGB")
    scale = min(1.0, 960 / max(view.size))
    if scale < 1.0:
        view = view.resize((int(view.width * scale), int(view.height * scale)))
    buf = io.BytesIO()
    view.save(buf, format="JPEG", quality=90)
    try:
        result, _ = engine(buf.getvalue())
    except Exception as exc:
        logger.debug("ocr failed: %s", exc)
        return []
    area = float(view.width * view.height)
    out = []
    for box, text, conf in result or []:
        if float(conf) < 0.6:
            continue
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        out.append((str(text), (max(xs) - min(xs)) * (max(ys) - min(ys)) / area))
    return out


def assess(content_or_image, *, identity_terms: tuple[str, ...] = ()) -> Quality:
    """给一张图打分。identity_terms：品牌名、型号这类本来就会印在产品上的字，不算海报字。"""
    image = content_or_image
    if isinstance(content_or_image, (bytes, bytearray)):
        image = Image.open(io.BytesIO(content_or_image))
    image = ImageOps.exif_transpose(image).convert("RGB")
    width, height = image.size
    long_edge, short_edge = max(width, height), min(width, height)
    flags: list[str] = []
    score = 100.0

    if long_edge < SMALL_EDGE:
        flags.append("小图")
        score -= 30
    elif long_edge < GOOD_EDGE:
        score -= 10
    if long_edge / max(1, short_edge) > 2.2:
        flags.append("长图")
        score -= 25

    white, std = _border_stats(image)
    if white >= 0.85:
        flags.append("白底")
        score += 15
    elif std <= 10:
        flags.append("纯色背景")
        score += 8
    elif _has_split_line(image):
        flags.append("拼图")
        score -= 35

    ids = tuple(term for term in (_compact(t) for t in identity_terms) if len(term) >= 2)
    text_ratio = 0.0
    text_boxes = 0
    watermark = promo = False
    for text, ratio in _read_text(image):
        low = text.lower()
        if "@" in text or any(term in low for term in WATERMARK_TERMS):
            watermark = True
            continue
        if any(term in text for term in PROMO_TERMS):
            promo = True
        compact = _compact(text)
        if compact and any(compact in term or (term in compact and len(compact) <= len(term) + 3) for term in ids):
            continue  # 产品本身印的品牌型号
        if _READOUT.match(text.strip()):
            continue  # 屏幕上的时间、里程
        cjk = len(re.findall(r"[\u4e00-\u9fff]", text))
        latin = len(re.findall(r"[A-Za-z]", text))
        if cjk < 3 and latin < 6:
            continue  # 接口标识、按键、短标签
        text_ratio += ratio
        text_boxes += 1
    if watermark:
        flags.append("水印")
        score -= 50
    if promo or text_ratio >= 0.04 or text_boxes >= 4:
        flags.append("海报字")
        score -= 40 if promo else 30
    if _has_face(image):
        flags.append("人像")
        score -= 35

    bad = any(flag in flags for flag in ("水印", "海报字", "拼图", "长图", "人像"))
    grade = "bad" if bad else ("good" if score >= 85 else "ok")
    return Quality(score=max(0.0, score), grade=grade, flags=flags, text_ratio=round(text_ratio, 4), white_ratio=round(white, 3))

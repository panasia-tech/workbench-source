"""成色 → 设计图上的成色槽（全新 / 9新 / 8新 / 7新 / 6新及以下），聊天「SKU 槽」和商品详情的价格区共用。

成色没有统一枚举：仓管选的是 95新 / 9新 / 85新 / 8新，上架表单还有 99新、准新、7新…，
历史数据里还有「9成新」。这里只按数字落槽，认不出的算「未定级」。
"""
import re

from app.models import Sku, SkuListingInfo
from app.services.listing_form_config import STUFF_STATUS_OPTIONS

SLOTS = (("new", "全新"), ("9", "9新"), ("8", "8新"), ("7", "7新"), ("6", "6新及以下"))
UNGRADED = ("none", "未定级")
SLOT_LABEL = dict((*SLOTS, UNGRADED))

# 上架表单的成色枚举 → 文案（sku 没填成色时拿上架信息补）
_STUFF_STATUS_LABEL = {o["value"]: o["label"] for o in STUFF_STATUS_OPTIONS if o["value"]}
_GRADE_NUM = re.compile(r"(\d{1,3})\s*成?新")


def slot_of(grade: str | None) -> str:
    """成色文案 → 槽：全新 / 9新（90~99、准新）/ 8新 / 7新 / 6新及以下；认不出算未定级。"""
    g = (grade or "").strip()
    if not g:
        return UNGRADED[0]
    if "全新" in g:
        return "new"
    if "准新" in g:
        return "9"
    m = _GRADE_NUM.search(g)
    if not m:
        return UNGRADED[0]
    v = int(m.group(1))
    if v < 10:  # 「9新」「8成新」这种一位数
        v *= 10
    if v >= 100:
        return "new"
    if v >= 90:
        return "9"
    if v >= 80:
        return "8"
    if v >= 70:
        return "7"
    return "6"


def grade_of(sku: Sku, info: SkuListingInfo | None) -> str:
    """这件货的成色文案：先看 sku 上填的，没填看上架信息里选的；都没有为空。"""
    if sku.condition_grade and sku.condition_grade.strip():
        return sku.condition_grade.strip()
    if info is not None and info.stuff_status in _STUFF_STATUS_LABEL:
        return _STUFF_STATUS_LABEL[info.stuff_status]
    return ""

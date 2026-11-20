"""上架素材分池(2026-11-10):每张候选图(这件货的实拍 / 上架图 / AI 图、爬虫同款图)一个状态。

- 可用(usable):自动补图能拿去用,挑图时正常显示;
- 待复核(review):爬虫评成 bad 的(水印、海报字、拼图、人像、长图)。挑图时照样能选、角标写出毛病,
  但自动补图、自动分配不用——沿用 11-10 质量分的口径「ERP 不自动用 bad」;
- 淘汰(rejected):不再出现在候选里,带原因。两种来源:
  · 规则:像头像、表情包、聊天 / 订单截图、几乎全是字的图(只看爬虫给的尺寸和质量标记,ERP 不做图像处理);
    这件货的封面不在实拍图里的(封面里抽查到过买家订单截图);
  · 人工:员工在上架图片管理、上架挑图时标的,写原因。

人工结论(image_material_mark 表)盖过规则:规则淘汰的人可以改回可用,反之亦然。
按图床干净地址认,一张爬虫图标了淘汰,同型号的货都不再拿它当候选。
同款他人的图证明不了这一件的成色,只当展示 / 参考,这里只管「能不能当候选」。
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app.models import ImageMaterialMark

USABLE = "usable"
REVIEW = "review"
REJECTED = "rejected"
LABEL = {USABLE: "可用", REVIEW: "待复核", REJECTED: "淘汰"}

# 挑图时一点就能选的淘汰原因(另有「其他原因」自己写;微信底部菜单最多 6 项,这里最多 5 条)
REASONS = ("不是这个型号", "水印 / 广告字", "截图", "头像 / 表情包", "模糊 / 看不清")
REASON_MAX = 64

# 爬虫质量标记里算毛病的(白底、纯色背景是加分项)
BAD_FLAGS = ("水印", "海报字", "拼图", "人像", "长图", "小图")

# 规则阈值:长边比这还小的基本是头像、表情包、缩略图
TINY_EDGE = 400
# 人像且长边不到这么大、接近方图:像头像
AVATAR_EDGE = 800
AVATAR_RATIO = 1.3
# 竖图高宽比到这么多(16:9 手机屏起)还满是字:像聊天 / 订单截图
SCREEN_RATIO = 1.75
# 爬虫以后给出文字占画面比例时用:到这么多就是纯文字图
TEXT_ONLY_RATIO = 0.2


@dataclass(frozen=True)
class Verdict:
    status: str
    reason: str | None = None
    manual: bool = False

    def as_dict(self) -> dict:
        return {"status": self.status, "reason": self.reason or "", "manual": self.manual}


def url_hash(url: str) -> str:
    return hashlib.md5(url.encode("utf-8")).hexdigest()


def _bad_flags(item: dict) -> list[str]:
    have = set(item.get("quality_flags") or [])
    return [f for f in BAD_FLAGS if f in have]  # 按毛病轻重排,不按爬虫给的顺序


def irrelevant_reason(item: dict) -> str | None:
    """爬虫图是不是根本不相干的图(头像、表情包、截图、纯文字),是就返回原因。只看爬虫给的字段。"""
    url = (item.get("url") or "").split("?", 1)[0].lower()
    flags = set(item.get("quality_flags") or [])
    if url.endswith(".gif"):
        return "动图，像表情包"
    try:
        w, h = int(item.get("width") or 0), int(item.get("height") or 0)
    except (TypeError, ValueError):
        w = h = 0
    if w > 0 and h > 0:
        long_edge, short_edge = max(w, h), min(w, h)
        if long_edge < TINY_EDGE:
            return "太小，像头像或表情包"
        if "人像" in flags and long_edge < AVATAR_EDGE and long_edge / short_edge <= AVATAR_RATIO:
            return "像头像"
        if h / w >= SCREEN_RATIO and flags & {"海报字", "水印"}:
            return "像聊天或订单截图"
    if "长图" in flags and "海报字" in flags:
        return "像长截图或详情页"
    ratio = item.get("quality_text_ratio")
    try:
        if ratio is not None and float(ratio) >= TEXT_ONLY_RATIO:
            return "几乎全是字"
    except (TypeError, ValueError):
        pass
    return None


def rule_verdict(item: dict) -> Verdict:
    """爬虫同款图按规则的结论。老任务没评过质量(没有 quality_grade)的当可用。"""
    why = irrelevant_reason(item)
    if why:
        return Verdict(REJECTED, why)
    if item.get("quality_grade") == "bad":
        flags = _bad_flags(item)
        return Verdict(REVIEW, flags[0] if flags else "质量差")
    return Verdict(USABLE)


def marks_for(db: Session, urls) -> dict[str, ImageMaterialMark]:
    """这些图的人工结论,url → 行。"""
    by_hash = {url_hash(u): u for u in urls if u}
    if not by_hash:
        return {}
    rows = db.query(ImageMaterialMark).filter(ImageMaterialMark.url_hash.in_(list(by_hash))).all()
    return {by_hash[r.url_hash]: r for r in rows if r.url_hash in by_hash}


def verdict(rule: Verdict, mark: ImageMaterialMark | None, item: dict | None = None) -> Verdict:
    """一张候选图的最终状态。rule 是规则的结论(爬虫图用 rule_verdict,自家的图一般是可用)。

    人工淘汰 → 淘汰;人工改回可用 → 规则的淘汰作废,但爬虫评 bad 的还是待复核(人只说了「不是无关图」,
    自动补图照样不用 bad);没人看过 → 规则说了算。
    """
    if mark is None:
        return rule
    if mark.status == ImageMaterialMark.REJECTED:
        return Verdict(REJECTED, mark.reason or "人工淘汰", True)
    if rule.status == REJECTED:
        if item is not None and item.get("quality_grade") == "bad":
            flags = _bad_flags(item)
            return Verdict(REVIEW, flags[0] if flags else "质量差", True)
        return Verdict(USABLE, None, True)
    return Verdict(rule.status, rule.reason, True)


def judge_crawled(db: Session, pool: list[dict]) -> list[tuple[dict, Verdict]]:
    marks = marks_for(db, [p.get("url") for p in pool])
    return [(p, verdict(rule_verdict(p), marks.get(p["url"]), p)) for p in pool if p.get("url")]


def usable_crawled(db: Session, pool: list[dict]) -> list[dict]:
    """自动补图能拿去用的爬虫图:可用的(待复核、淘汰的都不要),顺序照爬虫排的。"""
    return [p for p, v in judge_crawled(db, pool) if v.status == USABLE]


def set_mark(db: Session, url: str, status: str, *, reason: str | None = None, sku_id: str | None = None,
             spu_id: str | None = None, staff_name: str | None = None) -> ImageMaterialMark:
    """记人工结论。status 只收 usable / rejected;淘汰必须写原因。调用方自己 commit。"""
    if status not in (ImageMaterialMark.USABLE, ImageMaterialMark.REJECTED):
        raise ValueError("状态只能是可用或淘汰")
    reason = " ".join((reason or "").split())[:REASON_MAX] or None
    if status == ImageMaterialMark.REJECTED and not reason:
        raise ValueError("淘汰要写原因")
    h = url_hash(url)
    row = db.query(ImageMaterialMark).filter(ImageMaterialMark.url_hash == h).first()
    if row is None:
        row = ImageMaterialMark(url_hash=h, url=url[:512])
        db.add(row)
    row.status = status
    row.reason = reason if status == ImageMaterialMark.REJECTED else None
    row.sku_id = sku_id
    row.spu_id = spu_id
    row.marked_by = (staff_name or "")[:64] or None
    db.flush()
    return row

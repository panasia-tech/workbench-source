"""上架用图质量分(app/quality.py):文字和人脸用假的,只钉规则。"""
from PIL import Image, ImageDraw

import app.quality as Q


def _img(size=(1200, 1200), bg="white"):
    im = Image.new("RGB", size, bg)
    ImageDraw.Draw(im).rectangle((300, 300, 900, 900), fill=(40, 40, 60))
    return im


def _no_text_no_face(monkeypatch, texts=()):
    monkeypatch.setattr(Q, "_read_text", lambda image: list(texts))
    monkeypatch.setattr(Q, "_has_face", lambda image: False)


def test_clean_white_background_product_is_good(monkeypatch):
    _no_text_no_face(monkeypatch)
    q = Q.assess(_img())
    assert q.grade == "good" and "白底" in q.flags


def test_small_and_long_images(monkeypatch):
    _no_text_no_face(monkeypatch)
    assert "小图" in Q.assess(_img((500, 500))).flags
    long = Q.assess(_img((600, 2000)))
    assert "长图" in long.flags and long.grade == "bad"


def test_watermark_and_promo_text(monkeypatch):
    _no_text_no_face(monkeypatch, [("知乎 @某某", 0.001)])
    assert Q.assess(_img()).grade == "bad"
    _no_text_no_face(monkeypatch, [("正品保证 防伪可查", 0.01)])
    assert "海报字" in Q.assess(_img()).flags


def test_brand_model_and_screen_readouts_are_not_poster_text(monkeypatch):
    _no_text_no_face(monkeypatch, [("ASUS", 0.03), ("TUF GAMING", 0.03), ("12:27", 0.05), ("周五 14", 0.02)])
    q = Q.assess(_img(), identity_terms=("华硕", "ASUS", "TUF GAMING", "VG258QM"))
    assert "海报字" not in q.flags and q.grade == "good"


def test_slogan_that_contains_brand_still_counts(monkeypatch):
    _no_text_no_face(monkeypatch, [("Ulike Air3蓝宝石冰点脱毛仪", 0.05)])
    assert "海报字" in Q.assess(_img(), identity_terms=("Ulike", "AIR3")).flags


def test_collage_split_line(monkeypatch):
    _no_text_no_face(monkeypatch)
    im = Image.effect_noise((1200, 1200), 60).convert("RGB")
    ImageDraw.Draw(im).rectangle((0, 590, 1200, 610), fill="white")
    assert "拼图" in Q.assess(im).flags


def test_face_marks_model_shot(monkeypatch):
    monkeypatch.setattr(Q, "_read_text", lambda image: [])
    monkeypatch.setattr(Q, "_has_face", lambda image: True)
    q = Q.assess(_img())
    assert "人像" in q.flags and q.grade == "bad"


def test_task_api_keeps_quality_fields():
    from app.main import _preview_as_image

    out = _preview_as_image({"url": "u", "quality_grade": "bad", "quality_flags": ["水印"], "quality_score": 50})
    assert (out["quality_grade"], out["quality_flags"], out["quality_score"]) == ("bad", ["水印"], 50.0)

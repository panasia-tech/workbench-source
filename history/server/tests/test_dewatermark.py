"""去闲鱼水印(E02)。

两层:
- 不依赖 numpy/opencv 的:谁能用、缺依赖时 503、只取图床/爬虫上的图、处理后另存不覆盖原图并带来源记录;
- 要 numpy/opencv 的(测试环境没装就跳过):合成一张带闲鱼水印的图,定位对、水印以外像素不动、
  没补干净判残留、没有水印的图不动。LaMa 模型一律打桩,不加载真模型。
"""
import json

import pytest
from fastapi import HTTPException

from app.deps import require_roles
from app.enums import StaffRole
from app.models import Staff
from app.routers import dewatermark as api
from app.services import dewatermark as dw

OSS_HOST = "erp-bucket.oss-cn-hangzhou.aliyuncs.com"
SRC = f"https://{OSS_HOST}/spu-ref/90000720/pool/abc.jpg"


def _staff(role=StaffRole.SALES):
    return Staff(id=f"u-{role}", role=role, username="xiaowang", name="小王")


@pytest.fixture()
def hosts(monkeypatch):
    monkeypatch.setattr(dw.settings, "oss_public_base", "")
    monkeypatch.setattr(dw.settings, "oss_bucket", "erp-bucket")
    monkeypatch.setattr(dw.settings, "oss_endpoint", "https://oss-cn-hangzhou.aliyuncs.com")
    monkeypatch.setattr(dw.settings, "product_image_base_url", "http://127.0.0.1:8000")


# ── 不依赖图像库 ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("role", [StaffRole.ADMIN, StaffRole.SALES, StaffRole.WAREHOUSE, StaffRole.PURCHASER,
                                  StaffRole.FINANCE, StaffRole.BUSINESS, StaffRole.NEGOTIATOR])
def test_roles_allowed(role):
    checker = require_roles(*api._ROLES)
    assert checker(_staff(role)).role == role


@pytest.mark.parametrize("role", [StaffRole.CRAWLER, StaffRole.RFID_DEVICE])
def test_roles_denied(role):
    checker = require_roles(*api._ROLES)
    with pytest.raises(HTTPException) as e:
        checker(_staff(role))
    assert e.value.status_code == 403


def test_unavailable_returns_503_and_status_says_why(monkeypatch):
    monkeypatch.setattr(dw, "available", lambda: (False, "服务器没装 onnxruntime"))
    assert api.status(_=_staff()) == {"available": False, "reason": "服务器没装 onnxruntime"}
    with pytest.raises(HTTPException) as e:
        api.remove_watermark(api.DewatermarkIn(url=SRC), user=_staff())
    assert e.value.status_code == 503 and "onnxruntime" in e.value.detail


def test_available_reports_missing_model(monkeypatch, tmp_path):
    monkeypatch.setattr(dw, "_libs", lambda: (object(), object()))
    monkeypatch.setattr(dw, "MODEL_PATH", str(tmp_path / "nope.onnx"))
    ok, reason = dw.available()
    if "onnxruntime" in reason:  # 测试环境没装 onnxruntime 就先报这个
        assert not ok
    else:
        assert not ok and "模型" in reason


@pytest.mark.parametrize("url", [
    "http://127.0.0.1:8000/api/staff",
    "https://example.com/a.jpg",
    "file:///etc/passwd",
    f"ftp://{OSS_HOST}/a.jpg",
    f"https://{OSS_HOST}.evil.com/a.jpg",
])
def test_only_our_oss_and_crawler(hosts, url):
    with pytest.raises(dw.SourceNotAllowed):
        dw.check_source(url)


def test_our_oss_and_crawler_ok(hosts, monkeypatch):
    dw.check_source(SRC)
    dw.check_source("http://127.0.0.1:8000")
    monkeypatch.setattr(dw.settings, "oss_public_base", "http://127.0.0.1:8000")
    dw.check_source("http://127.0.0.1:8000")


def test_bad_source_is_400(hosts, monkeypatch):
    monkeypatch.setattr(dw, "available", lambda: (True, ""))
    with pytest.raises(HTTPException) as e:
        api.remove_watermark(api.DewatermarkIn(url="http://127.0.0.1/a.jpg"), user=_staff())
    assert e.value.status_code == 400


def test_folder_keeps_spu_ref_marker():
    # 爬虫图去完水印仍在 spu-ref/ 下:照它重绘的图要人确认那条规矩继续管用
    assert dw._folder_for(SRC, None) == "spu-ref/90000720/dewm"
    assert dw._folder_for(f"https://{OSS_HOST}/listing/x.jpg", "9000-07") == "spu-ref/9000-07/dewm"
    assert dw._folder_for(f"https://{OSS_HOST}/listing/x.jpg", "../../etc") == "spu-ref/etc/dewm"
    assert dw._folder_for(f"https://{OSS_HOST}/listing/x.jpg", None).startswith("dewatermark/")


def _fake_result(status, image=b"\xff\xd8clean"):
    return dw.Result(
        status,
        regions=[dw.Region("logo", [700, 950, 72, 40], 0.92), dw.Region("account_line", [480, 1005, 292, 26], 0.88)],
        checks={"residual_ok": status == dw.DONE},
        reasons=[] if status == dw.DONE else ["原位置还认得出水印(残留)"],
        image=image, width=800, height=1067, elapsed_ms=3000,
    )


@pytest.fixture()
def uploads(monkeypatch, hosts):
    import app.services.oss as oss

    calls = []

    def fake_upload(folder, name, content, ctype=None):
        calls.append({"folder": folder, "name": name, "content": content, "ctype": ctype})
        return {"object_key": f"{folder}/{name}", "public_url": f"https://{OSS_HOST}/{folder}/{name}", "access_url": ""}

    monkeypatch.setattr(oss, "upload_object", fake_upload)
    monkeypatch.setattr(dw, "fetch", lambda url: b"\xff\xd8original")
    monkeypatch.setattr(dw, "available", lambda: (True, ""))
    return calls


def test_saves_copy_and_record_never_overwrites_source(uploads, monkeypatch):
    monkeypatch.setattr(dw, "process", lambda content: _fake_result(dw.DONE))
    out = api.remove_watermark(api.DewatermarkIn(url=SRC), user=_staff())
    assert out["status"] == "done" and out["status_label"] == "已去水印"
    assert len(uploads) == 2
    img, rec = uploads
    assert img["folder"] == "spu-ref/90000720/dewm" and img["content"] == b"\xff\xd8clean" and img["ctype"] == "image/jpeg"
    assert f"{img['folder']}/{img['name']}" != "spu-ref/90000720/pool/abc.jpg"
    assert out["result_url"].endswith(img["name"]) and out["source_url"] == SRC
    assert rec["name"] == img["name"].rsplit(".", 1)[0] + ".json"
    record = json.loads(rec["content"])
    assert record["source_url"] == SRC and record["same_image_as"] == SRC
    assert record["operator"] == "xiaowang" and record["result_url"] == out["result_url"]
    assert [r["kind"] for r in record["regions"]] == ["logo", "account_line"]
    assert out["record_url"].endswith(".json")


def test_needs_review_still_saved_for_human(uploads, monkeypatch):
    monkeypatch.setattr(dw, "process", lambda content: _fake_result(dw.NEEDS_REVIEW))
    out = api.remove_watermark(api.DewatermarkIn(url=SRC), user=_staff())
    assert out["status"] == "needs_review" and out["reasons"] and out["result_url"]


def test_not_found_uploads_nothing(uploads, monkeypatch):
    monkeypatch.setattr(dw, "process", lambda content: dw.Result(dw.NOT_FOUND, reasons=["没认出"]))
    out = api.remove_watermark(api.DewatermarkIn(url=SRC), user=_staff())
    assert out["status"] == "not_found" and out["result_url"] is None and uploads == []


# ── 京东云远程补图 ────────────────────────────────────────────────────────────

REMOTE = "http://127.0.0.1:8000"


@pytest.fixture()
def remote(monkeypatch):
    """配上远程地址;httpx 全走假传输,handler 由各测试定。"""
    import httpx

    monkeypatch.setattr(dw.settings, "dewatermark_remote_url", REMOTE + "/")
    monkeypatch.setattr(dw.settings, "dewatermark_remote_token", "tok")
    monkeypatch.setattr(dw, "_remote_health", None)
    seen = {"requests": []}
    real_client = httpx.Client

    def client(**kw):
        def handler(request):
            seen["requests"].append(request)
            return seen["handler"](request)
        return real_client(transport=httpx.MockTransport(handler), **kw)

    monkeypatch.setattr(dw.httpx, "Client", client)
    return seen


def test_wire_round_trip():
    r = _fake_result(dw.NEEDS_REVIEW)
    back = dw.from_wire(json.loads(json.dumps(dw.to_wire(r))))
    assert back.summary() == r.summary() and back.image == r.image
    assert dw.from_wire(dw.to_wire(dw.Result(dw.NOT_FOUND, reasons=["没认出"]))).image is None


def test_remote_available_asks_jd_and_caches(remote):
    import httpx

    remote["handler"] = lambda req: httpx.Response(200, json={"available": True, "reason": ""})
    assert dw.available() == (True, "")
    assert dw.available() == (True, "")
    assert len(remote["requests"]) == 1
    req = remote["requests"][0]
    assert str(req.url) == REMOTE + "/health" and req.headers["authorization"] == "Bearer tok"


def test_remote_down_means_unavailable(remote):
    import httpx

    def down(req):
        raise httpx.ConnectError("refused")

    remote["handler"] = down
    ok, reason = dw.available()
    assert not ok and "连不上" in reason


def test_remote_process_saves_copy(uploads, remote, monkeypatch):
    import httpx

    monkeypatch.setattr(dw, "process", lambda content: pytest.fail("配了远程就不该在本机跑"))
    remote["handler"] = lambda req: httpx.Response(200, json=dw.to_wire(_fake_result(dw.DONE)))
    out = api.remove_watermark(api.DewatermarkIn(url=SRC), user=_staff())
    assert out["status"] == "done" and out["result_url"]
    req = remote["requests"][-1]
    assert str(req.url) == REMOTE + "/process" and req.content == b"\xff\xd8original"
    assert uploads[0]["content"] == b"\xff\xd8clean"


@pytest.mark.parametrize("response", [
    lambda req: (_ for _ in ()).throw(__import__("httpx").ReadTimeout("slow")),
    lambda req: __import__("httpx").Response(503, json={"detail": "去水印模型没放:/models/lama_fp32.onnx"}),
    lambda req: __import__("httpx").Response(200, text="<html>"),
])
def test_remote_errors_are_503_not_fetch_failure(uploads, remote, response):
    remote["handler"] = response
    with pytest.raises(HTTPException) as e:
        api.remove_watermark(api.DewatermarkIn(url=SRC), user=_staff())
    assert e.value.status_code == 503 and "京东云" in e.value.detail
    assert uploads == []


# ── 要 numpy / opencv ────────────────────────────────────────────────────────

def _cv():
    cv2 = pytest.importorskip("cv2")
    np = pytest.importorskip("numpy")
    return cv2, np


def _textured(np, h=1067, w=800, seed=1):
    rng = np.random.default_rng(seed)
    base = np.full((h, w, 3), (120, 110, 100), np.uint8)
    noise = rng.integers(-25, 25, (h, w, 1), dtype=np.int16)
    return np.clip(base.astype(np.int16) + noise, 0, 255).astype(np.uint8)


def _watermarked(cv2, np):
    """把内置的两块模板按 0.95 倍贴到右下角:小标右边距 30、「闲鱼号:」在下面一行。"""
    img = _textured(np)
    logo = cv2.resize(dw._template("logo"), None, fx=0.95, fy=0.95).astype(np.uint8)
    pre = cv2.resize(dw._template("prefix"), None, fx=0.95, fy=0.95).astype(np.uint8)
    lh, lw = logo.shape
    ph, pw = pre.shape
    lx, ly = 800 - 30 - lw, 1067 - 40 - ph - 14 - lh
    img[ly:ly + lh, lx:lx + lw] = cv2.cvtColor(logo, cv2.COLOR_GRAY2BGR)
    px, py = lx + lw - 280, ly + lh + 14
    img[py:py + ph, px:px + pw] = cv2.cvtColor(pre, cv2.COLOR_GRAY2BGR)
    # 用户名部分:几道白杠当字
    for i in range(6):
        x = px + pw + 6 + i * 26
        if x + 18 < lx + lw:
            img[py + 4:py + ph - 4, x:x + 18] = 235
    return img, (lx, ly, lw, lh), (px, py, pw, ph)


def _encode(cv2, img):
    ok, buf = cv2.imencode(".png", img)  # 输入用 PNG,水印以外好逐像素比
    return buf.tobytes()


def test_detects_logo_and_account_line():
    cv2, np = _cv()
    img, logo, pre = _watermarked(cv2, np)
    regions, info = dw.detect(img)
    assert regions, info
    got = {r.kind: r.box for r in regions}
    assert abs(got["logo"][0] - logo[0]) <= 3 and abs(got["logo"][1] - logo[1]) <= 3
    assert abs(got["account_line"][0] - pre[0]) <= 3 and abs(got["account_line"][1] - pre[1]) <= 3
    # 那一行到小标右边为止
    assert got["account_line"][0] + got["account_line"][2] >= logo[0] + logo[2]


def test_no_watermark_left_untouched():
    cv2, np = _cv()
    img = _textured(np, seed=7)
    # 右下角放个白底标签(商品上真的标识),不该当成水印
    img[900:960, 600:740] = 245
    cv2.putText(img, "SN 12345", (610, 940), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (30, 30, 30), 2)
    r = dw.process(_encode(cv2, img))
    assert r.status == dw.NOT_FOUND and r.image is None


def test_inpaint_only_touches_watermark(monkeypatch):
    cv2, np = _cv()
    img, _, _ = _watermarked(cv2, np)
    # 假 LaMa:把要补的地方换成周围的均色(真模型不加载);和真的一样返回 512×512×3、0~255
    def fake_lama(image_512, mask_512):
        im = image_512[0].transpose(1, 2, 0) * 255.0
        m = mask_512[0, 0] > 0
        im[m] = im[~m].mean(0)
        return im

    monkeypatch.setattr(dw, "_lama_run", fake_lama)
    r = dw.process(_encode(cv2, img))
    assert r.status in (dw.DONE, dw.NEEDS_REVIEW), r.reasons
    assert r.checks["changed_outside_mask"] == 0
    assert r.checks["residual_ok"] is True
    out = cv2.imdecode(np.frombuffer(r.image, np.uint8), cv2.IMREAD_COLOR)
    mask = dw.build_mask(img.shape, r.regions)
    # JPEG 输出会有压缩误差,水印以外只允许很小的差
    diff = np.abs(out.astype(int) - img.astype(int)).max(axis=2)
    assert np.percentile(diff[mask == 0], 99) <= 12


def test_residual_flags_for_human(monkeypatch):
    cv2, np = _cv()
    img, _, _ = _watermarked(cv2, np)
    monkeypatch.setattr(dw, "inpaint", lambda im, m: im.copy())  # 什么都没补
    r = dw.process(_encode(cv2, img))
    assert r.status == dw.NEEDS_REVIEW
    assert any("残留" in x for x in r.reasons)


def test_blurry_fill_on_texture_flags_for_human(monkeypatch):
    cv2, np = _cv()
    img, _, _ = _watermarked(cv2, np)
    # OpenCV Telea 在纹理上会糊成一片:要判出来交给人
    monkeypatch.setattr(dw, "inpaint", lambda im, m: cv2.inpaint(im, m, 4, cv2.INPAINT_TELEA))
    r = dw.process(_encode(cv2, img))
    assert r.status == dw.NEEDS_REVIEW
    assert any("糊" in x for x in r.reasons)


def test_garbage_bytes_fail_cleanly():
    _cv()
    r = dw.process(b"not an image")
    assert r.status == dw.FAILED and r.image is None

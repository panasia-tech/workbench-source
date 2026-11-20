from urllib.parse import urlsplit

import pytest

from app import library
from app.models import MediaItem
from tests.conftest import login


def _publish(db, storage, video, item_id="wh-basic-01", **kw):
    library.create_item(db, item_id, "第1课 所有物品登记与规范入库", **kw)
    v = library.add_version(db, storage, item_id, video)
    library.publish(db, item_id, v.version_no, actor="test")
    return v


def _play(client, item_id="wh-basic-01"):
    return client.get(f"/api/m/{item_id}/play")


def _local_path(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.path}?{parts.query}"


def test_staff_item_plays_with_range(client, db, storage, video):
    _publish(db, storage, video)
    r = client.get("/m/wh-basic-01", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"].startswith("/auth/login")

    login(client)
    page = client.get("/m/wh-basic-01")
    assert page.status_code == 200 and "第1课" in page.text
    play = _play(client).json()
    assert play["version"] == 1
    # 拖动进度靠 Range：要回 206 和对应字节
    r = client.get(_local_path(play["url"]), headers={"Range": "bytes=10-19"})
    assert r.status_code == 206
    assert r.content == video.read_bytes()[10:20]
    assert r.headers["content-disposition"].startswith("inline")


def test_expired_signature_is_refused_and_fixed_link_still_works(client, db, storage, video, monkeypatch):
    _publish(db, storage, video)
    login(client)
    url = _play(client).json()["url"]
    monkeypatch.setattr("app.storage.time.time", lambda: 4_000_000_000)
    assert client.get(_local_path(url)).status_code == 403
    monkeypatch.undo()
    # 固定入口重新取一次地址就又能看
    fresh = _play(client).json()["url"]
    assert client.get(_local_path(fresh)).status_code == 200


def test_tampered_signature_is_refused(client, db, storage, video):
    _publish(db, storage, video)
    login(client)
    url = _play(client).json()["url"].replace("v1/play.mp4", "v1/play.mp4x")
    assert client.get(_local_path(url)).status_code in (403, 404)


def test_role_audience(client, db, storage, video):
    _publish(db, storage, video, audience="roles", roles="warehouse")
    login(client, role="sales")
    assert _play(client).status_code == 403
    assert client.get("/m/wh-basic-01").status_code == 403
    login(client, role="warehouse")
    assert _play(client).status_code == 200
    login(client, role="admin")
    assert _play(client).status_code == 200


def test_public_needs_confirmation(client, db, storage, video):
    _publish(db, storage, video, item_id="company-intro", audience="public")
    assert _play(client, "company-intro").status_code == 401
    library.confirm_public(db, "company-intro", "老邹")
    client.cookies.clear()
    assert _play(client, "company-intro").status_code == 200


def test_external_pass_scope_expiry_and_revoke(client, db, storage, video):
    _publish(db, storage, video, item_id="partner-deck", audience="external")
    _publish(db, storage, video, item_id="wh-basic-02")
    login(client, role="warehouse")
    assert _play(client, "partner-deck").status_code == 403  # external 只认凭证

    p, token = library.create_pass(db, ["partner-deck"], label="合作方", days=7)
    client.cookies.clear()
    r = client.get(f"/m/partner-deck?pass={token}", follow_redirects=False)
    assert r.status_code == 303 and "pass=" not in r.headers["location"]
    assert _play(client, "partner-deck").status_code == 200
    assert _play(client, "wh-basic-02").status_code == 401  # 凭证只管列出的资料

    library.revoke_pass(db, p.id)
    assert _play(client, "partner-deck").status_code == 401
    assert client.get(f"/m/partner-deck?pass={token}").status_code == 403


def test_new_version_and_rollback_keep_fixed_link(client, db, storage, video, env):
    _publish(db, storage, video)
    v2_file = env / "lesson-v2.mp4"
    v2_file.write_bytes(video.read_bytes() + b"v2")
    v2 = library.add_version(db, storage, "wh-basic-01", v2_file)
    login(client)
    assert _play(client).json()["version"] == 1  # 传了不发布，入口不变

    library.publish(db, "wh-basic-01", v2.version_no)
    assert _play(client).json()["version"] == 2
    library.rollback(db, "wh-basic-01")
    assert _play(client).json()["version"] == 1
    # 旧版本对象还在，回退后能正常出文件
    assert client.get(_local_path(_play(client).json()["url"])).status_code == 200


def test_unverified_version_cannot_publish(client, db, storage, video, monkeypatch):
    library.create_item(db, "wh-basic-01", "第1课")
    monkeypatch.setattr(type(storage), "head", lambda self, key: None)
    with pytest.raises(library.LibraryError):
        library.add_version(db, storage, "wh-basic-01", video)
    with pytest.raises(library.LibraryError):
        library.publish(db, "wh-basic-01", 1)
    assert db.get(MediaItem, "wh-basic-01").published_version_id is None


def test_attachments_inline_pdf_download_docx(client, db, storage, video, env):
    _publish(db, storage, video)
    pdf = env / "说明.pdf"
    pdf.write_bytes(b"%PDF-1.4 test")
    docx = env / "讲义.docx"
    docx.write_bytes(b"PK\x03\x04 test")
    a_pdf = library.add_attachment(db, storage, "wh-basic-01", pdf)
    a_doc = library.add_attachment(db, storage, "wh-basic-01", docx)
    login(client)
    assert "说明.pdf" in client.get("/m/wh-basic-01").text

    r = client.get(f"/api/m/wh-basic-01/files/{a_pdf.id}", follow_redirects=False)
    got = client.get(_local_path(r.headers["location"]))
    assert got.headers["content-type"] == "application/pdf"
    assert got.headers["content-disposition"].startswith("inline")

    r = client.get(f"/api/m/wh-basic-01/files/{a_doc.id}", follow_redirects=False)
    got = client.get(_local_path(r.headers["location"]))
    assert got.headers["content-disposition"].startswith("attachment")
    assert got.content == docx.read_bytes()


def test_pdf_relayed_when_storage_cannot_override(client, db, storage, video, env, monkeypatch):
    # OSS 默认域名：签名地址一律按下载返回，PDF 改由本服务转发，docx 照旧跳过去
    _publish(db, storage, video)
    pdf = env / "说明.pdf"
    pdf.write_bytes(b"%PDF-1.4 relayed")
    docx = env / "讲义.docx"
    docx.write_bytes(b"PK\x03\x04 test")
    a_pdf = library.add_attachment(db, storage, "wh-basic-01", pdf)
    a_doc = library.add_attachment(db, storage, "wh-basic-01", docx)
    monkeypatch.setattr(storage, "can_override", False)
    login(client)

    r = client.get(f"/api/m/wh-basic-01/files/{a_pdf.id}", follow_redirects=False)
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert r.headers["content-disposition"].startswith("inline")
    assert r.content == pdf.read_bytes()
    assert client.get(f"/api/m/wh-basic-01/files/{a_doc.id}", follow_redirects=False).status_code == 302

    client.cookies.clear()
    assert client.get(f"/api/m/wh-basic-01/files/{a_pdf.id}", follow_redirects=False).status_code in (401, 403)


def test_unpublished_or_unknown_item_404(client, db):
    library.create_item(db, "wh-basic-09", "还没传")
    login(client)
    assert client.get("/m/wh-basic-09").status_code == 404
    assert client.get("/m/nope-nope").status_code == 404


def test_item_id_rules(db):
    with pytest.raises(library.LibraryError):
        library.create_item(db, "Bad ID", "x")
    with pytest.raises(library.LibraryError):
        library.create_item(db, "wh-x", "x", audience="roles")


def test_dev_login_off_by_default(client, monkeypatch):
    from app.config import get_settings

    monkeypatch.setenv("MEDIA_DEV_LOGIN", "false")
    get_settings.cache_clear()
    assert client.get("/auth/dev-login").status_code == 404


class _Resp:
    def __init__(self, data, status=200):
        self.status_code, self._data = status, data

    def json(self):
        return self._data

    def raise_for_status(self):
        return self


@pytest.fixture
def oidc(client, monkeypatch):
    """统一登录换成假的：令牌接口照收，userinfo 回 claims 里放的东西。"""
    from app import auth
    from app.config import get_settings

    monkeypatch.setenv("MEDIA_OIDC_ISSUER", "https://sso.test/application/o/media/")
    monkeypatch.setenv("MEDIA_OIDC_CLIENT_ID", "media")
    get_settings.cache_clear()
    monkeypatch.setattr(auth, "discover", lambda s: auth.OidcEndpoints(
        "https://sso.test/authorize", "https://sso.test/token", "https://sso.test/userinfo"))
    sent, claims = {}, {}
    monkeypatch.setattr(auth.httpx, "post", lambda url, **kw: sent.update(kw["data"]) or _Resp({"access_token": "DEMO_ONLY_REDACTED"}))
    monkeypatch.setattr(auth.httpx, "get", lambda url, **kw: _Resp(dict(claims)))
    return sent, claims


def _sso_login(client, next_path="/m/wh-basic-01"):
    client.cookies.clear()
    r = client.get("/auth/login", params={"next": next_path}, follow_redirects=False)
    q = dict(p.split("=", 1) for p in urlsplit(r.headers["location"]).query.split("&"))
    assert q["scope"] == "openid+profile+erp"
    return client.get("/auth/callback", params={"code": "c", "state": q["state"]}, follow_redirects=False)


def test_sso_login_uses_erp_sub_and_role(client, db, storage, video, oidc):
    sent, claims = oidc
    _publish(db, storage, video, audience="roles", roles="warehouse")
    claims.update(sub="hashed-abc", erp_sub="E007", name="仓管甲", erp_role="WAREHOUSE", groups=["仓库组"])
    r = _sso_login(client)
    assert r.status_code == 303 and r.headers["location"] == "/m/wh-basic-01"
    assert sent["code_verifier"] and sent["code"] == "c"
    assert _play(client).status_code == 200

    # 角色不对看不了；没有 erp_sub（不是 ERP 的号）登不进来
    claims.update(erp_role="SALES", groups=[])
    _sso_login(client)
    assert _play(client).status_code == 403
    claims.pop("erp_sub")
    assert _sso_login(client).status_code == 400

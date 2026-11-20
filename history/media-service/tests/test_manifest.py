from app import manifest
from app.models import MediaItem
from tests.conftest import login

HEADER = "id,title,audience,roles,video,master,attachments,description\n"


def _write(env, rows: str):
    m = env / "首批" / "清单.csv"
    m.parent.mkdir(exist_ok=True)
    m.write_text(HEADER + rows, encoding="utf-8")
    return m


def _files(env):
    d = env / "首批" / "仓库基础课"
    d.mkdir(parents=True, exist_ok=True)
    (d / "第1课.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"v1" * 4000)
    (d / "第1课_说明.pdf").write_bytes(b"%PDF-1.4 lesson1")
    (d / "宣发.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"ad" * 4000)
    return d


ROWS = ("wh-basic-01,第1课 规范入库,roles,WAREHOUSE,仓库基础课/第1课.mp4,,仓库基础课/第1课_说明.pdf,\n"
        "company-intro,公司介绍,public,,仓库基础课/宣发.mp4,,,\n")


def test_import_is_idempotent_and_versions_changed_video(client, db, storage, env):
    d = _files(env)
    m = _write(env, ROWS)

    r = manifest.import_manifest(db, storage, m, actor="test")
    assert r.errors == 0
    item = db.get(MediaItem, "wh-basic-01")
    assert item.published_version.version_no == 1 and len(item.attachments) == 1
    assert any("confirm-public company-intro" in line for line in r.lines)
    assert db.get(MediaItem, "company-intro").public_confirmed_at is None

    # 原样再跑：什么都不传
    r = manifest.import_manifest(db, storage, m)
    assert r.errors == 0 and not any("已传" in line or "已挂" in line for line in r.lines)

    # 视频换了：传 v2 并发布，固定链接照旧能播
    (d / "第1课.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"v2" * 4000)
    r = manifest.import_manifest(db, storage, m)
    db.refresh(item)
    assert item.published_version.version_no == 2
    login(client, role="WAREHOUSE")
    assert client.get("/api/m/wh-basic-01/play").json()["version"] == 2


def test_dry_run_changes_nothing(client, db, storage, env):
    _files(env)
    r = manifest.import_manifest(db, storage, _write(env, ROWS), dry_run=True)
    assert r.errors == 0 and any("新建" in line for line in r.lines)
    assert db.get(MediaItem, "wh-basic-01") is None


def test_missing_file_or_bad_row_only_skips_that_item(client, db, storage, env):
    _files(env)
    rows = ROWS + ("wh-basic-02,第2课,roles,WAREHOUSE,仓库基础课/没有这个.mp4,,,\n"
                   "wh-basic-03,第3课,roles,,仓库基础课/第1课.mp4,,,\n")
    r = manifest.import_manifest(db, storage, _write(env, rows))
    assert r.errors == 2
    assert db.get(MediaItem, "wh-basic-01") is not None
    assert db.get(MediaItem, "wh-basic-02") is None and db.get(MediaItem, "wh-basic-03") is None


def test_audience_change_is_reported(client, db, storage, env):
    _files(env)
    manifest.import_manifest(db, storage, _write(env, ROWS))
    r = manifest.import_manifest(db, storage, _write(env, ROWS.replace("roles,WAREHOUSE", "staff,")))
    assert any("受众 roles WAREHOUSE → staff" in line for line in r.lines)
    assert db.get(MediaItem, "wh-basic-01").audience == "staff"


def test_network_error_skips_item_and_rerun_fills_in(client, db, storage, env, monkeypatch):
    _files(env)
    m = _write(env, ROWS)
    real_put = storage.put_file

    def flaky(key, path, content_type, sha256):
        if "company-intro" in key:
            raise ConnectionError("The write operation timed out")
        return real_put(key, path, content_type, sha256)

    monkeypatch.setattr(storage, "put_file", flaky)
    seen = []
    r = manifest.import_manifest(db, storage, m, on_line=seen.append)
    assert r.errors == 1 and seen == r.lines
    assert any("上传出错（ConnectionError）" in line for line in r.lines)
    assert db.get(MediaItem, "wh-basic-01").published_version is not None
    assert db.get(MediaItem, "company-intro").published_version is None

    monkeypatch.setattr(storage, "put_file", real_put)
    r = manifest.import_manifest(db, storage, m)
    assert r.errors == 0 and db.get(MediaItem, "company-intro").published_version.version_no == 1
    assert not any(line.startswith("wh-basic-01\t已传") for line in r.lines)

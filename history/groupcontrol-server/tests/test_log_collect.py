"""远程取日志：下待办 → 端上认领 → 上传 → 归档。

为什么这条链路做成「待办」而不是在线推送：要日志的时候，那台机器往往正好不在线
（关机、断网、进程崩了）。做成待办后，端上每次心跳、每次启动都问一句——
**在线就立刻传，不在线就下次启动补传，一条路覆盖两种情况**。

这里钉死的：
  1. 心跳回包捎待办（这是"在线时"与"下次启动"共用的那条路）；
  2. 同一个端不叠单——排障时手抖点三次，不该让端上传三个包；
  3. 传完即出队，心跳不再重复要；
  4. 桌面端没有心跳，走 pending 自己问，且只看得到自己的；
  5. 超大包拒收，并把原因写回待办（不能让一台刷日志的机器把服务器磁盘吃穿）。
"""
import asyncio
import io
import zipfile
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.datastructures import Headers, UploadFile

from app import api
from app.models import Device, DeviceStatus, LogRequest, LogRequestStatus
from app.schemas import HeartbeatIn, LogRequestIn


def _device(db, token="tk"):
    dev = Device(name="win-01", status=DeviceStatus.ONLINE, token=token, kind="browser")
    db.add(dev)
    db.commit()
    return dev.id


def _zip_bytes(payload=b"hello token=abcdefgh"):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("executor.log", payload)
    return buf.getvalue()


def _upload(db, request_id, blob):
    file = UploadFile(filename="x.zip", file=io.BytesIO(blob),
                      headers=Headers({"content-type": "application/zip"}))
    return asyncio.run(api.upload_logs(request_id=request_id, file=file, db=db))


@pytest.fixture(autouse=True)
def _inbox(tmp_path, monkeypatch):
    """日志包落在临时目录，别往仓库里写东西。"""
    monkeypatch.setattr(api, "LOG_INBOX", Path(tmp_path) / "logs_inbox")


def test_心跳捎回取日志待办(db):
    did = _device(db)
    beat = api.device_heartbeat(did, HeartbeatIn(token="tk"), db)
    assert beat["log_request"] is None, "没下待办时不该凭空冒出来"

    created = api.request_logs(LogRequestIn(owner_kind="device", owner_id=did, days=3,
                                            note="排查门铃"), db)
    beat = api.device_heartbeat(did, HeartbeatIn(token="tk"), db)
    assert beat["log_request"]["id"] == created["id"]
    assert beat["log_request"]["days"] == 3
    assert beat["log_request"]["note"] == "排查门铃"


def test_同一个端不叠单(db):
    did = _device(db)
    first = api.request_logs(LogRequestIn(owner_kind="device", owner_id=did), db)
    again = api.request_logs(LogRequestIn(owner_kind="device", owner_id=did, days=30), db)
    assert again["reused"] is True and again["id"] == first["id"], \
        "手抖点三次不该让端上传三个包"
    assert db.query(LogRequest).count() == 1


def test_传完即出队并归档(db):
    did = _device(db)
    rid = api.request_logs(LogRequestIn(owner_kind="device", owner_id=did), db)["id"]
    blob = _zip_bytes()

    assert _upload(db, rid, blob)["size"] == len(blob)

    db.expire_all()
    assert api.device_heartbeat(did, HeartbeatIn(token="tk"), db)["log_request"] is None, \
        "已经传回来的待办还挂在那里，端上就会一直重复传"
    row = db.get(LogRequest, rid)
    assert row.status == LogRequestStatus.UPLOADED
    assert row.size_bytes == len(blob) and row.uploaded_at is not None
    assert Path(row.path).exists(), "落盘路径要真的有文件"
    assert row.path.endswith(".zip"), "扩展名要跟随上传方，别一律当 zip"
    assert zipfile.ZipFile(row.path).namelist() == ["executor.log"]


def test_桌面端的gz也收(db):
    """桌面端不能引新依赖，传的是内置 zlib 压的 .log.gz —— 服务端不能只认 zip。"""
    import gzip
    rid = api.request_logs(LogRequestIn(owner_kind="desktop", owner_id="mac-1"), db)["id"]
    blob = gzip.compress(b"hello")
    file = UploadFile(filename="mac.log.gz", file=io.BytesIO(blob),
                      headers=Headers({"content-type": "application/gzip"}))
    asyncio.run(api.upload_logs(request_id=rid, file=file, db=db))
    db.expire_all()
    row = db.get(LogRequest, rid)
    assert row.path.endswith(".log.gz"), row.path
    assert gzip.decompress(Path(row.path).read_bytes()) == b"hello"


def test_桌面端走pending且只看得到自己的(db):
    api.request_logs(LogRequestIn(owner_kind="desktop", owner_id="mac-abc", days=30), db)
    mine = api.pending_logs(owner_kind="desktop", owner_id="mac-abc", db=db)
    assert mine["log_request"]["days"] == 30
    assert api.pending_logs(owner_kind="desktop", owner_id="别人的机器", db=db)["log_request"] is None
    # 设备与桌面端各按各的 owner_kind 隔开，不会串台
    assert api.pending_logs(owner_kind="device", owner_id="mac-abc", db=db)["log_request"] is None


def test_天数夹在合理区间(db):
    a = api.request_logs(LogRequestIn(owner_kind="desktop", owner_id="m1", days=999), db)
    assert db.get(LogRequest, a["id"]).days == 30, "本地只留 30 天，要更久也没有"
    b = api.request_logs(LogRequestIn(owner_kind="desktop", owner_id="m2", days=0), db)
    assert db.get(LogRequest, b["id"]).days == 1


def test_超大包拒收并写回原因(db, monkeypatch):
    monkeypatch.setattr(api, "_MAX_LOG_BYTES", 128)
    did = _device(db)
    rid = api.request_logs(LogRequestIn(owner_kind="device", owner_id=did), db)["id"]

    with pytest.raises(HTTPException) as exc:
        _upload(db, rid, _zip_bytes(b"x" * 4096))
    assert exc.value.status_code == 413

    db.expire_all()
    row = db.get(LogRequest, rid)
    assert row.status == LogRequestStatus.PENDING, "拒收不该把待办标成已完成"
    assert "超过上限" in (row.error or ""), "得留下原因，否则现场只看到传不上去"


def test_待办不存在时明确报错(db):
    with pytest.raises(HTTPException) as exc:
        _upload(db, "查无此单", _zip_bytes())
    assert exc.value.status_code == 404

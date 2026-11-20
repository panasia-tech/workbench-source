"""维护操作：建资料、传新版本（回读校验）、发布 / 回退、挂配套文件、开外部凭证。命令行 scripts/mediactl.py 调这里。"""
import mimetypes
import re
from datetime import timedelta
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.auth import hash_token, new_pass_token
from app.models import (
    AUDIENCES,
    Attachment,
    ExternalPass,
    MediaItem,
    MediaVersion,
    PublishLog,
    utcnow,
)
from app.storage import Storage, file_sha256

ITEM_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{2,63}$")

CONTENT_TYPES = {
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".md": "text/markdown; charset=utf-8",
    ".srt": "text/plain; charset=utf-8",
    ".vtt": "text/vtt; charset=utf-8",
}


class LibraryError(Exception):
    pass


def guess_type(path: Path) -> str:
    return CONTENT_TYPES.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def get_item(db: Session, item_id: str) -> MediaItem:
    item = db.get(MediaItem, item_id)
    if item is None:
        raise LibraryError(f"没有资料 {item_id}")
    return item


def create_item(db: Session, item_id: str, title: str, *, kind: str = "video", audience: str = "staff",
                roles: str = "", description: str = "", series: str = "", sort: int = 0) -> MediaItem:
    if not ITEM_ID_RE.match(item_id):
        raise LibraryError("资料 ID 只能用小写字母、数字和横线，3~64 位，字母或数字开头")
    if audience not in AUDIENCES:
        raise LibraryError(f"受众只能是 {' / '.join(AUDIENCES)}")
    if audience == "roles" and not roles.strip():
        raise LibraryError("岗位专属资料要写 roles（ERP 角色或平台分组，逗号分隔）")
    if db.get(MediaItem, item_id):
        raise LibraryError(f"资料 {item_id} 已经有了")
    item = MediaItem(id=item_id, title=title, kind=kind, audience=audience, roles=roles, description=description,
                     series=series, sort=sort)
    db.add(item)
    db.commit()
    return item


def _upload_verified(storage: Storage, key: str, path: Path, content_type: str) -> tuple[int, str, bool]:
    sha = file_sha256(path)
    size = path.stat().st_size
    storage.put_file(key, path, content_type, sha)
    info = storage.head(key)
    ok = info is not None and info.size == size and info.sha256 == sha
    return size, sha, ok


def add_version(db: Session, storage: Storage, item_id: str, file: Path, *, master: Path | None = None,
                note: str = "") -> MediaVersion:
    item = get_item(db, item_id)
    if not file.is_file():
        raise LibraryError(f"找不到文件 {file}")
    no = (db.scalar(select(func.max(MediaVersion.version_no)).where(MediaVersion.item_id == item_id)) or 0) + 1
    # 每个版本一个新路径，旧版本的对象不动，回退才有东西可回
    prefix = f"media/{item.id}/v{no}"
    ctype = guess_type(file)
    key = f"{prefix}/play{file.suffix.lower()}"
    size, sha, ok = _upload_verified(storage, key, file, ctype)
    v = MediaVersion(item_id=item.id, version_no=no, object_key=key, content_type=ctype, size=size, sha256=sha,
                     source_path=str(file), note=note, verified_at=utcnow() if ok else None)
    if master is not None:
        mkey = f"{prefix}/master{master.suffix.lower()}"
        msize, msha, mok = _upload_verified(storage, mkey, master, guess_type(master))
        v.master_key, v.master_size, v.master_sha256 = mkey, msize, msha
        if not mok:
            v.verified_at = None
    db.add(v)
    db.commit()
    if v.verified_at is None:
        raise LibraryError(f"v{no} 传上去了但回读大小或校验值对不上，不能发布；重传一次")
    return v


def publish(db: Session, item_id: str, version_no: int, *, actor: str = "", action: str = "publish") -> MediaItem:
    item = get_item(db, item_id)
    v = db.scalar(select(MediaVersion).where(MediaVersion.item_id == item_id, MediaVersion.version_no == version_no))
    if v is None:
        raise LibraryError(f"{item_id} 没有 v{version_no}")
    if v.verified_at is None:
        raise LibraryError(f"{item_id} v{version_no} 没通过上传校验，不能发布")
    if item.published_version_id == v.id:
        return item
    db.add(PublishLog(item_id=item.id, from_version_id=item.published_version_id, to_version_id=v.id,
                      action=action, actor=actor))
    item.published_version_id = v.id
    db.commit()
    return item


def rollback(db: Session, item_id: str, *, actor: str = "") -> MediaItem:
    """回到上一次发布前的那个版本。"""
    get_item(db, item_id)
    last = db.scalar(select(PublishLog).where(PublishLog.item_id == item_id).order_by(PublishLog.id.desc()))
    if last is None or last.from_version_id is None:
        raise LibraryError(f"{item_id} 没有可回退的上一个已发布版本")
    prev = db.get(MediaVersion, last.from_version_id)
    return publish(db, item_id, prev.version_no, actor=actor, action="rollback")


def confirm_public(db: Session, item_id: str, by: str) -> MediaItem:
    item = get_item(db, item_id)
    if item.audience != "public":
        raise LibraryError(f"{item_id} 的受众不是 public")
    item.public_confirmed_by, item.public_confirmed_at = by, utcnow()
    db.commit()
    return item


def add_attachment(db: Session, storage: Storage, item_id: str, file: Path, title: str = "") -> Attachment:
    item = get_item(db, item_id)
    if not file.is_file():
        raise LibraryError(f"找不到文件 {file}")
    n = (db.scalar(select(func.count(Attachment.id)).where(Attachment.item_id == item_id)) or 0) + 1
    ctype = guess_type(file)
    key = f"media/{item.id}/files/{n}{file.suffix.lower()}"
    size, sha, ok = _upload_verified(storage, key, file, ctype)
    if not ok:
        raise LibraryError("配套文件回读大小或校验值对不上；重传一次")
    a = Attachment(item_id=item.id, title=title or file.name, object_key=key, content_type=ctype, size=size,
                   sha256=sha, source_path=str(file), verified_at=utcnow())
    db.add(a)
    db.commit()
    return a


def create_pass(db: Session, item_ids: list[str], *, label: str, days: int, created_by: str = "") -> tuple[ExternalPass, str]:
    for i in item_ids:
        get_item(db, i)
    token = new_pass_token()
    p = ExternalPass(token_sha256=hash_token(token), label=label, item_ids=",".join(item_ids),
                     expires_at=utcnow() + timedelta(days=days), created_by=created_by)
    db.add(p)
    db.commit()
    return p, token


def revoke_pass(db: Session, pass_id: int) -> ExternalPass:
    p = db.get(ExternalPass, pass_id)
    if p is None:
        raise LibraryError(f"没有凭证 {pass_id}")
    p.revoked_at = p.revoked_at or utcnow()
    db.commit()
    return p

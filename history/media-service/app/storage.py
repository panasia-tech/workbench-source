"""对象存储：生产用私有 OSS 桶 + 签名地址；开发和测试用本地目录，由本服务按同样的规则签名出文件。

浏览器拿到签名地址后直接找 OSS 读视频（拖动进度靠 Range），本服务不转发视频数据。
"""
import base64
import hashlib
import hmac
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from urllib.parse import quote, urlencode

from app.config import Settings

SHA256_META = "sha256"


@dataclass
class ObjectInfo:
    size: int
    sha256: str | None


class Storage(Protocol):
    # 签名地址能不能指定按什么类型、预览还是下载返回；不能的话，要预览的小文件由本服务转发
    can_override: bool

    def put_file(self, key: str, path: Path, content_type: str, sha256: str) -> None: ...

    def head(self, key: str) -> ObjectInfo | None: ...

    def signed_url(self, key: str, ttl: int, *, content_type: str, disposition: str) -> str: ...

    def read_chunks(self, key: str) -> Iterator[bytes]: ...

    def total_bytes(self) -> int: ...


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def content_disposition(disposition: str, filename: str) -> str:
    # 中文文件名按 RFC 5987 写 filename*，再给一个 ASCII 兜底
    fallback = filename.encode("ascii", "ignore").decode() or "file"
    return f"{disposition}; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename)}"


# ---------------------------------------------------------------- 本地


class LocalStorage:
    can_override = True

    def __init__(self, root: str, base_url: str, secret: str):
        self.root = Path(root)
        self.base_url = base_url.rstrip("/")
        self.secret = secret.encode()

    def path_for(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if self.root.resolve() not in p.parents:
            raise ValueError("对象路径越界")
        return p

    def put_file(self, key: str, path: Path, content_type: str, sha256: str) -> None:
        dest = self.path_for(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(path.read_bytes())
        dest.with_name(dest.name + ".sha256").write_text(sha256)

    def head(self, key: str) -> ObjectInfo | None:
        p = self.path_for(key)
        if not p.is_file():
            return None
        meta = p.with_name(p.name + ".sha256")
        return ObjectInfo(size=p.stat().st_size, sha256=meta.read_text().strip() if meta.exists() else None)

    def _sig(self, key: str, expires: int, content_type: str, disposition: str) -> str:
        msg = f"{key}\n{expires}\n{content_type}\n{disposition}".encode()
        return base64.urlsafe_b64encode(hmac.new(self.secret, msg, hashlib.sha256).digest()).decode().rstrip("=")

    def signed_url(self, key: str, ttl: int, *, content_type: str, disposition: str) -> str:
        expires = int(time.time()) + ttl
        q = urlencode({"e": expires, "ct": content_type, "cd": disposition,
                       "s": self._sig(key, expires, content_type, disposition)})
        return f"{self.base_url}/_local/{quote(key)}?{q}"

    def read_chunks(self, key: str) -> Iterator[bytes]:
        with self.path_for(key).open("rb") as f:
            yield from iter(lambda: f.read(1 << 16), b"")

    def total_bytes(self) -> int:
        return sum(p.stat().st_size for p in self.root.rglob("*") if p.is_file() and p.suffix != ".sha256")

    def verify(self, key: str, expires: int, content_type: str, disposition: str, sig: str) -> bool:
        if expires < time.time():
            return False
        return hmac.compare_digest(sig, self._sig(key, expires, content_type, disposition))


# ---------------------------------------------------------------- OSS


class OssStorage:
    def __init__(self, s: Settings):
        import oss2

        self._oss2 = oss2
        auth = oss2.Auth(s.oss_access_key_id, s.oss_access_key_secret)
        # 上传和回读走地域节点；签名用自定义域名，浏览器打开视频才会播放而不是下载
        self.bucket = oss2.Bucket(auth, s.oss_endpoint, s.oss_bucket, connect_timeout=s.oss_timeout_seconds)
        self.upload_threads = s.oss_upload_threads
        self.sign_bucket = (
            oss2.Bucket(auth, s.oss_cname, s.oss_bucket, is_cname=True) if s.oss_cname else self.bucket
        )
        self.storage_class = s.oss_storage_class
        self.can_override = bool(s.oss_cname)

    def put_file(self, key: str, path: Path, content_type: str, sha256: str) -> None:
        headers = {
            "Content-Type": content_type,
            "x-oss-object-acl": "private",
            "x-oss-storage-class": self.storage_class,
            f"x-oss-meta-{SHA256_META}": sha256,
        }
        self._oss2.resumable_upload(self.bucket, key, str(path), headers=headers,
                                    multipart_threshold=32 << 20, part_size=8 << 20, num_threads=self.upload_threads)

    def head(self, key: str) -> ObjectInfo | None:
        try:
            meta = self.bucket.head_object(key)
        except self._oss2.exceptions.NotFound:
            return None
        return ObjectInfo(size=meta.content_length, sha256=meta.headers.get(f"x-oss-meta-{SHA256_META}"))

    def signed_url(self, key: str, ttl: int, *, content_type: str, disposition: str) -> str:
        # 默认域名不许改响应头（带了回 400 InvalidRequest），而且一律按下载返回：<video> 照样能播，
        # PDF 这类要预览的由本服务转发。类型在上传时已经写进对象
        params = ({"response-content-type": content_type, "response-content-disposition": disposition}
                  if self.can_override else None)
        return self.sign_bucket.sign_url("GET", key, ttl, params=params, slash_safe=True)

    def read_chunks(self, key: str) -> Iterator[bytes]:
        yield from self.bucket.get_object(key)

    def total_bytes(self) -> int:
        # 桶统计有一小时左右的延迟，估费用够用
        return self.bucket.get_bucket_stat().storage_size_in_bytes


def build_storage(s: Settings) -> Storage:
    if s.storage == "oss":
        missing = [n for n in ("oss_endpoint", "oss_bucket", "oss_access_key_id", "oss_access_key_secret")
                   if not getattr(s, n)]
        if missing:
            raise RuntimeError(f"MEDIA_STORAGE=oss 但没配：{', '.join(m.upper() for m in missing)}")
        return OssStorage(s)
    return LocalStorage(s.local_root, s.base_url, s.session_secret)

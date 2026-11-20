import hashlib
import os
import time
import uuid



import oss2



from app.config import settings





class OssNotConfiguredError(Exception):

    """OSS_BUCKET / OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET 未配置。"""





def get_oss_bucket() -> oss2.Bucket:

    if not all([settings.oss_bucket, settings.oss_access_key_id, settings.oss_access_key_secret]):

        raise OssNotConfiguredError(

            "OSS 未配置：请设置 OSS_BUCKET、OSS_ACCESS_KEY_ID、OSS_ACCESS_KEY_SECRET"

        )

    auth = oss2.Auth(settings.oss_access_key_id, settings.oss_access_key_secret)

    return oss2.Bucket(auth, settings.oss_endpoint, settings.oss_bucket)





def delete_object_keys(keys: list[str]) -> dict:

    unique = sorted({k for k in keys if k})

    if not unique:

        return {"deleted": 0, "failed": []}

    bucket = get_oss_bucket()

    failed: list[str] = []

    deleted = 0

    for key in unique:

        try:

            bucket.delete_object(key)

            deleted += 1

        except Exception:

            failed.append(key)

    return {"deleted": deleted, "failed": failed}





def sign_download_url(object_key: str, expires: int = 86400) -> str:

    bucket = get_oss_bucket()

    return bucket.sign_url("GET", object_key, expires)





def _object_key(dir_prefix: str, filename: str | None) -> str:
    name = (filename or uuid.uuid4().hex).strip()
    if "." not in name.rsplit("/", 1)[-1]:
        name = f"{name}.jpg"
    return f"{dir_prefix.rstrip('/')}/{name}"


_B36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def upload_filename(client_filename: str | None, content: bytes) -> str:
    """客户端上传的对象名：毫秒时间戳转 36 进制（8 位）+ 内容 MD5 前 8 位 + 原扩展名（没有按 .jpg）。

    客户端一直拿 Date.now() 当文件名，一次多选几张时同一毫秒的几张同名，后传完的悄悄覆盖先传完的
    （2026-10-15 一台显示器上架 4 张图只剩 2 张）。前 8 位能还原上传时间，后 8 位能拿 md5sum 对图。
    """
    ext = os.path.splitext((client_filename or "").strip().rsplit("/", 1)[-1])[1] or ".jpg"
    ms = time.time_ns() // 1_000_000
    stamp = ""
    while ms:
        ms, r = divmod(ms, 36)
        stamp = _B36[r] + stamp
    return f"{stamp}{hashlib.md5(content).hexdigest()[:8]}{ext}"


def canonical_public_url(object_key: str) -> str:
    if settings.oss_public_base:
        return f"{settings.oss_public_base.rstrip('/')}/{object_key}"
    bucket = get_oss_bucket()
    return f"https://{settings.oss_bucket}.{bucket.endpoint.replace('https://', '').replace('http://', '')}/{object_key}"


def upload_object(
    dir_prefix: str,
    filename: str,
    content: bytes,
    content_type: str | None = None,
) -> dict:
    bucket = get_oss_bucket()
    key = _object_key(dir_prefix, filename)
    headers = {"Content-Type": content_type or "image/jpeg"}
    bucket.put_object(key, content, headers=headers)
    return {
        "object_key": key,
        "public_url": canonical_public_url(key),
        "access_url": sign_download_url(key, expires=3600),
    }


def generate_upload_token(dir_prefix: str, filename: str) -> dict:

    bucket = get_oss_bucket()

    key = _object_key(dir_prefix, filename)

    upload_url = bucket.sign_url("PUT", key, 3600)
    access_url = sign_download_url(key, expires=3600)
    public_url = canonical_public_url(key)

    return {

        "upload_url": upload_url,

        "object_key": key,

        "public_url": public_url,

        "access_url": access_url,

        "expires_in": 3600,

    }



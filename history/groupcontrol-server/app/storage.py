"""截图证据落地:配了 OSS 就上传,否则写本地 ./shots。

流程失败时 Engine 会 save_shot(name, bytes),返回的 key/path 存进 Task.shot_key,
供 ERP 异常队列/后台回看。OSS 凭证在 .env(与 ERP 同 bucket,前缀 gc/shots/)。
"""

import logging
import os
import time

from app.config import settings

logger = logging.getLogger("gc.storage")

_bucket = None


def _get_bucket():
    global _bucket
    if _bucket is not None:
        return _bucket
    if not (settings.oss_endpoint and settings.oss_key and settings.oss_secret and settings.oss_bucket):
        return None
    try:
        import oss2
        auth = oss2.Auth(settings.oss_key, settings.oss_secret)
        _bucket = oss2.Bucket(auth, settings.oss_endpoint, settings.oss_bucket)
        return _bucket
    except Exception as e:
        logger.warning("OSS 初始化失败,截图改存本地:%s", e)
        return None


def save_blob(name: str, data: bytes, ext: str) -> str:
    """存一份证据文件(截图/日志 JSON),返回 key(OSS)或本地路径。名字带时间戳防覆盖。
    name 可带子目录(如 trace/<task>/001_tap)——OSS key 天然支持;本地回退需先建目录。"""
    fname = f"{int(time.time())}_{name}.{ext}"
    bucket = _get_bucket()
    if bucket is not None:
        key = f"{settings.oss_shot_prefix}{fname}"
        try:
            bucket.put_object(key, data)
            return key
        except Exception as e:
            logger.warning("OSS 上传失败,回退本地:%s", e)
    path = os.path.join("shots", fname)
    os.makedirs(os.path.dirname(path) or "shots", exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    return path


def save_shot(name: str, data: bytes) -> str:
    """存一张截图,返回 key(OSS)或本地路径。名字带时间戳防覆盖。"""
    return save_blob(name, data, "png")


def load_blob(key: str | None) -> bytes | None:
    """读回 save_blob 存下的文件(OSS key 或本地路径),读不到返回 None。"""
    if not key:
        return None
    bucket = _get_bucket()
    if bucket is not None and key.startswith(settings.oss_shot_prefix):
        try:
            return bucket.get_object(key).read()
        except Exception as e:
            logger.warning("OSS 读取失败 %s:%s", key, e)
            return None
    # 本地回退只认 shots/ 下面的文件
    path = os.path.normpath(key)
    if path.startswith("shots" + os.sep) and os.path.isfile(path):
        with open(path, "rb") as f:
            return f.read()
    return None


def signed_url(key: str | None, expires: int = 1800, width: int | None = None) -> str | None:
    """OSS 上的证据文件 → 限时直链(后台回放看截图);给了 width 就让 OSS 缩到这么宽。
    本地路径或没配 OSS → None:本地截图只在开发机上,后台本来就看不到。"""
    if not key:
        return None
    bucket = _get_bucket()
    if bucket is None or not key.startswith(settings.oss_shot_prefix):
        return None
    params = {"x-oss-process": f"image/resize,w_{width}"} if width else None
    try:
        url = bucket.sign_url("GET", key, expires, params=params)
    except Exception as e:
        logger.warning("截图签名失败 %s:%s", key, e)
        return None
    # endpoint 没写协议时 oss2 出的是 http 链接;后台是 https 页面,混合内容会被浏览器拦
    return "https://" + url[len("http://"):] if url.startswith("http://") else url


def bucket_host() -> str | None:
    """本桶的直链域名「<bucket>.<endpoint 域名>」(和 ERP 同桶,ERP 存的商品图就是这个域名)。没配 OSS → None。"""
    if not (settings.oss_bucket and settings.oss_endpoint):
        return None
    endpoint = settings.oss_endpoint.split("://", 1)[-1].strip("/")
    return f"{settings.oss_bucket}.{endpoint}".lower()


def sign_object_url(key: str | None, expires: int = 86400, process: str | None = None) -> str | None:
    """本桶任意对象 → 限时直链(聊天里发出去的图片 / 视频);process 是 OSS 图片缩放 / 视频截帧参数。
    只给聊天媒体用,别拿它签截图证据(那个走 signed_url,限在 gc/shots/ 下)。没配 OSS → None。"""
    if not key:
        return None
    bucket = _get_bucket()
    if bucket is None:
        return None
    params = {"x-oss-process": process} if process else None
    try:
        url = bucket.sign_url("GET", key, expires, params=params)
    except Exception as e:
        logger.warning("聊天媒体签名失败 %s:%s", key, e)
        return None
    return "https://" + url[len("http://"):] if url.startswith("http://") else url

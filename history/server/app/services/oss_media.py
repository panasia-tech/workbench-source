"""OSS URL 解析、签名与归档后不可用标记。"""

from __future__ import annotations

import re
from urllib.parse import parse_qsl, unquote, urlencode, urlparse, urlsplit, urlunsplit

from app.config import settings

OSS_UNAVAILABLE_PREFIX = "__OSS_UNAVAILABLE__|"

# 合法 OSS 对象键：ascii 路径 + 文件扩展名（上传时 _object_key 会保证带扩展名）。
# 用于把物流轨迹文字、备注等自由文本挡在“当成媒体路径去签名”之外。
_OBJECT_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_\-./]*\.[A-Za-z0-9]{1,8}$")


def _looks_like_object_key(value: str | None) -> bool:
    return bool(value and _OBJECT_KEY_RE.match(value))


VIDEO_EXTENSIONS = (".mp4", ".mov", ".m4v", ".webm", ".avi")


def is_oss_url_unavailable(url: str | None) -> bool:
    return bool(url and str(url).startswith(OSS_UNAVAILABLE_PREFIX))


def is_video_url(url: str | None) -> bool:
    """按扩展名判定是否视频（与小程序端 utils/media.js 的判定保持一致）。"""
    if not url:
        return False
    base = str(url).split("?", 1)[0].lower()
    return base.endswith(VIDEO_EXTENSIONS)


def first_non_video_url(urls: list | None) -> str | None:
    """取列表中第一个可用且非视频的 URL，用作封面（视频不能直接做封面缩略图）。"""
    for u in urls or []:
        if u and not is_oss_url_unavailable(u) and not is_video_url(u):
            return u
    return None


def mark_oss_url_unavailable(url: str | None) -> str | None:
    if not url or is_oss_url_unavailable(url):
        return url
    return f"{OSS_UNAVAILABLE_PREFIX}{url}"


def mark_oss_urls_unavailable(urls: list | None) -> list:
    if not urls:
        return []
    return [mark_oss_url_unavailable(u) for u in urls if u]


def _url_already_oss_signed(url: str) -> bool:
    """已带 OSS 预签名 query 的 URL 勿再次签名（否则路径会变成 %252F 导致 404）。"""
    _, _, query = url.partition("?")
    return bool(query and "OSSAccessKeyId=" in query and "Signature=" in query)


def strip_oss_signature(url: str | None) -> str | None:
    """去掉 OSS 预签名 query + 还原被编码的路径，得到可长期保存的干净原始 URL。
    存库时用它：签名 URL 只有 24h 有效期，直接钉进 SkuListingInfo.images 会导致
    重发时（sign_oss_url 见已签名即跳过重签）复用过期签名 → push_media 下载失败。
    非签名 URL 原样返回（幂等），不碰占位/异常 URL。"""
    if not isinstance(url, str) or not url.strip():
        return url
    if not _url_already_oss_signed(url):
        return url
    from urllib.parse import unquote, urlparse, urlunparse

    p = urlparse(url)
    return urlunparse((p.scheme, p.netloc, unquote(p.path), "", "", ""))


def _is_placeholder_oss() -> bool:
    """本机开发用的假图床：endpoint 是本机地址且桶名是 local-dev-fake* 时不做签名。

    签名会按 .env 里的 endpoint/bucket 生成 URL；本地是假 endpoint，签出来是
    http://127.0.0.1:9/...，图片全打不开。此时直接返回库里保存的公开原图 URL
    （复制库里的 OSS 图本身是公开读的），只影响本机。生产的 endpoint 是
    https://oss-cn-...aliyuncs.com，不会命中。
    """
    endpoint = (settings.oss_endpoint or "").strip().lower()
    host = urlsplit(endpoint).hostname or ""
    return host in {"127.0.0.1", "localhost", "::1"} and (
        settings.oss_bucket or ""
    ).startswith("local-dev-fake")


def is_placeholder_oss() -> bool:
    """Public alias: callers that must skip real OSS IO in local dev."""
    return _is_placeholder_oss()


def _with_oss_process(url: str, process: str) -> str:
    """给公开原图加 x-oss-process（缩略/压缩），本地免签名时用。"""
    parts = urlsplit(url)
    query = [
        (key, value)
        for key, value in parse_qsl(parts.query, keep_blank_values=True)
        if key.lower() != "x-oss-process"
    ]
    query.append(("x-oss-process", process))
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def _local_clean_url(url: str) -> str:
    return strip_oss_signature(url) if _url_already_oss_signed(url) else url


def public_url_to_object_key(url: str | None) -> str | None:
    if not url or is_oss_url_unavailable(url):
        return None
    raw = url
    if raw.startswith(OSS_UNAVAILABLE_PREFIX):
        raw = raw[len(OSS_UNAVAILABLE_PREFIX) :]
    parsed = urlparse(raw.split("?", 1)[0])
    path = unquote(parsed.path.lstrip("/"))
    if not path:
        return None
    base = (settings.oss_public_base or "").rstrip("/")
    if base and raw.startswith(base):
        return path
    if settings.oss_bucket and f"/{settings.oss_bucket}/" in raw:
        idx = raw.find(f"/{settings.oss_bucket}/")
        return raw[idx + len(settings.oss_bucket) + 2 :]
    if parsed.netloc and "aliyuncs.com" in parsed.netloc:
        return path
    if not parsed.netloc and "/" in raw and not raw.startswith("http"):
        key = unquote(raw.lstrip("/"))
        return key if _looks_like_object_key(key) else None
    return path if "/" in path and _looks_like_object_key(path) else None


OSS_THUMB_PROCESS = {
    "small": "image/resize,m_fill,w_120,h_120",
    "medium": "image/resize,m_fill,w_240,h_240",
}


def sign_oss_thumb_url(url: str | None, *, size: str = "small", expires: int = 86400) -> str | None:
    if not url or is_oss_url_unavailable(url):
        return url
    process = OSS_THUMB_PROCESS.get(size, OSS_THUMB_PROCESS["small"])
    if _is_placeholder_oss():
        return _with_oss_process(_local_clean_url(url), process)
    if _url_already_oss_signed(url):
        return url
    key = public_url_to_object_key(url)
    if not key:
        return sign_oss_url(url, expires)
    try:
        from app.services.oss import get_oss_bucket

        bucket = get_oss_bucket()
        return bucket.sign_url("GET", key, expires, params={"x-oss-process": process})
    except Exception:
        # 未配 OSS / 签名失败：读图页不能整页炸，回落原 URL
        return url


# 视频封面：OSS 视频截帧，取第 1 秒（太靠前常是黑屏），宽 480
OSS_VIDEO_POSTER_PROCESS = "video/snapshot,t_1000,f_jpg,w_480,m_fast"

# 交给执行端上传闲鱼的商品图：长边压到 1600（limit_1=不放大，默认值，写上是防人「顺手」
# 改成放大）。10-27 实锤：手机原图 4284x5712、单张 2.5MB，六个店同发把网页版发布页
# 卡到 dump_nodes 超时；压到 1200x1600/334KB 后和普通货一样稳。OSS 实时出图、不占存储。
# 不加 auto-orient：它要求原图宽高都 <4096，手机原图会 400 报错（实测）。
OSS_PUBLISH_IMG_PROCESS = "image/resize,l_1600,limit_1"


def sign_oss_publish_image_url(url: str | None, *, expires: int = 86400) -> str | None:
    """发布用的商品图签名 URL：本桶的对象挂上 OSS 缩放（长边 1600），执行端下载到的
    就是压过的图；外链/认不出 key 的原样签下载 URL。"""
    if not url or is_oss_url_unavailable(url):
        return url
    process = OSS_PUBLISH_IMG_PROCESS
    if _is_placeholder_oss():
        clean = _local_clean_url(url)
        if urlsplit(clean).path.lower().endswith(".webp"):
            process += "/format,jpg"
        return _with_oss_process(clean, process)
    if _url_already_oss_signed(url):
        return url
    key = public_url_to_object_key(url)
    if not key:
        return sign_oss_url(url, expires)
    from app.services.oss import get_oss_bucket

    if key.lower().endswith(".webp"):
        # 闲鱼只收 png/jpg/gif/bmp;爬虫转存来的图常是 webp
        process += "/format,jpg"
    return get_oss_bucket().sign_url("GET", key, expires, params={"x-oss-process": process})


def sign_video_poster_url(url: str | None, *, expires: int = 86400) -> str | None:
    """视频 → 截帧封面的签名 URL；不是本桶的对象（外链、已归档）给 None，前端显示占位。"""
    if not url or is_oss_url_unavailable(url):
        return None
    clean = strip_oss_signature(url)
    if _is_placeholder_oss():
        return _with_oss_process(clean, OSS_VIDEO_POSTER_PROCESS)
    key = public_url_to_object_key(clean)
    if not key:
        return None
    from app.services.oss import get_oss_bucket

    bucket = get_oss_bucket()
    return bucket.sign_url("GET", key, expires, params={"x-oss-process": OSS_VIDEO_POSTER_PROCESS})


def first_image_list_urls(images: list | None, *, expires: int = 86400) -> dict[str, str | None]:
    """列表用：首图原图签名 URL + OSS 缩略图 URL。"""
    urls = [u for u in (images or []) if u and not is_oss_url_unavailable(u)]
    if not urls:
        return {"product_image": None, "product_image_thumb": None}
    first = urls[0]
    return {
        "product_image": sign_oss_url(first, expires),
        "product_image_thumb": sign_oss_thumb_url(first, size="small", expires=expires),
    }


def thumb_url_for_cover(url: str | None, *, expires: int = 86400) -> str | None:
    return sign_oss_thumb_url(url, size="small", expires=expires)


def sign_oss_url(url: str | None, expires: int = 86400) -> str | None:
    if not url or is_oss_url_unavailable(url):
        return url
    if _is_placeholder_oss():
        return _local_clean_url(url)
    if _url_already_oss_signed(url):
        return url
    key = public_url_to_object_key(url)
    if not key:
        return url
    from app.services.oss import sign_download_url

    return sign_download_url(key, expires)


def sign_media_payload(obj, expires: int = 86400):
    if obj is None:
        return None
    if isinstance(obj, str):
        return sign_oss_url(obj, expires) or obj
    if isinstance(obj, list):
        return [sign_media_payload(item, expires) for item in obj]
    if isinstance(obj, dict):
        return {key: sign_media_payload(value, expires) for key, value in obj.items()}
    return obj

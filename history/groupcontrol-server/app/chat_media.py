"""聊天里发给买家的图片 / 视频:收什么、存什么、怎么给人看。

- 只收**本桶**(和 ERP 同桶)里的对象:执行端会照着地址去下载,外站地址一律不收,
  免得被人拿来让执行端去拉任意链接。
- 买家不能看的(订单截图、库位照、议价 / 改派取证)和发布前同一套拦法(publish_spec)。
- 存对象键不存签名链接:签名 24 小时就过期,聊天记录里的图要一直看得到,读的时候再签。
"""
import logging
import os
from urllib.parse import unquote, urlparse

from app import storage
from app.config import settings
from app.publish_spec import _FORBIDDEN_IMG_MARKERS

logger = logging.getLogger(__name__)

IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".heic", ".gif", ".bmp")
# 闲鱼网页版聊天的上传控件只收这几种、单张小于 3MB,其余静默发不出去(11-01 读 /im 页面和它的代码确认)
SENDABLE_EXTS = (".jpg", ".jpeg", ".png", ".gif", ".bmp")
MAX_SEND_BYTES = 3_000_000
_TO_SENDABLE_PROCESS = "image/resize,l_2000/format,jpg/quality,q_85"
# 闲鱼一次选图上限 9 张
MAX_IMAGES = 9
# 网页版聊天没有发视频的入口,协议层有也不去碰(真号实测发不出去)
VIDEO_BLOCKED = "闲鱼网页版聊天发不了视频，请发图片"

_THUMB_PROCESS = {
    "image": "image/resize,m_fill,w_240,h_240",
    # 视频封面:第 1 秒截帧(太靠前常是黑屏)
    "video": "video/snapshot,t_1000,f_jpg,w_480,m_fast",
}


def normalize_media(items: list[dict]) -> list[dict]:
    """[{type, url}] → [{type, key}](去重保序)。收不了的抛 ValueError,消息可直接回给页面。"""
    host = storage.bucket_host()
    if not host:
        raise ValueError("存储没配好,发不了图片和视频")
    out: list[dict] = []
    seen: set[str] = set()
    for it in items:
        kind = it.get("type")
        if kind == "video":
            raise ValueError(VIDEO_BLOCKED)
        if kind != "image":
            raise ValueError("只能发图片")
        u = urlparse((it.get("url") or "").strip())
        if u.scheme not in ("http", "https") or u.netloc.lower() != host:
            raise ValueError("只能发我们自己存储里的图片")
        key = unquote(u.path.lstrip("/"))
        if not key or key.startswith(settings.oss_shot_prefix):
            raise ValueError("这个文件不能发给买家")
        if any(m in "/" + key.lower() for m in _FORBIDDEN_IMG_MARKERS):
            raise ValueError("混进了订单截图、库位照或议价取证,不能发给买家")
        ext = os.path.splitext(key.lower())[1]
        if ext not in IMAGE_EXTS:
            raise ValueError("图片格式不对(只认 jpg / png / webp / heic / gif / bmp)")
        if key in seen:
            continue
        seen.add(key)
        out.append({"type": kind, "key": key})
    if not out:
        raise ValueError("没选图片")
    if len(out) > MAX_IMAGES:
        raise ValueError(f"图片一次最多发 {MAX_IMAGES} 张")
    return out


def prepare_images(media: list[dict]) -> list[dict]:
    """闲鱼不收的图(webp / heic、3MB 以上)让 OSS 转成 jpg 另存一份,发那一份。转不了抛 ValueError。"""
    bucket = storage._get_bucket()
    if bucket is None:
        raise ValueError("存储没配好,发不了图片")
    out = []
    for m in media:
        key = m["key"]
        stem, ext = os.path.splitext(key)
        try:
            if ext.lower() not in SENDABLE_EXTS or bucket.head_object(key).content_length >= MAX_SEND_BYTES:
                data = bucket.get_object(key, process=_TO_SENDABLE_PROCESS).read()
                if len(data) >= MAX_SEND_BYTES:
                    raise ValueError("图片太大,压缩后还是超过 3MB,请换一张")
                key = f"{stem}-send.jpg"
                bucket.put_object(key, data)
        except ValueError:
            raise
        except Exception as ex:
            logger.warning("聊天图片转换失败 key=%s: %s", key, ex)
            raise ValueError("这张图片转不了格式,请换 jpg 或 png") from ex
        out.append({**m, "key": key})
    return out


def summary_text(media: list[dict]) -> str:
    """消息列表 / 会话末条显示用的一行字:「[图片]×3 [视频]」。"""
    n_img = sum(1 for m in media if m.get("type") == "image")
    n_vid = sum(1 for m in media if m.get("type") == "video")
    parts = []
    if n_img:
        parts.append("[图片]" + (f"×{n_img}" if n_img > 1 else ""))
    if n_vid:
        parts.append("[视频]" + (f"×{n_vid}" if n_vid > 1 else ""))
    return " ".join(parts)


def media_out(media: list | None, expires: int = 86400) -> list[dict] | None:
    """存的 [{type, key}] → 给页面看的 [{type, url, thumb}](现签)。没配 OSS 时 url 为空,页面显示占位。"""
    if not media:
        return None
    out = []
    for m in media:
        key = m.get("key") if isinstance(m, dict) else None
        kind = m.get("type") if isinstance(m, dict) else None
        if not key or kind not in _THUMB_PROCESS:
            continue
        out.append({
            "type": kind,
            "url": storage.sign_object_url(key, expires),
            "thumb": storage.sign_object_url(key, expires, _THUMB_PROCESS[kind]),
        })
    return out or None

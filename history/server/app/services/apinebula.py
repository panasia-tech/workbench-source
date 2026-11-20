"""apinebula(gpt-image-2)OpenAI 兼容图像接口客户端。

与 ALAPI 的区别：apinebula 走标准 OpenAI 接口、**同步**返回结果（base64），无需
提交任务再轮询：
- 文生图：POST /v1/images/generations（JSON）
- 图生图/重绘：POST /v1/images/edits（multipart，image 文件 + prompt）

两个接口都返回 ``{"data": [{"b64_json": "..."}]}``（PNG 的 base64，无 URL）。
本模块负责调用 + 解出图片字节 + 回传本项目 OSS。
"""

from __future__ import annotations

import base64
import logging
import mimetypes
import os

import httpx
from fastapi import HTTPException

from app.config import settings
from app.services.oss import upload_object

logger = logging.getLogger(__name__)

# gpt-image-2 同步出图 ~30-90 秒，超时给足；下载参考图/结果图单独短超时。
REQUEST_TIMEOUT = 180
DOWNLOAD_TIMEOUT = 60


class ApiNebulaError(Exception):
    pass


def _ensure_key() -> str:
    key = settings.apinebula_api_key.strip()
    if not key:
        raise HTTPException(status_code=503, detail="APINEBULA_API_KEY 未配置")
    return key


def _auth_headers() -> dict:
    return {"Authorization": f"Bearer {_ensure_key()}"}


def _base() -> str:
    return settings.apinebula_base_url.rstrip("/")


def _norm_size(size: str | None) -> str:
    """归一化尺寸。仅接受 OpenAI 的 WxH 形式（如 1024x1024），其余回退默认。

    仓库标签里 ai_size 可能是 "auto" 或 1k/2k 分辨率写法，这些 OpenAI 生图接口不认，
    统一回退到 1024x1024（实测 apinebula 接受该值）。"""
    s = (size or "").strip().lower()
    if "x" in s and s.replace("x", "").isdigit():
        return s
    return "1024x1024"


def _download(url: str) -> tuple[bytes, str]:
    try:
        resp = httpx.get(url, timeout=DOWNLOAD_TIMEOUT)
    except httpx.HTTPError as exc:
        raise ApiNebulaError("下载图片失败") from exc
    if resp.status_code != 200:
        raise ApiNebulaError(f"下载图片失败 HTTP {resp.status_code}")
    content_type = resp.headers.get("Content-Type", "image/png").split(";")[0].strip() or "image/png"
    return resp.content, content_type


def _parse(resp: httpx.Response) -> dict:
    if resp.status_code != 200:
        detail = f"apinebula HTTP {resp.status_code}"
        try:
            body = resp.json()
            detail = (body.get("error") or {}).get("message") or body.get("message") or detail
        except Exception:
            logger.warning("apinebula HTTP %s: %s", resp.status_code, resp.text[:500])
        raise HTTPException(status_code=502, detail=detail)
    return resp.json()


def _extract_image(body: dict) -> tuple[bytes, str]:
    """从 OpenAI 兼容响应解出图片字节 + content-type。优先 b64_json，兼容 url。"""
    data = body.get("data") or []
    if not data:
        err = (body.get("error") or {}).get("message") if isinstance(body.get("error"), dict) else body.get("error")
        raise ApiNebulaError(f"未返回图片: {err or body.get('message') or '空响应'}")
    item = data[0]
    if isinstance(item, dict):
        b64 = item.get("b64_json")
        if b64:
            try:
                return base64.b64decode(b64), "image/png"
            except Exception as exc:
                raise ApiNebulaError("b64_json 解码失败") from exc
        url = item.get("url")
        if url:
            return _download(url)
    raise ApiNebulaError("响应中无 b64_json/url")


def generate_image(
    prompt: str,
    image_url: str | None = None,
    size: str | None = None,
) -> tuple[bytes, str]:
    """出图。有参考图走图生图(edits)，无参考图走文生图(generations)。返回(字节, content-type)。"""
    _ensure_key()
    p = (prompt or "").strip()
    if not p:
        raise HTTPException(status_code=400, detail="提示词为空")
    sz = _norm_size(size)
    src = (image_url or "").strip()

    if src:
        # 图生图：OpenAI /v1/images/edits 需要把参考图作为文件上传（multipart）
        img_bytes, _ = _download(src)
        files = {"image": ("source.png", img_bytes, "image/png")}
        payload = {"model": settings.apinebula_model, "prompt": p, "n": "1", "size": sz}
        try:
            resp = httpx.post(
                f"{_base()}/images/edits",
                headers=_auth_headers(),
                files=files,
                data=payload,
                timeout=REQUEST_TIMEOUT,
            )
        except httpx.HTTPError as exc:
            logger.exception("apinebula edits 请求失败: %s", exc)
            raise HTTPException(status_code=502, detail="apinebula 请求失败") from exc
    else:
        # 文生图：OpenAI /v1/images/generations（JSON）
        payload = {"model": settings.apinebula_model, "prompt": p, "n": 1, "size": sz}
        try:
            resp = httpx.post(
                f"{_base()}/images/generations",
                headers=_auth_headers(),
                json=payload,
                timeout=REQUEST_TIMEOUT,
            )
        except httpx.HTTPError as exc:
            logger.exception("apinebula generations 请求失败: %s", exc)
            raise HTTPException(status_code=502, detail="apinebula 请求失败") from exc

    return _extract_image(_parse(resp))


def generate_and_upload(
    prompt: str,
    image_url: str | None = None,
    size: str | None = None,
    dir_prefix: str = "listing/ai-redraw",
) -> dict:
    """出图并回传本项目 OSS，返回 {object_key, public_url, access_url}。"""
    content, content_type = generate_image(prompt, image_url=image_url, size=size)
    ext = mimetypes.guess_extension(content_type) or ".png"
    if ext == ".jpe":
        ext = ".jpg"
    filename = f"{os.urandom(8).hex()}{ext}"
    return upload_object(dir_prefix, filename, content, content_type=content_type)

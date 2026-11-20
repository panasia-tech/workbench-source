"""ALAPI 接口客户端。gpt-image-2 异步生图 + 任务轮询 + 结果回传 OSS。"""

from __future__ import annotations

import logging
import mimetypes
import os
import time
from typing import Optional
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException

from app.config import settings
from app.services.oss import upload_object

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 30
DOWNLOAD_TIMEOUT = 60

POLL_INTERVAL_SECONDS = 5
POLL_MAX_SECONDS = 300

TERMINAL_STATUSES = {"completed", "failed", "error", "canceled", "cancelled"}


class AlapiError(Exception):
    pass


def _ensure_token() -> str:
    token = settings.alapi_token.strip()
    if not token:
        raise HTTPException(status_code=503, detail="ALAPI_TOKEN 未配置")
    return token


def submit_redraw(
    prompt: str,
    image_url: str,
    size: str | None = None,
    resolution: str | None = None,
) -> str:
    """提交异步生图任务，返回 task_id。"""
    token = _ensure_token()
    if not (prompt or "").strip():
        raise HTTPException(status_code=400, detail="提示词为空")
    if not (image_url or "").strip():
        raise HTTPException(status_code=400, detail="参考图为空")

    url = f"{settings.alapi_base_url.rstrip('/')}/api/ai/images/generations_sync"
    payload = {
        "model": "gpt-image-2",
        "prompt": prompt.strip(),
        "n": "1",
        "size": (size or "auto").strip() or "auto",
        "resolution": (resolution or "1k").strip() or "1k",
        "image_urls": image_url.strip(),
        "token": token,
    }
    try:
        resp = httpx.post(url, json=payload, timeout=REQUEST_TIMEOUT)
    except httpx.HTTPError as exc:
        logger.exception("ALAPI 提交失败: %s", exc)
        raise HTTPException(status_code=502, detail="ALAPI 请求失败") from exc

    if resp.status_code != 200:
        logger.warning("ALAPI HTTP %s: %s", resp.status_code, resp.text[:500])
        raise HTTPException(status_code=502, detail=f"ALAPI HTTP {resp.status_code}")

    body = resp.json()
    # 异步接口 data 中含 task_id；也可能直接平铺
    task_id = (body.get("data") or {}).get("task_id") or body.get("task_id")
    if not task_id:
        if not body.get("success"):
            detail = body.get("message") or "ALAPI 失败"
            raise HTTPException(status_code=502, detail=f"ALAPI: {detail}")
        raise HTTPException(status_code=502, detail="ALAPI 未返回 task_id")
    return task_id


def query_task(task_id: str) -> dict:
    """查询任务状态。返回 ALAPI 的 data 字段。"""
    token = _ensure_token()
    url = f"{settings.alapi_base_url.rstrip('/')}/api/ai/images/generations/task"
    payload = {"task_id": task_id, "token": token}
    try:
        resp = httpx.post(url, json=payload, timeout=REQUEST_TIMEOUT)
    except httpx.HTTPError as exc:
        logger.exception("ALAPI 查询失败: %s", exc)
        raise AlapiError("ALAPI 查询失败") from exc
    if resp.status_code != 200:
        raise AlapiError(f"ALAPI HTTP {resp.status_code}")
    body = resp.json()
    if not body.get("success"):
        raise AlapiError(body.get("message") or "ALAPI 查询失败")
    return body.get("data") or {}


def _extract_result_url(task_data: dict) -> Optional[str]:
    result = task_data.get("result") or {}
    images = result.get("images") or task_data.get("images") or []
    for img in images:
        if isinstance(img, dict) and img.get("url"):
            return img["url"]
        if isinstance(img, str):
            return img
    return None


def poll_until_done(
    task_id: str,
    *,
    on_tick=None,
    interval: int = POLL_INTERVAL_SECONDS,
    max_seconds: int = POLL_MAX_SECONDS,
) -> dict:
    """阻塞轮询 ALAPI 任务，到终态或超时返回 task data。"""
    deadline = time.monotonic() + max_seconds
    last_data: dict = {}
    while True:
        last_data = query_task(task_id)
        status = (last_data.get("status") or "").lower()
        if on_tick:
            try:
                on_tick(status, last_data)
            except Exception:
                logger.exception("on_tick failed")
        if status in TERMINAL_STATUSES:
            return last_data
        if time.monotonic() >= deadline:
            raise AlapiError(f"任务超时（>{max_seconds}s）")
        time.sleep(interval)


def fetch_and_upload(image_url: str, dir_prefix: str = "listing/ai-redraw") -> dict:
    """将远端图片下载并重传至本项目 OSS，返回 {object_key, public_url, access_url}。"""
    try:
        resp = httpx.get(image_url, timeout=DOWNLOAD_TIMEOUT)
    except httpx.HTTPError as exc:
        raise AlapiError("下载生成图失败") from exc
    if resp.status_code != 200:
        raise AlapiError(f"下载生成图失败 HTTP {resp.status_code}")

    content_type = resp.headers.get("Content-Type", "image/png").split(";")[0].strip() or "image/png"
    ext = mimetypes.guess_extension(content_type) or os.path.splitext(urlparse(image_url).path)[1] or ".png"
    if ext == ".jpe":
        ext = ".jpg"
    filename = f"{os.urandom(8).hex()}{ext}"
    return upload_object(dir_prefix, filename, resp.content, content_type=content_type)

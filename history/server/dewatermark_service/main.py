"""京东云上的去水印补图服务(11-10)。ERP 生产机 7G 内存放不下 LaMa,补图挪到这里跑。

只收图片字节、回补好的图和检查结果;不取网址、不存图、不记账——那些都在 ERP
(services/dewatermark.py 的远程模式)。算法就是 ERP 那份 dewatermark.py 原样拷进镜像,
两边一个口径。

- GET  /health   能不能用(依赖、模型在不在),ERP 决定按钮显不显示
- POST /process  请求体 = 图片原始字节,回 dewatermark.to_wire(结果)
两个都要带 Authorization: Bearer <DEWATERMARK_TOKEN>。/livez 给容器健康检查用,不带令牌。
"""
from __future__ import annotations

import asyncio
import hmac
import os

from fastapi import FastAPI, Header, HTTPException, Request
from starlette.concurrency import run_in_threadpool

import dewatermark as dw

TOKEN = os.environ.get("DEWATERMARK_TOKEN", "")
# 同时最多处理几张:模型推理本来就排队,这里再拦住解码 / 定位别把内存撑爆
_slots = asyncio.Semaphore(int(os.environ.get("DEWATERMARK_CONCURRENCY") or 2))

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


def _check(authorization: str | None) -> None:
    if not TOKEN or not hmac.compare_digest((authorization or "").encode(), f"Bearer {TOKEN}".encode()):
        raise HTTPException(status_code=401, detail="令牌不对")


@app.get("/livez")
def livez():
    return {"ok": True}


@app.get("/health")
def health(authorization: str | None = Header(None)):
    _check(authorization)
    ok, reason = dw.available()
    return {"available": ok, "reason": reason}


@app.post("/process")
async def process(request: Request, authorization: str | None = Header(None)):
    _check(authorization)
    content = await request.body()
    if not content or len(content) > dw.MAX_IMAGE_BYTES:
        raise HTTPException(status_code=400, detail=f"图片大小不对:{len(content)} 字节")
    async with _slots:
        try:
            result = await run_in_threadpool(dw.process, content)
        except dw.DewatermarkUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
    return dw.to_wire(result)

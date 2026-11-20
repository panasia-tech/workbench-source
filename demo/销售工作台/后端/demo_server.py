"""销售工作台本地演示，仅使用本包中的路由、合成样例和 SQLite。"""
import os
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import mkdtemp

from fastapi import FastAPI
import uvicorn

if "SALES_RUNTIME_DIR" not in os.environ:
    os.environ["SALES_RUNTIME_DIR"] = mkdtemp(prefix="sales-workbench-demo-")
Path(os.environ["SALES_RUNTIME_DIR"]).mkdir(parents=True, exist_ok=True)
# 本地 Demo 启动时重新灌装业务表，配置演练由独立本地文件保存。
from app.database import Base, SessionDemo, engine
from app.demo_api import router as core_router
from demo_data import seed

Base.metadata.create_all(engine)
IDS = seed(SessionDemo)
app = FastAPI(title="销售工作台 · 本地 Demo", docs_url=None, redoc_url=None, openapi_url=None)

from fastapi import APIRouter  # noqa: E402

_chat = APIRouter()
_NOW = datetime.utcnow()
_CONV = [
    {"id": "c1", "peer_nick": "阿杰-数码控", "account_nick": "果果数码", "item_title": "飞利浦 27M2N5510P 27英寸显示器", "item_price": "1020",
     "item_image": "/api/demo-img/MON1-1.jpg", "last_message": "能再便宜点吗？今天就拍，能开发票吗", "unread": 2, "order_status": "咨询中",
     "updated_at": (_NOW - timedelta(minutes=6)).strftime("%Y-%m-%d %H:%M:%S")},
    {"id": "c2", "peer_nick": "momo_小仓鼠", "account_nick": "果果数码", "item_title": "戴森 HT01 电吹风", "item_price": "1650",
     "item_image": "/api/demo-img/DYS-1.jpg", "last_message": "包邮吗？发顺丰可以吗", "unread": 1, "order_status": "咨询中",
     "updated_at": (_NOW - timedelta(minutes=22)).strftime("%Y-%m-%d %H:%M:%S")},
    {"id": "c3", "peer_nick": "林先生", "account_nick": "小满优选", "item_title": "小米 空气净化器 4LITE", "item_price": "359",
     "item_image": "/api/demo-img/PUR-1.jpg", "last_message": "滤网是新换的吗？能发张细节图吗", "unread": 1, "order_status": "咨询中",
     "updated_at": (_NOW - timedelta(hours=1, minutes=5)).strftime("%Y-%m-%d %H:%M:%S")},
    {"id": "c4", "peer_nick": "不吃香菜", "account_nick": "周周二手", "item_title": "创维 F24G30F 24英寸显示器", "item_price": "468",
     "item_image": "/api/demo-img/MON2-1.jpg", "last_message": "好的，已收到，谢谢", "unread": 0, "order_status": "已完成",
     "updated_at": (_NOW - timedelta(hours=5)).strftime("%Y-%m-%d %H:%M:%S")},
]


@_chat.get("/gc/chat/conversations")
async def _gc_conv(page: int = 1, size: int = 20):
    return {"items": _CONV if page == 1 else []}


@_chat.get("/gc/chat/conversations/{cid}")
async def _gc_conv_one(cid: str):
    return next((c for c in _CONV if c["id"] == cid), _CONV[0])


@_chat.get("/gc/chat/conversations/{cid}/messages")
async def _gc_msgs(cid: str, page: int = 1, size: int = 50, tail: int = 0):
    c = next((x for x in _CONV if x["id"] == cid), _CONV[0])
    t = lambda m: (_NOW - timedelta(minutes=m)).strftime("%Y-%m-%d %H:%M:%S")  # noqa: E731
    return {"items": [
        {"id": cid + "-1", "direction": "in", "type": "text", "text": "你好，这个还在吗？", "msg_at": t(30)},
        {"id": cid + "-2", "direction": "out", "type": "text", "text": "在的亲，实物拍摄，成色 95 新，功能全部正常～", "msg_at": t(28)},
        {"id": cid + "-3", "direction": "in", "type": "text", "text": c["last_message"], "msg_at": t(6)}]}


@_chat.post("/gc/chat/conversations/{cid}/read")
async def _gc_read(cid: str):
    return {"ok": True}


@_chat.post("/gc/chat/conversations/{cid}/reply")
async def _gc_reply(cid: str, body: dict = None):
    return {"ok": True, "id": cid + "-r"}


app.include_router(core_router)
app.include_router(_chat)

@app.get("/api/stitch-demo/health")
def stitch_demo_health():
    return {"mode": "stitch-sales-demo"}

import virtual_stub  # noqa: E402

app.include_router(virtual_stub.router)
import workbench_stub  # noqa: E402

workbench_stub.init(SessionDemo, IDS)
app.include_router(workbench_stub.router)
import reception_stub  # noqa: E402

app.include_router(reception_stub.router)
import pricing_stub  # noqa: E402

pricing_stub.init(SessionDemo, IDS)
app.include_router(pricing_stub.router)
import gc_stub  # noqa: E402

gc_stub.init(SessionDemo, IDS)
app.include_router(gc_stub.router)
import spec_baseline_engine  # noqa: E402

app.include_router(spec_baseline_engine.router)


if __name__ == "__main__":
    port = int(os.environ.get("STITCH_DEMO_PORT", "5342"))
    print(f"销售工作台 Stitch 演示后端：http://127.0.0.1:{port}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")

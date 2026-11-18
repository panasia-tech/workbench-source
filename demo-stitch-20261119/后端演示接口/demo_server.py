"""演示用启动器：真实的 ERP 后端（server/app），数据库换成一次性 SQLite，灌一批演示数据。

不改源码：和 tests/conftest.py 同一个思路——DATABASE_URL 填个假的 MySQL（引擎惰性、不连接），
真正用的是下面这个 SQLite 引擎，并覆盖 get_db。后台循环任务（lifespan）一律不起。
群控（真机）不在本机，用几条假数据顶替它的三个读接口，其余业务走真代码。
"""
import os
import sys
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from decimal import Decimal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "pylib"))
sys.path.insert(0, os.path.join(HERE, "server"))
os.chdir(os.path.join(HERE, "server"))
os.environ["DATABASE_URL"] = "mysql+pypostgresql://demo:demo@localhost/demo?charset=utf8mb4"

from sqlalchemy import create_engine, event  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

import app.database as appdb  # noqa: E402

# 文件型 SQLite（每次启动重建）+ WAL：并发请求各用各的连接。内存库共用一个连接，页面一次并发十几个请求就会
# 随机报「bad parameter or other API misuse」→ 500 → 页面读不到数据（这就是之前「demo 数据全没有」的一个原因）。
DBFILE = os.path.join(HERE, "demo.db")
for _f in (DBFILE, DBFILE + "-wal", DBFILE + "-shm"):
    if os.path.exists(_f):
        os.remove(_f)
engine = create_engine("sqlite:///" + DBFILE, connect_args={"check_same_thread": False, "timeout": 30}, pool_size=20, max_overflow=40)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi, _rec):
    c = dbapi.cursor()
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA busy_timeout=30000")
    c.close()

SessionDemo = sessionmaker(bind=engine, autoflush=False, autocommit=False)
appdb.SessionLocal.configure(bind=engine)

from app.database import Base, get_db  # noqa: E402
import app.models  # noqa: F401,E402

failed = []
for t in Base.metadata.sorted_tables:
    try:
        t.create(engine, checkfirst=True)
    except Exception as exc:  # noqa: BLE001  MySQL 专有类型的表建不了，演示用不到就跳过
        failed.append(t.name)
print("建表：成功 %d，跳过 %d" % (len(Base.metadata.sorted_tables) - len(failed), len(failed)), flush=True)

from app.enums import ShopListingStatus, SkuStatus, StaffRole, StaffStatus  # noqa: E402
from app.models import (  # noqa: E402
    AppSetting, ListingApproval, SaleShop, SalesOutbound, Sku, SkuListingInfo, SkuShopListing, Staff,
)
from app.services.password import hash_password  # noqa: E402
from app.services.finance import cn_today_start_utc  # noqa: E402

PWD = "demo1234"


from demo_data import seed  # noqa: E402


IDS = seed(SessionDemo)

# ---- 群控三个读接口的替身（真机不在本机）
from app.services.gc_bridge import client as gc  # noqa: E402


async def _owners():
    return {"gc-acc-1": [{"staff_id": IDS["chenxm"], "name": "陈小满"}], "gc-acc-2": [{"staff_id": IDS["chenxm"], "name": "陈小满"}],
            "gc-acc-3": [{"staff_id": IDS["zhoubb"], "name": "周小北"}]}


async def _accounts():
    return [{"id": "gc-acc-1", "nick": "果果数码"}, {"id": "gc-acc-2", "nick": "小满优选"}, {"id": "gc-acc-3", "nick": "周周二手"}]


async def _waiting():
    return {"items": [{"account": "gc-acc-1", "buyer": "买家A"}, {"account": "gc-acc-1", "buyer": "买家B"},
                      {"account": "gc-acc-2", "buyer": "买家C"}, {"account": "gc-acc-3", "buyer": "买家D"}]}


# ---- 演示图走本机静态目录，不经 OSS：把所有「签名/缩图」函数换成原样返回
from app.services import oss_media  # noqa: E402

_ident = lambda url, *a, **k: url  # noqa: E731
for _m in list(sys.modules.values()):
    for _n in ("sign_oss_url", "sign_oss_thumb_url"):
        if getattr(_m, _n, None) is not None and getattr(getattr(_m, _n), "__module__", "") == "app.services.oss_media":
            setattr(_m, _n, _ident)
oss_media.sign_oss_url = _ident
oss_media.sign_oss_thumb_url = _ident

gc.chat_sla_owners = _owners
gc.list_accounts = _accounts
gc.chat_sla_waiting = _waiting


# ---- 聊天（群控服务）的替身：会话列表、消息、已读、回复。群控不在本机，这几条用假数据
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


from fastapi.staticfiles import StaticFiles  # noqa: E402
from app.main import app  # noqa: E402

# ---- 彻底禁用旧版「员工提审 / 主管审批 / 重新审批」文案与状态标签，统一为「机器初筛 → 人工选图核价直接上架」两步闭环
try:
    from app.routers import listing_approval as _la_router
    from app.services import listing_approval as _la_svc

    _la_router.CELL_LABELS.update({
        "NONE": "待选图上架",
        "DRAFT": "已暂存待发",
        "SUBMITTED": "待确认上架",
        "APPROVED": "已清洗就绪",
        "REJECTED": "待重选",
        "STALE": "成本变动待重核",
    })
    _orig_problem = _la_svc.problem_for_publish

    def _clean_problem(db, sku, ap):
        msg = _orig_problem(db, sku, ap)
        if not msg:
            return None
        return (
            msg.replace("批准之后成本变了，要重新审批", "采购成本已更新，请核对新售价后直接上架")
            .replace("要重新审批", "请核对后直接上架")
            .replace("还没提交上架审批", "待选图确认价格后直接上架")
            .replace("上架审批还没批", "待确认价格后直接上架")
            .replace("审批", "确认")
        )

    _la_svc.problem_for_publish = _clean_problem
    if hasattr(_la_router, "la"):
        _la_router.la.problem_for_publish = _clean_problem
except Exception:  # noqa: BLE001
    pass

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


@asynccontextmanager
async def _no_lifespan(_app):
    yield


app.router.lifespan_context = _no_lifespan


def _get_db():
    db = SessionDemo()
    try:
        yield db
    finally:
        db.close()


app.dependency_overrides[get_db] = _get_db
app.mount("/api/demo-img", StaticFiles(directory=os.path.join(HERE, "demo-img")), name="demo-img")

if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("STITCH_DEMO_PORT", "5342"))
    print(f"销售工作台 Stitch 演示后端：http://127.0.0.1:{port}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")

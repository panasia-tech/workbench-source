"""销售工作台「虚拟」：卡券、数字权益的产品卡、补码、订单发码。逻辑见 services/virtual_goods.py。"""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import require_roles
from app.enums import StaffRole
from app.models import Staff
from app.services import virtual_goods as vg

router = APIRouter(prefix="/api/virtual", tags=["虚拟商品"])
_staff = require_roles(StaffRole.SALES, StaffRole.ADMIN)


@router.get("/products", summary="虚拟选品：所有产品卡（红黄绿）+ 分类树")
def products(q: str | None = None, state: str | None = None, mine: bool = False,
             db: Session = Depends(get_db), user: Staff = Depends(_staff)):
    return vg.gallery(db, user, q=q, state=state, mine=mine)


@router.post("/products", summary="新建一张产品卡（从第 1 步开始）")
def create(body: dict, db: Session = Depends(get_db), user: Staff = Depends(_staff)):
    return vg.create(db, user, body)


@router.get("/products/{pid}", summary="一张产品卡：8 步、证据、算账、库存、订单")
def detail(pid: str, db: Session = Depends(get_db), user: Staff = Depends(_staff)):
    return vg.detail(db, user, pid)


# 小程序 wx.request 不支持 PATCH，改设置走 POST
@router.post("/products/{pid}/settings", summary="改设置：基本信息、闲鱼链接、提醒线、发货检查、自动发货；合规只有主管能改")
def update(pid: str, body: dict, db: Session = Depends(get_db), user: Staff = Depends(_staff)):
    return vg.update(db, user, pid, body)


@router.post("/products/{pid}/advance", summary="交这一步的证据、走到下一步（缺的写待核，不能空、不能填 0）")
def advance(pid: str, body: dict, db: Session = Depends(get_db), user: Staff = Depends(_staff)):
    return vg.advance(db, user, pid, body)


@router.post("/products/{pid}/review", summary="主管批 / 退回上架申请（ok=true 批；退回要写 note）")
def review(pid: str, body: dict, db: Session = Depends(get_db), user: Staff = Depends(_staff)):
    return vg.review(db, user, pid, body)


@router.post("/products/{pid}/restock", summary="补码：一行一张，重复的自动跳过")
def restock(pid: str, body: dict, db: Session = Depends(get_db), user: Staff = Depends(_staff)):
    return vg.restock(db, user, pid, body)


@router.post("/sync", summary="马上从聊天里认一遍付款（平时每分钟自动跑）")
async def sync(db: Session = Depends(get_db), _: Staff = Depends(_staff)):
    return await vg.sync(db)


@router.post("/orders/{oid}/send", summary="发码：拿一张码、拼话术，经群控发进会话")
async def send(oid: str, db: Session = Depends(get_db), user: Staff = Depends(_staff)):
    return await vg.send(db, user, oid)


@router.post("/orders/{oid}/release", summary="放行被检查拦住的单")
def release(oid: str, db: Session = Depends(get_db), user: Staff = Depends(_staff)):
    return vg.release(db, user, oid)


@router.post("/orders/{oid}/delivered", summary="代充 / 人工交付做完了：写一句怎么交付的")
def delivered(oid: str, body: dict, db: Session = Depends(get_db), user: Staff = Depends(_staff)):
    return vg.mark_delivered(db, user, oid, body)


@router.post("/orders/{oid}/reveal", summary="看这单的码（记一笔：谁、什么时候、哪一单）")
def reveal(oid: str, db: Session = Depends(get_db), user: Staff = Depends(_staff)):
    return vg.reveal(db, user, oid)


@router.post("/orders/{oid}/void", summary="买家说码用不了：作废这张，再发会换一张")
def void(oid: str, body: dict, db: Session = Depends(get_db), user: Staff = Depends(_staff)):
    return vg.void_code(db, user, oid, body)


@router.get("/buyers", summary="退款名单")
def buyers(db: Session = Depends(get_db), _: Staff = Depends(_staff)):
    return {"items": vg.buyer_flags(db)}


@router.post("/buyers", summary="把买家拉进 / 移出退款名单")
def flag_buyer(body: dict, db: Session = Depends(get_db), user: Staff = Depends(_staff)):
    return vg.flag_buyer(db, user, body)


@router.post("/settings/auto-delivery", summary="自动发货总开关（主管）")
def auto_delivery(on: bool = Query(...), db: Session = Depends(get_db), user: Staff = Depends(_staff)):
    return vg.set_auto(db, user, on)

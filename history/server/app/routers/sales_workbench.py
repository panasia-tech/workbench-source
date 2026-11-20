"""销售工作台首页（手机端）：今日成交、在架、买家在等、待办。逻辑见 services/sales_workbench.py。"""

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user, require_roles
from app.enums import StaffRole
from app.models import Staff
from app.services import sales_workbench as sw

router = APIRouter(prefix="/api/sales-workbench", tags=["销售工作台"])


@router.get("/overview", summary="销售工作台首页：数字卡片 + 我的号 + 待办（单项拿不到给 null）")
async def overview(db: Session = Depends(get_db), user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN))):
    # 先异步拉群控（带超时），查库的几项放线程池里跑，别堵住事件循环
    gc_data = await sw.fetch_gc()
    out = await run_in_threadpool(sw.build_overview, db, user, gc_data)
    sw.remember_badges(user.id, out["badges"])
    return out


@router.get("/badges", summary="菜单红点：今天 / 库存商品 / 订单 / 接管台红的有几条，练习还差几步（每人缓存 60 秒）")
async def badges(db: Session = Depends(get_db), user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN))):
    hit = sw.cached_badges(user.id)
    if hit is not None:
        return hit
    return (await overview(db, user))["badges"]


@router.get("/goods", summary="库存商品：每件在库的货一张卡，红黄绿只表示要不要现在动手")
def goods(
    level: str | None = Query(None, description="red / yellow / green，空 = 全部"),
    q: str | None = None,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN)),
):
    from app.services import sales_goods

    return sales_goods.build(db, user, level=level, q=q)


@router.get("/goods/{sku_code}", summary="一件货：问题箱、成本 / 最低价 / 建议价 / 行情价、五步走到哪了")
def goods_item(
    sku_code: str,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN)),
):
    from app.services import sales_goods

    out = sales_goods.item(db, user, sku_code)
    if out is None:
        raise HTTPException(status_code=404, detail="货号不存在")
    return out


class BuyerCancelIn(BaseModel):
    reason: str = Field(..., min_length=2, max_length=200)


@router.post("/goods/{sku_code}/buyer-cancelled", summary="闲鱼卖出还没发、买家取消了：货放回在库（原来只有发货出库、退货回仓能解锁）")
async def buyer_cancelled(
    sku_code: str,
    body: BuyerCancelIn,
    db: Session = Depends(get_db),
    user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN)),
):
    from app.models import Sku
    from app.services.gc_bridge import client as gc
    from app.services.gc_bridge import sold_sync

    sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
    if sku is None:
        raise HTTPException(status_code=404, detail="货号不存在")
    try:
        sold = await gc.list_listings(sku=sku.sku_code, status="SOLD")
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail="群控连不上，稍后再点（不然下一轮售出同步又会把货锁回去）") from exc
    try:
        sold_sync.release_platform_sold(db, sku, [x["id"] for x in sold if x.get("id")], user.id, body.reason.strip())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    db.commit()
    sw.forget_badges(user.id)
    return {"ok": True, "sku_code": sku.sku_code, "status": sku.status}


@router.get("/orders", summary="订单：闲鱼卖出的货，漏抓 / 对不上货 / 卡住没走 / 状态不同步四类问题")
async def orders(db: Session = Depends(get_db), user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN))):
    from app.services import sales_orders

    # 销售只看分给自己的号卖的，和首页「我的号」同一个口径
    gc_data = await sw.fetch_gc()

    def run():
        accounts = sw._safe("我的号", db, sw.my_accounts, user, gc_data)
        scope, shops = accounts if accounts else ("all", None)
        shop_ids = {s["shop_id"] for s in shops if s["shop_id"]} if shops is not None and scope == "mine" else None
        return {**sales_orders.build(db, shop_ids), "scope": scope}

    return await run_in_threadpool(run)


@router.get("/assist", summary="实物接管台：在等回复的会话（超时的红、已升级）+ 今天各负责人的回复率")
async def assist(db: Session = Depends(get_db), user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN))):
    import asyncio
    from datetime import datetime, timedelta

    from app.services.gc_bridge import client as gc

    today = (datetime.utcnow() + timedelta(hours=8)).strftime("%Y-%m-%d")

    async def stats():
        try:
            return await asyncio.wait_for(gc.chat_sla_stats(today, today), timeout=sw.GC_TIMEOUT_SEC)
        except Exception:  # noqa: BLE001
            return None

    gc_data, st = await asyncio.gather(sw.fetch_gc(), stats())

    def run():
        accounts = sw._safe("我的号", db, sw.my_accounts, user, gc_data)
        scope, shops = accounts if accounts else ("all", None)
        return {
            "scope": scope,
            "reply_min": int((gc_data.get("waiting_conf") or {}).get("reply_min") or 15),
            "rows": sw.assist_rows(user, gc_data, shops, scope),
            "stats": sw.assist_stats(st),
        }

    return await run_in_threadpool(run)


# ---------- 主管加派 / 协同请求（规矩见 services/sales_team.py）----------

@router.get("/team", summary="主管：能派给谁 + 派出去的任务（没完的 + 最近 7 天完的）")
def team(db: Session = Depends(get_db), user: Staff = Depends(require_roles(StaffRole.ADMIN))):
    from app.services import sales_team as st

    return {"staff": st.team(db), "tasks": st.team_tasks(db, user)}


@router.post("/tasks", summary="主管加派：要求、范围、交付时间、派给谁都必填")
def create_task(body: dict, db: Session = Depends(get_db), user: Staff = Depends(require_roles(StaffRole.ADMIN))):
    from app.services import sales_team as st

    return st.create_task(db, user, body)


@router.get("/tasks/{task_id}", summary="一条加派任务：要求、状态、转交上下文、记录、我现在能点什么")
def get_task(task_id: str, db: Session = Depends(get_db),
             user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN))):
    from app.services import sales_team as st

    out = st.task_out(db, st.get_task(db, user, task_id), user)
    if "reassign" in out["can"]:
        out["staff"] = st.team(db)
    return out


@router.post("/tasks/{task_id}/{action}", summary="接收 / 等待外部 / 恢复 / 受阻 / 交验收；主管：验收 / 退回 / 接管 / 改派 / 撤销")
def act_task(task_id: str, action: str, body: dict, db: Session = Depends(get_db),
             user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN))):
    from app.services import sales_team as st

    return st.act(db, user, task_id, action, body)


@router.get("/collab", summary="协同请求：等我接的、我接了没做完的、我提的（顶栏每 10 秒轮询）")
def collab_live(db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    from app.services import sales_team as st

    return st.live(db, user)


@router.post("/collab", summary="提协同请求：一句话要帮什么，带会话 / 货号；谁都能提")
def collab_create(body: dict, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    from app.services import sales_team as st

    return st.create_collab(db, user, body)


@router.post("/collab/replied/{conversation_id}", summary="聊天页发出去了：这个会话上开着的协同请求自动关")
def collab_replied(conversation_id: str, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    from app.services import sales_team as st

    return {"closed": st.close_for_conversation(db, user, conversation_id)}


@router.post("/collab/{collab_id}/take", summary="我来接（先到先得，别人已接回 409）")
def collab_take(collab_id: str, db: Session = Depends(get_db),
                user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN))):
    from app.services import sales_team as st

    return st.take_collab(db, user, collab_id)


@router.post("/collab/{collab_id}/{action}", summary="接的人点做完了（done）；提的人撤回没人接的（cancel）")
def collab_close(collab_id: str, action: str, db: Session = Depends(get_db), user: Staff = Depends(get_current_user)):
    from app.services import sales_team as st

    return st.close_collab(db, user, collab_id, action)


# ---------- 遇到没见过的情况 ----------

@router.get("/reports", summary="没见过的情况：等主管回的（主管）、我报的、记成规则的")
def list_reports(db: Session = Depends(get_db), user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN))):
    from app.services import sales_team as st

    return st.reports(db, user)


@router.post("/reports", summary="报一条没见过的情况：一句话说清发生了什么")
def create_report(body: dict, db: Session = Depends(get_db),
                  user: Staff = Depends(require_roles(StaffRole.SALES, StaffRole.ADMIN))):
    from app.services import sales_team as st

    return st.create_report(db, user, body)


@router.post("/reports/{report_id}/answer", summary="主管回复处理办法，可记成规则（is_rule）")
def answer_report(report_id: str, body: dict, db: Session = Depends(get_db),
                  user: Staff = Depends(require_roles(StaffRole.ADMIN))):
    from app.services import sales_team as st

    return st.answer_report(db, user, report_id, body)

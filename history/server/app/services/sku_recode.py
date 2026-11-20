"""货号/条形码改码的共享 domain 逻辑。

旧 RFID 改码接口（/skus/recode）与新货号更换接口（/sku-migration/*）共用同一套实现，
确保改码时**所有**冗余存了 sku_code 的表一并同步，避免孤儿引用。
"""
from sqlalchemy import update
from sqlalchemy.orm import Session

from app.enums import SkuStatus, StockEventType
from app.models import (
    AiRedrawJob,
    PickupPayment,
    ReturnOrder,
    Sku,
    Staff,
    StockEvent,
    StocktakeAdjustment,
)

# 货号更换业务前缀：新货号必须以此开头才算"已更换"。
# 2026-07-06 老板拍板:51321154 开头的都是新货号——548x/549x/540x 是同一批
# 新标签卷的不同号段,都算已更换,前缀就是 8 位(勿再改成 513211540,那次误改
# 把 43 台贴新标签的货判回了待更换)。
SKU_MIGRATION_PREFIX = "51321154"
# 小程序仓库货号更换来源标记（StockEvent.payload.source）
SKU_MIGRATION_SOURCE = "MINIPROGRAM_WAREHOUSE_MIGRATION"
# 允许改码的在库范围
SCOPED_STATUSES = (SkuStatus.IN_STOCK, SkuStatus.RESERVED)


def migration_status(sku_code: str) -> str:
    """按前缀推导货号是否已迁移（不落库新字段）。"""
    return "DONE" if (sku_code or "").upper().startswith(SKU_MIGRATION_PREFIX) else "PENDING"


def recode_source_label(payload: dict | None) -> str | None:
    """把 RECODE 事件的 payload 翻译成人类可读的来源说明。"""
    if not payload:
        return None
    if payload.get("source") == SKU_MIGRATION_SOURCE:
        return "小程序货号更换"
    if payload.get("source") == "MINIPROGRAM_WAREHOUSE_EDIT":
        return "小程序编辑商品"
    if payload.get("source"):
        return str(payload["source"])
    if payload.get("device"):
        return f"设备 {payload['device']}"
    return None


def load_last_recode_event_map(db: Session, sku_ids: list[str]) -> dict[str, StockEvent]:
    """批量取每个 sku 最近一条 RECODE 事件，键为 sku_id。"""
    if not sku_ids:
        return {}
    rows = (
        db.query(StockEvent)
        .filter(
            StockEvent.sku_id.in_(sku_ids),
            StockEvent.event_type == StockEventType.RECODE,
        )
        .order_by(StockEvent.created_at.desc())
        .all()
    )
    latest: dict[str, StockEvent] = {}
    for row in rows:
        if row.sku_id and row.sku_id not in latest:
            latest[row.sku_id] = row
    return latest


def recode_sku(
    db: Session,
    user: Staff,
    *,
    old_sku_code: str,
    new_sku_code: str,
    source: str | None = None,
    commit: bool = True,
) -> tuple[Sku, StockEvent | None]:
    """把商品的旧货号整体改成新货号，并在同一事务里同步所有冗余 sku_code 的表。

    返回 (sku, event)；当新旧相同时返回 (sku, None) 表示无需改动。
    会 raise fastapi.HTTPException（400/404/409），调用方无需重复校验通用错误。
    commit=False 时不提交事务（调用方还要改别的字段、最后统一提交，如编辑页）。
    """
    # 延迟导入避免 service ↔ router 循环依赖
    from fastapi import HTTPException

    old = (old_sku_code or "").strip().upper()
    new = (new_sku_code or "").strip().upper()
    if not old or not new:
        raise HTTPException(status_code=400, detail="旧/新条码不能为空")

    sku = db.query(Sku).filter(Sku.sku_code == old).first()
    if not sku:
        raise HTTPException(status_code=404, detail="未查到该条码对应的商品")

    if old == new:
        return sku, None

    conflict = db.query(Sku).filter(Sku.sku_code == new, Sku.id != sku.id).first()
    if conflict:
        raise HTTPException(status_code=409, detail="新条码已被其它商品占用")

    # 重命名 + 传播到所有冗余表（含 PickupPayment——历史 RFID 改码曾漏同步）
    sku.sku_code = new
    db.execute(update(ReturnOrder).where(ReturnOrder.sku_id == sku.id).values(sku_code=new))
    db.execute(update(AiRedrawJob).where(AiRedrawJob.sku_code == old).values(sku_code=new))
    db.execute(update(StocktakeAdjustment).where(StocktakeAdjustment.sku_code == old).values(sku_code=new))
    db.execute(update(PickupPayment).where(PickupPayment.sku_id == sku.id).values(sku_code=new))
    event = StockEvent(
        purchase_order_id=sku.purchase_order_id,
        sku_id=sku.id,
        event_type=StockEventType.RECODE,
        operator_id=user.id,
        payload={
            "old": old,
            "new": new,
            "source": source,
            "operator": user.name,
            "device": user.name,
        },
    )
    db.add(event)
    if commit:
        db.commit()
        db.refresh(sku)
        db.refresh(event)
    return sku, event

"""阿里云市场 69码（商品条码）查询客户端（快鸟 icode，cmapi00067757）。

接口文档：https://market.aliyun.com/apimarket/detail/cmapi00067757
GET {base}/getBarcode?Code=xxx，Header: Authorization: APPCODE <appcode>。
返回原始 JSON（含 ItemName/BrandName/ItemSpecification/FirmName/Image 等），
调用方负责持久化（本项目存 sku.spu）。
"""

from __future__ import annotations

import logging

import httpx
from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.config import settings
from app.enums import StockEventType
from app.models import Sku, Staff, StockEvent

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 15


class BarcodeQueryError(Exception):
    pass


def query_barcode(code: str) -> dict:
    """按 69码 查询商品信息，返回接口原始 JSON。失败抛 HTTPException。"""
    code = (code or "").strip()
    if not code:
        raise HTTPException(status_code=400, detail="条码不能为空")
    appcode = settings.barcode_query_appcode.strip()
    if not appcode:
        raise HTTPException(status_code=503, detail="BARCODE_QUERY_APPCODE 未配置")

    url = f"{settings.barcode_query_base_url.rstrip('/')}/getBarcode"
    try:
        resp = httpx.get(
            url,
            params={"Code": code},
            headers={"Authorization": f"APPCODE {appcode}"},
            timeout=REQUEST_TIMEOUT,
        )
    except httpx.HTTPError as exc:
        logger.exception("69码查询请求失败: %s", exc)
        raise HTTPException(status_code=502, detail="条码查询服务请求失败") from exc

    if resp.status_code != 200:
        logger.warning("69码查询 HTTP %s: %s", resp.status_code, resp.text[:300])
        raise HTTPException(status_code=502, detail=f"条码查询服务 HTTP {resp.status_code}")

    try:
        body = resp.json()
    except ValueError as exc:
        raise HTTPException(status_code=502, detail="条码查询服务返回异常") from exc

    if str(body.get("status") or "") != "200":
        message = body.get("message") or "条码未查到"
        logger.info("69码查询无结果 code=%s: %s", code, message)
        raise HTTPException(status_code=404, detail=f"条码查询：{message}")
    return body


def enrich_sku_spu(sku, *, force: bool = False) -> bool:
    """按 sku.barcode 自动查询 69码 并写入 sku.spu。

    - barcode 为空，或非 force 且 spu 已有值 → 跳过（查过一次就不再重复查）。
    - 查询失败（未查到/服务异常）只记日志、不阻断入库/编辑主流程，spu 保持原值。
    """
    code = (getattr(sku, "barcode", None) or "").strip()
    if not code:
        return False
    if not force and getattr(sku, "spu", None):
        return False
    try:
        sku.spu = query_barcode(code)
    except HTTPException as exc:
        logger.info("69码自动查询跳过 sku=%s code=%s: %s", getattr(sku, "sku_code", "?"), code, exc.detail)
        return False
    return True


# ==================== 69码更换（小程序仓库页：空/错 69码 → 新 69码）====================
# 与货号更换（app/services/sku_recode.py）同构：列表按 barcode 是否为空分流，
# 单件更换走 apply_sku_barcode 统一入口——写码 + 重查 SPU + 留 BARCODE_SET 痕。

# 小程序仓库 69码更换来源标记（StockEvent.payload.source）
BARCODE_MIGRATION_SOURCE = "MINIPROGRAM_WAREHOUSE_BARCODE"
# 允许的条码长度：EAN-8 / UPC-A(12) / EAN-13(69码) / ITF-14
BARCODE_VALID_LENGTHS = (8, 12, 13, 14)


def normalize_barcode(raw: str | None) -> str | None:
    """清洗并校验 69码：空串归一成 None，非法格式抛 400。"""
    code = (raw or "").strip()
    if not code:
        return None
    if not code.isdigit():
        raise HTTPException(status_code=400, detail="69码只能是数字")
    if len(code) not in BARCODE_VALID_LENGTHS:
        raise HTTPException(status_code=400, detail="69码位数不对（应为 8/12/13/14 位）")
    return code


def barcode_status(barcode: str | None) -> str:
    """有码=DONE(已更换)，无码=PENDING(待更换)。"""
    return "DONE" if (barcode or "").strip() else "PENDING"


def spu_text(spu: dict | None) -> str | None:
    """把条码库返回的 SPU JSON 压成一行「名称 品牌 规格」，列表页直接展示。"""
    if not isinstance(spu, dict):
        return None
    parts = [
        str(spu.get(key) or "").strip()
        for key in ("ItemName", "BrandName", "ItemSpecification")
    ]
    return " ".join(p for p in parts if p) or None


def barcode_source_label(payload: dict | None) -> str | None:
    """把 BARCODE_SET 事件的 payload 翻译成人类可读的来源说明。"""
    if not payload:
        return None
    source = payload.get("source")
    if source == BARCODE_MIGRATION_SOURCE:
        return "小程序69码更换"
    if source == "MINIPROGRAM_WAREHOUSE_EDIT":
        return "小程序编辑商品"
    if source == "BARCODE_LOOKUP":
        return "详情页条码查询"
    return str(source) if source else None


def load_last_barcode_event_map(db: Session, sku_ids: list[str]) -> dict[str, StockEvent]:
    """批量取每个 sku 最近一条 BARCODE_SET 事件，键为 sku_id。"""
    if not sku_ids:
        return {}
    rows = (
        db.query(StockEvent)
        .filter(
            StockEvent.sku_id.in_(sku_ids),
            StockEvent.event_type == StockEventType.BARCODE_SET,
        )
        .order_by(StockEvent.created_at.desc())
        .all()
    )
    latest: dict[str, StockEvent] = {}
    for row in rows:
        if row.sku_id and row.sku_id not in latest:
            latest[row.sku_id] = row
    return latest


def apply_sku_barcode(
    db: Session,
    user: Staff,
    sku: Sku,
    *,
    barcode: str | None,
    source: str | None = None,
    commit: bool = True,
    spu: dict | None = None,
) -> StockEvent | None:
    """写入/更换 sku.barcode：清空并按新码重查 SPU，留 BARCODE_SET 痕。

    69码同款同码、天然不唯一，因此不做占用冲突校验（与货号更换不同）。
    与旧码相同则原样返回 None（不留痕、不重查）。
    spu 传了就直接用（调用方刚查过，避免重复打付费接口），否则内部自动查一次。
    """
    new_code = normalize_barcode(barcode)
    old_code = (sku.barcode or "").strip() or None
    if new_code == old_code:
        return None

    sku.barcode = new_code
    sku.spu = None
    if new_code:
        if spu is not None:
            sku.spu = spu
        else:
            # 换码后重查条码库；查不到只记日志，spu 留空，详情页可手动重试
            enrich_sku_spu(sku, force=True)
    event = StockEvent(
        purchase_order_id=sku.purchase_order_id,
        sku_id=sku.id,
        event_type=StockEventType.BARCODE_SET,
        ref_no=sku.sku_code,
        operator_id=user.id,
        payload={
            "old": old_code,
            "new": new_code,
            "source": source,
            "operator": user.name,
            "spu_found": bool(sku.spu),
        },
    )
    db.add(event)
    if commit:
        db.commit()
        db.refresh(sku)
        db.refresh(event)
    return event

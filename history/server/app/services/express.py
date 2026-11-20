from datetime import datetime
import logging
import re

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models import ExpressTrackingCache

logger = logging.getLogger(__name__)


class ExpressNotConfiguredError(Exception):
    pass


def normalize_phone_suffix(value: str | None) -> str:
    """收/寄件人手机号后四位，仅保留数字，最多 4 位。"""
    digits = re.sub(r"\D", "", (value or ""))
    return digits[:4] if digits else ""


def _extract_trace_items(raw: dict) -> list:
    result_obj = raw.get("result")
    if isinstance(result_obj, dict):
        items = result_obj.get("list") or result_obj.get("data") or []
    else:
        items = raw.get("data") or raw.get("list") or []
    return items if isinstance(items, list) else []


def normalize_express_response(raw: dict, tracking_no: str) -> dict:
    traces: list[dict[str, str]] = []
    for item in _extract_trace_items(raw):
        if not isinstance(item, dict):
            continue
        context = (
            item.get("context")
            or item.get("Context")
            or item.get("status")
            or item.get("Status")
            or item.get("desc")
            or ""
        ).strip()
        time_val = (item.get("time") or item.get("ftime") or item.get("Time") or "").strip()
        if context or time_val:
            traces.append({"time": time_val, "context": context})
    status = str(raw.get("status", ""))
    ok = status in ("200", "0", "1") or bool(traces)
    return {
        "tracking_no": tracking_no,
        "status": status,
        "msg": (raw.get("msg") or raw.get("message") or "").strip(),
        "traces": traces,
        "ok": ok,
    }


async def _fetch_express_remote(
    tracking_no: str,
    express_type: str = "",
    *,
    phone_suffix: str = "",
) -> dict:
    if not settings.kuaidi_user:
        raise ExpressNotConfiguredError("快递查询未配置，请设置 KUAIDI_USER")
    url = "http://api.officesee.com/kuaidi/kuaidi.ashx"
    # 顺丰需把收/寄件人手机尾号 4 位拼进单号:`单号:尾号`（接口文档格式，单独 phone 参数无效）
    no = f"{tracking_no}:{phone_suffix}" if phone_suffix else tracking_no
    params = {"user": settings.kuaidi_user, "type": express_type, "no": no}
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        raw = resp.json()
    return normalize_express_response(raw, tracking_no)


# 逾期采购判定：仓库在浙江，快件已到浙江省内 / 进入派送或签收阶段即视为提交太晚。
# 派送/派件/签收任一命中即逾期（已送达浙江仓所在地）。
OVERDUE_DELIVERY_KEYWORDS = ("派送", "派件", "签收")
# "浙江"命中即逾期，但若该条同时是"揽收"（多为浙江本地卖家刚发货的揽收记录，非到仓），不罚。
OVERDUE_PROVINCE_KEYWORD = "浙江"
PROVINCE_EXEMPT_KEYWORD = "揽收"


def _fetch_express_remote_sync(
    tracking_no: str,
    express_type: str = "",
    *,
    phone_suffix: str = "",
) -> dict:
    """同步抓取物流（供新建采购单提交时即时判定逾期，避免在同步事务里跑 async）。"""
    if not settings.kuaidi_user:
        raise ExpressNotConfiguredError("快递查询未配置，请设置 KUAIDI_USER")
    url = "http://api.officesee.com/kuaidi/kuaidi.ashx"
    no = f"{tracking_no}:{phone_suffix}" if phone_suffix else tracking_no
    params = {"user": settings.kuaidi_user, "type": express_type, "no": no}
    with httpx.Client(timeout=15) as client:
        resp = client.get(url, params=params)
        resp.raise_for_status()
        raw = resp.json()
    return normalize_express_response(raw, tracking_no)


def detect_overdue_by_express(tracking_no: str | None, *, phone_suffix: str = "") -> bool:
    """提交采购单时调用：任一物流轨迹进入派送/签收阶段，或出现"浙江"(且非揽收) → 逾期。
    查询失败/无轨迹/未配置一律按非逾期放行（不冤枉采购员）。"""
    no = (tracking_no or "").strip()
    suffix = normalize_phone_suffix(phone_suffix)
    if not no:
        logger.info("[逾期判定] 无运单号，放行（非逾期）")
        return False
    try:
        payload = _fetch_express_remote_sync(no, phone_suffix=suffix)
    except Exception as exc:
        logger.warning("[逾期判定] 查物流失败 no=%s suffix=%s err=%r → 放行（非逾期）", no, suffix, exc)
        return False
    traces = payload.get("traces") or []
    logger.info(
        "[逾期判定] no=%s suffix=%s status=%s msg=%s 轨迹数=%d",
        no, suffix, payload.get("status"), payload.get("msg"), len(traces),
    )
    for idx, trace in enumerate(traces):
        ctx = (trace.get("context") or "")
        logger.info("[逾期判定] 轨迹[%d] time=%s ctx=%s", idx, trace.get("time"), ctx)
        # 派送/派件/签收：已送达浙江仓所在地，直接判逾期
        hit_delivery = next((kw for kw in OVERDUE_DELIVERY_KEYWORDS if kw in ctx), None)
        if hit_delivery:
            logger.info("[逾期判定] 命中派送关键词「%s」→ 判定逾期 no=%s", hit_delivery, no)
            return True
        # 到浙江即逾期，但"揽收"那条（浙江本地卖家刚发货）不罚
        if OVERDUE_PROVINCE_KEYWORD in ctx and PROVINCE_EXEMPT_KEYWORD not in ctx:
            logger.info("[逾期判定] 命中「浙江」且非揽收 → 判定逾期 no=%s", no)
            return True
        if OVERDUE_PROVINCE_KEYWORD in ctx and PROVINCE_EXEMPT_KEYWORD in ctx:
            logger.info("[逾期判定] 含「浙江」但为揽收记录 → 豁免不罚（继续看其它轨迹）no=%s", no)
    logger.info("[逾期判定] 全部轨迹未命中逾期条件 → 放行（非逾期）no=%s", no)
    return False


def _cache_to_payload(row: ExpressTrackingCache, *, cached: bool) -> dict:
    return {
        "tracking_no": row.tracking_no,
        "status": row.status or "",
        "msg": row.msg or "",
        "traces": row.traces or [],
        "ok": bool(row.traces) or (row.status or "") in ("200", "0", "1"),
        "cached": cached,
        "queried_at": row.queried_at,
    }


def get_cached_tracking(
    db: Session,
    tracking_no: str,
    *,
    phone_suffix: str = "",
) -> dict | None:
    no = (tracking_no or "").strip()
    if not no:
        return None
    suffix = normalize_phone_suffix(phone_suffix)
    row = (
        db.query(ExpressTrackingCache)
        .filter(
            ExpressTrackingCache.tracking_no == no,
            ExpressTrackingCache.phone_suffix == suffix,
        )
        .first()
    )
    if not row:
        return None
    return _cache_to_payload(row, cached=True)


def map_cached_tracking(db: Session, items: list) -> dict[str, dict]:
    """items: (tracking_no, phone_suffix) 二元组列表（或纯单号列表，尾号默认空）。
    按"单号+手机尾号"精确命中缓存——顺丰单的缓存挂在其尾号下，必须带尾号才查得到。"""
    pairs: set[tuple[str, str]] = set()
    for it in items:
        if isinstance(it, (tuple, list)):
            no, phone = (it[0], it[1] if len(it) > 1 else "")
        else:
            no, phone = it, ""
        no = (no or "").strip()
        if no:
            pairs.add((no, normalize_phone_suffix(phone)))
    if not pairs:
        return {}
    nos = list({no for no, _ in pairs})
    rows = (
        db.query(ExpressTrackingCache)
        .filter(ExpressTrackingCache.tracking_no.in_(nos))
        .all()
    )
    return {
        row.tracking_no: _cache_to_payload(row, cached=True)
        for row in rows
        if (row.tracking_no, row.phone_suffix or "") in pairs
    }


def express_summary(cached: dict | None) -> str | None:
    if not cached:
        return None
    traces = cached.get("traces") or []
    if traces:
        ctx = (traces[0].get("context") or "").strip()
        if ctx:
            return ctx
    msg = (cached.get("msg") or "").strip()
    return msg or None


def _save_tracking_cache(db: Session, payload: dict, *, phone_suffix: str = "") -> ExpressTrackingCache:
    no = payload["tracking_no"]
    suffix = normalize_phone_suffix(phone_suffix)
    row = (
        db.query(ExpressTrackingCache)
        .filter(
            ExpressTrackingCache.tracking_no == no,
            ExpressTrackingCache.phone_suffix == suffix,
        )
        .first()
    )
    now = datetime.now()
    if row:
        row.status = payload.get("status") or ""
        row.msg = payload.get("msg") or ""
        row.traces = payload.get("traces") or []
        row.queried_at = now
    else:
        row = ExpressTrackingCache(
            tracking_no=no,
            phone_suffix=suffix,
            status=payload.get("status") or "",
            msg=payload.get("msg") or "",
            traces=payload.get("traces") or [],
            queried_at=now,
        )
        db.add(row)
    db.commit()
    db.refresh(row)
    return row


async def get_tracking(
    db: Session,
    tracking_no: str,
    *,
    refresh: bool = False,
    phone_suffix: str = "",
) -> dict:
    no = (tracking_no or "").strip()
    if not no:
        raise ValueError("运单号不能为空")
    suffix = normalize_phone_suffix(phone_suffix)

    if not refresh:
        cached = get_cached_tracking(db, no, phone_suffix=suffix)
        if cached:
            return cached

    payload = await _fetch_express_remote(no, phone_suffix=suffix)
    row = _save_tracking_cache(db, payload, phone_suffix=suffix)
    return _cache_to_payload(row, cached=False)

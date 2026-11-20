"""货况警示后台扫描 worker（实拍图 OCR 命中「全新/几乎全新」回填采购单/SKU）。

为什么要独立线程池而不是 FastAPI BackgroundTasks：
- BackgroundTasks 跑在 Starlette 的**共享线程池**里，与所有同步路由抢同一批线程槽（默认 40）。
  单次扫描要顺序下载 + OCR 最多 9 张图（单图最长 60s），采购高峰并发提交时会把线程池占满、
  把正常接口饿死 → 服务假死/宕机。
- 这里用**专用有界线程池**（与共享池隔离）+ **积压上限丢弃**，保证：
  1) 最多 MAX_WORKERS 个扫描并发，线程/HTTP/DB 连接都不会暴涨；
  2) 洪峰时新任务排队，超过 MAX_BACKLOG 直接丢弃（货况警示是辅助提示，可事后用
     scripts/backfill_condition_ocr.py 补扫），绝不无限堆内存；
  3) OCR 全程不持有 DB 连接，只在写结果时开短会话。

约束对齐 redraw_worker：受控线程池、短会话、失败不外抛。
"""

from __future__ import annotations

import asyncio
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Optional

from app.database import SessionLocal
from app.models import PurchaseOrder
from app.services.ocr import scan_images_condition

logger = logging.getLogger(__name__)

# 单次扫描以网络 I/O 为主、CPU 极轻；2 个并发足够日常采购量，且不挤占数据库连接池。
MAX_WORKERS = 2
# 积压保护：待处理 + 在跑 超过此值时丢弃新扫描（事后可脚本补扫），防止洪峰下队列无限增长。
MAX_BACKLOG = 200

_executor: Optional[ThreadPoolExecutor] = None
_lock = threading.Lock()
_pending = 0  # 已提交但未完成的任务数（受 _lock 保护）


def _get_executor() -> ThreadPoolExecutor:
    global _executor
    if _executor is None:
        _executor = ThreadPoolExecutor(
            max_workers=MAX_WORKERS,
            thread_name_prefix="cond-scan",
        )
    return _executor


def shutdown_executor() -> None:
    global _executor
    if _executor is not None:
        _executor.shutdown(wait=False, cancel_futures=True)
        _executor = None


def _run(order_id: str, image_urls: list[str]) -> None:
    """worker 入口：先做 OCR（不持有 DB），再开短会话写结果。任何异常只记日志。"""
    global _pending
    try:
        try:
            hit = asyncio.run(scan_images_condition(image_urls))
        except Exception:  # noqa: BLE001 - 货况警示为辅助提示，任何异常都不外抛
            logger.exception("[condition-scan] OCR 扫描失败 order_id=%s", order_id)
            return
        try:
            with SessionLocal() as db:
                order = db.get(PurchaseOrder, order_id)
                if not order:
                    return
                order.condition_warning = bool(hit)
                order.condition_warning_text = hit
                order.condition_scanned_at = datetime.utcnow()
                # 编辑实拍图触发的重扫：若已验货生成 SKU，同步冗余字段
                for sku in order.skus:
                    sku.condition_warning = bool(hit)
                    sku.condition_warning_text = hit
                db.commit()
        except Exception:  # noqa: BLE001
            logger.exception("[condition-scan] 回填失败 order_id=%s", order_id)
    finally:
        with _lock:
            _pending -= 1


def enqueue(order_id: str, image_urls: list[str]) -> bool:
    """对外入口：投递一次扫描。返回是否入队（积压超限则丢弃并返回 False）。

    线程池满时任务在内部队列排队，受 MAX_BACKLOG 上限保护。
    """
    global _pending
    images = [u for u in (image_urls or []) if u]
    if not images:
        return False
    with _lock:
        if _pending >= MAX_BACKLOG:
            logger.warning(
                "[condition-scan] 积压达上限 %d，丢弃 order_id=%s（可事后 backfill 补扫）",
                MAX_BACKLOG,
                order_id,
            )
            return False
        _pending += 1
    try:
        _get_executor().submit(_run, order_id, images)
        return True
    except Exception:  # noqa: BLE001 - 提交失败（如关停中）要回滚计数
        with _lock:
            _pending -= 1
        logger.exception("[condition-scan] 提交线程池失败 order_id=%s", order_id)
        return False

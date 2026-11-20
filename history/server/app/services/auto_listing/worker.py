"""自动上架 worker：把到点的流水线行往前推一步。

一行一个 SKU，每轮只推一步（advance），推完就落库、算好下次时间；
推不动的行自己退避，推到终态（DONE/NEEDS_HUMAN/FAILED）就不再被捡起。

多进程：生产是 `--workers 2`，两个进程都会起这个循环，靠 MySQL 具名锁保证
同一时刻只有一个在推——否则同一件货可能被两个进程各发一次群控作业。
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import contextmanager
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import settings
from app.enums import AutoListingStage
from app.models import SkuAutoListing
from app.services.auto_listing.pipeline import advance

logger = logging.getLogger(__name__)

_LOCK_KEY = "erp:auto_listing:worker"

# 终态：worker 不再捡起（NEEDS_HUMAN 要人处理完手工重置 stage 才会回到流水线）
TERMINAL_STAGES = (
    AutoListingStage.DONE,
    AutoListingStage.NEEDS_HUMAN,
    AutoListingStage.FAILED,
)


def due_rows(db: Session, *, limit: int) -> list[SkuAutoListing]:
    """到点该推的行。next_run_at 为空 = 挂起（终态或人工按住），不捡。"""
    return (
        db.query(SkuAutoListing)
        .filter(
            SkuAutoListing.stage.notin_(TERMINAL_STAGES),
            SkuAutoListing.next_run_at.isnot(None),
            SkuAutoListing.next_run_at <= datetime.utcnow(),
        )
        .order_by(SkuAutoListing.next_run_at)
        .limit(limit)
        .all()
    )


def publish_via_gc(db, sku, info) -> str | None:
    """READY → 下发群控发布作业，返回 job_id。注入给 advance 用。

    gc_publish_shops 是 async；本函数只在 worker 线程里跑（见 run_worker_loop），
    主事件循环不在这个线程上，所以可以直接 asyncio.run 起个临时循环——gc 客户端
    每次调用都新建 httpx.AsyncClient，没有绑定循环的常驻状态。

    店铺不指定 = 全部已绑群控账号的启用店铺，与人工「发布到全部店铺」同一口径。
    """
    from app.services.gc_bridge.listing_ops import gc_publish_shops

    if not settings.gc_publish_enabled:
        raise RuntimeError("群控上架未启用（GC_PUBLISH_ENABLED）")
    rows = asyncio.run(gc_publish_shops(db, sku, info))
    return rows[0].gc_job_id if rows else None


@contextmanager
def _batch_lock(db: Session, key: str = _LOCK_KEY):
    """MySQL 具名锁，拿不到就跳过本轮（下一轮马上又来，不排队等）。key 默认自动上架那把。

    锁走**独立连接**：批内每推一行就 commit 一次，commit 会把会话连接还回池子，
    而具名锁是连接级的——用会话连接就会出现「在 A 连接上锁、在 B 连接上解」，
    锁于是一直挂着没人能再拿到。非 MySQL（测试用 SQLite）直接放行。
    """
    bind = db.get_bind()
    if bind is None or bind.dialect.name != "mysql":
        yield True
        return
    conn = bind.connect()
    got = False
    try:
        try:
            got = bool(conn.execute(text("SELECT GET_LOCK(:k, 0)"), {"k": key}).scalar())
        except Exception:  # noqa: BLE001 - 拿锁本身失败就当没抢到，本轮跳过
            logger.exception("获取自动上架锁失败，跳过本轮")
        yield got
    finally:
        try:
            if got:
                conn.execute(text("SELECT RELEASE_LOCK(:k)"), {"k": key})
        except Exception:  # noqa: BLE001
            logger.warning("释放自动上架锁失败（连接归还后由 MySQL 兜底）")
        conn.close()


def run_due(db: Session, *, publish=None, limit: int | None = None) -> int:
    """把到点的行各推一步，返回**真正换了阶段**的行数。

    一行一提交：某行炸了不带走整轮，也不让已推进的行白跑。
    """
    limit = limit or settings.auto_listing_batch_size
    moved = 0
    with _batch_lock(db) as acquired:
        if not acquired:
            return 0  # 另一个 worker 正在推，本轮跳过
        rows = due_rows(db, limit=limit)
        for row in rows:
            before = row.stage
            try:
                advance(db, row, publish=publish)
                db.commit()
            except Exception:  # noqa: BLE001 - 单行失败不能带走整轮
                db.rollback()
                logger.exception("推进自动上架失败: sku_id=%s", row.sku_id)
                continue
            if row.stage != before:
                moved += 1
    if moved:
        logger.info("自动上架推进 %d 行", moved)
    return moved


def _tick() -> int:
    """一轮：独立会话，用完就关，不跨轮持有 DB 连接。"""
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        return run_due(db, publish=publish_via_gc)
    finally:
        db.close()


async def run_worker_loop() -> None:
    """常驻协程：定时推进自动上架流水线。由 main.lifespan 启动，进程退出时取消。

    每轮丢到线程里跑：阶段推进是同步 ORM，发布还要起临时事件循环，
    不能占着主事件循环（那上面还挂着群控 WS 网关和所有 HTTP 请求）。
    """
    while True:
        try:
            await asyncio.sleep(max(settings.auto_listing_interval_seconds, 5))
            if not settings.auto_listing_enabled:
                continue
            await asyncio.to_thread(_tick)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - 循环必须活着
            logger.exception("自动上架 worker 循环异常")

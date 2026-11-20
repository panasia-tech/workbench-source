"""上架状态兜底对账：把没人看的货也收敛掉。

# 问题是怎么被发现的

2026-09-16 架构清理时查生产：`sku_shop_listing` 里 **46 行卡在「上架中」，最老的
是 8 月 13 日**——一个多月。而去问群控，这些作业**全都有终态**（FAILED 8 /
CANCELLED 1 / SUCCESS 1 这种）。也就是说收敛逻辑本身没问题，是没人调它。

`sync_gc_publish_status` 只在 `build_shops_payload` 里被调用，而后者只有两个入口：
有人 GET 某件货的店铺列表，或者某件货的 WS 连着（每 3 秒一拍）。两个都要求
**有人正在看那件货**。发出去之后再没人打开过的货，就永远停在「上架中」。

它的 docstring 里原话是「轮询式(供定时任务/接口触发)」——定时任务那半从没建。
这个文件就是那半。

# 为什么不直接把两张表合成一张

一度以为这是「同一个事实记了两份」。不是。它是两层账本，各有各的语义：

  gc_listing         执行层：sku × 群控账号 × item_id × LIVE/DELISTED/SOLD
                     「闲鱼上到底怎么样」，由流程回写，带闲鱼商品 id
  sku_shop_listing   业务层：sku × 销售店铺 × PENDING/LISTING/LISTED/FAILED
                     「业务要它怎么样、现在到哪一步」，带 gc_job_id 表示在途

一件货在两个店铺上架、两个店铺挂在同一个群控账号上，这种情况两层的行数就不一样。
合并会丢掉其中一层的语义。缺的从来不是合并，是**闭环**。

# 节流

- 只捞 `grace` 分钟内没动过的行：正在被人看着的货有 WS 每 3 秒一拍，不跟它抢；
- 每轮最多 `batch` 件货：积压时慢慢消化，不要一次把群控打满；
- 群控不可达时本轮跳过，不清 gc_job_id——「查不到」和「确实失败了」是两件事。
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta

from sqlalchemy import distinct

from app.config import settings
from app.database import SessionLocal
from app.models import Sku, SkuShopListing

logger = logging.getLogger("gc.reconcile")


def _interval() -> int:
    return max(30, int(getattr(settings, "gc_reconcile_interval_sec", 300) or 300))


def _grace() -> int:
    return max(1, int(getattr(settings, "gc_reconcile_grace_min", 10) or 10))


def _batch() -> int:
    return max(1, int(getattr(settings, "gc_reconcile_batch", 20) or 20))


# 「任务成功但账本没确认」的行有意不自动收敛（猜错会让人重发，同一件货挂两份）。
# 但它们此前完全隐形：没有任何地方说得出「有几行在等人对账」，于是没人对。
_NEEDS_HUMAN = "发布结果待对账"


def needs_human_count(db) -> int:
    """有多少行在等人工对账。数出来才有人管。"""
    return (
        db.query(SkuShopListing)
        .filter(SkuShopListing.last_error.like(f"%{_NEEDS_HUMAN}%"))
        .count()
    )


def pending_sku_ids(db, *, grace_min: int, limit: int) -> list[str]:
    """捞出「在途但已经很久没动」的货。

    按 sku 去重：收敛是按 SKU 做的（一次把它所有店铺行都过一遍），
    同一件货的多行不该触发多次。
    """
    cutoff = datetime.utcnow() - timedelta(minutes=grace_min)
    rows = (
        db.query(distinct(SkuShopListing.sku_id))
        .filter(
            SkuShopListing.gc_job_id.isnot(None),
            SkuShopListing.updated_at < cutoff,
        )
        .limit(limit)
        .all()
    )
    return [r[0] for r in rows]


async def reconcile_once(*, grace_min: int | None = None, limit: int | None = None) -> dict:
    """跑一轮。返回 {scanned, changed, failed}，供定时循环记日志、也供人工触发。"""
    from app.services.gc_bridge.listing_ops import sync_gc_publish_status

    grace_min = _grace() if grace_min is None else grace_min
    limit = _batch() if limit is None else limit
    scanned = changed = failed = 0
    with SessionLocal() as db:
        sku_ids = pending_sku_ids(db, grace_min=grace_min, limit=limit)
        for sku_id in sku_ids:
            sku = db.get(Sku, sku_id)
            if sku is None:
                continue
            scanned += 1
            try:
                changed += await sync_gc_publish_status(db, sku)
            except Exception as exc:
                # 群控不可达、单件数据异常：记下来继续下一件。一件卡住不该让整轮停摆。
                failed += 1
                logger.warning("对账失败 sku=%s: %s", sku.sku_code, exc)
        human = needs_human_count(db)
    return {"scanned": scanned, "changed": changed, "failed": failed, "needs_human": human}


async def run_reconcile_loop() -> None:
    """常驻协程。ERP 启动时拉起，和自动上架 worker、自提收款清扫是同一类角色。"""
    logger.info("上架状态兜底对账已启动：每 %ss 一轮，只碰 %s 分钟没动过的行",
                _interval(), _grace())
    while True:
        try:
            result = await reconcile_once()
            if result["scanned"] or result["needs_human"]:
                logger.info("对账一轮：过了 %s 件货，收敛 %s 行，失败 %s 件；"
                            "另有 %s 行等人工对账（任务成功但群控账本没确认，别直接重发）",
                            result["scanned"], result["changed"], result["failed"],
                            result["needs_human"])
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # 兜底的东西自己不能把主进程带崩
            logger.exception("对账轮异常，下一轮继续: %s", exc)
        await asyncio.sleep(_interval())

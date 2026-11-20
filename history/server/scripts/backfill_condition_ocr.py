"""存量采购单货况警示回扫：OCR 实拍图，命中「全新/几乎全新」回填 condition_warning。

为什么需要：037 迁移只给字段默认 False，存量单不会自动扫。此脚本一次性补扫，
并把命中结果同步到已入库的 SKU（议价端读 SKU 上的冗余字段）。

用法（本地连开发库直接跑；连生产库走 SSH 隧道并用 DATABASE_URL 覆盖，见 erp-server-deploy 记录）：
    python3 -m scripts.backfill_condition_ocr [--status PENDING_INSPECT] [--limit 0] [--only-unscanned] [--dry-run]

默认扫全部采购单。建议先 --dry-run 看命中量。
"""

from __future__ import annotations

import argparse
import asyncio
import logging
from datetime import datetime

from app.database import SessionLocal
from app.models import PurchaseOrder
from app.services.ocr import ocr_configured, scan_images_condition

logger = logging.getLogger("backfill_condition_ocr")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--status", default=None, help="只扫指定订单状态，如 PENDING_INSPECT；默认全部")
    parser.add_argument("--limit", type=int, default=0, help="最多处理多少单，0=不限")
    parser.add_argument("--only-unscanned", action="store_true", help="只扫 condition_scanned_at 为空的单")
    parser.add_argument("--dry-run", action="store_true", help="只统计不写库")
    args = parser.parse_args()

    if not ocr_configured():
        logger.error("OCR 未配置（OCR_HTTP_URL 为空），中止")
        return

    db = SessionLocal()
    try:
        q = db.query(PurchaseOrder)
        if args.status:
            q = q.filter(PurchaseOrder.status == args.status)
        if args.only_unscanned:
            q = q.filter(PurchaseOrder.condition_scanned_at.is_(None))
        q = q.order_by(PurchaseOrder.created_at.desc())
        if args.limit:
            q = q.limit(args.limit)
        orders = q.all()
        logger.info("待处理采购单 %d 单（dry_run=%s）", len(orders), args.dry_run)

        hit_count = 0
        for i, order in enumerate(orders, 1):
            images = list(order.product_images or [])
            if not images:
                continue
            try:
                hit = asyncio.run(scan_images_condition(images))
            except Exception:  # noqa: BLE001 - 单单失败不应中断整批
                logger.exception("扫描失败 order_no=%s", order.order_no)
                continue
            if hit:
                hit_count += 1
                logger.info("[%d/%d] 命中「%s」 order_no=%s", i, len(orders), hit, order.order_no)
            if not args.dry_run:
                order.condition_warning = bool(hit)
                order.condition_warning_text = hit
                order.condition_scanned_at = datetime.utcnow()
                for sku in order.skus:
                    sku.condition_warning = bool(hit)
                    sku.condition_warning_text = hit
                db.commit()

        logger.info("完成：处理 %d 单，命中 %d 单%s", len(orders), hit_count,
                    "（dry-run 未写库）" if args.dry_run else "")
    finally:
        db.close()


if __name__ == "__main__":
    main()

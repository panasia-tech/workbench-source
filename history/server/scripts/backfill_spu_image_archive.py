#!/usr/bin/env python3
"""把已审核通过(READY)的 spu_image_search.pool_images 回填进 warehouse_spu_image(不联网)。

用法:
    python -m scripts.backfill_spu_image_archive --dry-run
    python -m scripts.backfill_spu_image_archive

待审核(REVIEWING)的行不会被写入档案。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import SessionLocal
from app.models import SpuImageSearch
from app.services import spu_image_archive


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="只统计,不写库")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        query = db.query(SpuImageSearch).filter(
            SpuImageSearch.status == SpuImageSearch.READY,
            SpuImageSearch.pool_images.isnot(None),
        )
        rows = query.all()
        images = sum(len(row.pool_images or []) for row in rows)
        print(f"待回填 SPU: {len(rows)}, 图池总张数: {images}")
        if args.dry_run:
            print("dry-run: 没有写库")
            return 0
        result = spu_image_archive.rebuild_from_pool(db)
        print(f"完成: SPU {result['spus']}, 写入/更新 {result['images']} 张, 跳过 {result['skipped']}")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())

"""把迁移来的历史图从 sku.images 改归类到 sku.location_images(仓库定位图)。

历史数据迁移时,老系统的图(CloudBase cloud:// 与秦丝外链,现都已落到 OSS
`.../migrate/...` 路径)被错误归到了商品实拍图 images。这些实际上是仓库定位/
标签图,应放进 location_images。新系统真实拍图/验货图(cloud://、purchase/、
inspection/、goods/album 等,URL 不含 /migrate/)保持不动。

规则(按图片逐张判断,URL 含 `/migrate/` 即视为迁移图):
  - 被迁图从 images 移除;images 仅保留非迁移图(真实拍图)。
  - location_images = [被迁图(保持原 images 顺序)] + [原有 location_images],去重。
    → 迁移来的图展示在前,原有定位图在后。
  - cover_url 保持不变。
  - 幂等:再次运行时 images 已无 /migrate/ 图 → 无操作。

用法(生产服务器 /www/wwwroot/py-api 下,venv 内):
    PYTHONPATH=. venv/bin/python scripts/migration/reclass_images_to_location.py --dry-run
    PYTHONPATH=. venv/bin/python scripts/migration/reclass_images_to_location.py
"""

from __future__ import annotations

import argparse
import logging

from sqlalchemy.orm.attributes import flag_modified

from app.database import SessionLocal
from app.models import Sku

logger = logging.getLogger("migration.reclass_images")

MIGRATED_MARKER = "/migrate/"


def _is_migrated(url) -> bool:
    return isinstance(url, str) and MIGRATED_MARKER in url


def _dedup(seq):
    seen = set()
    out = []
    for u in seq:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    db = SessionLocal()
    try:
        changed = 0
        moved_imgs = 0
        emptied = 0
        for sku in db.query(Sku).all():
            images = list(sku.images or [])
            location = list(sku.location_images or [])
            moved = [u for u in images if _is_migrated(u)]
            if not moved:
                continue
            remaining = [u for u in images if not _is_migrated(u)]
            new_location = _dedup(moved + location)

            changed += 1
            moved_imgs += len(moved)
            if not remaining:
                emptied += 1

            if not args.dry_run:
                sku.images = remaining
                sku.location_images = new_location
                flag_modified(sku, "images")
                flag_modified(sku, "location_images")

        if not args.dry_run:
            db.commit()

        logger.info(
            "%s受影响 sku: %d | 迁移图片: %d 张 | images 变空的 sku: %d",
            "[dry-run] " if args.dry_run else "",
            changed, moved_imgs, emptied,
        )
    finally:
        db.close()


if __name__ == "__main__":
    main()

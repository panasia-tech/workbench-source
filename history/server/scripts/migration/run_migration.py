"""ETL 主入口:按依赖顺序执行所有 ETL 步骤。

用法:
    python -m scripts.migration.run_migration              # 跑全部
    python -m scripts.migration.run_migration --only users payment_accounts
    python -m scripts.migration.run_migration --skip event_log
    python -m scripts.migration.run_migration --dry-run    # 只统计不写入
"""

from __future__ import annotations

import argparse
import logging
from pathlib import Path

from app.database import SessionLocal
from scripts.migration.common import CLOUD_DUMP_DIR, EtlStep, IdMapper
from scripts.migration.etl import STEPS

logger = logging.getLogger("migration.run")


def topo_sort(steps: list[EtlStep]) -> list[EtlStep]:
    by_name = {s.name: s for s in steps}
    visited: set[str] = set()
    ordered: list[EtlStep] = []

    def visit(name: str) -> None:
        if name in visited:
            return
        visited.add(name)
        s = by_name.get(name)
        if not s:
            return
        for dep in s.depends_on:
            visit(dep)
        ordered.append(s)

    for s in steps:
        visit(s.name)
    return ordered


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", nargs="*", default=None, help="只跑这些 step")
    parser.add_argument("--skip", nargs="*", default=[], help="跳过这些 step")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--id-map-file", default=str(CLOUD_DUMP_DIR / "id_map.json"))
    args = parser.parse_args()

    steps = STEPS
    if args.only:
        wanted = set(args.only)
        steps = [s for s in steps if s.name in wanted]
    steps = [s for s in steps if s.name not in args.skip]
    steps = topo_sort(steps)

    logger.info("准备执行 %d 个 step: %s", len(steps), [s.name for s in steps])

    mapper = IdMapper()
    id_map_path = Path(args.id_map_file)
    mapper.load(id_map_path)

    if args.dry_run:
        for s in steps:
            logger.info("[DRY-RUN] %s ← %s", s.name, s.collection)
        return

    db = SessionLocal()
    try:
        grand_total = 0
        for s in steps:
            try:
                grand_total += s.run(db, mapper)
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                logger.exception("[%s] 失败: %s", s.name, exc)
                raise
        logger.info("✅ 全部完成,合计导入 %d 条", grand_total)
    finally:
        mapper.save(id_map_path)
        db.close()


if __name__ == "__main__":
    main()

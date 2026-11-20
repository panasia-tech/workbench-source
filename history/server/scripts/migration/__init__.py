"""CloudBase → MySQL 数据迁移工具集。

使用方式:
    1. 先用 `scripts/migration/fetch_cloud.py` 将云端集合导出为 JSONL,
       存放在 `data/cloud_dump/<collection>.jsonl`
    2. 运行 `python -m scripts.migration.run_migration --collection all`

每个集合的转换逻辑在 `scripts/migration/etl/` 下。
"""

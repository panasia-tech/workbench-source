"""把 CloudBase NoSQL 集合分页导出到 data/cloud_dump/<collection>.jsonl。

依赖:CloudBase CLI(>= 3.5)。安装:
    npm i -g @cloudbase/cli
    tcb login

用法:
    cd server
    python3 -m scripts.migration.fetch_cloud --all
    python3 -m scripts.migration.fetch_cloud --collection users items
    python3 -m scripts.migration.fetch_cloud --collection event_log --page-size 500
    python3 -m scripts.migration.fetch_cloud --env-id wms-8g7f6vae1ef8f780 --all

底层用 `tcb db nosql execute --command '[{"TableName":...,"CommandType":"QUERY","Command":"{\"find\":...}"}]'`
分页拉取,每页 page_size 条,直到返回少于 page_size 即停止。
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
from pathlib import Path

from scripts.migration.common import CLOUD_DUMP_DIR

logger = logging.getLogger("migration.fetch")

DEFAULT_ENV_ID = os.environ.get("TCB_ENV_ID", "wms-8g7f6vae1ef8f780")
DEFAULT_PAGE_SIZE = 1000

COLLECTIONS = [
    # 核心业务
    "users",
    "payment_accounts",
    "purchase_orders",
    "sales_orders",
    "items",
    "inventory_ledger",
    "xianyu_listings",
    # 对账/支付
    "payment_bindings",
    "payment_transactions",
    "audit_runs",
    "audit_tasks",
    "audit_issues",
    # 业务工单
    "ops_tasks",
    "negotiation_tasks",
    "slow_moving_restock_records",
    "price_adjustments",
    "price_adjustment_logs",
    "issue_tickets",
    # 库存请求
    "inventory_manual_requests",
    "inventory_listing_tasks",
    # 资产
    "asset_devices",
    "asset_inventory_tasks",
    "asset_inventory_records",
    "asset_reduction_requests",
    # 排班
    "staff_schedule_logs",
    "staff_schedule_overrides",
    "staff_schedule_holiday_requests",
    # 待办
    "todo_task_templates",
    "todo_task_assignments",
    "todo_task_logs",
    # 杂项
    "llm_api_keys",
    "export_tasks",
    "logistics_track_events",
    "event_log",
]


def _tcb_query(env_id: str, collection: str, skip: int, limit: int) -> list[dict]:
    """单页查询。返回该页的文档列表。"""
    mongo_cmd = json.dumps(
        {
            "find": collection,
            "filter": {},
            "skip": skip,
            "limit": limit,
        }
    )
    payload = json.dumps(
        [{"TableName": collection, "CommandType": "QUERY", "Command": mongo_cmd}]
    )
    cmd = ["tcb", "db", "nosql", "execute", "-e", env_id, "--command", payload, "--json"]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)  # noqa: S603
    if proc.returncode != 0:
        logger.error("[%s] tcb 调用失败 skip=%d: %s", collection, skip, proc.stderr.strip())
        return []
    try:
        out = json.loads(proc.stdout)
    except json.JSONDecodeError:
        logger.error("[%s] tcb 输出非 JSON: %s", collection, proc.stdout[:200])
        return []
    err = out.get("error")
    if err:
        logger.error("[%s] tcb 返回错误: %s", collection, err)
        return []
    results = out.get("data", {}).get("results", [[]])
    return results[0] if results else []


def dump_collection(env_id: str, collection: str, dst_dir: Path, page_size: int) -> int:
    dst = dst_dir / f"{collection}.jsonl"
    skip = 0
    total = 0
    with dst.open("w", encoding="utf-8") as f:
        while True:
            docs = _tcb_query(env_id, collection, skip, page_size)
            if not docs:
                break
            for d in docs:
                f.write(json.dumps(d, ensure_ascii=False) + "\n")
            total += len(docs)
            logger.info("[%s] +%d (累计 %d)", collection, len(docs), total)
            if len(docs) < page_size:
                break
            skip += len(docs)
    logger.info("[%s] 完成,导出 %d 条 → %s", collection, total, dst)
    return total


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true", help="导出全部集合")
    parser.add_argument(
        "--collection",
        nargs="+",
        default=[],
        help="只导出这些集合(空格分隔)",
    )
    parser.add_argument("--env-id", default=DEFAULT_ENV_ID, help=f"CloudBase 环境 ID(默认 {DEFAULT_ENV_ID})")
    parser.add_argument("--page-size", type=int, default=DEFAULT_PAGE_SIZE, help=f"分页大小(默认 {DEFAULT_PAGE_SIZE})")
    args = parser.parse_args()

    CLOUD_DUMP_DIR.mkdir(parents=True, exist_ok=True)
    targets = COLLECTIONS if args.all else args.collection
    if not targets:
        parser.print_help()
        sys.exit(1)

    grand_total = 0
    for coll in targets:
        if coll not in COLLECTIONS:
            logger.warning("未知集合: %s,跳过", coll)
            continue
        grand_total += dump_collection(args.env_id, coll, CLOUD_DUMP_DIR, args.page_size)
    logger.info("全部完成,总计 %d 条", grand_total)


if __name__ == "__main__":
    main()

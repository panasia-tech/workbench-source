"""物流轮询入口,由 systemd timer 周期调用。

用法: python3 -m scripts.run_logistics_poll [--limit 50]
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os

from app.database import SessionLocal
from app.services.logistics_poll import run_poll_batch


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=int(os.environ.get("LOGISTICS_POLL_BATCH", "50")))
    args = parser.parse_args()

    db = SessionLocal()
    try:
        stats = asyncio.run(run_poll_batch(db, limit=args.limit))
        logging.getLogger("logistics_poll").info("轮询完成: %s", stats)
    finally:
        db.close()


if __name__ == "__main__":
    main()

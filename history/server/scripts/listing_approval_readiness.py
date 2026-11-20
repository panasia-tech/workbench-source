"""盘点上架审批打开前的存量：在架待整改 / 待清洗 / 待审批。

用法（在 server 目录）:
  python scripts/listing_approval_readiness.py
  python scripts/listing_approval_readiness.py --enable   # 管理员显式打开开关（先看盘点）
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.database import SessionLocal
from app.services import listing_approval as la
from app.services.app_settings import set_setting


def main() -> int:
    parser = argparse.ArgumentParser(description="上架审批存量盘点")
    parser.add_argument("--enable", action="store_true", help="盘点后打开 listing_approval_required")
    parser.add_argument("--disable", action="store_true", help="关掉开关")
    args = parser.parse_args()
    with SessionLocal() as db:
        ready = la.readiness(db)
        print(f"开关: {'开' if ready['required'] else '关'}")
        print(f"启用店铺: {ready['shop_count']}")
        print(f"在库可发: {ready['in_stock']}")
        print(f"待清洗:   {ready['todo']}")
        print(f"待审批:   {ready['review']}")
        print(f"在架待整改: {ready['fix']}")
        print(f"全部通过: {ready['done']}")
        print(ready["safe_hint"])
        if ready["fix_samples"]:
            print("整改样例:", ", ".join(ready["fix_samples"]))
        if args.enable and args.disable:
            print("不能同时 --enable 和 --disable", file=sys.stderr)
            return 2
        if args.enable:
            set_setting(db, la.REQUIRED_KEY, "1", None)
            db.commit()
            print("已打开 listing_approval_required")
        if args.disable:
            set_setting(db, la.REQUIRED_KEY, "0", None)
            db.commit()
            print("已关掉 listing_approval_required")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

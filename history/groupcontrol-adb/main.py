"""群控 ADB 保活/投屏守护入口。mac 开发 / win 正式跑,同一份代码。"""
from __future__ import annotations

import argparse
import logging
import sys

import yaml

from gc_adb.daemon import Daemon


def main() -> None:
    ap = argparse.ArgumentParser(description="群控 ADB 保活/投屏守护")
    ap.add_argument("-c", "--config", default="config.yaml", help="配置文件路径")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    try:
        with open(args.config, encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
    except FileNotFoundError:
        print(f"找不到配置 {args.config};先 cp config.example.yaml config.yaml", file=sys.stderr)
        sys.exit(1)

    Daemon(cfg).run()


if __name__ == "__main__":
    main()

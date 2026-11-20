"""爬虫补评老任务的上架用图质量分之后,把已结束跟进的图池(在审、已合格)按爬虫现在的顺序和质量分重同步一遍。

不改状态、不换参考图,只更新 spu_image_search.pool_images。
加 --fix-held:再把「备好（爬虫图）」的存量货里带水印、海报字的图换掉(只动没人改过的,见 backfill.recheck_crawled_images);
不加 --apply 只数不改。用法:python -m scripts.refresh_crawler_pools [--fix-held] [--apply]
"""
import argparse

from app.database import SessionLocal
from app.services import product_image
from app.services.auto_listing.backfill import recheck_crawled_images


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fix-held", action="store_true")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()
    db = SessionLocal()
    try:
        if args.apply:
            print("图池有变化的型号:", product_image.refresh_pools(db))
        if args.fix_held:
            print("备好（爬虫图）的存量货:", recheck_crawled_images(db, dry_run=not args.apply))
    finally:
        db.close()


if __name__ == "__main__":
    main()

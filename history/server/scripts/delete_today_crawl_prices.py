"""清理某一天爬到的行情价（默认中国日界今天）。

用途：爬虫早期取价逻辑有误（把「猜你喜欢」推荐里的诱饵低价当成结果，出过 ¥5/¥15 脏值），
需要把当天上报的 CrawlPrice 全部删掉，并把受影响商品的冗余「最新价」回滚到剩余最近一条。

用法（在生产 py-api 目录，须能读 .env → 生产库 erp_xcx）：
    cd /www/wwwroot/py-api
    python -m scripts.delete_today_crawl_prices            # 删中国日界今天
    python -m scripts.delete_today_crawl_prices 2026-06-24 # 删指定日期
    python -m scripts.delete_today_crawl_prices --dry      # 只看不删
"""
import sys
from datetime import date

from app.database import SessionLocal
from app.models import CrawlPrice, CrawlProduct
from app.services.finance import china_today


def main():
    args = [a for a in sys.argv[1:]]
    dry = "--dry" in args
    args = [a for a in args if a != "--dry"]
    target = date.fromisoformat(args[0]) if args else china_today()

    db = SessionLocal()
    try:
        rows = db.query(CrawlPrice).filter(CrawlPrice.crawl_date == target).all()
        product_ids = sorted({r.product_id for r in rows})
        print(f"目标日期 {target}：命中 {len(rows)} 条行情价，涉及 {len(product_ids)} 个商品")
        if dry:
            for r in rows[:30]:
                print(f"  {r.product_id}  ¥{r.price}  {(r.raw or {}).get('source')}")
            print("（--dry 仅预览，未删除）")
            return

        deleted = (
            db.query(CrawlPrice)
            .filter(CrawlPrice.crawl_date == target)
            .delete(synchronize_session=False)
        )
        db.flush()

        # 回滚受影响商品的冗余「最新价」到剩余最近一条（没有则清空）
        rolled = 0
        for pid in product_ids:
            prod = db.get(CrawlProduct, pid)
            if not prod:
                continue
            latest = (
                db.query(CrawlPrice)
                .filter(CrawlPrice.product_id == pid)
                .order_by(CrawlPrice.crawl_date.desc())
                .first()
            )
            if latest:
                prod.last_price = latest.price
                prod.last_price_date = latest.crawl_date
            else:
                prod.last_price = None
                prod.last_price_date = None
                prod.last_crawled_at = None
            rolled += 1

        db.commit()
        print(f"已删除 {deleted} 条；回滚 {rolled} 个商品的最新价")
    finally:
        db.close()


if __name__ == "__main__":
    main()

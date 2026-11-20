"""虚拟商品订单：每分钟从群控聊天里认一遍付款、查发出中的码、开着自动发货就发（erp-virtual-orders.timer）。

用法: python3 -m scripts.run_virtual_orders
逻辑见 app/services/virtual_goods.py 的 sync。
"""
from __future__ import annotations

import asyncio
import logging

from sqlalchemy import text

from app.database import SessionLocal
from app.services.virtual_goods import sync

_LOCK = "erp:virtual:orders"
logger = logging.getLogger("virtual.orders")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
    db = SessionLocal()
    try:
        if db.execute(text("SELECT GET_LOCK(:n, 0)"), {"n": _LOCK}).scalar() != 1:
            logger.info("上一轮还在跑，跳过")
            return
        r = asyncio.run(sync(db))
        if any(r.values()):
            logger.info("虚拟订单：新单 %d、状态变了 %d、发出结果 %d、自动发 %d",
                        r["new"], r["updated"], r["checked"], r["auto_sent"])
    finally:
        db.close()


if __name__ == "__main__":
    main()

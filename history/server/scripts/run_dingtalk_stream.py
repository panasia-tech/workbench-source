"""钉钉事件常驻监听：Stream 长连接收「通讯录用户增加 / 离职」，交给 app/services/dingtalk_sync.py 建号、删号。

用法: python3 -m scripts.run_dingtalk_stream
由 systemd 常驻（erp-dingtalk-stream.service，Restart=always）。断线自己重连，退避到 60 秒封顶。
开关 DINGTALK_SYNC_ENABLED 没开时照样连着，收到事件只记一行「会怎么做」，不动账号（漏掉的离职靠每天对账补）。
处理出错回钉钉 LATER，钉钉过一会儿重推；建号、删号都是幂等的，重推不会多建。
"""
from __future__ import annotations

import asyncio
import json
import logging
import sys
import urllib.parse

import websockets

from app.database import SessionLocal
from app.services import dingtalk, dingtalk_sync

logger = logging.getLogger("dingtalk_stream")


def _handle(event_type: str, data: str) -> bool:
    """在线程里跑（要连库、调钉钉接口）。返回是否处理成功。"""
    dry_run = bool(dingtalk_sync.why_not())
    db = SessionLocal()
    try:
        for line in dingtalk_sync.handle_event(db, event_type, data, dry_run=dry_run):
            logger.info("%s%s", "[预演] " if dry_run else "", line)
        return True
    except Exception:
        db.rollback()
        logger.exception("处理钉钉事件失败 %s %s", event_type, data[:300])
        return False
    finally:
        db.close()


def _ack(msg: dict, data: str) -> str:
    return json.dumps(
        {"code": 200, "headers": {"contentType": "application/json", "messageId": msg["headers"].get("messageId")}, "message": "OK", "data": data}
    )


async def _session() -> None:
    endpoint, ticket = await asyncio.to_thread(dingtalk.open_stream)
    async with websockets.connect(f"{endpoint}?ticket={urllib.parse.quote(ticket)}", ping_interval=30) as ws:
        logger.info("钉钉 Stream 已连上")
        async for raw in ws:
            msg = json.loads(raw)
            headers = msg.get("headers") or {}
            if msg.get("type") == "SYSTEM":
                if headers.get("topic") == "disconnect":
                    logger.info("钉钉要求断开重连")
                    return
                await ws.send(_ack(msg, msg.get("data") or ""))  # ping：原样回
                continue
            event_type = headers.get("eventType") or ""
            ok = True
            if event_type in (dingtalk_sync.JOIN, dingtalk_sync.LEAVE, dingtalk_sync.MODIFY):
                logger.info("收到钉钉事件 %s %s", event_type, headers.get("eventId"))
                ok = await asyncio.to_thread(_handle, event_type, msg.get("data") or "")
            status = {"status": "SUCCESS", "message": "success"} if ok else {"status": "LATER", "message": "retry"}
            await ws.send(_ack(msg, json.dumps(status)))


async def main() -> None:
    delay = 1
    while True:
        try:
            await _session()
            delay = 1
        except Exception as exc:  # noqa: BLE001 - 常驻进程，任何错都重连
            logger.warning("钉钉 Stream 断了：%s，%s 秒后重连", exc, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")
    why = dingtalk_sync.why_not(dry_run=True)
    if why:
        logger.error("%s，不启动", why)
        sys.exit(1)
    if dingtalk_sync.why_not():
        logger.info("账号同步未开启：只连着记日志，不建号也不删号")
    asyncio.run(main())

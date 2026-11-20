"""上下架状态 WS 推送(/ws/sku-shops/{sku_code}):替代小程序客户端 HTTP 轮询。

gc 上架是异步(调度器分钟级驱动真机),终态没有主动事件源,故本端点**服务端代轮询**:
连接期间每 3s 跑 sync_gc_publish_status 回写并比对快照,变了才推一帧;
全部收敛(gc_pending 清零)推终帧(settled=true)并正常关闭。

- 鉴权:?token=<JWT>(与 REST 同一 HS256 密钥,见 deps.decode_token)。
- 每连接独立轮询循环——ERP 多 worker(erp-api.service --workers 2)下无需跨进程广播。
- 并发量极小(内部员工几人),3s×N 连接打 gc 无压力;gc 侧后续改主动回调后可去掉代轮询。
- 两代际前缀别混:本路由在根路径 /ws/*,与旧内嵌群控 /api/gc/ws 无关。
"""

import asyncio
import json
import time

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect
from jose import JWTError

from app.database import SessionLocal
from app.deps import decode_token
from app.enums import StaffStatus
from app.models import Sku, Staff
from app.services.listing_shops import build_shops_payload

router = APIRouter()

_POLL_SEC = 3.0
_MAX_LIFETIME_SEC = 10 * 60  # 兜底:连接最长 10 分钟,防异常常驻


def _staff_ok(token: str) -> bool:
    """与 get_current_user 同规则(JWT 有效 + 员工激活),WS 无法走 Depends(HTTPBearer)。"""
    if not token:
        return False
    db = SessionLocal()
    try:
        staff_id = decode_token(token).get("sub")
        staff = db.get(Staff, staff_id) if staff_id else None
        return bool(staff and not staff.deleted_at and staff.status == StaffStatus.ACTIVE)
    except JWTError:
        return False
    finally:
        db.close()


@router.websocket("/ws/sku-shops/{sku_code}")
async def sku_shops_ws(ws: WebSocket, sku_code: str, token: str = Query(default="")):
    if not _staff_ok(token):
        await ws.close(code=4401)
        return
    await ws.accept()

    deadline = time.monotonic() + _MAX_LIFETIME_SEC
    last_blob: str | None = None
    try:
        while True:
            db = SessionLocal()
            try:
                sku = db.query(Sku).filter(Sku.sku_code == sku_code).first()
                if not sku:
                    await ws.send_json({"type": "error", "detail": "SKU 不存在"})
                    await ws.close(code=4404)
                    return
                payload = await build_shops_payload(db, sku)
            finally:
                db.close()

            shops = [item.model_dump(mode="json") for item in payload]
            settled = not any(s["gc_pending"] for s in shops)
            blob = json.dumps(shops, sort_keys=True, ensure_ascii=False)
            if blob != last_blob:
                last_blob = blob
                await ws.send_json({"type": "shops", "shops": shops, "settled": settled})
            if settled:
                await ws.close(code=1000)
                return
            if time.monotonic() > deadline:
                await ws.close(code=1000)
                return
            await asyncio.sleep(_POLL_SEC)
    except (WebSocketDisconnect, RuntimeError):
        # 客户端断开:sleep 期间的断开会下一轮 send 时抛 RuntimeError,同样静默收尾。
        return

"""采购入站 webhook 服务：验签 + 幂等落库。

分层：
- verify.py  HMAC-SHA256 验签 + 时间戳窗口（防重放）
- ingest.py  幂等落库到 purchase_webhook_event
"""

from app.services.purchase_webhook.ingest import ingest_event
from app.services.purchase_webhook.verify import verify_signature

__all__ = ["ingest_event", "verify_signature"]

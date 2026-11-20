"""采购入站 webhook 验签。

签名方案（与对方约定）：
    signed = f"{timestamp}." + <原始请求 body 字节>
    signature = hex( HMAC_SHA256(secret, signed) )
请求头：
    X-Webhook-Timestamp: <unix 秒>
    X-Webhook-Signature: sha256=<signature>

要点：
- 对「原始 body 字节」验签，不是解析后的字段（防篡改）；
- 把 timestamp 拌进签名并做时间窗校验（防重放）；
- 用 hmac.compare_digest 常量时间比对（防时序侧信道）；
- 支持主/备双密钥，任一通过即可（供密钥轮换过渡）。
"""

import hashlib
import hmac
import time


def _sign(raw_body: bytes, ts: int, secret: str) -> str:
    signed = f"{ts}.".encode() + raw_body
    return hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()


def verify_signature(
    raw_body: bytes,
    timestamp: str | None,
    signature: str | None,
    secrets: list[str],
    tolerance_seconds: int,
    now: int | None = None,
) -> tuple[bool, str]:
    """校验签名。返回 (是否通过, 失败原因)。

    secrets: 候选密钥列表（主/备），空串会被忽略。
    now: 当前 unix 秒，缺省取系统时间（测试时可注入）。
    """
    valid_secrets = [s for s in secrets if s]
    if not valid_secrets:
        return False, "secret not configured"
    if not signature:
        return False, "missing signature"
    if not timestamp:
        return False, "missing timestamp"

    # 1) 时间戳窗口，防重放
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        return False, "bad timestamp"
    current = int(time.time()) if now is None else now
    if abs(current - ts) > tolerance_seconds:
        return False, "timestamp expired"

    # 2) 重算 HMAC，常量时间比对；主备密钥任一通过即可
    got = signature.removeprefix("sha256=").strip()
    for secret in valid_secrets:
        expected = _sign(raw_body, ts, secret)
        if hmac.compare_digest(expected, got):
            return True, ""
    return False, "signature mismatch"

"""台账里要加密存的东西（支付宝授权令牌）。AES-256-GCM，密钥来自 LEDGER_SECRET_KEY。"""

from __future__ import annotations

import base64
import hashlib
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.config import settings


def _key() -> bytes:
    raw = settings.ledger_secret_key or f"ledger-token:{settings.jwt_secret}"
    return hashlib.sha256(raw.encode()).digest()


def seal(plain: str | None) -> str | None:
    if not plain:
        return None
    nonce = os.urandom(12)
    return base64.b64encode(nonce + AESGCM(_key()).encrypt(nonce, plain.encode(), None)).decode()


def unseal(sealed: str | None) -> str | None:
    if not sealed:
        return None
    blob = base64.b64decode(sealed)
    return AESGCM(_key()).decrypt(blob[:12], blob[12:], None).decode()

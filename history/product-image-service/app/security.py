from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from .config import Settings
from .db import Database


class CredentialVault:
    def __init__(self, settings: Settings, database: Database):
        self.database = database
        self.fernet: Fernet | None = None
        if settings.credential_encryption_key:
            try:
                self.fernet = Fernet(settings.credential_encryption_key.encode())
            except (ValueError, TypeError):
                self.fernet = None

    @property
    def enabled(self) -> bool:
        return self.fernet is not None

    def get(self, provider: str) -> dict[str, str]:
        stored = self.database.get_config(provider)
        if not stored or not self.fernet:
            return {}
        try:
            raw = self.fernet.decrypt(stored.encode()).decode()
            value = json.loads(raw)
            return {str(k): str(v) for k, v in value.items() if v is not None}
        except (InvalidToken, ValueError, TypeError, json.JSONDecodeError):
            return {}

    def put(self, provider: str, values: dict[str, str]) -> None:
        if not self.fernet:
            raise RuntimeError("CREDENTIAL_ENCRYPTION_KEY is not configured")
        payload = json.dumps(values, ensure_ascii=False, sort_keys=True).encode()
        self.database.put_config(provider, self.fernet.encrypt(payload).decode())

    def masked(self, provider: str) -> dict[str, str]:
        return {key: "********" if value else "" for key, value in self.get(provider).items()}


class AdminSession:
    def __init__(self, settings: Settings):
        self.password = settings.admin_password
        self.secret = settings.admin_session_secret.encode()

    def authenticate(self, password: str) -> bool:
        return bool(self.password) and hmac.compare_digest(password, self.password)

    def issue(self) -> str:
        payload = {"exp": int(time.time()) + 8 * 3600, "nonce": secrets.token_urlsafe(12)}
        body = base64.urlsafe_b64encode(
            json.dumps(payload, separators=(",", ":")).encode()
        ).decode()
        signature = hmac.new(self.secret, body.encode(), hashlib.sha256).hexdigest()
        return f"{body}.{signature}"

    def valid(self, token: str | None) -> bool:
        if not token or "." not in token:
            return False
        body, signature = token.rsplit(".", 1)
        expected = hmac.new(self.secret, body.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            return False
        try:
            payload: dict[str, Any] = json.loads(base64.urlsafe_b64decode(body + "===").decode())
            return int(payload.get("exp", 0)) >= int(time.time())
        except (ValueError, TypeError, json.JSONDecodeError):
            return False

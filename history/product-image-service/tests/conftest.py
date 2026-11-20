from __future__ import annotations

from pathlib import Path

from cryptography.fernet import Fernet

from app.config import Settings


def make_settings(tmp_path: Path) -> Settings:
    return Settings(
        data_dir=tmp_path / "data",
        storage_dir=tmp_path / "storage",
        database_path=tmp_path / "data" / "test.sqlite3",
        orchestration_manifest_path=Path("config/orchestration.json").resolve(),
        orchestration_state_path=tmp_path / "data" / "orchestration_state.json",
        enabled_providers="",
        admin_password="DEMO_ONLY_REDACTED",
        admin_session_secret="DEMO_ONLY_REDACTED",
        credential_encryption_key=Fernet.generate_key().decode(),
        public_base_url="http://testserver",
    )

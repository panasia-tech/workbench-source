from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx

from ..models import Candidate, ProductIdentity, ProviderState


def utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass
class Health:
    state: ProviderState
    message: str = ""


class Provider(ABC):
    name: str
    source_type: str

    def __init__(self, client: httpx.AsyncClient, credentials: dict[str, str] | None = None):
        self.client = client
        self.credentials = credentials or {}
        self.query_cap = 8

    @abstractmethod
    async def search(self, product: ProductIdentity, queries: list[str]) -> list[Candidate]:
        raise NotImplementedError

    async def fetch(self, candidate: Candidate) -> bytes:
        response = await self.client.get(candidate.image_url)
        response.raise_for_status()
        return response.content

    @abstractmethod
    async def healthcheck(self) -> Health:
        raise NotImplementedError

    def candidate(self, **values: Any) -> Candidate:
        return Candidate(
            provider=self.name,
            source_type=self.source_type,
            discovered_at=utc_now(),
            **values,
        )

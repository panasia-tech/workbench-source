from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class OrchestrationRegistry:
    """Editable platform/component catalog used by the admin control plane.

    The catalog deliberately separates source projects from service-owned stages.
    A reference project is visible and auditable, but is not silently executed as
    an arbitrary subprocess. Platform adapters can be promoted to ``builtin``
    after their code and smoke tests are brought into this service.
    """

    def __init__(self, manifest_path: Path, state_path: Path):
        self.manifest_path = manifest_path
        self.state_path = state_path
        self._manifest: dict[str, Any] = {}
        self._state: dict[str, Any] = {}
        self.reload()

    @property
    def manifest(self) -> dict[str, Any]:
        return self._manifest

    def reload(self) -> None:
        self._manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        if self.state_path.is_file():
            try:
                self._state = json.loads(self.state_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                self._state = {}
        else:
            self._state = {}

    def _platform_enabled(self, platform: dict[str, Any]) -> bool:
        return bool(
            self._state.get("platform_enabled", {}).get(
                platform["id"], platform.get("enabled", True)
            )
        )

    def _component_enabled(self, platform: dict[str, Any], component: dict[str, Any]) -> bool:
        key = f"{platform['id']}:{component['id']}"
        return bool(
            self._state.get("component_enabled", {}).get(key, component.get("enabled", True))
        )

    @staticmethod
    def _health(component: dict[str, Any], enabled: bool) -> str:
        if not enabled:
            return "disabled"
        return component.get("health", "unverified")

    def _component_view(
        self, platform: dict[str, Any], component: dict[str, Any]
    ) -> dict[str, Any]:
        enabled = self._component_enabled(platform, component) and self._platform_enabled(platform)
        item = dict(component)
        item["enabled"] = enabled
        item["health"] = self._health(component, enabled)
        return item

    def platform_views(self) -> list[dict[str, Any]]:
        views: list[dict[str, Any]] = []
        for platform in self._manifest.get("platforms", []):
            components = [
                self._component_view(platform, item) for item in platform.get("components", [])
            ]
            enabled_components = [item for item in components if item["enabled"]]
            health_counts: dict[str, int] = {}
            for item in components:
                health_counts[item["health"]] = health_counts.get(item["health"], 0) + 1
            view = {key: value for key, value in platform.items() if key != "components"}
            view.update(
                {
                    "enabled": self._platform_enabled(platform),
                    "component_count": len(components),
                    "enabled_component_count": len(enabled_components),
                    "health_counts": health_counts,
                    "components": components,
                }
            )
            views.append(view)
        return views

    def summary(self) -> dict[str, Any]:
        platforms = self.platform_views()
        components = [component for platform in platforms for component in platform["components"]]
        return {
            "manifest_version": self._manifest.get("version", 1),
            "platform_count": len(platforms),
            "enabled_platform_count": sum(1 for platform in platforms if platform["enabled"]),
            "component_count": len(components),
            "enabled_component_count": sum(1 for component in components if component["enabled"]),
            "ready_count": sum(1 for component in components if component["health"] == "ready"),
            "reference_count": sum(
                1 for component in components if component["health"] == "reference_only"
            ),
            "attention_count": sum(
                1
                for component in components
                if component["health"] in {"auth_required", "degraded", "unverified"}
            ),
            "max_parallel_platforms": self._manifest.get("defaults", {}).get(
                "max_parallel_platforms", 4
            ),
            "max_browser_workers": self._manifest.get("defaults", {}).get("max_browser_workers", 1),
        }

    def set_platform_enabled(self, platform_id: str, enabled: bool) -> dict[str, Any]:
        if not any(item["id"] == platform_id for item in self._manifest.get("platforms", [])):
            raise KeyError(platform_id)
        self._state.setdefault("platform_enabled", {})[platform_id] = enabled
        self._save_state()
        return self.get_platform(platform_id)

    def set_component_enabled(
        self, platform_id: str, component_id: str, enabled: bool
    ) -> dict[str, Any]:
        platform = next(
            (item for item in self._manifest.get("platforms", []) if item["id"] == platform_id),
            None,
        )
        if platform is None or not any(
            item["id"] == component_id for item in platform.get("components", [])
        ):
            raise KeyError(f"{platform_id}:{component_id}")
        self._state.setdefault("component_enabled", {})[f"{platform_id}:{component_id}"] = enabled
        self._save_state()
        return self.get_platform(platform_id)

    def get_platform(self, platform_id: str) -> dict[str, Any]:
        for platform in self.platform_views():
            if platform["id"] == platform_id:
                return platform
        raise KeyError(platform_id)

    def healthcheck(self, platform_id: str) -> dict[str, Any]:
        # The catalog endpoint must not pretend that a reference project or an
        # unverified adapter passed a live smoke test. Real adapters can replace
        # this hook with provider-specific checks without changing the admin API.
        return self.get_platform(platform_id)

    def plan(self, query: str) -> dict[str, Any]:
        platforms = self.platform_views()
        return {
            "query": query,
            "mode": "orchestrated",
            "max_parallel_platforms": self.summary()["max_parallel_platforms"],
            "max_browser_workers": self.summary()["max_browser_workers"],
            "platforms": [
                {
                    "id": platform["id"],
                    "name": platform["name"],
                    "enabled": platform["enabled"],
                    "components": [
                        {
                            "id": component["id"],
                            "name": component["name"],
                            "health": component["health"],
                            "kind": component["kind"],
                        }
                        for component in platform["components"]
                        if component["enabled"]
                    ],
                }
                for platform in platforms
                if platform["enabled"]
            ],
        }

    def _save_state(self) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        self.state_path.write_text(
            json.dumps(self._state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

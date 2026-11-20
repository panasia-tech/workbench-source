from __future__ import annotations

import json
import os
import sys
import time

import httpx

BASE_URL = os.getenv("SERVICE_URL", "http://127.0.0.1:8090")
QUERIES = ["sonos era300", "泰坦军团 27G6H", "ROG XG259CMS"]


def main() -> int:
    with httpx.Client(timeout=20) as client:
        for query in QUERIES:
            response = client.post(
                f"{BASE_URL}/v1/images/search", json={"query": query, "limit": 20}
            )
            response.raise_for_status()
            task_id = response.json()["task_id"]
            deadline = time.time() + 180
            while time.time() < deadline:
                result = client.get(f"{BASE_URL}/v1/images/tasks/{task_id}")
                result.raise_for_status()
                payload = result.json()
                if payload["status"] in {"completed", "failed"}:
                    print(
                        json.dumps(
                            {
                                "query": query,
                                "count": payload.get("count", 0),
                                "status": payload["status"],
                                "diagnostics": payload.get("diagnostics", {}),
                            },
                            ensure_ascii=False,
                            indent=2,
                        )
                    )
                    break
                time.sleep(1)
            else:
                print(f"TIMEOUT: {query}", file=sys.stderr)
                return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""给已经搜完的任务补上架用图质量分（app/quality.py），正式池按质量重排：干净的在前。

2026-11-10 起新任务搜完就会打分；这个脚本补老任务，不重搜、不改审核结论，员工的挪池决定按图片地址记，
重排不影响。员工从备选里挑进正式池的图（diagnostics 里的预览 + pool_decisions=formal）也一起评。
默认只打印不写库，加 --apply 才写。已经有分的跳过，--all 连有分的一起重评。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from app.config import get_settings
from app.db import Database
from app.quality import assess

RANK = {"good": 0, "ok": 1, "bad": 2}


def _file_for(storage: Path, url: str) -> Path | None:
    name = url.rsplit("/files/", 1)[-1].split("?", 1)[0]
    path = storage / name
    return path if name and path.is_file() else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=None)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--all", action="store_true")
    args = parser.parse_args()
    settings = get_settings()
    database = Database(args.database or settings.database_path)
    storage = settings.storage_dir

    rows = database._connection.execute(
        "SELECT task_id, query, brand, model, images_json, diagnostics_json, pool_decisions_json"
        " FROM tasks WHERE status='completed'"
    ).fetchall()
    tasks = graded = missing = 0
    for row in rows:
        images = json.loads(row["images_json"] or "[]")
        diagnostics = json.loads(row["diagnostics_json"] or "{}")
        decisions = json.loads(row["pool_decisions_json"] or "{}")
        promoted = [
            item
            for name in ("fuzzy_previews", "rejected_previews")
            for item in (diagnostics.get(name) or [])
            if isinstance(item, dict)
            and decisions.get(str(item.get("image_key") or item.get("url") or item.get("source_url") or "").strip())
            == "formal"
        ]
        todo = [img for img in images + promoted if args.all or not img.get("quality_grade")]
        if not todo:
            continue
        terms = tuple(t for t in (row["brand"], row["model"], *str(row["query"] or "").split()) if t)
        for img in todo:
            path = _file_for(storage, str(img.get("url") or ""))
            if path is None:
                missing += 1
                continue
            try:
                quality = assess(path.read_bytes(), identity_terms=terms)
            except Exception:
                missing += 1
                continue
            img.update(quality.as_dict())
            if "水印" in quality.flags:
                img["watermark"] = "detected"
            graded += 1
        images.sort(
            key=lambda img: (
                RANK.get(str(img.get("quality_grade") or ""), 1),
                -(float(img.get("quality_score") or 0) + float(img.get("score") or 0) * 0.2),
            )
        )
        tasks += 1
        good = sum(1 for img in images if img.get("quality_grade") == "good")
        print(f"{row['query']}: {len(images)} 张, good {good}")
        if args.apply:
            database.update_task(row["task_id"], images_json=images, diagnostics_json=diagnostics)
    print(f"任务 {tasks} 个, 评了 {graded} 张, 找不到文件 {missing} 张, {'已写库' if args.apply else '没写库(加 --apply)'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

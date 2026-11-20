"""生成执行端的代码热更新包：把业务 .py 打成带 md5 清单的静态目录。

产物落在 release/code/，目录结构就是服务器静态目录该有的样子：
    gc-ads-code-version.json    清单（端上只认这一个入口）
    gc_ads/*.py  main.py  manage.py

用法：
    .venv/bin/python scripts/publish_code.py --code-version 1 --version-name 0.1.0 \
        --notes "这版改了什么"
    rsync -rc --exclude='gc-ads-code-version.json' release/code/ erp-txy:/www/wwwroot/gc-app/gc-ads-code/
    rsync -c release/code/gc-ads-code-version.json erp-txy:/www/wwwroot/gc-app/gc-ads-code/

先传文件、最后传清单，不加 --delete：清单先到的话，端上照新清单去下还没到的文件；
--delete 会删掉正在下载旧版的端要的文件（2026-10-06 行情台热更新 404 就是这么来的）。

codeVersion 必须严格递增：端上只比它，versionName 只是给人看的。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STAGE = ROOT / "release" / "code"
MANIFEST = "gc-ads-code-version.json"

# 只发业务代码。重依赖（playwright / httpx）仍用包里内置的那份——既省流量，
# 也避免把运行时换坏：换错一个 .so 比不更新严重得多。
SOURCES = ["gc_ads", "main.py", "manage.py"]


def collect() -> list[tuple[str, Path]]:
    out: list[tuple[str, Path]] = []
    for item in SOURCES:
        p = ROOT / item
        if p.is_file():
            out.append((p.name, p))
        elif p.is_dir():
            for f in sorted(p.rglob("*.py")):
                if "__pycache__" in f.parts:
                    continue
                out.append((f.relative_to(ROOT).as_posix(), f))
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--code-version", type=int, required=True)
    ap.add_argument("--version-name", default="")
    ap.add_argument("--notes", default="")
    args = ap.parse_args()
    if args.code_version <= 0:
        raise SystemExit("codeVersion 必须是正整数")

    files = collect()
    if not files:
        raise SystemExit("没有可发布的文件")

    shutil.rmtree(STAGE, ignore_errors=True)
    STAGE.mkdir(parents=True, exist_ok=True)

    manifest_files: dict[str, str] = {}
    total = 0
    for rel, src in files:
        blob = src.read_bytes()
        manifest_files[rel] = hashlib.md5(blob).hexdigest()
        total += len(blob)
        target = STAGE / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob)

    manifest = {
        "product": "AdsPower 执行端 代码热更新",
        "versionName": args.version_name or f"v{args.code_version}",
        "codeVersion": args.code_version,
        "notes": args.notes,
        "files": manifest_files,
    }
    (STAGE / MANIFEST).write_text(json.dumps(manifest, ensure_ascii=False, indent=2),
                                  encoding="utf-8")
    print(f"代码包已生成：{STAGE}")
    print(f"  codeVersion {args.code_version} · {len(files)} 个文件 · {total/1024:.0f}KB")
    print("上传（先文件、后清单，不加 --delete）：")
    print(f"  rsync -rc --exclude='{MANIFEST}' {STAGE}/ erp-txy:/www/wwwroot/gc-app/gc-ads-code/")
    print(f"  rsync -c {STAGE}/{MANIFEST} erp-txy:/www/wwwroot/gc-app/gc-ads-code/")


if __name__ == "__main__":
    main()

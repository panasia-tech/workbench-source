"""打包前写内置代码版本：build-info/builtin-code-version.json，随包进 _internal/。

热更新只换比它新的（见 gc_ads/hot_code.builtin_version）；行情台也拿它判断工位上的包
是不是旧的、要不要更新。codeVersion 要和热更新通道（scripts/publish_code.py）用同一套编号，
打一个新包就同时把同一份代码按这个号发到热更新通道。

    python scripts/write_builtin_version.py --code-version 2 --version-name 0.2.0
"""
from __future__ import annotations

import argparse
import json
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--code-version", type=int, required=True)
    ap.add_argument("--version-name", required=True)
    args = ap.parse_args()
    if args.code_version <= 0:
        raise SystemExit("codeVersion 必须是正整数")
    out = ROOT / "build-info" / "builtin-code-version.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({"codeVersion": args.code_version, "versionName": args.version_name,
                               "builtAt": date.today().isoformat()}, ensure_ascii=False), encoding="utf-8")
    print(f"已写 {out}: codeVersion {args.code_version} / {args.version_name}")


if __name__ == "__main__":
    main()

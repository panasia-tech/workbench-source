"""启动时发现新代码就当场换上、交给新入口(同一进程),不用再「停了再启动两次」。

跑法：`.venv/bin/python scripts/test_code_handoff.py`，全过打印「全部通过」。

背景(2026-10-08):热更新原来只在跑起来以后才下载、下次启动才生效,发一版工位要重启两次
(第一次只是把新代码下下来)。走的是真的 hot_code.activate(插查找器、把旧模块请出 sys.modules),
新入口是临时目录里的一份 main.py,跑起来就写一个标记文件。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.chdir(ROOT)

import main as main_mod   # noqa: E402  (旧入口:本仓库里的 main.py)
from gc_ads import hot_code   # noqa: E402

NEW_MAIN = """
import os
async def main():
    open(os.environ["HANDOFF_MARK"], "w").write("new main ran")
"""


def write_new_code(root: Path, version: int) -> None:
    d = root / "code"
    (d / "gc_ads").mkdir(parents=True, exist_ok=True)
    files = {"gc_ads/__init__.py": "", "main.py": NEW_MAIN}
    manifest = {"codeVersion": version, "versionName": f"9.9.{version}", "files": {}}
    for rel, text in files.items():
        (d / rel).write_text(text, encoding="utf-8")
        manifest["files"][rel] = hashlib.md5(text.encode()).hexdigest()
    (d / hot_code.MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")


class Cfg:
    class executor:
        code_update_url = "https://example.invalid/gc-ads-code"


def run(coro):
    return asyncio.run(coro)


def main() -> None:
    saved_modules, saved_meta = dict(sys.modules), list(sys.meta_path)
    real_check, real_activate = hot_code.check_and_download, hot_code.activate
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        mark = root / "mark.txt"
        os.environ["HANDOFF_MARK"] = str(mark)
        main_mod.is_frozen = lambda: True
        main_mod.app_root = lambda: root
        checks = []

        # 1. 没有新版:照旧往下跑,不交接
        hot_code.check_and_download = lambda url, r, log=print: checks.append(url) or {"ok": True, "updated": False}
        assert run(main_mod._take_newer_code_now(Cfg())) is False and not mark.exists()
        print("1. 没有新版 -> 照旧启动 OK")

        # 2. 下了新版但启用不了(比如校验不过):照旧用当前版本
        hot_code.check_and_download = lambda url, r, log=print: {"ok": True, "updated": True}
        hot_code.activate = lambda r, log=print: {"active": False, "reason": "校验不符"}
        assert run(main_mod._take_newer_code_now(Cfg())) is False and not mark.exists()
        hot_code.activate = real_activate
        print("2. 新版启用不了 -> 用当前版本 OK")

        # 3. 有新版:下载 → 真的 activate → 本进程里跑新入口
        def fake_download(url, r, log=print):
            write_new_code(r, 99)
            return {"ok": True, "updated": True, "codeVersion": 99}
        hot_code.check_and_download = fake_download
        try:
            assert run(main_mod._take_newer_code_now(Cfg())) is True
            assert mark.read_text() == "new main ran", "新入口没跑"
            assert os.environ.get(main_mod._HANDOFF_ENV) == "1"
            # 新代码换上时留了「待确认」标记:新入口真跑起来会自己撤(mark_boot_ok);
            # 要是没跑起来,下次启动 activate 见到它就隔离新代码、退回旧版
            assert hot_code._boot_pending(root).exists()
            print("3. 有新版 -> 同一进程换上新代码跑新入口 OK")

            # 4. 交接后的新入口不再查(防套娃)
            checks.clear()
            hot_code.check_and_download = lambda url, r, log=print: checks.append(url) or {"ok": True, "updated": True}
            assert run(main_mod._take_newer_code_now(Cfg())) is False and checks == []
            print("4. 交接过的不再查 OK")
        finally:
            hot_code.check_and_download, hot_code.activate = real_check, real_activate
            os.environ.pop(main_mod._HANDOFF_ENV, None)
            sys.meta_path[:] = saved_meta
            sys.modules.clear()
            sys.modules.update(saved_modules)

    # 5. 开发态(非打包)绝不换:跑的必须是工作区源码
    main_mod.is_frozen = lambda: False
    hot_code.check_and_download = lambda *a, **k: (_ for _ in ()).throw(AssertionError("开发态不该查"))
    try:
        assert run(main_mod._take_newer_code_now(Cfg())) is False
    finally:
        hot_code.check_and_download = real_check
    print("5. 开发态不查不换 OK")
    print("全部通过")


main()

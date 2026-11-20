"""执行端代码热更新：加载顺序、三条安全线、坏版本自动回退。

这套机制要下载并**执行**代码，所以安全线比功能更值得钉：
  1. 清单里的路径必须落在 code/ 里 —— `../` 一类一律拒绝，否则一份被改过的清单
     就能往任意位置写文件；
  2. 每个文件逐个校验 md5，对不上就整体不换（不是"能下几个是几个"）；
  3. 起不来自动回退：加载成功却没跑起来是最阴的一类坏版本（不报错、就是不干活），
     靠 boot-pending 标记识别，下次启动隔离它并退回内置版本。

另外钉死「下载不改动正在跑的那份」：先下到 code.next/，全对了再原子换上。

跑法：.venv/bin/python scripts/test_hot_code.py
"""
import hashlib
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gc_ads import hot_code  # noqa: E402


def _make_code(root: Path, version: int = 2, body: str = "VALUE = 'hot'\n") -> dict:
    d = root / "code"
    (d / "gc_ads").mkdir(parents=True, exist_ok=True)
    files = {"gc_ads/__init__.py": "", "gc_ads/marker.py": body, "main.py": "def main():\n    pass\n"}
    manifest = {"codeVersion": version, "versionName": f"v{version}", "files": {}}
    for rel, text in files.items():
        f = d / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text, encoding="utf-8")
        manifest["files"][rel] = hashlib.md5(text.encode()).hexdigest()
    (d / hot_code.MANIFEST_NAME).write_text(json.dumps(manifest), encoding="utf-8")
    return manifest


def main() -> None:
    # --- 1. 路径安全线 --------------------------------------------------------
    for bad in ("../evil.py", "/etc/passwd", "C:/x.py", "a/../../b.py",
                "..\\win.py", "x.exe", "", "   "):
        assert hot_code.safe_rel_path(bad) is None, f"不安全路径被放行了: {bad!r}"
    for good in ("gc_ads/logs.py", "main.py", "gc_ads/sub/x.py"):
        assert hot_code.safe_rel_path(good) == good

    with tempfile.TemporaryDirectory() as d:
        root = Path(d)

        # --- 2. 完好的包能通过校验 -------------------------------------------
        _make_code(root)
        ok, detail = hot_code.verify_dir(root)
        assert ok, detail
        assert hot_code.local_version(root)["codeVersion"] == 2

        # --- 3. 文件被改过 → 整体不认 -----------------------------------------
        (root / "code" / "gc_ads" / "marker.py").write_text("VALUE = 'tampered'\n", encoding="utf-8")
        ok, detail = hot_code.verify_dir(root)
        assert not ok and "校验不符" in detail, detail

        # 缺文件同理
        _make_code(root)
        (root / "code" / "main.py").unlink()
        ok, detail = hot_code.verify_dir(root)
        assert not ok and "缺文件" in detail, detail

        # 清单里夹带不安全路径 → 拒绝
        _make_code(root)
        mf = root / "code" / hot_code.MANIFEST_NAME
        data = json.loads(mf.read_text(encoding="utf-8"))
        data["files"]["../escape.py"] = "0" * 32
        mf.write_text(json.dumps(data), encoding="utf-8")
        ok, detail = hot_code.verify_dir(root)
        assert not ok and "不安全" in detail, detail

    # --- 4. 启用 / 回退 -------------------------------------------------------
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        _make_code(root)

        res = hot_code.activate(root, log=lambda *_: None)
        assert res["active"] is True, res
        assert (root / "code" / ".boot-pending").exists(), "启用时要先立 boot-pending"
        # 真能从 code/ 里加载到
        import importlib
        mod = importlib.import_module("gc_ads.marker")
        assert mod.VALUE == "hot", "meta_path 查找器没生效——多半又退回包里那份了"
        # 启用了热更新 → 「在跑的版本」是热更新那份；落盘的标记带本进程 pid
        assert hot_code.running_version(root)["codeVersion"] == 2
        hot_code.write_running_marker(root, "k1test")
        import os as _os
        marker = json.loads(hot_code.running_marker(root, "k1test").read_text(encoding="utf-8"))
        assert marker["pid"] == _os.getpid() and marker["codeVersion"] == 2, marker
        del sys.modules["gc_ads.marker"]
        sys.meta_path = [f for f in sys.meta_path if not isinstance(f, hot_code._HotFinder)]
        # 查找器撤了 = 跑的是内置那份，哪怕磁盘上 code/ 更新（下好了没重启）
        assert hot_code.running_version(root)["codeVersion"] == 0
        assert hot_code.local_version(root)["codeVersion"] == 2
        # 跑起来了 → 标记撤掉
        hot_code.mark_boot_ok(root)
        assert not (root / "code" / ".boot-pending").exists()

        # --- 5. 上一版起不来 → 隔离并回退 ---------------------------------------
        # 刚写的标记 = 同目录另一个执行端正在启动，不能隔离（2026-11-01 工位全部退回内置版本）
        pending = root / "code" / ".boot-pending"
        pending.write_text("1", encoding="utf-8")
        assert hot_code.activate(root, log=lambda *_: None)["active"] is True
        sys.meta_path = [f for f in sys.meta_path if not isinstance(f, hot_code._HotFinder)]
        for name in [n for n in sys.modules if n.split(".")[0] in hot_code.HOT_MODULES and n != "gc_ads.hot_code"]:
            del sys.modules[name]
        old = time.time() - hot_code._BOOT_GRACE_SEC - 1
        os.utime(pending, (old, old))
        res = hot_code.activate(root, log=lambda *_: None)
        assert res["active"] is False and "起不来" in res["reason"], res
        assert (root / "code.bad").exists(), "坏版本要留在 code.bad 里可供排查，而不是直接删"
        assert not (root / "code").exists()

        # 回退之后再启用：没有 code/ 就老老实实用内置
        assert hot_code.activate(root, log=lambda *_: None)["active"] is False

    # --- 6. 下载：全对才换，坏一个就整体不动 ----------------------------------
    with tempfile.TemporaryDirectory() as d:
        root = Path(d)
        _make_code(root, version=1, body="VALUE = 'old'\n")

        served = {"gc_ads/__init__.py": b"", "main.py": b"def main():\n    pass\n"}
        manifest = {"codeVersion": 9, "versionName": "v9",
                    "files": {k: hashlib.md5(v).hexdigest() for k, v in served.items()}}

        class _Resp:
            def __init__(self, blob): self.blob = blob
            def read(self, *_a): return self.blob
            def __enter__(self): return self
            def __exit__(self, *_a): return False

        def fake_open(url, timeout=0, context=None):
            rel = url.rsplit("/gc-ads-code/", 1)[-1]
            return _Resp(served[rel])

        hot_code._urlopen = lambda url, timeout: fake_open(url, timeout)
        hot_code.download("http://x/gc-ads-code", root, manifest, log=lambda *_: None)
        assert hot_code.local_version(root)["codeVersion"] == 9
        assert (root / "code.prev").exists(), "换上新版前要把旧版留一份"

        # md5 对不上 → 抛错，且**不动**已经在跑的那份
        bad_manifest = {"codeVersion": 10, "files": {"main.py": "0" * 32}}
        try:
            hot_code.download("http://x/gc-ads-code", root, bad_manifest, log=lambda *_: None)
        except ValueError as exc:
            assert "校验不符" in str(exc), exc
        else:
            raise AssertionError("md5 对不上竟然换上去了")
        assert hot_code.local_version(root)["codeVersion"] == 9, "失败的下载不该动现有版本"

    # --- 7. 内置版本：热更新只换比包里新的 -----------------------------------
    # 2026-10-06：线上热更新还是 09-14 的 v1，新包内置的是 10-06 的代码。内置版本按 0 算的话，
    # 新装的包第一拍就会把 v1 下下来、下次启动换上——等于降级。
    with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as meipass:
        root = Path(d)
        (Path(meipass) / hot_code.BUILTIN_VERSION_NAME).write_text(
            json.dumps({"codeVersion": 2, "versionName": "0.2.0"}), encoding="utf-8")
        sys._MEIPASS = meipass
        try:
            assert hot_code.builtin_version()["codeVersion"] == 2
            assert hot_code.local_version(root)["codeVersion"] == 2, "没有 code/ 时就是内置版本"

            # 老目录里躺着上一代热更新 v1：不启用，也不立 boot-pending
            _make_code(root, version=1)
            res = hot_code.activate(root, log=lambda *_: None)
            assert res["active"] is False and "不比内置" in res["reason"], res
            assert not (root / "code" / ".boot-pending").exists()
            assert hot_code.local_version(root)["codeVersion"] == 2

            # 线上还是 v1（或同为 v2）：不下载
            fetched = []
            hot_code.fetch_manifest = lambda base, timeout=20: {"codeVersion": 1}
            hot_code.download = lambda *a, **k: fetched.append(a) or {"ok": True}
            assert hot_code.check_and_download("http://x", root, log=lambda *_: None)["updated"] is False
            hot_code.fetch_manifest = lambda base, timeout=20: {"codeVersion": 2}
            assert hot_code.check_and_download("http://x", root, log=lambda *_: None)["updated"] is False
            assert not fetched, "不比内置新的热更新不该下载"

            # 线上出了 v3：照常下载；code/ 是 v3 时照常启用
            hot_code.fetch_manifest = lambda base, timeout=20: {"codeVersion": 3}
            assert hot_code.check_and_download("http://x", root, log=lambda *_: None)["updated"] is True
            shutil.rmtree(root / "code")
            _make_code(root, version=3)
            res = hot_code.activate(root, log=lambda *_: None)
            assert res["active"] is True and res["codeVersion"] == 3, res
            sys.meta_path = [f for f in sys.meta_path if not isinstance(f, hot_code._HotFinder)]
            for name in [n for n in sys.modules if n.split(".")[0] in hot_code.HOT_MODULES and n != "gc_ads.hot_code"]:
                del sys.modules[name]
        finally:
            del sys._MEIPASS

    # --- code/ 版本是新的、文件却不全：要重下，不能因为版本号一样就算最新 ---------
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        manifest = _make_code(root, version=10)
        (root / "code" / "main.py").unlink()
        calls = []
        real_fetch, real_download = hot_code.fetch_manifest, hot_code.download
        hot_code.fetch_manifest = lambda *_a, **_k: manifest
        hot_code.download = lambda *_a, **_k: calls.append(1) or {"ok": True}
        try:
            assert hot_code.check_and_download("http://x", root, log=lambda *_: None)["updated"] is True
            assert calls == [1] and not (root / "code.lock").exists()
            # 另一个进程拿着锁：这次不下，也不算失败
            (root / "code.lock").write_text("", encoding="utf-8")
            res = hot_code.check_and_download("http://x", root, log=lambda *_: None)
            assert res["updated"] is False and calls == [1], res
        finally:
            hot_code.fetch_manifest, hot_code.download = real_fetch, real_download

    print("test_hot_code: PASS")


if __name__ == "__main__":
    main()

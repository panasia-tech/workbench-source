"""代码热更新：让打包后的 exe 也能只换几十 KB 的 .py，而不是重打 48MB 的包。

# 为什么需要

执行端是 PyInstaller 打的 onedir 包，业务代码（gc_ads / main / manage）被编进
exe 里的 PYZ。改一行就得在 Windows 上重打一次包、再让每台工位重下 48MB——
于是「消息门铃写好了，但工位上跑的还是两周前的代码」。

桌面端早就有这套（loader.js + code-version.json），这里是它的 Python 版。

# 怎么做的

exe 里的入口（gcads.py）永远不变，它做两件事：
  1. 若 `<exe 旁边>/code/` 里有一份通过校验的新代码，就把一个**查找器插到
     sys.meta_path 最前面**，让 gc_ads/main/manage 从那里加载；
  2. 否则老老实实用包里内置的那份。

为什么必须是 meta_path 而不是改 sys.path：PyInstaller 的 FrozenImporter 排在
sys.path 之前，光把目录塞进 sys.path，`import gc_ads` 仍然会命中包里那份。

# 三条安全线（下载执行代码这件事，值得多写几行）

- **只认清单里的文件，且逐个校验 md5**。清单本身从 HTTPS 取。
- **路径必须落在 code/ 里**。清单里出现 `../` 一类的相对路径一律拒绝，
  否则一个被改过的清单就能往任意位置写文件。
- **起不来就退回内置版本**。启动时先放一个 boot-pending 标记，跑起来后删掉；
  下次启动若标记还在，说明上一版热更新代码加载成功却没能跑起来——那是最阴的一类
  坏版本（不报错、就是不干活），直接隔离它并回退。
"""
from __future__ import annotations

import hashlib
import importlib.abc
import importlib.machinery
import importlib.util
import json
import os
import shutil
import sys
import time
import ssl
import urllib.request
from pathlib import Path


def _ssl_context() -> ssl.SSLContext:
    """显式用 certifi 的根证书。

    macOS/Windows 的 Python 往往没接系统根证书（mac python.org 包没跑
    Install Certificates.command 时 ssl 默认上下文凭证直接是空的），打包后的
    frozen 环境更是如此。热更新是走 HTTPS 下**代码**，证书校验绝不能因为
    "验不了就算了"而绕过——所以带上自己的根证书，而不是关掉校验。
    与 mqtt_client.py 里那段是同一个教训。
    """
    import certifi

    return ssl.create_default_context(cafile=certifi.where())


def _urlopen(url: str, timeout: int):
    return urllib.request.urlopen(url, timeout=timeout, context=_ssl_context())

# 热更新只接管这几个顶层模块——业务代码全在这里，其余（playwright、httpx 等重依赖）
# 仍用包里内置的，既省流量也避免把运行时换坏。
HOT_MODULES = ("gc_ads", "main", "manage", "gcads")

MANIFEST_NAME = "gc-ads-code-version.json"
_MAX_FILE_BYTES = 4 * 1024 * 1024      # 单个 .py 的上限：业务代码没有这么大的
_MAX_FILES = 200


def code_dir(root: Path) -> Path:
    return root / "code"


def _boot_pending(root: Path) -> Path:
    return root / "code" / ".boot-pending"


# 标记比这新 = 同一目录下另一个执行端正在启动，不算「上一版起不来」
_BOOT_GRACE_SEC = 120
# 下载锁比这旧 = 上次下到一半进程没了，可以接手
_LOCK_STALE_SEC = 600


BUILTIN_VERSION_NAME = "builtin-code-version.json"


def builtin_version() -> dict:
    """包里内置那份代码的版本：打包时由 build 脚本写进 _internal/（PyInstaller 的 _MEIPASS）。

    热更新只换比它新的。没有这一条，新装的包会把线上「比自己旧」的热更新下下来换上——
    2026-10-06 重打包时发现：线上热更新还是 09-14 的 v1，包里内置的已是 10-06 的代码，
    可内置版本当时一律按 0 算，装上第一拍就会被降级。
    开发态、老包（没有这个文件）都按 0 算，与以前一样。
    """
    base = getattr(sys, "_MEIPASS", None)
    if base:
        try:
            data = json.loads((Path(base) / BUILTIN_VERSION_NAME).read_text(encoding="utf-8"))
            return {"codeVersion": int(data.get("codeVersion") or 0),
                    "versionName": str(data.get("versionName") or "(内置)")}
        except Exception:
            pass
    return {"codeVersion": 0, "versionName": "(内置)"}


def hot_version(root: Path) -> dict:
    """code/ 里那份热更新代码的版本。没有就是 0。"""
    f = code_dir(root) / MANIFEST_NAME
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
        return {"codeVersion": int(data.get("codeVersion") or 0),
                "versionName": str(data.get("versionName") or "")}
    except Exception:
        return {"codeVersion": 0, "versionName": ""}


def local_version(root: Path) -> dict:
    """这台机器上最新的一份代码：热更新那份和内置那份，取版本号大的。"""
    hot, base = hot_version(root), builtin_version()
    return hot if hot["codeVersion"] > base["codeVersion"] else base


def safe_rel_path(name: str) -> str | None:
    """清单里的相对路径是否安全。不安全返回 None。

    绝对路径、`..`、盘符、反斜杠一律拒绝——清单是从网上取的，被改过一次就能
    往任意位置写文件。这条是整个机制里最不能省的一行。
    """
    rel = str(name or "").strip().replace("\\", "/")
    if not rel or rel.startswith("/") or ":" in rel:
        return None
    parts = [p for p in rel.split("/") if p]
    if any(p in ("..", ".") for p in parts):
        return None
    if not parts or not parts[-1].endswith((".py", ".json", ".yaml", ".txt")):
        return None
    return "/".join(parts)


def verify_dir(root: Path) -> tuple[bool, str]:
    """校验 code/ 里那份代码是否完整（清单在、文件全、md5 对得上）。"""
    d = code_dir(root)
    manifest = d / MANIFEST_NAME
    if not manifest.exists():
        return False, "没有热更新代码"
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
        files = data.get("files") or {}
        if not isinstance(files, dict) or not files:
            return False, "清单里没有文件"
        for rel, want in files.items():
            safe = safe_rel_path(rel)
            if safe is None:
                return False, f"清单里有不安全的路径: {rel}"
            f = d / safe
            if not f.exists():
                return False, f"缺文件 {safe}"
            if hashlib.md5(f.read_bytes()).hexdigest() != want:
                return False, f"{safe} 校验不符"
        return True, f"codeVersion={data.get('codeVersion')}"
    except Exception as exc:
        return False, f"清单读不了: {exc}"


class _HotFinder(importlib.abc.MetaPathFinder):
    """把 HOT_MODULES 解析到 code/ 目录。插在 sys.meta_path[0]，压过 FrozenImporter。"""

    def __init__(self, directory: Path):
        self.directory = str(directory)
        self._path_finder = importlib.machinery.PathFinder()

    def find_spec(self, fullname, path=None, target=None):
        top = fullname.split(".")[0]
        if top not in HOT_MODULES:
            return None
        if fullname == top:
            return self._path_finder.find_spec(fullname, [self.directory], target)
        return None      # 子模块交给包自己的 __path__（它已经指向 code/ 了）


def activate(root: Path, log=print) -> dict:
    """若 code/ 里有一份可用的新代码就启用它，返回启用结果。

    启用前先放 boot-pending 标记；调方跑起来之后要调 mark_boot_ok() 把它删掉。
    标记还在 = 上一版加载成功却没跑起来，这里直接隔离并回退。
    """
    d = code_dir(root)
    if not d.exists():
        return {"active": False, "reason": "没有热更新代码"}

    hot, base = hot_version(root), builtin_version()
    if hot["codeVersion"] <= base["codeVersion"]:
        # 不比内置的新就不用：多半是新包装在了老目录上，code/ 里还躺着上一代的热更新
        return {"active": False,
                "reason": f"热更新代码 v{hot['codeVersion']} 不比内置 v{base['codeVersion']} 新"}

    pending = _boot_pending(root)
    if pending.exists() and time.time() - pending.stat().st_mtime >= _BOOT_GRACE_SEC:
        bad = root / "code.bad"
        shutil.rmtree(bad, ignore_errors=True)
        try:
            d.rename(bad)
        except OSError:
            shutil.rmtree(d, ignore_errors=True)
        log("⚠️ 上一版热更新代码起不来，已隔离到 code.bad/，本次用内置版本")
        return {"active": False, "reason": "上一版起不来，已回退"}

    ok, detail = verify_dir(root)
    if not ok:
        log(f"⚠️ 热更新代码校验不通过（{detail}），本次用内置版本")
        return {"active": False, "reason": detail}

    if not pending.exists():
        pending.write_text("1", encoding="utf-8")
    sys.meta_path.insert(0, _HotFinder(d))

    # 把已经 import 进来的那批从 sys.modules 里请出去。
    #
    # 关键一步：入口本身是 `from gc_ads import hot_code` 起的，**包里内置的 gc_ads
    # 这时已经在 sys.modules 里了**——不清掉的话，后面 import gc_ads.logs 会顺着
    # 它那个 __path__ 走，热更新那份永远顶不上去（加载器看起来生效了，实际一行新
    # 代码都没跑）。本模块自身靠调用方手上的引用活着，删掉条目不影响它继续执行。
    for name in list(sys.modules):
        if name.split(".")[0] in HOT_MODULES:
            del sys.modules[name]
    log(f"已启用热更新代码 {hot['versionName']}（codeVersion {hot['codeVersion']}）")
    return {"active": True, **hot}


def mark_boot_ok(root: Path) -> None:
    """跑起来了：把 boot-pending 删掉。没有这一步，下次启动会把好代码当坏的隔离。"""
    try:
        _boot_pending(root).unlink()
    except OSError:
        pass


def running_version(root: Path) -> dict:
    """这个进程**实际在跑**的那份代码（不是磁盘上最新的那份）。

    磁盘上的 code/ 会被跑着的进程悄悄下载更新，但进程不换代码——只看 local_version
    会把「下好了还没重启」当成「已经是新版」（2026-10-14：工位 10-10 就下好了 v6，
    两个执行端还在跑 0.2.1）。查找器在 meta_path 里 = 启用了热更新代码。
    按类名认而不是 isinstance：启动时换代码交接后，本模块是重新 import 的另一份，
    插查找器的是旧的那份。
    """
    if any(type(f).__name__ == "_HotFinder" for f in sys.meta_path):
        return hot_version(root)
    return builtin_version()


def running_marker(root: Path, user_id: str) -> Path:
    return root / "run" / f"executor_{user_id}.version.json"


def write_running_marker(root: Path, user_id: str) -> None:
    """启动时把「本进程跑的是哪一版」落盘，行情台据此判断要不要显示更新按钮。

    带 pid：进程换了这份就作废，行情台对不上 pid 就不认。写不成只是少一行显示，不挡启动。
    """
    try:
        f = running_marker(root, user_id)
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps({"pid": os.getpid(), **running_version(root)},
                                ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 下载
# ---------------------------------------------------------------------------

def fetch_manifest(base_url: str, timeout: int = 20) -> dict:
    url = f"{str(base_url).rstrip('/')}/{MANIFEST_NAME}"
    with _urlopen(url, timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def download(base_url: str, root: Path, manifest: dict, log=print) -> dict:
    """把清单里的文件下到 code.next/，逐个校验 md5，全对了再原子换上。

    下到临时目录再换，是为了避免「下了一半就被当成新版本加载」——那会比不更新更糟。
    """
    files = manifest.get("files") or {}
    if not isinstance(files, dict) or not files:
        raise ValueError("清单里没有文件")
    if len(files) > _MAX_FILES:
        raise ValueError(f"清单里有 {len(files)} 个文件，超过上限 {_MAX_FILES}")

    # 每个进程一个暂存目录：多个执行端共用这个根目录，共用暂存目录会互相清掉对方下好的
    # 文件，拼出一份清单是新的、文件却不全的 code/（2026-11-01 工位全部退回内置版本）。
    staging = root / f"code.next.{os.getpid()}"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)

    base = str(base_url).rstrip("/")
    for rel, want in files.items():
        safe = safe_rel_path(rel)
        if safe is None:
            raise ValueError(f"清单里有不安全的路径: {rel}")
        with _urlopen(f"{base}/{safe}", 60) as resp:
            blob = resp.read(_MAX_FILE_BYTES + 1)
        if len(blob) > _MAX_FILE_BYTES:
            raise ValueError(f"{safe} 超过单文件上限")
        got = hashlib.md5(blob).hexdigest()
        if got != want:
            raise ValueError(f"{safe} 校验不符（想要 {want[:8]}… 实得 {got[:8]}…）")
        target = staging / safe
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob)

    (staging / MANIFEST_NAME).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    # 原子换上：先把旧的挪走，再把新的顶上，失败还能把旧的放回来
    current = code_dir(root)
    backup = root / "code.prev"
    shutil.rmtree(backup, ignore_errors=True)
    if current.exists():
        current.rename(backup)
    try:
        staging.rename(current)
    except OSError:
        if backup.exists():
            backup.rename(current)
        shutil.rmtree(staging, ignore_errors=True)
        raise
    log(f"热更新代码已就位：codeVersion {manifest.get('codeVersion')}"
        f"（{len(files)} 个文件），下次启动生效")
    return {"ok": True, "files": len(files), "codeVersion": manifest.get("codeVersion")}


def _take_lock(root: Path) -> Path | None:
    """同一目录同时只让一个进程下载（桌面端 executor-code.js 认同一把锁）。拿不到返回 None。"""
    lock = root / "code.lock"
    try:
        if time.time() - lock.stat().st_mtime >= _LOCK_STALE_SEC:
            lock.unlink()
    except OSError:
        pass
    try:
        os.close(os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
    except OSError:
        return None
    return lock


def check_and_download(base_url: str, root: Path, log=print) -> dict:
    """比版本号，新的就下；code/ 不完整也重下。**只在下次启动生效**——正在跑的进程绝不换代码。"""
    if not base_url:
        return {"ok": False, "reason": "未配置代码更新地址"}
    try:
        manifest = fetch_manifest(base_url)
    except Exception as exc:
        return {"ok": False, "reason": f"取清单失败: {exc}"}
    remote = int(manifest.get("codeVersion") or 0)
    current = local_version(root)["codeVersion"]
    # 只比版本号的话，坏掉的 code/ 永远修不好：清单说已是最新，启用时校验又不过
    broken = hot_version(root)["codeVersion"] > builtin_version()["codeVersion"] and not verify_dir(root)[0]
    if remote <= current and not broken:
        return {"ok": True, "updated": False, "codeVersion": current}
    lock = _take_lock(root)
    if lock is None:
        return {"ok": True, "updated": False, "codeVersion": current, "reason": "另一个进程正在下载"}
    try:
        result = download(base_url, root, manifest, log=log)
    except Exception as exc:
        log(f"⚠️ 热更新下载失败，继续用当前版本: {exc}")
        return {"ok": False, "reason": str(exc)}
    finally:
        lock.unlink(missing_ok=True)
    return {"ok": True, "updated": True, **result}

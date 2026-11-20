"""本地日志：按天切分、保留 30 天，并能按服务端的要求打包回传。

# 为什么要有这个文件

从前执行端的日志是 supervisor 把子进程 stdout 重定向到一个文件——**只增不删**，
跑几个月就是一个几百 MB 的大文件，出事时既不好翻也不好传。而真要排障的时候，
人往往不在那台机器旁边。

所以两件事一起做：
  1. 自己写日志，按天切分，只留最近 30 天（更久的没人会看，只会占盘）；
  2. 能把最近 N 天打成一个 zip 交出去——由服务端下待办，端上心跳时认领。

# 一条纪律：日志里不许有凭据

执行端手上有 enroll_secret、设备 token、AdsPower 的代理账号密码。日志是要离开
这台机器的，所以打包时统一过一遍打码——宁可日志难看一点，也不能把登录态送出去。
"""
from __future__ import annotations

import io
import logging
import os
import logging.handlers
import re
import time
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

from .paths import app_root

KEEP_DAYS = 30

# 会出现在日志里的凭据。打包前一律替换——这份名单宁可宽一点。
_SECRET_PAT = re.compile(
    r"((?:token|secret|password|passwd|pwd|sid|_m_h5_tk|authorization|bearer|api[_-]?key)"
    r"[\"'=:\s]+)([A-Za-z0-9_\-%.+/]{6,})",
    re.I)


def redact(text: str) -> str:
    """把 token/密码一类的值换成 <redacted:N>。长度留着，排障时还能看出"有没有配"。"""
    if not text:
        return text
    return _SECRET_PAT.sub(lambda m: f"{m.group(1)}<redacted:{len(m.group(2))}>", str(text))


def log_dir() -> Path:
    """日志目录。可用 GC_ADS_LOG_DIR 覆盖——回归要能隔离到临时目录，
    否则测试会去动这台机器上真实的日志（与 GC_ADS_PURPOSES_FILE 同一个路子）。"""
    override = os.environ.get("GC_ADS_LOG_DIR")
    d = Path(override) if override else app_root() / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def setup_logging(name: str, level: int = logging.INFO) -> Path:
    """把根 logger 接到「按天切分 + 保留 30 天」的文件上，同时保留控制台输出。

    返回日志文件路径。重复调用是幂等的（同名 handler 只挂一次），因为 manage.py 的
    子命令可能在同一进程里多次初始化。
    """
    path = log_dir() / f"{name}.log"
    root = logging.getLogger()
    root.setLevel(level)

    tag = f"gc-file:{path}"
    for h in root.handlers:
        if getattr(h, "_gc_tag", None) == tag:
            return path

    handler = logging.handlers.TimedRotatingFileHandler(
        path, when="midnight", backupCount=KEEP_DAYS, encoding="utf-8", utc=False)
    handler.suffix = "%Y-%m-%d"
    handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s: %(message)s"))
    handler._gc_tag = tag
    root.addHandler(handler)

    if not any(isinstance(h, logging.StreamHandler) and not hasattr(h, "_gc_tag")
               for h in root.handlers):
        stream = logging.StreamHandler()
        stream.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)s %(name)s: %(message)s"))
        root.addHandler(stream)

    prune_old_logs()
    return path


def prune_old_logs(keep_days: int = KEEP_DAYS) -> list[str]:
    """删掉超过保留期的日志文件。

    TimedRotatingFileHandler 的 backupCount 只管**它自己**切出来的那一串；机器上还有
    上一版留下的、别的进程写的、以及手工拷进来的文件，一并按 mtime 清。返回删掉的文件名。
    """
    cutoff = time.time() - keep_days * 86400
    removed = []
    for f in log_dir().glob("*.log*"):
        try:
            if f.is_file() and f.stat().st_mtime < cutoff:
                f.unlink()
                removed.append(f.name)
        except OSError:
            continue     # 正被写/被占用：下轮再说，清日志不值得报错
    return removed


def collect_logs(days: int = 7, extra_files: list[Path] | None = None) -> bytes:
    """把最近 days 天的日志打成 zip（内存里，不落临时文件）。

    - 只收 logs/ 下的文本日志，按 mtime 过滤；
    - **逐行打码**后再写进包（见文件头那条纪律）；
    - 单个文件超过 8MB 时只取尾部——排障要的是最近发生了什么，不是开头。
    """
    cutoff = time.time() - max(1, days) * 86400
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(log_dir().glob("*.log*")):
            try:
                if not f.is_file() or f.stat().st_mtime < cutoff:
                    continue
                raw = f.read_bytes()
                if len(raw) > 8 * 1024 * 1024:
                    raw = b"...(truncated, tail only)...\n" + raw[-8 * 1024 * 1024:]
                z.writestr(f.name, redact(raw.decode("utf-8", "replace")))
            except OSError:
                continue
        for extra in extra_files or []:
            try:
                if extra.is_file():
                    z.writestr(f"extra/{extra.name}",
                               redact(extra.read_text(encoding="utf-8", errors="replace")))
            except OSError:
                continue
        z.writestr("collected_at.txt",
                   f"{datetime.now().isoformat()}\ndays={days}\nkeep_days={KEEP_DAYS}\n")
    return buf.getvalue()


def summarize() -> dict:
    """日志盘点：几个文件、占多大、最早一条是什么时候。运维体检用。"""
    files = [f for f in log_dir().glob("*.log*") if f.is_file()]
    if not files:
        return {"files": 0, "bytes": 0, "oldest": None}
    oldest = min(f.stat().st_mtime for f in files)
    return {
        "files": len(files),
        "bytes": sum(f.stat().st_size for f in files),
        "oldest": datetime.fromtimestamp(oldest).strftime("%Y-%m-%d %H:%M"),
        "keep_days": KEEP_DAYS,
        "cutoff": (datetime.now() - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d"),
    }

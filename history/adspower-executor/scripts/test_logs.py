"""本地日志：按天切分、保留 30 天、打包前打码。

三条要害：
  1. **打码**——日志是要离开这台机器的，而执行端手上有 enroll_secret、设备 token、
     AdsPower 代理密码。宁可日志难看，也不能把登录态送出去；
  2. **保留期**——只留 30 天。从前是 supervisor 把 stdout 重定向到一个只增不删的
     文件，跑几个月就是一个没人敢打开的大文件；
  3. **超大文件只取尾部**——排障要的是最近发生了什么，不是开头。

跑法：.venv/bin/python scripts/test_logs.py
"""
import io
import os
import sys
import tempfile
import time
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

tmp = tempfile.mkdtemp(prefix="gc-ads-logs-test-")
os.environ["GC_ADS_LOG_DIR"] = tmp

from gc_ads import logs  # noqa: E402


def main() -> None:
    d = Path(tmp)

    # --- 1. 打码 --------------------------------------------------------------
    (d / "executor_a.log").write_text(
        "connected token=abcdefghij\nproxy password: s3cret-value\n_m_h5_tk=zzzzzzzzzz",
        encoding="utf-8")
    z = zipfile.ZipFile(io.BytesIO(logs.collect_logs(7)))
    text = z.read("executor_a.log").decode()
    for secret in ("abcdefghij", "s3cret-value", "zzzzzzzzzz"):
        assert secret not in text, f"明文凭据 {secret} 混进日志包了"
    assert "<redacted:" in text, "打码要留长度，排障时还能看出「有没有配」"
    assert "collected_at.txt" in z.namelist(), "包里要写清是什么时候、取了几天"

    # --- 2. 保留期 ------------------------------------------------------------
    old = d / "executor_old.log"
    old.write_text("ancient", encoding="utf-8")
    long_ago = time.time() - 40 * 86400
    os.utime(old, (long_ago, long_ago))

    removed = logs.prune_old_logs()
    assert removed == ["executor_old.log"], f"应只删过期的，实际 {removed}"
    assert (d / "executor_a.log").exists(), "今天的日志被误删了"

    # 过期文件也不该混进包
    assert "executor_old.log" not in zipfile.ZipFile(io.BytesIO(logs.collect_logs(1))).namelist()

    # --- 3. 超大文件只取尾部 ---------------------------------------------------
    big = d / "executor_big.log"
    big.write_text("A" * (9 * 1024 * 1024) + "TAIL-MARKER", encoding="utf-8")
    packed = zipfile.ZipFile(io.BytesIO(logs.collect_logs(7))).read("executor_big.log").decode()
    assert "TAIL-MARKER" in packed, "截断要保尾部——排障看的是最近发生了什么"
    assert "truncated" in packed, "截断了要说一声，别让人以为日志本来就这么短"
    assert len(packed) < 9 * 1024 * 1024

    # --- 4. setup_logging 幂等，且真的写文件 -----------------------------------
    import logging
    path = logs.setup_logging("unit_test")
    again = logs.setup_logging("unit_test")
    assert path == again
    handlers = [h for h in logging.getLogger().handlers
                if getattr(h, "_gc_tag", "").endswith("unit_test.log")]
    assert len(handlers) == 1, f"重复初始化挂了 {len(handlers)} 个 handler"
    logging.getLogger("gc.test").info("hello from test")
    handlers[0].flush()
    assert "hello from test" in path.read_text(encoding="utf-8")

    print("test_logs: PASS")


if __name__ == "__main__":
    main()

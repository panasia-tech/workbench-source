"""用途登记表的增删改查（纯离线，不碰真 AdsPower、不起 HTTP 服务）。

用途登记表就是「谁驱动哪批环境」的答案。它以前写死在 config.py 里，改一次要找开发——
而这是一件随人随时间变的事，本该在界面上点。所以它变成了可写的：落盘一份副本，
config 里那份退化成出厂默认。

这里钉死四条：
  1. owner 只能是 executor / desktop / none —— 自由填会建出一个谁也不会认领的用途，
     环境划进去就此沉默，而现场看不出发生过什么；
  2. **用途下还挂着环境时不许删** —— 删掉登记不会删掉环境，只会让它们变成没人驱动；
  3. 枚举不可用时同样不许删：拿不准里面有没有环境，就不能替人做主；
  4. 改动落盘，重启后仍然生效（否则每次重启就悄悄回到出厂默认）。

跑法：.venv/bin/python scripts/test_purposes_crud.py
"""
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gc_ads import broker as broker_mod  # noqa: E402
from gc_ads.config import AdsPowerConfig  # noqa: E402

FACTORY = {"行情": "executor", "采购": "executor", "未分配": "none"}


def make_broker(tmp: Path, envs=(), purposes=None):
    """造一个不连网的代理实例：把落盘路径与环境枚举都换成可控的。"""
    import os
    os.environ["GC_ADS_PURPOSES_FILE"] = str(tmp / "env_purposes.json")
    cfg = AdsPowerConfig(env_purposes=dict(purposes or FACTORY))
    b = broker_mod.AdsBroker.__new__(broker_mod.AdsBroker)   # 不跑 __init__（它会建 httpx 客户端）
    import threading
    b._lock = threading.Lock()
    b.purposes = dict(cfg.env_purposes)
    b.purposes_source = "config"
    b.ads = type("FakeAds", (), {"list_users": staticmethod(lambda: list(envs))})()
    b._load_purposes()
    return b


def main() -> None:
    with tempfile.TemporaryDirectory() as d:
        tmp = Path(d)

        # --- 1. owner 白名单 -------------------------------------------------
        b = make_broker(tmp)
        for bad in ("boss", "", "EXECUTOR", "运维"):
            try:
                b.upsert_purpose("新用途", bad)
            except ValueError as exc:
                assert "owner" in str(exc), exc
            else:
                raise AssertionError(f"owner={bad!r} 竟然被接受了")
        for good in ("executor", "desktop", "none"):
            assert b.upsert_purpose("新用途", good)["owner"] == good
        # 前后空格要吃掉：界面上复制粘贴带空格是常事，不该因此判成非法
        assert b.upsert_purpose("  带空格的用途  ", " executor ")["owner"] == "executor"
        assert "带空格的用途" in b.purposes

        # 名字也要守：空的和超长的都不行
        for bad_name in ("", "   ", "x" * 33):
            try:
                b.upsert_purpose(bad_name, "none")
            except ValueError:
                pass
            else:
                raise AssertionError(f"用途名 {bad_name!r} 不该被接受")

        # --- 2. 改动必须落盘，重启后还在 -------------------------------------
        b.upsert_purpose("售后", "desktop")
        saved = json.loads((tmp / "env_purposes.json").read_text(encoding="utf-8"))
        assert saved["purposes"]["售后"] == "desktop", saved

        reborn = make_broker(tmp)          # 模拟重启：同一个落盘目录
        assert reborn.purposes["售后"] == "desktop", "重启后改动丢了，等于白改"
        assert reborn.purposes_source == "file"

        # 出厂默认只在没有落盘副本时生效
        with tempfile.TemporaryDirectory() as d2:
            fresh = make_broker(Path(d2))
            assert fresh.purposes == FACTORY
            assert fresh.purposes_source == "config"

        # --- 3. 用途下还有环境 → 不许删 --------------------------------------
        busy = make_broker(tmp, envs=[
            {"user_id": "u1", "group_name": "采购"},
            {"user_id": "u2", "group_name": "采购"},
        ])
        try:
            busy.delete_purpose("采购")
        except ValueError as exc:
            assert "2 个环境" in str(exc), exc
        else:
            raise AssertionError("还挂着环境的用途被删掉了——那批环境会变成谁也不驱动")
        assert "采购" in busy.purposes

        # 空的用途可以删
        empty = make_broker(tmp, envs=[{"user_id": "u1", "group_name": "行情"}])
        assert empty.delete_purpose("采购")["owner"] == "executor"
        assert "采购" not in empty.purposes

        # 不存在的用途要如实报错，而不是静默成功
        try:
            empty.delete_purpose("查无此途")
        except ValueError as exc:
            assert "不存在" in str(exc)
        else:
            raise AssertionError("删一个不存在的用途竟然成功了")

        # --- 4. 枚举不可用时不许删 -------------------------------------------
        blind = make_broker(tmp)
        def boom():
            raise RuntimeError("Local API 不可达")
        blind.ads = type("FakeAds", (), {"list_users": staticmethod(boom)})()
        try:
            blind.delete_purpose("行情")
        except ValueError as exc:
            assert "无法确认" in str(exc), exc
        else:
            raise AssertionError("枚举不可用时不该替人做主删掉用途")

    print("test_purposes_crud: PASS")


if __name__ == "__main__":
    main()

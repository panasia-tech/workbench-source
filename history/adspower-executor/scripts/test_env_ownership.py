"""环境归属分区回归（纯离线，不碰真 AdsPower）。

同一台机器上桌面端 seller-pilot 和本执行端都在驱动 AdsPower。两边必须各管各的
环境，否则会抢同一个浏览器的标签页。归属边界用 AdsPower 自带的分组划。

这里钉死四条语义：
  1. 设了 env_group → 只认领该分组；
  2. 两侧分组不同 → 认领集合互不相交；
  3. 没有分组的环境 → 谁也不碰（opt-in：漏分组只是不纳管，不会被错误一方抢走）;
  4. 分组不存在 → 认领空集，**不能**退化成「认领全部」。

跑法：.venv/bin/python scripts/test_env_ownership.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gc_ads import adspower as ads_mod  # noqa: E402
from gc_ads.config import Config, EnvironmentEntry  # noqa: E402

FAKE_ENVS = [
    {"user_id": "s1", "name": "销售甲", "serial_number": "1", "group_name": "销售"},
    {"user_id": "s2", "name": "销售乙", "serial_number": "2", "group_name": "销售"},
    {"user_id": "m1", "name": "行情甲", "serial_number": "3", "group_name": "行情"},
    {"user_id": "x1", "name": "没分组", "serial_number": "4", "group_name": ""},
    {"user_id": "m2", "name": "行情乙", "serial_number": "10", "group_name": "行情"},
]

CONFIG = Path(__file__).resolve().parents[1] / "config.yaml"


def cfg_with(group: str, environments=None) -> Config:
    cfg = Config.load(CONFIG)
    cfg.adspower.env_group = group
    cfg.environments = environments or []
    return cfg


def main() -> None:
    ads_mod.AdsPowerClient.list_users = lambda self, *a, **k: list(FAKE_ENVS)

    executor = cfg_with("行情").env_user_ids()
    pilot = cfg_with("销售").env_user_ids()

    # serial_number 是字符串，10 必须排在 3 后面而不是按字典序排到 1 和 2 中间
    assert executor == ["m1", "m2"], executor
    assert pilot == ["s1", "s2"], pilot
    assert not set(executor) & set(pilot), "两侧认领集合必须互不相交"

    for claimed in (executor, pilot):
        assert "x1" not in claimed, "未分组的环境不能被任何一方认领"

    assert cfg_with("不存在的分组").env_user_ids() == [], \
        "分组不存在时必须认领空集，绝不能回退成认领全部"

    # 过渡默认：还没建分组时不过滤，保持改造前行为
    assert len(cfg_with("").env_user_ids()) == len(FAKE_ENVS)

    # config.yaml 的 enabled:false 覆盖叠加在分组过滤之上
    narrowed = cfg_with("销售", [EnvironmentEntry(user_id="s1", enabled=False)])
    assert narrowed.env_user_ids() == ["s2"], narrowed.env_user_ids()
    assert narrowed.env_user_ids(include_disabled=True) == ["s1", "s2"]

    # 用途登记表：建环境必须指定已登记的用途，打错字要被拒绝而不是建出孤儿环境
    purposes = Config.load(CONFIG).adspower.env_purposes
    assert purposes.get("行情") == "executor", purposes
    # 销售 = 网页版上下架,和行情/采购一样由执行端驱动(2026-09-15 起;此前这个分组名
    # 是历史遗留、里面装的是采购员账号、归桌面端,分组空了之后名字归位到字面意思)
    assert purposes.get("销售") == "executor", purposes
    # 「未分配」是显式隔离区：Local API 没有 group/delete，与其留个垃圾分组，
    # 不如给它一个明确语义——谁都不许驱动。
    assert purposes.get("未分配") == "none", purposes
    assert "行晴" not in purposes, "错别字用途不应存在于登记表"
    # 登记表覆盖了 fake 环境里出现的所有非空分组
    used = {u["group_name"] for u in FAKE_ENVS if u["group_name"]}
    assert used <= set(purposes), f"有分组没登记用途: {used - set(purposes)}"
    # 隔离区不能被任何一侧当作认领目标
    for side in ("executor", "desktop"):
        assert "未分配" not in [g for g, o in purposes.items() if o == side]

    report = cfg_with("行情").env_group_report()
    assert report == {"group": "行情", "filtered": True, "total": 5,
                      "claimed": 2, "ungrouped": 1}, report

    # 两侧配置必须互补：执行端认领的每个分组，其用途都必须登记为 executor
    mine = Config.load(CONFIG).adspower.env_groups()
    assert mine, "config.yaml 必须设 env_group，留空=认领全部会和桌面端互相踩"
    for g in mine:
        assert purposes.get(g) == "executor", \
            f"config.yaml 认领「{g}」，但登记表说它归 {purposes.get(g)}"

    # 认领多个分组：采购和销售会在同一台机器上共存一段时间（销售从安卓搬浏览器期间），
    # 改成单个销售分组会把采购那批的消息门铃一起停掉，所以必须支持并列认领。
    both = cfg_with("行情,销售").env_user_ids()
    assert both == ["s1", "s2", "m1", "m2"], both
    assert cfg_with(["行情", "销售"]).env_user_ids() == both, "YAML 列表写法要和逗号分隔等价"
    assert cfg_with(" 行情 , ,销售 ").env_user_ids() == both, "空白与空项要被忽略"
    assert cfg_with("行情,不存在的分组").env_user_ids() == ["m1", "m2"], \
        "并列里混进不存在的分组，只应少认领，不能回退成认领全部"

    # 免费版/断网回退时不做分组过滤，此时归属只能靠 config.yaml 人工确认
    def refuse(self, *a, **k):
        raise ads_mod.PaidFeatureUnavailable("This feature is only available in paid subscriptions.")
    ads_mod.AdsPowerClient.list_users = refuse
    fallback = cfg_with("行情", [EnvironmentEntry(user_id="cfg-only")])
    assert fallback.env_user_ids() == ["cfg-only"], fallback.env_user_ids()

    print("test_env_ownership: PASS")


if __name__ == "__main__":
    main()

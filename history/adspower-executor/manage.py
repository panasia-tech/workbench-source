"""AdsPower 群控执行端运维 CLI。

用法（在 adspower-executor/ 目录下）：
  .venv/bin/python manage.py doctor            # 安装/运行环境全面体检（只读）
  .venv/bin/python manage.py list              # 配置的环境清单 + 三方对账状态
  .venv/bin/python manage.py capacity          # 实例容量：当前运行数 + 套餐说明
  .venv/bin/python manage.py start [uid ...]   # 一键启动（不带参数 = 全部启用环境）
  .venv/bin/python manage.py stop  [uid ...]   # 停止（--browser 连浏览器一起关）
  .venv/bin/python manage.py status            # 简版状态表
  .venv/bin/python manage.py run               # 前台看门狗：崩了拉起、浏览器掉了重开
  .venv/bin/python manage.py sync-envs         # 付费版：从 AdsPower API 拉全部环境登记进 config.yaml
"""
from __future__ import annotations

import argparse
import sys

from gc_ads.config import Config
from gc_ads.doctor import format_report, run_doctor
from gc_ads.broker import DEFAULT_PORT as _BROKER_PORT
from gc_ads.supervisor import Supervisor


def _resolve_ids(cfg: Config, ids: list[str]) -> list[str]:
    """命令行没给 user_id = 全部纳管环境；给了就校验存在（防手滑启动打错的 ID）。"""
    if not ids:
        return cfg.env_user_ids()
    known = set(cfg.env_user_ids(include_disabled=True))
    bad = [i for i in ids if i not in known]
    if bad:
        source = "AdsPower 环境清单" if cfg.adspower.env_source == "api" else "config.yaml environments"
        raise SystemExit(f"环境不在{source}里: {', '.join(bad)}")
    return ids


def main() -> None:
    parser = argparse.ArgumentParser(prog="manage.py", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", default="config.yaml")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("doctor", help="安装/运行环境体检（只读）")
    p_list = sub.add_parser("list", help="环境清单与状态对账")
    p_list.add_argument("--json", action="store_true", help="JSON 输出（给群控守护桌面端等程序消费）")

    p_status = sub.add_parser("status", help="简版状态表")
    p_status.add_argument("--json", action="store_true", help="JSON 输出（同 list --json）")

    p_cap = sub.add_parser("capacity", help="实例容量探测")
    p_cap.add_argument("--probe", action="store_true",
                       help="主动探测：逐个启动未运行的配置环境直到撞限（会真实开浏览器）")

    p_groups = sub.add_parser("groups", help="环境归属：看分组现状 / 把环境划进分组")
    p_groups.add_argument("--assign", metavar="分组名",
                          help="把 --envs 指定的环境划进这个分组（不存在则自动创建）")
    p_groups.add_argument("--envs", nargs="*", default=[], metavar="user_id",
                          help="要划分的环境 ID；配合 --assign 使用")

    p_broker = sub.add_parser("broker", help="本机 AdsPower 代理：全机唯一入口 + 归属强制")
    p_broker.add_argument("--port", type=int, default=None, help=f"监听端口，默认 {_BROKER_PORT}")
    p_broker.add_argument("--daemon", action="store_true",
                          help="后台拉起并交给看门狗托管（默认前台运行）")
    p_broker.add_argument("--stop", action="store_true", help="停止后台代理")

    p_envs = sub.add_parser("envs", help="环境生命周期：按用途新建 / 删除")
    p_envs.add_argument("--create", metavar="备注名", help="新建一个环境（必须配 --purpose）")
    p_envs.add_argument("--purpose", help="用途（=AdsPower 分组名），决定谁驱动它")
    p_envs.add_argument("--count", type=int, default=1, help="批量新建个数，默认 1")
    p_envs.add_argument("--delete", nargs="*", default=None, metavar="user_id",
                        help="删除环境（不可逆：指纹与 cookie 一并消失）")
    p_envs.add_argument("--yes", action="store_true", help="删除时跳过二次确认")

    p_sync = sub.add_parser("sync-envs", help="从 AdsPower API 拉全部环境固化进 config.yaml")
    p_sync.add_argument("--enable-all", action="store_true",
                        help="新登记的环境直接 enabled=true（默认 false，登记后人工确认再启用）")

    p_start = sub.add_parser("start", help="启动 executor（默认全部启用环境）")
    p_start.add_argument("user_ids", nargs="*")

    p_stop = sub.add_parser("stop", help="停止 executor（默认全部）")
    p_stop.add_argument("user_ids", nargs="*")
    p_stop.add_argument("--browser", action="store_true", help="连 AdsPower 浏览器一起关")

    sub.add_parser("run", help="前台看门狗")

    args = parser.parse_args()
    cfg = Config.load(args.config)
    sup = Supervisor(cfg)

    if args.cmd == "doctor":
        print(format_report(run_doctor(cfg)))

    elif args.cmd in ("list", "status"):
        rows = sup.status()
        if getattr(args, "json", False):
            import json as _json
            print(_json.dumps(rows, ensure_ascii=False))
            return
        if not rows:
            print("没有可纳管的环境："
                  + ("AdsPower 里一个环境都没有，或 Local API 不可达"
                     if cfg.adspower.env_source == "api"
                     else "config.yaml 的 environments 为空"))
            return
        print(f"{'user_id':<14} {'备注':<12} {'浏览器':<8} {'executor':<20} 日志")
        for r in rows:
            print(f"{r['user_id']:<14} {r['name'] or '-':<12} {r['browser']:<8} "
                  f"{r['executor']:<20} {r['log']}")

    elif args.cmd == "capacity":
        running = sup.ads.local_active()
        print(f"当前运行中实例: {len(running)} 个"
              + ("：" + ", ".join(i.get("user_id", "?") for i in running) if running else ""))
        src = "AdsPower API" if cfg.adspower.env_source == "api" else "config.yaml"
        print(f"纳管环境（来源 {src}）: {len(cfg.env_user_ids())} 个")
        print("套餐并发上限: Local API 不提供查询接口；"
              "上限以启动时的报错为准（start 撞限会如实报 AdsPower 的错误文案）。")
        if args.probe:
            print("--probe: 逐个启动未运行的纳管环境，撞到上限为止 ...")
            for uid in cfg.env_user_ids():
                if sup.ads.is_active(uid):
                    print(f"  {uid}: 已在运行")
                    continue
                try:
                    sup.ads.start_browser(uid)
                    print(f"  {uid}: 启动成功")
                except Exception as exc:
                    print(f"  {uid}: 启动失败 → {exc}（这就是当前上限/边界）")
                    break

    elif args.cmd == "start":
        for r in [sup.start_one(uid) for uid in _resolve_ids(cfg, args.user_ids)]:
            print(("✓ " if r["ok"] else "✗ ") + f"{r['user_id']}: {r['note']}")

    elif args.cmd == "stop":
        for r in [sup.stop_one(uid, args.browser) for uid in _resolve_ids(cfg, args.user_ids)]:
            print(("✓ " if r["ok"] else "✗ ") + f"{r['user_id']}: {r['note']}")

    elif args.cmd == "run":
        sup.run_forever()

    elif args.cmd == "broker":
        if args.stop:
            print(sup.stop_broker()["note"])
        elif args.daemon:
            print(sup.start_broker()["note"])
        else:
            from gc_ads.broker import AdsBroker
            # 带上完整配置：代理要据此控制 executor 进程（界面上的启停执行端走这条路）
            AdsBroker(cfg.adspower, port=args.port or _BROKER_PORT, full_cfg=cfg).serve_forever()

    elif args.cmd == "envs":
        _envs(cfg, args)

    elif args.cmd == "groups":
        _groups(cfg, args.assign, args.envs)

    elif args.cmd == "sync-envs":
        _sync_envs(cfg, args.config, enable_all=args.enable_all)


def _envs(cfg: Config, args) -> None:
    """环境生命周期。用途（分组）是**出生属性**：AdsPower 的 user/create 强制要
    group_id，所以经这里建出来的环境一定有归属，不会留下谁也不认领的空档。"""
    from gc_ads.adspower import AdsPowerClient, PaidFeatureUnavailable
    ads = AdsPowerClient(cfg.adspower)
    purposes = cfg.adspower.env_purposes or {}

    if args.delete is not None:
        ids = [i for i in args.delete if i.strip()]
        if not ids:
            raise SystemExit("--delete 需要至少一个 user_id")
        known = {u["user_id"]: u for u in ads.list_users()}
        unknown = [i for i in ids if i not in known]
        if unknown:
            raise SystemExit(f"环境不存在: {', '.join(unknown)}")
        print("将要删除（不可逆，指纹与 cookie 一并消失）：")
        for i in ids:
            print(f"  {i:<12} {known[i].get('name') or '-'}  [{known[i].get('group_name') or '未分组'}]")
        if not args.yes:
            if input("确认删除？输入 yes 继续: ").strip().lower() != "yes":
                raise SystemExit("已取消")
        ads.delete_envs(ids)
        print(f"✓ 已删除 {len(ids)} 个环境")
        return

    if not args.create:
        # 无动作 = 按用途盘点
        try:
            users = ads.list_users()
        except PaidFeatureUnavailable as exc:
            raise SystemExit(f"环境枚举需要付费版套餐: {exc}")
        print("用途登记表（分组名 → 谁驱动）:")
        for name, owner in purposes.items():
            n = sum(1 for u in users if (u.get("group_name") or "").strip() == name)
            mine = " ← 本执行端" if name in cfg.adspower.env_groups() else ""
            label = "谁也不驱动（隔离）" if owner == "none" else owner
            print(f"  {name:<8} → {label:<18} {n} 个环境{mine}")
        # 就绪度：新建的环境没有代理也没有登录态，跑不了活。API 看不到登录态，
        # 但「有没有配代理」看得到——先把这一层暴露出来，免得以为建完就能用。
        unready = [u for u in users if not u.get("has_proxy")
                   and purposes.get((u.get("group_name") or "").strip()) not in (None, "none")]
        if unready:
            print(f"\n⚠️ {len(unready)} 个已纳管环境还没配代理，跑不了活：")
            for u in unready:
                print(f"    {u['user_id']:<12} {u.get('name') or '-'}  [{u.get('group_name')}]")
            print("   去 AdsPower 客户端给它配 socks5 并登录闲鱼账号（登录态 API 看不到，只能人工确认）")

        loose = [u for u in users if (u.get("group_name") or "").strip() not in purposes]
        if loose:
            print(f"\n⚠️ {len(loose)} 个环境的用途不在登记表里，谁也不会驱动它们：")
            for u in loose:
                print(f"    {u['user_id']:<12} {u.get('name') or '-'}  [{u.get('group_name') or '未分组'}]")
            print("   用 manage.py groups --assign <用途> --envs <id...> 归位")
        return

    purpose = (args.purpose or "").strip()
    if not purpose:
        raise SystemExit(f"--create 必须配 --purpose，可选: {', '.join(purposes) or '(登记表为空)'}")
    if purposes.get(purpose) == "none":
        raise SystemExit(
            f"「{purpose}」是显式隔离区（谁也不驱动），不能作为新建环境的用途。\n"
            "  要把已有环境停用，用 manage.py groups --assign 把它划进来。")
    if purpose not in purposes:
        raise SystemExit(
            f"用途「{purpose}」不在登记表里，可选: {', '.join(purposes)}。\n"
            "  新增用途请先写进 config.yaml 的 adspower.env_purposes，"
            "否则建出来的环境谁也不会驱动。")

    gid = ads.ensure_group(purpose)
    created = []
    for i in range(max(1, args.count)):
        name = args.create if args.count == 1 else f"{args.create}{i + 1:02d}"
        created.append(ads.create_env(name, gid))
        print(f"✓ {created[-1]['user_id']:<12} {name}  [{purpose}] "
              f"serial={created[-1]['serial_number']}")
    owner = purposes[purpose]
    print(f"\n共新建 {len(created)} 个，用途「{purpose}」→ 由 {owner} 驱动")
    if owner == "executor" and purpose in cfg.adspower.env_groups():
        print("  本执行端会在一个 env_cache_sec 内自动纳管，无需改配置")
    elif owner == "desktop":
        print("  由桌面端 seller-pilot 纳管：在「账号配置」里绑定该环境 ID")
    print("  ⚠️ 新环境没有代理也没有登录态，需要在 AdsPower 里配代理并登录闲鱼")


def _groups(cfg: Config, assign: str | None, envs: list[str]) -> None:
    """环境归属边界：AdsPower 分组 → 谁来驱动这个环境。

    同机上桌面端 seller-pilot 与本执行端都在驱动 AdsPower，必须各管各的环境。
    没有归属的环境（分组为空）在过滤生效时谁也不碰。
    """
    from gc_ads.adspower import AdsPowerClient, PaidFeatureUnavailable
    ads = AdsPowerClient(cfg.adspower)

    if assign:
        if not envs:
            raise SystemExit("--assign 需要配合 --envs 指定环境 ID")
        try:
            gid = ads.ensure_group(assign)
            ads.assign_group(envs, gid)
        except PaidFeatureUnavailable as exc:
            raise SystemExit(f"分组接口需要付费版套餐: {exc}")
        print(f"✓ 已把 {len(envs)} 个环境划进分组「{assign}」(group_id={gid}): {', '.join(envs)}")
        print("  注意：清单有缓存，最迟 env_cache_sec 秒后生效")
        return

    try:
        users = ads.list_users()
    except PaidFeatureUnavailable as exc:
        raise SystemExit(f"环境枚举需要付费版套餐: {exc}")

    mine = (cfg.adspower.env_group or "").strip()
    by_group: dict[str, list[dict]] = {}
    for u in users:
        by_group.setdefault((u.get("group_name") or "").strip(), []).append(u)

    print(f"本执行端认领分组: {mine or '(未设置 —— 认领全部环境)'}")
    if not mine:
        print("  ⚠️ 同机若同时跑桌面端 seller-pilot，两边会抢同一批环境的标签页。")
        print("     用 manage.py groups --assign <分组名> --envs <id...> 划好归属，再把")
        print("     config.yaml 的 adspower.env_group 设成本端分组。")
    print()
    for gname in sorted(by_group, key=lambda g: (g == "", g)):
        label = gname or "(未分组)"
        owned = "← 本端" if mine and gname == mine else ("← 谁也不碰" if mine and not gname else "")
        print(f"[{label}] {len(by_group[gname])} 个 {owned}")
        for u in sorted(by_group[gname], key=lambda x: _serial_of(x)):
            print(f"    {u['user_id']:<12} {u.get('name') or '-'}")
        print()


def _serial_of(u: dict):
    t = str(u.get("serial_number") or "").strip()
    return (0, int(t)) if t.isdigit() else (1, t)


def _sync_envs(cfg: Config, config_path: str, enable_all: bool = False) -> None:
    """把 AdsPower 的全量环境固化进 config.yaml environments。

    ⚠️ env_source=api（默认）下运行时本就直接从 API 拉清单，**不需要跑这个命令**。
    它只在两种场景有用：①要给环境批量写备注名或用 enabled: false 排除某些环境，
    先落一份骨架好编辑；②准备切到 env_source=config（离线/免费版）前做一次固化。

    合并策略：已存在的 user_id 保留原 name/enabled（人工设置不覆盖）；新环境按
    --enable-all 决定 enabled。⚠️ 重写 config.yaml 会丢 YAML 注释，注释模板以
    config.example.yaml 为准。
    """
    import yaml

    from gc_ads.adspower import AdsPowerClient, PaidFeatureUnavailable
    try:
        users = AdsPowerClient(cfg.adspower).list_users()
    except PaidFeatureUnavailable as exc:
        raise SystemExit(f"环境枚举失败: {exc}（此接口需要付费版套餐）")
    except Exception as exc:
        raise SystemExit(f"AdsPower API 不可达: {exc}")

    existing = {e.user_id: e for e in cfg.environments}
    merged, added = [], 0
    for u in users:
        uid = u.get("user_id")
        if not uid:
            continue
        if uid in existing:
            e = existing[uid]
            merged.append({"user_id": uid, "name": e.name or u.get("name") or "",
                           "enabled": e.enabled})
        else:
            merged.append({"user_id": uid, "name": u.get("name") or "",
                           "enabled": bool(enable_all)})
            added += 1

    doc = yaml.safe_load(open(config_path, encoding="utf-8")) or {}
    doc["environments"] = merged
    with open(config_path, "w", encoding="utf-8") as f:
        yaml.safe_dump(doc, f, allow_unicode=True, sort_keys=False)
    print(f"同步完成：AdsPower 共 {len(users)} 个环境，新登记 {added} 个"
          f"（{'已启用' if enable_all else '默认未启用，确认后把 enabled 改 true'}），"
          f"config.yaml 已更新")


if __name__ == "__main__":
    main()

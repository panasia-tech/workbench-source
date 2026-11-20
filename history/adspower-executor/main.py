"""入口：加载配置 → enroll → 启动 AdsPower 环境 → CDP 接管 → 连 MQTT → 心跳/identity 循环。

单环境直接跑：`python main.py`（用 config.yaml 的 adspower.user_id）。
多环境由 manage.py/supervisor 拉起：`python main.py --user-id <env_id>`。
"""
from __future__ import annotations

import argparse
import asyncio
import importlib
import logging
import os
import time

from gc_ads.adspower import AdsPowerClient
from gc_ads.config import Config
from gc_ads.driver import BrowserDriver
from gc_ads.enroll import EnrollClient
from gc_ads.identity import build_identity_frame, read_xianyu_nick
from gc_ads.logs import collect_logs, prune_old_logs, setup_logging
from gc_ads import hot_code
from gc_ads.paths import app_root, is_frozen
from gc_ads.im_watch import ImWatcher
from gc_ads.mqtt_client import GcMqttClient
from gc_ads.primitives import PrimitiveExecutor

log = logging.getLogger("gc.executor")

IDENTITY_REPORT_INTERVAL_SEC = 60

# 启动时已换上新代码、交给新入口时置位:新入口见到它就不再查,防来回套娃。
_HANDOFF_ENV = "GC_ADS_CODE_HANDOFF"


async def _take_newer_code_now(cfg) -> bool:
    """启动时先看有没有新代码:有就下载,当场在本进程里换上、交给新入口跑完,返回 True。

    以前只在跑起来以后才下载、要到「下次启动」才生效——发一版热更新,工位得停了再启动两次
    (第一次只是把新代码下下来)。现在启动这一次就用上。这时还没连浏览器、没连 MQTT,什么活
    都没开始,换代码踩不到正在干的事;同一个进程接着跑,进程号不变,行情台的台账照样认得它。
    正在跑的进程仍然绝不换代码(见主循环里的定时下载)。只在打包态做:开发态跑的是工作区源码。
    """
    url = cfg.executor.code_update_url
    if not is_frozen() or not url or os.environ.get(_HANDOFF_ENV):
        return False
    res = await asyncio.to_thread(hot_code.check_and_download, url, app_root(), log.info)
    if not res.get("updated"):
        return False
    act = hot_code.activate(app_root(), log.info)
    if not act.get("active"):
        log.warning("新代码已下载但这次没启用(%s),先用当前版本", act.get("reason"))
        return False
    os.environ[_HANDOFF_ENV] = "1"
    new_main = importlib.import_module("main")   # activate 已把旧模块请出 sys.modules,这里拿到的是新代码
    log.info("已换上新代码 %s(codeVersion %s),交给新入口", act.get("versionName"), act.get("codeVersion"))
    await new_main.main()
    return True


async def _maybe_upload_logs(enroll, beat: dict | None, done: set[str]) -> None:
    """心跳回包里带了取日志待办就把日志传回去。

    为什么挂在心跳上：要日志的时候机器常常正好不在线。心跳每 5s 一次、启动后第一拍
    也会打，于是「在线就立刻传」和「不在线就下次启动补传」是同一条路。

    ``done`` 记住本进程已处理过的待办 id：服务端在收到上传前会一直把它算作待办，
    而一轮上传可能要几十秒——不记就会同一个包传好几遍。
    """
    req = (beat or {}).get("log_request")
    if not req or req.get("id") in done:
        return
    rid, days = req["id"], int(req.get("days") or 7)
    done.add(rid)
    log.info("收到取日志待办 %s（最近 %d 天），开始打包", rid, days)
    try:
        blob = await asyncio.to_thread(collect_logs, days)
        await asyncio.to_thread(enroll.upload_logs, rid, blob)
        log.info("日志包已上传 %s（%.1f MB）", rid, len(blob) / 1048576)
    except Exception as exc:
        done.discard(rid)          # 传失败就让它留在待办里，下一拍重来
        log.warning("日志上传失败 %s: %s", rid, exc)


async def main() -> None:
    parser = argparse.ArgumentParser(description="gc ads executor")
    parser.add_argument("--config", default="config.yaml")
    parser.add_argument("--user-id", default=None,
                        help="覆盖 config.yaml 的 adspower.user_id（supervisor 多环境拉起用）")
    args = parser.parse_args()

    cfg = Config.load(args.config)
    if args.user_id:
        cfg = cfg.for_environment(args.user_id)

    # 日志：按天切分、保留 30 天。放在最前面——后面每一步的报错都要留得下来。
    log_path = setup_logging(f"executor_{args.user_id or cfg.adspower.user_id or 'default'}")
    log.info("日志文件 %s（按天切分，保留 30 天）", log_path)

    # 跑到这里算「起来了」：把热更新的 boot-pending 标记撤掉。
    # 不撤的话，下次启动会把这份好代码当成坏版本隔离掉。
    hot_code.mark_boot_ok(app_root())
    log.info("代码版本 %s", hot_code.local_version(app_root()))
    if await _take_newer_code_now(cfg):
        return
    if not cfg.adspower.user_id:
        raise SystemExit("未配置环境：config.yaml 填 adspower.user_id 或用 --user-id 指定")
    # 走到这里，跑的就是最终这份代码了（要换的已在上面换完）：记下来给行情台看版本
    hot_code.write_running_marker(app_root(), cfg.adspower.user_id)

    # 1) enroll：本地有身份复用，没有则注册（hw_id = adspower user_id）
    enroll = EnrollClient(cfg)
    enroll.load_or_enroll()
    log.info("enroll ok, device_id=%s", enroll.device_id)

    # 2) AdsPower 启动环境（已在跑时 start 也返回 ws；失败用 local-active 兜底）
    ads = AdsPowerClient(cfg.adspower)

    async def reopen_browser() -> str:
        """拉起 AdsPower 环境并返回 CDP ws 端点。首连、driver 自愈、cmd restart 共用一条路。
        AdsPowerClient 是同步 httpx（start 可能等到 60s），丢线程里跑,别卡住事件循环。"""
        try:
            return await asyncio.to_thread(ads.start_browser)
        except Exception as exc:
            log.warning("adspower start failed (%s), fallback to local-active", exc)
            ws = await asyncio.to_thread(ads.local_active_ws)
            if not ws:
                raise
            return ws

    ws = await reopen_browser()
    log.info("adspower browser up, ws=%s...", ws[:60])

    # 3) CDP 接管 + 打开闲鱼（reopen 交给 driver：浏览器中途被关也能自己救回来）
    driver = BrowserDriver(cfg, reopen=reopen_browser)
    await driver.connect(ws)
    await driver.open_xianyu()
    log.info("playwright connected, page=%s", driver.page.url if driver.page else None)

    executor = PrimitiveExecutor(driver)

    # 4) MQTT（cmd restart = 重建浏览器连接;cmd update_code = 下载新代码后退出进程、
    # 由 supervisor 拉起换新）
    shutdown_event = asyncio.Event()

    async def restart_browser() -> None:
        log.info("restart: reconnecting browser...")
        await driver.reconnect(await reopen_browser())
        await driver.open_xianyu()

    async def update_code() -> None:
        """cmd update_code：尽力下载新代码，然后置退出事件让主循环收尾退出——manage.py
        的 supervisor 10s 内拉起新进程，启动时 hot_code.activate 换上已下载的新版。
        finally 照常跑（MQTT 断开、driver.close 不杀浏览器，窗口留给用户）。
        已是最新/没配更新源也照常退出（对齐 restart 语义，重启本身能治病）。"""
        if not is_frozen():
            log.info("update_code: 开发态(非打包)不下载代码,直接退出进程由 supervisor 拉起")
        elif not cfg.executor.code_update_url:
            log.info("update_code: 未配置 code_update_url,退出进程由 supervisor 拉起")
        else:
            log.info("update_code: 下载新代码 ...")
            res = await asyncio.to_thread(hot_code.check_and_download,
                                          cfg.executor.code_update_url, app_root(), log.info)
            if res.get("updated"):
                log.info("update_code: 已下载新版本 %s(codeVersion %s),退出进程交给 supervisor 拉起",
                         res.get("versionName"), res.get("codeVersion"))
            else:
                log.info("update_code: %s,仍退出进程交给 supervisor 拉起",
                         res.get("reason") or "已是最新")
        shutdown_event.set()

    mqtt_client = GcMqttClient(cfg, enroll.device_id, enroll.token, executor,
                               on_restart=restart_browser, on_update_code=update_code)
    driver.notify = mqtt_client.log   # 浏览器自愈事件同步上报服务端
    loop = asyncio.get_running_loop()
    mqtt_client.start(loop)
    log.info("mqtt connecting %s:%s ...", cfg.server.mqtt_host, cfg.server.mqtt_port)

    # 5) 启动即上报一次 identity，之后每 60s 周期上报
    async def identity_report_loop() -> None:
        while True:
            try:
                nick = await read_xianyu_nick(driver)
                frame = build_identity_frame(nick, ready=bool(nick))
                mqtt_client.report(frame)
                log.info("identity reported: nick=%r ready=%s", nick, frame["ready"])
            except Exception as exc:
                log.warning("identity report failed: %s", exc)
            await asyncio.sleep(IDENTITY_REPORT_INTERVAL_SEC)

    ident_task = asyncio.create_task(identity_report_loop())

    # 5.5) 常驻 /im 消息门铃：未读上涨 → 提示服务端立刻扫一轮。
    # 只读（goto + evaluate），自己一张页，不与业务原语抢 tab。挂了只退回周期 chat_scan。
    watch_task = None
    if cfg.executor.im_watch_enabled:
        watcher = ImWatcher(
            driver, mqtt_client.report,
            chat_url=cfg.xianyu.chat_url,
            poll_sec=cfg.executor.im_watch_poll_sec,
            min_hint_interval_sec=cfg.executor.im_watch_min_hint_interval_sec,
            relogin_retry_sec=cfg.executor.im_watch_retry_sec,
            ignore_nicks=frozenset(cfg.executor.im_watch_ignore_nicks or ()),
        )
        watch_task = asyncio.create_task(watcher.run_forever())
        log.info("im_watch enabled (poll=%.1fs)", cfg.executor.im_watch_poll_sec)

    # 6) 5s 心跳（HTTP）；失败不崩溃。顺带认领服务端下的取日志待办。
    done_log_requests: set[str] = set()
    last_prune = 0.0
    try:
        while not shutdown_event.is_set():   # update_code 置位后收尾退出,由 supervisor 拉起
            if time.time() - last_prune > 6 * 3600:
                last_prune = time.time()
                removed = await asyncio.to_thread(prune_old_logs)
                if removed:
                    log.info("清理过期日志 %d 个", len(removed))
                # 顺带看一眼有没有新代码。**只下载，不热替换正在跑的进程**——
                # 下次启动（或看门狗重启）才生效，别在半路换掉自己脚下的地板。
                if cfg.executor.code_update_url and is_frozen():
                    await asyncio.to_thread(
                        hot_code.check_and_download, cfg.executor.code_update_url,
                        app_root(), log.info)
            page_ready = False
            try:
                page_ready = await driver.check_login()
            except Exception as exc:
                log.warning("page_ready check failed: %s", exc)
            try:
                beat = await asyncio.to_thread(
                    enroll.heartbeat,
                    mqtt_connected=mqtt_client.connected,
                    page_ready=page_ready,
                    busy=False,
                )
                await _maybe_upload_logs(enroll, beat, done_log_requests)
            except Exception as exc:
                log.warning("heartbeat failed: %s", exc)
            await asyncio.sleep(cfg.executor.heartbeat_interval_sec)
    except KeyboardInterrupt:
        log.info("shutting down ...")
    finally:
        ident_task.cancel()
        if watch_task:
            watch_task.cancel()
        mqtt_client.stop()
        await driver.close()
        # 不调用 ads.stop_browser()：浏览器留给用户继续使用
        log.info("bye")


if __name__ == "__main__":
    asyncio.run(main())

"""身份上报：读闲鱼网页版当前登录昵称，组 identity 帧经 MQTT report 上行。

服务端按 nick 唯一键 upsert gc_account 并完成 账号↔设备 绑定
（与 Android 端同一套逻辑，见 mqtt_bridge.py）。

identity 帧格式（保持不变）：
{"kind": "identity", "xianyu_installed": true, "xianyu_nick": "...",
 "ready": true, "blocking": "", "app_version": "...", "ts": ms}
"""
from __future__ import annotations

import time

from .driver import BrowserDriver, on_main_site
from . import __version__

# 页头昵称锚点只有闲鱼主站有。卖家工作台 seller.goofish.com 网址里也带 goofish.com，
# 以前照样在那读，读不到就报「没登录」。2026-10-08 现场：人开过卖家工作台，浏览器断线
# 重开后停在那一页，号明明登着却一直报没登录，掉登录冻结也等不到自动解冻。
__all__ = ["on_main_site", "read_xianyu_nick", "build_identity_frame"]


async def read_xianyu_nick(driver: BrowserDriver) -> str:
    """从闲鱼网页版读取当前账号昵称。

    当前页已在闲鱼主站就直接读（避免无谓刷新打断页面状态）；
    否则（别的网站、卖家工作台）先导航到首页再读。读不到返回 ""。
    """
    page = await driver.ensure_page()
    if not on_main_site(page.url):
        await driver.open_xianyu()
        page = driver.page
        assert page
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=15000)
        except Exception:
            pass
    return await driver.current_nick()


def build_identity_frame(nick: str, ready: bool, blocking: str = "") -> dict:
    return {
        "kind": "identity",
        "xianyu_installed": True,
        "xianyu_nick": nick,
        "ready": ready,
        "blocking": blocking,
        "app_version": __version__,
        "ts": int(time.time() * 1000),
    }

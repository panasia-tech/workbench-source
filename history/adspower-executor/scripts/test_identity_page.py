"""身份上报只在闲鱼主站读昵称(伪造 driver,不需要真浏览器)。

跑法：`.venv/bin/python scripts/test_identity_page.py`，全过打印「全部通过」。

背景(2026-10-08 现场):浏览器断线重开后停在卖家工作台 seller.goofish.com,网址里带
goofish.com,以前就地读昵称,读不到页头锚点,号明明登着却一直报「没登录」。
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from gc_ads.identity import on_main_site, read_xianyu_nick

HOME = "https://www.goofish.com"


class FakePage:
    def __init__(self, url):
        self.url = url

    async def wait_for_load_state(self, *a, **k):
        pass


class FakeDriver:
    """主站页面页头有昵称,别的页面读不到。"""

    def __init__(self, url, nick="洞穴Q弹的荆芥"):
        self.page = FakePage(url)
        self.nick = nick
        self.navigations = 0

    async def ensure_page(self):
        return self.page

    async def open_xianyu(self):
        self.navigations += 1
        self.page.url = HOME

    async def current_nick(self):
        return self.nick if on_main_site(self.page.url) else ""


async def main():
    # 1. 停在卖家工作台:先回首页再读,读到真昵称
    d = FakeDriver("https://seller.goofish.com/?site=COMMONPRO#/seller-data/data")
    assert await read_xianyu_nick(d) == "洞穴Q弹的荆芥"
    assert d.navigations == 1 and d.page.url == HOME
    print("1. 卖家工作台 -> 回首页再读 OK")

    # 2. 已在主站(消息页、发布页):就地读,不刷新打断页面
    for url in ("https://www.goofish.com/im", "https://www.goofish.com/publish?x=1", "https://goofish.com/"):
        d = FakeDriver(url)
        assert await read_xianyu_nick(d) == "洞穴Q弹的荆芥"
        assert d.navigations == 0, url
    print("2. 主站页面 -> 就地读 OK")

    # 3. 别的网站/空白页:照旧先回首页
    for url in ("about:blank", "https://login.taobao.com/member/login.jhtml", ""):
        d = FakeDriver(url)
        assert await read_xianyu_nick(d) == "洞穴Q弹的荆芥"
        assert d.navigations == 1, url
    print("3. 别的网站 -> 回首页再读 OK")

    # 4. 网址里只是「含」goofish.com 的假冒域名不算主站
    assert not on_main_site("https://www.goofish.com.evil.example/")
    assert not on_main_site("https://seller.goofish.com/")
    print("4. 只认主站域名 OK")

    print("全部通过")


asyncio.run(main())

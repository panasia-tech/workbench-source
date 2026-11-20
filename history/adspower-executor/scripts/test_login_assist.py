"""登录自救在真浏览器里用真鼠标点到跨域 iframe 里的「快速进入」(本机 Chrome 无头跑,不连外网)。

跑法：`.venv/bin/python scripts/test_login_assist.py`，全过打印「全部通过」。需要本机装了 Google Chrome。

闲鱼和淘宝的域名都由 Playwright 路由拦下来、喂本地假页面:主页面在 www.goofish.com,
登录框在跨站的 login.taobao.com iframe 里(和线上一样,主文档的 querySelector 看不到它)。
开 --site-per-process 让 iframe 跑在单独进程里(线上 AdsPower 浏览器就是这样),iframe 还
故意摆在页面中间偏下——坐标换算错了,真点就落空。假按钮只认真鼠标(event.isTrusted),
代码 el.click() 点不动它。
背景:2026-10-08 会话过期没点「快速进入」被冻号;2026-10-25 查到代码点 550 次只登回 1 次,改真鼠标点。
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from playwright.async_api import async_playwright

from gc_ads.driver import normalize_nick
from gc_ads.login_assist import _click_login_buttons, assist_login
from gc_ads.selectors import NICK_ANCHOR

# 登录框通知「登好了」后，主页面过一会儿把页头换成昵称(模拟会话恢复、页头刷新)
MAIN = """<html><body style="margin:0">
<div class="header"><a class="nick--RyNYtDXM">登录</a></div>
<div style="position:absolute; top:180px; left:320px">
  <iframe id="login" src="https://login.taobao.com/mini_login.htm" width="700" height="480" style="border:0"></iframe>
</div>
<script>
  window.addEventListener('message', (e) => {
    if (e.data === 'login-ok') setTimeout(() => {
      document.querySelector('.nick--RyNYtDXM').textContent = '土星耐心的黑水母';
    }, 1200);
  });
</script>
</body></html>"""

# 同上，但整页盖着一层透明遮罩：真点落在遮罩上，要退回代码点
MAIN_COVERED = MAIN.replace(
    "</body>", '<div style="position:fixed; inset:0; z-index:9"></div></body>')

QUICK = """<html><body>
<div class="avatar">t**2</div>
<button class="fm-button" style="margin:140px 0 0 220px; width:300px; height:44px"
  onclick="document.body.dataset.clicked = event.isTrusted ? 'quick' : 'quick-js';
           if (event.isTrusted) parent.postMessage('login-ok', '*')">快速进入</button>
<button onclick="document.body.dataset.clicked='other'">其他账号登录</button>
</body></html>"""

# 按钮文字包在 span 里、外层是 div(没有 button 标签):要点到最里层那个带事件的元素
QUICK_NESTED = """<html><body>
<div class="login-blue-button" style="margin:200px 0 0 60px; width:240px"
  onclick="document.body.dataset.clicked = event.isTrusted ? 'quick' : 'quick-js'"><span>快速进入</span></div>
<div onclick="document.body.dataset.clicked='other'"><span>其他账号登录</span></div>
</body></html>"""

FULL_FORM = """<html><body>
<div>短信登录</div><div>密码登录</div>
<input placeholder="请输入手机号"><button onclick="document.body.dataset.clicked='login'">登录</button>
<label><input type="checkbox" id="keep">保持登录状态</label>
</body></html>"""

# 「保持登录状态」是个按钮(会话确认页那种):也要真鼠标点
KEEP_BUTTON = """<html><body>
<button style="margin:80px 0 0 120px"
  onclick="document.body.dataset.clicked = event.isTrusted ? 'keep' : 'keep-js'">保持登录状态</button>
</body></html>"""

HIDDEN_QUICK = """<html><body>
<button style="display:none" onclick="document.body.dataset.clicked='quick'">快速进入</button>
</body></html>"""

# 名字里带「快速进入」的长句(比如别的提示文案)不算按钮
LOOKALIKE = """<html><body>
<a onclick="document.body.dataset.clicked='quick'">快速进入闲鱼会员专区了解更多</a>
</body></html>"""


async def open_case(browser, login_html: str, main_html: str = MAIN):
    """开一页假闲鱼(登录框在跨站 iframe 里)。返回 (ctx, page, 主页面被请求的次数计数器)。"""
    ctx = await browser.new_context(viewport={"width": 1400, "height": 900})
    loads = {"main": 0}

    async def handle(route):
        url = route.request.url
        if url.startswith("https://www.goofish.com/"):
            loads["main"] += 1
            await route.fulfill(status=200, content_type="text/html; charset=utf-8", body=main_html)
        elif url.startswith("https://login.taobao.com/"):
            await route.fulfill(status=200, content_type="text/html; charset=utf-8", body=login_html)
        else:
            await route.fulfill(status=404, body="")

    await ctx.route("**/*", handle)
    page = await ctx.new_page()
    await page.goto("https://www.goofish.com/im")
    await page.wait_for_timeout(300)
    # 主文档确实看不到 iframe 里的按钮(这正是 dump_nodes 漏掉它的原因)
    assert await page.evaluate("document.body.innerText.includes('快速进入')") is False
    return ctx, page, loads


def login_frame(page):
    return next(f for f in page.frames if "login.taobao.com" in f.url)


async def run_case(browser, login_html: str, main_html: str = MAIN):
    ctx, page, _ = await open_case(browser, login_html, main_html)
    clicked, how = await _click_login_buttons(page)
    frame = login_frame(page)
    inner = await frame.evaluate("document.body.dataset.clicked || ''")
    keep = await frame.evaluate(
        "document.getElementById('keep') ? document.getElementById('keep').checked : null")
    await ctx.close()
    return clicked, how, inner, keep


async def run_assist(browser, main_html: str):
    """走一整趟 assist_login,读昵称的办法和执行端一样(页头 nick-- 元素,「登录」归一为空)。"""
    ctx, page, loads = await open_case(browser, QUICK, main_html)

    async def read_nick():
        return normalize_nick(await page.evaluate(
            "(sel) => { const el = document.querySelector(sel); return el ? el.textContent.trim() : ''; }",
            NICK_ANCHOR))

    reports: list[str] = []
    t0 = time.monotonic()
    clicked = await assist_login(page, read_nick, reports.append)
    took = time.monotonic() - t0
    nick = await read_nick()
    await ctx.close()
    return clicked, reports, took, nick, loads["main"]


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(channel="chrome", headless=True, args=["--site-per-process"])
        try:
            clicked, how, inner, _ = await run_case(browser, QUICK)
            assert (clicked, how, inner) == ("快速进入", "真鼠标", "quick"), (clicked, how, inner)
            print("1. 跨进程 iframe 里、偏在页面中间的「快速进入」-> 真鼠标点中了 OK")

            clicked, how, inner, _ = await run_case(browser, QUICK_NESTED)
            assert (clicked, how, inner) == ("快速进入", "真鼠标", "quick"), (clicked, how, inner)
            print("2. 按钮是 div>span、没有 button 标签 -> 真鼠标点中了,没碰「其他账号登录」 OK")

            clicked, how, inner, keep = await run_case(browser, FULL_FORM)
            assert inner == "", f"完整登录表单上不该点任何登录按钮: {inner}"
            assert keep is True and clicked == "保持登录状态" and how == "勾选", (clicked, how, keep)
            print("3. 只有短信/密码登录表单 -> 不点登录,只把「保持登录状态」勾上 OK")

            clicked, how, inner, _ = await run_case(browser, KEEP_BUTTON)
            assert (clicked, how, inner) == ("保持登录状态", "真鼠标", "keep"), (clicked, how, inner)
            print("4. 「保持登录状态」是按钮 -> 真鼠标点 OK")

            clicked, how, inner, _ = await run_case(browser, HIDDEN_QUICK)
            assert clicked is None and inner == "", (clicked, inner)
            print("5. 隐藏的「快速进入」-> 不点 OK")

            clicked, how, inner, _ = await run_case(browser, LOOKALIKE)
            assert clicked is None and inner == "", (clicked, inner)
            print("6. 只是文字里带「快速进入」的长句 -> 不点 OK")

            clicked, how, inner, _ = await run_case(browser, QUICK, MAIN_COVERED)
            assert (clicked, how, inner) == ("快速进入", "代码", "quick-js"), (clicked, how, inner)
            print("7. 按钮被遮罩盖住、真点落空 -> 看出来没点中,退回代码点 OK")

            clicked, reports, took, nick, main_loads = await run_assist(browser, MAIN)
            assert clicked == "快速进入" and nick == "土星耐心的黑水母", (clicked, nick)
            assert main_loads == 1, f"登回来了就不该刷新页面: 主页面请求了 {main_loads} 次"
            assert took < 6, f"登回来了就该马上交回,用了 {took:.1f}s"
            assert len(reports) == 1 and "真鼠标点「快速进入」" in reports[0] and "登回来了" in reports[0], reports
            print(f"8. 整趟:真鼠标点完 {took:.1f}s 登回来,不刷新,报给服务端「{reports[0]}」 OK")

            clicked, reports, took, nick, main_loads = await run_assist(browser, MAIN_COVERED)
            assert clicked == "快速进入" and nick == "", (clicked, nick)
            assert main_loads == 2, f"没登回来要刷新一次再点: 主页面请求了 {main_loads} 次"
            assert took < 17, f"整趟要压在服务端 20s 超时以内,用了 {took:.1f}s"
            assert len(reports) == 1 and "代码点" in reports[0] and "还没登回" in reports[0], reports
            print(f"9. 整趟:点不中、登不回 -> 刷新再点,{took:.1f}s 交回,报「{reports[0]}」 OK")
        finally:
            await browser.close()
    print("全部通过")


asyncio.run(main())

"""详情页删除自己的商品（清理测试商品用）。

用法：.venv/bin/python scripts/delete_item.py <item_id>
链路：/item?id=<id> → 卖家操作组「删除」→ 确认弹窗「确定」→ 回 personal 校验卡片消失。
无忧卖商品网页版下架被平台拦截，但「删除」可用（2026-09-09 实测）。
"""
import asyncio
import sys
import time

import httpx
from playwright.async_api import async_playwright

ADS_API = "http://127.0.0.1:50325"
USER_ID = "k1esvnuc"


async def main() -> None:
    item_id = sys.argv[1]
    env = httpx.get(f"{ADS_API}/api/v1/browser/active?user_id={USER_ID}", timeout=15).json()["data"]
    async with async_playwright() as pw:
        browser = await pw.chromium.connect_over_cdp(env["ws"]["puppeteer"])
        ctx = browser.contexts[0]
        page = await ctx.new_page()
        await page.goto(f"https://www.goofish.com/item?id={item_id}", wait_until="domcontentloaded")
        await page.wait_for_timeout(5000)
        if f"id={item_id}" not in page.url:
            print("FAIL: 详情页未加载", page.url)
            return

        # 点卖家操作组「删除」
        clicked = await page.evaluate("""
          (() => {
            const btns = Array.from(document.querySelectorAll('[class*="sellerButton--"]'));
            const del = btns.find(b => (b.innerText || "").trim() === "删除");
            if (!del) return null;
            del.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true}));
            return true;
          })()
        """)
        if not clicked:
            print("FAIL: 未找到「删除」按钮")
            return
        await page.wait_for_timeout(2500)

        # 确认弹窗「确定」
        confirmed = await page.evaluate("""
          (() => {
            const btns = Array.from(document.querySelectorAll("button, [role=button], [class*='btn']"));
            const ok = btns.find(b => /^(确定|确认)$/.test((b.innerText || "").trim())
                                   && b.offsetParent !== null);
            if (!ok) return null;
            ok.dispatchEvent(new MouseEvent("click", {bubbles: true, cancelable: true}));
            return true;
          })()
        """)
        print("确认弹窗:", confirmed)
        await page.wait_for_timeout(4000)
        await page.screenshot(path=str(__file__).replace("delete_item.py", "shots/delete_after.png"))
        await page.close()

        # 回 personal 校验卡片消失
        p2 = await ctx.new_page()
        await p2.goto("https://www.goofish.com/personal", wait_until="domcontentloaded")
        await p2.wait_for_timeout(5000)
        gone = await p2.evaluate(f"""
          (() => !document.body.innerHTML.includes("{item_id}"))()
        """)
        print("列表校验 item 已消失:", gone)
        await p2.close()


asyncio.run(main())

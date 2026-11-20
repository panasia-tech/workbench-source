/**
 * 任务管理「登录闲鱼」：独立 Chromium 打开 goofish.com，轮询 Cookie 直至含 _m_h5_tk（MTOP 签名）
 * （扫码 / 账密均在页内完成，与账号管理「扫码登录」同源。）
 */
import { chromium } from 'playwright'
import {
  createBrowserLaunchOptions,
  applyMonitoringStealth,
  getGoofishPlaywrightContextOptions,
  applyGoofishSensorAntiBot
} from './xianyu-playwright-config.js'
import { cookieHeaderOkForXianyuListen as listenCookieOk } from './xianyu-mtop-cookie-guard.js'
import { tryExtractGoofishNicknameFromPage } from './xianyu-goofish-playwright.js'
import { fetchDmProxyPlaywrightSettings } from './xianyu-playwright-dm-proxy.js'

/** 与服务端 refreshCookieViaGoofishSearch 类似：进搜索页便于落齐 h5api / Set-Cookie */
const GOOFISH_SEARCH_WARM_URL =
  'https://www.goofish.com/search?q=%E9%97%B2%E9%B1%BC&spm=a21ybx.search.searchInput.0'

function playwrightCookiesToHeader(cookies) {
  const map = new Map()
  for (const c of cookies) {
    map.set(c.name, c.value)
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

/**
 * @param {object} [opts]
 * @param {number} [opts.waitLoginTimeoutMs] 默认 10 分钟
 * @param {number} [opts.pollMs]
 * @param {string} [opts.startUrl]
 */
export async function runGoofishMtopPlaywrightLogin({
  waitLoginTimeoutMs = 600000,
  pollMs = 2000,
  startUrl = 'https://www.goofish.com/'
} = {}) {
  let proxySettings = null
  try {
    proxySettings = await fetchDmProxyPlaywrightSettings()
    if (proxySettings?.server) {
      console.log('[浏览器自动化][登录闲鱼] 使用大麦动态代理', proxySettings.server)
    }
  } catch (e) {
    console.warn('[浏览器自动化][登录闲鱼] 动态代理获取失败，直连', e?.message || e)
  }
  const launchBase = createBrowserLaunchOptions({
    headless: false,
    monitoring: true,
    useChromeChannel: false
  })
  const browser = await chromium.launch({
    ...launchBase,
    ...(proxySettings?.server ? { proxy: proxySettings } : {})
  })
  const deadline = Date.now() + waitLoginTimeoutMs

  try {
    const context = await browser.newContext(getGoofishPlaywrightContextOptions({ headless: false }))
    await applyGoofishSensorAntiBot(context)
    await applyMonitoringStealth(context)
    const page = await context.newPage()
    page.setDefaultNavigationTimeout(120000)
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' })

    while (Date.now() < deadline) {
      let cookies
      try {
        cookies = await context.cookies()
      } catch {
        await browser.close().catch(() => {})
        return {
          ok: false,
          error: 'browser_closed',
          msg: '登录窗口已关闭，未完成登录'
        }
      }
      let header = playwrightCookiesToHeader(cookies)
      if (listenCookieOk(header)) {
        const headerBeforeWarm = header
        const cookiesBeforeWarm = cookies
        try {
          await page.goto(GOOFISH_SEARCH_WARM_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 45000
          })
          await new Promise((r) => setTimeout(r, 1500))
          const c2 = await context.cookies()
          const h2 = playwrightCookiesToHeader(c2)
          if (listenCookieOk(h2)) {
            header = h2
            cookies = c2
          }
        } catch {
          /* 保持登录完成瞬时的 Cookie */
        }
        if (!listenCookieOk(header)) {
          header = headerBeforeWarm
          cookies = cookiesBeforeWarm
        }
        let goofishNickname = ''
        try {
          await new Promise((r) => setTimeout(r, 400))
          goofishNickname = String(await tryExtractGoofishNicknameFromPage(page))
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 64)
        } catch {
          /* */
        }
        const out = { ok: true, cookieHeader: header, cookies, goofishNickname }
        await browser.close().catch(() => {})
        return out
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }

    await browser.close().catch(() => {})
    return {
      ok: false,
      error: 'timeout',
      msg: '等待登录超时，请重试'
    }
  } catch (e) {
    await browser.close().catch(() => {})
    return { ok: false, error: String(e && e.message ? e.message : e) }
  }
}

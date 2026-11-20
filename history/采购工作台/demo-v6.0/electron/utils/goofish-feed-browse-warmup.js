/**
 * 后台模拟逛闲鱼首页：打开推荐流 → 随机点一个商品 → 进入详情后关闭浏览窗口。
 */
import {
  openGoofishUrlInAppBrowseWindow,
  hasLiveMh5TkInPartition,
  isGoofishBrowseWindowOpenForBrowserKey,
  isUserGoofishBrowseWindowActive
} from './xianyu-goofish-electron-browse-window.js'
import { partitionForListingAccount } from './xianyu-session-partition.js'
import { partitionHasAccountLogin } from './goofish-partition-cookie.js'
import { ensureAccountMh5TkInPartition } from './goofish-partition-mh5-refresh.js'

const GOOFISH_HOME = 'https://www.goofish.com/'
const FEED_WAIT_MS = 18_000
const ITEM_NAV_WAIT_MS = 22_000
const SCROLL_INTERVAL_MS = 700

const CLICK_RANDOM_FEED_JS = `(() => {
  const links = [...document.querySelectorAll('a[href*="item?id="]')].filter((a) => {
    try {
      const href = String(a.href || a.getAttribute('href') || '');
      return /item\\?id=\\d+/i.test(href);
    } catch {
      return false;
    }
  });
  if (!links.length) return { ok: false, reason: 'no_links', count: 0 };
  const idx = Math.floor(Math.random() * links.length);
  const el = links[idx];
  const href = String(el.href || el.getAttribute('href') || '');
  try {
    el.click();
  } catch (e) {
    return { ok: false, reason: 'click_failed', error: String(e && e.message ? e.message : e) };
  }
  return { ok: true, href, count: links.length, idx };
})()`

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function webContentsAlive(wc) {
  try {
    return !!(wc && typeof wc.isDestroyed === 'function' && !wc.isDestroyed())
  } catch {
    return false
  }
}

function isItemDetailUrl(url) {
  return /goofish\.com\/item\?id=\d+/i.test(String(url || ''))
}

function closeBrowseWindowAfterWarmup(win) {
  if (!win || win.isDestroyed?.()) return
  try {
    win.close()
  } catch {
    /* */
  }
}

async function waitForRandomFeedClick(wc) {
  const deadline = Date.now() + FEED_WAIT_MS
  let lastCount = 0
  while (Date.now() < deadline) {
    if (!webContentsAlive(wc)) return { ok: false, reason: 'destroyed' }
    try {
      const r = await wc.executeJavaScript(CLICK_RANDOM_FEED_JS, true)
      if (r?.ok) return { ok: true, ...r }
      lastCount = Number(r?.count) || 0
    } catch (e) {
      return { ok: false, reason: 'script_error', error: String(e?.message || e) }
    }
    try {
      await wc.executeJavaScript('window.scrollBy(0, Math.max(320, window.innerHeight * 0.6))', true)
    } catch {
      /* */
    }
    await sleep(SCROLL_INTERVAL_MS)
  }
  return { ok: false, reason: 'feed_timeout', count: lastCount }
}

async function waitForItemNavigation(wc, beforeUrl) {
  const start = String(beforeUrl || '').trim()
  const deadline = Date.now() + ITEM_NAV_WAIT_MS
  while (Date.now() < deadline) {
    if (!webContentsAlive(wc)) return { ok: false, reason: 'destroyed' }
    let cur = ''
    try {
      cur = String(wc.getURL() || '').trim()
    } catch {
      return { ok: false, reason: 'url_error' }
    }
    if (isItemDetailUrl(cur) && cur !== start) {
      return { ok: true, url: cur }
    }
    await sleep(350)
  }
  let finalUrl = ''
  try {
    finalUrl = String(wc.getURL() || '').trim()
  } catch {
    /* */
  }
  if (isItemDetailUrl(finalUrl)) return { ok: true, url: finalUrl }
  return { ok: false, reason: 'item_nav_timeout', url: finalUrl }
}

/**
 * @param {string} accountId
 * @param {{ electronDirname?: string }} [opts]
 */
export async function runGoofishFeedBrowseWarmup(accountId, opts = {}) {
  const id = String(accountId || '').trim()
  if (!id) return { ok: false, error: 'missing_account_id' }
  if (isUserGoofishBrowseWindowActive(id)) {
    return { ok: false, skipped: true, error: 'user_browsing', msg: '用户正在浏览闲鱼，跳过本次预热' }
  }
  if (!(await partitionHasAccountLogin(id))) {
    return { ok: false, error: 'need_login', msg: '账号未登录，请先进入闲鱼完成登录' }
  }

  const partition = partitionForListingAccount(id)
  if (!(await hasLiveMh5TkInPartition(partition))) {
    const mh5 = await ensureAccountMh5TkInPartition(id, {
      electronDirname: String(opts.electronDirname || '').trim()
    })
    if (!mh5.ok) {
      return {
        ok: false,
        error: mh5.reason || 'mh5_refresh_failed',
        msg: '账号登录态仍在，但暂时无法刷新签名凭证'
      }
    }
  }

  const openRes = await openGoofishUrlInAppBrowseWindow({
    url: GOOFISH_HOME,
    browserKey: id,
    sessionPartition: partition,
    taskWindow: true,
    allowEmptyCookieHeader: true,
    preferExistingSession: true,
    silentBackground: true,
    electronDirname: String(opts.electronDirname || '').trim()
  })
  if (!openRes.ok || !openRes.window) {
    return { ok: false, error: openRes.error || 'open_failed' }
  }

  const win = openRes.window
  const wc = win.webContents
  await sleep(1200)

  if (!webContentsAlive(wc)) {
    return { ok: false, error: 'window_closed' }
  }

  let beforeUrl = ''
  try {
    beforeUrl = String(wc.getURL() || '').trim()
  } catch {
    /* */
  }

  const clickRes = await waitForRandomFeedClick(wc)
  if (!clickRes.ok) {
    console.warn('[闲鱼逛首页预热] 未点到商品', id, clickRes)
    closeBrowseWindowAfterWarmup(win)
    return { ok: false, error: clickRes.reason || 'no_feed', detail: clickRes }
  }

  const navRes = await waitForItemNavigation(wc, beforeUrl)
  if (!navRes.ok) {
    console.warn('[闲鱼逛首页预热] 进入商品页超时', id, navRes)
    closeBrowseWindowAfterWarmup(win)
    return { ok: false, error: navRes.reason || 'item_nav_failed', detail: navRes, clicked: clickRes.href }
  }

  await sleep(800)
  closeBrowseWindowAfterWarmup(win)
  console.log('[闲鱼逛首页预热] 完成', id, navRes.url)
  return {
    ok: true,
    itemUrl: navRes.url,
    feedCount: clickRes.count,
    windowOpen: isGoofishBrowseWindowOpenForBrowserKey(id)
  }
}

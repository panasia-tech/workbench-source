/**
 * MTOP 风控 / 滑块：打开应用内闲鱼 /im，手动拖滑块；关窗写回 Cookie 并可自动重试私聊实时。
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  hasLiveMh5TkInPartition,
  openGoofishUrlInAppBrowseWindow
} from './xianyu-goofish-electron-browse-window.js'
import {
  hasImSliderAssistUsed,
  markImSliderAssistUsed,
  tryMarkLockOrderRiskAssistUsed,
  clearLockOrderRiskAssistUsed
} from './goofish-im-slider-once-guard.js'
import { partitionPersistIdForGoofishBrowseShell } from './xianyu-session-partition.js'
import { looksLikeImVerifyErrorText, inferMtopAntiBotBodyFromLockOrderError, shouldOpenImSliderAssistForChallenge } from './goofish-im-user-hints.js'
import { broadcastGoofishImVerifyOpened } from './goofish-im-verify-notify-bridge.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { isMtopAntiBotChallengeJson } = require(join(__dirname, '../lib/xy_sxjk/mtop-antibot-json.js'))

const ELECTRON_ROOT_DIR = join(__dirname, '..')
const GOOFISH_IM_URL = 'https://www.goofish.com/im'

/** @param {string} itemId */
export function buildGoofishPcItemDetailUrl(itemId) {
  const id = String(itemId || '').trim()
  if (!id) return ''
  return `https://www.goofish.com/item?id=${encodeURIComponent(id)}`
}

export function isMtopSliderPopupEnabled() {
  const v = String(process.env.XIANYU_MTOP_SLIDER_POPUP ?? '1').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'off'
}

export { isMtopAntiBotChallengeJson }

function extractMtopAntiBotVerifyUrlOnly(json) {
  if (!json || typeof json !== 'object') return ''
  const raw = String(json?.data?.url || '').trim()
  if (!raw || !/^https?:\/\//i.test(raw)) return ''
  if (!/punish|_____tmd_____|x5sec|captcha|risk\.taobao|\/sm\//i.test(raw)) return ''
  try {
    const fixed = raw.replace(/^(https?:\/\/[^/]+)\/+/i, (_, hostPort) => `${hostPort}/`)
    return new URL(fixed).href
  } catch {
    return raw
  }
}

function buildGoofishSearchUrlForRiskSlider(keyword) {
  const q = String(keyword || '').trim().slice(0, 120)
  if (!q) return ''
  try {
    return `https://www.goofish.com/search?q=${encodeURIComponent(q)}&spm=a21ybx.search.searchInput.0`
  } catch {
    return ''
  }
}

function resolveSliderOpenUrl(json, opts, browserKey) {
  const searchKw = String(opts.searchKeyword || opts.listen_keyword || '').trim().slice(0, 120)
  const isGuest = browserKey === '__mtop_risk__'
  const punishUrl = extractMtopAntiBotVerifyUrlOnly(json)
  const directToImOnly = opts.directToImPageOnly === true
  const itemId = String(opts.itemId || '').trim()
  const itemDetailUrl =
    String(opts.itemDetailUrl || '').trim() || (itemId ? buildGoofishPcItemDetailUrl(itemId) : '')
  const lockOrderFlow =
    opts.openItemDetailOnSlider === true || String(opts?.notifySource || '').trim() === 'lock_order'

  // 锁单：直接开商品详情（页内过滑块）；勿开阿里 punish 空壳页（易 mfJBs 失败）
  if (lockOrderFlow && itemDetailUrl) {
    return { url: itemDetailUrl, kind: 'item_detail' }
  }

  const forceIm =
    opts.openImPageOnSlider === true ||
    opts.retryImRealtimeOnClose === true ||
    directToImOnly ||
    (!isGuest && opts.openImPageOnSlider !== false && searchKw.length === 0)

  /** 连接私聊 / 私聊实时 / 打招呼：始终开 /im（旧流程），不跳 punish 验证码拦截页 */
  const imVerifyFlow =
    directToImOnly ||
    opts.openImPageOnSlider === true ||
    opts.retryImRealtimeOnClose === true
  if (imVerifyFlow && forceIm) {
    return { url: GOOFISH_IM_URL, kind: 'im' }
  }

  /** 监听等非私聊场景：优先站内页；无对应页时再兜底 punish */
  if (forceIm) return { url: GOOFISH_IM_URL, kind: 'im' }

  const useSearchPage = !isGuest && searchKw.length > 0 && opts.openImPageOnSlider !== true
  if (useSearchPage) {
    const u = buildGoofishSearchUrlForRiskSlider(searchKw)
    if (u) return { url: u, kind: 'search' }
  }

  if (punishUrl) return { url: punishUrl, kind: 'punish' }
  if (!isGuest) return { url: GOOFISH_IM_URL, kind: 'im' }
  return { url: '', kind: '' }
}

/**
 * @param {unknown} json
 * @param {{
 *   cookie?: string,
 *   cookieHeader?: string,
 *   playwrightCookies?: unknown[],
 *   browserKey?: string,
 *   accountId?: string,
 *   searchKeyword?: string,
 *   listen_keyword?: string,
 *   openImPageOnSlider?: boolean,
 *   retryImRealtimeOnClose?: boolean,
 *   directToImPageOnly?: boolean,
 *   forceSliderAssist?: boolean
 * }} [opts]
 */
export async function runMtopAntiBotVerifyAssist(json, opts = {}) {
  const empty = { opened: false, hint: '' }
  // 仅真风控/滑块；SESSION_EXPIRED、空壳 JSON 等不开窗
  if (!shouldOpenImSliderAssistForChallenge(json)) return empty

  if (!isMtopSliderPopupEnabled()) {
    return {
      opened: false,
      hint: '闲鱼要求验证，但本机已关闭自动弹窗。请去掉环境变量 XIANYU_MTOP_SLIDER_POPUP=0，或到账号管理重新登录后再试。'
    }
  }

  const cookieHeader = String(opts.cookie || opts.cookieHeader || '').trim()
  const playwrightCookies = Array.isArray(opts.playwrightCookies) ? opts.playwrightCookies : undefined
  let browserKey = String(opts.browserKey || opts.accountId || '').trim()
  if (!browserKey) browserKey = '__mtop_risk__'
  if (!cookieHeader) {
    return {
      opened: false,
      hint: '闲鱼要求验证，但当前没有可用的登录 Cookie。请到账号管理登录该账号后再试。'
    }
  }

  const { url: openUrl, kind: openKind } = resolveSliderOpenUrl(json, opts, browserKey)
  if (!openUrl) {
    return {
      opened: false,
      hint: '闲鱼返回了验证类错误，但没有可用的验证页链接。请到账号管理重新登录后再试。'
    }
  }

  const retryImOnClose = opts.retryImRealtimeOnClose === true
  const accountIdForPersist = browserKey !== '__mtop_risk__' ? browserKey : ''

  if (
    accountIdForPersist &&
    retryImOnClose &&
    opts.forceSliderAssist !== true &&
    hasImSliderAssistUsed(accountIdForPersist)
  ) {
    return {
      opened: false,
      hint: '本账号已试过滑块并自动重连仍失败，不再重复弹窗。请到账号管理重新登录，或手动点「预热实时」再试。'
    }
  }

  try {
    const sessionBrowserKey = browserKey !== '__mtop_risk__' ? browserKey : 'mtop_risk:__guest__'
    let injectHeader = cookieHeader
    let injectPw = playwrightCookies
    if (accountIdForPersist) {
      try {
        const { enrichAntiBotVerifyCookies } = await import('./goofish-risk-cookie-bridge.js')
        const enriched = await enrichAntiBotVerifyCookies(
          accountIdForPersist,
          cookieHeader,
          playwrightCookies
        )
        injectHeader = String(enriched?.cookieHeader || cookieHeader).trim()
        if (Array.isArray(enriched?.playwrightCookies) && enriched.playwrightCookies.length) {
          injectPw = enriched.playwrightCookies
        }
      } catch (e) {
        console.warn('[闲鱼风控] 合并验证窗 Cookie 失败（继续用原凭证）', e?.message || e)
      }
    }
    const browsePart = partitionPersistIdForGoofishBrowseShell(sessionBrowserKey)
    const partitionHasLiveSession = await hasLiveMh5TkInPartition(browsePart)
    // 开窗前记下当前 x5sec，并开始监听分区内 x5sec 写入（过码常写 taobao 域）
    if (accountIdForPersist) {
      try {
        const { pickX5secFromCookieHeader } = await import('./goofish-partition-cookie.js')
        const { stashX5secBeforeVerify } = await import('./goofish-cookie-uplink-hold.js')
        const { startX5secVerifyWatch } = await import('./goofish-x5sec-verify-watch.js')
        let beforeX5 = pickX5secFromCookieHeader(injectHeader)
        if (!beforeX5) {
          const { readAccountCookieForApi } = await import('./goofish-partition-cookie.js')
          const snap0 = await readAccountCookieForApi(accountIdForPersist, { requireUnb: false })
          if (snap0.ok) beforeX5 = pickX5secFromCookieHeader(snap0.cookie)
        }
        stashX5secBeforeVerify(accountIdForPersist, beforeX5)
        startX5secVerifyWatch(accountIdForPersist, browsePart)
        console.log(
          '[闲鱼风控] 开窗前已记录 x5sec',
          accountIdForPersist,
          beforeX5 ? `len=${beforeX5.length}` : '(无)',
          beforeX5 || ''
        )
      } catch (e) {
        console.warn('[闲鱼风控] 开窗前记录 x5sec 失败', e?.message || e)
      }
    }
    const r = await openGoofishUrlInAppBrowseWindow({
      url: openUrl,
      cookieHeader: injectHeader,
      playwrightCookies: injectPw,
      electronDirname: ELECTRON_ROOT_DIR,
      browserKey: sessionBrowserKey,
      allowEmptyCookieHeader: false,
      preferExistingSession: partitionHasLiveSession,
      openDevTools: false,
      postSliderBounceToGoofishIm:
        openKind !== 'im' &&
        openKind !== 'home' &&
        openKind !== 'item_detail' &&
        opts.directToImPageOnly !== true,
      imVerifyHintSource: String(opts?.notifySource || 'warmup').trim() || 'warmup'
    })
    if (!r.ok) {
      const err = String(r.error || '未知错误').trim().slice(0, 200)
      if (accountIdForPersist) {
        broadcastGoofishImVerifyOpened({
          accountId: accountIdForPersist,
          source: String(opts?.notifySource || 'warmup').trim() || 'warmup',
          fallback: true
        })
      }
      return {
        opened: false,
        hint: err ? `消息页未能打开：${err}` : '消息页未能打开，请稍后重试。'
      }
    }
    try {
      if (
        openKind === 'im' ||
        openKind === 'home' ||
        openKind === 'item_detail' ||
        opts.directToImPageOnly === true
      ) {
        r.window?.setTitle?.(
          openKind === 'home'
            ? '闲鱼 · 请拖动滑块'
            : openKind === 'item_detail'
              ? '闲鱼验证 · 请拖动滑块'
              : '闲鱼验证 · 请拖动滑块到最右边'
        )
      }
    } catch {
      /* */
    }
    console.log(
      '[闲鱼风控] 已打开闲鱼页面，请完成后关闭窗口。',
      sessionBrowserKey,
      openKind === 'im'
        ? '(消息页 /im)'
        : openKind === 'item_detail'
          ? '(商品详情页)'
          : openKind === 'search'
            ? '(站内搜索页)'
            : '(接口验证链)'
    )
    const { getPersistRiskBrowsePartitionCookie, getRetryGoofishImWarmupAfterRiskClose } =
      await import('./goofish-risk-cookie-bridge.js')
    const persistFn = getPersistRiskBrowsePartitionCookie()
    const retryImFn = getRetryGoofishImWarmupAfterRiskClose()
    if (accountIdForPersist && retryImOnClose) {
      markImSliderAssistUsed(accountIdForPersist)
    }
    const notifySource = String(opts?.notifySource || '').trim()
    const lockOrderFlow = notifySource === 'lock_order'
    if (r.window && accountIdForPersist) {
      const part = partitionPersistIdForGoofishBrowseShell(sessionBrowserKey)
      if (lockOrderFlow && openKind === 'item_detail') {
        attachGoofishItemDetailCloseHandlers(
          accountIdForPersist,
          part,
          r.window,
          'goofish_lock_order_item_detail_close'
        )
      } else if (persistFn) {
        r.window.once('closed', () => {
          if (lockOrderFlow) clearLockOrderRiskAssistUsed(accountIdForPersist)
          setTimeout(() => {
            void persistFn(accountIdForPersist, part, { source: 'goofish_slider_im_close' })
              .then((pr) => {
                if (pr?.ok) {
                  console.log(
                    '[闲鱼风控] 验证窗口关闭：已写回账号 Cookie',
                    accountIdForPersist,
                    pr?.x5secChanged === true ? 'x5sec已换新' : 'x5sec未换新'
                  )
                } else if (pr?.msg) {
                  console.warn('[闲鱼风控] 验证窗口关闭写回 Cookie:', pr.msg)
                }
                // x5sec 未换新：滑块多半没过完，重连只会继续风控；清标记方便用户再开验证窗
                if (pr?.ok && pr?.x5secChanged === false) {
                  void import('./goofish-im-slider-once-guard.js').then((m) => {
                    m.clearImSliderAssistUsed?.(accountIdForPersist)
                  })
                  console.warn(
                    '[闲鱼风控] 关窗未产生新 x5sec，跳过自动重连。请重新点「连接私聊」，拖完滑块并等通过后再关窗。',
                    accountIdForPersist
                  )
                  return
                }
                if (retryImOnClose && typeof retryImFn === 'function') {
                  console.log('[闲鱼风控] 正在自动重试私聊实时连接…', accountIdForPersist)
                  void Promise.resolve(retryImFn(accountIdForPersist))
                    .then(() => {
                      console.log(
                        '[闲鱼风控] 关窗后私聊实时重试流程已结束',
                        accountIdForPersist
                      )
                    })
                    .catch((e) =>
                      console.warn('[闲鱼风控] 关窗后自动重连私聊失败', e?.message || e)
                    )
                }
              })
              .catch((e) => {
                console.warn('[闲鱼风控] 验证窗口关闭写回异常', e?.message || e)
                if (retryImOnClose && typeof retryImFn === 'function') {
                  void Promise.resolve(retryImFn(accountIdForPersist)).catch(() => {})
                }
              })
          }, 350)
        })
      } else if (lockOrderFlow) {
        r.window.once('closed', () => clearLockOrderRiskAssistUsed(accountIdForPersist))
      }
    }
    broadcastGoofishImVerifyOpened({
      accountId: accountIdForPersist,
      source: String(opts?.notifySource || 'warmup').trim() || 'warmup',
      bannerShown: true
    })
    return { opened: true, hint: '' }
  } catch (e) {
    const err = String(e?.message || e || '').trim().slice(0, 200)
    return {
      opened: false,
      hint: err ? `打开验证窗口异常：${err}` : '打开验证窗口失败，请到账号管理重新登录后再试。'
    }
  }
}

export function mtopSliderVerifyIpcFields(v) {
  const hint = String(v?.hint || '').trim()
  const o = {}
  if (v?.opened) o.sliderVerifyOpened = true
  if (hint) o.sliderVerifyHint = hint
  return o
}

async function enrichGoofishImPageCookies(accountId, cookieHeader, playwrightCookies) {
  let injectHeader = String(cookieHeader || '').trim()
  let injectPw = Array.isArray(playwrightCookies) ? playwrightCookies : undefined
  try {
    const { enrichAntiBotVerifyCookies } = await import('./goofish-risk-cookie-bridge.js')
    const enriched = await enrichAntiBotVerifyCookies(accountId, injectHeader, injectPw)
    injectHeader = String(enriched?.cookieHeader || injectHeader).trim()
    if (Array.isArray(enriched?.playwrightCookies) && enriched.playwrightCookies.length) {
      injectPw = enriched.playwrightCookies
    }
  } catch (e) {
    console.warn('[闲鱼风控] 连接私聊合并 Cookie 失败（继续）', e?.message || e)
  }
  return { injectHeader, injectPw }
}

function attachGoofishImPageCloseHandlers(accountId, browsePart, win, source) {
  if (!win || win.isDestroyed?.()) return
  win.once('closed', () => {
    setTimeout(() => {
      void (async () => {
        try {
          const { getPersistRiskBrowsePartitionCookie, getRetryGoofishImWarmupAfterRiskClose } =
            await import('./goofish-risk-cookie-bridge.js')
          const persistFn = getPersistRiskBrowsePartitionCookie()
          const retryFn = getRetryGoofishImWarmupAfterRiskClose()
          if (typeof persistFn === 'function') {
            const pr = await persistFn(accountId, browsePart, { source })
            if (!pr?.ok && pr?.msg) {
              console.warn('[闲鱼风控] 消息页关窗写回 Cookie:', pr.msg)
            } else if (pr?.ok) {
              console.log('[闲鱼风控] 消息页关窗：已写回账号 Cookie', accountId)
            }
          }
          if (typeof retryFn === 'function') {
            console.log('[闲鱼风控] 消息页关窗后自动重连私聊…', accountId)
            void Promise.resolve(retryFn(accountId)).catch((e) =>
              console.warn('[闲鱼风控] 消息页关窗后私聊重连失败', e?.message || e)
            )
          }
        } catch (e) {
          console.warn('[闲鱼风控] 消息页关窗写回异常', e?.message || e)
        }
      })()
    }, 350)
  })
}

/**
 * 打开闲鱼消息页 /im（不阻塞等待关窗）。
 * @param {{
 *   accountId: string,
 *   cookieHeader: string,
 *   playwrightCookies?: unknown[],
 *   closePersistSource?: string,
 *   retryImOnClose?: boolean,
 *   notifySource?: string
 * }} opts
 */
export async function openGoofishImPageForAccount(opts) {
  const accountId = String(opts?.accountId || '').trim()
  const cookieHeader = String(opts?.cookieHeader || '').trim()
  if (!accountId || !cookieHeader) {
    return { ok: false, opened: false, hint: '缺少账号或登录信息' }
  }

  const { injectHeader, injectPw } = await enrichGoofishImPageCookies(
    accountId,
    cookieHeader,
    opts.playwrightCookies
  )
  const sessionBrowserKey = accountId
  const browsePart = partitionPersistIdForGoofishBrowseShell(sessionBrowserKey)
  const partitionHasLiveSession = await hasLiveMh5TkInPartition(browsePart)
  const notifySource = String(opts?.notifySource || 'warmup').trim() || 'warmup'
  const r = await openGoofishUrlInAppBrowseWindow({
    url: GOOFISH_IM_URL,
    cookieHeader: injectHeader,
    playwrightCookies: injectPw,
    electronDirname: ELECTRON_ROOT_DIR,
    browserKey: sessionBrowserKey,
    allowEmptyCookieHeader: false,
    preferExistingSession: partitionHasLiveSession,
    openDevTools: false,
    postSliderBounceToGoofishIm: true,
    imVerifyHintSource: notifySource
  })
  if (!r.ok || !r.window) {
    const err = String(r?.error || '').trim().slice(0, 200)
    broadcastGoofishImVerifyOpened({
      accountId,
      source: notifySource,
      fallback: true
    })
    return {
      ok: false,
      opened: false,
      hint: err ? `闲鱼消息页未能打开：${err}` : '闲鱼消息页未能打开，请稍后重试。'
    }
  }

  try {
    r.window.setTitle('闲鱼验证 · 请拖动滑块到最右边')
  } catch {
    /* */
  }
  const closePersistSource =
    String(opts?.closePersistSource || '').trim() || 'goofish_im_page_close'
  if (opts?.retryImOnClose !== false) {
    attachGoofishImPageCloseHandlers(accountId, browsePart, r.window, closePersistSource)
  }
  broadcastGoofishImVerifyOpened({
    accountId,
    source: notifySource,
    bannerShown: true
  })
  console.log('[闲鱼风控] 已打开闲鱼消息页 /im', accountId, closePersistSource)
  return { ok: true, opened: true, hint: '', window: r.window }
}

/**
 * 私聊发信遇风控时：为对应账号打开闲鱼消息页，便于用户完成验证。
 * @param {{ accountId: string, cookieHeader: string, errText?: string }} opts
 */
export async function tryOpenGoofishImPageOnGreetingVerifyFailure(opts) {
  const accountId = String(opts?.accountId || '').trim()
  const cookieHeader = String(opts?.cookieHeader || '').trim()
  const errText = String(opts?.errText || '').trim()
  if (!accountId || !cookieHeader) return { opened: false }
  if (!looksLikeImVerifyErrorText(errText)) return { opened: false }
  const r = await openGoofishImPageForAccount({
    accountId,
    cookieHeader,
    closePersistSource: 'goofish_im_greeting_verify_close',
    retryImOnClose: true,
    notifySource: 'greeting'
  })
  return { opened: !!r?.opened, hint: r?.hint || '' }
}

function attachGoofishItemDetailCloseHandlers(accountId, browsePart, win, source) {
  if (!win || win.isDestroyed?.()) return
  win.once('closed', () => {
    clearLockOrderRiskAssistUsed(accountId)
    setTimeout(() => {
      void (async () => {
        try {
          const { getPersistRiskBrowsePartitionCookie } = await import('./goofish-risk-cookie-bridge.js')
          const persistFn = getPersistRiskBrowsePartitionCookie()
          if (typeof persistFn !== 'function') return
          const pr = await persistFn(accountId, browsePart, { source })
          if (!pr?.ok && pr?.msg) {
            console.warn('[闲鱼风控] 商品详情关窗写回 Cookie:', pr.msg)
          }
        } catch (e) {
          console.warn('[闲鱼风控] 商品详情关窗写回异常', e?.message || e)
        }
      })()
    }, 350)
  })
}

/**
 * 锁单风控：用锁单账号打开商品详情页，便于用户完成滑块验证。
 * @param {{
 *   accountId: string,
 *   cookieHeader: string,
 *   itemId: string,
 *   playwrightCookies?: unknown[],
 *   closePersistSource?: string,
 *   notifySource?: string
 * }} opts
 */
export async function openGoofishItemDetailPageForAccount(opts) {
  const accountId = String(opts?.accountId || '').trim()
  const cookieHeader = String(opts?.cookieHeader || '').trim()
  const itemId = String(opts?.itemId || '').trim()
  const itemUrl = buildGoofishPcItemDetailUrl(itemId)
  if (!accountId || !cookieHeader || !itemUrl) {
    return { ok: false, opened: false, hint: '缺少账号、登录信息或商品 ID' }
  }

  const { injectHeader, injectPw } = await enrichGoofishImPageCookies(
    accountId,
    cookieHeader,
    opts.playwrightCookies
  )
  const sessionBrowserKey = accountId
  const browsePart = partitionPersistIdForGoofishBrowseShell(sessionBrowserKey)
  const partitionHasLiveSession = await hasLiveMh5TkInPartition(browsePart)
  const notifySource = String(opts?.notifySource || 'lock_order').trim() || 'lock_order'
  const r = await openGoofishUrlInAppBrowseWindow({
    url: itemUrl,
    cookieHeader: injectHeader,
    playwrightCookies: injectPw,
    electronDirname: ELECTRON_ROOT_DIR,
    browserKey: sessionBrowserKey,
    allowEmptyCookieHeader: false,
    preferExistingSession: partitionHasLiveSession,
    openDevTools: false,
    postSliderBounceToGoofishIm: false,
    imVerifyHintSource: notifySource
  })
  if (!r.ok || !r.window) {
    const err = String(r?.error || '').trim().slice(0, 200)
    broadcastGoofishImVerifyOpened({
      accountId,
      source: notifySource,
      fallback: true
    })
    return {
      ok: false,
      opened: false,
      hint: err ? `商品详情页未能打开：${err}` : '商品详情页未能打开，请稍后重试。'
    }
  }

  try {
    r.window.setTitle('闲鱼验证 · 请拖动滑块')
  } catch {
    /* */
  }
  const closePersistSource =
    String(opts?.closePersistSource || '').trim() || 'goofish_lock_order_item_detail_close'
  attachGoofishItemDetailCloseHandlers(accountId, browsePart, r.window, closePersistSource)
  broadcastGoofishImVerifyOpened({
    accountId,
    source: notifySource,
    bannerShown: true
  })
  console.log('[闲鱼风控] 已打开商品详情页', accountId, itemId, closePersistSource)
  return { ok: true, opened: true, hint: '', window: r.window }
}

/**
 * 锁单遇风控：优先走 MTOP 验证链，否则为锁单账号打开商品详情页。
 * @param {{
 *   accountId: string,
 *   cookieHeader: string,
 *   itemId: string,
 *   errText?: string,
 *   antibotJson?: unknown
 * }} opts
 */
export async function runLockOrderRiskVerifyAssist(opts) {
  const empty = { opened: false, itemPageOpened: false, sliderVerifyOpened: false, hint: '' }
  const accountId = String(opts?.accountId || '').trim()
  const cookieHeader = String(opts?.cookieHeader || '').trim()
  const itemId = String(opts?.itemId || '').trim()
  const errText = String(opts?.errText || '').trim()
  if (!accountId || !cookieHeader || !itemId) return empty
  if (!looksLikeImVerifyErrorText(errText) && !opts?.antibotJson) return empty

  if (!tryMarkLockOrderRiskAssistUsed(accountId)) {
    return {
      ...empty,
      hint: '该秒拍账号已打开验证页，请先完成滑块后再继续锁单。'
    }
  }

  let opened = false
  try {
    const challengeBody =
      opts?.antibotJson && typeof opts.antibotJson === 'object'
        ? opts.antibotJson
        : inferMtopAntiBotBodyFromLockOrderError(errText)

    if (challengeBody && shouldOpenImSliderAssistForChallenge(challengeBody)) {
      try {
        const v = await runMtopAntiBotVerifyAssist(challengeBody, {
          cookieHeader,
          accountId,
          browserKey: accountId,
          itemId,
          openItemDetailOnSlider: true,
          openImPageOnSlider: false,
          retryImRealtimeOnClose: false,
          forceSliderAssist: true,
          notifySource: 'lock_order'
        })
        const hint = String(v?.hint || '').trim()
        if (v?.opened) {
          opened = true
          return {
            opened: true,
            itemPageOpened: true,
            sliderVerifyOpened: true,
            hint
          }
        }
        if (hint) return { ...empty, hint }
      } catch (e) {
        console.warn('[闲鱼风控] 锁单风控辅助失败', e?.message || e)
      }
    }

    const r = await openGoofishItemDetailPageForAccount({
      accountId,
      cookieHeader,
      itemId,
      closePersistSource: 'goofish_lock_order_item_detail_close',
      notifySource: 'lock_order'
    })
    opened = !!r?.opened
    return {
      opened,
      itemPageOpened: opened,
      sliderVerifyOpened: opened,
      hint: r?.hint || ''
    }
  } finally {
    if (!opened) clearLockOrderRiskAssistUsed(accountId)
  }
}

/**
 * 锁单失败且错误像风控时：打开商品详情页引导过滑块。
 * @param {{ accountId: string, cookieHeader: string, itemId: string, errText?: string }} opts
 */
export async function tryOpenGoofishItemDetailOnLockOrderVerifyFailure(opts) {
  const accountId = String(opts?.accountId || '').trim()
  const cookieHeader = String(opts?.cookieHeader || '').trim()
  const itemId = String(opts?.itemId || '').trim()
  const errText = String(opts?.errText || '').trim()
  if (!accountId || !cookieHeader || !itemId) return { opened: false }
  if (!looksLikeImVerifyErrorText(errText)) return { opened: false }
  if (!tryMarkLockOrderRiskAssistUsed(accountId)) {
    return {
      opened: false,
      hint: '该秒拍账号已打开验证页，请先完成滑块后再继续锁单。'
    }
  }
  const r = await openGoofishItemDetailPageForAccount({
    accountId,
    cookieHeader,
    itemId,
    closePersistSource: 'goofish_lock_order_item_detail_close',
    notifySource: 'lock_order'
  })
  if (!r?.opened) clearLockOrderRiskAssistUsed(accountId)
  return { opened: !!r?.opened, hint: r?.hint || '' }
}

/**
 * 账号管理「连接私聊」：打开闲鱼消息页 https://www.goofish.com/im ，关窗后写回 Cookie。
 * @param {{
 *   accountId: string,
 *   cookieHeader: string,
 *   playwrightCookies?: unknown[]
 * }} opts
 */
export async function openGoofishImPageForManualConnectAndWaitClose(opts) {
  const accountId = String(opts?.accountId || '').trim()
  const cookieHeader = String(opts?.cookieHeader || '').trim()
  if (!accountId || !cookieHeader) {
    return { ok: false, hint: '缺少账号或登录信息' }
  }

  const r = await openGoofishImPageForAccount({
    accountId,
    cookieHeader,
    playwrightCookies: opts.playwrightCookies,
    closePersistSource: 'goofish_im_manual_connect_close',
    retryImOnClose: false,
    notifySource: 'manual_connect'
  })
  if (!r.ok || !r.opened) {
    return { ok: false, hint: r.hint || '闲鱼消息页未能打开，请稍后重试。' }
  }

  await new Promise((resolve) => {
    const win = r.window
    if (!win || win.isDestroyed()) {
      resolve(undefined)
      return
    }
    win.once('closed', () => setTimeout(resolve, 350))
  })

  const browsePart = partitionPersistIdForGoofishBrowseShell(accountId)
  try {
    const { getPersistRiskBrowsePartitionCookie } = await import('./goofish-risk-cookie-bridge.js')
    const persistFn = getPersistRiskBrowsePartitionCookie()
    if (typeof persistFn === 'function') {
      const pr = await persistFn(accountId, browsePart, { source: 'goofish_im_manual_connect_close' })
      if (!pr?.ok && pr?.msg) {
        console.warn('[闲鱼风控] 消息页关窗写回 Cookie:', pr.msg)
      }
    }
  } catch (e) {
    console.warn('[闲鱼风控] 消息页关窗写回异常', e?.message || e)
  }

  return { ok: true, hint: '' }
}

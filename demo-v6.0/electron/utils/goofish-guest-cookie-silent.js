/**
 * 游客 Cookie 静默获取：后台打开闲鱼主页（不抢焦点），等待 _m_h5_tk 后写入 guest JSON。
 */
import { session } from 'electron'
import { GOOFISH_HOME_URL } from '../config/goofish.js'
import { setGuestCookieHeader } from './goofish-guest-cookies-store.js'
import { cookiesToHeaderFromSession } from './goofish-partition-cookie.js'
import { headerHasMh5Tk } from './xianyu-goofish-open-session.js'
import {
  closeGoofishBrowseWindowAndWait,
  hasLiveMh5TkInPartition,
  openGoofishUrlInAppBrowseWindow,
  partitionPersistIdForGoofishBrowseShell
} from './xianyu-goofish-electron-browse-window.js'

const GUEST_BROWSER_KEY = '__guest_auth__'
const DEFAULT_TIMEOUT_MS = 25_000
const POLL_INTERVAL_MS = 800
const MIN_INTERVAL_MS = 60_000

let lastSilentCaptureAt = 0
/** @type {Promise<{ ok: boolean, msg?: string, cookieHeader?: string, updatedAt?: string, skipped?: boolean }> | null} */
let silentCaptureInflight = null

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function silentCaptureTimeoutMs() {
  const n = parseInt(String(process.env.XIANYU_GUEST_SILENT_CAPTURE_TIMEOUT_MS || '25000'), 10)
  return Number.isFinite(n) && n >= 5000 ? n : DEFAULT_TIMEOUT_MS
}

function isSilentGuestCaptureEnabled() {
  const v = String(process.env.XIANYU_GUEST_SILENT_CAPTURE ?? '1').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'no'
}

/** @param {string} partition @param {number} timeoutMs */
async function waitForGuestMh5(partition, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await hasLiveMh5TkInPartition(partition)) return true
    await sleep(POLL_INTERVAL_MS)
  }
  return false
}

/**
 * @param {{ guestCookiesFilePath: string, electronDirname?: string, taskId?: string, force?: boolean }} opts
 */
async function runGuestCookieSilentCapture(opts = {}) {
  const guestCookiesFilePath = String(opts?.guestCookiesFilePath || '').trim()
  if (!guestCookiesFilePath) return { ok: false, msg: '未配置游客 Cookie 存储' }
  if (!isSilentGuestCaptureEnabled()) return { ok: false, msg: '静默获取已关闭' }

  const taskId = String(opts?.taskId || '').trim()
  const scope = taskId ? 'task' : 'global'
  const partition = partitionPersistIdForGoofishBrowseShell(GUEST_BROWSER_KEY)
  const now = Date.now()
  if (!opts.force && now - lastSilentCaptureAt < MIN_INTERVAL_MS) {
    if (await hasLiveMh5TkInPartition(partition)) {
      try {
        const header = String(await cookiesToHeaderFromSession(session.fromPartition(partition))).trim()
        if (headerHasMh5Tk(header)) {
          const saved = await setGuestCookieHeader(guestCookiesFilePath, {
            scope,
            taskId,
            cookieHeader: header
          })
          if (saved.ok) {
            return {
              ok: true,
              cookieHeader: header,
              updatedAt: saved.updatedAt,
              skipped: true
            }
          }
        }
      } catch {
        /* 继续走完整静默加载 */
      }
    }
    return { ok: false, msg: '静默获取冷却中' }
  }

  const electronDirname = String(opts.electronDirname || '').trim()
  const timeoutMs = silentCaptureTimeoutMs()
  /** @type {import('electron').BrowserWindow | null | undefined} */
  let openedWin = null
  const started = Date.now()

  try {
    const openRes = await openGoofishUrlInAppBrowseWindow({
      url: GOOFISH_HOME_URL,
      browserKey: GUEST_BROWSER_KEY,
      allowEmptyCookieHeader: true,
      preferExistingSession: true,
      silentBackground: true,
      electronDirname
    })
    if (!openRes.ok) {
      lastSilentCaptureAt = Date.now()
      console.warn('[游客Cookie采集] 打开失败 %s', openRes.error || '')
      return { ok: false, msg: openRes.error || '后台打开闲鱼页失败' }
    }

    openedWin = openRes.window
    const got = await waitForGuestMh5(partition, timeoutMs)
    let captured = ''
    if (got) {
      captured = String(await cookiesToHeaderFromSession(session.fromPartition(partition))).trim()
    }

    if (openedWin && !openedWin.isDestroyed()) {
      try {
        openedWin.close()
      } catch {
        /* */
      }
      await closeGoofishBrowseWindowAndWait(openedWin, 3000).catch(() => {})
    }

    lastSilentCaptureAt = Date.now()
    const elapsedMs = Date.now() - started

    if (!headerHasMh5Tk(captured)) {
      console.warn('[游客Cookie采集] 超时 耗时毫秒=%d', elapsedMs)
      return { ok: false, msg: '静默获取超时，请稍后重试或手动授权' }
    }

    const saved = await setGuestCookieHeader(guestCookiesFilePath, {
      scope,
      taskId,
      cookieHeader: captured
    })
    if (!saved.ok) {
      return { ok: false, msg: saved.error || '保存游客 Cookie 失败' }
    }

    console.log('[游客Cookie采集] 成功 范围=%s 耗时毫秒=%d', scope, elapsedMs)
    return {
      ok: true,
      cookieHeader: captured,
      updatedAt: saved.updatedAt
    }
  } catch (e) {
    lastSilentCaptureAt = Date.now()
    if (openedWin && !openedWin.isDestroyed()) {
      try {
        openedWin.close()
      } catch {
        /* */
      }
    }
    const msg = String(e?.message || e)
    console.warn('[游客Cookie采集] 异常 %s', msg)
    return { ok: false, msg }
  }
}

/**
 * @param {{ guestCookiesFilePath: string, electronDirname?: string, taskId?: string, force?: boolean }} opts
 */
export async function captureGuestCookieSilent(opts = {}) {
  if (silentCaptureInflight) return silentCaptureInflight
  silentCaptureInflight = runGuestCookieSilentCapture(opts).finally(() => {
    silentCaptureInflight = null
  })
  return silentCaptureInflight
}

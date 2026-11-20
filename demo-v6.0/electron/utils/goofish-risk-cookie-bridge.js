/**
 * 风控验证窗 / 消息页关窗：从 browse 分区读 Cookie 写回账号（无 HTTP 保活）。
 */
import { session, BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { cookiesToHeaderFromSession, cookieHeaderHasUnb, pickX5secFromCookieHeader } from './goofish-partition-cookie.js'
import { headerHasMh5Tk } from './xianyu-goofish-open-session.js'
import { partitionForListingAccount } from './xianyu-session-partition.js'
import { exportPlaywrightCookiesFromElectronSession } from './xianyu-playwright-cookies-to-electron.js'
import { verifyGoofishMtopWithUserPageNav } from './xianyu-goofish-mtop-verify.js'
import { isGoofishImAutoWarmupEnabled } from './goofish-im-warmup-policy.js'
import { runGoofishImWarmupWithPersist } from './goofish-im-connection-facade.js'
import { clearImSliderAssistUsed } from './goofish-im-slider-once-guard.js'
import { looksLikeImVerifyErrorText } from './goofish-im-user-hints.js'
import { isAccountGoofishEmbedViewAlive } from '../ipc/accounts-goofish-embed.js'
import {
  applyAccountMtopLoginVerifyResult,
  readAccountJson,
  xianyuMtopSessionPath
} from '../ipc/accounts.js'
import {
  pickAvatarFromUserPageNavJson,
  pickDisplayNameFromUserPageNavJson
} from './goofish-account-profile.js'
import { repersistAccountPartitionCookiesForDisk, flushAccountPartitionStore } from './goofish-partition-persist.js'
import { notifyAccountCookiePersisted } from './goofish-account-profile-sync.js'
import {
  markAccountCookieUplinkHold,
  takeX5secBeforeVerify
} from './goofish-cookie-uplink-hold.js'
import { resolveAndApplyNewX5secAfterVerifyClose } from './goofish-x5sec-verify-watch.js'
import { sxjkBackendPost } from './sxjk-backend-client.js'

/** @type {string} */
let bridgeAccountsDir = ''

/** @type {null | (() => import('electron').BrowserWindow | null | undefined)} */
let bridgeGetMainWindow = null

/** @type {null | ((accountId: string, partitionKey: string, opts?: object) => Promise<{ ok?: boolean, msg?: string }>)} */
let persistRiskBrowsePartitionCookieRef = null

/** @type {null | ((accountId: string) => Promise<void>)} */
let retryGoofishImWarmupAfterRiskCloseRef = null

const goofishImWarmupInflight = new Set()

function resolveBridgeMainWindow() {
  if (typeof bridgeGetMainWindow === 'function') {
    try {
      const w = bridgeGetMainWindow()
      if (w && !w.isDestroyed()) return w
    } catch {
      /* */
    }
  }
  try {
    return BrowserWindow.getAllWindows().find((w) => w && !w.isDestroyed()) || null
  } catch {
    return null
  }
}

function mergeCookieHeaderWithPrev(prevHeader, nextHeader) {
  const prev = String(prevHeader || '').trim()
  const next = String(nextHeader || '').trim()
  if (!next) return prev
  if (!prev) return next
  const map = new Map()
  for (const part of prev.split(';')) {
    const p = part.trim()
    if (!p) continue
    const eq = p.indexOf('=')
    if (eq <= 0) continue
    map.set(p.slice(0, eq).trim(), p.slice(eq + 1))
  }
  for (const part of next.split(';')) {
    const p = part.trim()
    if (!p) continue
    const eq = p.indexOf('=')
    if (eq <= 0) continue
    map.set(p.slice(0, eq).trim(), p.slice(eq + 1))
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

function goofishProfileFromUserPageNavVerify(vr, prev = {}) {
  const apply = {}
  if (vr?.ok) {
    const nick = pickDisplayNameFromUserPageNavJson(vr.json)
    const avatar = pickAvatarFromUserPageNavJson(vr.json, '')
    if (nick) apply.goofishNickname = nick
    else if (prev?.goofishNickname) apply.goofishNickname = prev.goofishNickname
    if (avatar) apply.goofishAvatar = avatar
    else if (prev?.goofishAvatar) apply.goofishAvatar = prev.goofishAvatar
  }
  return { apply }
}

async function captureLoginSnapshotFromPartition(partition) {
  try {
    const part = String(partition || '').trim()
    if (!part) return { ok: false, msg: 'missing_partition' }
    const sess = session.fromPartition(part)
    const header = String(await cookiesToHeaderFromSession(sess)).trim()
    if (!headerHasMh5Tk(header)) {
      return { ok: false, msg: 'partition_no_valid_cookie' }
    }
    const playwrightCookies = await exportPlaywrightCookiesFromElectronSession(sess)
    return { ok: true, cookieHeader: header, playwrightCookies }
  } catch (e) {
    return { ok: false, msg: String(e?.message || e) }
  }
}

async function backupAccountPartitionCookieToDisk(accountsDir, accountId, opts = {}) {
  const id = String(accountId || '').trim()
  if (!id || !accountsDir) return { ok: false }
  const snap = await captureLoginSnapshotFromPartition(partitionForListingAccount(id))
  if (!snap?.ok) return { ok: false }
  const live = String(snap.cookieHeader || '').trim()
  const perPath = xianyuMtopSessionPath(accountsDir, id)
  let prev = null
  try {
    prev = JSON.parse(await fs.readFile(perPath, 'utf-8'))
  } catch {
    /* */
  }
  const merged = prev?.cookieHeader
    ? mergeCookieHeaderWithPrev(String(prev.cookieHeader), live)
    : live
  const payload = {
    ...(prev && typeof prev === 'object' ? prev : {}),
    cookieHeader: merged,
    updatedAt: new Date().toISOString(),
    source: String(opts?.source || 'partition_backup'),
    accountId: id,
    ...(Array.isArray(snap.playwrightCookies) && snap.playwrightCookies.length
      ? { playwrightCookies: snap.playwrightCookies }
      : {})
  }
  await fs.mkdir(dirname(perPath), { recursive: true })
  await fs.writeFile(perPath, JSON.stringify(payload, null, 2), 'utf-8')
  return { ok: true, hasUnb: cookieHeaderHasUnb(merged) }
}

/**
 * 主进程立刻上行本机分区 Cookie 到服务端（不等渲染进程 1.5s 防抖）。
 * 保证关窗重连 / 下次「连接私聊」前，库里已是新区（含 x5sec）。
 * @param {string} accountId
 * @param {string} [cookieHeader]
 * @param {{ source?: string }} [opts]
 */
async function forceUplinkAccountCookieToCloud(accountId, cookieHeader = '', opts = {}) {
  const id = String(accountId || '').trim()
  if (!id) return { ok: false, skipped: true, error: 'missing_id' }
  markAccountCookieUplinkHold(id, 15000)
  let cookie = String(cookieHeader || '').trim()
  if (!headerHasMh5Tk(cookie)) {
    try {
      const { readAccountCookieForApi } = await import('./goofish-partition-cookie.js')
      const snap = await readAccountCookieForApi(id, { requireUnb: false })
      if (snap.ok) cookie = String(snap.cookie || '').trim()
    } catch {
      /* */
    }
  }
  if (!headerHasMh5Tk(cookie)) {
    console.warn('[闲鱼风控桥接] 关窗上行跳过：分区无有效 _m_h5_tk', id)
    return { ok: false, skipped: true, error: 'no_mh5' }
  }
  let prevAcc = {}
  try {
    prevAcc = await readAccountJson(bridgeAccountsDir, id)
  } catch {
    /* */
  }
  const item = {
    client_id: id,
    login_status: '有效',
    synced_at: new Date().toISOString(),
    mtop_cookie: cookie,
    account: String(prevAcc?.phone || prevAcc?.account || '').trim(),
    nickname: String(prevAcc?.goofishNickname || prevAcc?.nickname || '').trim(),
    avatar: String(prevAcc?.goofishAvatar || prevAcc?.avatar || '').trim(),
    goofishImRealtimeOk: prevAcc?.goofishImRealtimeOk === true
  }
  try {
    await sxjkBackendPost(
      '/app/xy-sxjk/pcAccounts/syncCookies',
      { items: [item] },
      { timeoutMs: 25000 }
    )
    console.log(
      '[闲鱼风控桥接] 关窗 Cookie 已同步到云端',
      id,
      String(opts?.source || '').trim() || 'risk_close',
      pickX5secFromCookieHeader(cookie) ? '有x5sec' : '无x5sec'
    )
    // 上行成功后再续持一会，挡住迟到的 pull
    markAccountCookieUplinkHold(id, 10000)
    return { ok: true, synced: true }
  } catch (e) {
    console.warn('[闲鱼风控桥接] 关窗 Cookie 上行云端失败', id, e?.message || e)
    return { ok: false, error: String(e?.message || e) }
  }
}

async function persistAccountMtopCookieFromRiskBrowseSession(accountId, partitionKey, persistOpts = {}) {
  const id = String(accountId || '').trim()
  if (!id || !bridgeAccountsDir) return { ok: false, msg: '缺少账号或账户目录' }
  const part = String(partitionKey || '').trim()
  if (!part) return { ok: false, msg: '缺少分区' }
  const sourceTag = String(persistOpts?.source || '').trim() || 'goofish_risk_verify_close'

  // 先挡住 pull，再落盘，避免上行前被旧云端盖掉
  markAccountCookieUplinkHold(id, 20000)

  // 关窗后先把会话 Cookie 改持久并 flush，避免 x5sec 只在内存里
  try {
    await repersistAccountPartitionCookiesForDisk(id)
    await flushAccountPartitionStore(id)
  } catch (e) {
    console.warn('[闲鱼风控桥接] 关窗后分区落盘失败', id, e?.message || e)
  }

  const snapshot = await captureLoginSnapshotFromPartition(part)
  if (!snapshot?.ok) {
    return {
      ok: false,
      msg: '窗口里未读到完整 Cookie（可能验证未完成或已过期），可再开一次验证页或重新登录。'
    }
  }
  const s = String(snapshot.cookieHeader || '').trim()
  if (!headerHasMh5Tk(s)) {
    return {
      ok: false,
      msg: '窗口里未读到完整 Cookie（可能验证未完成或已过期），可再开一次验证页或重新登录。'
    }
  }

  // 验证窗与账号分区同罐：过码可能写在 taobao/punish 域，需扫描各域并镜像到 goofish
  const beforeX5 = takeX5secBeforeVerify(id)
  const x5Resolve = await resolveAndApplyNewX5secAfterVerifyClose(id, beforeX5, part)
  // 镜像后再读一次分区头，供上行 / nav
  let cookieForSync = s
  try {
    const snapAfter = await captureLoginSnapshotFromPartition(part)
    if (snapAfter?.ok && headerHasMh5Tk(snapAfter.cookieHeader)) {
      cookieForSync = String(snapAfter.cookieHeader || '').trim()
    }
  } catch {
    /* */
  }
  const x5 = pickX5secFromCookieHeader(cookieForSync) || x5Resolve.after || ''
  if (!x5Resolve.changed) {
    console.warn(
      '[闲鱼风控桥接] 关窗 x5sec 未换新，后续私聊多半仍会风控',
      id
    )
  }

  const vr = await verifyGoofishMtopWithUserPageNav(cookieForSync)
  const chkAt = new Date().toISOString()
  let prevAcc = {}
  try {
    prevAcc = await readAccountJson(bridgeAccountsDir, id)
  } catch {
    /* */
  }
  const { apply } = goofishProfileFromUserPageNavVerify(vr, prevAcc)
  await applyAccountMtopLoginVerifyResult(bridgeAccountsDir, id, {
    sessionValid: !!vr.ok,
    loginCheckUpdatedAt: chkAt,
    ...apply
  })
  try {
    await backupAccountPartitionCookieToDisk(bridgeAccountsDir, id, { source: sourceTag })
  } catch (e) {
    console.warn('[闲鱼风控桥接] 关窗后备份分区 Cookie 失败', id, e?.message || e)
  }

  // 主进程同步等待上行完成，再通知渲染（防抖二次 sync）并返回 → 之后才自动重连私聊
  const uplink = await forceUplinkAccountCookieToCloud(id, cookieForSync, { source: sourceTag })
  notifyAccountCookiePersisted(() => resolveBridgeMainWindow(), id, { source: sourceTag })

  // 关窗后的重连由 closed 回调里的 retryImFn 触发；此处不再按 AUTO_WARMUP 再跑一遍，避免重复/被开关误杀
  return {
    ok: true,
    sessionValid: !!vr.ok,
    partitionOnly: true,
    mtopVerifyOk: !!vr.ok,
    cloudSynced: uplink?.ok === true,
    x5secChanged: x5Resolve.changed === true,
    x5sec: x5
  }
}

/**
 * @param {string} accountId
 * @param {{ afterSliderClose?: boolean }} [opts]
 * afterSliderClose=true：验证/消息页关窗后的强制重连，不受 XIANYU_GOOFISH_IM_AUTO_WARMUP 限制
 */
async function runBackgroundGoofishImWarmupForAccount(accountId, { afterSliderClose = false } = {}) {
  const id = String(accountId || '').trim()
  if (!id || !bridgeAccountsDir) return
  if (!afterSliderClose && !isGoofishImAutoWarmupEnabled()) return
  if (goofishImWarmupInflight.has(id)) return
  goofishImWarmupInflight.add(id)
  try {
    const { readAccountCookieForApi } = await import('./goofish-partition-cookie.js')
    // 关窗路径：persist 内已 await 上行；再稍等读最新分区 Cookie（含过码）
    if (afterSliderClose) {
      await new Promise((r) => setTimeout(r, 200))
    }
    const snap = await readAccountCookieForApi(id, { requireUnb: true, fresh: true })
    if (!snap.ok) {
      console.warn('[闲鱼风控桥接] 私聊实时预热失败：读 Cookie', id, snap.error)
      if (afterSliderClose) clearImSliderAssistUsed(id)
      return
    }
    const hasX5sec = !!pickX5secFromCookieHeader(snap.cookie)
    console.log(
      '[闲鱼风控桥接] 开始私聊重连',
      id,
      afterSliderClose ? '(验证关窗后·用新区 Cookie)' : '(自动预热)',
      hasX5sec ? '有x5sec' : '无x5sec'
    )

    const runOnce = () =>
      runGoofishImWarmupWithPersist({
        cookieHeader: snap.cookie,
        accountsDir: bridgeAccountsDir,
        accountId: id,
        suppressSliderAssist: afterSliderClose === true,
        allowSliderCloseRetry: true
      })

    let result = await runOnce()
    // 过码刚写完偶发未生效：有 x5sec 时再等一会重试一次（仍不二次弹窗）
    if (
      afterSliderClose &&
      !result?.ok &&
      hasX5sec &&
      looksLikeImVerifyErrorText(String(result?.error || ''))
    ) {
      console.log('[闲鱼风控桥接] 关窗后仍风控，1.2s 后带 x5sec 再试一次', id)
      await new Promise((r) => setTimeout(r, 1200))
      const snap2 = await readAccountCookieForApi(id, { requireUnb: true })
      if (snap2.ok) {
        result = await runGoofishImWarmupWithPersist({
          cookieHeader: snap2.cookie,
          accountsDir: bridgeAccountsDir,
          accountId: id,
          suppressSliderAssist: true,
          allowSliderCloseRetry: true
        })
      }
    }

    if (result?.ok) {
      console.log('[闲鱼风控桥接] 私聊重连成功', id, result.sid ? `sid=${result.sid}` : '')
    } else {
      console.warn('[闲鱼风控桥接] 私聊重连失败', id, String(result?.error || '').slice(0, 160))
      // 关窗自动重连仍失败：清「已试过」标记，便于手动「预热实时」再开验证窗
      if (afterSliderClose) clearImSliderAssistUsed(id)
    }
  } catch (e) {
    console.warn('[闲鱼风控桥接] 私聊实时预热异常', id, e?.message || e)
    if (afterSliderClose) clearImSliderAssistUsed(id)
  } finally {
    goofishImWarmupInflight.delete(id)
  }
}

/**
 * @param {{ accountsDir: string, getMainWindow?: () => import('electron').BrowserWindow | null | undefined }} opts
 */
export function initGoofishRiskCookieBridge(opts = {}) {
  bridgeAccountsDir = String(opts.accountsDir || '').trim()
  bridgeGetMainWindow = typeof opts.getMainWindow === 'function' ? opts.getMainWindow : null
  persistRiskBrowsePartitionCookieRef = persistAccountMtopCookieFromRiskBrowseSession
  retryGoofishImWarmupAfterRiskCloseRef = (accountId) =>
    runBackgroundGoofishImWarmupForAccount(accountId, { afterSliderClose: true })
}

export function getPersistRiskBrowsePartitionCookie() {
  return persistRiskBrowsePartitionCookieRef
}

export function getRetryGoofishImWarmupAfterRiskClose() {
  return retryGoofishImWarmupAfterRiskCloseRef
}

export async function enrichAntiBotVerifyCookies(accountId, cookieHeader, playwrightCookies) {
  const id = String(accountId || '').trim()
  let header = String(cookieHeader || '').trim()
  let pw = Array.isArray(playwrightCookies) ? playwrightCookies : []
  if (id && bridgeAccountsDir && !pw.length) {
    try {
      const raw = await fs.readFile(xianyuMtopSessionPath(bridgeAccountsDir, id), 'utf-8')
      const d = JSON.parse(raw)
      if (Array.isArray(d?.playwrightCookies) && d.playwrightCookies.length) {
        pw = d.playwrightCookies
      }
    } catch {
      /* */
    }
  }
  if (id && isAccountGoofishEmbedViewAlive(id)) {
    try {
      const snap = await captureLoginSnapshotFromPartition(partitionForListingAccount(id))
      if (snap?.ok) {
        const live = String(snap.cookieHeader || '').trim()
        if (headerHasMh5Tk(live)) {
          header = header ? mergeCookieHeaderWithPrev(header, live) : live
        }
        if (Array.isArray(snap.playwrightCookies) && snap.playwrightCookies.length) {
          pw = snap.playwrightCookies
        }
      }
    } catch (e) {
      console.warn('[闲鱼风控桥接] 合并嵌入会话失败', id, e?.message || e)
    }
  }
  return { cookieHeader: header, playwrightCookies: pw }
}

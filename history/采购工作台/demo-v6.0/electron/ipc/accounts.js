/**
 * 闲鱼上新监控：仅保留本地账号 JSON 的读写与排序，不打开嵌入页/独立窗口（工作台能力已移除）。
 */
import { session, BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  partitionForListingAccount,
  legacySxjkGfTabsPartition,
  clearGoofishSessionPartitionsForAccount
} from '../utils/xianyu-session-partition.js'
import { partitionHasMh5Tk, partitionHasAccountLogin } from '../utils/goofish-partition-cookie.js'
import {
  destroyAccountEmbedView,
  registerAccountsGoofishEmbedIPC
} from './accounts-goofish-embed.js'
import {
  syncAccountProfileFromPartition,
  notifyAccountProfileSynced
} from '../utils/goofish-account-profile-sync.js'
import {
  stopAccountFeedBrowseLoop,
  refreshGoofishFeedBrowseWarmupFromDisk,
  getMh5ForceRefreshSchedule
} from '../utils/goofish-feed-browse-warmup-scheduler.js'

export { partitionForListingAccount, partitionPersistIdForGoofishBrowseShell } from '../utils/xianyu-session-partition.js'

const ACCOUNTS_ORDER_FILE = 'accounts-order.json'

/**
 * 删除主账号 JSON、对应 *.xianyu-mtop.json，以及「文件名不是 id.json 但 JSON 内 id 一致」的孤儿账号行文件。
 */
async function unlinkAllAccountRowArtifacts(accountsDir, id) {
  const idStr = String(id || '').trim()
  if (!idStr || !accountsDir) return
  const canonical = accountFilePath(accountsDir, idStr)
  try {
    if (await fileExists(canonical)) await fs.unlink(canonical)
  } catch (e) {
    console.warn('[账号] unlink account json:', idStr, e?.message || e)
  }
  try {
    const mtopPath = xianyuMtopSessionPath(accountsDir, idStr)
    if (await fileExists(mtopPath)) await fs.unlink(mtopPath)
  } catch (e) {
    console.warn('[账号] unlink xianyu mtop session:', idStr, e?.message || e)
  }
  let names = []
  try {
    names = await fs.readdir(accountsDir)
  } catch {
    return
  }
  for (const f of names) {
    if (
      f === ACCOUNTS_ORDER_FILE ||
      f.startsWith('.') ||
      f.endsWith('.xianyu-mtop.json') ||
      !f.endsWith('.json')
    ) {
      continue
    }
    const full = join(accountsDir, f)
    if (full === canonical) continue
    try {
      const raw = await fs.readFile(full, 'utf-8')
      const data = JSON.parse(raw)
      const inner = data && String(data.id || '').trim()
      if (inner === idStr) await fs.unlink(full)
    } catch {
      /* 非账号行或损坏 */
    }
  }
}

export function accountFilePath(accountsDir, id) {
  return join(accountsDir, `${id}.json`)
}

/** 与主进程 xianyu-mtop 一致：每账号一份闲鱼 MTOP Cookie 快照 */
export function xianyuMtopSessionPath(accountsDir, id) {
  return join(accountsDir, `${id}.xianyu-mtop.json`)
}

/** 历史兼容：已无 MTOP 登录 IPC 注册此回调 */
let persistManagedAccountMergedCookieFn = null

export function setManagedAccountMergedCookiePersister(fn) {
  persistManagedAccountMergedCookieFn = typeof fn === 'function' ? fn : null
}

/** @type {Map<string, Promise<void>>} */
const jsonWriteChains = new Map()

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetriableFsWriteError(err) {
  const code = String(err?.code || '')
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

async function commitTempJsonFile(tmpPath, filePath) {
  let lastErr
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      await fs.rename(tmpPath, filePath)
      return
    } catch (err) {
      lastErr = err
      if (!isRetriableFsWriteError(err) || attempt >= 8) break
      await sleep(30 * attempt)
    }
  }
  try {
    await fs.copyFile(tmpPath, filePath)
    await fs.unlink(tmpPath)
    return
  } catch (fallbackErr) {
    try {
      await fs.unlink(tmpPath)
    } catch {
      /* */
    }
    throw lastErr || fallbackErr
  }
}

export async function safeWriteJson(filePath, data) {
  const prev = jsonWriteChains.get(filePath) || Promise.resolve()
  const run = prev.catch(() => {}).then(async () => {
    const tmpPath = `${filePath}.tmp`
    const text = JSON.stringify(data, null, 2)
    let lastErr
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        await fs.writeFile(tmpPath, text, 'utf-8')
        await commitTempJsonFile(tmpPath, filePath)
        return
      } catch (err) {
        lastErr = err
        try {
          await fs.unlink(tmpPath)
        } catch {
          /* */
        }
        if (!isRetriableFsWriteError(err) || attempt >= 8) throw err
        await sleep(30 * attempt)
      }
    }
    throw lastErr
  })
  jsonWriteChains.set(filePath, run)
  try {
    await run
  } finally {
    if (jsonWriteChains.get(filePath) === run) jsonWriteChains.delete(filePath)
  }
}

async function readAccountOrder(accountsDir) {
  try {
    const raw = await fs.readFile(join(accountsDir, ACCOUNTS_ORDER_FILE), 'utf-8')
    const data = JSON.parse(raw)
    return Array.isArray(data.ids) ? data.ids.map((x) => String(x)) : []
  } catch {
    return []
  }
}

async function writeAccountOrder(accountsDir, ids) {
  await safeWriteJson(join(accountsDir, ACCOUNTS_ORDER_FILE), { ids })
}

function compareAccountsNewestFirst(a, b) {
  const ta = Date.parse(String(a?.createdAt || '')) || 0
  const tb = Date.parse(String(b?.createdAt || '')) || 0
  if (tb !== ta) return tb - ta
  const ua = Date.parse(String(a?.updatedAt || '')) || 0
  const ub = Date.parse(String(b?.updatedAt || '')) || 0
  if (ub !== ua) return ub - ua
  return String(b?.id || '').localeCompare(String(a?.id || ''))
}

function applySavedOrder(accounts, orderIds) {
  if (!orderIds?.length) return accounts
  const byId = new Map(accounts.map((a) => [a.id, a]))
  const ordered = []
  const seen = new Set()
  for (const id of orderIds) {
    const a = byId.get(id)
    if (a) {
      ordered.push(a)
      seen.add(id)
    }
  }
  const rest = accounts.filter((a) => !seen.has(a.id))
  rest.sort(compareAccountsNewestFirst)
  // 未进排序文件的新账号（rest）插到最前；已有顺序仍尊重手动排序
  return [...rest, ...ordered]
}

async function removeIdsFromAccountOrder(accountsDir, ids) {
  const rm = new Set(ids.map((x) => String(x || '').trim()).filter(Boolean))
  const cur = await readAccountOrder(accountsDir)
  const next = cur.filter((x) => !rm.has(x))
  await writeAccountOrder(accountsDir, next)
}

/** 账户 JSON 损坏时：删除账号行文件、MTOP 快照，并从排序中移除。 */
async function purgeCorruptedAccountById(accountsDir, id) {
  const idStr = String(id || '').trim()
  if (!idStr || !accountsDir) return
  await unlinkAllAccountRowArtifacts(accountsDir, idStr)
  try {
    await removeIdsFromAccountOrder(accountsDir, [idStr])
  } catch (e) {
    console.warn('[账号] remove corrupted from order:', idStr, e?.message || e)
  }
  try {
    await session.fromPartition(partitionForListingAccount(idStr)).clearStorageData()
  } catch {
    /* */
  }
  try {
    await session.fromPartition(legacySxjkGfTabsPartition(idStr)).clearStorageData()
  } catch {
    /* */
  }
}

export async function readAccountJson(accountsDir, id) {
  const raw = await fs.readFile(accountFilePath(accountsDir, id), 'utf-8')
  return JSON.parse(raw)
}

async function writeAccountJson(accountsDir, account) {
  await safeWriteJson(accountFilePath(accountsDir, account.id), account)
}

/**
 * 用户手动打开闲鱼页（独立窗口或嵌入页）时记录时间。
 * @param {string} accountsDir
 * @param {string} accountId
 * @param {() => import('electron').BrowserWindow | null | undefined} [getMainWindow]
 */
export async function touchAccountGoofishPageOpenedAt(accountsDir, accountId, getMainWindow) {
  const id = String(accountId || '').trim()
  if (!id || !accountsDir) return { ok: false, error: 'missing_id' }
  const path = accountFilePath(accountsDir, id)
  if (!(await fileExists(path))) return { ok: false, error: 'not_found' }
  const now = new Date().toISOString()
  const acc = await readAccountJson(accountsDir, id)
  acc.goofishPageOpenedAt = now
  acc.updatedAt = now
  await writeAccountJson(accountsDir, acc)
  const win = getMainWindow?.()
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.send('sxjk-account-goofish-page-opened', {
        accountId: id,
        goofishPageOpenedAt: now
      })
    } catch {
      /* */
    }
  }
  return { ok: true, accountId: id, goofishPageOpenedAt: now }
}

/**
 * 登录/续期后由主进程写入：接口校验是否真正可用 + 检测时间；可选合并接口返回的昵称（扫码等）。
 * @param {string} accountId
 * @param {{ sessionValid?: boolean, loginCheckUpdatedAt?: string, goofishNickname?: string, goofishAvatar?: string }} [opts]
 */
export async function applyAccountMtopLoginVerifyResult(accountsDir, accountId, opts = {}) {
  const id = String(accountId || '').trim()
  if (!id) throw new Error('missing_id')
  const acc = await readAccountJson(accountsDir, id)
  const now = new Date().toISOString()
  const sessionValid = opts.sessionValid
  let broadcastImOffline = false
  if (typeof sessionValid === 'boolean') {
    acc.loginCheckSessionValid = sessionValid
    if (sessionValid === false) {
      acc.goofishImRealtimeOk = false
      acc.goofishImRealtimeErr = '登录已过期，私聊通道已断开'
      broadcastImOffline = true
      try {
        const { closeGoofishImSession } = await import('../utils/goofish-im-session-pool.js')
        closeGoofishImSession(id, { silent: true })
      } catch {
        /* */
      }
    }
  }
  const chk = String(opts.loginCheckUpdatedAt || '').trim()
  acc.loginCheckUpdatedAt = chk || now
  acc.updatedAt = now
  if (Object.prototype.hasOwnProperty.call(opts, 'goofishNickname')) {
    const nick = String(opts.goofishNickname || '').trim().slice(0, 64)
    if (nick) acc.goofishNickname = nick
    else delete acc.goofishNickname
  }
  if (Object.prototype.hasOwnProperty.call(opts, 'goofishAvatar')) {
    const av = String(opts.goofishAvatar || '').trim().slice(0, 512)
    if (av) acc.goofishAvatar = av
    else delete acc.goofishAvatar
  }
  if (!opts.skipPersist) {
    await writeAccountJson(accountsDir, acc)
  }
  if (broadcastImOffline) {
    broadcastAccountImRealtimeChanged(accountId, {
      ok: false,
      err: String(acc.goofishImRealtimeErr || '登录已过期，私聊通道已断开').trim()
    })
  }
  return acc
}

/**
 * 私聊 WebSocket 预热（与打招呼开关同源）完成后写入账号 JSON，供账号管理「实时已连」标签。
 * @param {string} accountsDir
 * @param {string} accountId
 * @param {{ ok: boolean, err?: string }} meta
 */
export async function applyAccountGoofishImRealtimeMeta(accountsDir, accountId, meta) {
  const id = String(accountId || '').trim()
  if (!id || !accountsDir) return
  const ok = meta && meta.ok === true
  const err = String(meta?.err || '').trim().slice(0, 240)
  try {
    const path = accountFilePath(accountsDir, id)
    if (!(await fileExists(path))) return
    const acc = await readAccountJson(accountsDir, id)
    const now = new Date().toISOString()
    acc.updatedAt = now
    if (ok) {
      acc.goofishImRealtimeOk = true
      acc.goofishImRealtimeAt = now
      if (Object.prototype.hasOwnProperty.call(acc, 'goofishImRealtimeErr')) delete acc.goofishImRealtimeErr
    } else {
      acc.goofishImRealtimeOk = false
      if (err) acc.goofishImRealtimeErr = err
      else if (Object.prototype.hasOwnProperty.call(acc, 'goofishImRealtimeErr')) delete acc.goofishImRealtimeErr
    }
    await writeAccountJson(accountsDir, acc)
  } catch (e) {
    console.warn('[账号] applyAccountGoofishImRealtimeMeta', id, e?.message || e)
  }
}

/**
 * 应用启动时清空所有账号「实时已连」落盘标记；私聊通道须在本会话内手动重连。
 * @param {string} accountsDir
 */
export async function resetAllGoofishImRealtimeOnAppStart(accountsDir) {
  if (!accountsDir) return { touched: 0 }
  let touched = 0
  try {
    const accounts = await loadAllAccounts(accountsDir)
    for (const acc of accounts) {
      if (acc?.goofishImRealtimeOk !== true) continue
      const id = String(acc.id || '').trim()
      if (!id) continue
      acc.goofishImRealtimeOk = false
      if (Object.prototype.hasOwnProperty.call(acc, 'goofishImRealtimeAt')) {
        delete acc.goofishImRealtimeAt
      }
      acc.updatedAt = new Date().toISOString()
      await writeAccountJson(accountsDir, acc)
      touched++
    }
  } catch (e) {
    console.warn('[账号] resetAllGoofishImRealtimeOnAppStart', e?.message || e)
  }
  return { touched }
}

/** 私聊实时状态落盘后通知渲染进程刷新账号列表 */
export function broadcastAccountImRealtimeChanged(accountId, meta = {}) {
  const payload = {
    accountId: String(accountId || '').trim(),
    ok: meta.ok === true,
    err: String(meta?.err || '').trim()
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue
    try {
      w.webContents.send('sxjk-account-im-realtime-changed', payload)
    } catch {
      /* */
    }
  }
}

async function fileExists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

/** @param {Record<string, unknown>} acc @param {Record<string, unknown>} payload */
function applyMtopRiskFieldsToAccount(acc, payload) {
  if (!acc || typeof acc !== 'object' || !payload || typeof payload !== 'object') return
  if (payload.clearMtopRisk === true) {
    delete acc.mtopRiskUntil
    delete acc.mtopRiskMarkedAt
    delete acc.mtopRiskReason
    return
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'mtopRiskUntil')) {
    const until = String(payload.mtopRiskUntil || '').trim()
    if (until) acc.mtopRiskUntil = until
    else delete acc.mtopRiskUntil
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'mtopRiskMarkedAt')) {
    const at = String(payload.mtopRiskMarkedAt || '').trim()
    if (at) acc.mtopRiskMarkedAt = at
    else delete acc.mtopRiskMarkedAt
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'mtopRiskReason')) {
    const reason = String(payload.mtopRiskReason || '').trim().slice(0, 200)
    if (reason) acc.mtopRiskReason = reason
    else delete acc.mtopRiskReason
  }
}

async function enrichXianyuSessionFlags(_accountsDir, account) {
  try {
    const id = String(account?.id || '').trim()
    const hasMh5 = id ? await partitionHasMh5Tk(id) : false
    const hasUnb = id ? await partitionHasAccountLogin(id) : false
    const ok = hasMh5 || hasUnb
    return {
      ...account,
      hasXianyuSession: ok,
      xianyuSessionUpdatedAt: ok ? account.updatedAt || account.createdAt || null : null
    }
  } catch {
    return { ...account, hasXianyuSession: false, xianyuSessionUpdatedAt: null }
  }
}

export async function loadAllAccounts(accountsDir) {
  const names = await fs.readdir(accountsDir)
  const jsonFiles = names.filter(
    (f) => f.endsWith('.json') && f !== ACCOUNTS_ORDER_FILE && !f.endsWith('.xianyu-mtop.json')
  )
  const accounts = []
  for (const f of jsonFiles) {
    try {
      const raw = await fs.readFile(join(accountsDir, f), 'utf-8')
      const data = JSON.parse(raw)
      if (data && data.id) accounts.push(data)
    } catch (e) {
      const fullPath = join(accountsDir, f)
      const brokenBackupPath = `${fullPath}.broken-${Date.now()}`
      console.error(`[账号] 账户配置文件损坏，已自动将其重命名备份为 ${f}.broken-* 以留存凭证现场:`, e?.message || e)
      try {
        await fs.rename(fullPath, brokenBackupPath)
      } catch (renameErr) {
        console.error('[账号] 重命名备份损坏的账户配置文件失败:', f, renameErr?.message || renameErr)
      }
    }
  }
  accounts.sort(compareAccountsNewestFirst)
  // 列表固定「最新添加在前」；同步写回排序文件，后续新建 unshift 也保持一致
  try {
    const nextIds = accounts.map((a) => String(a.id))
    const prevIds = await readAccountOrder(accountsDir)
    const same =
      prevIds.length === nextIds.length && prevIds.every((id, i) => id === nextIds[i])
    if (!same) await writeAccountOrder(accountsDir, nextIds)
  } catch (e) {
    console.warn('[账号] 同步 accounts-order 失败', e?.message || e)
  }
  return accounts
}

/**
 * 账号登录成功后写入/更新账号元数据（手机号、备注、闲鱼昵称、会话时间）。
 */
export async function upsertAccountForMtopLogin(accountsDir, { id, phone, remark, goofishNickname, goofishAvatar }) {
  if (!id) throw new Error('missing_id')
  const path = accountFilePath(accountsDir, id)
  const existed = await fileExists(path)
  let createdAt = new Date().toISOString()
  let prevNick = ''
  let prevAvatar = ''
  let prevLoginCheckUpdatedAt = ''
  let prevLoginCheckSessionValid
  let prevRealtimeOk
  let prevRealtimeAt = ''
  let prevRealtimeErr = ''
  let prevGoofishPageOpenedAt = ''
  if (existed) {
    const prev = await readAccountJson(accountsDir, id)
    createdAt = prev.createdAt || createdAt
    prevNick = String(prev.goofishNickname || '').trim().slice(0, 64)
    prevAvatar = String(prev.goofishAvatar || '').trim().slice(0, 512)
    prevGoofishPageOpenedAt = String(prev.goofishPageOpenedAt || '').trim()
    const chk = String(prev.loginCheckUpdatedAt || '').trim()
    if (chk) prevLoginCheckUpdatedAt = chk
    if (typeof prev.loginCheckSessionValid === 'boolean') {
      prevLoginCheckSessionValid = prev.loginCheckSessionValid
    }
    if (typeof prev.goofishImRealtimeOk === 'boolean') {
      prevRealtimeOk = prev.goofishImRealtimeOk
    }
    prevRealtimeAt = String(prev.goofishImRealtimeAt || '').trim()
    prevRealtimeErr = String(prev.goofishImRealtimeErr || '').trim().slice(0, 240)
  }
  const phoneStr = String(phone || '').trim().slice(0, 11)
  const remarkStr = String(remark || '').trim().slice(0, 200)
  const incomingNick = String(goofishNickname || '').trim().slice(0, 64)
  const goofishNickStored = incomingNick || prevNick
  const incomingAvatar = String(goofishAvatar || '').trim().slice(0, 512)
  const goofishAvatarStored = incomingAvatar || prevAvatar
  const name = phoneStr.slice(0, 64) || '未命名账号'
  const account = {
    id,
    name,
    phone: phoneStr,
    remark: remarkStr,
    ...(goofishNickStored ? { goofishNickname: goofishNickStored } : {}),
    ...(goofishAvatarStored ? { goofishAvatar: goofishAvatarStored } : {}),
    partition: partitionForListingAccount(id),
    createdAt,
    updatedAt: new Date().toISOString(),
    sessionUpdatedAt: new Date().toISOString(),
    ...(prevLoginCheckUpdatedAt ? { loginCheckUpdatedAt: prevLoginCheckUpdatedAt } : {}),
    ...(typeof prevLoginCheckSessionValid === 'boolean'
      ? { loginCheckSessionValid: prevLoginCheckSessionValid }
      : {}),
    ...(typeof prevRealtimeOk === 'boolean' ? { goofishImRealtimeOk: prevRealtimeOk } : {}),
    ...(prevRealtimeAt ? { goofishImRealtimeAt: prevRealtimeAt } : {}),
    ...(prevRealtimeErr ? { goofishImRealtimeErr: prevRealtimeErr } : {}),
    ...(prevGoofishPageOpenedAt ? { goofishPageOpenedAt: prevGoofishPageOpenedAt } : {})
  }
  await writeAccountJson(accountsDir, account)
  if (!existed) {
    const order = await readAccountOrder(accountsDir)
    if (!order.includes(id)) {
      order.unshift(id)
      await writeAccountOrder(accountsDir, order)
    }
  }
  return account
}

export function registerAccountIPC(ipcMain, accountsDir, getMainWindow, opts = {}) {
  const electronDirname = String(opts.electronDirname || '').trim()
  fs.mkdir(accountsDir, { recursive: true }).catch(() => {})

  registerAccountsGoofishEmbedIPC(ipcMain, accountsDir, getMainWindow)

  void refreshGoofishFeedBrowseWarmupFromDisk(accountsDir, { electronDirname })

  ipcMain.handle('sxjk-mh5-force-refresh-schedule', () => getMh5ForceRefreshSchedule())

  ipcMain.handle('list-accounts', async () => {
    try {
      const rawItems = await loadAllAccounts(accountsDir)
      const items = await Promise.all(rawItems.map((a) => enrichXianyuSessionFlags(accountsDir, a)))
      return { ok: true, items }
    } catch (e) {
      console.error('[账号] list-accounts:', e)
      return { ok: false, error: String(e), items: [] }
    }
  })

  /** 从分区读 Cookie 拉取昵称/头像，写入账号 JSON（不写 Cookie 快照） */
  ipcMain.handle('refresh-account-goofish-profile', async (_e, payload = {}) => {
    const id = String(payload?.accountId || '').trim()
    if (!id) return { ok: false, error: 'missing_account_id', msg: '缺少账号' }
    try {
      if (!(await fileExists(accountFilePath(accountsDir, id)))) {
        return { ok: false, error: 'not_found', msg: '账号不存在' }
      }
      const result = await syncAccountProfileFromPartition(accountsDir, id, {
        debug: payload?.debug === true
      })
      if (result.ok) {
        notifyAccountProfileSynced(getMainWindow, id, result)
      }
      return result
    } catch (e) {
      console.error('[账号] refresh-account-goofish-profile:', e)
      return { ok: false, error: String(e), msg: '获取失败，请稍后重试' }
    }
  })

  ipcMain.handle('set-account-order', async (_e, payload = {}) => {
    try {
      const raw = payload.ids
      if (!Array.isArray(raw)) return { ok: false, error: 'missing_ids' }
      const incoming = [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))]
      const all = await loadAllAccounts(accountsDir)
      const disk = new Set(all.map((a) => a.id))
      if (incoming.length !== disk.size) return { ok: false, error: 'order_count_mismatch' }
      if (!incoming.every((id) => disk.has(id))) return { ok: false, error: 'order_unknown_id' }
      await writeAccountOrder(accountsDir, incoming)
      return { ok: true }
    } catch (e) {
      console.error('[账号] set-account-order:', e)
      return { ok: false, error: String(e) }
    }
  })

  ipcMain.handle('query-accounts', async (_e, params = {}) => {
    try {
      const page = Math.max(1, Number(params.page) || 1)
      const pageSize = Math.min(100, Math.max(1, Number(params.pageSize) || 20))
      const all = await loadAllAccounts(accountsDir)
      const total = all.length
      const start = (page - 1) * pageSize
      const items = all.slice(start, start + pageSize)
      return { items, total }
    } catch (e) {
      console.error('[账号] query-accounts:', e)
      return { items: [], total: 0 }
    }
  })

  ipcMain.handle('save-account', async (_e, payload = {}) => {
    try {
      const id = payload.id || randomUUID()
      const name = String(payload.name ?? '未命名账号').trim().slice(0, 64) || '未命名账号'
      let phone
      if (payload.phone != null) {
        const p = String(payload.phone).replace(/\D/g, '').slice(0, 11)
        if (p) {
          if (!/^1\d{10}$/.test(p)) {
            return { ok: false, error: 'invalid_phone' }
          }
          phone = p
        }
      }
      const remark =
        payload.remark != null ? String(payload.remark).trim().slice(0, 200) : undefined
      const path = accountFilePath(accountsDir, id)
      const existed = await fileExists(path)
      let createdAt = new Date().toISOString()
      if (existed) {
        const prev = await readAccountJson(accountsDir, id)
        createdAt = prev.createdAt || createdAt
      }
      const account = {
        id,
        name,
        partition: partitionForListingAccount(id),
        createdAt,
        updatedAt: new Date().toISOString()
      }
      if (phone !== undefined) account.phone = phone
      if (remark !== undefined) account.remark = remark
      await writeAccountJson(accountsDir, account)
      if (!existed) {
        const order = await readAccountOrder(accountsDir)
        if (!order.includes(id)) {
          order.unshift(id)
          await writeAccountOrder(accountsDir, order)
        }
      }
      return { ok: true, account, created: !existed }
    } catch (e) {
      console.error('[账号] save-account:', e)
      return { ok: false, error: String(e) }
    }
  })

  ipcMain.handle('update-account', async (_e, payload = {}) => {
    try {
      const { id, name, phone, remark } = payload
      if (!id) return { ok: false, error: 'missing_id' }
      const path = accountFilePath(accountsDir, id)
      if (!(await fileExists(path))) return { ok: false, error: 'not_found' }
      const hasLoginCheck =
        Object.prototype.hasOwnProperty.call(payload, 'sessionValid') ||
        Object.prototype.hasOwnProperty.call(payload, 'loginCheckUpdatedAt') ||
        Object.prototype.hasOwnProperty.call(payload, 'goofishNickname') ||
        Object.prototype.hasOwnProperty.call(payload, 'goofishAvatar') ||
        payload.clearGoofishNickname === true
      if (hasLoginCheck) {
        const verifyOpts = {}
        if (typeof payload.sessionValid === 'boolean') {
          verifyOpts.sessionValid = payload.sessionValid
        }
        if (payload.loginCheckUpdatedAt != null) {
          verifyOpts.loginCheckUpdatedAt = String(payload.loginCheckUpdatedAt).trim()
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'goofishNickname')) {
          verifyOpts.goofishNickname = payload.goofishNickname
        }
        if (Object.prototype.hasOwnProperty.call(payload, 'goofishAvatar')) {
          verifyOpts.goofishAvatar = payload.goofishAvatar
        }
        if (payload.clearGoofishNickname === true) {
          verifyOpts.goofishNickname = ''
        }
        const acc = await applyAccountMtopLoginVerifyResult(accountsDir, id, {
          ...verifyOpts,
          skipPersist: true
        })
        if (name != null) acc.name = String(name).trim().slice(0, 64) || acc.name
        if (phone != null) acc.phone = String(phone).trim().slice(0, 11)
        if (remark != null) acc.remark = String(remark).trim().slice(0, 200)
        applyMtopRiskFieldsToAccount(acc, payload)
        acc.updatedAt = new Date().toISOString()
        await writeAccountJson(accountsDir, acc)
        return { ok: true, account: acc }
      }
      const acc = await readAccountJson(accountsDir, id)
      if (name != null) acc.name = String(name).trim().slice(0, 64) || acc.name
      if (phone != null) acc.phone = String(phone).trim().slice(0, 11)
      if (remark != null) acc.remark = String(remark).trim().slice(0, 200)
      applyMtopRiskFieldsToAccount(acc, payload)
      acc.updatedAt = new Date().toISOString()
      await writeAccountJson(accountsDir, acc)
      return { ok: true, account: acc }
    } catch (e) {
      console.error('[账号] update-account:', e)
      return { ok: false, error: String(e) }
    }
  })

  async function deleteAccountCore(id, opts = {}) {
    try {
      if (!id) return { ok: false, error: 'missing_id' }
      let phone = ''
      try {
        const acc = await readAccountJson(accountsDir, id)
        phone = String(acc?.phone || '').trim()
      } catch {
        /* */
      }
      destroyAccountEmbedView(id, getMainWindow)
      stopAccountFeedBrowseLoop(id)
      await clearGoofishSessionPartitionsForAccount(id, phone)
      await unlinkAllAccountRowArtifacts(accountsDir, id)
      if (!opts.skipOrder) {
        try {
          await removeIdsFromAccountOrder(accountsDir, [id])
        } catch (e) {
          console.warn('[账号] remove from order:', e)
        }
      }
      return { ok: true }
    } catch (e) {
      console.error('[账号] delete-account-core:', id, e)
      return { ok: false, error: String(e) }
    }
  }

  ipcMain.handle('delete-account', async (_e, payload = {}) => {
    const r = await deleteAccountCore(payload.id)
    return r.ok ? { ok: true } : { ok: false, error: r.error }
  })

  ipcMain.handle('delete-accounts', async (_e, payload = {}) => {
    try {
      const raw = payload.ids
      if (!Array.isArray(raw) || raw.length === 0) {
        return { ok: false, error: 'missing_ids', deleted: [], failed: [] }
      }
      const ids = [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))]
      const results = await Promise.all(
        ids.map(async (id) => {
          const r = await deleteAccountCore(id, { skipOrder: true })
          return { id, ...r }
        })
      )
      const deleted = results.filter((x) => x.ok).map((x) => x.id)
      const failed = results
        .filter((x) => !x.ok)
        .map((x) => ({ id: x.id, error: x.error || 'unknown' }))
      if (deleted.length) {
        try {
          await removeIdsFromAccountOrder(accountsDir, deleted)
        } catch (e) {
          console.warn('[账号] batch remove from order:', e)
        }
      }
      return {
        ok: failed.length === 0,
        deleted,
        failed
      }
    } catch (e) {
      console.error('[账号] delete-accounts:', e)
      return { ok: false, error: String(e), deleted: [], failed: [] }
    }
  })

  const notSupported = async () => ({ ok: false, error: 'not_supported' })

  ipcMain.handle('close-login-session', async () => ({ ok: true, closed: false }))
  ipcMain.handle('capture-login-session', notSupported)
  ipcMain.handle('open-inject', notSupported)
  ipcMain.handle('check-login-status', async () => ({
    ok: true,
    windowOpen: false,
    hint: '当前版本已移除工作台网页会话'
  }))
  ipcMain.handle('add-account-via-playwright', notSupported)
}

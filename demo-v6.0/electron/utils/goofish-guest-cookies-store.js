/**
 * 游客 Cookie：独立 JSON（global + byTaskId），手动写入，无定时续期。
 */
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { headerHasMh5Tk } from './xianyu-goofish-open-session.js'

const MAX_COOKIE_LEN = 65536

function sanitizeCookie(s) {
  return String(s ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('; ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, MAX_COOKIE_LEN)
}

async function readStore(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const data = JSON.parse(raw)
    return {
      global: data?.global && typeof data.global === 'object' ? data.global : {},
      byTaskId: data?.byTaskId && typeof data.byTaskId === 'object' ? data.byTaskId : {}
    }
  } catch {
    return { global: {}, byTaskId: {} }
  }
}

async function writeStore(filePath, store) {
  await fs.mkdir(dirname(filePath), { recursive: true })
  const tmp = filePath + '.tmp'
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf-8')
  await fs.rename(tmp, filePath)
}

/**
 * @param {string} filePath
 * @param {{ scope?: 'global'|'task', taskId?: string }} opts
 */
export async function getGuestCookieHeader(filePath, opts = {}) {
  const scope = String(opts?.scope || 'global').trim() === 'task' ? 'task' : 'global'
  const taskId = String(opts?.taskId || '').trim()
  const store = await readStore(filePath)
  if (scope === 'task' && taskId) {
    const entry = store.byTaskId[taskId]
    const h = sanitizeCookie(entry?.cookieHeader)
    if (headerHasMh5Tk(h)) {
      return { ok: true, cookie: h, updatedAt: entry?.updatedAt || null, source: 'task' }
    }
  }
  const g = sanitizeCookie(store.global?.cookieHeader)
  if (headerHasMh5Tk(g)) {
    return {
      ok: true,
      cookie: g,
      updatedAt: store.global?.updatedAt || null,
      source: scope === 'task' && taskId ? 'global_fallback' : 'global'
    }
  }
  return { ok: false, cookie: '', error: 'no_guest_cookie' }
}

/**
 * @param {string} filePath
 * @param {{ scope?: 'global'|'task', taskId?: string, cookieHeader: string }} opts
 */
export async function setGuestCookieHeader(filePath, opts = {}) {
  const cookieHeader = sanitizeCookie(opts?.cookieHeader)
  if (!headerHasMh5Tk(cookieHeader)) {
    return { ok: false, error: 'missing_mh5_tk' }
  }
  const scope = String(opts?.scope || 'global').trim() === 'task' ? 'task' : 'global'
  const taskId = String(opts?.taskId || '').trim()
  const store = await readStore(filePath)
  const updatedAt = new Date().toISOString()
  const entry = { cookieHeader, updatedAt }
  if (scope === 'task' && taskId) {
    store.byTaskId[taskId] = entry
  } else {
    store.global = entry
  }
  await writeStore(filePath, store)
  return { ok: true, updatedAt, scope, taskId: taskId || null }
}

/** @param {string} filePath @param {{ scope?: 'global'|'task'|'all', taskId?: string }} opts */
export async function clearGuestCookieHeader(filePath, opts = {}) {
  const scope = String(opts?.scope || 'global').trim()
  const taskId = String(opts?.taskId || '').trim()
  const store = await readStore(filePath)
  if (scope === 'all') {
    await writeStore(filePath, { global: {}, byTaskId: {} })
    return { ok: true }
  }
  if (scope === 'task' && taskId && store.byTaskId[taskId]) {
    delete store.byTaskId[taskId]
    await writeStore(filePath, store)
    return { ok: true }
  }
  store.global = {}
  await writeStore(filePath, store)
  return { ok: true }
}

/** 任务轮询：本机游客库优先（global/task 会被静默续期与写回更新），任务内嵌 Cookie 仅作兜底 */
export async function resolveGuestCookieForTask(filePath, opts = {}) {
  const taskId = String(opts?.taskId || '').trim()
  if (taskId) {
    const taskR = await getGuestCookieHeader(filePath, { scope: 'task', taskId })
    if (taskR.ok) return taskR
  }
  const globalR = await getGuestCookieHeader(filePath, { scope: 'global' })
  if (globalR.ok) return globalR
  const inline = sanitizeCookie(opts?.guestCookieHeader)
  if (headerHasMh5Tk(inline)) {
    return { ok: true, cookie: inline, source: 'inline' }
  }
  return { ok: false, cookie: '', error: 'no_guest_cookie' }
}

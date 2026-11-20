/**
 * ERP 账号登录（ERP /auth/xianyu-login，全部真人员工角色可登录）。
 * 令牌和记住的密码加密后存在本地 userData/erp-auth.json（不用系统钥匙串：没签名的应用常被它弹窗拦）；
 * 密钥由这台电脑的设备码派生，文件拷到别的电脑上解不开。
 * 渲染进程每个请求带 X-Erp-Token，服务端拿它去 ERP 验人。
 * 续期：启动后和每隔 6 小时用还有效的令牌换新令牌（ERP /auth/xianyu-refresh，又是 7 天），
 * 所以只有连续 7 天没打开、令牌过期了才回登录页；记住了密码的点一下登录就行。
 */
import { ipcMain, app, BrowserWindow } from 'electron'
import { join } from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { getDeviceId } from '../utils/device-binding.js'

const ERP_API_BASE = String(process.env.ERP_API_BASE || 'http://127.0.0.1:8000').replace(/\/+$/, '')
const FIRST_REFRESH_DELAY_MS = 15 * 1000
const REFRESH_INTERVAL_MS = 6 * 3600 * 1000

function file() {
  return join(app.getPath('userData'), 'erp-auth.json')
}

function key() {
  const device = getDeviceId(app.getPath('userData')) || `${os.hostname()}|${os.userInfo().username}`
  return crypto.createHash('sha256').update(`xianyu-erp-auth|${device}`).digest()
}

/** AES-256-GCM：v1:base64(iv 12 + tag 16 + 密文) */
function enc(text) {
  if (!text) return ''
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()])
  return `v1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`
}

function dec(value) {
  if (!String(value || '').startsWith('v1:')) return ''
  try {
    const buf = Buffer.from(value.slice(3), 'base64')
    const d = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12))
    d.setAuthTag(buf.subarray(12, 28))
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8')
  } catch {
    return ''
  }
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8')) || {}
  } catch {
    return {}
  }
}

function save(data) {
  fs.writeFileSync(file(), JSON.stringify(data, null, 2), { mode: 0o600 })
}

/** JWT 的 exp（毫秒）；解析不了返回 0 */
function tokenExpMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
    return Number(payload.exp) * 1000 || 0
  } catch {
    return 0
  }
}

function currentToken() {
  const token = dec(load().token)
  if (!token) return ''
  const exp = tokenExpMs(token)
  return exp && exp > Date.now() ? token : ''
}

function broadcastToken(token) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('erp-auth:token-updated', token)
  }
}

/** 用还有效的令牌换新令牌；令牌已失效（停用、改角色）就清掉，界面下次请求会被要求重新登录 */
async function refresh() {
  const token = currentToken()
  if (!token) return
  let res
  try {
    res = await fetch(`${ERP_API_BASE}/auth/xianyu-refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000)
    })
  } catch {
    return // 网络问题：旧令牌还有效，下次再续
  }
  if (res.status === 401 || res.status === 403) {
    save({ ...load(), token: '' })
    broadcastToken('')
    return
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data?.token) return
  const d = load()
  save({ ...d, token: enc(data.token), staff: { id: data.staff?.id, name: data.staff?.name, role: data.staff?.role }, refreshedAt: new Date().toISOString() })
  broadcastToken(data.token)
}

async function erpLogin(username, password) {
  let res
  try {
    res = await fetch(`${ERP_API_BASE}/auth/xianyu-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(20000)
    })
  } catch {
    return { ok: false, reason: '连不上 ERP，请检查网络' }
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data?.token) {
    const detail = typeof data?.detail === 'string' ? data.detail : ''
    return { ok: false, reason: detail || `登录失败（${res.status}）` }
  }
  return { ok: true, token: data.token, staff: data.staff || {} }
}

async function login({ username, password, remember }) {
  const u = String(username || '').trim()
  const p = String(password || '')
  if (!u || !p) return { ok: false, reason: '请输入账号和密码' }
  const r = await erpLogin(u, p)
  if (!r.ok) return r
  const prev = load()
  save({
    username: u,
    staff: { id: r.staff.id, name: r.staff.name, role: r.staff.role },
    token: enc(r.token),
    // 登录成功才记密码：记一个错的密码，下次就是一次必然失败的自动登录
    password: remember ? enc(p) : '',
    remember: !!remember,
    loggedAt: new Date().toISOString(),
    ...(prev.lastLogoutAt ? { lastLogoutAt: prev.lastLogoutAt } : {})
  })
  return { ok: true, staff: r.staff }
}

async function loginRemembered() {
  const d = load()
  const p = d.remember ? dec(d.password) : ''
  if (!d.username || !p) return { ok: false, reason: '没有记住的密码' }
  const r = await login({ username: d.username, password: p, remember: true })
  // 记住的密码已经不对（改过密码 / 账号停用）：清掉，让人重新输
  if (!r.ok && /密码|停用|不能登录/.test(r.reason)) save({ ...load(), password: '', remember: false })
  return r
}

export function registerErpAuthIPC() {
  app.whenReady().then(() => {
    setTimeout(() => void refresh(), FIRST_REFRESH_DELAY_MS)
    setInterval(() => void refresh(), REFRESH_INTERVAL_MS).unref?.()
  })
  // preload 启动时同步取一次，保证首批请求就带上令牌
  ipcMain.on('erp-auth:token-sync', (e) => {
    e.returnValue = currentToken()
  })
  ipcMain.handle('erp-auth:state', () => {
    const d = load()
    return {
      loggedIn: !!currentToken(),
      staff: d.staff || null,
      username: d.username || '',
      remember: !!d.remember && !!d.password,
      // 自己点了退出（不是过期）：登录页不提示「已过期」
      loggedOut: !!d.lastLogoutAt && String(d.lastLogoutAt) > String(d.loggedAt || '')
    }
  })
  ipcMain.handle('erp-auth:login', (_e, body = {}) => login(body))
  ipcMain.handle('erp-auth:login-remembered', () => loginRemembered())
  ipcMain.handle('erp-auth:logout', (_e, { forget = false } = {}) => {
    const d = load()
    save({ ...d, token: '', ...(forget ? { password: '', remember: false } : {}), lastLogoutAt: new Date().toISOString() })
    return { ok: true }
  })
}

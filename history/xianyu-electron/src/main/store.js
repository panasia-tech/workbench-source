// 持久化：服务器地址 / 加密 token / 登录信息 / 账号配置 / 设置 / 爬取结果日志
import { randomUUID } from 'crypto'
import { safeStorage } from 'electron'
import Store from 'electron-store'

const store = new Store({
  name: 'xianyu-electron',
  defaults: {
    serverBaseUrl: 'http://127.0.0.1:8000',
    tokenEnc: null, // safeStorage 加密后的 base64
    staff: null, // { id, username, role }
    accounts: [], // [{ id, name, partition, enabled }]
    settings: {
      throttleMinMs: 1500, // 任务间隔下限
      throttleMaxMs: 3500, // 任务间隔上限（运行时在 [min,max] 内取随机延迟）
      dailyEnabled: false,
      dailyTime: '09:00',
      closeToTray: true,
      maxTasks: 0, // 0=不限；>0 用于联调时只跑前 N 个
      recycleEvery: 50 // 每爬 N 条销毁重建浏览器视图释放内存，0=不重建
    },
    results: [] // 爬取结果日志（最新在前），上限见 RESULT_CAP
  }
})

const RESULT_CAP = 5000

// ---------- token（safeStorage 加密） ----------
export function setToken(token) {
  if (!token) {
    store.set('tokenEnc', null)
    return
  }
  if (safeStorage.isEncryptionAvailable()) {
    store.set('tokenEnc', safeStorage.encryptString(token).toString('base64'))
  } else {
    // 兜底：明文（极少数无 keychain 环境）
    store.set('tokenEnc', 'plain:' + token)
  }
}

export function getToken() {
  const enc = store.get('tokenEnc')
  if (!enc) return null
  if (enc.startsWith('plain:')) return enc.slice(6)
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}

export function clearAuth() {
  store.set('tokenEnc', null)
  store.set('staff', null)
}

// ---------- 通用 getter/setter ----------
export const getServerBaseUrl = () => store.get('serverBaseUrl')
export const setServerBaseUrl = (v) => store.set('serverBaseUrl', (v || '').trim().replace(/\/+$/, ''))
export const getStaff = () => store.get('staff')
export const setStaff = (v) => store.set('staff', v)
export function getSettings() {
  const s = { ...store.get('settings') }
  // 兼容老配置：单值 throttleMs → min/max
  if (s.throttleMinMs == null || s.throttleMaxMs == null) {
    const base = s.throttleMs || 2200
    s.throttleMinMs = s.throttleMinMs ?? Math.max(500, Math.round(base * 0.7))
    s.throttleMaxMs = s.throttleMaxMs ?? Math.round(base * 1.6)
    delete s.throttleMs
    store.set('settings', s)
  }
  // 兼容老配置：无 recycleEvery 时补默认值
  if (s.recycleEvery == null) {
    s.recycleEvery = 50
    store.set('settings', s)
  }
  return s
}
export const setSettings = (patch) => store.set('settings', { ...store.get('settings'), ...patch })

// ---------- 账号 ----------
export const getAccounts = () => store.get('accounts')

export function addAccount(name) {
  const id = randomUUID()
  const acc = { id, name: (name || '').trim() || '账号', partition: `persist:xianyu-${id}`, enabled: true }
  store.set('accounts', [...store.get('accounts'), acc])
  return acc
}

export function updateAccount(id, patch) {
  const list = store.get('accounts').map((a) => (a.id === id ? { ...a, ...patch } : a))
  store.set('accounts', list)
  return list.find((a) => a.id === id) || null
}

export function removeAccount(id) {
  store.set('accounts', store.get('accounts').filter((a) => a.id !== id))
}

// ---------- 爬取结果日志 ----------
export function addResult(row) {
  const list = store.get('results')
  list.unshift({ id: randomUUID(), ...row })
  if (list.length > RESULT_CAP) list.length = RESULT_CAP
  store.set('results', list)
}

export function queryResults({ q = '', status = null, page = 1, pageSize = 50 } = {}) {
  let list = store.get('results')
  const kw = (q || '').trim().toLowerCase()
  if (kw) {
    list = list.filter(
      (r) =>
        (r.name || '').toLowerCase().includes(kw) ||
        (r.keyword || '').toLowerCase().includes(kw) ||
        (r.account || '').toLowerCase().includes(kw)
    )
  }
  if (status) list = list.filter((r) => r.status === status)
  const total = list.length
  const start = (page - 1) * pageSize
  return { items: list.slice(start, start + pageSize), total }
}

export function clearResults() {
  store.set('results', [])
}

import { promisify } from '../util.js'

// wx.*Storage：localStorage，值包一层 {v} 保住原类型。和小程序一样，取不到的键返回 ''。
const PREFIX = 'mp:'

function read(key) {
  let raw = null
  try {
    raw = localStorage.getItem(PREFIX + key)
  } catch {
    return ''
  }
  if (raw == null) return ''
  try {
    const parsed = JSON.parse(raw)
    return parsed && Object.prototype.hasOwnProperty.call(parsed, 'v') ? parsed.v : ''
  } catch {
    return ''
  }
}

export function getStorageSync(key) {
  return read(String(key))
}

export function setStorageSync(key, data) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ v: data }))
  } catch (e) {
    console.warn('[H5] setStorageSync 失败', e)
  }
}

export function removeStorageSync(key) {
  try {
    localStorage.removeItem(PREFIX + key)
  } catch {
    /* 存储不可用时静默 */
  }
}

function ownKeys() {
  const keys = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && k.startsWith(PREFIX)) keys.push(k.slice(PREFIX.length))
    }
  } catch {
    /* ignore */
  }
  return keys
}

export function clearStorageSync() {
  for (const k of ownKeys()) removeStorageSync(k)
}

export function getStorageInfoSync() {
  const keys = ownKeys()
  let size = 0
  for (const k of keys) {
    try { size += (localStorage.getItem(PREFIX + k) || '').length } catch { /* ignore */ }
  }
  return { keys, currentSize: Math.ceil(size / 1024), limitSize: 5120 }
}

export const getStorage = promisify('getStorage', ({ key }) => {
  try {
    if (localStorage.getItem(PREFIX + key) == null) throw new Error('data not found')
  } catch (e) {
    throw new Error(e.message || 'data not found')
  }
  return { data: read(key) }
})
export const setStorage = promisify('setStorage', ({ key, data }) => { setStorageSync(key, data) })
export const removeStorage = promisify('removeStorage', ({ key }) => { removeStorageSync(key) })
export const clearStorage = promisify('clearStorage', () => { clearStorageSync() })

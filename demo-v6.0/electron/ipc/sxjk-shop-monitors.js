/**
 * 店铺上新监控：本地监听列表（与 xy-sxjk-tasks.json 独立）
 */
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { normalizeGreetingDeliveryMode } from '../../shared/sxjk-greeting-delivery-mode.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))

function normalizePriceField(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  return /^\d+(\.\d{1,2})?$/.test(s) ? s : ''
}

function normalizeAccountId(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  return s.slice(0, 64)
}

/** 店铺秒拍账号：去重、排序；旧数据仅有 miaopai_account_id 时由此补全 */
const MAX_MIAOPAI_ACCOUNT_IDS = 16

function normalizeMiaopaiAccountIdsPersist(rawIds, legacySingle) {
  const out = []
  const seen = new Set()
  if (Array.isArray(rawIds)) {
    for (const x of rawIds) {
      const id = normalizeAccountId(x)
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(id)
      if (out.length >= MAX_MIAOPAI_ACCOUNT_IDS) break
    }
  }
  if (!out.length) {
    const one = normalizeAccountId(legacySingle)
    if (one) out.push(one)
  }
  out.sort((a, b) => a.localeCompare(b))
  return out
}

/** 与任务监听列表一致：去重、排序、上限；旧数据仅有单账号时由此补全 */
function normalizeListenAccountIdsPersist(rawListen, legacySingle) {
  const out = []
  const seen = new Set()
  if (Array.isArray(rawListen)) {
    for (const x of rawListen) {
      const id = normalizeAccountId(x)
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(id)
      if (out.length >= 20) break
    }
  }
  if (!out.length) {
    const one = normalizeAccountId(legacySingle)
    if (one) out.push(one)
  }
  out.sort((a, b) => a.localeCompare(b))
  return out
}

function normalizeDingtalkRobotIndicesPersist(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const x of raw) {
    const n = Math.floor(Number(x))
    if (!Number.isFinite(n) || n < 0 || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

/** 历史字段：落盘仍保留默认 3600；当前版本店铺上新不再用该时间窗过滤 */
function normalizeNewItemWithinSec(raw) {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n)) return 3600
  return Math.min(86400, Math.max(5, n))
}

function normalizeGreetingTemplateIdsPersist(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const x of raw) {
    const n = Math.floor(Number(x))
    if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue
    seen.add(n)
    out.push(n)
    if (out.length >= 50) break
  }
  return out
}

function normalizeSellerUserId(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  const digits = s.replace(/\D/gu, '')
  return digits.slice(0, 24)
}

function normalizeShopLinkPersist(v) {
  return String(v ?? '').trim().slice(0, 512)
}

function normalizeShopDisplayNick(v) {
  return String(v ?? '').trim().slice(0, 120)
}

function normalizeShopDisplayShopName(v) {
  return String(v ?? '').trim().slice(0, 120)
}

function normalizeShopDisplayAvatar(v) {
  let s = String(v ?? '').trim().slice(0, 512)
  if (s.startsWith('//')) s = `https:${s}`
  return s
}

/**
 * 店铺上新：检查间隔毫秒，100～86400000。
 * 旧数据 poll_interval_sec / interval_minutes 会换算。
 * @param {unknown} raw
 */
function normalizePollIntervalMs(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {}
  const msRaw = Number(obj.poll_interval_ms)
  if (Number.isFinite(msRaw) && msRaw >= 100 && msRaw <= 86_400_000) {
    return Math.floor(msRaw)
  }
  const secRaw = Number(obj.poll_interval_sec)
  if (Number.isFinite(secRaw) && secRaw >= 1 && secRaw <= 86400) {
    return Math.min(86_400_000, Math.max(100, Math.floor(secRaw * 1000)))
  }
  const legacyMin = Math.floor(Number(obj.interval_minutes))
  if (Number.isFinite(legacyMin) && legacyMin >= 1) {
    return Math.min(86_400_000, legacyMin * 60 * 1000)
  }
  return 1000
}

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>}
 */
function normalizeShopMonitorPersist(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const id = String(r.id || '').trim().slice(0, 64) || randomUUID()
  const seller_user_id = normalizeSellerUserId(r.seller_user_id)
  const poll_interval_ms = normalizePollIntervalMs(r)
  const price_from = normalizePriceField(r.price_from)
  const price_to = normalizePriceField(r.price_to)
  let pf = price_from
  let pt = price_to
  if (pf && pt && Number(pf) > Number(pt)) {
    const t = pf
    pf = pt
    pt = t
  }
  const xianyu_listen_account_ids = normalizeListenAccountIdsPersist(r.xianyu_listen_account_ids, r.xianyu_account_id)
  const miaopai_account_ids = normalizeMiaopaiAccountIdsPersist(
    r.miaopai_account_ids,
    r.miaopai_account_id
  )
  const mpId = miaopai_account_ids[0] || ''
  const explicitChat = normalizeAccountId(r.xianyu_account_id)
  const greetAllow = new Set(xianyu_listen_account_ids)
  for (const id of miaopai_account_ids) greetAllow.add(id)
  /** 私聊账号独立选择：须在监听∪秒拍并集内，否则清空由 UI 重选 */
  let xianyu_account_id = ''
  if (explicitChat && greetAllow.has(explicitChat)) {
    xianyu_account_id = explicitChat
  }
  return {
    id,
    enabled: r.enabled !== false && r.enabled !== '0' && r.enabled !== 0,
    seller_user_id,
    shop_link: normalizeShopLinkPersist(r.shop_link),
    xianyu_listen_account_ids,
    xianyu_account_id,
    price_from: pf,
    price_to: pt,
    poll_interval_ms,
    interval_jitter_enabled:
      r.interval_jitter_enabled === true ||
      r.interval_jitter_enabled === '1' ||
      r.interval_jitter_enabled === 1,
    dingtalk_push_enabled: r.dingtalk_push_enabled !== false && r.dingtalk_push_enabled !== '0',
    dingtalk_robot_indices: normalizeDingtalkRobotIndicesPersist(r.dingtalk_robot_indices),
    miaopai_enabled: r.miaopai_enabled === true || r.miaopai_enabled === '1' || r.miaopai_enabled === 1,
    miaopai_account_ids,
    miaopai_account_id: mpId,
    miaopai_deliver_id: String(r?.miaopai_deliver_id || '').trim().slice(0, 32),
    miaopai_deliver_label: String(r?.miaopai_deliver_label || '').trim().slice(0, 160),
    greeting_enabled: r.greeting_enabled === true || r.greeting_enabled === '1' || r.greeting_enabled === 1,
    greeting_template_ids: normalizeGreetingTemplateIdsPersist(r.greeting_template_ids),
    greeting_delivery_mode: normalizeGreetingDeliveryMode(r.greeting_delivery_mode),
    new_item_within_sec: normalizeNewItemWithinSec(r.new_item_within_sec),
    shop_display_nick: normalizeShopDisplayNick(r.shop_display_nick),
    shop_display_name: normalizeShopDisplayShopName(r.shop_display_name),
    shop_display_avatar: normalizeShopDisplayAvatar(r.shop_display_avatar),
    created_at: String(r.created_at || '').trim().slice(0, 40),
    updated_at: String(r.updated_at || '').trim().slice(0, 40),
    last_run_at: r.last_run_at != null ? String(r.last_run_at).trim().slice(0, 40) : ''
  }
}

/**
 * @param {unknown} list
 */
function normalizeShopMonitorsList(list) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const x of list) {
    const m = normalizeShopMonitorPersist(x)
    if (!m.seller_user_id || !Array.isArray(m.xianyu_listen_account_ids) || m.xianyu_listen_account_ids.length === 0)
      continue
    if (seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
    if (out.length >= 100) break
  }
  return out
}

export function registerSxjkShopMonitorsIPC(ipcMain, monitorsFile) {
  ipcMain.handle('sxjk-shop-monitors-load', async () => {
    try {
      const text = await fs.readFile(monitorsFile, 'utf-8')
      const data = JSON.parse(text)
      const raw = Array.isArray(data?.monitors) ? data.monitors : Array.isArray(data) ? data : []
      const monitors = normalizeShopMonitorsList(raw)
      return { ok: true, monitors }
    } catch (e) {
      if (e && e.code === 'ENOENT') return { ok: true, monitors: [] }
      console.error('[店铺监听] load', e)
      return { ok: false, error: String(e.message || e), monitors: [] }
    }
  })

  ipcMain.handle('sxjk-shop-monitors-save', async (_e, list) => {
    try {
      const monitors = normalizeShopMonitorsList(list)
      await fs.mkdir(dirname(monitorsFile), { recursive: true })
      const payload = JSON.stringify({ monitors, schemaVersion: 1 }, null, 2)
      const tmp = `${monitorsFile}.${process.pid}.${randomUUID()}.tmp`
      await fs.writeFile(tmp, payload, 'utf-8')
      await fs.rename(tmp, monitorsFile)
      return { ok: true, monitors }
    } catch (e) {
      console.error('[店铺监听] save', e)
      return { ok: false, error: String(e.message || e) }
    }
  })
}

export function registerSxjkNormalizeMtopCardListIPC(ipcMain) {
  ipcMain.handle('sxjk-normalize-mtop-card-list-json', async (_e, body = {}) => {
    try {
      const require = createRequire(import.meta.url)
      const { normalizeItems } = require(join(__dirname, '..', 'lib', 'xy_sxjk', 'normalize-items.js'))
      const json = body?.json ?? body?.mtopRawJson ?? null
      const items = normalizeItems(json)
      return { ok: true, items: Array.isArray(items) ? items : [] }
    } catch (e) {
      console.error('[店铺卡片规范化]', e)
      return { ok: false, error: String(e?.message || e), items: [] }
    }
  })
}

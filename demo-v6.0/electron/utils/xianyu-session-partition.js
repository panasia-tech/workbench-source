/**
 * Electron 闲鱼相关 session 分区命名。
 * 应用内独立闲鱼窗口 / 重新登录：一账号一 `persist:xianyu_sxjk_<id>`。
 * 账号管理「嵌入」：与闲鱼工作台多开一致，每账号 `persist:xianyu_sxjk_<id>`，三套 BrowserView 共用该账号分区。
 *
 * 例外：`__global__`、`__guest_auth__` 仍用 `persist:sxjk_gf_tabs_*`，与历史数据兼容。
 */
import { session } from 'electron'

/** 与账号 JSON、listing 窗口一致 */
export function partitionForListingAccount(id) {
  const safe = String(id || '').replace(/[^\w-]/g, '')
  if (!safe) return 'persist:xianyu_sxjk_default'
  return `persist:xianyu_sxjk_${safe}`
}

/**
 * 升级前：应用内闲鱼窗口使用 `persist:sxjk_gf_tabs_<sanitizedKey>`。删号或迁移时用于清理旧罐。
 * @param {string} browserKey 与 `partitionPersistIdForGoofishBrowseShell` 历史规则相同的 key
 */
export function legacySxjkGfTabsPartition(browserKey) {
  const raw = String(browserKey || '').trim() || '__global__'
  if (raw === '__global__') return 'persist:sxjk_gf_tabs_global'
  const safe = raw.replace(/[^\w-]/g, '').slice(0, 80) || 'global'
  return `persist:sxjk_gf_tabs_${safe}`
}

/**
 * 应用内闲鱼浏览窗口 / 游客授权 / 全局打开 使用的分区。
 * @param {string} browserKey 账号 id、`__global__`、`__guest_auth__`、首次登录的 `managed_…` 等
 */
export function partitionPersistIdForGoofishBrowseShell(browserKey) {
  const k = String(browserKey || '').trim() || '__global__'
  if (k === '__global__') return 'persist:sxjk_gf_tabs_global'
  if (k === '__guest_auth__') return legacySxjkGfTabsPartition(k)
  return partitionForListingAccount(k)
}

/** 新账号窗口登录前使用的临时 browserKey（按手机号），删号时须一并清空 */
export function managedBrowserKeyForPhone(phone) {
  const p = String(phone || '')
    .replace(/[^\w-]/g, '')
    .slice(0, 40)
  return p ? `managed_${p}` : 'managed_new'
}

/**
 * 删号 / 新号登录前：清空账号 id 与 managed_<手机号> 两套分区里的 Cookie 与本地存储。
 * @param {string} accountId
 * @param {string} [phone]
 */
export async function clearGoofishSessionPartitionsForAccount(accountId, phone = '') {
  const keys = new Set()
  const id = String(accountId || '').trim()
  if (id) keys.add(id)
  const mk = managedBrowserKeyForPhone(phone)
  if (mk) keys.add(mk)
  for (const k of keys) {
    for (const part of [partitionForListingAccount(k), legacySxjkGfTabsPartition(k)]) {
      try {
        await session.fromPartition(part).clearStorageData()
      } catch (e) {
        console.warn('[闲鱼会话分区] clearStorageData:', part, e?.message || e)
      }
    }
  }
}

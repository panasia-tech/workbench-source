/**
 * 账号管理「嵌入」：与闲鱼工作台多开一致，每账号独立 persist 分区（persist:xianyu_sxjk_<id>），
 * 登录态留在各自 BrowserView 的 session 里，切换 Tab 只换挂视图，不再共用一罐 Cookie。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { app, session } from 'electron'
import { partitionForListingAccount } from './xianyu-session-partition.js'
import {
  removeAllCookiesForUrls,
  GOOFISH_COOKIE_HEADER_INJECT_URLS
} from './xianyu-playwright-cookies-to-electron.js'

/** 历史共用分区（升级前）；新逻辑不再写入，启动时可清空避免污染 */
export const GOOFISH_EMBED_SHARED_PARTITION = 'persist:xianyu_sxjk_embed_shared'

/** 当前嵌入区展示的账号 id（仅用于落盘/续期时判断是否同步到该账号分区） */
let activeEmbedAccountId = null

/** @param {string} accountId */
export function partitionForAccountEmbed(accountId) {
  return partitionForListingAccount(accountId)
}

export function getEmbedSharedPartitionActiveAccountId() {
  return activeEmbedAccountId
}

export function setEmbedSharedPartitionActiveAccountId(accountId) {
  activeEmbedAccountId = String(accountId || '').trim() || null
}

export function clearEmbedSharedPartitionActiveAccountId() {
  activeEmbedAccountId = null
}

/** 升级：清空旧版共用嵌入分区（仅执行一次，避免每次启动误清历史登录态） */
const LEGACY_EMBED_SHARED_CLEARED_FLAG = '.sxjk-embed-shared-cleared.done'

export async function clearLegacyEmbedSharedPartitionOnce(userDataPath = '') {
  const flagRoot = String(userDataPath || app.getPath('userData') || '').trim()
  const flagPath = flagRoot ? join(flagRoot, LEGACY_EMBED_SHARED_CLEARED_FLAG) : ''
  if (flagPath) {
    try {
      await fs.access(flagPath)
      return
    } catch {
      /* 首次执行 */
    }
  }
  try {
    const sess = session.fromPartition(GOOFISH_EMBED_SHARED_PARTITION)
    await removeAllCookiesForUrls(sess, GOOFISH_COOKIE_HEADER_INJECT_URLS)
    await sess.clearStorageData()
    console.log('[闲鱼嵌入会话] 已清空旧版共用嵌入分区（一次性）')
    if (flagPath) {
      await fs.writeFile(flagPath, new Date().toISOString(), 'utf-8')
    }
  } catch (e) {
    console.warn('[闲鱼嵌入会话] 清空旧版共用分区失败', e?.message || e)
  }
}

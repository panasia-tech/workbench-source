/**
 * 闲鱼应用内 BrowserWindow 使用独立 session 分区时，对齐桌面 Chrome 133（与 IM 一致）。
 */
import { session } from 'electron'
import { GOOFISH_ELECTRON_BROWSE_USER_AGENT } from './xianyu-playwright-config.js'

const configuredPartitions = new Set()

export function getChromeLikeUserAgent() {
  return GOOFISH_ELECTRON_BROWSE_USER_AGENT
}

export function clientHintPlatformQuoted() {
  const p = process.platform
  if (p === 'darwin') return '"macOS"'
  if (p === 'linux') return '"Linux"'
  return '"Windows"'
}

export function buildSecChUa() {
  return '"Chromium";v="133", "Google Chrome";v="133", "Not-A.Brand";v="24"'
}

/** @param {string} partition */
export function ensureGoofishPartitionChromeLike(partition) {
  if (!partition || typeof partition !== 'string') return
  if (configuredPartitions.has(partition)) return

  const sess = session.fromPartition(partition)
  const ua = getChromeLikeUserAgent()
  const secChUa = buildSecChUa()
  const platform = clientHintPlatformQuoted()

  try {
    sess.setUserAgent(ua)
  } catch (e) {
    console.warn('[闲鱼会话] 设置UA失败:', e)
  }

  try {
    sess.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
      const headers = { ...(details.requestHeaders || {}) }
      headers['User-Agent'] = ua
      headers['Sec-CH-UA'] = secChUa
      headers['sec-ch-ua'] = secChUa
      headers['Sec-CH-UA-Mobile'] = '?0'
      headers['sec-ch-ua-mobile'] = '?0'
      headers['Sec-CH-UA-Platform'] = platform
      headers['sec-ch-ua-platform'] = platform
      callback({ requestHeaders: headers })
    })
    configuredPartitions.add(partition)
  } catch (e) {
    console.warn('[闲鱼会话] 请求头拦截失败:', e)
  }
}

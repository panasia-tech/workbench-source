/**
 * 账号管理「一键全部登录」等 Playwright 浏览器：可选从代理商接口拉取 ip:port，写入 chromium.launch({ proxy })。
 * 仅在配置了环境变量 HARDCODED_DM_PROXY_FETCH_URL（见闲鱼上新监控/.env）时启用。
 */
import axios from 'axios'

/** @returns {string} */
function resolveDmProxyFetchUrlFromEnv() {
  return String(process.env.HARDCODED_DM_PROXY_FETCH_URL ?? '').trim()
}

/**
 * @returns {Promise<import('playwright').ProxySettings | null>}
 */
export async function fetchDmProxyPlaywrightSettings() {
  const fetchUrl = resolveDmProxyFetchUrlFromEnv()
  if (!fetchUrl) return null

  const res = await axios.get(fetchUrl, {
    timeout: 20000,
    responseType: 'text',
    proxy: false,
    validateStatus: () => true
  })
  const raw = typeof res.data === 'string' ? res.data.trim() : ''
  if (!raw) return null

  const oneLine = raw.split(/\r?\n/)[0].trim()
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}$/.test(oneLine)) {
    return { server: `http://${oneLine}` }
  }

  try {
    const j = JSON.parse(raw)
    if (j && j.success === false) return null
    if (Array.isArray(j?.data) && j.data.length) {
      const s = String(j.data[0] ?? '').trim()
      if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{2,5}$/.test(s)) {
        return { server: `http://${s}` }
      }
    }
  } catch {
    /* 非 JSON */
  }
  return null
}

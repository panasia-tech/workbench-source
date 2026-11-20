/**
 * 闲鱼 MTOP / Goofish 请求用 Axios。
 *
 * 与「逆向合集/闲鱼PC/http-client.js」对齐：**MTOP POST 默认直连**（不挂代理），避免代理出口 IP
 * 与浏览器复制的 Cookie 会话不一致，触发闲鱼 RGV587（挤爆）。
 *
 * - `getHttpClientForMtop()`：POST h5api（除搜索外的 MTOP）默认直连。
 * - `getHttpClientForMtopSearch()`：`postMtopFeed(..., { forSearch: true })` 专用；可走环境变量代理。
 * - `httpAxios`：挂 xy-http-proxy，供拉 Goofish 页等非列表 MTOP 场景；**列表搜索**单独用下方 20s 超时实例。
 *
 * 若确需全部 MTOP 走代理，可设：`XIANYU_MTOP_USE_PROXY=1`
 */
const axios = require('axios')
const { attachXianyuProxyInterceptor, shouldRouteSearchThroughProxy } = require('./xy-http-proxy')

function createBase(timeoutMs = 60000) {
  return axios.create({
    timeout: timeoutMs,
    validateStatus: () => true
  })
}

/** 与参考项目一致：无代理，供 MTOP 签名请求 */
const httpAxiosMtopDirect = createBase()

/** 可选代理：拉搜索页合并 Cookie 等（非列表搜索，保持较长超时） */
const httpAxios = createBase()
attachXianyuProxyInterceptor(httpAxios)

/** 列表搜索 MTOP：超时缩短，避免长时间卡住（仅主进程 hasLogin 等遗留直连） */
const SEARCH_MTOP_TIMEOUT_MS = 20000
const httpAxiosMtopSearchDirect = createBase(SEARCH_MTOP_TIMEOUT_MS)
const httpAxiosSearchProxy = createBase(SEARCH_MTOP_TIMEOUT_MS)
attachXianyuProxyInterceptor(httpAxiosSearchProxy)

function mtopUseProxy() {
  const v = String(process.env.XIANYU_MTOP_USE_PROXY || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

function getHttpClientForMtop() {
  return mtopUseProxy() ? httpAxios : httpAxiosMtopDirect
}

/** 仅搜索轮询 MTOP：可走环境变量代理；其它 MTOP 仍用 {@link getHttpClientForMtop} */
function getHttpClientForMtopSearch() {
  return shouldRouteSearchThroughProxy() ? httpAxiosSearchProxy : httpAxiosMtopSearchDirect
}

module.exports = {
  httpAxios,
  httpAxiosMtopDirect,
  getHttpClientForMtop,
  getHttpClientForMtopSearch
}

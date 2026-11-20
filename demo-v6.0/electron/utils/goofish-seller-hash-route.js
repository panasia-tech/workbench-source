/**
 * 鱼小铺 seller 嵌入页：只比较 hash 主路由，忽略 ?site=COMMONPRO 等查询参数。
 */

/** @param {string} url */
export function parseGoofishSellerMainHashRoute(url) {
  try {
    const u = new URL(String(url || '').trim())
    if (!/seller\.goofish\.com/i.test(u.hostname)) return ''
    let hash = String(u.hash || '').trim()
    if (!hash) return ''
    hash = hash.replace(/^#\/?/, '')
    return hash.split('?')[0].replace(/\/+$/, '').toLowerCase()
  } catch {
    return ''
  }
}

export const GOOFISH_SELLER_HASH_LOGIN = 'login'
export const GOOFISH_SELLER_HASH_LOGGED_IN = 'seller-data/data'

/**
 * @param {string} url
 * @returns {'login' | 'logged_in' | 'other'}
 */
export function classifyGoofishSellerEmbedRoute(url) {
  const route = parseGoofishSellerMainHashRoute(url)
  if (route === GOOFISH_SELLER_HASH_LOGIN) return 'login'
  if (route === GOOFISH_SELLER_HASH_LOGGED_IN) return 'logged_in'
  return 'other'
}

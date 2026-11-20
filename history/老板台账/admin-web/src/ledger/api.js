import axios from 'axios'

// 令牌：自己登的、后台的、H5 的三个来源。从哪儿点进来就先用哪儿的（?from=h5 / ?from=admin，存在本标签页里刷新不丢）——
// 公用电脑上前一个人留着台账或后台的登录，后一个人从 H5「我的」点进来，看到的得是自己，不是前一个人。
// 直接打开链接（书签）才先用自己登的。点过「退出」或被服务端判过期的令牌记下来，不再借。
const KEY = 'ledger_token'
const SKIP_KEY = 'ledger_skip_tokens'
const FROM_KEY = 'ledger_from'

function read(key) {
  try {
    return localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

function h5Token() {
  try {
    return JSON.parse(localStorage.getItem('mp:token') || 'null')?.v || ''
  } catch {
    return ''
  }
}

function entryFrom() {
  try {
    const q = new URLSearchParams(location.search).get('from')
    if (q) sessionStorage.setItem(FROM_KEY, q)
    return q || sessionStorage.getItem(FROM_KEY) || ''
  } catch {
    return ''
  }
}

function skipped() {
  try {
    return JSON.parse(localStorage.getItem(SKIP_KEY) || '[]')
  } catch {
    return []
  }
}

/** 这个令牌不再借（退出、过期）；只留最近几个 */
export function skipToken(token) {
  if (!token) return
  if (token === read(KEY)) setToken('')
  try {
    localStorage.setItem(SKIP_KEY, JSON.stringify([token, ...skipped().filter((t) => t !== token)].slice(0, 6)))
  } catch {
    /* 存不了就算了 */
  }
}

function candidates() {
  const own = read(KEY)
  const admin = read('token')
  const h5 = h5Token()
  const from = entryFrom()
  const order = from === 'h5' ? [h5, own, admin] : from === 'admin' ? [admin, own, h5] : [own, admin, h5]
  const skip = skipped()
  return order.filter((t, i) => t && order.indexOf(t) === i && !skip.includes(t))
}

export function getToken() {
  return candidates()[0] || ''
}

/** 借来的令牌认出人了：自己存的那个是别人（或更早）的，丢掉，免得下次直接打开又变回那个人 */
export function settleToken() {
  const used = getToken()
  if (used && read(KEY) && read(KEY) !== used) setToken('')
}

/** 退出：这几个来源现在的令牌都不再借，下次进来要自己登 */
export function forgetAll() {
  candidates().forEach(skipToken)
}

export function setToken(token) {
  try {
    if (token) {
      localStorage.setItem(KEY, token)
      // 刚登的就是要用的：别再被来源顺序顶掉，也从「不再借」里拿出来
      sessionStorage.removeItem(FROM_KEY)
      localStorage.setItem(SKIP_KEY, JSON.stringify(skipped().filter((t) => t !== token)))
    } else localStorage.removeItem(KEY)
  } catch {
    /* 隐私模式存不了，就只在这次打开里有效 */
  }
}

const api = axios.create({ baseURL: '/api' })

api.interceptors.request.use((config) => {
  const token = getToken()
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

export function errText(err, fallback = '出错了') {
  const d = err?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d)) return '有一项没填对'
  return fallback
}

export default api

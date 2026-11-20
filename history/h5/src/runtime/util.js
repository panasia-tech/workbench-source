// 运行时公用小工具

export function isPlainObject(v) {
  return Object.prototype.toString.call(v) === '[object Object]'
}

/** 小程序 data 是值拷贝：每个页面实例拿一份独立的初始数据 */
export function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone)
  if (isPlainObject(v)) {
    const out = {}
    for (const k of Object.keys(v)) {
      if (typeof v[k] !== 'function') out[k] = deepClone(v[k])
    }
    return out
  }
  return v
}

/** setData 的路径：'a.b[0].c' → ['a', 'b', 0, 'c'] */
export function parsePath(key) {
  const out = []
  const re = /([^.[\]]+)|\[(\d+)\]/g
  let m
  while ((m = re.exec(key))) out.push(m[2] !== undefined ? Number(m[2]) : m[1])
  return out
}

export function getByPath(obj, key) {
  let cur = obj
  for (const k of parsePath(key)) {
    if (cur == null) return undefined
    cur = cur[k]
  }
  return cur
}

/** 小程序的布尔属性：无值 / true / 非空字符串都算真（连 "false" 也是真） */
export function isTrue(v) {
  if (v === '' || v === true) return true
  if (v === false || v == null || v === 0) return false
  return !!v
}

const warned = new Set()
export function warnOnce(msg) {
  if (warned.has(msg)) return
  warned.add(msg)
  console.warn(`[H5] ${msg}`)
}

const RPX_RE = /(?<![\w.#-])(-?(?:\d+\.?\d*|\.\d+))rpx\b/g
const VH_RE = /(?<![\w.#-])(-?(?:\d+\.?\d*|\.\d+))vh\b/g
const rpxCache = new Map()

/** 动态 style 里的 rpx / vh（静态的在构建期已换掉） */
export function convertStyle(style) {
  if (style == null || style === '') return style
  if (typeof style !== 'string') return style
  let out = rpxCache.get(style)
  if (out === undefined) {
    out = style
      .replace(RPX_RE, (_, n) => `calc(${n} * var(--rpx))`)
      .replace(VH_RE, (_, n) => `calc(${n} * var(--mp-vh, 1vh))`)
    if (rpxCache.size > 2000) rpxCache.clear()
    rpxCache.set(style, out)
  }
  return out
}

/** rpx 换算成当前屏幕的 px（JS 里要用数值的地方，比如 picker-view 的行高）。基准同 base.css 的 --rpx-base-w */
export function rpxToPx(n) {
  const vw = window.innerWidth || 375
  const w = vw >= 1024 ? 420 : Math.min(vw, 480)
  return (Number(n) * w) / 750
}

/** '112rpx' / '44px' / 44 → px 数值 */
export function lengthToPx(v, fallback = 0) {
  if (v == null || v === '') return fallback
  if (typeof v === 'number') return v
  const m = String(v).trim().match(/^(-?[\d.]+)\s*(rpx|px)?$/)
  if (!m) return fallback
  return m[2] === 'rpx' ? rpxToPx(m[1]) : Number(m[1])
}

export function parseQuery(qs) {
  const out = {}
  if (!qs) return out
  for (const part of qs.split('&')) {
    if (!part) continue
    const i = part.indexOf('=')
    // 小程序 onLoad 拿到的参数不解码（页面里自己 decodeURIComponent），这里保持一致
    if (i < 0) out[part] = ''
    else out[part.slice(0, i)] = part.slice(i + 1)
  }
  return out
}

/** 以 Promise 风格实现的接口，同时支持 success / fail / complete 回调（有回调时不再返回 Promise） */
export function promisify(name, impl) {
  return function api(opts = {}) {
    const options = opts || {}
    const hasCb = typeof options.success === 'function' || typeof options.fail === 'function' || typeof options.complete === 'function'
    const p = Promise.resolve()
      .then(() => impl(options))
      .then(
        (res) => {
          const r = { errMsg: `${name}:ok`, ...(res || {}) }
          if (options.success) options.success(r)
          if (options.complete) options.complete(r)
          return r
        },
        (err) => {
          const e = normalizeErr(name, err)
          if (options.fail) options.fail(e)
          if (options.complete) options.complete(e)
          throw e
        },
      )
    if (hasCb) {
      p.catch(() => {})
      return undefined
    }
    return p
  }
}

export function normalizeErr(name, err) {
  if (err && typeof err === 'object' && typeof err.errMsg === 'string') return err
  const msg = err && err.message ? err.message : String(err || '')
  return { errMsg: `${name}:fail ${msg}`.trim() }
}

/** 同步回调：弹窗类接口在点击事件里直接回调，后续的 chooseMedia 才拿得到「用户手势」 */
export function callbackSync(name, options, ok, res) {
  const r = ok ? { errMsg: `${name}:ok`, ...res } : { errMsg: `${name}:fail ${res || 'cancel'}` }
  try {
    if (ok && options.success) options.success(r)
    if (!ok && options.fail) options.fail(r)
    if (options.complete) options.complete(r)
  } catch (e) {
    console.error(e)
  }
  return r
}

/**
 * 本机锁单 MTOP：遇风控直接返回提示，不调远程 captchaForward、不重试过码。
 * 文案对齐移动端 server/modules/xy_sxjk/mob-miaopai-order.js
 */
import { URL } from 'node:url'

const MTOP_HOST = 'h5api.m.goofish.com'

/** 秒拍遇闲鱼滑块/风控时，面向用户的统一提示（对齐移动端） */
export const MIAOPAI_ACCOUNT_TOO_FREQUENT_MSG =
  '该秒拍账号操作过于频繁，已触发闲鱼验证。请切换其他秒拍账号重试，或耐心等待自动解除（具体时间未知，通常需数小时）'

function isMtopTokenExpiredMessage(msg) {
  const s = String(msg || '')
  if (!s) return false
  const u = s.toUpperCase()
  return (
    u.includes('FAIL_SYS_TOKEN') ||
    u.includes('TOKEN_EXOIRED') ||
    u.includes('TOKEN_EXPIRED') ||
    u.includes('SESSION_EXPIRED') ||
    s.includes('令牌过期')
  )
}

/** 锁单步骤中文标签（用户可见） */
export const LOCK_ORDER_RISK_STEP_LABEL = {
  detail: '商品详情',
  address: '收货地址',
  orderRender: '确认订单',
  createOrder: '创建订单'
}

/** 步骤 source 标签（日志，兼容旧调用） */
export const LOCK_ORDER_CAPTCHA_SOURCE = {
  detail: '秒拍-详情',
  address: '秒拍-地址',
  orderRender: '秒拍-确认订单',
  createOrder: '秒拍-下单'
}

function normalizeCookieHeader(cookie) {
  return String(cookie || '')
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, '')
    .trim()
}

function firstRetMessageFromJson(json) {
  const ret = json?.ret
  if (Array.isArray(ret) && ret.length) return String(ret[0] || '').trim()
  if (typeof ret === 'string') return ret.trim()
  return ''
}

function isMtopSuccess(json) {
  return String(firstRetMessageFromJson(json) || '').includes('SUCCESS')
}

export function isMtopRiskResponse(json) {
  if (!json || typeof json !== 'object') return false
  const ret0 = firstRetMessageFromJson(json)
  const ret1 = Array.isArray(json.ret) ? String(json.ret[1] || '') : ''
  if (/FAIL_SYS_USER_VALIDATE|RGV587/i.test(ret0)) return true
  if (/RGV587|挤爆|USER_VALIDATE|哎哟喂/i.test(ret1)) return true
  const punishUrl = String(json?.data?.url || '')
  return /punish|_____tmd_____|x5sec|captcha/i.test(punishUrl)
}

export function extractPunishUrl(json) {
  const raw = String(json?.data?.url || '').trim()
  if (!raw) return ''
  if (!/punish|_____tmd_____|x5sec|captcha/i.test(raw)) return ''
  const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${MTOP_HOST}${raw.startsWith('/') ? raw : `/${raw}`}`
  try {
    return new URL(withProto.replace(/^(https?:\/\/[^/]+)\/+/i, (_, host) => `${host}/`)).href
  } catch {
    return withProto
  }
}

function flattenMtopErrorText(message, mtopRet) {
  const parts = []
  const msg = String(message || '').trim()
  if (msg) parts.push(msg)
  if (Array.isArray(mtopRet)) {
    for (const row of mtopRet) {
      const text = String(row || '').trim()
      if (text && !parts.includes(text)) parts.push(text)
    }
  }
  return parts.join(' | ')
}

/** 从 punish URL 提取 API 作用域 */
export function punishUrlScopeKey(punishUrl) {
  const u = String(punishUrl || '').toLowerCase()
  if (u.includes('order.create')) return 'order.create'
  if (u.includes('pc.detail') || u.includes('idle.pc.detail')) return 'pc.detail'
  if (u.includes('address')) return 'address'
  const match = u.match(/mtop\.[a-z0-9._]+/i)
  return match ? match[0] : u.slice(0, 64)
}

/** 会话过期类错误不当作风控过码 */
export function isMtopRiskNeedCaptcha(json, combinedErr, mtopRet) {
  if (isMtopTokenExpiredMessage(combinedErr)) return false
  if (Array.isArray(mtopRet) && mtopRet.some((r) => isMtopTokenExpiredMessage(r))) return false
  return isMtopRiskResponse(json) || /RGV587|USER_VALIDATE|挤爆|哎哟喂|punish|滑块|人机/i.test(String(combinedErr || ''))
}

export function humanizeMiaopaiCaptchaRiskError(riskStepLabel) {
  const prefix = String(riskStepLabel || '').trim() ? `【${String(riskStepLabel).trim()}】` : ''
  return `${prefix}${MIAOPAI_ACCOUNT_TOO_FREQUENT_MSG}`
}

/**
 * 批量锁单共享 Cookie 上下文
 * @param {string} accountId
 * @param {string} initialCookie
 */
export function createAccountCookieContext(accountId, initialCookie) {
  const aid = String(accountId || '').trim()
  let current = normalizeCookieHeader(initialCookie)
  return {
    accountId: aid,
    get() {
      return current
    },
    set(nextCookie) {
      const normalized = normalizeCookieHeader(nextCookie)
      if (normalized) current = normalized
    }
  }
}

/**
 * MTOP 单次执行：遇风控直接返回提示，不远程过码、不重试
 *
 * @param {{
 *   accountId?: string,
 *   cookie?: string,
 *   cookieCtx?: { get: () => string, set: (c: string) => void },
 *   source?: string,
 *   riskStepLabel?: string,
 *   onCookieUpdated?: (cookie: string) => void | Promise<void>,
 *   execute: (cookie: string) => Promise<{ ok?: boolean, json?: object, cookie?: string, error?: string, [k: string]: any }>
 * }} opts
 */
export async function runMtopWithCaptchaRetry(opts) {
  const cookieCtx = opts?.cookieCtx || null
  let cookie = cookieCtx ? cookieCtx.get() : normalizeCookieHeader(opts?.cookie)
  const riskStepLabel = String(opts?.riskStepLabel || '').trim()
  const execute = opts?.execute
  if (typeof execute !== 'function') {
    throw new Error('runMtopWithCaptchaRetry 缺少 execute')
  }

  const persistCookie = async (next) => {
    const normalized = normalizeCookieHeader(next) || cookie
    cookie = normalized
    if (cookieCtx) cookieCtx.set(normalized)
    if (typeof opts?.onCookieUpdated === 'function') {
      try {
        await opts.onCookieUpdated(normalized)
      } catch (e) {
        console.warn('[sxjk-captcha] onCookieUpdated', e?.message || e)
      }
    }
    return normalized
  }

  cookie = cookieCtx ? cookieCtx.get() : cookie
  const result = await execute(cookie)
  await persistCookie(String(result?.cookie || cookie || '').trim())

  if (result?.ok === true || (result?.json && isMtopSuccess(result.json))) {
    return {
      ...result,
      cookie,
      captchaTried: false,
      captchaOk: false,
      captchaScope: '',
      riskStepLabel
    }
  }

  const json = result?.json
  const retMsg = firstRetMessageFromJson(json)
  const mtopRet = json?.ret
  const combinedErr = flattenMtopErrorText(result?.error || retMsg, mtopRet)
  const punishUrl = extractPunishUrl(json)
  const captchaScope = punishUrl ? punishUrlScopeKey(punishUrl) : ''

  if (isMtopRiskNeedCaptcha(json, combinedErr, mtopRet)) {
    console.warn('[sxjk-captcha] 遇风控，跳过远程过码', {
      source: String(opts?.source || '').trim(),
      accountId: String(opts?.accountId || '').trim(),
      riskStepLabel,
      scopeKey: captchaScope
    })
    return {
      ...result,
      cookie,
      captchaTried: false,
      captchaOk: false,
      captchaScope,
      riskStepLabel,
      error: humanizeMiaopaiCaptchaRiskError(riskStepLabel)
    }
  }

  return {
    ...result,
    cookie,
    captchaTried: false,
    captchaOk: false,
    captchaScope,
    riskStepLabel,
    error: combinedErr || result?.error
  }
}

/**
 * 把步骤标签拼进失败文案（无前缀时补上）
 */
export function formatLockOrderRiskError(riskStepLabel, error) {
  const label = String(riskStepLabel || '').trim()
  const err = String(error || '').trim()
  if (!err) return label ? `【${label}】锁单失败` : '锁单失败'
  if (label && !err.includes(`【${label}】`)) return `【${label}】${err}`
  return err
}

/** 主进程 · 私聊实时：面向用户的提示（浏览「已登录」≠ 私聊通道已连） */

export const GOOFISH_IM_VERIFY_OPENED_HINT =
  '已打开闲鱼验证窗口：请把滑块拖到最右边完成验证，然后关闭该窗口。'

/** 验证窗顶部黄条：按场景追加第二行说明 */
const GOOFISH_IM_VERIFY_SOURCE_SUFFIX = {
  greeting: '完成后可在钉钉再点一次打招呼。',
  lock_order: '验证通过后可在钉钉再点一次锁单。',
  manual_connect: '验证通过后关闭窗口，再点「连接私聊」即可。',
  warmup: '验证通过后关闭窗口，系统将自动继续连接私聊。'
}

/** @param {string} [source] */
export function buildGoofishImVerifyBannerSuffix(source) {
  const key = String(source || '').trim()
  return GOOFISH_IM_VERIFY_SOURCE_SUFFIX[key] || ''
}

export const GOOFISH_IM_NEED_VERIFY_HINT =
  '私聊被闲鱼拦住了。请在验证窗拖完滑块后关闭，系统会自动重连；若仍失败请重新登录。'

export const GOOFISH_IM_MISSING_UNB_HINT =
  '缺少「用户登录标识」（unb，私聊专用）。当前只能搜商品，不能连私聊。请点「重新登录」→ 在闲鱼主页顶栏出现昵称 → 关闭窗口 → 再点「连接私聊」。'

export const GOOFISH_IM_REG_TIMEOUT_HINT =
  '私聊通道暂时连不上（未完成注册）。请稍后再试；若反复失败，请重新登录该账号。'

export const GOOFISH_IM_SESSION_EXPIRED_HINT =
  '闲鱼登录已过期。请到账号管理对该账号点「重新登录」，完成后再点「连接私聊」。'

/**
 * 是否像「要过滑块/风控」。
 * 注意：IM 注册超时 / 未收到 sid 不是滑块问题，不要弹验证窗。
 */
export function looksLikeImVerifyErrorText(rawText) {
  const t = String(rawText || '').trim()
  if (!t) return false
  if (/未收到 sid|IM 注册超时|IM 注册失败/i.test(t)) return false
  return /FAIL_SYS_USER_VALIDATE|USER_VALIDATE|滑块|人机验证|人机校验|RGV587|挤爆|哎哟喂|安全验证|punish|_____tmd_____|x5sec|captcha|risk\.taobao/i.test(
    t
  )
}

function mtopChallengeRet0(json) {
  if (!json || typeof json !== 'object') return ''
  return Array.isArray(json.ret) ? String(json.ret[0] || '') : String(json.ret || '')
}

/**
 * 是否应弹验证辅助窗。
 * 有 punish 链 → 开真验证页；仅有 USER_VALIDATE/RGV587 → 开 /im（旧流程，过滑块后关窗可连上）。
 * 会话过期只重登，不开窗。
 */
export function shouldOpenImSliderAssistForChallenge(json) {
  if (!json || typeof json !== 'object') return false
  const ret0 = mtopChallengeRet0(json)
  if (/FAIL_SYS_SESSION_EXPIRED/i.test(ret0)) return false
  const punish = String(json?.data?.url || '').trim()
  if (
    punish &&
    /^https?:\/\//i.test(punish) &&
    /punish|_____tmd_____|x5sec|captcha|risk\.taobao|\/sm\//i.test(punish)
  ) {
    return true
  }
  if (/FAIL_SYS_USER_VALIDATE|USER_VALIDATE|RGV587/i.test(ret0)) return true
  const ret1 = Array.isArray(json.ret) ? String(json.ret[1] || '') : ''
  return /RGV587|挤爆|USER_VALIDATE|人机验证|安全验证|滑块|哎哟喂/i.test(ret1)
}

/** @param {unknown} err */
export function inferMtopAntiBotBodyFromImError(err) {
  const body = err && typeof err === 'object' ? err.body : null
  if (body && typeof body === 'object' && shouldOpenImSliderAssistForChallenge(body)) {
    return body
  }
  const msg = String(err?.message || err || '').trim()
  if (!looksLikeImVerifyErrorText(msg)) return null
  return { ret: [msg.includes('::') ? msg : `FAIL_SYS_USER_VALIDATE::${msg}`] }
}

/** @param {string} errText */
export function inferMtopAntiBotBodyFromLockOrderError(errText) {
  const msg = String(errText || '').trim()
  if (!looksLikeImVerifyErrorText(msg)) return null
  return { ret: [msg.includes('::') ? msg : `FAIL_SYS_USER_VALIDATE::${msg}`] }
}

export function humanizeGoofishImErrorMain(rawText) {
  const t = String(rawText || '').trim()
  if (!t) return '私聊暂时连不上，请稍后点「连接私聊」重试。'
  if (/已打开.*验证|已打开验证页|已弹出验证页/i.test(t)) return GOOFISH_IM_VERIFY_OPENED_HINT
  if (/已打开闲鱼|拖完滑块|稍等后关闭|再重试监听|自动重试「实时|正在连接私聊/i.test(t)) {
    return ''
  }
  if (/不再重复弹窗|已试过滑块/i.test(t)) return t
  if (/用户登录标识.*unb|私聊专用.*不能连私聊/i.test(t)) return t
  if (/缺少 unb|unb（私聊|Cookie 中缺少 unb|须账号登录态/i.test(t)) {
    return GOOFISH_IM_MISSING_UNB_HINT
  }
  if (/FAIL_SYS_SESSION_EXPIRED|Session过期|会话过期/i.test(t)) {
    return GOOFISH_IM_SESSION_EXPIRED_HINT
  }
  if (/未收到 sid|IM 注册超时|IM 注册失败/i.test(t)) return GOOFISH_IM_REG_TIMEOUT_HINT
  if (/消息页未能打开|打开验证窗口|打开页面失败|窗口已关闭/i.test(t)) return t
  if (looksLikeImVerifyErrorText(t)) return GOOFISH_IM_NEED_VERIFY_HINT
  if (/NETWORK|ECONNREFUSED|ENOTFOUND|timeout|超时/i.test(t)) {
    return '网络异常，私聊暂时连不上，请稍后再试。'
  }
  if (t.length <= 80 && !/^FAIL_SYS_/i.test(t)) return t
  return '私聊暂时连不上，请稍后再试；若反复失败请重新登录该账号。'
}

/**
 * MTOP 风控 / 滑块 JSON 判定（无 sign 依赖）
 */
function isMtopAntiBotChallengeJson(json) {
  if (!json || typeof json !== 'object') return false
  const ret0 = Array.isArray(json.ret) ? String(json.ret[0] || '') : String(json.ret || '')
  const ret1 = Array.isArray(json.ret) ? String(json.ret[1] || '') : ''
  if (/FAIL_SYS_USER_VALIDATE|FAIL_SYS_SESSION_EXPIRED|RGV587/i.test(ret0)) return true
  if (/RGV587|挤爆|USER_VALIDATE|人机验证|安全验证|滑块|哎哟喂/i.test(ret1)) return true
  const raw = String(json?.data?.url || '').trim()
  if (
    raw &&
    /^https?:\/\//i.test(raw) &&
    /punish|_____tmd_____|x5sec|captcha|risk\.taobao|\/sm\//i.test(raw)
  ) {
    return true
  }
  return false
}

module.exports = { isMtopAntiBotChallengeJson }

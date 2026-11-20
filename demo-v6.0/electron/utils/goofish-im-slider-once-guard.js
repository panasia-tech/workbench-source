/**
 * 私聊实时风控：每账号本进程内只自动弹一次 /im 滑块，避免关窗重试失败后再弹窗死循环。
 */
const imSliderAssistUsed = new Set()

/** 锁单风控：每账号本进程内只自动弹一次商品详情验证窗，避免批量秒拍反复刷新同一窗口 */
const lockOrderRiskAssistUsed = new Set()

export function hasImSliderAssistUsed(accountId) {
  const id = String(accountId || '').trim()
  return id ? imSliderAssistUsed.has(id) : false
}

export function markImSliderAssistUsed(accountId) {
  const id = String(accountId || '').trim()
  if (id) imSliderAssistUsed.add(id)
}

export function clearImSliderAssistUsed(accountId) {
  const id = String(accountId || '').trim()
  if (id) imSliderAssistUsed.delete(id)
}

export function hasLockOrderRiskAssistUsed(accountId) {
  const id = String(accountId || '').trim()
  return id ? lockOrderRiskAssistUsed.has(id) : false
}

/** 占位成功返回 true；已占位返回 false（并发秒拍只开一次验证窗） */
export function tryMarkLockOrderRiskAssistUsed(accountId) {
  const id = String(accountId || '').trim()
  if (!id || lockOrderRiskAssistUsed.has(id)) return false
  lockOrderRiskAssistUsed.add(id)
  return true
}

export function clearLockOrderRiskAssistUsed(accountId) {
  const id = String(accountId || '').trim()
  if (id) lockOrderRiskAssistUsed.delete(id)
}

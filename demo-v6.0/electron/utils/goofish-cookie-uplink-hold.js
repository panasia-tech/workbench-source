/**
 * 过码/关窗上行窗口：短暂禁止 pull 注入覆盖本机新区 Cookie。
 * 避免「本机已有新 x5sec → pull 旧云端 → 再 sync 把旧串写回库」。
 */
/** @type {Map<string, number>} accountId → holdUntilMs */
const holdUntilByAccount = new Map()

/** 开验证窗时记下的 x5sec，关窗后对比是否换成新值 @type {Map<string, string>} */
const x5secBeforeVerifyByAccount = new Map()

/**
 * 打开验证窗前调用：记下当前分区 x5sec（可能为空）
 * @param {string} accountId
 * @param {string} [x5sec]
 */
export function stashX5secBeforeVerify(accountId, x5sec = '') {
  const id = String(accountId || '').trim()
  if (!id) return
  x5secBeforeVerifyByAccount.set(id, String(x5sec || '').trim())
}

/**
 * 关窗后取出开窗前的 x5sec（取出后清除）
 * @param {string} accountId
 */
export function takeX5secBeforeVerify(accountId) {
  const id = String(accountId || '').trim()
  if (!id) return ''
  const v = x5secBeforeVerifyByAccount.get(id) || ''
  x5secBeforeVerifyByAccount.delete(id)
  return v
}

/**
 * 关窗后打印开窗前 / 关窗后两份 x5sec，便于核对是否换成新过码
 * @param {string} accountId
 * @param {string} afterX5sec
 */
export function logX5secBeforeAfterOnVerifyClose(accountId, afterX5sec) {
  const id = String(accountId || '').trim()
  const before = takeX5secBeforeVerify(id)
  const after = String(afterX5sec || '').trim()
  const same = before && after ? before === after : false
  console.log('[闲鱼风控] ========== x5sec 开关窗对比 ==========')
  console.log('[闲鱼风控] accountId=', id)
  console.log(
    '[闲鱼风控] 开窗前 x5sec',
    before ? `len=${before.length}` : '(无)',
    before || ''
  )
  console.log(
    '[闲鱼风控] 关窗后 x5sec',
    after ? `len=${after.length}` : '(无)',
    after || ''
  )
  console.log(
    '[闲鱼风控] 两份是否相同=',
    before || after ? (same ? '相同(未换新)' : '不同(已换新或一侧为空)') : '两侧皆空'
  )
  console.log('[闲鱼风控] ========================================')
}

/**
 * @param {string} accountId
 * @param {number} [holdMs] 默认 12s（含上行 + 防抖二次 sync）
 */
export function markAccountCookieUplinkHold(accountId, holdMs = 12000) {
  const id = String(accountId || '').trim()
  if (!id) return
  const ms = Math.max(2000, Number(holdMs) || 12000)
  const until = Date.now() + ms
  const prev = holdUntilByAccount.get(id) || 0
  holdUntilByAccount.set(id, Math.max(prev, until))
}

/** @param {string} accountId */
export function clearAccountCookieUplinkHold(accountId) {
  const id = String(accountId || '').trim()
  if (id) holdUntilByAccount.delete(id)
}

/** @param {string} accountId */
export function isAccountCookieUplinkHeld(accountId) {
  const id = String(accountId || '').trim()
  if (!id) return false
  const until = holdUntilByAccount.get(id)
  if (!until) return false
  if (Date.now() >= until) {
    holdUntilByAccount.delete(id)
    return false
  }
  return true
}

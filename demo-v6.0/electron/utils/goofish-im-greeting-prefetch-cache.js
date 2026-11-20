/** 监控账号 id -> Map<itemId, { peerUserId, spm, sellerKey, at }>（服务端打招呼批量详情后主进程写入） */
const sxjkGreetingPrefetchByAccount = new Map()
const SXJK_GREETING_PREFETCH_PER_ACCOUNT_CAP = 520

export function ingestSxjkGreetingPrefetchRows(accountId, rows) {
  const aid = String(accountId || '').trim()
  if (!aid || !Array.isArray(rows) || !rows.length) return 0
  let sub = sxjkGreetingPrefetchByAccount.get(aid)
  if (!sub) {
    sub = new Map()
    sxjkGreetingPrefetchByAccount.set(aid, sub)
  }
  const at = Date.now()
  let n = 0
  for (const r of rows) {
    const itemId = String(r?.itemId || '').trim()
    const peerUserId = String(r?.peerUserId || '').trim()
    if (!itemId || !peerUserId) continue
    sub.set(itemId, {
      peerUserId,
      spm: String(r?.spm || '').trim(),
      sellerKey: String(r?.sellerKey || '').trim().slice(0, 256),
      at
    })
    n += 1
  }
  while (sub.size > SXJK_GREETING_PREFETCH_PER_ACCOUNT_CAP) {
    let oldestKey = ''
    let oldestAt = Infinity
    for (const [k, v] of sub.entries()) {
      if (v.at < oldestAt) {
        oldestAt = v.at
        oldestKey = k
      }
    }
    if (!oldestKey) break
    sub.delete(oldestKey)
  }
  return n
}

export function getSxjkGreetingPrefetchRow(accountId, itemId) {
  const aid = String(accountId || '').trim()
  const iid = String(itemId || '').trim()
  if (!aid || !iid) return null
  const sub = sxjkGreetingPrefetchByAccount.get(aid)
  if (!sub) return null
  return sub.get(iid) || null
}

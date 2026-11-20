/**
 * 验证窗打开期间监听分区 x5sec 变更；关窗时优先采用「新写入」的值并镜像到 goofish。
 * 解决：过码写在 taobao/punish 域，聚合时仍优先旧 goofish x5sec → 看起来「未换新」。
 */
import { session } from 'electron'
import { partitionForListingAccount } from './xianyu-session-partition.js'
import { replaceX5secInAccountPartition } from './goofish-partition-cookie.js'
import { flushAccountPartitionStore } from './goofish-partition-persist.js'

/** @type {Map<string, { stop: () => void, events: Array<{ value: string, domain: string, at: number, removed: boolean }> }>} */
const watches = new Map()

/**
 * @param {string} accountId
 * @param {string} [partition]
 */
export function startX5secVerifyWatch(accountId, partition = '') {
  const id = String(accountId || '').trim()
  if (!id) return
  stopX5secVerifyWatch(id)
  const part = String(partition || '').trim() || partitionForListingAccount(id)
  let sess
  try {
    sess = session.fromPartition(part)
  } catch (e) {
    console.warn('[闲鱼风控] x5sec 监听启动失败', id, e?.message || e)
    return
  }
  /** @type {Array<{ value: string, domain: string, at: number, removed: boolean }>} */
  const events = []
  const onChanged = (_event, cookie, cause, removed) => {
    const name = String(cookie?.name || '').trim().toLowerCase()
    if (name !== 'x5sec') return
    const value = String(cookie?.value ?? '').trim()
    const domain = String(cookie?.domain || '').trim()
    const at = Date.now()
    events.push({ value, domain, at, removed: removed === true })
    console.log(
      '[闲鱼风控] 验证窗内 x5sec 变更',
      id,
      removed ? '删除' : '写入',
      `cause=${cause || ''}`,
      `domain=${domain || '?'}`,
      value ? `len=${value.length}` : '(空)',
      value || ''
    )
  }
  try {
    sess.cookies.on('changed', onChanged)
  } catch (e) {
    console.warn('[闲鱼风控] 绑定 cookies.changed 失败', id, e?.message || e)
    return
  }
  watches.set(id, {
    events,
    stop: () => {
      try {
        sess.cookies.removeListener('changed', onChanged)
      } catch {
        /* */
      }
    }
  })
  console.log('[闲鱼风控] 已开始监听验证窗 x5sec 变更', id, part)
}

/** @param {string} accountId */
export function stopX5secVerifyWatch(accountId) {
  const id = String(accountId || '').trim()
  if (!id) return
  const w = watches.get(id)
  if (!w) return
  try {
    w.stop()
  } catch {
    /* */
  }
  watches.delete(id)
}

/**
 * 列出分区内所有域的 x5sec（不去重）
 * @param {string} accountId
 * @param {string} [partition]
 */
export async function listAllX5secInPartition(accountId, partition = '') {
  const id = String(accountId || '').trim()
  const part = String(partition || '').trim() || partitionForListingAccount(id)
  try {
    const sess = session.fromPartition(part)
    if (typeof sess.cookies.flushStore === 'function') {
      await sess.cookies.flushStore()
    }
    const list = await sess.cookies.get({})
    return (Array.isArray(list) ? list : [])
      .filter((c) => String(c?.name || '').toLowerCase() === 'x5sec' && String(c?.value || '').trim())
      .map((c) => ({
        domain: String(c.domain || ''),
        value: String(c.value || '').trim(),
        path: String(c.path || '/'),
        expirationDate: c.expirationDate
      }))
  } catch {
    return []
  }
}

/**
 * 关窗时：打印各域 x5sec，选出相对开窗前的新区，并强制写入 goofish 供私聊使用。
 * @param {string} accountId
 * @param {string} beforeX5sec 开窗前
 * @param {string} [partition]
 * @returns {Promise<{ changed: boolean, before: string, after: string, source: string, all: object[] }>}
 */
export async function resolveAndApplyNewX5secAfterVerifyClose(accountId, beforeX5sec, partition = '') {
  const id = String(accountId || '').trim()
  const before = String(beforeX5sec || '').trim()
  const part = String(partition || '').trim() || partitionForListingAccount(id)
  const watch = watches.get(id)
  const events = Array.isArray(watch?.events) ? [...watch.events] : []
  stopX5secVerifyWatch(id)

  await flushAccountPartitionStore(id).catch(() => {})
  const all = await listAllX5secInPartition(id, part)

  console.log('[闲鱼风控] ========== 关窗各域 x5sec 清单 ==========')
  console.log('[闲鱼风控] accountId=', id, `条数=${all.length}`, `监听变更=${events.length}`)
  for (const row of all) {
    console.log(
      '[闲鱼风控] 域x5sec',
      `domain=${row.domain}`,
      `len=${row.value.length}`,
      row.value === before ? '(与开窗前相同)' : '(与开窗前不同)',
      row.value
    )
  }
  if (!all.length) {
    console.warn('[闲鱼风控] 关窗分区内没有任何 x5sec')
  }

  // 1) 监听里最后一次「写入且非空且与开窗前不同」
  let chosen = ''
  let source = ''
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.removed || !ev.value) continue
    if (before && ev.value === before) continue
    chosen = ev.value
    source = `watch:${ev.domain || '?'}`
    break
  }
  // 2) 各域里与开窗前不同的（优先非 goofish，再 goofish；同优先更长）
  if (!chosen) {
    const diffs = all.filter((r) => r.value && r.value !== before)
    diffs.sort((a, b) => {
      const ag = /goofish/i.test(a.domain) ? 1 : 0
      const bg = /goofish/i.test(b.domain) ? 1 : 0
      if (ag !== bg) return ag - bg // 非 goofish 优先（过码常写 taobao）
      return b.value.length - a.value.length
    })
    if (diffs[0]) {
      chosen = diffs[0].value
      source = `domain:${diffs[0].domain}`
    }
  }
  // 3) 兜底：扁平头 / 任一现有
  if (!chosen && all[0]) {
    chosen = all[0].value
    source = `fallback:${all[0].domain}`
  }

  const changed = !!(chosen && chosen !== before)
  console.log(
    '[闲鱼风控] 关窗选用 x5sec',
    `source=${source || '无'}`,
    changed ? '已换新' : '未换新',
    chosen ? `len=${chosen.length}` : '(无)'
  )
  console.log('[闲鱼风控] 开窗前 x5sec', before ? `len=${before.length}` : '(无)', before || '')
  console.log('[闲鱼风控] 关窗选用 x5sec', chosen ? `len=${chosen.length}` : '(无)', chosen || '')
  console.log('[闲鱼风控] ========================================')

  if (changed && chosen) {
    try {
      // 过码常落在 taobao/punish 域：强制镜像到 .goofish.com，供私聊 MTOP 使用
      const wr = await replaceX5secInAccountPartition(id, `x5sec=${chosen}`)
      if (!wr?.ok) {
        console.warn('[闲鱼风控] 镜像新区 x5sec 到 goofish 未成功', id, wr?.error || wr)
      }
    } catch (e) {
      console.warn('[闲鱼风控] 镜像新区 x5sec 到 goofish 失败', id, e?.message || e)
    }
  } else {
    console.warn(
      '[闲鱼风控] 滑块关窗未拿到新 x5sec：请拖完滑块并等到页面提示通过后再关；勿在「验证失败」时关窗'
    )
  }

  return { changed, before, after: chosen, source, all }
}

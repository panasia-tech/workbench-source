'use strict'

/** 店铺 xyh.item.list 返回里可解析为商品的条数 */
function countXyhListItems(json) {
  const d = json?.data
  if (!d || typeof d !== 'object') return 0
  for (const k of ['cardList', 'items', 'list', 'resultList']) {
    if (Array.isArray(d[k])) return d[k].length
  }
  return 0
}

function xyhListResponseHasCards(json) {
  return countXyhListItems(json) > 0
}

/** 从 itemGroupList 选分组：最新 → 在售 → 全部 → 首个 */
function pickShopListGroupId(groups) {
  if (!Array.isArray(groups) || !groups.length) return null
  const nameOf = (g) => String(g?.groupName ?? g?.name ?? '').trim()
  const idOf = (g) => {
    const n = Math.floor(Number(g?.groupId ?? g?.id))
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  for (const label of ['最新', '在售', '全部']) {
    const hit = groups.find((g) => nameOf(g).includes(label))
    const gid = idOf(hit)
    if (gid) return { groupId: gid, groupName: nameOf(hit) || label }
  }
  const first = groups[0]
  const gid = idOf(first)
  if (!gid) return null
  return { groupId: gid, groupName: nameOf(first) || '最新' }
}

/**
 * 店铺列表多步 fallback（对齐移动端 personal referer + 分组）
 * @param {string} cookie
 * @param {string} sellerUserId
 * @param {Record<string, unknown>} opts
 * @param {{ requestOnce: (cookie: string, reqOpts: Record<string, unknown>) => Promise<object> }} deps
 */
async function fetchShopXyhItemListWithFallback(cookie, sellerUserId, opts = {}, deps = {}) {
  const requestOnce = deps.requestOnce
  if (typeof requestOnce !== 'function') {
    throw new Error('fetchShopXyhItemListWithFallback 缺少 requestOnce')
  }

  const userId = String(sellerUserId || opts.userId || opts.seller_user_id || '').trim()
  if (!userId) {
    return { ok: false, error: '缺少 seller_user_id', mtopRawJson: null, items: [], rawItemCount: 0 }
  }

  const personalReferer = `https://www.goofish.com/personal?userId=${encodeURIComponent(userId)}`
  const base = {
    userId,
    seller_user_id: userId,
    pageNumber: Math.max(1, Math.floor(Number(opts.pageNumber) || 1)),
    pageSize: Math.min(50, Math.max(1, Math.floor(Number(opts.pageSize) || 20))),
    skipPrepareClientCookie: true,
    referer:
      typeof opts.referer === 'string' && opts.referer.trim() ? opts.referer.trim() : personalReferer,
    spmCnt:
      opts.spmCnt != null && String(opts.spmCnt).trim()
        ? String(opts.spmCnt).trim()
        : 'a21ybx.personal.0.0',
    groupSortId:
      opts.groupSortId != null ? opts.groupSortId : 'newest',
    defaultGroup: opts.defaultGroup !== false
  }

  if (opts.needGroupInfo === true) {
    return requestOnce(cookie, { ...base, ...opts, needGroupInfo: true })
  }

  let last = await requestOnce(cookie, {
    ...base,
    needGroupInfo: false,
    groupName: opts.groupName != null ? opts.groupName : '最新'
  })
  if (last?.ok && xyhListResponseHasCards(last.mtopRawJson)) return last
  if (last?.ok !== true) return last

  const groupProbe = await requestOnce(cookie, { ...base, needGroupInfo: true })
  last = groupProbe
  if (groupProbe?.ok && xyhListResponseHasCards(groupProbe.mtopRawJson)) return groupProbe
  if (groupProbe?.ok !== true) return groupProbe

  const picked = pickShopListGroupId(groupProbe.mtopRawJson?.data?.itemGroupList)
  if (!picked) return last

  const withGroup = await requestOnce(cookie, {
    ...base,
    needGroupInfo: false,
    groupName: picked.groupName,
    groupId: picked.groupId
  })
  if (withGroup?.ok === true) return withGroup
  return last
}

module.exports = {
  countXyhListItems,
  xyhListResponseHasCards,
  pickShopListGroupId,
  fetchShopXyhItemListWithFallback
}

import { buildSkuModel } from './sku-model.js'

function findMeanTimeItemId(obj, depth = 0, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || depth > 8) return ''
  if (seen.has(obj)) return ''
  seen.add(obj)
  if (obj.meanTimeItemId != null) {
    const v = String(obj.meanTimeItemId).trim()
    if (/^\d{8,20}$/.test(v)) return v
  }
  for (const k of Object.keys(obj)) {
    const nested = findMeanTimeItemId(obj[k], depth + 1, seen)
    if (nested) return nested
  }
  return ''
}

function pickMeanTimeItemId(json, mainItemId) {
  const main = String(mainItemId || '').trim()
  const fromTree = findMeanTimeItemId(json?.data)
  if (fromTree && fromTree !== main) return fromTree
  const raw = JSON.stringify(json?.data || {})
  const re = /"meanTimeItemId"\s*:\s*"?(\d{8,20})"?/gi
  let m
  while ((m = re.exec(raw)) !== null) {
    if (m[1] !== main) return m[1]
  }
  return main
}

function isSkuRowObject(row) {
  if (!row || typeof row !== 'object') return false
  const skuId = String(row.skuId ?? row.sku_id ?? '').trim()
  if (/^\d{8,20}$/.test(skuId)) return true
  const pl = row.propertyList
  return (
    Array.isArray(pl) &&
    pl.length > 0 &&
    (row.priceInCent != null || row.price != null || row.priceInCent === 0)
  )
}

function deepCollectSkuRows(root, depth = 0, seen = new Set(), out = []) {
  if (!root || typeof root !== 'object' || depth > 14) return out
  if (seen.has(root)) return out
  seen.add(root)
  if (Array.isArray(root)) {
    if (root.length >= 1 && root.length <= 200 && root.every(isSkuRowObject)) {
      out.push(...root)
      return out
    }
    for (const x of root) deepCollectSkuRows(x, depth + 1, seen, out)
    return out
  }
  for (const [, v] of Object.entries(root)) {
    deepCollectSkuRows(v, depth + 1, seen, out)
  }
  return out
}

function collectRawSkuList(json) {
  const item = json?.data?.itemDO || {}
  const lists = [item.skuList, item.idleItemSkuList, json?.data?.skuList, json?.data?.idleItemSkuList]
  const merged = []
  const seen = new Set()
  const pushRow = (row) => {
    if (!isSkuRowObject(row)) return
    const skuId = String(row?.skuId ?? row?.sku_id ?? '').trim()
    const key = skuId || JSON.stringify(row?.propertyList || [])
    if (seen.has(key)) return
    seen.add(key)
    merged.push(row)
  }
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const row of list) pushRow(row)
  }
  for (const row of deepCollectSkuRows(json?.data)) pushRow(row)
  return merged
}

function itemOrderUrlNeedsSku(item) {
  const urls = [item?.createOrderUrl, item?.channelUmpCreateOrderUrl, item?.liveRoomCreateOrderUrl]
  return urls.some((u) => /sku_layer|skuLayer|sku_id=/i.test(String(u || '')))
}

export function inspectPcDetailSkuMode(json) {
  const item = json?.data?.itemDO || {}
  const rawList = collectRawSkuList(json)
  const skus = parsePcDetailSkus(json)
  const minP = String(item.minPrice ?? '').trim()
  const maxP = String(item.maxPrice ?? '').trim()
  const raw = json?.data ? JSON.stringify(json.data) : ''
  const hitReasons = []
  const hasSkuIdRows = rawList.some((row) => String(row?.skuId ?? row?.sku_id ?? '').trim())
  const orderUrlNeedsSku = itemOrderUrlNeedsSku(item)
  const minMaxDiff = !!(minP && maxP && minP !== maxP)
  const rawHasSkuListJson = /\"skuList\"\s*:\s*\[\s*\{/.test(raw)
  const rawHasIdleSkuListJson = /\"idleItemSkuList\"\s*:\s*\[\s*\{/.test(raw)
  if (hasSkuIdRows) hitReasons.push('skuList含skuId')
  if (orderUrlNeedsSku) hitReasons.push('createOrderUrl含sku_layer')
  if (minMaxDiff) hitReasons.push('minPrice≠maxPrice')
  if (rawHasSkuListJson) hitReasons.push('json含skuList')
  if (rawHasIdleSkuListJson) hitReasons.push('json含idleItemSkuList')
  return {
    isMultiSku: hitReasons.length > 0,
    hitReasons,
    parsedSkuCount: skus.length
  }
}

export function isMultiSkuPcDetail(json) {
  return inspectPcDetailSkuMode(json).isMultiSku
}

export function parsePcDetailSkus(json) {
  const skuList = collectRawSkuList(json)
  const model = buildSkuModel(skuList)
  const inStock = model.skus.filter((s) => s.inStock && s.skuId)
  if (inStock.length) return inStock
  return model.skus.filter((s) => s.skuId)
}

export function pickItemTitleFromPcDetail(json) {
  const item = json?.data?.itemDO || json?.data?.itemInfo || json?.data?.item || {}
  return String(item.title || item.subject || item.itemTitle || '').trim()
}

export { pickMeanTimeItemId }

/**
 * 闲鱼地域：extraFilterValue.divisionList + userPositionJson: "{}"
 * 与官方 App / 抓包一致：
 * - 整省：divisionList: [{ province }]（如「全四川」）
 * - 整市：divisionList: [{ province, city }]（无 area，如「全成都」）
 * - 多区：divisionList: [{ province, city, area }, ...]
 */

const fs = require('fs')
const path = require('path')

const AREAS_PATH = path.join(__dirname, 'areas.json')
const MAX_LEAF_IDS = 24

let cascaderCache = null
/** @type {{ areaMap: Map<number,{province:string,city:string,area:string}>, cityMap: Map<number,{province:string,city:string}>, provMap: Map<number,string> } | null} */
let divisionMapsCache = null

function loadRootProvinces() {
  const raw = fs.readFileSync(AREAS_PATH, 'utf8')
  const j = JSON.parse(raw)
  const r = j?.data?.result
  return Array.isArray(r) ? r : []
}

function isChinaProvinceNode(n) {
  return (
    n &&
    n.level === 'prov' &&
    typeof n.id === 'number' &&
    Number.isFinite(n.id) &&
    n.id >= 110000 &&
    n.id < 900000
  )
}

/** 区县叶子 */
function toAreaLeaf(area) {
  return {
    value: area.id,
    label: String(area.na || '')
  }
}

/**
 * 市：首项「全${市}」与 App 一致，值为 c:cityId；其后为区县叶子
 */
function toCityOption(city, pna) {
  const ch = city.ch || []
  const areas = ch.filter((a) => a && a.level === 'area').map(toAreaLeaf)
  const cna = String(city.na || '')
  const cityAll = { value: `c:${city.id}`, label: `全${cna}` }
  return {
    value: city.id,
    label: cna,
    children: [cityAll, ...areas]
  }
}

/**
 * 省：首项「全${省}」，值为 p:provId；其后为各市
 */
function toProvOption(prov) {
  const pna = String(prov.na || '')
  const provAll = { value: `p:${prov.id}`, label: `全${pna}` }
  const cities = (prov.ch || [])
    .filter((c) => c && c.level === 'city')
    .map((c) => toCityOption(c, pna))
  return {
    value: prov.id,
    label: pna,
    children: [provAll, ...cities]
  }
}

function getCascaderOptions() {
  if (!cascaderCache) {
    const root = loadRootProvinces().filter(isChinaProvinceNode)
    cascaderCache = root.map(toProvOption)
  }
  return cascaderCache
}

function buildDivisionMaps() {
  const areaMap = new Map()
  const cityMap = new Map()
  const provMap = new Map()
  const provinces = loadRootProvinces().filter(isChinaProvinceNode)
  for (const prov of provinces) {
    const pna = String(prov.na || '')
    provMap.set(prov.id, pna)
    for (const city of prov.ch || []) {
      if (!city || city.level !== 'city') continue
      const cna = String(city.na || '')
      cityMap.set(city.id, { province: pna, city: cna })
      for (const ar of city.ch || []) {
        if (ar && ar.level === 'area') {
          areaMap.set(ar.id, { province: pna, city: cna, area: String(ar.na || '') })
        }
      }
    }
  }
  return { areaMap, cityMap, provMap }
}

function getDivisionMaps() {
  if (!divisionMapsCache) divisionMapsCache = buildDivisionMaps()
  return divisionMapsCache
}

/** @returns {(string|number)[]} */
function sanitizeDivisionLeafIds(raw) {
  if (raw == null) return []
  const arr = Array.isArray(raw) ? raw : []
  const out = []
  const seen = new Set()
  for (const x of arr) {
    if (typeof x === 'string') {
      const s = x.trim()
      if (/^p:\d+$/.test(s) || /^c:\d+$/.test(s)) {
        if (seen.has(s)) continue
        seen.add(s)
        out.push(s)
        if (out.length >= MAX_LEAF_IDS) break
      }
      continue
    }
    const id = typeof x === 'number' && Number.isInteger(x) ? x : parseInt(x, 10)
    if (!Number.isFinite(id) || id <= 0) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_LEAF_IDS) break
  }
  return out
}

function normalizeNationwideFlag(raw) {
  if (raw === true || raw === 1) return true
  if (raw === false || raw === 0 || raw == null) return false
  const s = String(raw).trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes'
}

/**
 * @param {string|number} id
 * @returns {{ kind: 'prov'|'city'|'area', province: string, city?: string, area?: string } | null}
 */
function resolveDivisionId(id, maps) {
  const { areaMap, cityMap, provMap } = maps
  if (typeof id === 'string') {
    const s = id.trim()
    const pm = s.match(/^p:(\d+)$/)
    if (pm) {
      const pid = parseInt(pm[1], 10)
      const pna = provMap.get(pid)
      if (!pna) return null
      return { kind: 'prov', province: pna }
    }
    const cm = s.match(/^c:(\d+)$/)
    if (cm) {
      const cid = parseInt(cm[1], 10)
      const r = cityMap.get(cid)
      if (!r) return null
      return { kind: 'city', province: r.province, city: r.city }
    }
    return null
  }
  const nid = typeof id === 'number' && Number.isInteger(id) ? id : parseInt(id, 10)
  if (!Number.isFinite(nid) || nid <= 0) return null
  if (areaMap.has(nid)) {
    const r = areaMap.get(nid)
    return { kind: 'area', province: r.province, city: r.city, area: r.area }
  }
  if (cityMap.has(nid)) {
    const r = cityMap.get(nid)
    return { kind: 'city', province: r.province, city: r.city }
  }
  return null
}

/**
 * @param {(string|number)[]} ids
 */
function buildDivisionPayloadFromLeafIds(ids) {
  const maps = getDivisionMaps()
  const resolved = []
  for (const id of ids) {
    const r = resolveDivisionId(id, maps)
    if (r) resolved.push(r)
  }
  if (resolved.length === 0) {
    return { extraFilterValue: '{}', userPositionJson: '{}' }
  }

  const provWide = new Set()
  for (const r of resolved) {
    if (r.kind === 'prov') provWide.add(r.province)
  }

  const afterProv = resolved.filter((r) => {
    if (r.kind === 'prov') return true
    if (provWide.has(r.province)) return false
    return true
  })

  const divisions = []
  const provSeen = new Set()
  for (const r of afterProv) {
    if (r.kind === 'prov') {
      if (!provSeen.has(r.province)) {
        divisions.push({ province: r.province })
        provSeen.add(r.province)
      }
    }
  }

  const rest = afterProv.filter((r) => r.kind !== 'prov')
  const grouped = new Map()
  for (const r of rest) {
    const ck = `${r.province}\0${r.city}`
    if (!grouped.has(ck)) grouped.set(ck, { areas: [], city: null })
    const g = grouped.get(ck)
    if (r.kind === 'area') g.areas.push(r)
    else if (r.kind === 'city') g.city = r
  }

  const areaKeySeen = new Set()
  for (const g of grouped.values()) {
    if (g.areas.length) {
      for (const a of g.areas) {
        const ak = `${a.province}\0${a.city}\0${a.area}`
        if (areaKeySeen.has(ak)) continue
        areaKeySeen.add(ak)
        divisions.push({ province: a.province, city: a.city, area: a.area })
      }
    } else if (g.city) {
      divisions.push({ province: g.city.province, city: g.city.city })
    }
  }

  if (divisions.length === 0) {
    return { extraFilterValue: '{}', userPositionJson: '{}' }
  }

  const extraObj = {
    divisionList: divisions,
    excludeMultiPlacesSellers: '0',
    extraDivision: ''
  }
  return {
    extraFilterValue: JSON.stringify(extraObj),
    userPositionJson: '{}'
  }
}

function applyDivisionToSearchOptions(body = {}, base) {
  const nationwide = normalizeNationwideFlag(
    body.division_nationwide ?? body.divisionNationwide ?? body.region_nationwide
  )
  if (nationwide) {
    return {
      ...base,
      extraFilterValue: JSON.stringify({
        divisionList: [],
        excludeMultiPlacesSellers: '0',
        extraDivision: '全国'
      }),
      userPositionJson: '{}'
    }
  }
  const ids = sanitizeDivisionLeafIds(body.division_leaf_ids ?? body.divisionLeafIds ?? [])
  if (ids.length === 0) {
    return {
      ...base,
      extraFilterValue: '{}',
      userPositionJson: '{}'
    }
  }
  const { extraFilterValue, userPositionJson } = buildDivisionPayloadFromLeafIds(ids)
  return {
    ...base,
    extraFilterValue,
    userPositionJson
  }
}

module.exports = {
  getCascaderOptions,
  sanitizeDivisionLeafIds,
  buildDivisionPayloadFromLeafIds,
  applyDivisionToSearchOptions,
  MAX_LEAF_IDS
}

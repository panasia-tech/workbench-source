#!/usr/bin/env node

/**
 * Enrich an existing seller queue with the human-facing fields from the
 * original homepage-slot workbook. The queue itself remains keyed by sellerId;
 * this migration only fills missing display metadata and is safe to rerun.
 *
 * Default mode is a dry run. Use --apply with an explicit --backup-root before
 * touching user data.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import XLSXPkg from 'xlsx'

const XLSX = XLSXPkg.default || XLSXPkg

const DEFAULT_WORKBOOK = './demo'
const DEFAULT_TARGETS = [
  '/Users/user/Library/Application Support/闲鱼卖家巡航台/seller-sources.json',
  '/Users/user/Library/Application Support/xianyu-electron/merchant-batch-all.json'
]

function argValues(name) {
  const values = []
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1])
  }
  return values
}

function argValue(name, fallback = '') {
  return argValues(name)[0] || fallback
}

function sellerIdFromUrl(value) {
  const raw = String(value || '').trim()
  if (/^[A-Za-z0-9_-]{1,128}$/.test(raw)) return raw
  try {
    const url = new URL(raw)
    return String(url.searchParams.get('userId') || url.searchParams.get('userid') || '').trim()
  } catch {
    return ''
  }
}

function text(value) {
  return String(value ?? '').trim()
}

function numberOrNull(value) {
  const n = Number(String(value ?? '').trim())
  return Number.isFinite(n) && n > 0 ? n : null
}

function pushUnique(list, value) {
  const clean = text(value)
  if (clean && !list.includes(clean)) list.push(clean)
}

function sourceContext(row) {
  const category = text(row['类目'] || row['分类'] || row['品类'])
  const city = text(row['城市'] || row['范围'])
  const board = text(row['榜单'] || row['榜单名称'])
  const rank = numberOrNull(row['排名'] || row['榜单排名'])
  if (!category && !city && !board && rank == null) return ''
  const prefix = [category, city, board].filter(Boolean).join('/')
  return rank == null ? prefix : `${prefix}${prefix ? ' ' : ''}TOP${rank}`
}

function buildMetadataIndex(workbookPath) {
  if (!fs.existsSync(workbookPath)) throw new Error(`source workbook does not exist: ${workbookPath}`)
  const workbook = XLSX.readFile(workbookPath, { cellDates: false })
  const sheetName = workbook.SheetNames.includes('主页链接') ? '主页链接' : workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false })
  const index = new Map()
  for (const row of rows) {
    const sellerId = sellerIdFromUrl(row['主页链接'] || row['卖家主页'] || row['sourceUrl'] || row['canonicalUrl'])
    if (!sellerId) continue
    const current = index.get(sellerId) || {
      sellerName: '',
      mainContent: '',
      mainType: '',
      categories: [],
      boards: [],
      cities: [],
      ranks: [],
      contexts: [],
      sourceSlotCount: null,
      sourceOrdinal: null,
      sourceSheet: sheetName,
      sourceWorkbook: path.basename(workbookPath)
    }
    current.sellerName ||= text(row['卖家名称'] || row['卖家昵称'])
    current.mainContent ||= text(row['主营内容'] || row['主营'])
    current.mainType ||= text(row['主营类型'] || row['类型'])
    pushUnique(current.categories, row['类目'] || row['分类'] || row['品类'])
    pushUnique(current.boards, row['榜单'] || row['榜单名称'])
    pushUnique(current.cities, row['城市'] || row['范围'])
    const rank = numberOrNull(row['排名'] || row['榜单排名'])
    if (rank != null && !current.ranks.includes(rank)) current.ranks.push(rank)
    pushUnique(current.contexts, sourceContext(row))
    const slotCount = numberOrNull(row['源榜总数'] || row['来源槽位数'])
    if (slotCount != null) current.sourceSlotCount = Math.max(current.sourceSlotCount || 0, slotCount)
    const ordinal = Number(row.__rowNum__)
    if (Number.isFinite(ordinal) && ordinal > 0) current.sourceOrdinal = current.sourceOrdinal == null ? ordinal : Math.min(current.sourceOrdinal, ordinal)
    index.set(sellerId, current)
  }
  return { index, sheetName, rowCount: rows.length }
}

function mergeMetadataIndexes(indexes) {
  const merged = new Map()
  for (const { index } of indexes) {
    for (const [sellerId, incoming] of index) {
      const current = merged.get(sellerId) || {
        sellerName: '', mainContent: '', mainType: '', categories: [], boards: [],
        cities: [], ranks: [], contexts: [], sourceSlotCount: null, sourceOrdinal: null,
        sourceSheet: '', sourceWorkbook: ''
      }
      current.sellerName ||= incoming.sellerName
      current.mainContent ||= incoming.mainContent
      current.mainType ||= incoming.mainType
      for (const key of ['categories', 'boards', 'cities', 'ranks', 'contexts']) {
        for (const value of incoming[key] || []) if (!current[key].includes(value)) current[key].push(value)
      }
      if (incoming.sourceSlotCount != null) current.sourceSlotCount = Math.max(current.sourceSlotCount || 0, incoming.sourceSlotCount)
      if (incoming.sourceOrdinal != null) current.sourceOrdinal = current.sourceOrdinal == null ? incoming.sourceOrdinal : Math.min(current.sourceOrdinal, incoming.sourceOrdinal)
      current.sourceSheet ||= incoming.sourceSheet
      current.sourceWorkbook ||= incoming.sourceWorkbook
      merged.set(sellerId, current)
    }
  }
  return merged
}

function readTarget(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  if (Array.isArray(parsed)) return { container: parsed, rows: parsed, wrap: (rows) => rows }
  const key = Array.isArray(parsed.rows) ? 'rows' : Array.isArray(parsed.sources) ? 'sources' : Array.isArray(parsed.sellers) ? 'sellers' : ''
  if (!key) throw new Error(`unsupported seller source format: ${filePath}`)
  return { container: parsed, rows: parsed[key], wrap: (rows) => ({ ...parsed, [key]: rows }) }
}

function hasValue(row, key) {
  return row[key] !== undefined && row[key] !== null && text(row[key]) !== ''
}

function metadataFor(source) {
  const rank = source.ranks.length ? Math.min(...source.ranks) : null
  return {
    sellerName: source.sellerName,
    mainContent: source.mainContent,
    mainType: source.mainType,
    category: source.categories.join('、'),
    board: source.boards.join('、'),
    boardName: source.boards.join('、'),
    sourceBoardRanks: source.contexts.join('；'),
    rank,
    sourceRank: rank,
    sourceOrdinal: source.sourceOrdinal,
    sourceSlotCount: source.sourceSlotCount,
    cities: source.cities.join('、'),
    sourceSheet: source.sourceSheet,
    sourceWorkbook: source.sourceWorkbook
  }
}

function enrichRows(rows, metadataIndex) {
  let matched = 0
  let enriched = 0
  let changedFields = 0
  const nextRows = rows.map((row) => {
    const sellerId = sellerIdFromUrl(row.sellerId || row.url || row.sourceUrl || row.canonicalUrl || row.id)
    const source = metadataIndex.get(sellerId)
    if (!source) return row
    matched += 1
    const next = { ...row }
    for (const [key, value] of Object.entries(metadataFor(source))) {
      if (value === undefined || value === null || text(value) === '' || hasValue(next, key)) continue
      next[key] = value
      changedFields += 1
    }
    if (changedFields > 0 && JSON.stringify(next) !== JSON.stringify(row)) enriched += 1
    return next
  })
  return { rows: nextRows, matched, enriched, changedFields }
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function writeAtomic(filePath, value) {
  const temp = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, filePath)
}

function run() {
  const workbookPaths = argValues('--workbook').length ? argValues('--workbook') : [DEFAULT_WORKBOOK]
  const targets = argValues('--target').length ? argValues('--target') : DEFAULT_TARGETS
  const backupRoot = argValue('--backup-root')
  const apply = process.argv.includes('--apply')
  if (apply && !backupRoot) throw new Error('--apply requires --backup-root')
  const workbookIndexes = workbookPaths.map((workbookPath) => buildMetadataIndex(workbookPath))
  const index = mergeMetadataIndexes(workbookIndexes)
  const report = { schemaVersion: 1, mode: apply ? 'apply' : 'dry-run', workbooks: workbookPaths, sheets: workbookIndexes.map(({ sheetName, rowCount }) => ({ sheetName, rowCount })), indexedSellerIds: index.size, targets: [] }
  for (const target of targets) {
    if (!fs.existsSync(target)) { report.targets.push({ target, skipped: true, reason: 'missing' }); continue }
    const original = readTarget(target)
    const result = enrichRows(original.rows, index)
    const entry = { target, rows: original.rows.length, matched: result.matched, enriched: result.enriched, changedFields: result.changedFields }
    if (apply && result.enriched > 0) {
      fs.mkdirSync(backupRoot, { recursive: true })
      const backupPath = path.join(backupRoot, path.basename(target))
      if (!fs.existsSync(backupPath)) fs.copyFileSync(target, backupPath)
      writeAtomic(target, original.wrap(result.rows))
      entry.sha256 = sha256(target)
      entry.backup = backupPath
    }
    report.targets.push(entry)
  }
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run() } catch (error) { console.error(error.stack || error); process.exitCode = 1 }
}

export { buildMetadataIndex, enrichRows, metadataFor }

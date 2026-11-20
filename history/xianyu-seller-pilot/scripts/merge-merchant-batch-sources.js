#!/usr/bin/env node

// Merge the two user-provided seller-homepage deliveries without duplicating
// sellers. The active batch is kept intact; sellers unique to the older
// 16,000-slot delivery are appended to the remaining batches.
//
// Usage:
//   node merge-merchant-batch-sources.js --dry-run
//   node merge-merchant-batch-sources.js --apply

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const XLSX = require('xlsx')

const APP_DATA = '/Users/user/Library/Application Support/xianyu-electron'
const STATE_PATH = path.join(APP_DATA, 'xianyu-electron.json')
const ALL_PATH = path.join(APP_DATA, 'merchant-batch-all.json')
const REMAINING_PATH = path.join(APP_DATA, 'merchant-batch-remaining.json')
const CITY_XLSX = './demo'
const SLOT_XLSX = './demo'
const MERGED_MANIFEST = './demo'

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tempPath, filePath)
}

function sellerIdFromUrl(value) {
  try {
    const url = new URL(String(value || '').trim())
    const id = url.searchParams.get('userId') || url.searchParams.get('userid')
    return id && /^\d+$/.test(id) ? id : ''
  } catch {
    return ''
  }
}

function stableId(prefix, sellerId) {
  const digest = crypto.createHash('sha1').update(`${prefix}:${sellerId}`).digest('hex').slice(0, 16)
  return `${prefix}-${digest}`
}

function readUniqueSellerRows(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: false })
  const sheetName = workbook.SheetNames.includes('唯一卖家主页') ? '唯一卖家主页' : workbook.SheetNames[0]
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '', raw: false })
  const bySellerId = new Map()
  for (const row of rows) {
    const sourceUrl = String(row['主页链接'] || row['卖家主页'] || row['sourceUrl'] || '').trim()
    const sellerId = sellerIdFromUrl(sourceUrl)
    if (!sellerId || bySellerId.has(sellerId)) continue
    bySellerId.set(sellerId, {
      sellerId,
      sourceUrl,
      canonicalUrl: `https://www.goofish.com/personal?userId=${sellerId}`,
      sellerName: String(row['卖家名称'] || '').trim(),
      mainContent: String(row['主营内容'] || '').trim(),
      mainType: String(row['主营类型'] || row['类目'] || '').trim(),
      sourceSlotCount: String(row['来源槽位数'] || '').trim(),
      cities: String(row['城市'] || '').trim(),
      legacySourceFile: path.basename(filePath),
      legacySourceSheet: sheetName,
      legacyExcelRow: rows.indexOf(row) + 2,
    })
  }
  return [...bySellerId.values()]
}

function makeAppEntry(row, ordinal) {
  const now = new Date().toISOString()
  return {
    id: stableId('excel-union-20260821', row.sellerId),
    sourceUrl: row.sourceUrl,
    canonicalUrl: row.canonicalUrl,
    sellerId: row.sellerId,
    source: 'excel-union-16k+city-20260821',
    status: 'pending',
    receivedAt: now,
    updatedAt: null,
    excelRow: row.legacyExcelRow,
    sellerName: row.sellerName,
    mainContent: row.mainContent,
    mainType: row.mainType,
    sourceSlotCount: row.sourceSlotCount,
    cities: row.cities,
    sourceOrdinal: ordinal,
  }
}

function buildPlan() {
  const state = readJson(STATE_PATH)
  const all = readJson(ALL_PATH)
  const remaining = readJson(REMAINING_PATH)
  if (!Array.isArray(all) || !Array.isArray(remaining)) throw new Error('批次清单格式不正确')
  if (state.merchantBatch?.source === 'excel-union-16k+city-20260821') {
    if (all.length !== Number(state.merchantBatch.total) || remaining.length !== Number(state.merchantBatch.remainingCount)) {
      throw new Error('并集批次元数据与清单数量不一致，停止以避免覆盖未知队列')
    }
    return {
      state,
      all,
      remaining,
      additions: [],
      mergedAll: all,
      mergedRemaining: remaining,
      alreadyApplied: true,
      citySource: CITY_XLSX,
      slotSource: SLOT_XLSX,
    }
  }
  if (all.length !== 9803) throw new Error(`当前完整清单不是预期的 9803 条，而是 ${all.length} 条；停止以避免覆盖未知队列`)
  if (remaining.length !== 4803) throw new Error(`当前剩余清单不是预期的 4803 条，而是 ${remaining.length} 条；停止以避免覆盖进行中的状态`)
  if (state.merchantBatch?.source !== 'excel-唯一卖家主页-20260821') throw new Error('当前批次来源已变化，停止以避免误合并')

  const currentIds = new Set(all.map((row) => String(row.sellerId || sellerIdFromUrl(row.sourceUrl))).filter(Boolean))
  const legacyRows = readUniqueSellerRows(SLOT_XLSX)
  const onlyLegacy = legacyRows.filter((row) => !currentIds.has(row.sellerId))
  const additions = onlyLegacy.map((row, index) => makeAppEntry(row, all.length + index + 1))
  const mergedAll = [...all, ...additions]
  const mergedRemaining = [...remaining, ...additions]
  return {
    state,
    all,
    remaining,
    additions,
    mergedAll,
    mergedRemaining,
    citySource: CITY_XLSX,
    slotSource: SLOT_XLSX,
  }
}

function printPlan(plan) {
  console.log(JSON.stringify({
    alreadyApplied: Boolean(plan.alreadyApplied),
    currentAll: plan.all.length,
    currentRemaining: plan.remaining.length,
    legacyUnique: readUniqueSellerRows(SLOT_XLSX).length,
    additions: plan.additions.length,
    mergedAll: plan.mergedAll.length,
    mergedRemaining: plan.mergedRemaining.length,
    additionSellerIds: plan.additions.map((row) => row.sellerId),
  }, null, 2))
}

function apply(plan) {
  if (plan.alreadyApplied) {
    console.log(JSON.stringify({ applied: false, reason: '并集批次已存在', total: plan.mergedAll.length, remaining: plan.mergedRemaining.length }, null, 2))
    return
  }
  const stamp = '20260821'
  for (const source of [STATE_PATH, ALL_PATH, REMAINING_PATH]) {
    const backup = `${source}.bak.before-source-union-${stamp}`
    if (!fs.existsSync(backup)) fs.copyFileSync(source, backup)
  }

  writeJsonAtomic(ALL_PATH, plan.mergedAll)
  writeJsonAtomic(REMAINING_PATH, plan.mergedRemaining)
  writeJsonAtomic(MERGED_MANIFEST, {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'excel-union-16k+city-20260821',
    sourcePaths: [plan.slotSource, plan.citySource],
    dedupeKey: 'sellerId',
    total: plan.mergedAll.length,
    currentCitySourceCount: plan.all.length,
    addedFrom16kSlotSource: plan.additions.length,
    sellers: plan.mergedAll,
  })

  const nextState = {
    ...plan.state,
    merchantBatch: {
      ...plan.state.merchantBatch,
      source: 'excel-union-16k+city-20260821',
      sourceSheet: '唯一卖家主页（城市榜）+ 唯一卖家主页（16,000槽位）',
      sourcePath: MERGED_MANIFEST,
      sourcePaths: [plan.slotSource, plan.citySource],
      total: plan.mergedAll.length,
      remainingCount: plan.mergedRemaining.length,
      allPath: ALL_PATH,
      remainingPath: REMAINING_PATH,
      mergedAt: new Date().toISOString(),
      mergedAdded: plan.additions.length,
    },
  }
  writeJsonAtomic(STATE_PATH, nextState)
  console.log(JSON.stringify({ applied: true, total: plan.mergedAll.length, remaining: plan.mergedRemaining.length, added: plan.additions.length }, null, 2))
}

const plan = buildPlan()
printPlan(plan)
if (process.argv.includes('--apply')) apply(plan)
else console.log('dry-run: 未写入任何文件；使用 --apply 才会应用合并')

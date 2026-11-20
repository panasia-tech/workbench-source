#!/usr/bin/env node

// Restore durable seller statuses from an explicitly selected checkpoint
// backup after a legacy user-data migration.  The current checkpoint wins for
// rows with a live currentAttempt; all other rows inherit the older durable
// attempt/evidence state.  Seller display names always come from the current
// seller-sources.json mapping.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const fromIndex = args.indexOf('--from')
const backupIndex = args.indexOf('--backup')
const sourceCheckpoint = fromIndex >= 0 ? args[fromIndex + 1] : ''
const backupRoot = backupIndex >= 0 ? args[backupIndex + 1] : ''
const dataDir = resolve(args.find((arg, index) => !arg.startsWith('--') && index !== fromIndex + 1 && index !== backupIndex + 1) || process.env.XIANYU_SELLER_DATA_DIR || join(process.env.HOME || '', 'Library/Application Support/闲鱼卖家巡航台'))
const currentPath = join(dataDir, 'seller-checkpoint-v3.json')
if (!sourceCheckpoint || !existsSync(sourceCheckpoint)) throw new Error(`--from checkpoint not found: ${sourceCheckpoint}`)
if (!existsSync(currentPath)) throw new Error(`current checkpoint not found: ${currentPath}`)

const current = JSON.parse(readFileSync(currentPath, 'utf8'))
const prior = JSON.parse(readFileSync(sourceCheckpoint, 'utf8'))
const sources = JSON.parse(readFileSync(join(dataDir, 'seller-sources.json'), 'utf8'))
const names = new Map((Array.isArray(sources) ? sources : [])
  .map((row) => [String(row?.sellerId || '').trim(), String(row?.sellerName || '').trim()])
  .filter(([sellerId, sellerName]) => sellerId && sellerName))
const priorBySellerId = new Map((prior.records || []).map((row) => [String(row?.sellerId || row?.id || ''), row]))
let restored = 0
let keptLive = 0
let renamed = 0

const records = (current.records || []).map((row) => {
  const sellerId = String(row?.sellerId || row?.id || '')
  const live = row?.currentAttempt || row?.status === 'running'
  const priorRow = priorBySellerId.get(sellerId)
  let next = row
  if (!live && priorRow && (priorRow.status !== 'pending' || priorRow.currentAttempt || (priorRow.attempts || []).length || Object.keys(priorRow.itemIds || {}).some((key) => (priorRow.itemIds?.[key] || []).length))) {
    next = { ...priorRow, ...((row?.sellerName || names.get(sellerId)) ? { sellerName: row.sellerName || names.get(sellerId) } : {}) }
    restored++
  } else if (live) {
    keptLive++
  }
  const sellerName = names.get(sellerId)
  if (sellerName && next.sellerName !== sellerName) {
    next = { ...next, sellerName }
    renamed++
  }
  return next
})

const nextDocument = { ...current, schemaVersion: 3, persistedAt: new Date().toISOString(), records }
const report = {
  apply,
  dataDir,
  currentRecords: current.records?.length || 0,
  priorRecords: prior.records?.length || 0,
  restored,
  keptLive,
  renamed,
  beforeBytes: statSync(currentPath).size,
  afterBytes: Buffer.byteLength(JSON.stringify(nextDocument, null, 2) + '\n')
}
if (apply && restored + renamed > 0) {
  if (!backupRoot) throw new Error('--backup is required with --apply')
  const backupDir = resolve(backupRoot)
  mkdirSync(backupDir, { recursive: true })
  copyFileSync(currentPath, join(backupDir, 'seller-checkpoint-v3.before-status-restore.json'))
  const tempPath = `${currentPath}.status-restore-${process.pid}.tmp`
  writeFileSync(tempPath, JSON.stringify(nextDocument, null, 2) + '\n', { mode: 0o600 })
  renameSync(tempPath, currentPath)
  report.backupPath = join(backupDir, 'seller-checkpoint-v3.before-status-restore.json')
}
console.log(JSON.stringify(report, null, 2))

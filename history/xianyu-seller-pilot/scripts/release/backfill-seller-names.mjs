#!/usr/bin/env node

// Repair display-only seller names after the crawler's generic DOM nickname
// selector captured the logged-in account instead of the seller being visited.
// Seller IDs, item IDs, prices, evidence, and statuses are intentionally not
// changed.  Run without --apply first for a read-only report.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const dataDir = resolve(args.find((arg) => !arg.startsWith('--')) || process.env.XIANYU_SELLER_DATA_DIR || join(process.env.HOME || '', 'Library/Application Support/闲鱼卖家巡航台'))
const sourcePath = join(dataDir, 'seller-sources.json')
if (!existsSync(sourcePath)) throw new Error(`seller-sources.json not found: ${sourcePath}`)

const sourceRows = JSON.parse(readFileSync(sourcePath, 'utf8'))
const nameBySellerId = new Map()
for (const row of Array.isArray(sourceRows) ? sourceRows : []) {
  const sellerId = String(row?.sellerId || '').trim()
  const sellerName = String(row?.sellerName || '').trim()
  if (sellerId && sellerName && !nameBySellerId.has(sellerId)) nameBySellerId.set(sellerId, sellerName)
}

const targets = [
  'seller-items.jsonl',
  'seller-progress.jsonl',
  'seller-checkpoint-v3.json'
]
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupDir = join(dataDir, 'seller-name-backups', stamp)

function sellerIdOf(row) {
  return String(row?.sellerId || row?.sourceSellerId || row?.id || '').trim()
}

function patchRow(row) {
  const sellerId = sellerIdOf(row)
  const sellerName = nameBySellerId.get(sellerId)
  if (!sellerName || String(row?.sellerName || '') === sellerName) return false
  row.sellerName = sellerName
  return true
}

function atomicWrite(path, text) {
  const tempPath = `${path}.seller-name-backfill-${process.pid}.tmp`
  writeFileSync(tempPath, text, 'utf8')
  renameSync(tempPath, path)
}

const reports = []
for (const filename of targets) {
  const path = join(dataDir, filename)
  if (!existsSync(path)) continue
  const beforeBytes = statSync(path).size
  if (filename.endsWith('.jsonl')) {
    const lines = readFileSync(path, 'utf8').split(/\n/)
    let changed = 0
    const next = lines.map((line) => {
      if (!line.trim()) return line
      const row = JSON.parse(line)
      if (patchRow(row)) changed++
      return JSON.stringify(row)
    })
    reports.push({ filename, changed, beforeBytes, afterBytes: Buffer.byteLength(next.join('\n')) })
    if (apply && changed) {
      mkdirSync(backupDir, { recursive: true })
      copyFileSync(path, join(backupDir, basename(path)))
      atomicWrite(path, next.join('\n'))
    }
    continue
  }
  const document = JSON.parse(readFileSync(path, 'utf8'))
  const records = Array.isArray(document) ? document : (Array.isArray(document.records) ? document.records : [])
  let changed = 0
  for (const row of records) if (patchRow(row)) changed++
  const serialized = JSON.stringify(document, null, 2) + '\n'
  reports.push({ filename, changed, beforeBytes, afterBytes: Buffer.byteLength(serialized) })
  if (apply && changed) {
    mkdirSync(backupDir, { recursive: true })
    copyFileSync(path, join(backupDir, basename(path)))
    atomicWrite(path, serialized)
  }
}

const totalChanged = reports.reduce((sum, report) => sum + report.changed, 0)
console.log(JSON.stringify({ apply, dataDir, knownSellerNames: nameBySellerId.size, totalChanged, backupDir: apply && totalChanged ? backupDir : null, reports }, null, 2))

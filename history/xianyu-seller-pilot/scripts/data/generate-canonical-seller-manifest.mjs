#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_EXPECTED_COUNT = 9977
export const DEFAULT_INPUT = join(homedir(), 'Library/Application Support/xianyu-electron/merchant-batch-all.json')
export const DEFAULT_OUTPUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../resources/seller-index/canonical-sellers.manifest.json')

function normalizeSellerId(value) {
  const normalized = String(value ?? '').trim()
  if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9_-]+$/.test(normalized)) {
    throw new Error(`invalid seller ID at replaceable input boundary: ${normalized || '<empty>'}`)
  }
  return normalized
}

function sellerIdFromRow(row) {
  if (typeof row === 'string' || typeof row === 'number' || typeof row === 'bigint') return row
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('each source row must be a seller ID or object')
  const candidate = row.sellerId ?? row.seller_id ?? row.userId ?? row.user_id
  if (candidate == null) throw new Error('source row is missing sellerId')
  return candidate
}

export function normalizeSellerIds(rows) {
  if (!Array.isArray(rows)) throw new Error('canonical seller source must be a JSON array')
  const normalized = rows.map((row) => normalizeSellerId(sellerIdFromRow(row)))
  const seen = new Set()
  for (const sellerId of normalized) {
    if (seen.has(sellerId)) throw new Error(`duplicate seller ID after normalization: ${sellerId}`)
    seen.add(sellerId)
  }
  return normalized.sort((left, right) => left.localeCompare(right, 'en'))
}

export function hashSellerIds(sellerIds) {
  return createHash('sha256').update(sellerIds.join('\n'), 'utf8').digest('hex')
}

function displaySourcePath(inputPath) {
  const absolute = resolve(inputPath)
  const taskHome = homedir()
  return absolute === taskHome || absolute.startsWith(`${taskHome}/`)
    ? `~/${relative(taskHome, absolute)}`
    : absolute
}

export function buildCanonicalSellerManifest(rows, {
  expectedCount = DEFAULT_EXPECTED_COUNT,
  inputPath = DEFAULT_INPUT,
  provenance = 'measured-production-source'
} = {}) {
  const sellerIds = normalizeSellerIds(rows)
  const expected = Number(expectedCount)
  if (!Number.isSafeInteger(expected) || expected < 1) throw new Error('expected count must be a positive integer')
  if (sellerIds.length !== expected) throw new Error(`canonical count mismatch: expected ${expected}, received ${sellerIds.length}`)
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    provenance: {
      label: String(provenance || 'replaceable-input'),
      sourcePath: displaySourcePath(inputPath)
    },
    hashAlgorithm: 'sha256(sortedSellerIdsJoinedByNewline)',
    count: sellerIds.length,
    sha256: hashSellerIds(sellerIds),
    sellerIds
  }
}

export function verifyCanonicalSellerManifest(manifest, { expectedCount = null } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('canonical manifest must be an object')
  if (manifest.schemaVersion !== 1) throw new Error('unsupported canonical manifest schema version')
  if (!manifest.generatedAt || !Number.isFinite(Date.parse(manifest.generatedAt))) throw new Error('canonical manifest generatedAt is invalid')
  if (!manifest.provenance || typeof manifest.provenance !== 'object' || !manifest.provenance.sourcePath) throw new Error('canonical manifest provenance is required')
  if (manifest.hashAlgorithm !== 'sha256(sortedSellerIdsJoinedByNewline)') throw new Error('canonical manifest hash algorithm is invalid')
  if (!Array.isArray(manifest.sellerIds)) throw new Error('canonical manifest sellerIds must be an array')
  const normalized = normalizeSellerIds(manifest.sellerIds)
  if (normalized.some((sellerId, index) => sellerId !== manifest.sellerIds[index])) throw new Error('canonical seller IDs must be normalized and sorted')
  if (manifest.count !== normalized.length) throw new Error(`canonical manifest count mismatch: declared ${manifest.count}, actual ${normalized.length}`)
  if (expectedCount != null && manifest.count !== Number(expectedCount)) throw new Error(`canonical manifest count mismatch: expected ${expectedCount}, actual ${manifest.count}`)
  const recomputedHash = hashSellerIds(normalized)
  if (manifest.sha256 !== recomputedHash) throw new Error(`canonical manifest hash mismatch: expected ${recomputedHash}`)
  return { count: normalized.length, sha256: recomputedHash, sellerIds: normalized }
}

function parseArgs(argv) {
  const args = {
    input: DEFAULT_INPUT,
    output: DEFAULT_OUTPUT,
    expectedCount: DEFAULT_EXPECTED_COUNT,
    provenance: 'merchant-batch-all measured 2026-08-21'
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--input') args.input = value, index += 1
    else if (flag === '--output') args.output = value, index += 1
    else if (flag === '--expected-count') args.expectedCount = Number(value), index += 1
    else if (flag === '--provenance') args.provenance = value, index += 1
    else throw new Error(`unknown or incomplete argument: ${flag}`)
  }
  if (!args.input || !args.output) throw new Error('input and output paths are required')
  return args
}

export function generateCanonicalSellerManifest(options) {
  const inputPath = resolve(options.input)
  const outputPath = resolve(options.output)
  if (!existsSync(inputPath)) throw new Error(`authoritative seller input is absent: ${inputPath}`)
  const rows = JSON.parse(readFileSync(inputPath, 'utf8'))
  const manifest = buildCanonicalSellerManifest(rows, {
    expectedCount: options.expectedCount,
    inputPath,
    provenance: options.provenance
  })
  verifyCanonicalSellerManifest(manifest, { expectedCount: options.expectedCount })
  mkdirSync(dirname(outputPath), { recursive: true })
  const temporaryPath = `${outputPath}.tmp-${process.pid}`
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporaryPath, outputPath)
  return { outputPath, count: manifest.count, sha256: manifest.sha256 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = generateCanonicalSellerManifest(parseArgs(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`)
    process.exitCode = 1
  }
}

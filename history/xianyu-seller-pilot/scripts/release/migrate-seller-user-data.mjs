#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const EXACT_DESTINATION = path.join(os.homedir(), 'Library/Application Support/闲鱼卖家巡航台')
const DEFAULT_SOURCES = [
  path.join(os.homedir(), 'Library/Application Support/xianyu-electron'),
  path.join(os.homedir(), 'Library/Application Support/闲鱼行情工作台')
]
const WRITER_PATTERNS = [
  '/Applications/闲鱼行情爬虫.app/Contents/MacOS/闲鱼行情爬虫',
  '/Applications/闲鱼行情工作台.app/Contents/MacOS/闲鱼行情工作台',
  '/Applications/闲鱼卖家巡航台.app/Contents/MacOS/闲鱼卖家巡航台'
]
const CHROME_NAMES = new Set([
  'Cookies', 'Cookies-journal', 'Partitions', 'Local Storage', 'Session Storage', 'IndexedDB',
  'Network', 'Network Persistent State', 'Preferences', 'Secure Preferences', 'WebStorage'
])
// Lease and mutex directories are process-owned runtime state, not user data.
// Copying them across an upgrade can resurrect an incomplete lock (for example
// a stale directory without owner.json) and make the new app fail before it can
// recover the seller queue. Complete source trees remain in the immutable
// migration backup, while the destination starts with no stale runtime locks.
const RUNTIME_ONLY_TOP_LEVEL = new Set(['seller-leases', 'seller-claim.mutex'])
const TASK_CENTER_FILENAME = 'xianyu-task-center.json'

function parseArgs(argv) {
  const mode = argv[0]
  if (!['inventory', 'dry-run', 'apply', 'verify'].includes(mode)) throw new Error('mode must be inventory, dry-run, apply, or verify')
  const options = { mode, sources: [] }
  for (let i = 1; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === '--source') { options.sources.push(value); i += 1 }
    else if (key === '--destination') { options.destination = value; i += 1 }
    else if (key === '--backup-root') { options.backupRoot = value; i += 1 }
    else if (key === '--report') { options.report = value; i += 1 }
    else if (key === '--writer-pid-file') { options.writerPidFile = value; i += 1 }
    else throw new Error(`unknown option: ${key}`)
  }
  options.sources = (options.sources.length ? options.sources : DEFAULT_SOURCES).map(resolveRealish)
  options.destination = resolveRealish(options.destination || EXACT_DESTINATION)
  options.backupRoot = resolveRealish(options.backupRoot || path.join(os.homedir(), 'Library/Application Support/闲鱼卖家巡航台 Migration Backups'))
  if (options.report) options.report = path.resolve(options.report)
  if (options.writerPidFile) options.writerPidFile = path.resolve(options.writerPidFile)
  return options
}

function resolveRealish(value) {
  const absolute = path.resolve(String(value))
  let cursor = absolute
  const suffix = []
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    suffix.unshift(path.basename(cursor))
    cursor = parent
  }
  const resolved = fs.existsSync(cursor) ? fs.realpathSync(cursor) : cursor
  return path.join(resolved, ...suffix)
}

function within(child, parent) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

function validateCoordinates(options) {
  const inTemporaryFixture = within(options.destination, fs.realpathSync(os.tmpdir())) && options.sources.every((source) => within(source, fs.realpathSync(os.tmpdir())))
  if (options.destination !== EXACT_DESTINATION && !inTemporaryFixture) throw new Error(`destination must be exactly ${EXACT_DESTINATION}`)
  if (new Set(options.sources).size !== options.sources.length) throw new Error('duplicate resolved source directory')
  for (const source of options.sources) {
    if (source === options.destination || within(source, options.destination) || within(options.destination, source)) throw new Error('source and destination trees must not overlap')
    if (options.backupRoot === source || within(options.backupRoot, source) || within(source, options.backupRoot)) {
      throw new Error('backup root and migration source trees must not overlap')
    }
  }
  if (options.backupRoot === options.destination || within(options.backupRoot, options.destination) || within(options.destination, options.backupRoot)) {
    throw new Error('backup root and destination trees must not overlap')
  }
}

function nearestExistingDirectory(value) {
  let cursor = value
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) throw new Error(`cannot resolve an existing parent for ${value}`)
    cursor = parent
  }
  const stat = fs.statSync(cursor)
  return stat.isDirectory() ? cursor : path.dirname(cursor)
}

function availableBytes(directory) {
  const stat = fs.statfsSync(directory)
  return Number(stat.bavail) * Number(stat.bsize)
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function walkFiles(root, relative = '') {
  if (!fs.existsSync(root)) return []
  const output = []
  const current = path.join(root, relative)
  for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = path.join(relative, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`symbolic links are not allowed in migration source: ${rel}`)
    if (entry.isDirectory()) output.push(...walkFiles(root, rel))
    else if (entry.isFile()) output.push(rel)
  }
  return output
}

function treeInventory(root) {
  if (!fs.existsSync(root)) return { exists: false, fileCount: 0, bytes: 0, sha256: null }
  const hash = crypto.createHash('sha256')
  let bytes = 0
  // Runtime locks are intentionally excluded from the migration copy. They
  // must also be excluded from the post-apply inventory: a running renderer
  // may recreate an owner.json between apply and verify, which would make a
  // deterministic migration report fail even though user evidence is intact.
  const files = walkFiles(root).filter((rel) => {
    if (['migration-report.json', '.seller-pilot-install-state.json'].includes(rel)) return false
    return ![...RUNTIME_ONLY_TOP_LEVEL].some((name) => rel === name || rel.startsWith(`${name}${path.sep}`))
  })
  for (const rel of files) {
    const fileHash = sha256File(path.join(root, rel))
    const size = fs.statSync(path.join(root, rel)).size
    bytes += size
    hash.update(rel).update('\0').update(String(size)).update('\0').update(fileHash).update('\n')
  }
  return { exists: true, fileCount: files.length, bytes, sha256: hash.digest('hex') }
}

function sellerId(row) {
  const direct = String(row?.sellerId || row?.userId || '').trim()
  if (/^[A-Za-z0-9_-]{1,128}$/.test(direct)) return direct
  try {
    const url = new URL(String(row?.url || row?.sourceUrl || row?.canonicalUrl || ''))
    const value = String(url.searchParams.get('userId') || url.searchParams.get('userid') || '').trim()
    return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null
  } catch {
    // A progress record's opaque row id is not a seller identity. Older
    // stores used SHA/UUID ids here; importing them would create phantom
    // numeric-looking sellers alongside the real URL-backed row.
    return null
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function taskCenterMetrics(value) {
  const store = value && typeof value === 'object' && !Array.isArray(value) ? value : null
  const collections = Array.isArray(store?.collections) ? store.collections : []
  const taskCount = collections.reduce((total, collection) => total + (Array.isArray(collection?.tasks) ? collection.tasks.length : 0), 0)
  const runs = Array.isArray(store?.runs) ? store.runs : []
  const runResults = Array.isArray(store?.runResults) ? store.runResults : []
  const wmsSkus = Array.isArray(store?.wmsSkus) ? store.wmsSkus : []
  const timestamps = [store?.lastImport?.at, store?.wmsSyncedAt]
  for (const collection of collections) timestamps.push(collection?.importedAt, collection?.archivedAt)
  for (const run of runs) timestamps.push(run?.startedAt, run?.finishedAt)
  for (const result of runResults) timestamps.push(result?.at, result?.createdAt)
  const latestTimestamp = Math.max(0, ...timestamps.map((value) => Date.parse(value || '') || 0))
  const meaningful = collections.length > 0 || taskCount > 0 || runs.length > 0 || runResults.length > 0 || wmsSkus.length > 0 || !!store?.lastImport
  // Tasks are the primary user-owned content. Results and runs retain useful
  // history, while collections provide the task-center container context.
  // Keep this deterministic so a partial legacy store cannot displace a
  // complete store merely because its JSON file happens to be larger.
  const richness = taskCount * 1000 + runResults.length * 100 + runs.length * 10 + collections.length + wmsSkus.length
  return { meaningful, richness, latestTimestamp, collectionCount: collections.length, taskCount, runCount: runs.length, resultCount: runResults.length }
}

function taskCenterCandidate(source, index) {
  const file = path.join(source, TASK_CENTER_FILENAME)
  if (!fs.existsSync(file)) return null
  const value = readJson(file, null)
  const metrics = taskCenterMetrics(value)
  return metrics.meaningful ? { source, index, file, value, metrics } : null
}

function selectTaskCenterSource(sources) {
  let best = null
  sources.forEach((source, index) => {
    const candidate = taskCenterCandidate(source, index)
    if (!candidate) return
    if (!best || candidate.metrics.richness > best.metrics.richness ||
      (candidate.metrics.richness === best.metrics.richness && candidate.metrics.latestTimestamp > best.metrics.latestTimestamp)) {
      best = candidate
    }
  })
  return best
}

function shouldRestoreTaskCenter(source, destination) {
  if (!source) return false
  const targetMetrics = taskCenterMetrics(destination)
  if (!targetMetrics.meaningful) return true
  // Existing task-center state is operator-owned. Keep it whenever it is
  // richer, or at least as recent, than a legacy source. A source can replace
  // a thin/older target, which is the recovery path for a fresh install.
  if (targetMetrics.latestTimestamp > source.metrics.latestTimestamp) return false
  return targetMetrics.richness < source.metrics.richness
}

function reconcileTaskCenterStore(sources, destination) {
  const source = selectTaskCenterSource(sources)
  if (!source) return { action: 'none', source: null }
  const destinationFile = path.join(destination, TASK_CENTER_FILENAME)
  const destinationStore = readJson(destinationFile, null)
  if (!shouldRestoreTaskCenter(source, destinationStore)) return { action: 'preserved', source: source.source }
  writeJsonAtomic(destinationFile, source.value)
  return { action: 'restored', source: source.source }
}

function rowsFromSource(source) {
  const rows = []
  const sourceRows = readJson(path.join(source, 'seller-sources.json'), [])
  const merchantRows = readJson(path.join(source, 'merchant-batch-all.json'), [])
  const checkpoint = readJson(path.join(source, 'seller-checkpoint-v3.json'), {})
  for (const row of Array.isArray(sourceRows) ? sourceRows : []) rows.push({ kind: 'source', row, source })
  for (const row of Array.isArray(merchantRows) ? merchantRows : []) rows.push({ kind: 'source', row, source })
  for (const row of Array.isArray(checkpoint.records) ? checkpoint.records : []) rows.push({ kind: 'progress', row, source, persistedAt: checkpoint.persistedAt })
  const progressFile = path.join(source, 'seller-progress.jsonl')
  if (fs.existsSync(progressFile)) {
    for (const line of fs.readFileSync(progressFile, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { rows.push({ kind: 'progress', row: JSON.parse(line), source }) } catch { /* corrupt lines remain in complete backup */ }
    }
  }
  return rows.filter((entry) => sellerId(entry.row))
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function mergeUnique(values, key = (value) => stableJson(value)) {
  const found = new Map()
  for (const value of values.flat()) found.set(key(value), value)
  return [...found.values()]
}

// Seller homepage queues are not just a bag of numeric IDs.  The source
// workbooks carry the human-facing label, category and source-slot context
// that operators need when reviewing a 10k-row queue.  Keep only these
// non-secret display fields while merging legacy source files; crawl state is
// still merged separately from checkpoint/progress rows below.
const SELLER_DISPLAY_FIELDS = [
  'sellerName', 'mainContent', 'mainType', 'category', 'board', 'boardName',
  'sourceBoardRanks', 'rank', 'sourceRank', 'sourceOrdinal', 'sourceSlotCount', 'cities', 'excelRow',
  'sourceSheet', 'sourceWorkbook'
]

function displayMetadata(rows) {
  const metadata = {}
  for (const row of rows) {
    for (const field of SELLER_DISPLAY_FIELDS) {
      const value = row?.[field]
      if (value === undefined || value === null || String(value).trim() === '') continue
      // Never copy a credential-like field even if a future workbook happens
      // to use an unfortunate header name.
      if (/token|cookie|authorization|password|secret|session/i.test(field)) continue
      if (metadata[field] === undefined) metadata[field] = value
    }
  }
  return metadata
}

function rowTimestamp(entry) {
  const row = entry.row
  return Date.parse(row.updatedAt || row.finishedAt || row.persistedAt || entry.persistedAt || row.startedAt || '') || 0
}

function mergePlan(sources) {
  const entries = sources.flatMap(rowsFromSource)
  const ids = [...new Set(entries.map((entry) => sellerId(entry.row)))].sort()
  const sourceRows = []
  const records = []
  let conflicts = 0
  for (const id of ids) {
    const group = entries.filter((entry) => sellerId(entry.row) === id)
    const sourcesForId = group.filter((entry) => entry.kind === 'source')
    const progress = group.filter((entry) => entry.kind === 'progress').sort((a, b) => rowTimestamp(b) - rowTimestamp(a))
    const source = sourcesForId[0]?.row || progress[0]?.row || {}
    const metadata = displayMetadata(sourcesForId.map((entry) => entry.row))
    sourceRows.push({
      id,
      sellerId: id,
      url: source.url || source.sourceUrl || `https://www.goofish.com/personal?userId=${encodeURIComponent(id)}`,
      source: 'seller-user-data-migration',
      ...metadata
    })
    if (!progress.length) {
      records.push({ schemaVersion: 3, id, sellerId: id, status: 'pending', itemIds: { active: [], sold: [] }, attempts: [], reasonCode: null })
      continue
    }
    const newestTime = rowTimestamp(progress[0])
    const newest = progress.filter((entry) => rowTimestamp(entry) === newestTime)
    const distinctNewest = new Set(newest.map((entry) => stableJson(entry.row)))
    const conflict = distinctNewest.size > 1
    if (conflict) conflicts += 1
    const base = { ...progress[0].row }
    const allRows = progress.map((entry) => entry.row)
    const activeIds = mergeUnique(allRows.map((row) => row.itemIds?.active || row.activeItemIds || []), String)
    const soldIds = mergeUnique(allRows.map((row) => row.itemIds?.sold || row.soldItemIds || []), String).filter((idValue) => !activeIds.includes(idValue))
    const attempts = mergeUnique(allRows.map((row) => row.attempts || []), (attempt) => String(attempt.attemptKey || stableJson(attempt)))
    const status = base.status === 'running' ? 'pending' : (conflict ? 'needs_review' : (base.status || 'pending'))
    records.push({
      ...base,
      schemaVersion: 3,
      id,
      sellerId: id,
      status,
      itemIds: { active: activeIds, sold: soldIds },
      attempts,
      reasonCode: base.status === 'running' ? 'RECOVERED_INTERRUPTED_RUN' : (conflict ? 'MIGRATION_CONFLICT' : (base.reasonCode || null)),
      migrationConflict: conflict ? { candidateCount: newest.length, latestTimestamp: newestTime || null } : undefined
    })
  }
  return { sourceRows, records, conflicts }
}

function metadataReport(mode, options, plan) {
  return {
    schemaVersion: 1,
    mode,
    sources: options.sources.map((source) => ({ path: source, ...treeInventory(source) })),
    destination: { path: options.destination, ...treeInventory(options.destination) },
    summary: { uniqueSellerIds: plan.sourceRows.length, progressRecords: plan.records.length, conflicts: plan.conflicts },
    backups: []
  }
}

function pidIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

function activeWriters(options) {
  const active = []
  if (options.writerPidFile && fs.existsSync(options.writerPidFile)) {
    const pid = Number(fs.readFileSync(options.writerPidFile, 'utf8').trim())
    if (pidIsAlive(pid)) active.push({ kind: 'pid-file', pid })
  }
  if (options.destination === EXACT_DESTINATION) {
    try {
      const output = execFileSync('/usr/bin/pgrep', ['-afil', WRITER_PATTERNS.join('|')], { encoding: 'utf8' })
      for (const line of output.split('\n').filter(Boolean)) {
        const pid = Number(line.match(/^\d+/)?.[0])
        if (pid && pid !== process.pid) active.push({ kind: 'application', pid })
      }
    } catch (error) {
      if (![1, null].includes(error.status)) throw error
    }
  }
  return active
}

function copyCompleteBackup(source, backupRoot, index) {
  const before = treeInventory(source)
  if (!before.exists) return { source, path: null, ...before }
  const target = backupTarget(source, backupRoot, index, before)
  if (!fs.existsSync(target)) fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false })
  const after = treeInventory(target)
  if (stableJson(before) !== stableJson(after)) throw new Error(`backup checksum mismatch for source ${index + 1}`)
  restrictTree(target)
  return { source, path: target, ...after }
}

function backupTarget(source, backupRoot, index, inventory = treeInventory(source)) {
  if (!inventory.exists) return null
  const name = `${String(index + 1).padStart(2, '0')}-${crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)}-${inventory.sha256.slice(0, 12)}`
  return path.join(backupRoot, name)
}

function evidenceCopyBytes(source, destination) {
  if (!fs.existsSync(source)) return 0
  let bytes = 0
  const visit = (from, to, topLevel = false) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const allowed = !topLevel || CHROME_NAMES.has(entry.name) || /^(seller-|merchant-homepage-data)/.test(entry.name)
      if (!allowed || (topLevel && RUNTIME_ONLY_TOP_LEVEL.has(entry.name)) || (topLevel && ['seller-sources.json', 'seller-checkpoint-v3.json', 'seller-progress.jsonl'].includes(entry.name))) continue
      const sourcePath = path.join(from, entry.name)
      const destinationPath = path.join(to, entry.name)
      if (!fs.existsSync(destinationPath)) {
        bytes += entry.isDirectory() ? treeInventory(sourcePath).bytes : fs.statSync(sourcePath).size
      } else if (entry.isDirectory() && !(topLevel && CHROME_NAMES.has(entry.name))) {
        visit(sourcePath, destinationPath, false)
      }
    }
  }
  visit(source, destination, true)
  return bytes
}

function ensureMigrationCapacity(options) {
  const requirements = new Map()
  const addRequirement = (target, bytes) => {
    if (bytes <= 0) return
    const parent = nearestExistingDirectory(target)
    const device = String(fs.statSync(parent).dev)
    const current = requirements.get(device) || { parent, bytes: 0 }
    current.bytes += bytes
    requirements.set(device, current)
  }
  options.sources.forEach((source, index) => {
    const inventory = treeInventory(source)
    const target = backupTarget(source, options.backupRoot, index, inventory)
    if (target && !fs.existsSync(target)) addRequirement(options.backupRoot, inventory.bytes)
    addRequirement(options.destination, evidenceCopyBytes(source, options.destination))
  })
  const taskCenterSource = selectTaskCenterSource(options.sources)
  const destinationTaskCenter = readJson(path.join(options.destination, TASK_CENTER_FILENAME), null)
  if (taskCenterSource && shouldRestoreTaskCenter(taskCenterSource, destinationTaskCenter)) {
    addRequirement(options.destination, fs.statSync(taskCenterSource.file).size)
  }
  for (const { parent, bytes } of requirements.values()) {
    const reserve = Math.max(64 * 1024 * 1024, Math.ceil(bytes * 0.05))
    const required = bytes + reserve
    const available = availableBytes(parent)
    if (available < required) {
      throw new Error(`insufficient free space for migration: need ${required} bytes, have ${available} bytes on ${parent}`)
    }
  }
}

function copyAllowedEvidence(source, destination) {
  if (!fs.existsSync(source)) return
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const allowed = CHROME_NAMES.has(entry.name) || /^(seller-|merchant-homepage-data)/.test(entry.name)
    if (!allowed || RUNTIME_ONLY_TOP_LEVEL.has(entry.name) || ['seller-sources.json', 'seller-checkpoint-v3.json', 'seller-progress.jsonl'].includes(entry.name)) continue
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (!fs.existsSync(to)) fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: true })
    else if (entry.isDirectory() && !CHROME_NAMES.has(entry.name)) mergeDirectoryWithoutOverwrite(from, to)
  }
}

function mergeDirectoryWithoutOverwrite(source, destination) {
  fs.mkdirSync(destination, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (!fs.existsSync(to)) fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: true })
    else if (entry.isDirectory()) mergeDirectoryWithoutOverwrite(from, to)
  }
}

function mergedMeta(sources, destination = '') {
  const metas = sources.map((source) => readJson(path.join(source, 'xianyu-seller-crawl.json'), {}))
  const existing = destination ? readJson(path.join(destination, 'xianyu-seller-crawl.json'), {}) : {}
  const sourceJob = { ...Object.assign({}, ...metas.map((meta) => meta.job || {})), running: false }
  const hasExistingJob = existing.job && typeof existing.job === 'object' && Object.keys(existing.job).length > 0
  return {
    // An upgrade must not silently reset settings the operator changed in the
    // seller pilot itself. Legacy sources provide defaults only; the existing
    // destination settings are the newest user-owned configuration.
    settings: Object.assign({}, ...metas.map((meta) => meta.settings || {}), existing.settings || {}),
    // The destination is the authoritative seller queue after the first
    // install. Preserve an in-flight job marker so the new process can run its
    // normal startup recovery instead of silently idling after an upgrade.
    job: hasExistingJob ? { ...existing.job } : sourceJob,
    lastImport: metas.map((meta) => meta.lastImport).filter(Boolean).at(-1) || null,
    recentEvents: mergeUnique(metas.map((meta) => meta.recentEvents || [])),
    accountSafetyStates: Object.assign({}, ...metas.map((meta) => meta.accountSafetyStates || {}), existing.accountSafetyStates || {}),
    scheduleState: Object.assign({}, ...metas.map((meta) => meta.scheduleState || {}), existing.scheduleState || {}),
    // Legacy stores may have a lastCanonicalImport hash but no explicit mode.
    // Do not infer canonical membership from that hash: migrated rows remain
    // an imported source universe until an explicit manifest import occurs.
    sourceMode: existing.sourceMode === 'canonical' || existing.sourceMode === 'imported'
      ? existing.sourceMode
      : metas.map((meta) => meta.sourceMode).find((mode) => mode === 'canonical' || mode === 'imported') || 'imported'
  }
}

function safeAccountMetadata(sources, destination) {
  // Legacy sources provide defaults; the destination is operator-owned and
  // must win when it already has an explicit AdsPower binding. Reading it
  // last also prevents a legacy config without browserProvider from erasing a
  // profile that was set in the seller pilot during a later upgrade.
  const configs = [...sources, destination].map((source) => readJson(path.join(source, 'xianyu-electron.json'), {}))
  const accounts = new Map()
  for (const config of configs) {
    for (const account of Array.isArray(config.accounts) ? config.accounts : []) {
      const id = String(account?.id || '').trim()
      const partition = String(account?.partition || '').trim()
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) continue
      if (partition !== `persist:xianyu-${id}`) continue
      const normalized = {
        id,
        name: String(account?.name || id).slice(0, 120),
        partition,
        enabled: account?.enabled !== false
      }
      // AdsPower owns the fingerprint/cookie session.  Preserve an explicit
      // binding during install migration; dropping it silently routes the
      // account back to an empty Electron partition after upgrade.
      //
      // A pre-migration `bitBrowserId` names an environment that only exists
      // in BitBrowser, so it is deliberately not carried over as an AdsPower
      // id — the account surfaces as unbound and the operator rebinds it.
      const provider = String(account?.browserProvider || '').trim().toLowerCase()
      const profile = String(account?.adsPowerId || account?.browserProfileId || '').trim()
      if (provider === 'adspower' && /^[A-Za-z0-9_-]{1,128}$/.test(profile)) {
        normalized.browserProvider = 'adspower'
        normalized.adsPowerId = profile
      }
      accounts.set(id, normalized)
    }
  }
  return [...accounts.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function mergeRuntimeConfig(sources, destination) {
  const existing = readJson(path.join(destination, 'xianyu-electron.json'), {})
  return { ...existing, accounts: safeAccountMetadata(sources, destination) }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(temp, file)
}

function restrictTree(root) {
  if (!fs.existsSync(root)) return
  fs.chmodSync(root, 0o700)
  for (const rel of walkFiles(root)) fs.chmodSync(path.join(root, rel), 0o600)
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) { fs.chmodSync(path.join(dir, entry.name), 0o700); visit(path.join(dir, entry.name)) }
  }
  visit(root)
}

function applyMigration(options, plan) {
  const writers = activeWriters(options)
  if (writers.length) {
    const error = new Error(`migration refused: ${writers.length} writer process(es) are still running`)
    error.exitCode = 2
    throw error
  }
  ensureMigrationCapacity(options)
  fs.mkdirSync(options.backupRoot, { recursive: true, mode: 0o700 })
  const backups = options.sources.map((source, index) => copyCompleteBackup(source, options.backupRoot, index))
  // Sources are immutable and fully backed up before this point. Reconcile in-place
  // with atomic metadata writes so a 1+ GB evidence tree is never duplicated into
  // a second staging tree on disk-constrained production Macs.
  fs.mkdirSync(options.destination, { recursive: true, mode: 0o700 })
  for (const source of options.sources) copyAllowedEvidence(source, options.destination)
  reconcileTaskCenterStore(options.sources, options.destination)
  writeJsonAtomic(path.join(options.destination, 'seller-sources.json'), plan.sourceRows)
  const persistedAtMs = Math.max(0, ...options.sources.map((source) => Date.parse(readJson(path.join(source, 'seller-checkpoint-v3.json'), {}).persistedAt || '') || 0))
  writeJsonAtomic(path.join(options.destination, 'seller-checkpoint-v3.json'), { schemaVersion: 3, persistedAt: persistedAtMs ? new Date(persistedAtMs).toISOString() : null, records: plan.records })
  writeJsonAtomic(path.join(options.destination, 'xianyu-seller-crawl.json'), mergedMeta(options.sources, options.destination))
  writeJsonAtomic(path.join(options.destination, 'xianyu-electron.json'), mergeRuntimeConfig(options.sources, options.destination))
  restrictTree(options.destination)
  return backups
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  validateCoordinates(options)
  const plan = mergePlan(options.sources)
  let report = metadataReport(options.mode, options, plan)
  if (options.mode === 'apply') {
    report.backups = applyMigration(options, plan)
    report.destination = { path: options.destination, ...treeInventory(options.destination) }
    if (!options.report) throw new Error('--report is required for apply')
    writeJsonAtomic(options.report, report)
  } else if (options.mode === 'verify') {
    if (!fs.existsSync(options.destination)) throw new Error('destination does not exist')
    const checkpoint = readJson(path.join(options.destination, 'seller-checkpoint-v3.json'), {})
    if ((checkpoint.records || []).length !== plan.records.length) throw new Error('destination progress count mismatch')
    if (options.report) {
      const applied = readJson(options.report, null)
      if (!applied || applied.destination?.sha256 !== report.destination.sha256) throw new Error('destination checksum does not match apply report')
    }
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
}

try { main() } catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exit(error.exitCode || 1)
}

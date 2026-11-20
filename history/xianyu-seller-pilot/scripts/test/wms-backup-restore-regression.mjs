import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../..', import.meta.url))
const migrator = join(projectRoot, 'scripts/release/migrate-seller-user-data.mjs')

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function inventory(root) {
  const hash = crypto.createHash('sha256')
  let files = 0
  let bytes = 0
  function visit(dir, base = '') {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      const rel = relative(root, path)
      if (entry.isDirectory()) visit(path, base)
      else if (entry.isFile() && !['migration-report.json', '.seller-pilot-install-state.json'].includes(rel)) {
        const data = readFileSync(path)
        const digest = crypto.createHash('sha256').update(data).digest('hex')
        files += 1
        bytes += data.length
        hash.update(rel).update('\0').update(String(data.length)).update('\0').update(digest).update('\n')
      }
    }
  }
  visit(root)
  return { exists: existsSync(root), fileCount: files, bytes, sha256: hash.digest('hex') }
}

function runMigration(args, expected = 0) {
  const result = spawnSync(process.execPath, [migrator, ...args], { cwd: projectRoot, encoding: 'utf8' })
  assert.equal(result.status, expected, `migration ${args[0]} failed (signal=${result.signal}, error=${result.error?.message || 'none'})\n${result.stdout}\n${result.stderr}`)
  return result.stdout.trim() ? JSON.parse(result.stdout) : null
}

function hasSecret(value) {
  return /fixture[-_](?:token|cookie|secret)|authorization\s*:/i.test(JSON.stringify(value))
}

function inventoryFacts(value) {
  return { exists: value?.exists, fileCount: value?.fileCount, bytes: value?.bytes, sha256: value?.sha256 }
}

const root = mkdtempSync(join(tmpdir(), 'seller-pilot-api-spu-backup-'))
const legacy = join(root, 'legacy')
const destination = join(root, 'destination')
const rehydrated = join(root, 'rehydrated')
const backupRoot = join(root, 'backups')
const rehydratedBackupRoot = join(root, 'rehydrated-backups')
const report = join(root, 'migration-report.json')
const rehydratedReport = join(root, 'rehydrated-report.json')
mkdirSync(legacy, { recursive: true })

const taskCenter = {
  activeCollectionId: null,
  collections: [],
  settings: { wmsSource: 'rest' },
  wmsSkus: [{ sku_code: 'SKU-001', spu_code: 'SPU-001', status: 'IN_STOCK' }],
  wmsSyncedAt: '2026-08-25T10:00:00.000Z',
  wmsSyncState: { status: 'synced', source: 'rest', snapshotHash: 'fixture-snapshot-hash' },
  apiSpuLedger: {
    'SPU-001': { canonicalSpu: 'SPU-001', taskId: 'api-spu-001', active: true, lastSeenAt: '2026-08-25T10:00:00.000Z' }
  },
  apiListingPrices: {
    'SPU-001': { skuCode: 'SKU-001', spuCode: 'SPU-001', price: 229, verifiedAt: '2026-08-25T10:01:00.000Z' }
  },
  runs: [{ id: 'run-001', status: 'done', total: 1 }],
  runResults: [{ id: 'result-001', taskId: 'api-spu-001', status: 'success', price: 229 }]
}
writeJson(join(legacy, 'xianyu-task-center.json'), taskCenter)
writeJson(join(legacy, 'seller-checkpoint-v3.json'), { schemaVersion: 3, persistedAt: '2026-08-25T10:00:00.000Z', records: [] })
writeJson(join(legacy, 'seller-sources.json'), [])
writeJson(join(legacy, 'xianyu-seller-crawl.json'), { settings: {}, job: { running: false } })
writeJson(join(legacy, 'xianyu-electron.json'), { accounts: [] })

const common = ['--source', legacy, '--destination', destination, '--backup-root', backupRoot]
const before = inventory(legacy)
const inventoryReport = runMigration(['inventory', ...common])
assert.equal(inventoryReport.mode, 'inventory')
assert.deepEqual(inventoryReport.sources[0].sha256, before.sha256)
assert.equal(existsSync(destination), false, 'inventory must be write-free')
assert.equal(existsSync(backupRoot), false, 'inventory must not create a backup')
assert.equal(hasSecret(inventoryReport), false)

const dryRun = runMigration(['dry-run', ...common])
assert.equal(dryRun.mode, 'dry-run')
assert.equal(existsSync(destination), false, 'dry-run must be write-free')
assert.equal(existsSync(backupRoot), false, 'dry-run must not create a backup')

const applied = runMigration(['apply', ...common, '--writer-pid-file', join(root, 'absent.pid'), '--report', report])
assert.equal(applied.mode, 'apply')
assert.equal(applied.backups.length, 1)
assert.equal(applied.backups[0].fileCount > 0, true)
assert.equal(applied.backups[0].bytes > 0, true)
assert.match(applied.backups[0].sha256, /^[a-f0-9]{64}$/)
assert.equal(hasSecret(applied), false)
assert.equal(existsSync(report), true)

const verified = runMigration(['verify', ...common, '--report', report])
assert.equal(verified.mode, 'verify')
assert.deepEqual(inventoryFacts(inventory(destination)), inventoryFacts(applied.destination))

const backupSource = applied.backups[0].path
assert.ok(backupSource && existsSync(backupSource), 'immutable source backup must exist')
const rehydrateCommon = ['--source', backupSource, '--destination', rehydrated, '--backup-root', rehydratedBackupRoot]
const rehydratedApply = runMigration(['apply', ...rehydrateCommon, '--writer-pid-file', join(root, 'absent-2.pid'), '--report', rehydratedReport])
runMigration(['verify', ...rehydrateCommon, '--report', rehydratedReport])
assert.deepEqual(inventoryFacts(inventory(rehydrated)), inventoryFacts(rehydratedApply.destination))
const restored = JSON.parse(readFileSync(join(rehydrated, 'xianyu-task-center.json'), 'utf8'))
assert.deepEqual(restored.apiSpuLedger, taskCenter.apiSpuLedger)
assert.deepEqual(restored.wmsSyncState, taskCenter.wmsSyncState)
assert.deepEqual(restored.apiListingPrices, taskCenter.apiListingPrices)
assert.deepEqual(restored.runs, taskCenter.runs)
assert.deepEqual(restored.runResults, taskCenter.runResults)
assert.equal(hasSecret(restored), false)

const evidence = {
  schemaVersion: 1,
  status: 'PASS',
  fixture: 'offline-api-spu-user-data',
  source: before,
  backup: applied.backups[0],
  destination: applied.destination,
  rehydrated: rehydratedApply.destination,
  readback: { apiSpuLedger: true, wmsSyncState: true, apiListingPrices: true, queueHistory: true },
  secretScan: 'PASS'
}
assert.equal(hasSecret(evidence), false)
console.log(JSON.stringify(evidence, null, 2))
console.log('wms backup restore regression: PASS')

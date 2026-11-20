import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '../..')
const repositoryRoot = resolve(projectRoot, '..')
const migrationScript = join(projectRoot, 'scripts/release/migrate-seller-user-data.mjs')

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2))
}

function runMigration(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [migrationScript, ...args], { encoding: 'utf8' })
  assert.equal(result.status, expectedStatus, `migration status ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
  return result
}

function flagValue(flag, fallback = null) {
  const index = process.argv.indexOf(flag)
  if (index < 0) return fallback
  const value = process.argv[index + 1]
  assert(value && !value.startsWith('--'), `${flag} requires a value`)
  return value
}

function writeIdentityReport(reportPath, report) {
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
}

function bundleHash(bundlePath) {
  const verifier = join(projectRoot, 'scripts/test/verify-seller-release.mjs')
  const result = spawnSync(process.execPath, [verifier, '--bundle-hash', bundlePath], { cwd: projectRoot, encoding: 'utf8' })
  assert.equal(result.status, 0, `bundle identity verification failed\n${result.stdout}\n${result.stderr}`)
  const value = JSON.parse(result.stdout)
  return { bundleSha256: value.bundle.sha256, signature: { status: 'PASS', identity: value.signature.identity || 'com.erp.xianyu.sellerpilot' } }
}

function sandboxRoots(report) {
  assert(isAbsolute(report.sandboxRoot), 'sandboxRoot must be absolute')
  const root = resolve(report.sandboxRoot)
  for (const key of ['applicationsRoot', 'supportRoot', 'launchAgentsRoot', 'userData']) {
    assert(isAbsolute(report[key]), `${key} must be absolute`)
    const value = resolve(report[key])
    assert(value !== root && value.startsWith(`${root}/`), `${key} escapes sandboxRoot`)
  }
  const bundle = resolve(report.bundlePath)
  assert(bundle.startsWith(`${resolve(report.applicationsRoot)}/`), 'bundlePath escapes applicationsRoot')
  return {
    root,
    applications: resolve(report.applicationsRoot),
    support: resolve(report.supportRoot),
    launchAgents: resolve(report.launchAgentsRoot),
    userData: resolve(report.userData),
    bundle
  }
}

function runGuiPrepare() {
  const manifest = resolve(repositoryRoot, flagValue('--candidate-manifest'))
  const reportPath = resolve(repositoryRoot, flagValue('--installed-identity-report'))
  assert(existsSync(manifest), `candidate manifest missing: ${manifest}`)
  const manifestData = JSON.parse(readFileSync(manifest, 'utf8'))
  const sandbox = mkdtempSync(join(tmpdir(), 'seller-pilot-gui-'))
  const applications = join(sandbox, 'Applications')
  const support = join(sandbox, 'Application Support')
  const agents = join(sandbox, 'LaunchAgents')
  mkdirSync(join(applications, '闲鱼行情爬虫.app'), { recursive: true })
  mkdirSync(join(applications, '闲鱼行情工作台.app'), { recursive: true })
  writeFileSync(join(applications, '闲鱼行情爬虫.app', 'identity.txt'), 'legacy-crawler')
  writeFileSync(join(applications, '闲鱼行情工作台.app', 'identity.txt'), 'legacy-workbench')
  const source = join(support, 'xianyu-electron')
  mkdirSync(source, { recursive: true })
  writeJson(join(source, 'seller-checkpoint-v3.json'), { schemaVersion: 3, persistedAt: new Date().toISOString(), records: [] })
  const env = {
    ...process.env,
    SELLER_PILOT_SANDBOX_ROOT: sandbox,
    SELLER_PILOT_APPLICATIONS_ROOT: applications,
    SELLER_PILOT_SUPPORT_ROOT: support,
    SELLER_PILOT_LAUNCH_AGENTS_ROOT: agents
  }
  const installer = join(projectRoot, 'scripts/release/install-seller-pilot.sh')
  const result = spawnSync(installer, ['--sandbox', '--manifest', manifest], { cwd: projectRoot, env, encoding: 'utf8' })
  assert.equal(result.status, 0, `sandbox prepare install failed\n${result.stdout}\n${result.stderr}`)
  const bundle = join(applications, '闲鱼卖家巡航台.app')
  const identity = bundleHash(bundle)
  const asar = join(bundle, 'Contents/Resources/app.asar')
  const manifestSha256 = crypto.createHash('sha256').update(readFileSync(manifest)).digest('hex')
  const report = {
    schemaVersion: 1,
    reportKind: 'seller-installed-identity',
    manifestPath: manifest,
    manifestSha256,
    sandboxRoot: sandbox,
    applicationsRoot: applications,
    supportRoot: support,
    launchAgentsRoot: agents,
    userData: join(support, '闲鱼卖家巡航台'),
    bundlePath: bundle,
    bundleSha256: identity.bundleSha256,
    asarSha256: crypto.createHash('sha256').update(readFileSync(asar)).digest('hex'),
    appId: manifestData.identity.appId,
    launchAgentLabel: manifestData.identity.launchAgentLabel,
    signature: identity.signature
  }
  writeIdentityReport(reportPath, report)
  console.log(JSON.stringify({ ok: true, mode: 'prepare-gui', installedIdentityReport: reportPath, sandboxRoot: sandbox, bundlePath: bundle }, null, 2))
}

function runGuiCleanup() {
  const reportPath = resolve(repositoryRoot, flagValue('--installed-identity-report'))
  assert(existsSync(reportPath), `installed identity report missing: ${reportPath}`)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const roots = sandboxRoots(report)
  const env = {
    ...process.env,
    SELLER_PILOT_SANDBOX_ROOT: roots.root,
    SELLER_PILOT_APPLICATIONS_ROOT: roots.applications,
    SELLER_PILOT_SUPPORT_ROOT: roots.support,
    SELLER_PILOT_LAUNCH_AGENTS_ROOT: roots.launchAgents
  }
  const rollback = join(projectRoot, 'scripts/release/rollback-seller-pilot.sh')
  const result = spawnSync(rollback, ['--sandbox'], { cwd: projectRoot, env, encoding: 'utf8' })
  assert.equal(result.status, 0, `sandbox cleanup rollback failed\n${result.stdout}\n${result.stderr}`)
  assert(existsSync(roots.userData), 'cleanup must preserve seller-pilot userData evidence')
  rmSync(roots.root, { recursive: true, force: true })
  console.log(JSON.stringify({ ok: true, mode: 'cleanup', sandboxRoot: roots.root, reportPath }, null, 2))
}

function reportHasSecret(value) {
  return /fixture-cookie-secret|fixture-token-secret|authorization/i.test(JSON.stringify(value))
}

function migrationFixture() {
  const root = mkdtempSync(join(tmpdir(), 'seller-pilot-migration-'))
  const legacy = join(root, 'legacy')
  const modular = join(root, 'modular')
  const destination = join(root, 'seller-pilot')
  const backupRoot = join(root, 'backups')
  const report = join(root, 'migration-report.json')
  mkdirSync(legacy, { recursive: true })
  mkdirSync(modular, { recursive: true })

  writeJson(join(legacy, 'merchant-batch-all.json'), [
    { sellerId: 'seller-a', url: 'https://www.goofish.com/personal?userId=seller-a', sellerName: '测试卖家A', mainType: '显示器', boardName: '显示器榜', sourceRank: 7, sourceSlotCount: 100 },
    { sellerId: 'seller-b', url: 'https://www.goofish.com/personal?userId=seller-b' }
  ])
  writeJson(join(legacy, 'seller-sources.json'), [
    { id: '1f43e6dc34a045f56fd10c9a', url: 'https://www.goofish.com/personal?userId=seller-a' }
  ])
  writeJson(join(legacy, 'seller-checkpoint-v3.json'), {
    schemaVersion: 3,
    persistedAt: '2026-08-20T02:00:00.000Z',
    records: [{
      id: 'seller-a', sellerId: 'seller-a', status: 'incomplete', updatedAt: '2026-08-20T02:00:00.000Z',
      expected: { active: 3, sold: 1 }, itemIds: { active: ['a1'], sold: [] }, attempts: [{ attemptKey: 'cycle:a', cycleKey: 'cycle', sellerId: 'seller-a', accountId: 'account-a' }]
    }]
  })
  writeFileSync(join(legacy, 'seller-progress.jsonl'), JSON.stringify({ id: 'seller-b', sellerId: 'seller-b', status: 'pending', updatedAt: '2026-08-19T02:00:00.000Z' }) + '\n')
  writeJson(join(legacy, 'xianyu-seller-crawl.json'), { settings: { weeklyTime: '02:00' }, accountSafetyStates: { 'account-a': { status: 'cooling', coolingUntil: '2026-08-24T00:00:00.000Z' } } })
  writeJson(join(legacy, 'xianyu-electron.json'), {
    accounts: [{ id: 'account-a', name: '账号 A', partition: 'persist:xianyu-account-a', enabled: true, browserProvider: 'adspower', adsPowerId: 'profile-a', cookie: 'fixture-cookie-secret' }],
    tokenEnc: 'fixture-token-secret'
  })
  writeJson(join(legacy, 'xianyu-task-center.json'), {
    activeCollectionId: 'legacy-task-collection',
    collections: [{
      id: 'legacy-task-collection',
      name: '旧版任务清单',
      sourceFile: 'legacy-tasks.xlsx',
      importedAt: '2026-08-20T02:00:00.000Z',
      rowCount: 1,
      tasks: [{ id: 'legacy-task', name: '华硕 G259CMS', brand: '华硕', model: 'G259CMS', enabled: true }]
    }],
    settings: { dailyEnabled: false, dailyTime: '02:00' },
    runs: [{ id: 'legacy-run', collectionId: 'legacy-task-collection', status: 'done', total: 1, startedAt: '2026-08-20T02:05:00.000Z', finishedAt: '2026-08-20T02:06:00.000Z' }],
    runResults: [{ id: 'legacy-result', taskId: 'legacy-task', runId: 'legacy-run', status: 'success', at: '2026-08-20T02:06:00.000Z', price: 620 }],
    lastImport: { sourceFile: 'legacy-tasks.xlsx', rowCount: 1, at: '2026-08-20T02:00:00.000Z' }
  })
  writeJson(join(modular, 'seller-checkpoint-v3.json'), {
    schemaVersion: 3,
    persistedAt: '2026-08-21T02:00:00.000Z',
    records: [{
      id: 'seller-a', sellerId: 'seller-a', status: 'completed', updatedAt: '2026-08-20T02:00:00.000Z',
      expected: { active: 2, sold: 1 }, itemIds: { active: ['a2'], sold: ['s1'] }, attempts: [{ attemptKey: 'cycle:b', cycleKey: 'cycle', sellerId: 'seller-a', accountId: 'account-b' }]
    }]
  })
  mkdirSync(join(legacy, 'seller-events'), { recursive: true })
  writeFileSync(join(legacy, 'seller-events/seller-events-2026-08-20.jsonl'), '{"sellerId":"seller-a","kind":"checkpoint"}\n')
  // Runtime leases are deliberately not migration evidence. A crashed source
  // can leave a lock directory without owner.json; copying it would make the
  // freshly installed app fail before it can recover the queue.
  mkdirSync(join(legacy, 'seller-leases', 'stale-lock-without-owner'), { recursive: true })
  mkdirSync(join(legacy, 'seller-claim.mutex'), { recursive: true })
  mkdirSync(join(legacy, 'Partitions/persist_account-a/Network'), { recursive: true })
  writeFileSync(join(legacy, 'Partitions/persist_account-a/Network/Cookies'), 'fixture-cookie-secret')
  writeFileSync(join(legacy, 'Cookies'), 'fixture-token-secret')

  return { root, legacy, modular, destination, backupRoot, report }
}

function testMigration() {
  const fx = migrationFixture()
  const common = ['--source', fx.legacy, '--source', fx.modular, '--destination', fx.destination, '--backup-root', fx.backupRoot]

  const inventory = runMigration(['inventory', ...common])
  const inventoryJson = JSON.parse(inventory.stdout)
  assert.equal(inventoryJson.mode, 'inventory')
  assert.equal(reportHasSecret(inventoryJson), false)

  const dryRun = runMigration(['dry-run', ...common])
  const dryRunJson = JSON.parse(dryRun.stdout)
  assert.equal(dryRunJson.mode, 'dry-run')
  assert.equal(dryRunJson.summary.uniqueSellerIds, 2)
  assert.equal(dryRunJson.summary.conflicts, 1)
  assert.equal(existsSync(fx.destination), false, 'dry-run must not create destination')
  assert.equal(existsSync(fx.backupRoot), false, 'dry-run must not create backup')

  runMigration(['dry-run', '--source', fx.legacy, '--destination', fx.destination, '--backup-root', join(fx.legacy, 'recursive-backups')], 1)
  assert.equal(existsSync(join(fx.legacy, 'recursive-backups')), false, 'overlapping backup refusal must be write-free')

  const pidFile = join(fx.root, 'writer.pid')
  writeFileSync(pidFile, String(process.pid))
  runMigration(['apply', ...common, '--writer-pid-file', pidFile, '--report', fx.report], 2)
  assert.equal(existsSync(fx.destination), false, 'running-writer refusal must be write-free')

  writeFileSync(pidFile, '999999')
  runMigration(['apply', ...common, '--writer-pid-file', pidFile, '--report', fx.report])
  assert.equal(existsSync(fx.report), true)
  const applied = JSON.parse(readFileSync(fx.report, 'utf8'))
  assert.equal(applied.mode, 'apply')
  assert.equal(reportHasSecret(applied), false, 'reports must never contain cookie/token material')
  assert.equal(applied.summary.conflicts, 1)
  assert.equal(applied.backups.length, 2)
  for (const backup of applied.backups) assert.equal(existsSync(backup.path), true)

  const checkpoint = JSON.parse(readFileSync(join(fx.destination, 'seller-checkpoint-v3.json'), 'utf8'))
  const migratedSources = JSON.parse(readFileSync(join(fx.destination, 'seller-sources.json'), 'utf8'))
  const migratedSeller = migratedSources.find((row) => row.sellerId === 'seller-a')
  assert.equal(migratedSeller.sellerName, '测试卖家A', 'migration keeps seller display name')
  assert.equal(migratedSeller.mainType, '显示器', 'migration keeps seller category')
  assert.equal(migratedSeller.boardName, '显示器榜', 'migration keeps source board')
  assert.equal(migratedSeller.sourceRank, 7, 'migration keeps source rank')
  assert.equal(migratedSeller.sourceSlotCount, 100, 'migration keeps source slot count')
  const conflict = checkpoint.records.find((row) => row.sellerId === 'seller-a' || row.id === 'seller-a')
  assert.equal(conflict.status, 'needs_review')
  assert.deepEqual(conflict.itemIds.active.sort(), ['a1', 'a2'])
  assert.deepEqual(conflict.itemIds.sold, ['s1'])
  assert.equal(conflict.attempts.length, 2)
  assert.equal(existsSync(join(fx.destination, 'Partitions/persist_account-a/Network/Cookies')), true)
  assert.equal(existsSync(join(fx.destination, 'seller-leases')), false, 'migration must not copy stale seller leases')
  assert.equal(existsSync(join(fx.destination, 'seller-claim.mutex')), false, 'migration must not copy stale claim mutex')
  const restoredTaskCenter = JSON.parse(readFileSync(join(fx.destination, 'xianyu-task-center.json'), 'utf8'))
  assert.equal(restoredTaskCenter.activeCollectionId, 'legacy-task-collection', 'missing task-center store is restored from the legacy source')
  assert.equal(restoredTaskCenter.collections[0].tasks[0].id, 'legacy-task', 'task-center tasks are recovered with their collection')
  assert.equal(restoredTaskCenter.runs[0].id, 'legacy-run', 'task-center run history is recovered')
  assert.equal(restoredTaskCenter.runResults[0].id, 'legacy-result', 'task-center run results are recovered')
  // A renderer may create a live lease immediately after apply. Runtime lock
  // descendants are intentionally outside the evidence checksum, so verify
  // remains deterministic while preserving all user-owned seller data.
  mkdirSync(join(fx.destination, 'seller-leases', 'live-lock'), { recursive: true })
  writeJson(join(fx.destination, 'seller-leases', 'live-lock', 'owner.json'), { pid: 42, accountId: 'redacted' })
  runMigration(['verify', ...common, '--report', fx.report])
  const runtimeConfig = JSON.parse(readFileSync(join(fx.destination, 'xianyu-electron.json'), 'utf8'))
  assert.deepEqual(runtimeConfig.accounts, [{ id: 'account-a', name: '账号 A', partition: 'persist:xianyu-account-a', enabled: true, browserProvider: 'adspower', adsPowerId: 'profile-a' }])
  assert.equal(reportHasSecret(runtimeConfig), false, 'runtime config must copy account metadata without cookie/token material')
  assert.equal(statSync(fx.destination).mode & 0o077, 0, 'destination must not be group/world accessible')

  const firstHash = applied.destination.sha256
  // A destination created by a newer release can contain only the default
  // task-center shape after a failed/partial install. Recover the meaningful
  // legacy collection and history instead of leaving the empty target in
  // place.
  writeJson(join(fx.destination, 'xianyu-task-center.json'), {
    activeCollectionId: null,
    collections: [],
    settings: {},
    runs: [],
    runResults: []
  })
  runMigration(['apply', ...common, '--writer-pid-file', pidFile, '--report', fx.report])
  const recoveredEmptyTaskCenter = JSON.parse(readFileSync(join(fx.destination, 'xianyu-task-center.json'), 'utf8'))
  assert.equal(recoveredEmptyTaskCenter.activeCollectionId, 'legacy-task-collection', 'empty task-center target is repopulated from source')
  assert.equal(recoveredEmptyTaskCenter.collections[0].tasks.length, 1)

  // An operator may already have imported a newer and richer task list into
  // the seller-pilot directory. A later install must not replace it with the
  // older source store just because migration runs again.
  writeJson(join(fx.destination, 'xianyu-task-center.json'), {
    activeCollectionId: 'destination-task-collection',
    collections: [{
      id: 'destination-task-collection',
      name: '新版任务清单',
      importedAt: '2026-08-24T02:00:00.000Z',
      rowCount: 2,
      tasks: [
        { id: 'destination-task-a', name: '新版任务 A', enabled: true },
        { id: 'destination-task-b', name: '新版任务 B', enabled: true }
      ]
    }],
    settings: { dailyEnabled: true, dailyTime: '03:00' },
    runs: [
      { id: 'destination-run-a', collectionId: 'destination-task-collection', status: 'done', startedAt: '2026-08-24T03:00:00.000Z', finishedAt: '2026-08-24T03:01:00.000Z' },
      { id: 'destination-run-b', collectionId: 'destination-task-collection', status: 'done', startedAt: '2026-08-24T04:00:00.000Z', finishedAt: '2026-08-24T04:01:00.000Z' }
    ],
    runResults: [{ id: 'destination-result', taskId: 'destination-task-a', runId: 'destination-run-a', status: 'success', at: '2026-08-24T03:01:00.000Z' }],
    lastImport: { sourceFile: 'new-tasks.xlsx', rowCount: 2, at: '2026-08-24T02:00:00.000Z' }
  })
  runMigration(['apply', ...common, '--writer-pid-file', pidFile, '--report', fx.report])
  const preservedTaskCenter = JSON.parse(readFileSync(join(fx.destination, 'xianyu-task-center.json'), 'utf8'))
  assert.equal(preservedTaskCenter.activeCollectionId, 'destination-task-collection', 'newer task-center collection is not replaced by an old source')
  assert.equal(preservedTaskCenter.collections[0].tasks.length, 2, 'richer destination task list is preserved')
  assert.equal(preservedTaskCenter.runs[0].id, 'destination-run-a', 'destination task-center history is preserved')

  // A release upgrade re-runs migration against the existing seller-pilot
  // directory. Operator-owned throttle settings must survive legacy-source
  // reconciliation instead of reverting to the source app defaults.
  writeJson(join(fx.destination, 'xianyu-seller-crawl.json'), {
    settings: { pageWaitMs: 1200, throttleMinMs: 15000, throttleMaxMs: 15000 },
    scheduleState: { lastCycleKey: 'cycle-operator-owned' },
    job: { running: true, runId: 'operator-run', cycleKey: 'cycle-operator-owned', recoveryPending: false }
  })
  runMigration(['apply', ...common, '--writer-pid-file', pidFile, '--report', fx.report])
  const reapplied = JSON.parse(readFileSync(fx.report, 'utf8'))
  assert.notEqual(reapplied.destination.sha256, firstHash, 'operator settings are part of the upgraded destination evidence')
  const preservedMeta = JSON.parse(readFileSync(join(fx.destination, 'xianyu-seller-crawl.json'), 'utf8'))
  assert.equal(preservedMeta.settings.pageWaitMs, 1200, 'upgrade preserves operator page wait')
  assert.equal(preservedMeta.settings.throttleMinMs, 15000, 'upgrade preserves operator minimum throttle')
  assert.equal(preservedMeta.settings.throttleMaxMs, 15000, 'upgrade preserves operator maximum throttle')
  assert.equal(preservedMeta.scheduleState.lastCycleKey, 'cycle-operator-owned', 'upgrade preserves schedule evidence')
  assert.equal(preservedMeta.job.running, true, 'upgrade preserves an in-flight seller job marker for startup recovery')
  assert.equal(preservedMeta.job.runId, 'operator-run', 'upgrade preserves the in-flight run identity')
  writeJson(join(fx.destination, 'xianyu-electron.json'), {
    accounts: [{ id: 'account-a', name: '账号 A', partition: 'persist:xianyu-account-a', enabled: true, browserProvider: 'adspower', adsPowerId: 'profile-destination' }]
  })
  runMigration(['apply', ...common, '--writer-pid-file', pidFile, '--report', fx.report])
  const rebound = JSON.parse(readFileSync(fx.report, 'utf8'))
  const preservedRuntime = JSON.parse(readFileSync(join(fx.destination, 'xianyu-electron.json'), 'utf8'))
  assert.equal(preservedRuntime.accounts[0].adsPowerId, 'profile-destination', 'upgrade preserves the destination AdsPower binding')
  runMigration(['apply', ...common, '--writer-pid-file', pidFile, '--report', fx.report])
  const stableReapply = JSON.parse(readFileSync(fx.report, 'utf8'))
  assert.equal(stableReapply.destination.sha256, rebound.destination.sha256, 'a second upgrade is idempotent after preserving operator settings')
  runMigration(['verify', ...common, '--report', fx.report])
  assert(readdirSync(fx.backupRoot).length >= 2)
}

if (process.argv.includes('--prepare-gui')) {
  runGuiPrepare()
} else if (process.argv.includes('--cleanup')) {
  runGuiCleanup()
} else if (process.argv.includes('--migration')) {
  testMigration()
  console.log('seller install recovery regression: migration PASS')
} else if (process.argv.includes('--install-sandbox')) {
  assert(existsSync(migrationScript), 'migration script must exist before install sandbox runs')
  const installer = join(projectRoot, 'scripts/release/install-seller-pilot.sh')
  const rollback = join(projectRoot, 'scripts/release/rollback-seller-pilot.sh')
  assert(existsSync(installer) && existsSync(rollback), 'install and rollback scripts must exist')
  const sandbox = mkdtempSync(join(tmpdir(), 'seller-pilot-install-'))
  const applications = join(sandbox, 'Applications')
  const support = join(sandbox, 'Application Support')
  const agents = join(sandbox, 'LaunchAgents')
  for (const appName of ['闲鱼行情爬虫.app', '闲鱼行情工作台.app']) {
    const app = join(applications, appName)
    mkdirSync(app, { recursive: true })
    writeFileSync(join(app, 'identity.txt'), appName)
  }
  const source = join(support, 'xianyu-electron')
  mkdirSync(source, { recursive: true })
  writeJson(join(source, 'seller-checkpoint-v3.json'), { schemaVersion: 3, persistedAt: '2026-08-22T00:00:00.000Z', records: [{ id: 'sandbox-seller', sellerId: 'sandbox-seller', status: 'incomplete', itemIds: { active: ['one'], sold: [] } }] })
  const env = {
    ...process.env,
    SELLER_PILOT_SANDBOX_ROOT: sandbox,
    SELLER_PILOT_APPLICATIONS_ROOT: applications,
    SELLER_PILOT_SUPPORT_ROOT: support,
    SELLER_PILOT_LAUNCH_AGENTS_ROOT: agents
  }
  const manifestFlagIndex = process.argv.indexOf('--candidate-manifest')
  const manifest = manifestFlagIndex >= 0 ? process.argv[manifestFlagIndex + 1] : null
  assert(manifest && !manifest.startsWith('--'), '--candidate-manifest is required for install sandbox')
  const escapedApplications = `${sandbox}-escaped-applications`
  const escaped = spawnSync(installer, ['--sandbox', '--manifest', manifest], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...env, SELLER_PILOT_APPLICATIONS_ROOT: escapedApplications }
  })
  assert.notEqual(escaped.status, 0, 'sandbox installer must reject roots outside its sandbox')
  assert.match(escaped.stderr, /escapes SELLER_PILOT_SANDBOX_ROOT/)
  assert.equal(existsSync(join(escapedApplications, '闲鱼卖家巡航台.app')), false, 'sandbox boundary refusal must be write-free')

  const tamperedManifest = join(sandbox, 'tampered-candidate-manifest.json')
  const tampered = JSON.parse(readFileSync(manifest, 'utf8'))
  tampered.components.bundle.sha256 = '0'.repeat(64)
  writeJson(tamperedManifest, tampered)
  const failedCopy = spawnSync(installer, ['--sandbox', '--manifest', tamperedManifest], { cwd: projectRoot, encoding: 'utf8', env })
  assert.notEqual(failedCopy.status, 0, 'installer must reject a candidate whose full-bundle hash changed')
  assert.equal(existsSync(join(applications, '闲鱼卖家巡航台.app')), false, 'failed post-copy verification must clean only the new target')
  assert.equal(existsSync(join(agents, 'com.erp.xianyu.sellerpilot.autostart.plist')), false, 'failed verification must not leave a LaunchAgent')

  const result = spawnSync(installer, ['--sandbox', '--manifest', manifest], { cwd: projectRoot, encoding: 'utf8', env })
  assert.equal(result.status, 0, `sandbox installer failed\n${result.stdout}\n${result.stderr}`)
  const target = join(applications, '闲鱼卖家巡航台.app')
  const userData = join(support, '闲鱼卖家巡航台')
  const backupRoot = join(support, '闲鱼卖家巡航台 Migration Backups')
  const plist = join(agents, 'com.erp.xianyu.sellerpilot.autostart.plist')
  assert(existsSync(target) && existsSync(userData) && existsSync(backupRoot) && existsSync(plist))
  const installState = JSON.parse(readFileSync(join(userData, '.seller-pilot-install-state.json'), 'utf8'))
  assert.equal(installState.schemaVersion, 2)
  assert.match(installState.bundleSha256, /^[0-9a-f]{64}$/)
  assert.equal(existsSync(join(userData, 'migration-backups')), false, 'migration backups must never recursively enter seller-pilot userData')
  assert(existsSync(join(applications, '闲鱼行情爬虫.app/identity.txt')))
  assert(existsSync(join(applications, '闲鱼行情工作台.app/identity.txt')))
  const verifier = join(projectRoot, 'scripts/test/verify-seller-release.mjs')
  const installedVerification = spawnSync(process.execPath, [verifier, '--candidate-manifest', manifest, '--installed', target], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...env, SELLER_PILOT_VERIFY_SANDBOX_ROOT: sandbox }
  })
  assert.equal(installedVerification.status, 0, `installed verification failed\n${installedVerification.stdout}\n${installedVerification.stderr}`)
  assert.equal(JSON.parse(installedVerification.stdout).mode, 'installed')
  const refused = spawnSync(installer, ['--sandbox', '--manifest', manifest], { cwd: projectRoot, encoding: 'utf8', env })
  assert.notEqual(refused.status, 0, 'installer must refuse a pre-existing target')
  const plistBuddy = '/usr/libexec/PlistBuddy'
  assert.equal(spawnSync(plistBuddy, ['-c', 'Set :Label com.example.tampered', plist]).status, 0)
  const unsafeRollback = spawnSync(rollback, ['--sandbox'], { cwd: projectRoot, encoding: 'utf8', env })
  assert.notEqual(unsafeRollback.status, 0, 'rollback must refuse a LaunchAgent not owned by its install state')
  assert(existsSync(target), 'refused rollback must preserve the installed app')
  assert.equal(spawnSync(plistBuddy, ['-c', 'Set :Label com.erp.xianyu.sellerpilot.autostart', plist]).status, 0)
  const rolledBack = spawnSync(rollback, ['--sandbox'], { cwd: projectRoot, encoding: 'utf8', env })
  assert.equal(rolledBack.status, 0, `sandbox rollback failed\n${rolledBack.stdout}\n${rolledBack.stderr}`)
  assert.equal(existsSync(target), false, 'rollback must remove only the new app')
  assert.equal(existsSync(plist), false, 'rollback must remove only the new launch registration')
  assert.equal(existsSync(userData), true, 'rollback must preserve seller-pilot userData')
  assert(existsSync(join(applications, '闲鱼行情爬虫.app/identity.txt')))
  assert(existsSync(join(applications, '闲鱼行情工作台.app/identity.txt')))
  console.log('seller install recovery regression: install sandbox PASS')
} else {
  testMigration()
  console.log('seller install recovery regression: PASS')
}

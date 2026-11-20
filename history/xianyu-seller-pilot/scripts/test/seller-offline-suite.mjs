#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const supportedArgs = new Set(['--require-canonical-manifest'])
const unknownArgs = process.argv.slice(2).filter((arg) => !supportedArgs.has(arg))
if (unknownArgs.length) {
  process.stderr.write(`unsupported seller offline suite argument: ${unknownArgs.join(', ')}\n`)
  process.exit(2)
}

const requireCanonicalManifest = process.argv.includes('--require-canonical-manifest')

function verifySellerKeywordBoundary() {
  const mainDir = join(testDir, '../../src/main')
  const sellerFiles = [
    'seller-goofish.js',
    'seller-schedule.js',
    'seller-scheduler.js',
    'seller-state-machine.js',
    'seller-store.js',
    'seller-worker.js'
  ]
  const sellerSource = sellerFiles
    .map((file) => `/* ${file} */\n${readFileSync(join(mainDir, file), 'utf8')}`)
    .join('\n')
  const keywordScheduler = readFileSync(join(mainDir, 'scheduler.js'), 'utf8')
  const taskStore = readFileSync(join(mainDir, 'task-store.js'), 'utf8')

  const forbiddenSellerDependencies = [
    ['keyword scheduler import', /from\s+['"]\.\/scheduler\.js['"]/],
    ['legacy keyword task-store import', /from\s+['"]\.\/task-store\.js['"]/],
    ['keyword crawl route', /\bcrawlOne\s*\(/],
    ['snapshot capture API', /\bcaptureHtmlSnapshot\s*\(/],
    ['legacy result writer', /\b(?:taskStore\.)?recordRunResult\s*\(/],
    ['legacy aggregate writer', /\baddResult\s*\(/],
    ['keyword price-composition detail fields', /\bpriceBreakdown\b/]
  ]
  for (const [label, pattern] of forbiddenSellerDependencies) {
    if (pattern.test(sellerSource)) throw new Error(`seller boundary violation: ${label}`)
  }

  const requiredKeywordContracts = [
    ['keyword crawl route', keywordScheduler, /\bcrawlOne\s*\(/],
    ['keyword snapshot capture', keywordScheduler, /\bcaptureHtmlSnapshot\s*\(/],
    ['legacy keyword result writer', keywordScheduler, /\baddResult\s*\(/],
    ['legacy task-store run writer', keywordScheduler, /taskStore\.recordRunResult\s*\(/],
    ['task-store snapshot persistence', taskStore, /snapshotPath:\s*result\.snapshotPath\s*\|\|\s*[^,]+/],
    ['task-store price composition persistence', taskStore, /priceBreakdown:\s*result\.priceBreakdown\s*\|\|\s*null/]
  ]
  for (const [label, source, pattern] of requiredKeywordContracts) {
    if (!pattern.test(source)) throw new Error(`keyword contract missing: ${label}`)
  }

  return `seller modules remain isolated from keyword crawl, legacy writes, and snapshot/detail APIs (${sellerFiles.length} modules checked)`
}

const gates = [
  { id: 'state', file: 'seller-state-machine-regression.mjs' },
  { id: 'schedule', file: 'seller-schedule-regression.mjs' },
  { id: 'recovery', file: 'seller-store-recovery-regression.mjs' },
  { id: 'risk_recovery', file: 'seller-risk-recovery-regression.mjs' },
  { id: 'worker', file: 'seller-worker-isolation-regression.mjs' },
  { id: 'session_reuse', file: 'seller-session-reuse-regression.mjs' },
  { id: 'scheduler_integration', file: 'seller-scheduler-integration-regression.mjs' },
  { id: 'ipc_export', file: 'seller-ipc-contract-regression.mjs' },
  { id: 'validation_contract', file: 'seller-validation-contract-regression.mjs' },
  { id: 'migration_recovery', file: 'seller-install-recovery-regression.mjs', args: ['--migration'] },
  { id: 'source_metadata', file: 'seller-source-metadata-regression.mjs' },
  { id: 'source_enrichment', file: 'seller-source-enrichment-regression.mjs' },
  { id: 'source_mode', file: 'seller-source-mode-migration-regression.mjs' },
  { id: 'seller_evidence', file: 'seller-evidence-regression.mjs' },
  { id: 'seller_status_groups', file: 'seller-status-groups-regression.mjs' },
  { id: 'seller_keyword_boundary', file: 'semantic boundary (aggregate)', run: verifySellerKeywordBoundary },
  { id: 'keyword_price', file: 'goofish-price-regression.mjs' },
  { id: 'canonical_index', file: 'seller-index-regression.mjs', args: requireCanonicalManifest ? ['--require-canonical-manifest'] : [] },
  { id: 'root_runtime', file: 'seller-rpa-runtime-harness.js' },
  { id: 'root_source_contract', file: 'verify-seller-rpa-only.js' },
  { id: 'release_config', file: 'verify-seller-release.mjs', args: ['--config-only', 'electron-builder.seller-pilot.yml'] },
  { id: 'build', command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['run', 'build'] }
]

const startedAt = new Date().toISOString()
const results = []
for (const gate of gates) {
  const gateStarted = Date.now()
  let execution
  if (gate.run) {
    try {
      execution = { status: 0, stdout: gate.run(), stderr: '' }
    } catch (error) {
      execution = { status: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
    }
  } else {
    const command = gate.command || process.execPath
    const args = gate.command ? (gate.args || []) : [join(testDir, gate.file), ...(gate.args || [])]
    execution = spawnSync(command, args, {
      cwd: join(testDir, '../..'),
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 20 * 1024 * 1024
    })
  }
  const stdoutLines = String(execution.stdout || '').trim().split('\n').filter(Boolean)
  const stderrLines = String(execution.stderr || '').trim().split('\n').filter(Boolean)
  const result = {
    id: gate.id,
    file: gate.file,
    ok: execution.status === 0,
    exitCode: execution.status ?? 1,
    durationMs: Date.now() - gateStarted,
    evidence: stdoutLines.at(-1) || null,
    error: execution.status === 0 ? null : (stderrLines.slice(-8).join('\n') || execution.error?.message || 'offline gate failed')
  }
  results.push(result)
  if (!result.ok) break
}

const summary = {
  schemaVersion: 1,
  suite: 'seller-offline',
  deliveryGate: 'deterministic-offline',
  sandboxCandidateGate: 'separate-not-run',
  ok: results.length === gates.length && results.every((result) => result.ok),
  requireCanonicalManifest,
  livePlatformEvidence: 'not-run',
  startedAt,
  finishedAt: new Date().toISOString(),
  gates: results,
  totals: {
    planned: gates.length,
    executed: results.length,
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length
  }
}

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
if (!summary.ok) process.exit(1)

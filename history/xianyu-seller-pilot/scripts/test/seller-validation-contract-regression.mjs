#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const projectDir = join(testDir, '../..')
const cli = join(testDir, 'real-seller-run.mjs')
const report = 'docs/test-reports/phase-01-real-runs.md'

function invoke(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, FORCE_COLOR: '0' }
  })
  assert.equal(result.error?.code, undefined, `CLI process failed to start or timed out: ${result.error?.message}`)
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
}

const help = invoke(['--help'])
assert.equal(help.status, 0)
assert.match(help.stdout, /maximum 20/)
assert.match(help.stdout, /never opens Electron or Goofish/)

const manifest = invoke(['--validate-manifests'])
assert.equal(manifest.status, 0, manifest.stderr)
assert.match(manifest.stdout, /PASS \(offline; no platform navigation\)/)

const reportResult = invoke(['--validate-report', report])
assert.equal(reportResult.status, 0, reportResult.stderr)

const missingSmoke = invoke(['--validate-report', report, '--require-smoke'])
assert.equal(missingSmoke.status, 1)
assert.match(missingSmoke.stderr, /technical smoke evidence is not passed/)

const legacyGate = invoke(['--require-observation', '154'])
assert.equal(legacyGate.status, 2)
assert.match(legacyGate.stderr, /historical 154-seller business benchmark is not an active validation path/)

const removedOptional154 = invoke(['--include-optional-154'])
assert.equal(removedOptional154.status, 2)
assert.match(removedOptional154.stderr, /not an active validation path/)

const unknown = invoke(['--definitely-unknown'])
assert.equal(unknown.status, 2)
assert.match(unknown.stderr, /unknown option/)

for (const result of [help, manifest, reportResult, missingSmoke, legacyGate, removedOptional154, unknown]) {
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /cookie|password|authorization/i)
}

process.stdout.write('seller validation CLI regression: PASS (offline; no platform navigation)\n')

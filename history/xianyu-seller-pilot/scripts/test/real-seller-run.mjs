#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectDir = resolve(here, '../..')
const fixtureDir = join(here, 'fixtures')
const canonicalPath = join(projectDir, 'resources/seller-index/canonical-sellers.manifest.json')
const canaryPath = join(fixtureDir, 'seller-canary-20.json')
const reportSchemaPath = join(fixtureDir, 'seller-run-report.schema.json')

const HELP = `Usage: node scripts/test/real-seller-run.mjs [options]

Offline/default gates (never navigate the platform):
  --validate-manifests              Validate the frozen 20-seller smoke fixture
  --validate-report <path>          Validate a machine-readable evidence report
  --require-smoke                   Require a passed technical smoke run (maximum 20)

Explicit optional operational evidence (not a release requirement):
  --optional-require-two-account    Require passed two-account evidence

Fixture maintenance:
  --freeze-manifests                Rebuild the deterministic 20-seller fixture
  --help                            Show this help

This command only validates fixtures/reports. It never opens Electron or Goofish.`

function fail(message, code = 1) {
  const error = new Error(message)
  error.exitCode = code
  throw error
}

function parseArgs(argv) {
  const flags = new Set()
  const values = new Map()
  const valueOptions = new Set(['--validate-report'])
  const booleanOptions = new Set([
    '--validate-manifests', '--require-smoke', '--optional-require-two-account',
    '--freeze-manifests', '--help'
  ])
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (valueOptions.has(arg)) {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) fail(`${arg} requires a file path`, 2)
      if (values.has(arg)) fail(`${arg} may only be specified once`, 2)
      values.set(arg, value)
      index += 1
    } else if (booleanOptions.has(arg)) {
      if (flags.has(arg)) fail(`${arg} may only be specified once`, 2)
      flags.add(arg)
    } else if (arg === '--require-observation' || arg === '--optional-require-observation' || arg === '--include-optional-154') {
      fail(`${arg} was removed; the historical 154-seller business benchmark is not an active validation path`, 2)
    } else if (arg === '--require-two-account') {
      fail(`${arg} was removed from the delivery gate; use --optional-require-two-account explicitly`, 2)
    } else {
      fail(`unknown option: ${arg}\n\n${HELP}`, 2)
    }
  }
  const evidenceFlag = flags.has('--require-smoke') || flags.has('--optional-require-two-account')
  if (evidenceFlag && !values.has('--validate-report')) fail('evidence requirement flags require --validate-report <path>', 2)
  return { flags, values }
}

function readJson(path, label = path) {
  let source
  try { source = readFileSync(path, 'utf8') } catch (error) { fail(`cannot read ${label}: ${error.message}`) }
  try { return JSON.parse(source) } catch (error) { fail(`invalid JSON in ${label}: ${error.message}`) }
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const sellerIdsHash = (ids) => sha256(ids.join('\n'))

function assertExactKeys(value, keys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} contains unknown or missing fields`)
}

function assertIsoDate(value, label) {
  assert.equal(typeof value, 'string', `${label} must be an ISO timestamp`)
  assert(!Number.isNaN(Date.parse(value)), `${label} must be an ISO timestamp`)
}

function assertAllowedSeller(seller) {
  assertExactKeys(seller, ['id', 'url'], 'seller')
  assert.match(seller.id, /^\d+$/, `invalid seller ID: ${seller.id}`)
  const url = new URL(seller.url)
  assert.equal(url.protocol, 'https:', 'seller URL must use HTTPS')
  assert.equal(url.hostname, 'www.goofish.com', 'seller URL host is not approved')
  assert.equal(url.pathname, '/personal', 'seller URL must be a seller homepage')
  assert.equal(url.searchParams.get('userId'), seller.id, 'seller URL userId mismatch')
  assert.equal([...url.searchParams.keys()].length, 1, 'seller URL has unexpected parameters')
}

function readCanonical() {
  const source = readJson(canonicalPath, 'canonical seller manifest')
  assert.equal(source.count, 9977, 'canonical source must contain 9,977 sellers')
  assert.equal(source.sellerIds.length, source.count, 'canonical seller count mismatch')
  assert.deepEqual([...source.sellerIds].sort((a, b) => a.localeCompare(b)), source.sellerIds, 'canonical IDs must be sorted')
  assert.equal(new Set(source.sellerIds).size, source.count, 'canonical IDs must be unique')
  assert.equal(sellerIdsHash(source.sellerIds), source.sha256, 'canonical source hash mismatch')
  return source
}

function createFrozenManifest(kind, ids, source) {
  return {
    schemaVersion: 1,
    kind,
    // Fixture generation is byte-for-byte reproducible for the same canonical source.
    frozenAt: '2026-08-23T02:30:00.000+08:00',
    count: ids.length,
    source: { file: 'resources/seller-index/canonical-sellers.manifest.json', count: source.count, sha256: source.sha256 },
    hashAlgorithm: 'sha256(sortedSellerIdsJoinedByNewline)',
    manifestHash: sellerIdsHash(ids),
    sellers: ids.map((id) => ({ id, url: `https://www.goofish.com/personal?userId=${id}` }))
  }
}

function freezeManifests() {
  const source = readCanonical()
  const canary = createFrozenManifest('canary20', source.sellerIds.slice(0, 20), source)
  writeFileSync(canaryPath, `${JSON.stringify(canary, null, 2)}\n`, { mode: 0o644 })
  process.stdout.write(`frozen fixture: smoke20=${canary.manifestHash}\n`)
}

function validateManifest(path, expectedKind, expectedCount) {
  const manifest = readJson(path, `${expectedKind} fixture`)
  assertExactKeys(manifest, ['count', 'frozenAt', 'hashAlgorithm', 'kind', 'manifestHash', 'schemaVersion', 'sellers', 'source'], `${expectedKind} fixture`)
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.kind, expectedKind)
  assert.equal(manifest.count, expectedCount)
  assert.equal(manifest.hashAlgorithm, 'sha256(sortedSellerIdsJoinedByNewline)')
  assertIsoDate(manifest.frozenAt, `${expectedKind}.frozenAt`)
  assert(Array.isArray(manifest.sellers), `${expectedKind}.sellers must be an array`)
  assert.equal(manifest.sellers.length, expectedCount)
  const ids = manifest.sellers.map((seller) => String(seller.id).trim())
  assert.equal(new Set(ids).size, ids.length, `${expectedKind} contains duplicate seller IDs`)
  assert.deepEqual([...ids].sort((a, b) => a.localeCompare(b)), ids, `${expectedKind} IDs are not sorted`)
  manifest.sellers.forEach(assertAllowedSeller)
  assert.equal(manifest.manifestHash, sellerIdsHash(ids), `${expectedKind} hash mismatch`)
  const canonical = readCanonical()
  assert.deepEqual(manifest.source, { file: 'resources/seller-index/canonical-sellers.manifest.json', count: canonical.count, sha256: canonical.sha256 }, `${expectedKind} source anchor mismatch`)
  return manifest
}

function validateManifests() {
  const canary = validateManifest(canaryPath, 'canary20', 20)
  return { canary }
}

function parseReport(path) {
  let markdown
  try { markdown = readFileSync(path, 'utf8') } catch (error) { fail(`cannot read report: ${error.message}`) }
  const blocks = [...markdown.matchAll(/<!-- SELLER_RUN_REPORT_JSON_START -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- SELLER_RUN_REPORT_JSON_END -->/g)]
  assert.equal(blocks.length, 1, 'report must contain exactly one machine-readable JSON evidence block')
  try { return JSON.parse(blocks[0][1]) } catch (error) { fail(`invalid report JSON: ${error.message}`) }
}

function validateRun(run, manifest, label) {
  assertExactKeys(run, ['accountRefs', 'durationMs', 'endedAt', 'id', 'manifestFile', 'manifestHash', 'maxSellers', 'startedAt', 'status', 'summary', 'trigger'], label)
  assert.match(run.id, /^[a-z0-9][a-z0-9._-]{0,79}$/i, `${label}.id is invalid`)
  assert(['not-run', 'passed', 'failed', 'aborted'].includes(run.status), `${label}.status is invalid`)
  assert(Number.isInteger(run.maxSellers) && run.maxSellers >= 1, `${label}.maxSellers must be positive`)
  assert(Array.isArray(run.accountRefs), `${label}.accountRefs must be an array`)
  assert(run.accountRefs.every((value) => /^acct_[a-f0-9]{12}$/.test(value)), `${label}.accountRefs must be pseudonymous`)
  assert.equal(new Set(run.accountRefs).size, run.accountRefs.length, `${label}.accountRefs must be unique`)
  assert(run.summary && typeof run.summary === 'object' && !Array.isArray(run.summary), `${label}.summary must be an object`)
  if (run.status === 'not-run') {
    assert.equal(run.startedAt, null); assert.equal(run.endedAt, null); assert.equal(run.durationMs, null)
  } else {
    assertIsoDate(run.startedAt, `${label}.startedAt`); assertIsoDate(run.endedAt, `${label}.endedAt`)
    assert(Number.isInteger(run.durationMs) && run.durationMs >= 0, `${label}.durationMs must be non-negative`)
    assert(Date.parse(run.endedAt) >= Date.parse(run.startedAt), `${label} ends before it starts`)
  }
  if (manifest) {
    assert.equal(run.manifestHash, manifest.manifestHash, `${label} manifest hash drifted`)
    assert.equal(run.maxSellers, manifest.count, `${label} seller limit differs from fixture`)
  }
}

function validateReport(path) {
  const schema = readJson(reportSchemaPath, 'seller run report schema')
  assert.equal(schema.additionalProperties, false, 'report schema must reject unknown fields')
  assert.equal(schema.properties?.schemaVersion?.const, 2, 'report schema version mismatch')
  const report = parseReport(path)
  assertExactKeys(report, ['delivery', 'generatedAt', 'notes', 'optionalEvidence', 'schemaVersion', 'technicalSmoke'], 'report')
  assert.equal(report.schemaVersion, 2); assertIsoDate(report.generatedAt, 'report.generatedAt')
  assertExactKeys(report.delivery, ['blockers', 'offlineVerification', 'status'], 'delivery')
  assert(['ready', 'blocked'].includes(report.delivery.status)); assert(['passed', 'failed'].includes(report.delivery.offlineVerification))
  assert(Array.isArray(report.delivery.blockers) && report.delivery.blockers.every((item) => typeof item === 'string' && item.trim()), 'delivery.blockers must be readable strings')
  if (report.delivery.status === 'ready') {
    assert.equal(report.delivery.offlineVerification, 'passed', 'ready delivery requires passed offline verification')
    assert.equal(report.delivery.blockers.length, 0, 'ready delivery cannot contain blockers')
  }
  const canary = validateManifest(canaryPath, 'canary20', 20)
  validateRun(report.technicalSmoke, canary, 'technicalSmoke')
  assert(report.technicalSmoke.maxSellers <= 20, 'technical smoke may never exceed 20 sellers')
  assertExactKeys(report.optionalEvidence, ['twoAccount'], 'optionalEvidence')
  validateRun(report.optionalEvidence.twoAccount, null, 'optionalEvidence.twoAccount')
  assert(report.optionalEvidence.twoAccount.maxSellers <= 20, 'optional two-account evidence is capped at 20 sellers')
  assert(Array.isArray(report.notes) && report.notes.every((item) => typeof item === 'string' && item.trim()), 'notes must be readable strings')
  const serialized = JSON.stringify(report)
  assert.doesNotMatch(serialized, /cookie|token|password|secret|authorization/i, 'report contains a forbidden secret-field name')
  assert.doesNotMatch(serialized, /https?:\/\//i, 'report must not embed navigated URLs')
  return report
}

function run(argv) {
  const { flags, values } = parseArgs(argv)
  if (flags.has('--help')) { process.stdout.write(`${HELP}\n`); return }
  if (!argv.length) fail(`no operation selected\n\n${HELP}`, 2)
  if (flags.has('--freeze-manifests')) freezeManifests()
  if (flags.has('--validate-manifests')) validateManifests()
  const report = values.has('--validate-report') ? validateReport(resolve(projectDir, values.get('--validate-report'))) : null
  if (flags.has('--require-smoke')) assert.equal(report.technicalSmoke.status, 'passed', '20-seller technical smoke evidence is not passed')
  if (flags.has('--optional-require-two-account')) {
    assert.equal(report.optionalEvidence.twoAccount.status, 'passed', 'optional two-account evidence is not passed')
    assert.equal(report.optionalEvidence.twoAccount.accountRefs.length, 2, 'optional two-account evidence needs two distinct pseudonymous account references')
  }
  process.stdout.write('seller validation contract: PASS (offline; no platform navigation)\n')
}

try { run(process.argv.slice(2)) } catch (error) {
  process.stderr.write(`seller validation contract: FAIL\n${error.message}\n`)
  process.exitCode = Number.isInteger(error.exitCode) ? error.exitCode : 1
}

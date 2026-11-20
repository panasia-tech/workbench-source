#!/usr/bin/env node

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const currentFile = fileURLToPath(import.meta.url)
const repoRoot = path.resolve(path.dirname(currentFile), '../..')
const checker = path.resolve(path.dirname(currentFile), 'market-spu-contract-check.mjs')
const fixturePath = path.resolve(path.dirname(currentFile), 'market-spu-contract-fixture.json')
const pendingPath = path.resolve(repoRoot, '.planning/phases/01.2-api-spu/01.2-CONTRACT.md')

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'market-spu-contract-'))
}

function cloneFixture(directory, mutate = () => {}) {
  const contract = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
  mutate(contract)
  const destination = path.join(directory, 'contract.json')
  fs.writeFileSync(destination, `${JSON.stringify(contract, null, 2)}\n`, 'utf8')
  return destination
}

function runChecker(contractPath, extra = []) {
  const result = spawnSync(process.execPath, [checker, '--contract', contractPath, '--expected-version', '1', '--reject-pending', '--reject-tbd', ...extra], {
    encoding: 'utf8',
  })
  let payload
  try {
    payload = JSON.parse(result.stdout.trim())
  } catch (error) {
    throw new Error(`checker did not emit JSON: ${result.stdout}\n${result.stderr}\n${error.message}`)
  }
  return { ...result, payload }
}

function assertError(result, code, fieldPath) {
  assert.notEqual(result.status, 0, `expected checker failure for ${code}`)
  assert.ok(result.payload.errors.some((error) => error.code === code && (!fieldPath || error.path === fieldPath)), `${code}/${fieldPath || '*'} not found in ${JSON.stringify(result.payload.errors)}`)
}

const directory = tempDir()
try {
  // Complete confirmed JSON fixture is accepted and deterministic.
  const validPath = cloneFixture(directory)
  const jsonOut = path.join(directory, 'valid-output.json')
  const valid = runChecker(validPath, ['--require-confirmed', '--require-value', 'rollback_policy=NO_DOWNGRADE_AFTER_EVIDENCE', '--print-hash', '--json-out', jsonOut])
  assert.equal(valid.status, 0)
  assert.equal(valid.payload.ok, true)
  assert.equal(valid.payload.contract_version, 1)
  assert.equal(valid.payload.status, 'CONFIRMED')
  assert.match(valid.payload.sha256, /^[0-9a-f]{64}$/)
  assert.deepEqual(JSON.parse(fs.readFileSync(jsonOut, 'utf8')), valid.payload)
  const rawFixture = fs.readFileSync(validPath)
  assert.equal(valid.payload.sha256, crypto.createHash('sha256').update(rawFixture).digest('hex'))
  const validAgain = runChecker(validPath, ['--require-confirmed', '--print-hash'])
  assert.equal(validAgain.stdout, valid.stdout)

  // Missing and empty nested paths are distinct, named validation failures.
  assertError(runChecker(cloneFixture(directory, (contract) => { delete contract.schedule.interval })), 'MISSING_FIELD', 'schedule.interval')
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.schedule.interval = null })), 'EMPTY_FIELD', 'schedule.interval')

  // Pending/TBD are rejected recursively, even if the status itself says CONFIRMED.
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.risk_pause_resume = 'PENDING_HUMAN_CONFIRMATION' })), 'UNRESOLVED_VALUE', 'risk_pause_resume')
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.evidence_backup_policy = 'TBD' })), 'UNRESOLVED_VALUE', 'evidence_backup_policy')
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.schedule = { startup_trigger: 'PENDING' } })), 'UNRESOLVED_VALUE', 'schedule.startup_trigger')

  // Enum, scalar/object shape, duration, timezone, timestamp, and number errors.
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.ordinary_success_policy = 'MANUAL' })), 'INVALID_ENUM', 'ordinary_success_policy')
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.out_of_stock_policy = 'DELETE' })), 'INVALID_ENUM', 'out_of_stock_policy')
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.rollback_policy = 'DOWNGRADE' })), 'INVALID_ENUM', 'rollback_policy')
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.schedule = '6h' })), 'INVALID_TYPE', 'schedule')
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.retry_policy = [] })), 'INVALID_TYPE', 'retry_policy')
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.schedule.interval = '0m' })), 'INVALID_DURATION', 'schedule.interval')
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.schedule.timezone = 'Mars/Olympus' })), 'INVALID_TIMEZONE', 'schedule.timezone')
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.confirmed_at = 'not-a-timestamp' })), 'INVALID_TIMESTAMP', 'confirmed_at')
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.concurrency_limit = 0 })), 'INVALID_POSITIVE_INTEGER', 'concurrency_limit')
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.retry_policy.max_attempts = 1.5 })), 'INVALID_POSITIVE_INTEGER', 'retry_policy.max_attempts')
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.writeback_roles = { role: 'ADMIN' } })), 'INVALID_TYPE', 'writeback_roles')
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.price_writeback_policy.mode = 'ALWAYS_250_PERCENT' })), 'INVALID_ENUM', 'price_writeback_policy.mode')
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.price_writeback_policy.candidate_ratio_basis = 'CURRENT_API_PRICE' })), 'INVALID_ENUM', 'price_writeback_policy.candidate_ratio_basis')
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.price_writeback_policy.spread_formula = 'STANDARD_DEVIATION' })), 'INVALID_ENUM', 'price_writeback_policy.spread_formula')
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.price_writeback_policy.rounding_mode = 'FLOOR' })), 'INVALID_ENUM', 'price_writeback_policy.rounding_mode')
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.price_writeback_policy.cost_floor_ratio = 0 })), 'INVALID_POSITIVE_NUMBER', 'price_writeback_policy.cost_floor_ratio')
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.price_writeback_policy.max_spread_ratio = 1.1 })), 'INVALID_RATIO', 'price_writeback_policy.max_spread_ratio')
  assertError(runChecker(cloneFixture(directory, (contract) => { contract.price_writeback_policy.selection_requires_explicit_confirm = false })), 'INVALID_CONFIRMATION', 'price_writeback_policy.selection_requires_explicit_confirm')

  // CLI gates are explicit and must fail without modifying the submitted file.
  const pendingBefore = fs.readFileSync(pendingPath)
  const pendingJsonOut = path.join(directory, 'pending-output.json')
  const pending = runChecker(pendingPath, ['--require-confirmed', '--print-hash', '--json-out', pendingJsonOut])
  assertError(pending, 'REQUIRE_CONFIRMED', 'status')
  assert.deepEqual(fs.readFileSync(pendingPath), pendingBefore)
  assert.equal(fs.existsSync(pendingJsonOut), true)

  assertError(runChecker(validPath, ['--require-confirmed', '--expected-version', '2']), 'VERSION_MISMATCH', 'contract_version')
  assertError(runChecker(validPath, ['--require-confirmed', '--require-value', 'rollback_policy=OTHER']), 'REQUIRE_VALUE_MISMATCH', 'rollback_policy')

  console.log('market SPU contract checker tests: passed (frontmatter/JSON validation, pending gate, version/hash evidence)')
} finally {
  fs.rmSync(directory, { recursive: true, force: true })
}

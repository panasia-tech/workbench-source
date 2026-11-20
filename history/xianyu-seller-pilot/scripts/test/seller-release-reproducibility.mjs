#!/usr/bin/env node

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const repositoryRoot = path.resolve(packageRoot, '..')
const verifier = path.join(packageRoot, 'scripts/test/verify-seller-release.mjs')
const canonical = path.join(packageRoot, 'release-seller-pilot/seller-pilot-release.json')
const requiredChecks = ['startup', 'task-center-rainbow', 'seller-preview-isolation', 'wms-credential-safety', 'rollback-relaunch']

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function invoke(args) {
  return spawnSync(process.execPath, [verifier, ...args], { cwd: repositoryRoot, encoding: 'utf8' })
}

function expectFailure(args, label) {
  const result = invoke(args)
  assert.notEqual(result.status, 0, `${label} must fail`)
  assert(result.stderr.includes('seller release verification failed'), `${label} should print a diagnostic`)
}

function buildReports(root, manifest) {
  const sandboxRoot = path.join(root, 'sandbox')
  const applicationsRoot = path.join(sandboxRoot, 'Applications')
  const supportRoot = path.join(sandboxRoot, 'Application Support')
  const launchAgentsRoot = path.join(sandboxRoot, 'LaunchAgents')
  const userData = path.join(supportRoot, '闲鱼卖家巡航台')
  const bundlePath = path.join(applicationsRoot, '闲鱼卖家巡航台.app')
  const manifestSha256 = sha256File(canonical)
  const bundleSha256 = manifest.components.bundle.sha256
  const asarSha256 = manifest.components.asar.archiveSha256
  const signature = {
    status: manifest.components.codeSignature?.verified ? 'PASS' : 'FAILED',
    identity: manifest.components.codeSignature?.identity || manifest.identity.appId
  }
  const installed = {
    schemaVersion: 1,
    reportKind: 'seller-installed-identity',
    manifestPath: canonical,
    manifestSha256,
    sandboxRoot,
    applicationsRoot,
    supportRoot,
    launchAgentsRoot,
    userData,
    bundlePath,
    bundleSha256,
    asarSha256,
    appId: manifest.identity.appId,
    launchAgentLabel: manifest.identity.launchAgentLabel,
    signature
  }
  const gui = {
    schemaVersion: 1,
    reportKind: 'seller-gui-regression',
    status: 'PASS',
    manifestPath: canonical,
    manifestSha256,
    installed: {
      bundlePath,
      bundleSha256,
      asarSha256,
      appId: installed.appId,
      launchAgentLabel: installed.launchAgentLabel,
      signature
    },
    runner: { name: 'reproducibility-fixture', version: '1' },
    checks: requiredChecks.map((id) => ({ id, status: 'PASS', evidence: [`fixture evidence for ${id}`] }))
  }
  return { installed, gui }
}

function main() {
  const args = process.argv.slice(2)
  const canonicalArg = args.includes('--canonical-manifest') ? args[args.indexOf('--canonical-manifest') + 1] : 'xianyu-electron/release-seller-pilot/seller-pilot-release.json'
  assert.equal(path.resolve(repositoryRoot, canonicalArg), path.resolve(canonical), 'test must use the canonical manifest')
  assert(fs.existsSync(canonical), 'canonical seller-pilot manifest must exist before reproducibility test')
  const manifest = JSON.parse(fs.readFileSync(canonical, 'utf8'))
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seller-release-repro-'))
  const { installed, gui } = buildReports(root, manifest)
  const installedPath = path.join(root, 'installed-identity.json')
  const guiPath = path.join(root, 'gui.json')
  writeJson(installedPath, installed)
  writeJson(guiPath, gui)
  const secondary = path.join(root, 'release')
  const common = ['--report-only', '--candidate-manifest', canonicalArg, '--require-gui-report', guiPath, '--installed-identity-report', installedPath]

  const valid = invoke([...common, '--reject-secondary-dir', secondary])
  assert.equal(valid.status, 0, `valid report contract failed\n${valid.stdout}\n${valid.stderr}`)

  const failedGui = { ...gui, status: 'FAILED' }
  writeJson(guiPath, failedGui)
  expectFailure([...common, '--reject-secondary-dir', secondary], 'failed GUI report')
  writeJson(guiPath, gui)

  const missingCheck = { ...gui, checks: gui.checks.filter((check) => check.id !== 'startup') }
  writeJson(guiPath, missingCheck)
  expectFailure([...common, '--reject-secondary-dir', secondary], 'missing GUI check')
  const emptyEvidence = { ...gui, checks: gui.checks.map((check) => check.id === 'startup' ? { ...check, evidence: [] } : check) }
  writeJson(guiPath, emptyEvidence)
  expectFailure([...common, '--reject-secondary-dir', secondary], 'empty GUI evidence')
  writeJson(guiPath, gui)

  const badIdentity = { ...installed, bundleSha256: '0'.repeat(64) }
  writeJson(installedPath, badIdentity)
  expectFailure([...common, '--reject-secondary-dir', secondary], 'mismatched installed identity')
  writeJson(installedPath, installed)

  fs.mkdirSync(secondary, { recursive: true })
  writeJson(path.join(secondary, 'seller-pilot-release.json'), { stale: true })
  expectFailure([...common, '--reject-secondary-dir', secondary], 'duplicate secondary manifest')

  console.log(JSON.stringify({ ok: true, checks: 6, canonical, manifestSha256: sha256File(canonical) }))
}

try {
  main()
} catch (error) {
  console.error(`seller release reproducibility regression failed: ${error.message}`)
  process.exitCode = 1
}

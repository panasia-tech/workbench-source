#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const repositoryRoot = packageRoot
const requiredChecks = ['startup', 'task-center-rainbow', 'seller-preview-isolation', 'wms-credential-safety', 'rollback-relaunch']

function value(flag, fallback = null) {
  const index = process.argv.indexOf(flag)
  if (index < 0) return fallback
  const result = process.argv[index + 1]
  if (!result || result.startsWith('--')) throw new Error(`${flag} requires a value`)
  return result
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
}

function failedReport({ manifestPath, manifestSha256 = null, installed = null, blocker, runner = null }) {
  return {
    schemaVersion: 1,
    reportKind: 'seller-gui-regression',
    status: 'FAILED',
    manifestPath,
    manifestSha256,
    installed,
    runner: runner || { name: 'unavailable', version: 'unavailable' },
    checks: [],
    blocker
  }
}

function descendants(report) {
  const root = path.resolve(report.sandboxRoot)
  const resolved = (name) => {
    const value = report[name]
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${name} must be absolute`)
    const absolute = path.resolve(value)
    if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) throw new Error(`${name} escapes sandboxRoot`)
    return absolute
  }
  return {
    root,
    applications: resolved('applicationsRoot'),
    support: resolved('supportRoot'),
    launchAgents: resolved('launchAgentsRoot'),
    userData: resolved('userData'),
    bundle: path.resolve(report.bundlePath)
  }
}

function runShell(command, env) {
  return spawnSync('/bin/zsh', ['-lc', command], { cwd: repositoryRoot, env, encoding: 'utf8' })
}

function main() {
  const manifestArg = value('--canonical-manifest', 'release-seller-pilot/seller-pilot-release.json')
  const identityArg = value('--installed-identity-report', 'docs/test-reports/phase-01.1-seller-installed-identity.json')
  const reportArg = value('--report', 'docs/test-reports/phase-01.1-seller-gui.json')
  const sandbox = process.argv.includes('--sandbox')
  const runnerCommand = value('--runner-command', process.env.SELLER_PILOT_GUI_COMMAND || '')
  const reportPath = path.resolve(repositoryRoot, reportArg)
  const manifestPath = path.resolve(repositoryRoot, manifestArg)
  const identityPath = path.resolve(repositoryRoot, identityArg)
  let manifestSha256 = null
  let installed = null
  let runner = null
  const emitFailure = (blocker) => {
    writeJson(reportPath, failedReport({ manifestPath, manifestSha256, installed, blocker, runner }))
    console.error(`seller GUI regression FAILED: ${blocker}`)
    process.exitCode = 1
  }

  try {
    if (!sandbox) throw new Error('--sandbox is required; refusing to touch a real installation')
    if (manifestPath !== path.resolve(packageRoot, 'release-seller-pilot/seller-pilot-release.json')) throw new Error('canonical manifest path is required')
    if (!fs.existsSync(manifestPath)) throw new Error(`canonical manifest missing: ${manifestPath}`)
    manifestSha256 = sha256File(manifestPath)
    if (!fs.existsSync(identityPath)) throw new Error(`installed identity report missing: ${identityPath}`)
    installed = JSON.parse(fs.readFileSync(identityPath, 'utf8'))
    if (installed.reportKind !== 'seller-installed-identity' || installed.schemaVersion !== 1) throw new Error('installed identity report schema mismatch')
    const roots = descendants(installed)
    if (roots.bundle === roots.applications || !roots.bundle.startsWith(`${roots.applications}${path.sep}`)) throw new Error('bundlePath escapes applicationsRoot')
    if (path.resolve(installed.manifestPath) !== manifestPath) throw new Error('installed identity is bound to a different manifest')
    if (installed.manifestSha256 !== manifestSha256) throw new Error('installed identity manifest hash mismatch')
    if (!runnerCommand.trim()) throw new Error('configured GUI/Midscene runner is missing; install/configure a real runner before claiming GUI PASS')
    runner = { name: process.env.SELLER_PILOT_GUI_RUNNER_NAME || 'configured-gui-runner', version: process.env.SELLER_PILOT_GUI_RUNNER_VERSION || 'unknown' }

    const env = {
      ...process.env,
      SELLER_PILOT_SANDBOX_ROOT: roots.root,
      SELLER_PILOT_APPLICATIONS_ROOT: roots.applications,
      SELLER_PILOT_SUPPORT_ROOT: roots.support,
      SELLER_PILOT_LAUNCH_AGENTS_ROOT: roots.launchAgents,
      SELLER_PILOT_GUI_BUNDLE_PATH: roots.bundle,
      SELLER_PILOT_GUI_MANIFEST: manifestPath,
      SELLER_PILOT_GUI_INSTALLED_IDENTITY: identityPath
    }
    if (process.argv.includes('--rollback-relaunch')) {
      const rollback = path.join(packageRoot, 'scripts/release/rollback-seller-pilot.sh')
      const installer = path.join(packageRoot, 'scripts/release/install-seller-pilot.sh')
      const rolledBack = spawnSync(rollback, ['--sandbox'], { cwd: packageRoot, env, encoding: 'utf8' })
      if (rolledBack.status !== 0) throw new Error(`sandbox rollback before GUI failed: ${rolledBack.stderr || rolledBack.stdout}`)
      const reinstalled = spawnSync(installer, ['--sandbox', '--manifest', manifestPath], { cwd: packageRoot, env, encoding: 'utf8' })
      if (reinstalled.status !== 0) throw new Error(`sandbox reinstall before GUI failed: ${reinstalled.stderr || reinstalled.stdout}`)
    }
    const result = runShell(runnerCommand, env)
    if (result.status !== 0) throw new Error(`configured GUI/Midscene runner exited ${result.status}: ${result.stderr || result.stdout}`)
    const resultPath = process.env.SELLER_PILOT_GUI_RESULT
    if (!resultPath || !fs.existsSync(resultPath)) throw new Error('GUI runner returned zero but did not provide SELLER_PILOT_GUI_RESULT evidence JSON')
    const observed = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
    if (!Array.isArray(observed.checks) || observed.checks.length !== requiredChecks.length) throw new Error('GUI runner evidence must contain exactly five required checks')
    const ids = observed.checks.map((check) => check.id)
    if (ids.some((id) => !requiredChecks.includes(id)) || new Set(ids).size !== requiredChecks.length) throw new Error('GUI runner evidence has missing or duplicate required checks')
    for (const check of observed.checks) {
      if (check.status !== 'PASS' || !Array.isArray(check.evidence) || check.evidence.length === 0 || check.evidence.some((item) => !String(item).trim())) throw new Error(`GUI runner check ${check.id} lacks PASS evidence`)
    }
    const report = {
      schemaVersion: 1,
      reportKind: 'seller-gui-regression',
      status: 'PASS',
      manifestPath,
      manifestSha256,
      installed: {
        bundlePath: installed.bundlePath,
        bundleSha256: installed.bundleSha256,
        asarSha256: installed.asarSha256,
        appId: installed.appId,
        launchAgentLabel: installed.launchAgentLabel,
        signature: installed.signature
      },
      runner,
      checks: observed.checks
    }
    writeJson(reportPath, report)
    console.log(JSON.stringify({ ok: true, reportPath, checks: requiredChecks.length }, null, 2))
  } catch (error) {
    emitFailure(error.message)
  }
}

try {
  main()
} catch (error) {
  console.error(`seller GUI regression failed: ${error.message}`)
  process.exitCode = 1
}

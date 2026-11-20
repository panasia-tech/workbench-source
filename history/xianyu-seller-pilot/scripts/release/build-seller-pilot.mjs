#!/usr/bin/env node

/**
 * Build the seller-pilot package from an explicitly selected commit.
 *
 * This command deliberately refuses to turn a dirty source tree into a
 * release.  A caller can inspect the printed dirty-input evidence, create a
 * clean worktree from the selected commit, and rerun the same command.  The
 * current worktree is never reset, cleaned, or overwritten by this script.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const repositoryRoot = packageRoot
const canonicalManifest = path.join(packageRoot, 'release-seller-pilot/seller-pilot-release.json')
const secondaryManifest = path.join(packageRoot, 'release/seller-pilot-release.json')
const packageInputs = [
  'src',
  'electron.vite.config.js',
  'package.json',
  'package-lock.json',
  'electron-builder.seller-pilot.yml',
  'resources/icon-seller-pilot.icns',
  'resources/icon-seller-pilot-source.png',
  'resources/seller-index/canonical-sellers.manifest.json',
  'scripts/release',
  'scripts/test/verify-seller-release.mjs'
]

function fail(message, code = 1) {
  console.error(`seller-pilot build refused: ${message}`)
  process.exitCode = code
}

function run(command, args, { cwd = repositoryRoot, stdio = 'pipe' } = {}) {
  const output = execFileSync(command, args, { cwd, encoding: 'utf8', stdio })
  return typeof output === 'string' ? output.trim() : ''
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function dirtyInputs() {
  const output = run('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', ...packageInputs])
  return output ? output.split('\n').filter(Boolean) : []
}

function atomicWrite(file, text) {
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const fd = fs.openSync(temp, 'w', 0o600)
  try {
    fs.writeFileSync(fd, text)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(temp, file)
}

function parseArgs() {
  const args = process.argv.slice(2)
  const value = (flag, fallback = null) => {
    const indexes = args.reduce((all, item, index) => item === flag ? all.concat(index) : all, [])
    if (indexes.length > 1) throw new Error(`${flag} must be provided once`)
    if (!indexes.length) return fallback
    const next = args[indexes[0] + 1]
    if (!next || next.startsWith('--')) throw new Error(`${flag} requires a value`)
    return next
  }
  const commit = value('--commit', 'HEAD')
  const manifest = value('--canonical-manifest', 'release-seller-pilot/seller-pilot-release.json')
  if (args.some((item) => item.startsWith('--') && !['--commit', '--canonical-manifest'].includes(item))) throw new Error(`unknown option: ${args.find((item) => item.startsWith('--') && !['--commit', '--canonical-manifest'].includes(item))}`)
  return { commit, manifest }
}

function main() {
  const { commit, manifest } = parseArgs()
  const manifestPath = path.resolve(repositoryRoot, manifest)
  if (manifestPath !== path.resolve(canonicalManifest)) throw new Error(`canonical manifest must be ${canonicalManifest}`)
  if (fs.existsSync(secondaryManifest)) throw new Error(`secondary seller-pilot manifest is forbidden: ${secondaryManifest}`)

  const resolvedCommit = run('git', ['rev-parse', '--verify', `${commit}^{commit}`])
  const head = run('git', ['rev-parse', 'HEAD'])
  if (resolvedCommit !== head) throw new Error(`current worktree HEAD ${head} does not equal requested fixed commit ${resolvedCommit}; build from a clean worktree without changing this checkout`)
  const dirty = dirtyInputs()
  if (dirty.length) {
    const evidence = {
      schemaVersion: 1,
      status: 'REJECTED_DIRTY_INPUTS',
      commit: resolvedCommit,
      buildWorkspacePath: repositoryRoot,
      dirtyPackageInputs: dirty,
      capturedAt: new Date().toISOString()
    }
    const evidencePath = path.join(os.tmpdir(), `seller-pilot-dirty-inputs-${process.pid}.json`)
    atomicWrite(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
    console.error(JSON.stringify({ ...evidence, evidencePath }, null, 2))
    process.exitCode = 2
    return
  }

  run('npm', ['run', 'build', '--prefix', packageRoot], { stdio: 'inherit' })
  run(path.join(packageRoot, 'node_modules/.bin/electron-builder'), ['--config', 'electron-builder.seller-pilot.yml', '--mac', 'dir'], { cwd: packageRoot, stdio: 'inherit' })
  run(process.execPath, ['scripts/release/sign-seller-pilot.mjs'], { cwd: packageRoot, stdio: 'inherit' })

  const draft = path.join(os.tmpdir(), `seller-pilot-manifest-${process.pid}.json`)
  run(process.execPath, ['scripts/test/verify-seller-release.mjs', '--discover-candidate', 'electron-builder.seller-pilot.yml', '--write-manifest', draft], { cwd: packageRoot, stdio: 'inherit' })
  const result = JSON.parse(fs.readFileSync(draft, 'utf8'))
  result.releaseKind = 'seller-pilot-candidate'
  result.commit = resolvedCommit
  result.buildWorkspacePath = repositoryRoot
  result.dirtyPackageInputs = []
  result.builder = {
    command: 'build-seller-pilot.mjs',
    fixedCommit: resolvedCommit,
    packageInputs,
    manifestSha256BeforeAtomicReplace: sha256File(draft)
  }
  atomicWrite(manifestPath, `${JSON.stringify(result, null, 2)}\n`)
  fs.unlinkSync(draft)
  console.log(JSON.stringify({ ok: true, manifestPath, commit: resolvedCommit, manifestSha256: sha256File(manifestPath) }, null, 2))
}

try {
  main()
} catch (error) {
  fail(error.message)
}

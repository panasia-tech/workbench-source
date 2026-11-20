#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const outputRoot = path.join(packageRoot, 'release-seller-pilot')
const expectedName = '闲鱼卖家巡航台.app'
const expectedAppId = 'com.erp.xianyu.sellerpilot'

function candidates(root) {
  if (!fs.existsSync(root)) return []
  const found = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory() && entry.name === expectedName) found.push(fs.realpathSync(absolute))
      else if (entry.isDirectory()) visit(absolute)
    }
  }
  visit(root)
  return found
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: packageRoot, encoding: 'utf8' })
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.stdout}`)
  return String(result.stdout || '').trim()
}

const apps = candidates(outputRoot)
assert.equal(apps.length, 1, `expected exactly one ${expectedName} under ${outputRoot}; found ${apps.length}`)
const app = apps[0]
assert(app.startsWith(fs.realpathSync(outputRoot) + path.sep), 'candidate escaped the isolated release directory')
const appId = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(app, 'Contents/Info.plist')])
assert.equal(appId, expectedAppId, 'refusing to sign a candidate with the wrong bundle identifier')
const existingSignature = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { cwd: packageRoot, encoding: 'utf8' })
if (existingSignature.status !== 0) {
  // A locally reproducible build may intentionally disable identity discovery
  // (for example on a machine without the distribution certificate). In that
  // case the nested Electron frameworks are unsigned/partially signed too, so
  // an ad-hoc deep signature is required before the strict verification gate.
  run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app])
}
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
process.stdout.write(`seller-pilot candidate signature PASS (${existingSignature.status === 0 ? 'preserved' : 'ad-hoc'}): ${app}\n`)

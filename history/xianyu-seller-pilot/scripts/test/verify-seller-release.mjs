import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const electronPackage = require('electron/package.json')
const builderPackage = require('electron-builder/package.json')
const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(scriptDir, '../..')
const repositoryRoot = packageRoot
const RELEASE_SCHEMA_VERSION = 2
const GUI_REPORT_SCHEMA_VERSION = 1
const INSTALLED_IDENTITY_SCHEMA_VERSION = 1
const CANONICAL_MANIFEST = path.join(packageRoot, 'release-seller-pilot/seller-pilot-release.json')
const REQUIRED_GUI_CHECKS = Object.freeze([
  'startup',
  'task-center-rainbow',
  'seller-preview-isolation',
  'wms-credential-safety',
  'rollback-relaunch'
])
const EXPECTED_IDENTITY = Object.freeze({
  productName: '闲鱼卖家巡航台',
  appId: 'com.erp.xianyu.sellerpilot',
  icon: 'resources/icon-seller-pilot.icns',
  bundlePath: '/Applications/闲鱼卖家巡航台.app',
  userDataPath: path.join(os.homedir(), 'Library/Application Support/闲鱼卖家巡航台'),
  launchAgentLabel: 'com.erp.xianyu.sellerpilot.autostart'
})
const OLD_IDENTITIES = Object.freeze([
  {
    productName: '闲鱼行情爬虫',
    appId: 'com.erp.xianyu.electron',
    bundlePath: '/Applications/闲鱼行情爬虫.app',
    userDataPath: path.join(os.homedir(), 'Library/Application Support/xianyu-electron'),
    launchAgentLabel: 'com.erp.xianyu.electron.autostart'
  },
  {
    productName: '闲鱼行情工作台',
    appId: 'com.erp.xianyu.workbench',
    bundlePath: '/Applications/闲鱼行情工作台.app',
    userDataPath: path.join(os.homedir(), 'Library/Application Support/闲鱼行情工作台'),
    launchAgentLabel: 'com.erp.xianyu.workbench.autostart'
  }
])
const PACKAGE_INPUTS = Object.freeze([
  'src',
  'electron.vite.config.js',
  'package.json',
  'package-lock.json',
  'electron-builder.seller-pilot.yml',
  'resources/icon-seller-pilot.icns',
  'resources/icon-seller-pilot-source.png',
  'resources/seller-index/canonical-sellers.manifest.json',
  'scripts/release/install-seller-pilot.sh',
  'scripts/release/migrate-seller-user-data.mjs',
  'scripts/release/rollback-seller-pilot.sh',
  'scripts/release/sign-seller-pilot.mjs',
  'scripts/test/seller-install-recovery-regression.mjs',
  'scripts/test/verify-seller-release.mjs'
])
const SECRET_KEY = /(?:^|[_-])(password|passwd|secret|token|cookie|authorization|session)(?:$|[_-])/i
const SECRET_VALUE = /(?:authorization:\s*(?:bearer|basic)|(?:password|passwd|secret|token|cookie)\s*[:=]\s*[^\s,;]{6,})/i

function fail(message) {
  throw new Error(message)
}

function argValue(flag, { required = false } = {}) {
  const index = process.argv.indexOf(flag)
  const value = index >= 0 ? process.argv[index + 1] : null
  if (required && (!value || value.startsWith('--'))) fail(`${flag} requires a value`)
  return value
}

function strictFlagPath(flag) {
  const indexes = process.argv.reduce((all, value, index) => value === flag ? all.concat(index) : all, [])
  assert.equal(indexes.length, 1, `${flag} must be provided exactly once`)
  const index = indexes[0]
  const value = process.argv[index + 1]
  assert(value && !value.startsWith('--'), `${flag} requires a path value`)
  return value
}

function assertStrictReportArguments() {
  const valueFlags = new Set(['--candidate-manifest', '--reject-secondary-dir', '--require-gui-report', '--installed-identity-report'])
  const booleanFlags = new Set(['--report-only', '--require-canonical-manifest'])
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (booleanFlags.has(token)) continue
    if (valueFlags.has(token)) {
      const value = args[index + 1]
      assert(value && !value.startsWith('--'), `${token} requires exactly one path value`)
      index += 1
      continue
    }
    fail(`unexpected report-only argument: ${token}`)
  }
}

function manifestSha256(manifestPath) {
  return sha256File(manifestPath)
}

function canonicalManifestPath() {
  return path.resolve(CANONICAL_MANIFEST)
}

function resolveRepositoryPath(value) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(repositoryRoot, value)
}

function assertCanonicalManifest(candidateManifest, { rejectSecondaryDir = null } = {}) {
  const candidate = resolveRepositoryPath(candidateManifest)
  assert.equal(candidate, canonicalManifestPath(), `candidate manifest must be the canonical parent-locked path: ${CANONICAL_MANIFEST}`)
  if (rejectSecondaryDir) {
    const secondary = path.resolve(repositoryRoot, rejectSecondaryDir)
    const duplicate = path.join(secondary, 'seller-pilot-release.json')
    assert(!fs.existsSync(duplicate), `secondary seller-pilot manifest is forbidden: ${duplicate}`)
  }
  assert(fs.existsSync(candidate), `canonical seller-pilot manifest missing: ${candidate}`)
  return candidate
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file))
}

function sortedFiles(root) {
  if (!fs.existsSync(root)) fail(`required path missing: ${root}`)
  const output = []
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) output.push(absolute)
    }
  }
  if (fs.statSync(root).isFile()) return [root]
  visit(root)
  return output
}

function treeManifest(root) {
  const files = sortedFiles(root).map((file) => ({
    path: path.relative(root, file).split(path.sep).join('/'),
    bytes: fs.statSync(file).size,
    sha256: sha256File(file)
  }))
  return {
    fileCount: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    sha256: sha256Buffer(Buffer.from(files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}`).join('\n'))),
    files
  }
}

function bundleManifest(root) {
  const absoluteRoot = fs.realpathSync(root)
  const entries = []
  const visit = (current) => {
    for (const entry of fs.readdirSync(current).sort((a, b) => a.localeCompare(b))) {
      const absolute = path.join(current, entry)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(absolute)
        const resolved = fs.realpathSync(absolute)
        assert(resolved === absoluteRoot || resolved.startsWith(absoluteRoot + path.sep), `candidate bundle symlink escapes app: ${relative}`)
        entries.push({ path: relative, type: 'symlink', target })
      } else if (stat.isDirectory()) {
        entries.push({ path: relative, type: 'directory' })
        visit(absolute)
      } else if (stat.isFile()) {
        entries.push({ path: relative, type: 'file', bytes: stat.size, sha256: sha256File(absolute) })
      } else {
        fail(`unsupported candidate bundle entry: ${relative}`)
      }
    }
  }
  visit(root)
  const canonical = Buffer.from(entries.map((entry) => JSON.stringify(entry)).join('\n'))
  return {
    entryCount: entries.length,
    fileCount: entries.filter((entry) => entry.type === 'file').length,
    symlinkCount: entries.filter((entry) => entry.type === 'symlink').length,
    bytes: entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0),
    sha256: sha256Buffer(canonical)
  }
}

function verifyCodeSignature(appPath) {
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], packageRoot)
  const inspected = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], { cwd: packageRoot, encoding: 'utf8' })
  assert.equal(inspected.status, 0, `cannot inspect candidate signature: ${inspected.stderr || inspected.stdout}`)
  const details = `${inspected.stdout || ''}${inspected.stderr || ''}`.trim()
  const portableDetails = details.split('\n').filter((line) => !line.startsWith('Executable=')).join('\n')
  return {
    verified: true,
    adHoc: /(?:^|\n)Signature=adhoc(?:\n|$)/.test(details),
    detailsSha256: sha256Buffer(Buffer.from(portableDetails))
  }
}

function command(commandName, args, cwd = repositoryRoot) {
  return execFileSync(commandName, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function gitCommit(root = repositoryRoot) {
  return command('git', ['rev-parse', 'HEAD'], root)
}

function dirtyPackageInputs(root = repositoryRoot) {
  const output = command('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', ...PACKAGE_INPUTS], root)
  return output ? output.split('\n').filter(Boolean) : []
}

function valueAfterKey(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.match(new RegExp(`^${escaped}:\\s*(.+?)\\s*$`, 'm'))?.[1]?.replace(/^['"]|['"]$/g, '') || null
}

function nestedValue(text, parent, key) {
  const escapedParent = parent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.match(new RegExp(`^${escapedParent}:\\s*\\n(?:  .+\\n)*?  ${escapedKey}:\\s*(.+?)\\s*$`, 'm'))?.[1]?.replace(/^['"]|['"]$/g, '') || null
}

function sellerIdentityValue(text, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.match(new RegExp(`^    ${escapedKey}:\\s*(.+?)\\s*$`, 'm'))?.[1]?.replace(/^['"]|['"]$/g, '') || null
}

function validateConfig(configPath) {
  const absolute = path.resolve(packageRoot, configPath)
  assert(fs.existsSync(absolute), `seller-pilot builder config missing: ${absolute}`)
  const text = fs.readFileSync(absolute, 'utf8')
  const configIdentity = {
    productName: valueAfterKey(text, 'productName'),
    appId: valueAfterKey(text, 'appId'),
    icon: nestedValue(text, 'mac', 'icon'),
    bundlePath: sellerIdentityValue(text, 'bundlePath'),
    userDataPath: sellerIdentityValue(text, 'userDataPath')?.replace(/^~/, os.homedir()),
    launchAgentLabel: sellerIdentityValue(text, 'launchAgentLabel')
  }
  assert.deepStrictEqual(configIdentity, EXPECTED_IDENTITY, 'seller-pilot config must contain the exact five-coordinate identity and icon')
  assert.equal(nestedValue(text, 'directories', 'output'), 'release-seller-pilot', 'seller-pilot must use an isolated output directory')
  assert.match(text, /^files:\s*\n  - out\/\*\*\/\*$/m, 'candidate must package modular out/**/*')
  // package.json 的 main 是 loader.js，任何构建都必须打包它，否则入口文件缺失、装完起不来。
  assert.match(text, /^  - loader\.js$/m, 'candidate must package the loader entry named by package.json main')
  // 但刻意不带 code-version.json：那是「启用代码热更新」的开关，巡航台走整包分发。
  assert.doesNotMatch(text, /^  - code-version\.json$/m, 'seller-pilot ships whole packages; it must not enable code hot update')
  assert.match(text, /^  - resources\/icon-seller-pilot\.icns$/m, 'candidate must package only its dedicated icon resource')
  assert.match(text, /^  - resources\/seller-index\/canonical-sellers\.manifest\.json$/m, 'candidate must package the canonical seller manifest used by runtime evidence summaries')
  for (const oldIdentity of OLD_IDENTITIES) {
    for (const coordinate of ['productName', 'appId', 'bundlePath', 'userDataPath', 'launchAgentLabel']) {
      assert.notEqual(configIdentity[coordinate], oldIdentity[coordinate], `${coordinate} collides with ${oldIdentity.productName}`)
    }
  }
  const iconPath = path.join(packageRoot, configIdentity.icon)
  assert(fs.existsSync(iconPath), `seller-pilot icon missing: ${iconPath}`)
  const workbenchIcon = path.join(packageRoot, 'resources/icon-workbench.icns')
  assert.notEqual(sha256File(iconPath), sha256File(workbenchIcon), 'seller-pilot icon must differ from workbench icon')
  return {
    configPath: absolute,
    outputDirectory: path.resolve(packageRoot, nestedValue(text, 'directories', 'output')),
    identity: configIdentity,
    configSha256: sha256File(absolute),
    iconSha256: sha256File(iconPath)
  }
}

function validateSellerPilotBranding(root = packageRoot) {
  const rendererHtml = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8')
  const consoleView = fs.readFileSync(path.join(root, 'src/renderer/src/views/Console.vue'), 'utf8')
  const loginView = fs.readFileSync(path.join(root, 'src/renderer/src/views/Login.vue'), 'utf8')
  const mainSource = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8')

  assert.match(rendererHtml, /<title>卖家工作台<\/title>/, 'renderer document title must use seller-pilot identity')
  assert.match(consoleView, /<b>卖家工作台<\/b><small>SELLER PILOT<\/small>/, 'sidebar must use seller-pilot identity')
  assert.match(consoleView, /class="brand-mark">巡<\/div>/, 'sidebar mark must be seller-pilot specific')
  assert.match(loginView, /<h2 class="title">卖家工作台<\/h2>/, 'login title must use seller-pilot identity')
  assert.match(mainSource, /name !== 'xianyu-electron' \? name : '卖家工作台'/, 'BrowserWindow fallback title must use seller-pilot identity')
  assert.doesNotMatch(`${rendererHtml}\n${consoleView}\n${loginView}`, /闲鱼行情爬虫|MARKET WORKBENCH/, 'seller-pilot renderer must not carry the legacy product brand')
}

function findCandidateApps(outputDirectory, productName) {
  if (!fs.existsSync(outputDirectory)) return []
  const matches = []
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory() && entry.name === `${productName}.app`) matches.push(path.resolve(absolute))
      else if (entry.isDirectory()) visit(absolute)
    }
  }
  visit(outputDirectory)
  return matches.sort()
}

function plistValue(appPath, key) {
  return command('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(appPath, 'Contents/Info.plist')], packageRoot)
}

function asarComponentManifest(archive, outRoot) {
  const out = treeManifest(outRoot)
  const entries = new Set(asar.listPackage(archive).map((entry) => entry.replace(/^\//, '')))
  const candidateFiles = []
  for (const file of out.files) {
    const asarPath = `out/${file.path}`
    assert(entries.has(asarPath), `candidate asar missing build output: ${asarPath}`)
    const buffer = asar.extractFile(archive, asarPath)
    const candidate = { path: file.path, bytes: buffer.length, sha256: sha256Buffer(buffer) }
    assert.deepStrictEqual(candidate, file, `candidate asar drifted from build output: ${file.path}`)
    candidateFiles.push(candidate)
  }
  const forbiddenEntries = [...entries].filter((entry) => /(?:^|\/)(?:\.env(?:\.|$)|groupcontrol-app|index\.js\.bak)(?:\/|$)/i.test(entry))
  assert.deepStrictEqual(forbiddenEntries, [], `candidate contains forbidden inputs: ${forbiddenEntries.join(', ')}`)
  return {
    out,
    asar: {
      path: archive,
      archiveSha256: sha256File(archive),
      fileCount: candidateFiles.length,
      bytes: candidateFiles.reduce((sum, file) => sum + file.bytes, 0),
      sha256: sha256Buffer(Buffer.from(candidateFiles.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}`).join('\n'))),
      files: candidateFiles
    }
  }
}

function packagedIdentityMetadata(archive) {
  const packaged = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
  const metadata = {
    main: packaged.main,
    productName: packaged.productName,
    bundlePath: packaged.sellerPilotIdentity?.bundlePath,
    userDataPath: String(packaged.sellerPilotIdentity?.userDataPath || '').replace(/^~/, os.homedir()),
    launchAgentLabel: packaged.sellerPilotIdentity?.launchAgentLabel
  }
  assert.equal(metadata.main, './out/main/index.js', 'candidate must boot the modular main bundle')
  assert.deepStrictEqual({
    productName: metadata.productName,
    bundlePath: metadata.bundlePath,
    userDataPath: metadata.userDataPath,
    launchAgentLabel: metadata.launchAgentLabel
  }, {
    productName: EXPECTED_IDENTITY.productName,
    bundlePath: EXPECTED_IDENTITY.bundlePath,
    userDataPath: EXPECTED_IDENTITY.userDataPath,
    launchAgentLabel: EXPECTED_IDENTITY.launchAgentLabel
  }, 'packaged app metadata must preserve the isolated runtime identity')
  return { ...metadata, sha256: sha256Buffer(Buffer.from(JSON.stringify(metadata))) }
}

function packagedCanonicalManifest(archive) {
  const manifestPath = 'resources/seller-index/canonical-sellers.manifest.json'
  const entries = new Set(asar.listPackage(archive).map((entry) => entry.replace(/^\//, '')))
  assert(entries.has(manifestPath), 'candidate must package the canonical seller manifest at the runtime path')
  const buffer = asar.extractFile(archive, manifestPath)
  const manifest = JSON.parse(buffer.toString('utf8'))
  assert.equal(manifest.count, 9977, 'packaged canonical seller count must remain 9,977')
  assert.equal(manifest.sellerIds?.length, 9977, 'packaged canonical seller ID array must remain 9,977')
  return { path: manifestPath, count: manifest.count, sha256: sha256Buffer(buffer) }
}

function installedEvidence() {
  return OLD_IDENTITIES.map((identity) => {
    const appPath = identity.bundlePath
    if (!fs.existsSync(appPath)) return { appPath, exists: false }
    const asarPath = path.join(appPath, 'Contents/Resources/app.asar')
    return {
      appPath,
      exists: true,
      appId: plistValue(appPath, 'CFBundleIdentifier'),
      infoPlistSha256: sha256File(path.join(appPath, 'Contents/Info.plist')),
      asarSha256: fs.existsSync(asarPath) ? sha256File(asarPath) : null
    }
  })
}

function assertMetadataSafe(value, trail = 'manifest') {
  if (Array.isArray(value)) return value.forEach((item, index) => assertMetadataSafe(item, `${trail}[${index}]`))
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert(!SECRET_KEY.test(key), `secret-like manifest key rejected: ${trail}.${key}`)
      assertMetadataSafe(child, `${trail}.${key}`)
    }
    return
  }
  if (typeof value === 'string') assert(!SECRET_VALUE.test(value), `secret-like manifest value rejected at ${trail}`)
}

function discoverCandidate(configPath, manifestPath, { sandboxDraft = false } = {}) {
  const config = validateConfig(configPath)
  validateSellerPilotBranding()
  const dirty = dirtyPackageInputs()
  if (!sandboxDraft) assert.deepStrictEqual(dirty, [], `release workspace contains dirty package inputs:\n${dirty.join('\n')}`)
  const candidates = findCandidateApps(config.outputDirectory, config.identity.productName)
  assert.equal(candidates.length, 1, `expected exactly one candidate app under ${config.outputDirectory}; found ${candidates.length}`)
  const candidateAppPath = candidates[0]
  assert.notEqual(candidateAppPath, config.identity.bundlePath, 'candidate discovery must never target /Applications before install')
  assert.equal(plistValue(candidateAppPath, 'CFBundleIdentifier'), config.identity.appId, 'candidate bundle ID mismatch')
  assert.equal(plistValue(candidateAppPath, 'CFBundleName'), config.identity.productName, 'candidate bundle name mismatch')
  const archive = path.join(candidateAppPath, 'Contents/Resources/app.asar')
  assert(fs.existsSync(archive), `candidate app.asar missing: ${archive}`)
  const components = asarComponentManifest(archive, path.join(packageRoot, 'out'))
  components.bundle = bundleManifest(candidateAppPath)
  components.codeSignature = verifyCodeSignature(candidateAppPath)
  const source = {
    main: treeManifest(path.join(packageRoot, 'src/main')),
    preload: treeManifest(path.join(packageRoot, 'src/preload')),
    renderer: treeManifest(path.join(packageRoot, 'src/renderer'))
  }
  const rootCompatibilityPath = path.join(packageRoot, 'legacy/rank_rpa.py')
  const manifest = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    releaseKind: sandboxDraft ? 'seller-pilot-sandbox-draft' : 'seller-pilot-candidate',
    createdAt: new Date().toISOString(),
    commit: gitCommit(),
    buildWorkspacePath: repositoryRoot,
    candidateAppPath,
    dirtyPackageInputs: dirty,
    packageLockSha256: sha256File(path.join(packageRoot, 'package-lock.json')),
    toolVersions: {
      node: process.version,
      npm: command('npm', ['--version'], packageRoot),
      electron: electronPackage.version,
      electronBuilder: builderPackage.version
    },
    identity: config.identity,
    config: { path: config.configPath, sha256: config.configSha256 },
    iconSha256: config.iconSha256,
    source,
    sourceTreeSha256: sha256Buffer(Buffer.from([source.main.sha256, source.preload.sha256, source.renderer.sha256].join('\n'))),
    rootCompatibilityEvidence: {
      path: rootCompatibilityPath,
      sha256: sha256File(rootCompatibilityPath),
      role: 'read-only-compatibility-evidence'
    },
    packagedIdentity: packagedIdentityMetadata(archive),
    packagedCanonicalManifest: packagedCanonicalManifest(archive),
    components,
    releaseTools: {
      scripts: treeManifest(path.join(packageRoot, 'scripts/release')),
      verifierSha256: sha256File(path.join(packageRoot, 'scripts/test/verify-seller-release.mjs')),
      recoveryRegressionSha256: sha256File(path.join(packageRoot, 'scripts/test/seller-install-recovery-regression.mjs'))
    },
    installedAppsBeforeCandidate: installedEvidence()
  }
  assertMetadataSafe(manifest)
  let absoluteManifest = path.resolve(packageRoot, manifestPath)
  if (sandboxDraft) {
    const temporaryRoot = fs.realpathSync(os.tmpdir())
    const canonicalParent = fs.realpathSync(path.dirname(absoluteManifest))
    assert(canonicalParent === temporaryRoot || canonicalParent.startsWith(temporaryRoot + path.sep), 'sandbox draft manifest must be written under the system temporary directory')
    absoluteManifest = path.join(canonicalParent, path.basename(absoluteManifest))
  }
  fs.mkdirSync(path.dirname(absoluteManifest), { recursive: true })
  fs.writeFileSync(absoluteManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  return { manifestPath: absoluteManifest, manifest }
}

function installedTargetEvidence(manifest, installedPath) {
  const absolute = path.resolve(installedPath)
  const sandboxRoot = String(process.env.SELLER_PILOT_VERIFY_SANDBOX_ROOT || '').trim()
  const sandboxAllowed = sandboxRoot && (absolute === path.resolve(sandboxRoot) || absolute.startsWith(path.resolve(sandboxRoot) + path.sep))
  assert(absolute === EXPECTED_IDENTITY.bundlePath || sandboxAllowed, `installed target must be exactly ${EXPECTED_IDENTITY.bundlePath}`)
  assert(fs.existsSync(absolute), `installed seller-pilot app missing: ${absolute}`)
  assert.equal(plistValue(absolute, 'CFBundleIdentifier'), EXPECTED_IDENTITY.appId, 'installed bundle ID mismatch')
  assert.equal(plistValue(absolute, 'CFBundleName'), EXPECTED_IDENTITY.productName, 'installed bundle name mismatch')
  const archive = path.join(absolute, 'Contents/Resources/app.asar')
  assert(fs.existsSync(archive), 'installed app.asar missing')
  assert.equal(sha256File(archive), manifest.components.asar.archiveSha256, 'installed app.asar differs from release manifest')
  assert.deepStrictEqual(bundleManifest(absolute), manifest.components.bundle, 'installed app bundle differs from release manifest')
  assert.deepStrictEqual(packagedIdentityMetadata(archive), manifest.packagedIdentity, 'installed runtime identity drifted')
  assert.deepStrictEqual(packagedCanonicalManifest(archive), manifest.packagedCanonicalManifest, 'installed canonical seller manifest drifted')
  const codeSignature = verifyCodeSignature(absolute)
  assert.deepStrictEqual(codeSignature, manifest.components.codeSignature, 'installed code signature differs from release manifest')
  return {
    appPath: absolute,
    appId: EXPECTED_IDENTITY.appId,
    asarSha256: sha256File(archive),
    signatureVerified: true
  }
}

function assertAbsoluteDescendant(value, root, label) {
  assert(typeof value === 'string' && path.isAbsolute(value), `${label} must be an absolute path`)
  const resolvedRoot = path.resolve(root)
  const resolvedValue = path.resolve(value)
  assert(resolvedValue !== resolvedRoot && resolvedValue.startsWith(`${resolvedRoot}${path.sep}`), `${label} must be a descendant of sandboxRoot`)
}

function readJsonReport(reportPath, label) {
  const absolute = resolveRepositoryPath(reportPath)
  assert(fs.existsSync(absolute), `${label} is missing: ${absolute}`)
  let report
  try {
    report = JSON.parse(fs.readFileSync(absolute, 'utf8'))
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`)
  }
  assert(report && typeof report === 'object' && !Array.isArray(report), `${label} must be an object`)
  return { absolute, report }
}

function expectedSignature(manifest) {
  const signature = manifest.components?.codeSignature || manifest.signature || {}
  return {
    status: signature.status || (signature.verified ? 'PASS' : 'FAILED'),
    identity: signature.identity || manifest.identity?.appId || ''
  }
}

function installedIdentityFromManifest(manifest) {
  const identity = manifest.installedIdentity || {}
  const signature = identity.signature || expectedSignature(manifest)
  return {
    bundlePath: identity.bundlePath || manifest.identity?.bundlePath,
    bundleSha256: identity.bundleSha256 || manifest.components?.bundle?.sha256,
    asarSha256: identity.asarSha256 || manifest.components?.asar?.archiveSha256,
    appId: identity.appId || manifest.identity?.appId,
    launchAgentLabel: identity.launchAgentLabel || manifest.identity?.launchAgentLabel,
    signature: {
      status: signature.status,
      identity: signature.identity
    }
  }
}

function validateInstalledIdentityReport(reportPath, report, manifest, canonicalPath, candidateHash) {
  assert.equal(report.schemaVersion, INSTALLED_IDENTITY_SCHEMA_VERSION, 'installed identity report schemaVersion must be 1')
  assert.equal(report.reportKind, 'seller-installed-identity', 'installed identity report reportKind mismatch')
  assert.equal(resolveRepositoryPath(report.manifestPath), canonicalPath, 'installed identity manifestPath must be canonical')
  assert.equal(report.manifestSha256, candidateHash, 'installed identity manifestSha256 mismatch')
  assert(typeof report.sandboxRoot === 'string' && path.isAbsolute(report.sandboxRoot), 'installed identity sandboxRoot must be absolute')
  for (const key of ['applicationsRoot', 'supportRoot', 'launchAgentsRoot', 'userData']) {
    assertAbsoluteDescendant(report[key], report.sandboxRoot, `installed identity ${key}`)
  }
  assertAbsoluteDescendant(report.bundlePath, report.applicationsRoot, 'installed identity bundlePath')
  assert.equal(report.bundleSha256, installedIdentityFromManifest(manifest).bundleSha256, 'installed identity bundleSha256 mismatch')
  assert.equal(report.asarSha256, installedIdentityFromManifest(manifest).asarSha256, 'installed identity asarSha256 mismatch')
  assert.equal(report.appId, installedIdentityFromManifest(manifest).appId, 'installed identity appId mismatch')
  assert.equal(report.launchAgentLabel, installedIdentityFromManifest(manifest).launchAgentLabel, 'installed identity launchAgentLabel mismatch')
  assert(report.signature && typeof report.signature === 'object', 'installed identity signature is required')
  const expected = installedIdentityFromManifest(manifest).signature
  assert.equal(report.signature.status, expected.status, 'installed identity signature status mismatch')
  assert.equal(report.signature.identity, expected.identity, 'installed identity signature identity mismatch')
  return { absolute: path.resolve(repositoryRoot, reportPath), report }
}

function validateGuiReport(reportPath, report, manifest, canonicalPath, candidateHash, installedIdentity) {
  assert.equal(report.schemaVersion, GUI_REPORT_SCHEMA_VERSION, 'GUI report schemaVersion must be 1')
  assert.equal(report.reportKind, 'seller-gui-regression', 'GUI report reportKind mismatch')
  assert.equal(report.status, 'PASS', 'GUI report status must be PASS')
  assert.equal(resolveRepositoryPath(report.manifestPath), canonicalPath, 'GUI report manifestPath must be canonical')
  assert.equal(report.manifestSha256, candidateHash, 'GUI report manifestSha256 mismatch')
  assert(report.runner && typeof report.runner.name === 'string' && report.runner.name.trim(), 'GUI report runner.name is required')
  assert(report.runner.version !== undefined && String(report.runner.version).trim(), 'GUI report runner.version is required')
  assert(report.installed && typeof report.installed === 'object', 'GUI report installed identity is required')
  for (const key of ['bundlePath', 'bundleSha256', 'asarSha256', 'appId', 'launchAgentLabel']) {
    assert.equal(report.installed[key], installedIdentity.report[key], `GUI report installed.${key} mismatch`)
  }
  assert.deepEqual(report.installed.signature, installedIdentity.report.signature, 'GUI report installed.signature mismatch')
  assert(Array.isArray(report.checks) && report.checks.length > 0, 'GUI report checks must be a non-empty array')
  const ids = report.checks.map((check) => check?.id)
  assert.deepEqual([...ids].sort(), [...REQUIRED_GUI_CHECKS].sort(), 'GUI report must contain exactly the five required check IDs once')
  for (const check of report.checks) {
    assert.equal(check.status, 'PASS', `GUI check ${check.id} status must be PASS`)
    assert(Array.isArray(check.evidence) && check.evidence.length > 0, `GUI check ${check.id} evidence must be non-empty`)
    for (const evidence of check.evidence) assert(typeof evidence === 'string' && evidence.trim(), `GUI check ${check.id} evidence must contain text`)
  }
  return { absolute: path.resolve(repositoryRoot, reportPath), report }
}

function verifyReportOnly(candidateManifest, guiReportPath, installedIdentityPath, { rejectSecondaryDir = null } = {}) {
  const canonical = assertCanonicalManifest(candidateManifest, { rejectSecondaryDir })
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(canonical, 'utf8'))
  } catch (error) {
    fail(`canonical manifest is not valid JSON: ${error.message}`)
  }
  assert.equal(manifest.schemaVersion, RELEASE_SCHEMA_VERSION, 'release manifest schemaVersion mismatch')
  assertMetadataSafe(manifest)
  const candidateHash = manifestSha256(canonical)
  const installed = readJsonReport(installedIdentityPath, 'installed identity report')
  const normalizedInstalled = validateInstalledIdentityReport(installedIdentityPath, installed.report, manifest, canonical, candidateHash)
  const gui = readJsonReport(guiReportPath, 'GUI report')
  const normalizedGui = validateGuiReport(guiReportPath, gui.report, manifest, canonical, candidateHash, normalizedInstalled)
  return {
    canonical,
    candidateHash,
    manifest,
    installed: normalizedInstalled.report,
    gui: normalizedGui.report
  }
}

function verifyManifest(manifestPath, { installedPath = null, installationPreflight = false } = {}) {
  const absolute = resolveRepositoryPath(manifestPath)
  const manifest = JSON.parse(fs.readFileSync(absolute, 'utf8'))
  assert.equal(manifest.schemaVersion, RELEASE_SCHEMA_VERSION)
  assertMetadataSafe(manifest)
  const sandboxRoot = String(process.env.SELLER_PILOT_VERIFY_SANDBOX_ROOT || '').trim()
  const sandboxInstalled = Boolean(installedPath && sandboxRoot && (path.resolve(installedPath) === path.resolve(sandboxRoot) || path.resolve(installedPath).startsWith(path.resolve(sandboxRoot) + path.sep)))
  const sandboxDraft = manifest.releaseKind === 'seller-pilot-sandbox-draft'
  assert(manifest.releaseKind === 'seller-pilot-candidate' || (sandboxDraft && sandboxInstalled), 'sandbox draft manifests are valid only for sandbox installed verification')
  assert.equal(manifest.commit, gitCommit(manifest.buildWorkspacePath), 'release workspace commit drifted')
  const currentDirty = dirtyPackageInputs(manifest.buildWorkspacePath)
  assert.deepStrictEqual(currentDirty, manifest.dirtyPackageInputs, 'release workspace package inputs changed after manifest creation')
  if (!sandboxDraft) assert.deepStrictEqual(currentDirty, [], 'release workspace package inputs became dirty')
  const packagePath = manifest.buildWorkspacePath
  const config = validateConfig(manifest.config.path)
  validateSellerPilotBranding(packagePath)
  assert.equal(config.configSha256, manifest.config.sha256, 'builder config hash drifted')
  assert.equal(sha256File(path.join(packagePath, 'package-lock.json')), manifest.packageLockSha256, 'package lock hash drifted')
  assert(fs.existsSync(manifest.candidateAppPath), 'manifest-selected candidate app no longer exists')
  const archive = path.join(manifest.candidateAppPath, 'Contents/Resources/app.asar')
  assert.deepStrictEqual(packagedIdentityMetadata(archive), manifest.packagedIdentity, 'packaged runtime identity drifted')
  assert.deepStrictEqual(packagedCanonicalManifest(archive), manifest.packagedCanonicalManifest, 'packaged canonical seller manifest drifted')
  const components = asarComponentManifest(archive, path.join(packagePath, 'out'))
  components.bundle = bundleManifest(manifest.candidateAppPath)
  components.codeSignature = verifyCodeSignature(manifest.candidateAppPath)
  assert.deepStrictEqual(components, manifest.components, 'source build/candidate component manifest drifted')
  assert.deepStrictEqual({
    scripts: treeManifest(path.join(packagePath, 'scripts/release')),
    verifierSha256: sha256File(path.join(packagePath, 'scripts/test/verify-seller-release.mjs')),
    recoveryRegressionSha256: sha256File(path.join(packagePath, 'scripts/test/seller-install-recovery-regression.mjs'))
  }, manifest.releaseTools, 'release tooling drifted after manifest creation')
  if (!installedPath && !installationPreflight) assert.deepStrictEqual(installedEvidence(), manifest.installedAppsBeforeCandidate, 'an existing installed app changed during candidate build')
  if (!installedPath) assert(!fs.existsSync(EXPECTED_IDENTITY.bundlePath), 'seller-pilot is already installed; candidate-only plan must not overwrite it')
  const installed = installedPath ? installedTargetEvidence(manifest, installedPath) : null
  return { manifestPath: absolute, manifest, installed }
}

function main() {
  const configOnly = argValue('--config-only')
  const discoverConfig = argValue('--discover-candidate')
  const candidateManifest = argValue('--candidate-manifest')
  const bundleHashPath = argValue('--bundle-hash')
  const installedPath = argValue('--installed')
  const reportOnly = process.argv.includes('--report-only')
  const requireGuiReport = process.argv.includes('--require-gui-report')
  const installedIdentityFlag = process.argv.includes('--installed-identity-report')
  const requireCanonical = process.argv.includes('--require-canonical-manifest')
  const rejectSecondaryDir = argValue('--reject-secondary-dir')
  const installationPreflight = process.argv.includes('--installation-preflight')
  const sandboxDraft = process.argv.includes('--sandbox-draft')
  if (reportOnly || requireGuiReport || installedIdentityFlag) {
    assertStrictReportArguments()
    assert(reportOnly, '--require-gui-report and --installed-identity-report require --report-only')
    assert(candidateManifest, '--report-only requires --candidate-manifest')
    assert(requireGuiReport, '--report-only requires --require-gui-report')
    assert(installedIdentityFlag, '--report-only requires --installed-identity-report')
    assertCanonicalManifest(candidateManifest, { rejectSecondaryDir: rejectSecondaryDir || (requireCanonical ? 'release' : null) })
    const guiReport = strictFlagPath('--require-gui-report')
    const installedIdentityReport = strictFlagPath('--installed-identity-report')
    const result = verifyReportOnly(candidateManifest, guiReport, installedIdentityReport, { rejectSecondaryDir: rejectSecondaryDir || (requireCanonical ? 'release' : null) })
    console.log(JSON.stringify({ ok: true, mode: 'report-only', manifestPath: result.canonical, manifestSha256: result.candidateHash, guiReport: result.gui, installedIdentity: result.installed }, null, 2))
    return
  }
  const modes = [Boolean(configOnly), Boolean(discoverConfig), Boolean(candidateManifest), Boolean(bundleHashPath)].filter(Boolean).length
  assert.equal(modes, 1, 'choose exactly one of --config-only, --discover-candidate, --candidate-manifest or --bundle-hash')

  if (bundleHashPath) {
    const absolute = fs.realpathSync(bundleHashPath)
    assert.equal(path.basename(absolute), `${EXPECTED_IDENTITY.productName}.app`, 'bundle hash mode only accepts the seller-pilot app name')
    assert.equal(plistValue(absolute, 'CFBundleIdentifier'), EXPECTED_IDENTITY.appId, 'bundle hash mode rejected the bundle identifier')
    const signature = verifyCodeSignature(absolute)
    console.log(JSON.stringify({ ok: true, mode: 'bundle-hash', appPath: absolute, bundle: bundleManifest(absolute), signature }, null, 2))
    return
  }

  if (configOnly) {
    const config = validateConfig(configOnly)
    console.log(JSON.stringify({ ok: true, mode: 'config-only', identity: config.identity, configSha256: config.configSha256, iconSha256: config.iconSha256 }, null, 2))
    return
  }
  if (discoverConfig) {
    const writeManifest = argValue('--write-manifest', { required: true })
    const result = discoverCandidate(discoverConfig, writeManifest, { sandboxDraft })
    console.log(JSON.stringify({ ok: true, mode: 'discover-candidate', manifestPath: result.manifestPath, candidateAppPath: result.manifest.candidateAppPath, commit: result.manifest.commit }, null, 2))
    return
  }
  const manifestForVerification = requireCanonical || rejectSecondaryDir ? assertCanonicalManifest(candidateManifest, { rejectSecondaryDir }) : candidateManifest
  const result = verifyManifest(manifestForVerification, { installedPath, installationPreflight })
  console.log(JSON.stringify({ ok: true, mode: installedPath ? 'installed' : (installationPreflight ? 'installation-preflight' : 'candidate-manifest'), manifestPath: result.manifestPath, candidateAppPath: result.manifest.candidateAppPath, commit: result.manifest.commit, installed: result.installed }, null, 2))
}

try {
  main()
} catch (error) {
  console.error(`seller release verification failed: ${error.message}`)
  process.exitCode = 1
}

#!/usr/bin/env node

/**
 * Phase 03 release gate.
 *
 * This runner deliberately does not use a shell pipeline. Every command gets
 * its own process, stdout/stderr file, exit code and status row. A failed or
 * blocked command never prevents the evidence and history checks that follow.
 */

import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const DEFAULT_HISTORY_ROOT = join(PROJECT_ROOT, 'regression/history')
const DEFAULT_ARTIFACT_ROOT = join(PROJECT_ROOT, 'docs/test-reports/artifacts/regression', timestamp())
const NODE = process.execPath
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const STATUS = Object.freeze({ PASS: 'PASS', FAILED: 'FAILED', BLOCKED: 'BLOCKED', NOT_RUN: 'NOT RUN' })

function timestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

function slug(value) {
  return String(value || 'phase-03').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'phase-03'
}

function parseArgs(argv) {
  const result = { stage: 'post', artifactRoot: null, historyRoot: DEFAULT_HISTORY_ROOT }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--stage' || arg === '--artifact-root' || arg === '--history-root') {
      const value = argv[++index]
      if (!value) throw new Error(`${arg} requires a value`)
      const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      result[key] = value
      continue
    }
    if (arg.startsWith('--stage=')) result.stage = arg.slice('--stage='.length)
    else if (arg.startsWith('--artifact-root=')) result.artifactRoot = arg.slice('--artifact-root='.length)
    else if (arg.startsWith('--history-root=')) result.historyRoot = arg.slice('--history-root='.length)
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/test/phase-03-gate.mjs --stage=post|ship-pre|final [--artifact-root PATH] [--history-root PATH]')
      process.exit(0)
    } else throw new Error(`unsupported argument: ${arg}`)
  }
  if (!['post', 'ship-pre', 'final'].includes(result.stage)) throw new Error(`unsupported stage: ${result.stage}`)
  result.artifactRoot = resolve(PROJECT_ROOT, result.artifactRoot || DEFAULT_ARTIFACT_ROOT)
  result.historyRoot = resolve(PROJECT_ROOT, result.historyRoot)
  return result
}

function mkdirs(paths) {
  for (const path of paths) mkdirSync(path, { recursive: true })
}

function redact(value) {
  return String(value ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(authorization|cookie|set-cookie|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|token)(\s*[:=]\s*)([^\s,;"']+)/gi, '$1$2[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    // Keep repository-relative paths useful while hiding absolute executor
    // paths from command/cwd/argv/relatedArtifacts and child-process output.
    .replace(/\/Users\/[^\/\s"'<>]+(?:\/[^\s"'<>]*)?/g, '/Users/[REDACTED_USER]/[REDACTED_PATH]')
    .replace(/\\Users\\[^\\\s"'<>]+(?:\\[^\s"'<>]*)?/g, '\\Users\\[REDACTED_USER]\\[REDACTED_PATH]')
    .replace(/\/Volumes\/[^\/\s"'<>]+(?:\/[^\s"'<>]*)?/g, '/Volumes/[REDACTED_VOLUME]/[REDACTED_PATH]')
    .replace(/\\Volumes\\[^\\\s"'<>]+(?:\\[^\s"'<>]*)?/g, '\\Volumes\\[REDACTED_VOLUME]\\[REDACTED_PATH]')
}

function safeWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, redact(content), { encoding: 'utf8', mode: 0o600 })
}

function jsonWrite(path, value) {
  safeWrite(path, `${JSON.stringify(value, null, 2)}\n`)
}

function sha256(path) {
  if (!existsSync(path) || !statSync(path).isFile()) return null
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fileList(root, matcher = () => true) {
  if (!existsSync(root)) return []
  const output = []
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && matcher(path)) output.push(path)
    }
  }
  visit(root)
  return output.sort()
}

function command(id, label, args, options = {}) {
  return {
    id,
    label,
    command: options.command || NODE,
    args,
    group: options.group || 'phase-03',
    required: options.required !== false,
    blockedReason: options.blockedReason || null,
    relatedArtifacts: options.relatedArtifacts || args.filter((arg) => /[\\/]/.test(arg)),
    cwd: options.cwd || PROJECT_ROOT,
    timeoutMs: options.timeoutMs || 300000
  }
}

const GATE_A = [
  command('browser.provider.contract', '服务器浏览器 Provider 合同', ['scripts/test/browser-provider-contract-regression.mjs'], { group: 'h5-transport' }),
  command('nginx.sse.config', 'Nginx SSE 实时通道配置', ['scripts/test/nginx-sse-regression.mjs'], { group: 'h5-transport' }),
  command('systemd.deployment.config', 'systemd 服务器部署配置', ['scripts/test/systemd-deployment-regression.mjs'], { group: 'release' }),
  command('h5.server.ai', 'H5 服务器 AI transport', ['scripts/test/server-ai-regression.mjs'], { group: 'h5-transport' }),
  command('wms.sync.lifecycle', '常驻 API 同步生命周期', ['scripts/test/wms-sync-service-regression.mjs'], { group: 'wms-sync' }),
  command('wms.persistence.migration', '受保护配置与迁移', ['scripts/test/wms-persistence-migration-regression.mjs'], { group: 'wms-sync' }),
  command('wms.backup.restore', '备份/恢复/重新水合', ['scripts/test/wms-backup-restore-regression.mjs'], { group: 'release' }),
  command('wms.mcp.security', 'MCP SSRF 与分页边界', ['scripts/test/wms-mcp-ssrf-pagination-regression.mjs'], { group: 'wms-sync' }),
  command('wms.projection', 'API-SPU 与 Excel 统一投影', ['scripts/test/wms-unified-projection-regression.mjs'], { group: 'api-spu' }),
  command('wms.scale.10k', '一万 SPU 去重与分页', ['scripts/test/wms-10k-scale-regression.mjs'], { group: 'api-spu' }),
  command('wms.correction.writeback', '异常修正与名称回写', ['scripts/test/wms-correction-writeback-regression.mjs'], { group: 'correction' }),
  command('api-spu.correction', 'API-SPU 修正合同', ['scripts/test/api-spu-correction-regression.mjs'], { group: 'correction' }),
  command('api.writeback.allowlist', '写回字段白名单', ['scripts/test/api-writeback-gate-regression.mjs'], { group: 'correction' }),
  command('price.preview.policy', 'price-policy-v1 预览', ['scripts/test/price-candidate-preview-regression.mjs'], { group: 'price' }),
  command('price.apply.gate', '价格回写零调用门禁', ['scripts/test/price-apply-gate-regression.mjs'], { group: 'price' }),
  command('api.price.contract', 'Listing 价格版本合同', ['scripts/test/api-price-contract-regression.mjs'], { group: 'price' }),
  command('wms.ipc.contract', 'IPC 脱敏与输入校验', ['scripts/test/wms-ipc-contract-regression.mjs'], { group: 'ipc-ui' }),
  command('spu.ui.observability', 'API-SPU/行情 UI 可观察性', ['scripts/test/spu-ui-observability-regression.mjs'], { group: 'ipc-ui' })
]

const HISTORICAL = [
  ['test.regression', 'test:regression', 'regression'],
  ['test.search', 'test:search', 'search'],
  ['test.search.keywords', 'test:search-keywords', 'search'],
  ['test.auth', 'test:auth', 'auth'],
  ['test.price', 'test:price', 'price'],
  ['test.price.display', 'test:price-display', 'price'],
  ['test.price.preview.legacy', 'test:price-preview', 'price'],
  ['test.task.snapshot.history', 'test:taDEMO_ONLY_REDACTED', 'task-store'],
  ['test.task.template', 'test:task-template', 'task-store'],
  ['test.task.alias.slots', 'test:task-alias-slots', 'task-store'],
  ['test.spu.data', 'test:spu-data', 'api-spu'],
  ['test.spu.ui', 'test:spu-ui', 'ipc-ui'],
  ['test.category.search', 'test:category-search', 'search'],
  ['test.category.search.rules', 'test:category-search-rules', 'search'],
  ['test.task.derived.names', 'test:task-derived-names', 'search'],
  ['test.wms.match', 'test:wms', 'api-spu'],
  ['test.api.spu.correction', 'test:api-spu-correction', 'correction'],
  ['test.api.writeback', 'test:api-writeback-gate', 'correction'],
  ['test.api.spu.live.source', 'test:api-spu-live-source', 'api-spu'],
  ['test.prices.history.ui', 'test:prices-history-ui', 'price'],
  ['test.resume', 'test:resume', 'task-store'],
  ['test.queues', 'test:queues', 'task-store'],
  ['test.seller.delivery', 'test:seller-delivery', 'release'],
  ['test.seller.release', 'test:seller-release', 'release'],
  ['build', 'build', 'release']
].map(([id, script, group]) => command(id, `历史 ${script}`, ['run', script], { command: NPM, group }))

function existsFormalApp() {
  return process.platform === 'darwin' && existsSync('/Applications/闲鱼卖家巡航台.app')
}

function hasDesktopSession() {
  if (process.platform === 'darwin') return Boolean(process.env.DISPLAY || process.env.__CFBundleIdentifier || process.env.SSH_TTY === undefined)
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
}

function hasPrivateCredential() {
  return Boolean(process.env.WMS_ADMIN_TOKEN || process.env.WMS_ADMIN_PASSWORD || process.env.WMS_API_KEY)
}

function buildShipPre(context) {
  // The recovery regression resolves paths from the workspace parent, while
  // the gate itself runs inside the project. Pass absolute paths so the same
  // manifest/report is used by every release step instead of silently looking
  // in /Volumes/Data/行政管理.
  const manifest = join(PROJECT_ROOT, 'release-seller-pilot/seller-pilot-release.json')
  const identity = context.installedIdentityReportPath
  const gui = context.guiReportPath
  const releaseGuard = (runContext) => releaseIdentityBlockReason(runContext)
  return [
    command('release.clean-worktree', '固定提交与干净工作树', ['status', '--short'], { command: 'git', group: 'release', blockedReason: () => gitIsDirty() ? '当前工作树存在用户/阶段修改，正式 package 必须使用固定干净提交' : null }),
    command('release.npm-ci', '锁文件安装', ['ci'], { command: NPM, group: 'release', blockedReason: () => gitIsDirty() ? '当前工作树未清洁；不在用户工作树执行正式 npm ci 链路' : null }),
    command('release.canonical-build', 'canonical release 构建', ['scripts/release/build-seller-pilot.mjs', '--commit', 'HEAD'], { group: 'release', blockedReason: () => gitIsDirty() ? 'canonical build 需要固定干净提交' : null }),
    command('release.sandbox.identity.prepare', '隔离安装身份证据', ['scripts/test/seller-install-recovery-regression.mjs', '--prepare-gui', '--candidate-manifest', manifest, '--installed-identity-report', identity], { group: 'release', relatedArtifacts: [manifest, identity], blockedReason: (runContext) => releaseGuard(runContext) || (!existsSync(manifest) ? 'canonical manifest 不存在' : null) }),
    command('release.manifest.verify', 'canonical manifest 身份', ['scripts/test/verify-seller-release.mjs', '--candidate-manifest', manifest, '--report-only', '--require-canonical-manifest', '--require-gui-report', gui, '--installed-identity-report', identity], { group: 'release', relatedArtifacts: [manifest, gui, identity], blockedReason: (runContext) => releaseGuard(runContext) || (!existsSync(manifest) ? 'canonical manifest 不存在' : (!existsSync(identity) ? '隔离安装身份报告不存在' : (!existsSync(gui) ? '正式 GUI report 不存在；fixture 不得替代正式证据' : null))) }),
    command('release.install.sandbox', '隔离安装回归', ['scripts/test/seller-install-recovery-regression.mjs', '--install-sandbox', '--candidate-manifest', manifest], { group: 'release', blockedReason: (runContext) => releaseGuard(runContext) || (!existsSync(manifest) ? 'canonical manifest 不存在' : null) }),
    command('release.sandbox.identity.cleanup', '清理隔离安装身份证据', ['scripts/test/seller-install-recovery-regression.mjs', '--cleanup', '--installed-identity-report', identity], { group: 'release', relatedArtifacts: [identity], blockedReason: () => !existsSync(context.installedIdentityReportPath) ? '本次 run 没有可清理的隔离安装身份报告' : null }),
    command('release.migration.regression', '迁移/回滚/重新水合', ['scripts/test/seller-install-recovery-regression.mjs', '--migration'], { group: 'release' })
  ]
}

function buildFinal(context) {
  const releaseGuard = (runContext) => releaseIdentityBlockReason(runContext)
  return [
    command('formal.installed.identity', '正式安装包身份', ['scripts/test/verify-seller-release.mjs', '--candidate-manifest', 'release-seller-pilot/seller-pilot-release.json', '--installed', '/Applications/闲鱼卖家巡航台.app'], { group: 'formal-gui', blockedReason: (runContext) => releaseGuard(runContext) || (!existsFormalApp() ? '正式安装路径不存在' : null) }),
    command('formal.wms.credential', '私有 ADMIN 上游凭据', ['scripts/test/api-spu-live-source-regression.mjs'], { group: 'upstream', blockedReason: () => !hasPrivateCredential() ? '未配置私有 ADMIN 凭据' : null }),
    command('formal.gui.smoke', '正式安装 GUI/Midscene', ['tests/e2e/midscene/wms-background-sync-smoke.mjs'], { group: 'formal-gui', blockedReason: (runContext) => releaseGuard(runContext) || (!existsFormalApp() || !hasDesktopSession() ? '正式安装包或桌面会话不可用' : null) }),
    command('formal.clean-exit.relaunch', '正式退出/重启/数据读回', ['tests/e2e/midscene/wms-background-sync-smoke.mjs', '--formal-relaunch'], { group: 'formal-gui', blockedReason: (runContext) => releaseGuard(runContext) || (!existsFormalApp() || !hasDesktopSession() ? '正式安装包或桌面会话不可用' : null) }),
    command('formal.price.contract', '正式 listing 版本合同', ['scripts/test/api-price-contract-regression.mjs'], { group: 'upstream', blockedReason: () => !hasPrivateCredential() ? '未配置私有 ADMIN 凭据，无法证明真实 listing 合同' : null })
  ]
}

function gitIsDirty() {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: PROJECT_ROOT, encoding: 'utf8' })
  return result.status !== 0 || Boolean(String(result.stdout || '').trim())
}

function readGitHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout || '').trim() : null
}

function releaseIdentityBlockReason(context) {
  if (gitIsDirty()) return '当前工作树未清洁；release manifest/installed identity 必须绑定固定提交'
  const manifestPath = join(PROJECT_ROOT, 'release-seller-pilot/seller-pilot-release.json')
  if (!existsSync(manifestPath)) return 'canonical manifest 不存在'
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    return 'canonical manifest 不是有效 JSON'
  }
  const fixedCommit = context.fixedCommit || readGitHead()
  if (!fixedCommit) return '无法读取当前固定提交'
  if (manifest.commit !== fixedCommit) {
    return 'canonical manifest commit 未绑定当前固定提交（manifest=' + (manifest.commit || 'missing') + '）'
  }
  if (manifest.buildWorkspacePath && resolve(manifest.buildWorkspacePath) !== PROJECT_ROOT) {
    return 'canonical manifest buildWorkspacePath 未绑定当前项目'
  }
  return null
}

function pathsFromHistory(root) {
  return fileList(root, (path) => path.endsWith('.md')).map((path) => ({ path, text: redact(readFileSync(path, 'utf8')) }))
}

function historyDocuments(historyRoot) {
  return [
    ...pathsFromHistory(historyRoot),
    ...pathsFromHistory(join(PROJECT_ROOT, 'docs/test-reports/regression-history')),
    ...fileList(join(PROJECT_ROOT, 'docs/incident-reports'), (path) => /BUG-[^/]+\.md$/i.test(path)).map((path) => ({ path, text: redact(readFileSync(path, 'utf8')) }))
  ]
}

function groupsForText(source) {
  const groups = new Set()
  const groupNeedles = {
    'h5-transport': ['h5', 'transport', 'server-ai', '联网核查', '人工确认'],
    'wms-sync': ['wms-sync', 'sync-service', 'persistence', 'mcp', '常驻', '同步'],
    'api-spu': ['api-spu', 'spu', 'projection', '库存'],
    correction: ['correction', 'writeback', '回写', '复核', 'requeue'],
    price: ['price', 'listing', '行情', '价格'],
    'ipc-ui': ['ipc', 'ui', 'renderer', '界面', 'workbench', '工作台'],
    release: ['release', 'install', 'migration', 'rehydrat', '安装', '迁移'],
    'formal-gui': ['midscene', 'gui', '正式安装', 'relaunch', '重启']
  }
  for (const [group, needles] of Object.entries(groupNeedles)) if (needles.some((needle) => source.toLowerCase().includes(needle.toLowerCase()))) groups.add(group)
  return groups
}

function historyGroups(documents) {
  const groups = new Set()
  let metadataMissing = false
  for (const document of documents) {
    const metadata = document.text.match(/(?:^|\n)\s*[-*]?\s*(?:changed_files|command_ids|route|routes?)\s*:\s*(.+?)(?=\n\s*[-*]?\s*\w[\w-]*\s*:|\n##|$)/gis)
    if (!metadata?.length) {
      metadataMissing = true
      continue
    }
    const matched = groupsForText(metadata.map((match) => match[1]).join('\n'))
    if (!matched.size) metadataMissing = true
    for (const group of matched) groups.add(group)
  }
  return { groups, metadataMissing }
}

function selectHistoryReplay(documents) {
  const history = historyGroups(documents)
  const knownGroups = new Set([...GATE_A, ...HISTORICAL].map((item) => item.group))
  if (!documents.length || history.metadataMissing || !history.groups.size) return { mode: 'full', groups: knownGroups, reason: documents.length ? 'history metadata missing or unmapped; replay full applicable Gate A' : 'no prior history; initial full applicable Gate A' }
  return { mode: 'changed-path', groups: history.groups, reason: 'changed_files/route/command_ids mapped to affected command groups' }
}

function historyCommands(replay) {
  const source = [...GATE_A, ...HISTORICAL]
  const selected = source.filter((item) => replay.groups.has(item.group))
  return selected.map((item) => ({ ...item, id: `history.replay.${item.id}`, label: `历史回放 ${item.label}` }))
}

function resultStatus(exitCode, blockedReason, required) {
  if (blockedReason) return STATUS.BLOCKED
  if (!required) return STATUS.NOT_RUN
  if (exitCode === 0) return STATUS.PASS
  return STATUS.FAILED
}

function parseLastJson(stdout) {
  const lines = String(stdout || '').trim().split('\n').map((line) => line.trim()).filter(Boolean).reverse()
  for (const line of lines) {
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object' && !Array.isArray(value)) return value
    } catch {
      // A child process may print a human-readable prefix before JSON.
    }
  }
  return null
}

function structuredBlockReason(item, stdout, stderr, exitCode) {
  const text = `${stdout}\n${stderr}`
  if (item.id === 'formal.gui.smoke' || item.id === 'formal.clean-exit.relaunch') {
    const report = parseLastJson(stdout)
    if (report?.formalInstalledGui && report.formalInstalledGui !== 'PASS') {
      return `formal GUI evidence reports formalInstalledGui=${report.formalInstalledGui}`
    }
    if (report?.mode === 'development-fixture-contract') {
      return 'formal GUI command only produced a development-fixture-contract result'
    }
    if (report?.status === 'BLOCKED' || report?.blocked === true) {
      return 'formal GUI command produced an explicit BLOCKED result'
    }
    if (exitCode === 0 && report?.formalInstalledGui !== 'PASS') {
      return 'formal GUI command did not provide formalInstalledGui=PASS evidence'
    }
  }
  if (item.id === 'release.manifest.verify' && /(requires --require-gui-report|GUI report.*missing|installed identity report.*missing|release workspace commit drift|worktree.*dirty|manifest.*drift)/i.test(text)) {
    return 'release manifest evidence is unavailable or not bound to the fixed commit'
  }
  if (item.id === 'formal.installed.identity' && /(installed app bundle differs|release workspace commit drift|seller-pilot is already installed|installed path.*missing|candidate manifest.*missing)/i.test(text)) {
    return 'installed app identity is not the current canonical candidate; formal installation evidence is unavailable'
  }
  return null
}

function runCommand(item, context, sequence) {
  const startedAt = new Date().toISOString()
  const started = Date.now()
  const base = `${String(sequence).padStart(3, '0')}-${slug(item.id)}`
  const stdoutPath = join(context.artifactRoot, 'stdout', `${base}.log`)
  const stderrPath = join(context.artifactRoot, 'stderr', `${base}.log`)
  const preflightReason = typeof item.blockedReason === 'function' ? item.blockedReason(context) : item.blockedReason
  let execution = { status: null, stdout: '', stderr: '' }
  if (!preflightReason) {
    execution = spawnSync(item.command, item.args, {
      cwd: item.cwd,
      encoding: 'utf8',
      env: process.env,
      timeout: item.timeoutMs,
      maxBuffer: 40 * 1024 * 1024
    })
  } else {
    execution.stdout = `BLOCKED: ${preflightReason}\n`
    execution.stderr = ''
  }
  const stdout = redact(execution.stdout || '')
  const stderr = redact(execution.stderr || execution.error?.message || '')
  safeWrite(stdoutPath, stdout)
  safeWrite(stderrPath, stderr)
  const exitCode = preflightReason ? null : (typeof execution.status === 'number' ? execution.status : 1)
  const observedBlockReason = preflightReason ? null : structuredBlockReason(item, stdout, stderr, exitCode)
  const resolvedReason = preflightReason || observedBlockReason
  const status = resultStatus(exitCode, resolvedReason, item.required)
  const row = {
    sequence,
    id: item.id,
    label: item.label,
    group: item.group,
    stage: context.stage,
    command: redact(item.command),
    argv: item.args.map((arg) => redact(arg)),
    cwd: redact(relative(PROJECT_ROOT, item.cwd) || '.'),
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    exitCode,
    signal: execution.signal || null,
    status,
    blockedReason: resolvedReason || null,
    stdoutPath: relative(PROJECT_ROOT, stdoutPath),
    stderrPath: relative(PROJECT_ROOT, stderrPath),
    relatedArtifacts: item.relatedArtifacts.map((artifact) => redact(artifact)),
    outputSha256: sha256(stdoutPath),
    errorSha256: sha256(stderrPath)
  }
  appendFileSync(context.commandsPath, `${redact(JSON.stringify(row))}\n`)
  context.results.push(row)
  return row
}

function runArtifactSecurityScan(context) {
  const rules = [
    ['home-path', /\/Users\/(?!\[REDACTED_USER\])[^/\s"'<>]+/],
    ['volume-path', /\/Volumes\/(?!\[REDACTED_VOLUME\])[^/\s"'<>]+/],
    ['url', /https?:\/\/(?!\[REDACTED_URL\])/i],
    ['bearer', /Bearer\s+(?!\[REDACTED\])\S+/i],
    ['credential-value', /(?:password|passwd|secret|token|cookie|authorization|api[-_]?key)\s*[:=]\s*(?!\[REDACTED\])[^,\s"']+/i],
    ['query-secret', /[?&](?:token|key|secret|password|cookie|authorization)=([^&\s"']+)/i],
    ['fixture-secret', /fixture-(?:cookie|token)-secret/i]
  ]
  const findings = []
  for (const file of fileList(context.artifactRoot)) {
    const original = readFileSync(file, 'utf8')
    const text = redact(original)
    if (text !== original) writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 })
    for (const [rule] of rules) {
      const expression = rules.find(([name]) => name === rule)[1]
      if (expression.test(text)) findings.push({ rule, path: relative(PROJECT_ROOT, file) })
    }
  }
  const sequence = context.results.length + 1
  const stdoutPath = join(context.artifactRoot, 'stdout', `${String(sequence).padStart(3, '0')}-evidence-security-scan.log`)
  const stderrPath = join(context.artifactRoot, 'stderr', `${String(sequence).padStart(3, '0')}-evidence-security-scan.log`)
  const status = findings.length ? STATUS.FAILED : STATUS.PASS
  safeWrite(stdoutPath, JSON.stringify({ status, checked: fileList(context.artifactRoot).length, findings: findings.map(({ rule, path }) => ({ rule, path })) }, null, 2) + '\n')
  safeWrite(stderrPath, '')
  const row = {
    sequence,
    id: 'evidence.security.scan',
    label: '证据脱敏与伪 secret/path/query 扫描',
    group: 'release',
    stage: context.stage,
    command: '[internal-artifact-security-scan]',
    argv: [],
    cwd: '.',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    exitCode: findings.length ? 1 : 0,
    signal: null,
    status,
    blockedReason: null,
    stdoutPath: relative(PROJECT_ROOT, stdoutPath),
    stderrPath: relative(PROJECT_ROOT, stderrPath),
    relatedArtifacts: [relative(PROJECT_ROOT, context.artifactRoot)],
    outputSha256: sha256(stdoutPath),
    errorSha256: sha256(stderrPath)
  }
  appendFileSync(context.commandsPath, `${redact(JSON.stringify(row))}\n`)
  context.results.push(row)
  return row
}

function currentChangedFiles() {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd: PROJECT_ROOT, encoding: 'utf8' })
  return String(result.stdout || '').split('\n').map((line) => line.slice(3).trim()).filter(Boolean).map((path) => redact(path))
}

function writeHistory(context, replay, documents) {
  const historyPath = join(context.historyRoot, `phase-03-api-spu-${context.runTimestamp}.md`)
  const statuses = context.results.map((row) => `| ${row.id} | ${row.status} | ${row.exitCode ?? '—'} | ${row.durationMs}ms |`).join('\n')
  const body = `# Phase 03 Gate ${context.runTimestamp}\n\n- stage: ${context.stage}\n- run_timestamp: ${context.runTimestamp}\n- changed_files: ${JSON.stringify(currentChangedFiles())}\n- command_ids: ${JSON.stringify(context.results.map((row) => row.id))}\n- replay_reason: ${replay.reason}\n- prior_history_documents: ${documents.length}\n- artifact_root: ${relative(PROJECT_ROOT, context.artifactRoot)}\n\n## Status\n\n| command_id | status | exit_code | duration |\n|---|---|---:|---:|\n${statuses}\n\nThis entry is append-only. Runtime logs are sanitized and live under the run-scoped artifact root. BLOCKED and NOT RUN are never PASS.\n`
  safeWrite(historyPath, body)
  return historyPath
}

function writeBug(context, historyPath) {
  if (!context.results.some((row) => row.status === STATUS.FAILED)) return null
  const bugPath = join(context.historyRoot, `BUG-${context.runTimestamp}-${slug(context.stage)}.md`)
  const failed = context.results.filter((row) => row.status === STATUS.FAILED)
  const body = `# Phase 03 Gate BUG ${context.runTimestamp}\n\n- status: FAILED\n- stage: ${context.stage}\n- changed_files: ${JSON.stringify(currentChangedFiles())}\n- history_entry: ${relative(PROJECT_ROOT, historyPath)}\n- artifact_root: ${relative(PROJECT_ROOT, context.artifactRoot)}\n\n## Failed commands\n\n${failed.map((row) => `- ${row.id}: exit ${row.exitCode}; stdout=${row.stdoutPath}; stderr=${row.stderrPath}`).join('\n')}\n\n## Repair loop\n\nDiagnose the owning command, repair the product or test, rerun the failed command, then rerun affected history before the complete matrix. This report contains no credentials or raw private URLs.\n`
  safeWrite(bugPath, body)
  const supplementPath = join(PROJECT_ROOT, 'docs/incident-reports', `BUG-${context.runTimestamp}-${slug(context.stage)}.md`)
  safeWrite(supplementPath, body.replace('## Repair loop', '## Sanitized supplement\n\nRoot regression/history is authoritative.\n\n## Repair loop'))
  return bugPath
}

function finalStatus(results) {
  if (results.some((row) => row.status === STATUS.FAILED)) return 1
  if (results.some((row) => row.status === STATUS.BLOCKED || row.status === STATUS.NOT_RUN)) return 2
  return 0
}

function appendPhaseReportIndex(context, summary) {
  const reportPath = join(PROJECT_ROOT, 'docs/test-reports/phase-03-api-spu.md')
  const counts = Object.entries(summary.counts).map(([status, count]) => `${status}=${count}`).join(', ')
  const section = `\n\n## Gate run index ${context.runTimestamp}\n\n- stage: ${context.stage} (post/ship-pre is not the final release decision)\n- final_summary: ${summary.status}; exit_code=${summary.exitCode}\n- status_counts: ${counts}\n- artifact_root: ${summary.artifactRoot}\n- history_entry: ${summary.historyPath}\n- bug_entry: ${summary.bugPath || 'none'}\n- release_identity: ${context.fixedCommit || 'unavailable'}\n\nThis index is append-only. PASS is reserved for executed evidence; FAILED, BLOCKED, and NOT RUN remain explicit and are not promoted by a later non-final run.\n`
  mkdirSync(dirname(reportPath), { recursive: true })
  appendFileSync(reportPath, redact(section))
}

function run() {
  const options = parseArgs(process.argv.slice(2))
  mkdirs([
    options.artifactRoot,
    join(options.artifactRoot, 'stdout'),
    join(options.artifactRoot, 'stderr'),
    join(options.artifactRoot, 'screenshots'),
    join(options.artifactRoot, 'manifests'),
    options.historyRoot
  ])
  const context = {
    ...options,
    runTimestamp: basename(options.artifactRoot),
    fixedCommit: readGitHead(),
    installedIdentityReportPath: join(options.artifactRoot, 'installed-identity.json'),
    guiReportPath: join(options.artifactRoot, 'seller-gui-report.json'),
    commandsPath: join(options.artifactRoot, 'commands.jsonl'),
    results: []
  }
  const documents = historyDocuments(options.historyRoot)
  const replay = selectHistoryReplay(documents)
  const shipPre = options.stage === 'ship-pre' || options.stage === 'final' ? buildShipPre(context) : []
  // A clean checkout has no node_modules yet. Bootstrap the locked
  // dependency tree before replaying history or Gate A; otherwise every
  // command fails with MODULE_NOT_FOUND and the later npm ci result is too
  // late to be useful. The clean-worktree guard still runs first and keeps
  // user worktrees fail-closed without running npm ci over their changes.
  const dependencyBootstrap = shipPre.filter((item) => ['release.clean-worktree', 'release.npm-ci'].includes(item.id))
  const remainingShipPre = shipPre.filter((item) => !dependencyBootstrap.includes(item))
  const plan = [...dependencyBootstrap, ...historyCommands(replay), ...GATE_A, ...remainingShipPre, ...(options.stage === 'final' ? buildFinal(context) : [])]
  const unique = []
  const seen = new Set()
  for (const item of plan) {
    const key = `${item.id}:${item.command}:${item.args.join('\u0000')}`
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(item)
    }
  }
  for (const [index, item] of unique.entries()) runCommand(item, context, index + 1)
  runArtifactSecurityScan(context)

  const historyPath = writeHistory(context, replay, documents)
  const bugPath = writeBug(context, historyPath)
  const counts = Object.fromEntries(Object.values(STATUS).map((status) => [status, context.results.filter((row) => row.status === status).length]))
  const exitCode = finalStatus(context.results)
  const summary = {
    schemaVersion: 1,
    gate: 'phase-03-api-spu',
    stage: options.stage,
    runTimestamp: context.runTimestamp,
    startedAt: context.results[0]?.startedAt || new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode,
    status: exitCode === 0 ? STATUS.PASS : exitCode === 1 ? STATUS.FAILED : STATUS.BLOCKED,
    replay,
    historyDocuments: documents.map((doc) => relative(PROJECT_ROOT, doc.path)),
    artifactRoot: relative(PROJECT_ROOT, options.artifactRoot),
    historyPath: relative(PROJECT_ROOT, historyPath),
    bugPath: bugPath ? relative(PROJECT_ROOT, bugPath) : null,
    counts,
    commands: context.results.map((row) => ({ id: row.id, status: row.status, exitCode: row.exitCode }))
  }
  jsonWrite(join(options.artifactRoot, 'summary.json'), summary)
  jsonWrite(join(options.artifactRoot, 'manifests', 'artifact-manifest.json'), {
    schemaVersion: 1,
    runTimestamp: context.runTimestamp,
    files: fileList(options.artifactRoot).map((path) => ({ path: relative(PROJECT_ROOT, path), sha256: sha256(path) }))
  })
  appendPhaseReportIndex(context, summary)
  console.log(JSON.stringify({
    gate: summary.gate,
    stage: summary.stage,
    status: summary.status,
    exitCode,
    counts,
    artifactRoot: summary.artifactRoot,
    historyPath: summary.historyPath,
    bugPath: summary.bugPath
  }, null, 2))
  process.exitCode = exitCode
}

try {
  run()
} catch (error) {
  console.error(redact(error instanceof Error ? error.stack || error.message : String(error)))
  process.exitCode = 1
}

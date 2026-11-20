import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { runCommand } = require('../../server/browser/command-runner.js')
const { createAdsPowerProvider } = require('../../server/browser/adspower-provider.js')
const { createCamoufoxProvider } = require('../../server/browser/camoufox-provider.js')
const { createProviderFromConfig } = require('../../server/browser/provider-registry.js')
const { BrowserProviderError } = require('../../server/browser/provider.js')

const sleep = promisify(setTimeout)

async function main() {
  const command = await runCommand(process.execPath, ['-e', 'process.stdout.write("ok"); process.stderr.write("warn")'])
  assert.equal(command.code, 0)
  assert.equal(command.stdout, 'ok')
  assert.equal(command.stderr, 'warn')

  await assert.rejects(() => runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { timeoutMs: 25 }), error => error.code === 'command_timeout')
  const nonZero = await runCommand(process.execPath, ['-e', 'process.exit(7)'])
  assert.equal(nonZero.code, 7)
  await assert.rejects(() => runCommand(process.execPath, ['-e', 'process.exit(7)'], { rejectOnNonZero: true }), error => error.code === 'command_failed')
  const secretResult = await runCommand(process.execPath, ['-e', 'process.stderr.write("secret-token")'], { secrets: ['secret-token'] })
  assert.equal(secretResult.stderr, '[REDACTED]')

  assert.throws(() => createProviderFromConfig({ provider: 'electron' }), error => error.code === 'provider_not_allowed')
  const fake = createProviderFromConfig({ provider: 'fake' })
  assert.equal(fake.name, 'fake')

  const calls = []
  const adspower = createAdsPowerProvider({
    apiKey: 'DEMO_ONLY_REDACTED',
    request: async (url, options) => {
      calls.push({ url, options })
      if (url.includes('/start')) return { ok: true, status: 200, body: { code: 0, data: { browser_id: 'b1', debug_endpoint: '127.0.0.1:9222' } } }
      if (url.includes('/stop')) return { ok: true, status: 200, body: { code: 0 } }
      return { ok: true, status: 200, body: { code: 0, data: { list: [] } } }
    },
    transport: { navigate: async (page, url) => ({ ok: true, page, url }), evaluate: async (_page, expression) => ({ expression }) }
  })
  const health = await adspower.health()
  assert.equal(health.ok, true)
  const session = await adspower.openSession({ profileId: 'profile-1' })
  assert.equal(session.debugEndpoint, 'http://127.0.0.1:9222')
  const page = await adspower.getPage(session)
  assert.deepEqual(await adspower.navigate(page, 'https://example.test'), { ok: true, page, url: 'https://example.test' })
  assert.deepEqual(await adspower.evaluate(page, '1+1'), { expression: '1+1' })
  await adspower.closeSession(session)
  assert.deepEqual(await adspower.closeSession(session), { ok: true, alreadyClosed: true })
  const cliResult = await adspower.runCli(['-e', 'process.stderr.write("secret-api-key")'], { command: process.execPath })
  assert.equal(cliResult.stderr, '[REDACTED]')

  let connected = false
  const cdpProvider = createAdsPowerProvider({
    request: async url => url.includes('/start') ? { ok: true, status: 200, body: { code: 0, data: { browser_id: 'cdp-1', debug_endpoint: 'http://127.0.0.1:9333' } } } : { ok: true, status: 200, body: { code: 0 } },
    playwright: { chromium: { connectOverCDP: async endpoint => { connected = endpoint === 'http://127.0.0.1:9333'; return { contexts: () => [{ pages: () => [{ goto: async () => {}, evaluate: async expression => expression }] }], close: async () => {} } } } }
  })
  const cdpSession = await cdpProvider.openSession({ profileId: 'cdp-profile' })
  const cdpPage = await cdpProvider.getPage(cdpSession)
  await cdpProvider.navigate(cdpPage, 'https://example.test')
  assert.equal(await cdpProvider.evaluate(cdpPage, '1+1'), '1+1')
  await cdpProvider.closeSession(cdpSession)
  assert.equal(connected, true)

  let closed = false
  const camoufox = createCamoufoxProvider({
    launchPersistentContext: async options => ({
      options,
      pages: () => [{ goto: async _url => {}, evaluate: async expression => ({ expression }), mouse: { wheel: async () => {} } }],
      close: async () => { closed = true }
    })
  })
  const camSession = await camoufox.openSession({ profileId: 'cam-1', userDataDir: './server-data/test-camoufox', proxy: { server: 'http://proxy.test:8080', username: 'user', password: 'DEMO_ONLY_REDACTED' } })
  const camPage = await camoufox.getPage(camSession)
  assert.equal((await camoufox.navigate(camPage, 'https://example.test')).ok, true)
  assert.deepEqual(await camoufox.evaluate(camPage, 'document.title'), { expression: 'document.title' })
  assert.equal((await camoufox.scroll(camPage, 240)).ok, true)
  assert.deepEqual(camSession.context.options.proxy, { server: 'http://proxy.test:8080', username: 'user', password: 'DEMO_ONLY_REDACTED' })
  await camoufox.closeSession(camSession)
  assert.equal(closed, true)

  const cliCalls = []
  const healthCalls = []
  const cliHealthProvider = createCamoufoxProvider({
    useCli: true,
    runtimeVersionCheck: () => true,
    commandRunner: async (command, args) => { healthCalls.push({ command, args }); return { code: 0, stdout: '0.7.3\n', stderr: '' } }
  })
  assert.deepEqual((await cliHealthProvider.health()).ok, true)
  assert.deepEqual(healthCalls[0].args, ['--version'])
  const unsupportedCli = createCamoufoxProvider({ useCli: true, runtimeVersionCheck: () => false, commandRunner: async () => ({ code: 0, stdout: '0.7.3' }) })
  assert.equal((await unsupportedCli.health()).error, 'camoufox-cli runtime requires Node.js 22+')
  const missingBrowserRuntime = createCamoufoxProvider({
    useCli: true,
    requireInstalledRuntime: true,
    installDir: '/Volumes/ChatGPT/Codex-External/camoufox-runtime-contract-missing',
    runtimeVersionCheck: () => true,
    commandRunner: async () => ({ code: 0, stdout: '0.7.3\n' })
  })
  const missingBrowserHealth = await missingBrowserRuntime.health()
  assert.equal(missingBrowserHealth.ok, false)
  assert.equal(missingBrowserHealth.runtimeInstalled, false)
  const cliFailure = createCamoufoxProvider({ useCli: true, runtimeVersionCheck: () => true, commandRunner: async () => ({ code: 0, stdout: JSON.stringify({ id: 'r1', success: false, error: 'simulated' }) }) })
  await assert.rejects(() => cliFailure.openSession({ profileId: 'cli-failure' }), error => error.code === 'camoufox_cli_failed')
  const camoufoxCli = createCamoufoxProvider({
    useCli: true,
    runtimeVersionCheck: () => true,
    proxyMap: { 'server-cam-cli': 'http://proxy-user:897aba84c3@example.invalid:8080' },
    commandRunner: async (command, args) => {
      cliCalls.push({ command, args })
      if (args.includes('screenshot')) return { code: 0, stdout: JSON.stringify({ id: 'r1', success: true, data: { mimeType: 'image/png', base64: 'aGVsbG8=' } }), stderr: '' }
      if (args.includes('snapshot')) return { code: 0, stdout: JSON.stringify({ id: 'r1', success: true, data: { snapshot: '- button "Login" [ref=e1]' } }), stderr: '' }
      if (args.includes('eval')) return { code: 0, stdout: JSON.stringify({ id: 'r1', success: true, data: { result: 'Login' } }), stderr: '' }
      return { code: 0, stdout: JSON.stringify({ id: 'r1', success: true, data: { ok: true } }), stderr: '' }
    }
  })
  assert.throws(() => createCamoufoxProvider({ proxyMap: { bad: 'ftp://proxy.test:21' } }), error => error.code === 'proxy_invalid')
  const cliSession = await camoufoxCli.openSession({ profileId: 'cam-cli', serverProfileId: 'server-cam-cli', userDataDir: '/var/lib/xianyu/cam-cli' })
  const cliPage = await camoufoxCli.getPage(cliSession)
  const headedSession = await camoufoxCli.openSession({ profileId: 'cam-headed', headless: false, userDataDir: '/var/lib/xianyu/cam-cli' })
  const headlessManualCalls = []
  const headlessManualProvider = createCamoufoxProvider({
    useCli: true,
    forceHeadless: true,
    runtimeVersionCheck: () => true,
    commandRunner: async (_command, args) => {
      headlessManualCalls.push(args)
      return { code: 0, stdout: JSON.stringify({ id: 'r1', success: true, data: { ok: true } }), stderr: '' }
    }
  })
  const headlessManualSession = await headlessManualProvider.openSession({ profileId: 'cam-manual-headless', headless: false, userDataDir: '/var/lib/xianyu/cam-cli' })
  await headlessManualProvider.closeSession(headlessManualSession)
  assert.equal(headlessManualCalls.some(args => args.includes('open') && args.includes('--headed')), false)
  const secondCliSession = await camoufoxCli.openSession({ profileId: 'cam-cli-2', userDataDir: '/var/lib/xianyu/cam-cli' })
  assert.notEqual(cliSession.userDataDir, secondCliSession.userDataDir)
  await camoufoxCli.scroll(cliPage, -500)
  assert.equal(await camoufoxCli.snapshot(cliPage), '- button "Login" [ref=e1]')
  assert.deepEqual((await camoufoxCli.screenshot(cliPage)).base64, 'aGVsbG8=')
  assert.equal(await camoufoxCli.evaluate(cliPage, 'document.title'), 'Login')
  await camoufoxCli.manualAction(cliPage, { type: 'click', ref: '@e1' })
  await camoufoxCli.manualAction(cliPage, { type: 'fill', ref: '@e1', text: 'safe text' })
  await camoufoxCli.closeSession(cliSession)
  await camoufoxCli.closeSession(secondCliSession)
  await camoufoxCli.closeSession(headedSession)
  assert.equal(cliCalls.some(call => call.args.includes('open') && call.args.some(value => String(value).startsWith('/var/lib/xianyu/cam-cli/'))), true)
  assert.equal(cliCalls.some(call => call.args.includes('scroll') && call.args.includes('up') && call.args.includes('500')), true)
  assert.equal(cliCalls.some(call => call.args.includes('snapshot') && call.args.includes('-i')), true)
  assert.equal(cliCalls.some(call => call.args.includes('screenshot') && call.args.includes('--json')), true)
  assert.equal(cliCalls.some(call => call.args.includes('click') && call.args.includes('@e1')), true)
  assert.equal(cliCalls.some(call => call.args.includes('--headed') && call.args.includes('open')), true)
  assert.equal(cliCalls.some(call => call.args.includes('--proxy') && call.args.some(value => String(value).startsWith('http://proxy-user:897aba84c3@example.invalid:8080'))), true)
  assert.equal(cliSession.proxyConfigured, true)

  const unsafeSession = await camoufoxCli.openSession({ profileId: '../../escape/profile', userDataDir: '/var/lib/xianyu/cam-safe' })
  await camoufoxCli.closeSession(unsafeSession)
  const unsafeArgs = cliCalls.flatMap(call => call.args)
  assert.equal(unsafeArgs.some(value => String(value).includes('../')), false)

  const abort = new AbortController()
  const child = runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { signal: abort.signal })
  await sleep(10)
  abort.abort()
  await assert.rejects(child, error => error.code === 'command_aborted')

  console.log('browser-provider-contract: PASS')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})

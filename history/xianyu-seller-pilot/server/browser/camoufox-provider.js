"use strict"

const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { BrowserProviderError, assertProvider } = require('./provider.js')
const { runCommand } = require('./command-runner.js')

const MAX_MANUAL_TEXT = 2_000
const MAX_MANUAL_KEY = 80
const MAX_SCROLL_AMOUNT = 2_000
const MAX_PROXY_URL = 2_048
const MAX_PROXY_MAP_ENTRIES = 256

function parseCliOutput(stdout = '') {
  const raw = String(stdout || '').trim()
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return raw }
}

function parseCliResponse(stdout = '') {
  const parsed = parseCliOutput(stdout)
  if (parsed && typeof parsed === 'object' && parsed.success === false) {
    throw new BrowserProviderError('Camoufox CLI command failed', { code: 'camoufox_cli_failed', retryable: true })
  }
  if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'data')) return parsed.data
  return parsed
}

function manualRef(value) {
  const ref = String(value || '').trim()
  if (!/^@[A-Za-z0-9_-]{1,80}$/.test(ref)) throw new BrowserProviderError('manual action ref is invalid', { code: 'manual_ref_invalid' })
  return ref
}

function manualText(value, field = 'text') {
  const text = String(value ?? '')
  if (text.length > MAX_MANUAL_TEXT || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw new BrowserProviderError(`manual action ${field} is invalid`, { code: 'manual_input_invalid' })
  }
  return text
}

function manualKey(value) {
  const key = String(value || '').trim()
  if (!key || key.length > MAX_MANUAL_KEY || /[\u0000-\u001f\u007f]/.test(key)) throw new BrowserProviderError('manual action key is invalid', { code: 'manual_key_invalid' })
  return key
}

function normaliseProxy(value, field = 'proxy') {
  if (value == null || value === '') return ''
  let raw = value
  if (typeof value === 'object' && !Array.isArray(value)) {
    raw = value.server
    if (raw && (value.username != null || value.password != null)) {
      try {
        const parsed = new URL(String(raw))
        if (value.username != null) parsed.username = String(value.username)
        if (value.password != null) parsed.password = String(value.password)
        raw = parsed.toString()
      } catch {
        throw new BrowserProviderError(`${field} is invalid`, { code: 'proxy_invalid' })
      }
    }
  }
  const text = String(raw || '').trim()
  if (!text || text.length > MAX_PROXY_URL) throw new BrowserProviderError(`${field} is invalid`, { code: 'proxy_invalid' })
  let parsed
  try { parsed = new URL(text) } catch { throw new BrowserProviderError(`${field} is invalid`, { code: 'proxy_invalid' }) }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.hash || parsed.search || (parsed.pathname && parsed.pathname !== '/')) {
    throw new BrowserProviderError(`${field} must be an http(s) proxy URL`, { code: 'proxy_invalid' })
  }
  return parsed.toString()
}

function parseProxyMap(value) {
  if (value == null || value === '') return Object.freeze({})
  let source = value
  if (typeof value === 'string') {
    try { source = JSON.parse(value) } catch { throw new BrowserProviderError('CAMOUFOX_PROXY_MAP_JSON is invalid JSON', { code: 'proxy_map_invalid' }) }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new BrowserProviderError('CAMOUFOX_PROXY_MAP_JSON must be an object', { code: 'proxy_map_invalid' })
  }
  const entries = Object.entries(source)
  if (entries.length > MAX_PROXY_MAP_ENTRIES) throw new BrowserProviderError('CAMOUFOX_PROXY_MAP_JSON has too many entries', { code: 'proxy_map_invalid' })
  const result = {}
  for (const [key, proxy] of entries) {
    const identity = String(key || '').trim()
    if (!identity || identity.length > 240 || /[\u0000-\u001f\u007f]/.test(identity)) throw new BrowserProviderError('CAMOUFOX_PROXY_MAP_JSON contains an invalid profile key', { code: 'proxy_map_invalid' })
    result[identity] = normaliseProxy(proxy, `proxy for profile ${identity}`)
  }
  return Object.freeze(result)
}

function proxyForPlaywright(proxy) {
  if (!proxy) return undefined
  const parsed = new URL(proxy)
  const server = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`
  return {
    server,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {})
  }
}

function cliNodeRuntimeSupported() {
  const [major] = String(process.versions.node || '').split('.').map(Number)
  // camoufox-cli 0.7.3 declares Node >=20.10, but its pinned camoufox-js
  // 0.11.2 dependency declares Node >=22. Use the transitive runtime floor so
  // production preflight fails with an actionable reason instead of a daemon
  // that starts and dies while importing the browser runtime.
  return Number.isInteger(major) && major >= 22
}

function camoufoxExecutablePath(installDir) {
  if (process.platform === 'linux') return path.join(installDir, 'camoufox-bin')
  if (process.platform === 'darwin') return path.join(installDir, 'Camoufox.app', 'Contents', 'MacOS', 'camoufox')
  if (process.platform === 'win32') return path.join(installDir, 'camoufox.exe')
  return ''
}

function installedCamoufoxRuntime(installDir) {
  const versionPath = path.join(installDir, 'version.json')
  const executable = camoufoxExecutablePath(installDir)
  if (!executable) return { ok: false, error: 'unsupported Camoufox host platform' }
  try {
    fs.accessSync(versionPath, fs.constants.R_OK)
    fs.accessSync(executable, fs.constants.X_OK)
    return { ok: true }
  } catch {
    return { ok: false, error: 'Camoufox browser runtime is not installed or is not executable' }
  }
}

function createCamoufoxProvider(options = {}) {
  const now = options.now || (() => new Date().toISOString())
  const launchPersistentContext = options.launchPersistentContext || null
  const commandRunner = options.commandRunner || runCommand
  const cliCommand = String(options.cliCommand || process.env.CAMOUFOX_CLI_COMMAND || 'camoufox-cli')
  const runtimeCheck = options.runtimeCheck || null
  const runtimeVersionCheck = options.runtimeVersionCheck || cliNodeRuntimeSupported
  const executablePath = options.executablePath || process.env.CAMOUFOX_EXECUTABLE || ''
  const useCli = options.useCli === true || ['1', 'true', 'yes', 'on'].includes(String(process.env.CAMOUFOX_USE_CLI || '').toLowerCase())
  // Production Linux containers and systemd services normally have no X
  // server. The H5 manual-control path is screenshot/action based, so it can
  // stay usable without a desktop window. Keep local desktop callers headed
  // by default, while allowing deployment to force headless CLI sessions.
  const forceHeadless = options.forceHeadless === true || ['1', 'true', 'yes', 'on'].includes(String(process.env.CAMOUFOX_FORCE_HEADLESS || '').toLowerCase())
  const requireInstalledRuntime = options.requireInstalledRuntime === true ||
    ['1', 'true', 'yes', 'on'].includes(String(process.env.CAMOUFOX_REQUIRE_INSTALLED_RUNTIME || '').toLowerCase()) ||
    (useCli && String(process.env.NODE_ENV || '').toLowerCase() === 'production')
  const runtimeInstallDir = path.resolve(String(options.installDir || process.env.CAMOUFOX_INSTALL_DIR || path.join(process.cwd(), 'server-data', 'camoufox')))
  const proxyMap = parseProxyMap(options.proxyMap ?? process.env.CAMOUFOX_PROXY_MAP_JSON)
  const sessions = new Map()

  function profileDataDir(profileKey, profile = {}) {
    // Treat every configured path as a server-owned root and append the
    // hashed identity. This prevents two vendor profiles from sharing cookies
    // when the registry supplies one common `camoufox/` root.
    const root = path.resolve(String(profile.userDataDir || options.userDataDir || path.join(process.cwd(), 'server-data', 'camoufox')))
    return path.join(root, profileKey)
  }

  function profileProxy(profile = {}) {
    const direct = profile.proxy ?? profile.proxyUrl
    if (direct) return normaliseProxy(direct)
    const keys = [profile.serverProfileId, profile.storageProfileId, profile.profileId, profile.vendorProfileId, profile.id]
    for (const key of keys) {
      const mapped = proxyMap[String(key || '').trim()]
      if (mapped) return mapped
    }
    return ''
  }

  const provider = {
    name: 'camoufox',
    capabilities: { cdp: false, playwright: true, persistentProfile: true, remoteView: false, cli: useCli, manualControl: useCli, screenshot: useCli, accessibilitySnapshot: useCli },
    async health() {
      if (runtimeCheck) {
        const result = await runtimeCheck()
        return { ok: Boolean(result?.ok), provider: 'camoufox', runtime: result?.runtime || 'playwright', checkedAt: now() }
      }
      if (useCli) {
        if (!runtimeVersionCheck()) return { ok: false, provider: 'camoufox', runtime: 'cli', error: 'camoufox-cli runtime requires Node.js 22+', checkedAt: now() }
        const check = await commandRunner(cliCommand, ['--version'], { timeoutMs: options.timeoutMs, rejectOnNonZero: true, secrets: [process.env.CAMOUFOX_TOKEN] }).catch(() => null)
        const version = String(check?.stdout || '').trim().slice(0, 80)
        const cliOk = Boolean(check?.code === 0 && /^\d+\.\d+\.\d+/.test(version))
        const installed = installedCamoufoxRuntime(runtimeInstallDir)
        if (!cliOk) return { ok: false, provider: 'camoufox', runtime: 'cli', version, runtimeInstalled: installed.ok, error: 'camoufox-cli --version failed', checkedAt: now() }
        if (requireInstalledRuntime && !installed.ok) return { ok: false, provider: 'camoufox', runtime: 'cli', version, runtimeInstalled: false, error: installed.error, checkedAt: now() }
        return { ok: true, provider: 'camoufox', runtime: 'cli', version, runtimeInstalled: installed.ok, checkedAt: now() }
      }
      return { ok: Boolean(launchPersistentContext || executablePath), provider: 'camoufox', runtime: launchPersistentContext || executablePath ? 'playwright' : 'not_configured', checkedAt: now() }
    },
    async openSession(profile = {}) {
      const profileId = String(profile.id || profile.profileId || '').trim()
      if (!profileId) throw new BrowserProviderError('profile id is required', { code: 'profile_required' })
      // Vendor/profile IDs are employee-provided metadata. Hash the ID before
      // using it as a local directory or CLI session name so `../` and other
      // path/argument characters cannot escape the server-owned data root.
      // Vendor IDs are not guaranteed to be unique in our control plane. Use
      // the server profile identity for the persistent directory/session key
      // so two records cannot accidentally share cookies or a CLI daemon.
      const storageIdentity = String(profile.serverProfileId || profile.storageProfileId || profileId).trim()
      const profileKey = crypto.createHash('sha256').update(storageIdentity).digest('hex').slice(0, 32)
      const userDataDir = profileDataDir(profileKey, profile)
      const proxy = profileProxy(profile)
      const launchOptions = {
        headless: forceHeadless || profile.headless !== false,
        userDataDir,
        proxy: proxyForPlaywright(proxy),
        virtualDisplay: profile.virtualDisplay !== false
      }
      let context = null
      let cliResult = null
      if (launchPersistentContext) {
        context = await launchPersistentContext(launchOptions)
      } else if (executablePath) {
        let playwright
        try { playwright = options.playwright || require('playwright-core') } catch (error) {
          throw new BrowserProviderError('playwright-core is unavailable for Camoufox', { code: 'playwright_runtime_unavailable', cause: error })
        }
        if (!playwright.chromium?.launchPersistentContext) throw new BrowserProviderError('Playwright persistent context is unavailable', { code: 'playwright_runtime_unavailable' })
        context = await playwright.chromium.launchPersistentContext(userDataDir, { ...launchOptions, executablePath })
      } else if (useCli) {
        // camoufox-cli owns a daemon per --session and persists an identity
        // with --persistent. `open` is the documented lifecycle command;
        // there is no separate `start` API to poll from the Node process.
        if (!runtimeVersionCheck()) throw new BrowserProviderError('Camoufox CLI requires Node.js 22+', { code: 'provider_runtime_unavailable', retryable: false })
        const cliArgs = ['--session', profileKey, '--persistent', userDataDir]
        if (proxy) cliArgs.push('--proxy', proxy)
        if (profile.headless === false && !forceHeadless) cliArgs.push('--headed')
        cliArgs.push('open', 'about:blank')
        cliResult = await commandRunner(cliCommand, cliArgs, {
          timeoutMs: options.timeoutMs,
          rejectOnNonZero: true,
          secrets: [proxy, process.env.CAMOUFOX_TOKEN]
        }).catch(error => {
          throw new BrowserProviderError('Camoufox CLI start failed', { code: error.code || 'camoufox_start_failed', retryable: true, cause: error })
        })
        parseCliResponse(cliResult?.stdout)
      } else {
        throw new BrowserProviderError('Camoufox Playwright runtime is not configured', { code: 'provider_runtime_unavailable', retryable: false })
      }
      const session = {
        provider: 'camoufox',
        sessionId: `camoufox-${profileId}-${sessions.size + 1}`,
        profileId,
        profileKey,
        userDataDir,
        context,
        cliResult,
        openedAt: now(),
        closed: false,
        persistentProfile: true,
        cli: useCli,
        proxyConfigured: Boolean(proxy)
      }
      sessions.set(session.sessionId, session)
      return session
    },
    async getPage(session) {
      const active = sessions.get(session?.sessionId)
      if (!active || active.closed) throw new BrowserProviderError('session is not available', { code: 'session_unavailable', retryable: true })
      if (active.context && typeof active.context.pages === 'function') {
        const pages = active.context.pages()
        return (Array.isArray(pages) ? pages[0] : null) || (typeof active.context.newPage === 'function' ? active.context.newPage() : null)
      }
      if (active.cli) return { provider: 'camoufox', sessionId: active.sessionId, profileId: active.profileId, profileKey: active.profileKey, cli: true }
      throw new BrowserProviderError('Camoufox page is not available', { code: 'page_unavailable', retryable: true })
    },
    async navigate(page, url) {
      if (page?.cli) {
        const result = await commandRunner(cliCommand, ['--session', page.profileKey || page.profileId, 'open', String(url || 'about:blank')], { timeoutMs: options.timeoutMs, rejectOnNonZero: true, secrets: [process.env.CAMOUFOX_TOKEN] })
        parseCliResponse(result?.stdout)
        return { ok: true, url: String(url || 'about:blank') }
      }
      if (!page || typeof page.goto !== 'function') throw new BrowserProviderError('Camoufox page transport is not configured', { code: 'provider_capability_unavailable' })
      await page.goto(String(url || 'about:blank'))
      return { ok: true, url: String(url || 'about:blank') }
    },
    async evaluate(page, expression) {
      if (page?.cli) {
        const result = await commandRunner(cliCommand, ['--session', page.profileKey || page.profileId, 'eval', String(expression || '')], { timeoutMs: options.timeoutMs, maxOutput: Number(options.evalMaxOutput) || 4 * 1024 * 1024, rejectOnNonZero: true, secrets: [process.env.CAMOUFOX_TOKEN] })
        const payload = parseCliResponse(result?.stdout)
        return payload && typeof payload === 'object' && Object.hasOwn(payload, 'result') ? payload.result : payload
      }
      if (!page || typeof page.evaluate !== 'function') throw new BrowserProviderError('Camoufox page transport is not configured', { code: 'provider_capability_unavailable' })
      return page.evaluate(String(expression || ''))
    },
    async scroll(page, deltaY = 0) {
      const delta = Number(deltaY) || 0
      if (!delta) return { ok: true }
      if (page?.cli) {
        const direction = delta < 0 ? 'up' : 'down'
        await commandRunner(cliCommand, ['--session', page.profileKey || page.profileId, 'scroll', direction, String(Math.abs(Math.round(delta)))], {
          timeoutMs: options.timeoutMs,
          rejectOnNonZero: true,
          secrets: [process.env.CAMOUFOX_TOKEN]
        })
        return { ok: true, direction, amount: Math.abs(Math.round(delta)) }
      }
      if (page?.mouse && typeof page.mouse.wheel === 'function') {
        await page.mouse.wheel(0, delta)
        return { ok: true, amount: delta }
      }
      throw new BrowserProviderError('Camoufox scroll transport is not configured', { code: 'provider_capability_unavailable' })
    },
    async snapshot(page, { interactive = true } = {}) {
      if (!page?.cli) throw new BrowserProviderError('Camoufox CLI snapshot transport is not configured', { code: 'provider_capability_unavailable' })
      const args = ['--json', 'snapshot']
      if (interactive) args.push('-i')
      const result = await commandRunner(cliCommand, ['--session', page.profileKey || page.profileId, ...args], {
        timeoutMs: options.timeoutMs,
        maxOutput: Number(options.snapshotMaxOutput) || 2 * 1024 * 1024,
        rejectOnNonZero: true,
        secrets: [process.env.CAMOUFOX_TOKEN]
      })
      const payload = parseCliResponse(result?.stdout)
      return payload && typeof payload === 'object' && Object.hasOwn(payload, 'snapshot') ? payload.snapshot : payload
    },
    async screenshot(page, { full = false } = {}) {
      if (page?.cli) {
        const args = ['--json', 'screenshot']
        if (full) args.push('--full')
        const result = await commandRunner(cliCommand, ['--session', page.profileKey || page.profileId, ...args], {
          timeoutMs: options.timeoutMs,
          maxOutput: Number(options.screenshotMaxOutput) || 8 * 1024 * 1024,
          rejectOnNonZero: true,
          secrets: [process.env.CAMOUFOX_TOKEN]
        })
        const parsed = parseCliResponse(result?.stdout)
        if (typeof parsed === 'string') return { mimeType: 'image/png', base64: parsed }
        const base64 = parsed?.base64 || parsed?.data || parsed?.screenshot || parsed?.image || ''
        if (!base64 || typeof base64 !== 'string') throw new BrowserProviderError('Camoufox screenshot did not return image data', { code: 'screenshot_unavailable', retryable: true })
        return { mimeType: parsed?.mimeType || 'image/png', base64: base64.replace(/^data:image\/[^;]+;base64,/, '') }
      }
      if (!page || typeof page.screenshot !== 'function') throw new BrowserProviderError('Camoufox screenshot transport is not configured', { code: 'provider_capability_unavailable' })
      const buffer = await page.screenshot({ fullPage: Boolean(full) })
      return { mimeType: 'image/png', base64: Buffer.from(buffer).toString('base64') }
    },
    async manualAction(page, action = {}) {
      if (!page?.cli) throw new BrowserProviderError('Camoufox CLI manual control is not configured', { code: 'provider_capability_unavailable' })
      const type = String(action.type || '').trim().toLowerCase()
      const ref = ['click', 'fill', 'type', 'select', 'check', 'hover'].includes(type) ? manualRef(action.ref) : ''
      let args
      if (type === 'click') args = ['click', ref]
      else if (type === 'fill') args = ['fill', ref, manualText(action.text)]
      else if (type === 'type') args = ['type', ref, manualText(action.text)]
      else if (type === 'select') args = ['select', ref, manualText(action.text, 'option')]
      else if (type === 'check') args = ['check', ref]
      else if (type === 'hover') args = ['hover', ref]
      else if (type === 'press') args = ['press', manualKey(action.key)]
      else if (type === 'scroll') {
        const direction = String(action.direction || '').trim().toLowerCase()
        const amount = Math.min(MAX_SCROLL_AMOUNT, Math.max(1, Math.round(Number(action.amount) || 500)))
        if (!['up', 'down'].includes(direction)) throw new BrowserProviderError('manual scroll direction is invalid', { code: 'manual_scroll_invalid' })
        args = ['scroll', direction, String(amount)]
      } else {
        throw new BrowserProviderError('manual action is not allowed', { code: 'manual_action_not_allowed' })
      }
      const result = await commandRunner(cliCommand, ['--session', page.profileKey || page.profileId, ...args], {
        timeoutMs: options.timeoutMs,
        maxOutput: Number(options.manualMaxOutput) || 256 * 1024,
        rejectOnNonZero: true,
        secrets: [process.env.CAMOUFOX_TOKEN]
      })
      return { ok: true, action: type, output: parseCliResponse(result?.stdout) }
    },
    async closeSession(session) {
      const active = session?.sessionId ? sessions.get(session.sessionId) : null
      if (!active) return { ok: true, alreadyClosed: true }
      if (!active.closed && active.cli) await commandRunner(cliCommand, ['--session', active.profileKey || active.profileId, 'close'], { timeoutMs: options.timeoutMs, rejectOnNonZero: false, secrets: [process.env.CAMOUFOX_TOKEN] }).catch(() => {})
      if (!active.closed && active.context && typeof active.context.close === 'function') await active.context.close()
      active.closed = true
      sessions.delete(active.sessionId)
      return { ok: true, sessionId: active.sessionId }
    }
  }
  return assertProvider(provider, 'Camoufox provider')
}

module.exports = { createCamoufoxProvider }

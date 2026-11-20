"use strict"

const { BrowserProviderError, assertProvider } = require('./provider.js')
const { runCommand } = require('./command-runner.js')

const DEFAULT_ENDPOINT = 'http://127.0.0.1:50325'

function loadPlaywright(playwright) {
  if (playwright) return playwright
  try { return require('playwright-core') } catch (error) {
    throw new BrowserProviderError('playwright-core is unavailable for AdsPower CDP', { code: 'cdp_runtime_unavailable', cause: error })
  }
}

function cleanEndpoint(value) {
  if (value == null) return ''
  const text = String(value).trim()
  if (!text) return ''
  return text.startsWith('ws://') || text.startsWith('wss://') || text.startsWith('http://') || text.startsWith('https://')
    ? text
    : `http://${text}`
}

function responseError(response, fallback = 'adspower_request_failed') {
  const status = response?.status == null ? '' : ` (${response.status})`
  const body = response?.body && typeof response.body === 'object' ? response.body : {}
  const message = String(body.msg || body.message || response?.statusText || fallback).replace(/[\r\n\t]/g, ' ').slice(0, 180)
  return new BrowserProviderError(`AdsPower request failed${status}: ${message}`, {
    code: fallback,
    retryable: !response || response.status >= 500
  })
}

async function fetchRequest(url, options = {}) {
  if (typeof fetch !== 'function') throw new BrowserProviderError('fetch is unavailable', { code: 'http_runtime_unavailable' })
  const response = await fetch(url, options)
  let body = null
  try { body = await response.json() } catch { body = null }
  return { ok: response.ok, status: response.status, statusText: response.statusText, body }
}

function createAdsPowerProvider(options = {}) {
  const endpoint = String(options.endpoint || process.env.ADSPOWER_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/$/, '')
  const apiKey = String(options.apiKey || process.env.ADSPOWER_API_KEY || '')
  const request = options.request || fetchRequest
  const commandRunner = options.commandRunner || runCommand
  const now = options.now || (() => new Date().toISOString())
  const transport = options.transport || null
  const sessions = new Map()

  const provider = {
    name: 'adspower',
    capabilities: { cdp: true, playwright: false, persistentProfile: true, remoteView: true },
    async health() {
      const response = await request(`${endpoint}/api/v1/user/list?page=1&page_size=1`, {
        method: 'GET',
        headers: apiKey ? { 'X-API-KEY': apiKey } : undefined
      }).catch(error => { throw new BrowserProviderError('AdsPower health request failed', { code: 'adspower_unavailable', retryable: true, cause: error }) })
      if (!response?.ok || (response.body && Number(response.body.code) !== 0)) throw responseError(response, 'adspower_unavailable')
      return { ok: true, provider: 'adspower', endpointConfigured: true, checkedAt: now() }
    },
    async openSession(profile = {}) {
      const profileId = String(profile.id || profile.profileId || '').trim()
      if (!profileId) throw new BrowserProviderError('profile id is required', { code: 'profile_required' })
      const payload = {
        user_id: profileId,
        headless: profile.headless === false ? 0 : 1,
        open_tabs: profile.openTabs === false ? 0 : 1
      }
      if (profile.proxy) payload.proxy = profile.proxy
      const response = await request(`${endpoint}/api/v2/browser-profile/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { 'X-API-KEY': apiKey } : {}) },
        body: JSON.stringify(payload)
      }).catch(error => { throw new BrowserProviderError('AdsPower profile start failed', { code: 'adspower_unavailable', retryable: true, cause: error }) })
      if (!response?.ok || (response.body && Number(response.body.code) !== 0)) throw responseError(response, 'adspower_profile_start_failed')
      const data = response.body?.data || response.body || {}
      const debugEndpoint = cleanEndpoint(data.debug_endpoint || data.ws?.puppeteer || data.ws?.selenium || data.debugger_address || data.ws)
      const vendorSessionId = String(data.session_id || data.browser_id || data.id || profileId)
      const session = {
        provider: 'adspower',
        sessionId: `adspower-${profileId}-${vendorSessionId}`,
        profileId,
        vendorSessionId,
        debugEndpoint,
        openedAt: now(),
        closed: false,
        persistentProfile: true
      }
      sessions.set(session.sessionId, session)
      return session
    },
    async getPage(session) {
      const active = sessions.get(session?.sessionId)
      if (!active || active.closed) throw new BrowserProviderError('session is not available', { code: 'session_unavailable', retryable: true })
      if (transport) {
        if (transport.getPage) return transport.getPage(active)
        return { provider: 'adspower', sessionId: active.sessionId, debugEndpoint: active.debugEndpoint }
      }
      if (!active.debugEndpoint) throw new BrowserProviderError('AdsPower did not return a debug endpoint', { code: 'debug_endpoint_missing', retryable: true })
      if (active.page) return active.page
      const playwright = loadPlaywright(options.playwright)
      if (!playwright.chromium?.connectOverCDP) throw new BrowserProviderError('Playwright CDP client is unavailable', { code: 'cdp_runtime_unavailable' })
      active.browser = await playwright.chromium.connectOverCDP(active.debugEndpoint)
      const contexts = active.browser.contexts()
      const context = contexts[0] || (await active.browser.newContext())
      const pages = context.pages()
      active.page = pages[0] || await context.newPage()
      return active.page
    },
    async navigate(page, url) {
      if (!page) throw new BrowserProviderError('page is not available', { code: 'page_unavailable' })
      if (transport?.navigate) return transport.navigate(page, String(url || 'about:blank'))
      if (typeof page.goto !== 'function') throw new BrowserProviderError('AdsPower page transport is not configured', { code: 'provider_capability_unavailable', retryable: false })
      await page.goto(String(url || 'about:blank'))
      return { ok: true, url: String(url || 'about:blank') }
    },
    async evaluate(page, expression) {
      if (!page) throw new BrowserProviderError('page is not available', { code: 'page_unavailable' })
      if (transport?.evaluate) return transport.evaluate(page, String(expression || ''))
      if (typeof page.evaluate !== 'function') throw new BrowserProviderError('AdsPower page transport is not configured', { code: 'provider_capability_unavailable', retryable: false })
      return page.evaluate(String(expression || ''))
    },
    async closeSession(session) {
      const active = session?.sessionId ? sessions.get(session.sessionId) : null
      if (!active) return { ok: true, alreadyClosed: true }
      if (!active.closed) {
        if (active.browser && typeof active.browser.close === 'function') await active.browser.close().catch(() => {})
        const response = await request(`${endpoint}/api/v1/browser-profile/stop`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(apiKey ? { 'X-API-KEY': apiKey } : {}) },
          body: JSON.stringify({ user_id: active.profileId })
        }).catch(error => { throw new BrowserProviderError('AdsPower profile stop failed', { code: 'adspower_stop_failed', retryable: true, cause: error }) })
        if (!response?.ok || (response.body && Number(response.body.code) !== 0)) throw responseError(response, 'adspower_stop_failed')
        active.closed = true
      }
      sessions.delete(active.sessionId)
      return { ok: true, sessionId: active.sessionId }
    },
    async runCli(args = [], cliOptions = {}) {
      return commandRunner(cliOptions.command || 'ads', args, { ...cliOptions, rejectOnNonZero: true, secrets: [apiKey, ...(cliOptions.secrets || [])] })
    }
  }
  return assertProvider(provider, 'AdsPower provider')
}

module.exports = { DEFAULT_ENDPOINT, cleanEndpoint, createAdsPowerProvider }

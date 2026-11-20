"use strict"

const { BrowserProviderError, safeProviderError } = require('../browser/provider.js')
const { projectSellerResult } = require('../domain/task-projection.js')
const { persistHtmlSnapshot } = require('./crawl-artifacts.js')

function applySellerControl(state = {}, command = '') {
  const action = String(command || '').trim().toLowerCase()
  const current = String(state.status || 'pending')
  if (action === 'pause' && ['pending', 'running'].includes(current)) return { ...state, status: 'paused', control: 'paused' }
  if (action === 'resume' && current === 'paused') return { ...state, status: 'running', control: 'resumed' }
  if (action === 'stop' && !['completed', 'failed', 'cancelled'].includes(current)) return { ...state, status: 'cancelled', control: 'stopped' }
  return { ...state, status: current }
}

async function runSellerJob({ provider, job, profile = {}, artifactStore = null, now = () => new Date().toISOString() } = {}) {
  if (!provider) throw new BrowserProviderError('seller job provider is required', { code: 'provider_required' })
  const payload = job?.payload || {}
  const sellerUrl = String(payload.sellerUrl || '').trim()
  if (!sellerUrl) return projectSellerResult({ jobId: job?.id, state: 'failed', evidence: { failed: true, error: true }, error: { code: 'seller_url_required', message: 'Seller URL is required' } })
  const controlled = applySellerControl({ status: 'running' }, payload.control)
  if (controlled.status === 'paused' || controlled.status === 'cancelled') return projectSellerResult({ jobId: job?.id, state: controlled.status, evidence: { requestedStatus: controlled.status === 'paused' ? 'running' : undefined } })
  let session
  try {
    session = await provider.openSession(profile)
    const page = await provider.getPage(session)

    // The Linux worker must use the same seller-page rules as the desktop
    // product.  For the real providers, adapt their minimal page transport
    // to the production crawler instead of maintaining a second fixture-only
    // implementation here.  Fixture providers intentionally keep the small
    // deterministic path used by regression tests.
    if (['adspower', 'camoufox'].includes(String(provider.name || '').toLowerCase())) {
      const { crawlSellerPage } = await import('../../src/main/seller-goofish.js')
      const webContents = {
        loadURL: (url) => provider.navigate(page, url),
        executeJavaScript: (script) => provider.evaluate(page, script),
        getURL: () => {
          try {
            if (typeof page.url === 'function') return page.url()
            return page.url || ''
          } catch {
            return ''
          }
        },
        // crawlSellerPage only uses stop() after a bounded navigation timeout.
        // Providers own the session lifecycle, so there is no extra browser
        // process for the worker to terminate here.
        stop: () => {},
        // camoufox-cli has an explicit scroll command. Mark the hidden CLI
        // page as focused for this transport only so the crawler can trigger
        // lazy loading without stealing focus from an employee desktop.
        isFocused: () => Boolean(page?.cli),
        sendInputEvent: (event) => {
          if (page?.cli && typeof provider.scroll === 'function') provider.scroll(page, event?.deltaY).catch(() => {})
        }
      }
      const crawl = await crawlSellerPage(webContents, sellerUrl, {
        sourceSellerName: payload.sellerName || payload.name || '',
        maxItemsPerSeller: payload.maxItemsPerSeller,
        maxScrollSteps: payload.maxScrollSteps,
        pageWaitMs: payload.pageWaitMs,
        executionMode: payload.executionMode,
        executionTimeoutMs: payload.executionTimeoutMs,
        excludeItemIds: payload.excludeItemIds
      })
      const evidence = { ...(crawl?.evidence || {}) }
      if (crawl?.loggedOut) evidence.loggedOut = true
      if (crawl?.riskControl || crawl?.http429) evidence.riskControl = true
      if (crawl?.needsReview) evidence.domAnomaly = true
      if (!crawl?.ok) {
        evidence.failed = !crawl?.loggedOut && !crawl?.riskControl && !crawl?.http429 && !crawl?.needsReview
        evidence.error = crawl?.reason || 'Seller crawl did not complete'
        if (crawl?.reasonCode) evidence.failureReasonCode = crawl.reasonCode
      }
      const snapshot = crawl?.ok && artifactStore
        ? await persistHtmlSnapshot({ artifactStore, webContents, jobId: job?.id, kind: 'seller', now }).catch(() => null)
        : null
      return projectSellerResult({
        jobId: job?.id,
        state: crawl?.ok ? 'completed' : 'failed',
        items: crawl?.items || [],
        evidence,
        sellerName: crawl?.sellerName || payload.sellerName || payload.name || '',
        raw: crawl || null,
        snapshotPath: snapshot?.path || '',
        error: crawl?.ok ? null : { code: crawl?.reasonCode || 'seller_crawl_failed', message: crawl?.reason || 'Seller crawl did not complete' }
      })
    }
    await provider.navigate(page, sellerUrl)
    const fixture = await provider.evaluate(page, 'window.__sellerFixture')
    const evidence = fixture?.evidence || fixture || {}
    const items = Array.isArray(fixture?.items) ? fixture.items : []
    return projectSellerResult({ jobId: job?.id, state: 'completed', items, evidence, sellerName: fixture?.sellerName || payload.sellerName || payload.name || '' })
  } catch (error) {
    const safe = safeProviderError(error, 'seller_job_failed')
    const evidence = safe.code === 'login_expired' ? { loginExpired: true } : safe.code === 'risk_cooldown' ? { riskControl: true } : { failed: true, error: true }
    return projectSellerResult({ jobId: job?.id, state: 'failed', evidence, error: safe })
  } finally {
    if (session) await provider.closeSession(session).catch(() => {})
  }
}

module.exports = { applySellerControl, runSellerJob }

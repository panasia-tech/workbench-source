"use strict"

const { BrowserProviderError, safeProviderError } = require('../browser/provider.js')
const { projectMarketResult } = require('../domain/task-projection.js')
const { persistHtmlSnapshot } = require('./crawl-artifacts.js')

function normalizeKeywords(value) {
  const values = Array.isArray(value) ? value : [value]
  return [...new Set(values.map(item => String(item || '').trim()).filter(Boolean))].slice(0, 20)
}

function normalizeItem(item = {}) {
  return {
    id: String(item.id || item.itemId || item.url || '').trim(),
    title: String(item.title || item.name || '').trim().slice(0, 240),
    price: item.price ?? item.currentPrice ?? item.amount ?? null,
    url: String(item.url || '').trim().slice(0, 500),
    source: String(item.source || 'fixture').trim().slice(0, 80)
  }
}

async function runMarketJob({ provider, job, profile = {}, artifactStore = null, now = () => new Date().toISOString() } = {}) {
  if (!provider) throw new BrowserProviderError('market job provider is required', { code: 'provider_required' })
  const payload = job?.payload || {}
  const keywords = normalizeKeywords(payload.keywords || payload.keyword)
  if (!keywords.length) return projectMarketResult({ jobId: job?.id, status: 'failed', error: { code: 'keyword_required', message: 'At least one keyword is required' } })
  const blacklist = (Array.isArray(payload.blacklistKeywords) ? payload.blacklistKeywords : []).map(value => String(value || '').trim().toLowerCase()).filter(Boolean).slice(0, 100)
  const priceFence = payload.priceFence || {}
  const items = []
  const seen = new Set()
  let session
  try {
    // Reuse the production Electron-side Goofish extractor when a real
    // server Provider is selected. The wrapper deliberately exposes only the
    // small WebContents surface that crawlOne needs, so the domain rules and
    // selectors stay single-sourced instead of being reimplemented in the
    // Linux worker. Fake provider jobs retain their deterministic fixture path.
    if (['adspower', 'camoufox'].includes(String(provider.name || '').toLowerCase())) {
      const { crawlOne } = await import('../../src/main/goofish.js')
      session = await provider.openSession(profile)
      const page = await provider.getPage(session)
      const webContents = {
        loadURL: (url) => provider.navigate(page, url),
        executeJavaScript: (script) => provider.evaluate(page, script),
        getURL: () => page.url || ''
      }
      const result = await crawlOne(webContents, keywords, {
        accountName: profile.label || profile.id || profile.profileId || '',
        blacklistKeywords: blacklist,
        effectivePolicy: { blacklist: { terms: blacklist }, priceFence },
        queryDelayMinMs: Number(payload.queryDelayMinMs) || 8000,
        queryDelayMaxMs: Number(payload.queryDelayMaxMs) || 14000,
        captureSnapshot: artifactStore
          ? (input) => persistHtmlSnapshot({ artifactStore, webContents, jobId: job?.id, kind: `market-${input?.query || 'snapshot'}`, now })
          : null
      })
      const status = result?.riskControl ? 'risk_control' : result?.ok ? 'succeeded' : result?.empty ? 'empty' : 'failed'
      const rawItems = result?.raw?.candidates || result?.priceBreakdown?.includedListings || []
      return projectMarketResult({
        jobId: job?.id,
        keyword: keywords.join(' | '),
        status,
        items: rawItems,
        picked: result?.price != null ? { price: result.price, average: result.price, lowest: result.price, median: result.price } : null,
        evidence: { acceptedCount: rawItems.length, sources: rawItems.map(item => item.itemUrl || item.source || 'goofish') },
        error: status === 'failed' || status === 'risk_control' ? { code: status, message: result?.reason || 'Goofish crawl did not produce a successful result' } : null,
        raw: { result: result || null, provider: provider.name }
      })
    }
    const { listingPriceFenceCheck } = await import('../../src/main/price-fence.js')
    session = await provider.openSession(profile)
    const page = await provider.getPage(session)
    for (const keyword of keywords) {
      await provider.navigate(page, `https://www.goofish.com/search?q=${encodeURIComponent(keyword)}`)
      const fixture = await provider.evaluate(page, 'window.__fixture')
      const candidates = Array.isArray(fixture?.items) ? fixture.items : Array.isArray(fixture) ? fixture : []
      for (const candidate of candidates) {
        const item = normalizeItem(candidate)
        const identity = item.id || `${item.title}:${item.price}`
        if (seen.has(identity)) continue
        seen.add(identity)
        items.push({ ...item, keyword })
      }
    }
    const accepted = []
    let blockedCount = 0
    let invalidPriceCount = 0
    for (const item of items) {
      const lowerTitle = item.title.toLowerCase()
      if (blacklist.some(word => lowerTitle.includes(word))) { blockedCount += 1; continue }
      const fence = listingPriceFenceCheck({ listingPrice: item.price, priceFence })
      if (!fence.ok) { invalidPriceCount += 1; continue }
      accepted.push({ ...item, normalizedPrice: fence.listingPrice })
    }
    const { pickPrice } = await import('../../src/main/goofish.js')
    const picked = pickPrice(accepted.map(item => item.normalizedPrice))
    const status = picked ? 'succeeded' : (items.length ? 'invalid_price' : 'empty')
    return projectMarketResult({
      jobId: job?.id,
      keyword: keywords.join(' | '),
      status,
      items: accepted,
      picked,
      evidence: { acceptedCount: accepted.length, blockedCount, invalidPriceCount, sources: accepted.map(item => item.source) }
    })
  } catch (error) {
    const safe = safeProviderError(error, 'market_job_failed')
    return projectMarketResult({ jobId: job?.id, keyword: keywords.join(' | '), status: 'failed', error: safe, evidence: { sources: [] } })
  } finally {
    if (session) await provider.closeSession(session).catch(() => {})
  }
}

module.exports = { normalizeItem, normalizeKeywords, runMarketJob }

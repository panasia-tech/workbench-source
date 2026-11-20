"use strict"

function safeText(value, max = 240) {
  return String(value == null ? '' : value).replace(/[\r\n\t]/g, ' ').slice(0, max)
}

function projectMarketResult({ jobId, keyword, status, items = [], picked = null, evidence = {}, error = null, raw = null } = {}) {
  const result = {
    jobId: String(jobId || ''),
    kind: 'market_snapshot',
    keyword: safeText(keyword, 120),
    status: safeText(status || 'failed', 40),
    price: picked?.price ?? null,
    average: picked?.average ?? null,
    lowest: picked?.lowest ?? null,
    median: picked?.median ?? null,
    itemCount: Array.isArray(items) ? items.length : 0,
    evidence: {
      acceptedCount: Number(evidence.acceptedCount || 0),
      blockedCount: Number(evidence.blockedCount || 0),
      invalidPriceCount: Number(evidence.invalidPriceCount || 0),
      sources: Array.isArray(evidence.sources) ? evidence.sources.slice(0, 20).map(value => safeText(value, 200)) : []
    },
    error: error ? { code: safeText(error.code || 'market_job_failed', 80), message: safeText(error.message || 'Market job failed'), retryable: Boolean(error.retryable) } : null
  }
  if (raw && typeof raw === 'object') {
    const source = raw.result || raw
    result.priceBreakdown = source.priceBreakdown || null
    result.snapshotPath = source.snapshotPath || null
    result.snapshotPaths = Array.isArray(source.snapshotPaths) ? source.snapshotPaths.slice(0, 100) : []
    result.snapshotEntries = Array.isArray(source.snapshotEntries) ? source.snapshotEntries.slice(0, 100) : []
    result.queryLogs = Array.isArray(source.queryLogs) ? source.queryLogs.slice(0, 100) : []
    result.policyEvidence = source.policyEvidence || null
    result.raw = { provider: raw.provider || 'server', result: source }
  }
  return result
}

async function projectSellerResult({ jobId, state, items = [], evidence = {}, error = null, sellerName = '', raw = null, snapshotPath = '' } = {}) {
  const { evaluateSellerEvidence } = await import('../../src/main/seller-state-machine.js')
  const evaluated = evaluateSellerEvidence(evidence)
  const result = {
    jobId: String(jobId || ''),
    kind: 'seller_snapshot',
    status: evaluated.status,
    reasonCode: evaluated.reasonCode,
    sellerName: safeText(sellerName, 128),
    snapshotPath: safeText(snapshotPath, 128),
    expected: evaluated.expected,
    counts: evaluated.counts,
    itemCount: Array.isArray(items) ? items.length : 0,
    items: Array.isArray(items) ? items.slice(0, 100000).map(item => ({
      itemId: item?.itemId || item?.id || '',
      title: item?.title || item?.name || '',
      category: item?.category || '',
      branch: item?.branch || item?.statusBranch || item?.source || '',
      price: item?.price == null ? null : Number(item.price),
      status: item?.status || item?.itemStatus || '',
      url: item?.url || item?.itemUrl || '',
      capturedAt: item?.capturedAt || item?.observedAt || null
    })) : [],
    state: safeText(state || 'completed', 40),
    evidence: {
      expected: evaluated.expected,
      expectedTrusted: {
        active: evidence.expectedTrusted?.active === true,
        sold: evidence.expectedTrusted?.sold === true
      },
      itemIds: {
        active: Array.isArray(evidence.itemIds?.active) ? evidence.itemIds.active.slice(0, 100000).map(id => safeText(id, 200)) : [],
        sold: Array.isArray(evidence.itemIds?.sold) ? evidence.itemIds.sold.slice(0, 100000).map(id => safeText(id, 200)) : []
      },
      unknownItemIds: Array.isArray(evidence.unknownItemIds) ? evidence.unknownItemIds.slice(0, 100000).map(id => safeText(id, 200)) : [],
      branches: evidence.branches && typeof evidence.branches === 'object' ? evidence.branches : {},
      capped: Boolean(evidence.capped),
      platformBoundaryReached: Boolean(evidence.platformBoundaryReached),
      safetyLimitReached: Boolean(evidence.safetyLimitReached),
      loggedOut: Boolean(evidence.loggedOut || evidence.loginExpired),
      riskControl: Boolean(evidence.riskControl || evidence.verificationRequired),
      domAnomaly: Boolean(evidence.domAnomaly),
      failureReasonCode: safeText(evidence.failureReasonCode || '', 80)
    },
    error: error ? { code: safeText(error.code || 'seller_job_failed', 80), message: safeText(error.message || 'Seller job failed'), retryable: Boolean(error.retryable) } : null
  }
  if (raw && typeof raw === 'object') {
    result.raw = {
      source: safeText(raw.raw?.source || 'seller_home', 80),
      selection: safeText(raw.raw?.selection || '', 80),
      sellerUrl: safeText(raw.raw?.sellerUrl || '', 2000)
    }
  }
  return result
}

module.exports = { projectMarketResult, projectSellerResult, safeText }

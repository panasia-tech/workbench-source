function normalizeExpressResult(result) {
  if (!result) return null
  const traces = (result.traces || []).map((item) => ({
    time: item.time || '',
    context: (item.context || item.status || item.desc || '').trim(),
  }))
  return { ...result, traces }
}

function expressSummaryFromResult(result) {
  const normalized = normalizeExpressResult(result)
  if (!normalized) return ''
  const traces = normalized.traces || []
  if (traces.length && traces[0].context) return traces[0].context
  return (normalized.msg || '').trim()
}

module.exports = {
  normalizeExpressResult,
  expressSummaryFromResult,
}

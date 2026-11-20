const OSS_UNAVAILABLE_PREFIX = '__OSS_UNAVAILABLE__|'

function isOssArchived(url) {
  return !!(url && String(url).indexOf(OSS_UNAVAILABLE_PREFIX) === 0)
}

function stripUnavailablePrefix(url) {
  if (!url) return ''
  return isOssArchived(url) ? String(url).slice(OSS_UNAVAILABLE_PREFIX.length) : String(url)
}

function resolveDisplayUrl(url) {
  if (!url || isOssArchived(url)) return ''
  return String(url)
}

function isVideoUrl(url) {
  const u = stripUnavailablePrefix(url).toLowerCase()
  return /\.(mp4|mov|m4v|webm|avi)(\?|$)/i.test(u)
}

function normalizeMedia(url) {
  const archived = isOssArchived(url)
  return {
    archived,
    displayUrl: resolveDisplayUrl(url),
    isVideo: !archived && isVideoUrl(url),
    hasMedia: !!(url && String(url)),
  }
}

function normalizeMediaList(urls) {
  if (!Array.isArray(urls)) return []
  // 只保留字符串 URL：历史迁移数据里可能混入对象(如 {snLabel,accessory,appearance}),需跳过避免渲染成 [object Object]
  return urls.filter((url) => typeof url === 'string' && url).map((url) => ({ url, ...normalizeMedia(url) }))
}

function previewUrls(urls) {
  return (urls || []).map(resolveDisplayUrl).filter(Boolean)
}

function uploadAccessUrl(token) {
  if (!token) return ''
  return token.access_url || token.public_url || ''
}

function uploadPublicUrl(token) {
  if (!token) return ''
  return token.public_url || token.access_url || ''
}

module.exports = {
  OSS_UNAVAILABLE_PREFIX,
  isOssArchived,
  stripUnavailablePrefix,
  resolveDisplayUrl,
  isVideoUrl,
  normalizeMedia,
  normalizeMediaList,
  previewUrls,
  uploadAccessUrl,
  uploadPublicUrl,
}

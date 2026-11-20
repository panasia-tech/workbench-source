export const OSS_UNAVAILABLE_PREFIX = '__OSS_UNAVAILABLE__|'

export function isOssArchived(url) {
  return !!(url && String(url).startsWith(OSS_UNAVAILABLE_PREFIX))
}

export function stripUnavailablePrefix(url) {
  if (!url) return ''
  return isOssArchived(url) ? String(url).slice(OSS_UNAVAILABLE_PREFIX.length) : String(url)
}

export function resolveDisplayUrl(url) {
  if (!url || isOssArchived(url)) return ''
  return String(url)
}

export function isVideoUrl(url) {
  const u = stripUnavailablePrefix(url).toLowerCase()
  return /\.(mp4|mov|m4v|webm|avi)(\?|$)/i.test(u)
}

export function normalizeMedia(url) {
  const archived = isOssArchived(url)
  return {
    url,
    archived,
    displayUrl: resolveDisplayUrl(url),
    isVideo: !archived && isVideoUrl(url),
    hasMedia: !!(url && String(url)),
  }
}

export function normalizeMediaList(urls) {
  if (!Array.isArray(urls)) return []
  return urls.filter(Boolean).map((url) => normalizeMedia(url))
}

export function previewUrls(urls) {
  return (urls || []).map(resolveDisplayUrl).filter(Boolean)
}

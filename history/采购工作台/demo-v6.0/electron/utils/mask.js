/**
 * 隐私脱敏（主进程 / 渲染进程共用逻辑）
 */

function maskHostname(hostname) {
  if (!hostname || hostname.includes('***')) return hostname || '***'
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    const parts = hostname.split('.')
    return `***.***.***.${parts[3]}`
  }
  const parts = hostname.split('.')
  if (parts.length >= 2) {
    return parts.map((part, index) => (index < parts.length - 1 ? '***' : part)).join('.')
  }
  return '***'
}

function maskPathSegment(segment) {
  if (!segment || segment === '***') return segment
  if (/^\*\*\*\./.test(segment)) return segment
  const idx = segment.lastIndexOf('.')
  if (idx > 0 && idx < segment.length - 1) {
    return `***${segment.slice(idx)}`
  }
  return '***'
}

function maskPathname(pathname) {
  if (!pathname || pathname === '/') return pathname
  const trailingSlash = pathname.endsWith('/') && pathname.length > 1
  const segments = pathname.split('/').filter(Boolean)
  if (!segments.length) return pathname
  return `/${segments.map(maskPathSegment).join('/')}${trailingSlash ? '/' : ''}`
}

function buildMaskedUrl(urlObj) {
  const port = urlObj.port ? `:${urlObj.port}` : ''
  return `${urlObj.protocol}//${maskHostname(urlObj.hostname)}${port}${maskPathname(urlObj.pathname)}${urlObj.search}${urlObj.hash}`
}

/**
 * 脱敏 URL：域名/IP 与路径均半打码（路径每段替换为 ***，文件名保留扩展名）
 */
export function maskDomain(url) {
  if (!url || typeof url !== 'string') {
    return url || ''
  }

  const raw = url.trim()
  if (!raw) return ''

  try {
    return buildMaskedUrl(new URL(raw))
  } catch {
    try {
      return buildMaskedUrl(new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`))
    } catch {
      const domainPattern = /([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}|\d{1,3}(\.\d{1,3}){3}/
      return raw.replace(domainPattern, (match) => maskHostname(match))
    }
  }
}

export function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') {
    return phone || ''
  }

  const cleaned = phone.replace(/\D/g, '')
  if (cleaned.length === 11) {
    return cleaned.slice(0, 3) + '****' + cleaned.slice(7)
  }
  if (cleaned.length > 4) {
    return cleaned.slice(0, 2) + '****' + cleaned.slice(-2)
  }
  return phone
}

export function maskEmail(email) {
  if (!email || typeof email !== 'string') {
    return email || ''
  }

  const [localPart, domain] = email.split('@')
  if (!domain) {
    return email
  }

  const maskedLocal = localPart.length > 1 ? localPart[0] + '***' : localPart
  return `${maskedLocal}@${maskDomain(domain)}`
}

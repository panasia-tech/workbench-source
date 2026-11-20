/** 与 src/utils/humanizeListingField.js 保持一致（主进程读盘 JSON 时兜底） */
export function humanizeListingField(v, maxLen = 48) {
  if (v == null) return ''
  if (typeof v === 'string') return v.trim().slice(0, maxLen)
  if (typeof v === 'number' && Number.isFinite(v)) return String(v).slice(0, maxLen)
  if (typeof v === 'boolean') return (v ? '是' : '否').slice(0, maxLen)
  if (Array.isArray(v)) {
    const parts = []
    for (const el of v) {
      const s = humanizeListingField(el, maxLen)
      if (s) parts.push(s)
    }
    return parts.join('、').slice(0, maxLen)
  }
  if (typeof v === 'object') {
    const prefer = [
      'name',
      'title',
      'text',
      'label',
      'content',
      'desc',
      'creditLevelName',
      'levelName',
      'tagName',
      'shortText',
      'value'
    ]
    for (const k of prefer) {
      const s = humanizeListingField(v[k], maxLen)
      if (s) return s
    }
    for (const k of Object.keys(v)) {
      const sub = v[k]
      if (sub == null || typeof sub === 'object') continue
      const s = humanizeListingField(sub, maxLen)
      if (s) return s
    }
  }
  try {
    const s = String(v).trim()
    if (s === '[object Object]') return ''
    return s.slice(0, maxLen)
  } catch {
    return ''
  }
}

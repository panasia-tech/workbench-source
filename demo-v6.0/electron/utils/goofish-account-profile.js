/**
 * 账号昵称 / 头像：本机算签 + POST h5api（与过期检测同源）
 */

export function isGoofishAvatarDebugEnabled() {
  const v = String(process.env.XIANYU_GOOFISH_AVATAR_DEBUG || '').toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

function logGoofishAvatarDebug(tag, meta = {}) {
  if (!isGoofishAvatarDebugEnabled()) return
  try {
    console.log('[闲鱼头像]', tag, meta)
  } catch {
    /* */
  }
}

/** @param {unknown} raw */
export function normalizeGoofishAvatarUrl(raw) {
  let s = String(raw ?? '').trim().slice(0, 512)
  if (!s) return ''
  if (s.startsWith('//')) s = `https:${s}`
  else if (/^http:\/\//i.test(s)) s = `https://${s.slice(7)}`
  return /^https?:\/\//i.test(s) ? s : ''
}

/** 与 server/modules/xy_sxjk/normalize-items buildGoofishUserAvatarUrl 一致 */
export function buildGoofishUserAvatarUrl(userId, pixel = '120') {
  const id = String(userId ?? '').trim()
  if (!id) return ''
  const px = String(pixel || '120').replace(/\D/g, '') || '120'
  return `https://api.goofish.com/m/userAvatar.action?id=${encodeURIComponent(id)}&needHttps=1&suffix=_${px}x${px}.jpg`
}

export function pickDisplayNameFromUserPageNavJson(json) {
  const base = json?.data?.module?.base || {}
  return String(base.displayName || base.nick || base.nickname || '').trim().slice(0, 64)
}

/**
 * @param {unknown} json
 * @param {string} [cookieHeader]
 * @param {{ skipUnbFallback?: boolean }} [opts]
 */
export function pickAvatarFromUserPageNavJson(json, cookieHeader = '', opts = {}) {
  const base = json?.data?.module?.base || {}
  const mod = json?.data?.module || {}
  const d = json?.data || {}
  const avKeys = ['avatar', 'userAvatar', 'headPic', 'picUrl', 'userAvatarUrl', 'portrait', 'sellerAvatar']

  let av = ''
  if (typeof base.avatar === 'string') {
    av = base.avatar.trim()
  } else if (base.avatar && typeof base.avatar === 'object') {
    av = String(base.avatar.avatar || base.avatar.url || base.avatar.picUrl || '').trim()
  }

  const buckets = [base, mod, d, d.baseInfo].filter((x) => x && typeof x === 'object')
  if (!av) {
    for (const b of buckets) {
      for (const k of avKeys) {
        av = String(b[k] ?? '').trim()
        if (av) break
      }
      if (av) break
    }
  }

  let out = normalizeGoofishAvatarUrl(av)
  if (out) return out
  if (opts.skipUnbFallback) return ''
  return ''
}

/** @param {unknown} json */
export function pickAvatarFromLoginUserGetJson(json) {
  const d = json?.data
  if (!d || typeof d !== 'object') return ''
  const keys = ['avatar', 'userAvatar', 'headPic', 'picUrl', 'userAvatarUrl', 'portrait', 'photo']
  for (const k of keys) {
    const n = normalizeGoofishAvatarUrl(d[k])
    if (n) return n
  }
  for (const nest of [d.user, d.userInfo, d.loginUser, d.data]) {
    if (!nest || typeof nest !== 'object') continue
    for (const k of keys) {
      const n = normalizeGoofishAvatarUrl(nest[k])
      if (n) return n
    }
  }
  return ''
}

/**
 * 本机：算签 userPageNav → POST h5api，与账号过期检测一致。
 * @param {string} cookieHeader
 * @param {{ debug?: boolean, accountId?: string }} [opts]
 */
export async function fetchGoofishAccountProfile(cookieHeader, opts = {}) {
  const debugOn = opts.debug === true || isGoofishAvatarDebugEnabled()
  const debug = debugOn ? { steps: [] } : null

  const s = String(cookieHeader || '')
    .replace(/[\r\n\t\x00-\x1f\x7f]/g, '')
    .trim()
  if (!s) return { ok: false, displayName: '', avatar: '', error: 'empty_cookie', ...(debug ? { debug } : {}) }
  if (!/(?:^|;\s*)_m_h5_tk=/i.test(s)) {
    return { ok: false, displayName: '', avatar: '', error: 'missing_mh5_tk', ...(debug ? { debug } : {}) }
  }

  try {
    const { xianyuMtop } = await import('./xianyu-mtop-client.js')
    const profile = await xianyuMtop.fetchProfile(s, { accountId: opts.accountId })
    const navOk = profile.navOk === true
    const softOnly = profile.softOnly === true
    const displayName = String(profile.displayName || '').trim()
    const avatar = String(profile.avatar || '').trim()
    const avatarSource = String(profile.avatarSource || (avatar ? 'nav' : 'none'))
    const sessionOk = profile.ok === true

    if (debug) {
      debug.steps.push({
        step: 'local.userPageNav',
        ok: navOk,
        error: profile.error || '',
        softOnly
      })
      logGoofishAvatarDebug('fetch-profile', debug)
    }

    if (!navOk) {
      console.warn(
        '[分区资料] 本机 nav 未通过',
        opts.accountId || '',
        String(profile.error || '').slice(0, 160) || (softOnly ? 'soft_unb' : 'mtop_fail')
      )
    }

    return {
      ok: sessionOk,
      navOk,
      softOnly,
      displayName: String(displayName || '').trim().slice(0, 64),
      avatar: normalizeGoofishAvatarUrl(avatar),
      avatarSource: avatar ? avatarSource : 'none',
      cookie: String(profile.client_mtop_cookie_updated || s).trim(),
      error: sessionOk ? undefined : profile.error || 'mtop_fail',
      ...(debug ? { debug } : {})
    }
  } catch (e) {
    return {
      ok: false,
      displayName: '',
      avatar: '',
      error: String(e?.message || e),
      ...(debug ? { debug } : {})
    }
  }
}

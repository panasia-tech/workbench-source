/**
 * 从账号 persist 分区读 Cookie，拉取 user.page.nav 昵称/头像，写入账号 JSON（不写 Cookie 磁盘快照）。
 */
import { readAccountCookieHeader, partitionHasAccountLogin } from './goofish-partition-cookie.js'
import {
  fetchGoofishAccountProfile,
  buildGoofishUserAvatarUrl
} from './goofish-account-profile.js'
import { applyAccountMtopLoginVerifyResult } from '../ipc/accounts.js'
import { flushAccountPartitionStore, repersistAccountPartitionCookiesForDisk } from './goofish-partition-persist.js'
import { refreshGoofishFeedBrowseWarmupFromDisk } from './goofish-feed-browse-warmup-scheduler.js'

function pickCookieValue(cookieHeader, name) {
  const s = String(cookieHeader || '')
  const re = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`, 'i')
  const m = s.match(re)
  if (!m) return ''
  let v = String(m[1] || '').trim()
  if (!v || /^deleted$/i.test(v)) return ''
  try {
    v = decodeURIComponent(v)
  } catch {
    /* 保持原值 */
  }
  return v
}

function pickTracknickFromCookieHeader(cookieHeader) {
  return pickCookieValue(cookieHeader, 'tracknick').slice(0, 64)
}

function pickAvatarFallbackFromCookieHeader(cookieHeader) {
  const unb = pickCookieValue(cookieHeader, 'unb')
  return unb ? buildGoofishUserAvatarUrl(unb) : ''
}

/**
 * @param {string} accountsDir
 * @param {string} accountId
 * @param {{ debug?: boolean, preserveSessionOnFail?: boolean, markSessionValidOnSoftFail?: boolean }} [opts]
 * preserveSessionOnFail：拉资料失败时不得写成过期（保留原 loginCheckSessionValid）
 * markSessionValidOnSoftFail：仅 Cookie 添加等「刚注入凭证」场景，拉资料失败仍可标已登录
 */
export async function syncAccountProfileFromPartition(accountsDir, accountId, opts = {}) {
  const id = String(accountId || '').trim()
  if (!id || !accountsDir) {
    return { ok: false, error: 'missing_id', msg: '缺少账号' }
  }
  const preserveSessionOnFail = opts.preserveSessionOnFail === true
  const markSessionValidOnSoftFail = opts.markSessionValidOnSoftFail === true
  const snap = await readAccountCookieHeader(id)
  if (!snap.ok) {
    if (!preserveSessionOnFail) {
      try {
        await applyAccountMtopLoginVerifyResult(accountsDir, id, { sessionValid: false })
      } catch {
        /* */
      }
    }
    void refreshGoofishFeedBrowseWarmupFromDisk(accountsDir, {})
    return {
      ok: false,
      error: 'no_session',
      msg: snap.error || '分区暂无有效登录，请先在嵌入页或登录窗口完成登录'
    }
  }
  const profile = await fetchGoofishAccountProfile(snap.cookie, {
    debug: opts.debug === true,
    accountId: id
  })
  /** 仅有 unb/tracknick 兜底、nav 未通过：不算真正登录 */
  const loginVerified = profile.ok === true && profile.navOk === true
  const softProfileOnly = profile.ok === true && profile.navOk !== true

  if (!loginVerified) {
    if (preserveSessionOnFail || softProfileOnly) {
      const nick =
        String(profile.displayName || '').trim().slice(0, 64) ||
        pickTracknickFromCookieHeader(snap.cookie)
      const avatar =
        String(profile.avatar || '').trim().slice(0, 512) ||
        pickAvatarFallbackFromCookieHeader(snap.cookie)
      const apply = {}
      if (markSessionValidOnSoftFail) {
        apply.sessionValid = true
        apply.loginCheckUpdatedAt = new Date().toISOString()
      }
      if (nick) apply.goofishNickname = nick
      if (avatar) apply.goofishAvatar = avatar
      if (Object.keys(apply).length) {
        try {
          await applyAccountMtopLoginVerifyResult(accountsDir, id, apply)
        } catch {
          /* */
        }
      }
      void refreshGoofishFeedBrowseWarmupFromDisk(accountsDir, {})
      if (markSessionValidOnSoftFail) {
        return {
          ok: true,
          soft: true,
          sessionVerified: true,
          goofishNickname: nick,
          goofishAvatar: avatar,
          avatarSource: avatar ? 'unb_fallback' : 'none',
          msg: '接口暂未返回资料，已用 Cookie 兜底昵称/头像'
        }
      }
      console.warn(
        '[分区资料] nav 未通过，未把登录状态改为已登录',
        id,
        softProfileOnly ? 'soft_unb' : profile.error || ''
      )
      return {
        ok: false,
        soft: true,
        sessionVerified: false,
        error: softProfileOnly ? 'nav_soft' : 'mtop_fail',
        goofishNickname: nick,
        goofishAvatar: avatar,
        avatarSource: avatar ? 'unb_fallback' : 'none',
        msg: '分区仍有凭证，但登录校验未通过；未改登录状态'
      }
    }
    try {
      await applyAccountMtopLoginVerifyResult(accountsDir, id, { sessionValid: false })
    } catch {
      /* */
    }
    void refreshGoofishFeedBrowseWarmupFromDisk(accountsDir, {})
    return {
      ok: false,
      error: 'mtop_fail',
      sessionVerified: false,
      msg: '登录已失效，请重新登录后再试',
      ...(profile.debug ? { debug: profile.debug } : {})
    }
  }
  const nick =
    String(profile.displayName || '').trim().slice(0, 64) ||
    pickTracknickFromCookieHeader(snap.cookie)
  const avatar =
    String(profile.avatar || '').trim().slice(0, 512) ||
    pickAvatarFallbackFromCookieHeader(snap.cookie)
  const apply = { sessionValid: true }
  if (nick) apply.goofishNickname = nick
  if (avatar) apply.goofishAvatar = avatar
  await applyAccountMtopLoginVerifyResult(accountsDir, id, apply)
  await flushAccountPartitionStore(id)
  void refreshGoofishFeedBrowseWarmupFromDisk(accountsDir, {})
  return {
    ok: true,
    sessionVerified: true,
    goofishNickname: nick,
    goofishAvatar: avatar,
    avatarSource: profile.avatarSource || (avatar ? 'unb_fallback' : 'none'),
    debug: profile.debug
  }
}

/**
 * 应用内闲鱼浏览窗关窗：先把分区 Cookie 落盘，再尽量同步昵称/头像。
 * Cookie 添加首关常见「有 unb、_m_h5_tk 尚未就绪」或「有 Cookie 但拉昵称失败」——仍须 flush，且不误标登录失效。
 * 普通浏览关窗：分区残留 Cookie 不得把已判定「过期」改成「已登录」，须资料接口校验通过才标有效。
 * @param {string} accountsDir
 * @param {string} accountId
 * @param {{ injectedCookieHeader?: string, getMainWindow?: () => import('electron').BrowserWindow | null | undefined, debug?: boolean }} [opts]
 */
export async function finalizeGoofishBrowseWindowClose(accountsDir, accountId, opts = {}) {
  const id = String(accountId || '').trim()
  if (!id || !accountsDir) {
    return {
      ok: false,
      error: 'missing_id',
      msg: '缺少账号',
      cookiePersisted: false,
      profileSynced: false,
      sessionVerified: false
    }
  }

  const injectedCookie = !!String(opts.injectedCookieHeader || '').trim()
  const hasLogin = await partitionHasAccountLogin(id)
  let snap = await readAccountCookieHeader(id)

  if (injectedCookie || hasLogin || snap.ok) {
    const rep = await repersistAccountPartitionCookiesForDisk(id)
    if (rep.updated > 0) {
      console.log('[分区落盘] 关窗 Cookie 持久化', id, 'updated=', rep.updated)
    }
    await flushAccountPartitionStore(id)
    snap = await readAccountCookieHeader(id, { fresh: true })
  }

  const hasLoginAfter = await partitionHasAccountLogin(id)
  const cookiePersisted = hasLoginAfter || snap.ok
  const getMainWindow = typeof opts.getMainWindow === 'function' ? opts.getMainWindow : null
  /** 拉资料失败时不得误标过期；仅 Cookie 添加可在 soft fail 时标已登录 */
  const preserveSessionOnFail = injectedCookie || hasLoginAfter || snap.ok
  const markSessionValidOnSoftFail = injectedCookie

  if (!cookiePersisted) {
    const sync = await syncAccountProfileFromPartition(accountsDir, id, {
      ...opts,
      preserveSessionOnFail: false,
      markSessionValidOnSoftFail: false
    })
    return {
      ...sync,
      cookiePersisted: false,
      profileSynced: sync.ok === true && sync.sessionVerified !== false,
      sessionVerified: sync.sessionVerified === true
    }
  }

  if (snap.ok || hasLoginAfter) {
    const sync = await syncAccountProfileFromPartition(accountsDir, id, {
      ...opts,
      preserveSessionOnFail,
      markSessionValidOnSoftFail
    })
    if (sync.ok === true && sync.sessionVerified !== false) {
      notifyAccountCookiePersisted(getMainWindow, id, {
        source: injectedCookie ? 'cookie_add_close' : 'browse_close'
      })
      return {
        ...sync,
        cookiePersisted: true,
        profileSynced: true,
        sessionVerified: true
      }
    }
    if (markSessionValidOnSoftFail) {
      const chkAt = new Date().toISOString()
      const patch = {
        sessionValid: true,
        loginCheckUpdatedAt: chkAt
      }
      const nickFromCookie = pickTracknickFromCookieHeader(snap.cookie || '')
      const avatarFromCookie = pickAvatarFallbackFromCookieHeader(snap.cookie || '')
      if (nickFromCookie) patch.goofishNickname = nickFromCookie
      if (avatarFromCookie) patch.goofishAvatar = avatarFromCookie
      await applyAccountMtopLoginVerifyResult(accountsDir, id, patch)
      console.warn(
        '[分区落盘] Cookie添加关窗拉昵称失败，已保留登录态并兜底头像',
        id,
        sync.error || sync.msg || ''
      )
      notifyAccountCookiePersisted(getMainWindow, id, {
        source: 'cookie_add_close'
      })
      void refreshGoofishFeedBrowseWarmupFromDisk(accountsDir, {})
      return {
        ok: true,
        cookiePersisted: true,
        profileSynced: false,
        sessionVerified: true,
        partitionOnly: true,
        msg: '登录凭证已保存；昵称稍后可点「检测过期」刷新'
      }
    }
    console.warn(
      '[分区落盘] 关窗拉资料未通过，保留原登录状态（不因残留 Cookie 标已登录）',
      id,
      sync.error || sync.msg || ''
    )
    notifyAccountCookiePersisted(getMainWindow, id, {
      source: 'browse_close'
    })
    return {
      ok: true,
      cookiePersisted: true,
      profileSynced: false,
      sessionVerified: false,
      partitionOnly: true,
      msg: sync.msg || '凭证已写入分区；登录状态未变更'
    }
  }

  if (injectedCookie) {
    const chkAt = new Date().toISOString()
    await applyAccountMtopLoginVerifyResult(accountsDir, id, {
      sessionValid: true,
      loginCheckUpdatedAt: chkAt
    })
    notifyAccountCookiePersisted(getMainWindow, id, {
      source: 'cookie_add_close'
    })
    void refreshGoofishFeedBrowseWarmupFromDisk(accountsDir, {})
    return {
      ok: true,
      cookiePersisted: true,
      profileSynced: false,
      sessionVerified: true,
      partitionOnly: true,
      msg: '登录凭证已保存到本机'
    }
  }

  notifyAccountCookiePersisted(getMainWindow, id, {
    source: 'browse_close'
  })
  return {
    ok: true,
    cookiePersisted: true,
    profileSynced: false,
    sessionVerified: false,
    partitionOnly: true,
    msg: '凭证已写入分区；登录状态未变更'
  }
}

/**
 * @param {() => import('electron').BrowserWindow | null | undefined} getMainWindow
 * @param {string} accountId
 * @param {Record<string, unknown>} payload
 */
export function notifyAccountProfileSynced(getMainWindow, accountId, payload = {}) {
  const win = getMainWindow?.()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('sxjk-account-profile-synced', {
      accountId: String(accountId || '').trim(),
      ...payload
    })
    /** 仅资料校验通过或 Cookie 添加 soft 标有效时，才当「已登录」广播 */
    const verified = payload?.sessionVerified === true || payload?.profileSynced === true
    if (verified) {
      win.webContents.send('sxjk-goofish-embed-login-autosaved', {
        accountId: String(accountId || '').trim(),
        ok: true,
        msg: String(payload.msg || 'profile_synced').trim()
      })
      notifyAccountCookiePersisted(getMainWindow, accountId, {
        source: String(payload.source || 'profile_synced').trim() || 'profile_synced'
      })
    }
  } catch {
    /* */
  }
}

/**
 * 验证窗/登录窗关窗后 Cookie 已落盘：通知渲染进程立刻 syncCookies 到服务端。
 * @param {() => import('electron').BrowserWindow | null | undefined} getMainWindow
 * @param {string} accountId
 * @param {{ source?: string }} [payload]
 */
export function notifyAccountCookiePersisted(getMainWindow, accountId, payload = {}) {
  const id = String(accountId || '').trim()
  if (!id) return
  const win = getMainWindow?.()
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send('sxjk-account-cookie-persisted', {
      accountId: id,
      source: String(payload?.source || '').trim() || 'account_cookie_persisted',
      at: new Date().toISOString()
    })
  } catch {
    /* */
  }
}

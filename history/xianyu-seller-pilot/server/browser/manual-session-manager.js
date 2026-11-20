"use strict"

const crypto = require('node:crypto')
const { BrowserProviderError, safeProviderError } = require('./provider.js')

const DEFAULT_TTL_MS = 15 * 60 * 1000
const ALLOWED_HOSTS = ['goofish.com', 'taobao.com']
const ACTION_TYPES = new Set(['click', 'fill', 'type', 'select', 'check', 'hover', 'press', 'scroll'])

function safeManualUrl(value) {
  const raw = String(value || 'https://www.goofish.com/').trim()
  let url
  try { url = new URL(raw) } catch { throw new BrowserProviderError('manual browser URL is invalid', { code: 'manual_url_invalid' }) }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) throw new BrowserProviderError('manual browser URL is not allowed', { code: 'manual_url_not_allowed' })
  const host = url.hostname.toLowerCase()
  if (!ALLOWED_HOSTS.some(allowed => host === allowed || host.endsWith(`.${allowed}`))) throw new BrowserProviderError('manual browser URL host is not allowed', { code: 'manual_url_not_allowed' })
  return url.toString()
}

function validateManualAction(action = {}) {
  const type = String(action.type || '').trim().toLowerCase()
  if (!ACTION_TYPES.has(type)) throw new BrowserProviderError('manual action is not allowed', { code: 'manual_action_not_allowed' })
  if (['click', 'fill', 'type', 'select', 'check', 'hover'].includes(type) && !/^@[A-Za-z0-9_-]{1,80}$/.test(String(action.ref || '').trim())) throw new BrowserProviderError('manual action ref is invalid', { code: 'manual_ref_invalid' })
  if (['fill', 'type', 'select'].includes(type)) {
    const text = String(action.text ?? '')
    if (text.length > 2_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new BrowserProviderError('manual action text is invalid', { code: 'manual_input_invalid' })
  }
  if (type === 'press' && (!String(action.key || '').trim() || String(action.key).length > 80 || /[\u0000-\u001f\u007f]/.test(String(action.key)))) throw new BrowserProviderError('manual action key is invalid', { code: 'manual_key_invalid' })
  if (type === 'scroll') {
    if (!['up', 'down'].includes(String(action.direction || '').trim().toLowerCase())) throw new BrowserProviderError('manual scroll direction is invalid', { code: 'manual_scroll_invalid' })
    if (action.amount !== undefined && action.amount !== null && String(action.amount) !== '') {
      const amount = Number(action.amount)
      if (!Number.isFinite(amount) || amount < 1 || amount > 2_000) throw new BrowserProviderError('manual scroll amount is invalid', { code: 'manual_scroll_invalid' })
    }
  }
  return type
}

function createManualSessionManager({ provider, db, now = () => Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
  if (!provider || !db) throw new TypeError('manual session manager requires provider and db')
  const sessions = new Map()
  const openingProfiles = new Set()
  const ttl = Math.max(60_000, Number(ttlMs) || DEFAULT_TTL_MS)

  function timestamp(value = now()) { return new Date(Number(value)).toISOString() }
  function publicSession(entry) {
    return {
      sessionId: entry.sessionId,
      profileId: entry.profileId,
      provider: entry.provider,
      state: entry.state,
      url: entry.url,
      openedAt: entry.openedAt,
      lastActivityAt: entry.lastActivityAt,
      expiresAt: entry.expiresAt,
      capabilities: {
        manualControl: Boolean(provider.capabilities?.manualControl),
        screenshot: Boolean(provider.capabilities?.screenshot),
        accessibilitySnapshot: Boolean(provider.capabilities?.accessibilitySnapshot),
        remoteView: Boolean(provider.capabilities?.remoteView)
      }
    }
  }

  function prune() {
    const current = Number(now())
    for (const entry of sessions.values()) {
      if (entry.expiresAtMs <= current) closeEntry(entry, null, 'expired').catch(() => {})
    }
  }

  async function closeEntry(entry, actorId = null, reason = 'closed') {
    if (!entry || entry.closed) return { ok: true, alreadyClosed: true }
    entry.closed = true
    sessions.delete(entry.profileId)
    await provider.closeSession(entry.session).catch(() => {})
    db.releaseBrowserProfileLock?.({ profileId: entry.profileId, ownerId: entry.profileLockOwner })
    db.audit({ actorId, action: reason === 'expired' ? 'manual.session.expired' : 'manual.session.close', entityType: 'manual_browser_session', entityId: entry.sessionId, metadata: { profileId: entry.profileId, provider: entry.provider, reason } })
    return { ok: true, sessionId: entry.sessionId }
  }

  function requireEntry(profileId, sessionId = null) {
    prune()
    const id = String(profileId || '').trim()
    const entry = sessions.get(id)
    if (!entry || entry.closed || (sessionId && entry.sessionId !== String(sessionId))) throw new BrowserProviderError('manual browser session not found', { code: 'manual_session_not_found' })
    return entry
  }

  function touch(entry) {
    const current = Number(now())
    if (entry.profileLockOwner && db.acquireBrowserProfileLock && !db.acquireBrowserProfileLock({ profileId: entry.profileId, ownerId: entry.profileLockOwner, leaseMs: ttl })) {
      throw new BrowserProviderError('manual browser profile lock was lost', { code: 'profile_lock_lost', retryable: true })
    }
    entry.lastActivityAt = timestamp(current)
    entry.expiresAtMs = current + ttl
    entry.expiresAt = timestamp(entry.expiresAtMs)
  }

  async function inspectEntry(entry, { withScreenshot = true, withSnapshot = true } = {}) {
    touch(entry)
    const response = { session: publicSession(entry) }
    if (withSnapshot && typeof provider.snapshot === 'function' && provider.capabilities?.accessibilitySnapshot) response.snapshot = await provider.snapshot(entry.page, { interactive: true })
    if (withScreenshot && typeof provider.screenshot === 'function' && provider.capabilities?.screenshot) response.screenshot = await provider.screenshot(entry.page, { full: false })
    return response
  }

  const manager = {
    capabilities: provider.capabilities || {},
    async open({ profile, actorId = null, url = null } = {}) {
      if (!profile?.id || !profile.vendor_profile_id) throw new BrowserProviderError('browser profile is incomplete', { code: 'profile_required' })
      // The H5 route requires a server-side screenshot plus a constrained
      // action transport. AdsPower's current remoteView/CDP capability does
      // not provide that contract, so fail closed instead of opening a blind
      // session employees cannot operate.
      if (!provider.capabilities?.manualControl || typeof provider.manualAction !== 'function') throw new BrowserProviderError('manual browser control is unavailable for this provider', { code: 'manual_control_unavailable' })
      prune()
      const profileId = String(profile.id)
      if (sessions.has(profileId) || openingProfiles.has(profileId)) throw new BrowserProviderError('manual browser session already exists for this profile', { code: 'manual_session_exists' })
      const busy = db.listActiveJobs({}).some(job => String(job.profile_id || '') === String(profile.id))
      if (busy) throw new BrowserProviderError('profile is busy with a server task', { code: 'profile_busy', retryable: true })
      const targetUrl = safeManualUrl(url)
      const sessionId = crypto.randomUUID()
      const profileLockOwner = `manual:${sessionId}`
      if (db.acquireBrowserProfileLock && !db.acquireBrowserProfileLock({ profileId, ownerId: profileLockOwner, leaseMs: ttl })) {
        throw new BrowserProviderError('profile is busy with a server task', { code: 'profile_busy', retryable: true })
      }
      let lockHeld = true
      openingProfiles.add(profileId)
      try {
        const session = await provider.openSession({ id: profile.vendor_profile_id, vendorProfileId: profile.vendor_profile_id, serverProfileId: profile.id, userDataDir: profile.user_data_dir || undefined, headless: false, virtualDisplay: true })
        const page = await provider.getPage(session)
        const entry = {
          sessionId, profileId, profileLockOwner, provider: String(profile.provider || provider.name || 'browser'), session, page,
          state: 'manual_intervention_required', url: targetUrl, openedAt: timestamp(), lastActivityAt: timestamp(), expiresAtMs: Number(now()) + ttl, expiresAt: timestamp(Number(now()) + ttl), closed: false
        }
        try {
          await provider.navigate(page, targetUrl)
        } catch (error) {
          await provider.closeSession(session).catch(() => {})
          throw error
        }
        sessions.set(entry.profileId, entry)
        lockHeld = false
        db.audit({ actorId, action: 'manual.session.open', entityType: 'manual_browser_session', entityId: entry.sessionId, metadata: { profileId: entry.profileId, provider: entry.provider, host: new URL(targetUrl).hostname } })
        try { return await inspectEntry(entry) } catch (error) { await closeEntry(entry, null, 'open_failed').catch(() => {}); throw error }
      } finally {
        openingProfiles.delete(profileId)
        if (lockHeld) db.releaseBrowserProfileLock?.({ profileId, ownerId: profileLockOwner })
      }
    },
    async inspect({ profileId, sessionId, withScreenshot = true, withSnapshot = true } = {}) {
      return inspectEntry(requireEntry(profileId, sessionId), { withScreenshot, withSnapshot })
    },
    async action({ profileId, sessionId, actorId = null, action = {} } = {}) {
      const entry = requireEntry(profileId, sessionId)
      const type = String(action.type || '').trim().toLowerCase()
      if (type === 'navigate') {
        const targetUrl = safeManualUrl(action.url)
        await provider.navigate(entry.page, targetUrl)
        entry.url = targetUrl
      } else if (typeof provider.manualAction === 'function' && provider.capabilities?.manualControl) {
        validateManualAction(action)
        await provider.manualAction(entry.page, action)
      } else {
        throw new BrowserProviderError('manual action is unavailable for this provider', { code: 'manual_control_unavailable' })
      }
      touch(entry)
      db.audit({ actorId, action: 'manual.session.action', entityType: 'manual_browser_session', entityId: entry.sessionId, metadata: { profileId: entry.profileId, type } })
      return inspectEntry(entry)
    },
    async close({ profileId, sessionId, actorId = null, reason = 'closed' } = {}) {
      return closeEntry(requireEntry(profileId, sessionId), actorId, reason)
    },
    list() { prune(); return [...sessions.values()].map(publicSession) },
    async stopAll() { await Promise.all([...sessions.values()].map(entry => closeEntry(entry, null, 'server_shutdown'))) }
  }
  return manager
}

module.exports = { DEFAULT_TTL_MS, ALLOWED_HOSTS, safeManualUrl, validateManualAction, createManualSessionManager }

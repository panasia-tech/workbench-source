"use strict"

const { BrowserProviderError } = require('../../browser/provider.js')
const { tokenFromRequest } = require('../events.js')

function publicProfile(profile) {
  if (!profile) return null
  const { id, provider, vendor_profile_id, label, proxy_label, capabilities, status, created_at, updated_at } = profile
  return { id, provider, vendor_profile_id, label, proxy_label, capabilities, status, created_at, updated_at }
}

function registerProfileRoutes(fastify, { db, auth, config = {} }) {
  function assertConfiguredProvider(provider) {
    // A server process owns one browser Provider instance. In production a
    // profile from another vendor would otherwise be accepted into the
    // database and later opened by the wrong adapter (for example an
    // AdsPower id sent to Camoufox CLI). Keep fixture/unit apps flexible,
    // but fail closed for the real deployment configuration.
    if (config.environment === 'production' && config.provider && String(config.provider).toLowerCase() !== provider) {
      throw new BrowserProviderError(`profile provider must match server provider (${config.provider})`, { code: 'provider_mismatch' })
    }
  }

  fastify.get('/profiles', async (request, reply) => {
    const actor = auth.verifyToken(tokenFromRequest(request))
    if (!actor) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } })
    return { profiles: db.listBrowserProfiles({ limit: request.query?.limit }).map(publicProfile) }
  })

  fastify.post('/profiles', async (request, reply) => {
    const actor = auth.verifyToken(tokenFromRequest(request))
    if (!actor) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } })
    if (!['admin', 'operator'].includes(actor.role)) return reply.code(403).send({ error: { code: 'forbidden', message: 'Insufficient role' } })
    try {
      const body = request.body || {}
      const provider = String(body.provider || '').trim().toLowerCase()
      if (!['fake', 'adspower', 'camoufox'].includes(provider)) throw new BrowserProviderError('unsupported provider', { code: 'provider_not_allowed' })
      assertConfiguredProvider(provider)
      const vendorProfileId = String(body.vendorProfileId || '').trim()
      if (!vendorProfileId) throw new BrowserProviderError('vendor profile id is required', { code: 'profile_required' })
      // The browser data directory is server-owned. Employees may select the
      // vendor profile identity and display label, but cannot point the
      // server process at an arbitrary filesystem path.
      const profile = db.upsertBrowserProfile({ provider, vendorProfileId, label: body.label || vendorProfileId, proxyLabel: body.proxyLabel, createdBy: actor.id })
      db.audit({ actorId: actor.id, action: 'profile.upsert', entityType: 'browser_profile', entityId: profile.id, metadata: { provider, vendorProfileId } })
      return reply.code(201).send({ profile: publicProfile(profile) })
    } catch (error) {
      const code = error?.code || 'profile_create_failed'
      return reply.code(code === 'forbidden' ? 403 : code === 'provider_mismatch' ? 409 : 400).send({ error: { code, message: String(error?.message || 'Profile create failed').slice(0, 240) } })
    }
  })

  fastify.patch('/profiles/:id', async (request, reply) => {
    const actor = auth.verifyToken(tokenFromRequest(request))
    if (!actor) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } })
    if (!['admin', 'operator'].includes(actor.role)) return reply.code(403).send({ error: { code: 'forbidden', message: 'Insufficient role' } })
    const current = db.getBrowserProfile(request.params.id)
    if (!current) return reply.code(404).send({ error: { code: 'profile_not_found', message: 'Profile not found' } })
    try {
      const body = request.body || {}
      const provider = String(body.provider || current.provider).trim().toLowerCase()
      if (!['fake', 'adspower', 'camoufox'].includes(provider)) throw new BrowserProviderError('unsupported provider', { code: 'provider_not_allowed' })
      assertConfiguredProvider(provider)
      const vendorProfileId = String(body.vendorProfileId || body.vendor_profile_id || current.vendor_profile_id).trim()
      if (!vendorProfileId) throw new BrowserProviderError('vendor profile id is required', { code: 'profile_required' })
      const requestedStatus = body.status || (body.enabled === undefined ? current.status : (body.enabled ? 'ready' : 'disabled'))
      const status = ['ready', 'disabled', 'blocked'].includes(String(requestedStatus)) ? String(requestedStatus) : current.status
      const profile = db.upsertBrowserProfile({ id: current.id, provider, vendorProfileId, label: body.label || body.name || current.label, proxyLabel: body.proxyLabel ?? current.proxy_label, status, createdBy: current.created_by })
      db.audit({ actorId: actor.id, action: 'profile.update', entityType: 'browser_profile', entityId: profile.id, metadata: { provider, vendorProfileId, status } })
      return { profile: publicProfile(profile) }
    } catch (error) {
      const code = error?.code || 'profile_update_failed'
      return reply.code(code === 'provider_mismatch' ? 409 : 400).send({ error: { code, message: String(error?.message || 'Profile update failed').slice(0, 240) } })
    }
  })

  fastify.delete('/profiles/:id', async (request, reply) => {
    const actor = auth.verifyToken(tokenFromRequest(request))
    if (!actor) return reply.code(401).send({ error: { code: 'unauthenticated', message: 'Authentication required' } })
    if (!['admin', 'operator'].includes(actor.role)) return reply.code(403).send({ error: { code: 'forbidden', message: 'Insufficient role' } })
    const removed = db.deleteBrowserProfile(request.params.id, actor.id)
    if (!removed) return reply.code(404).send({ error: { code: 'profile_not_found', message: 'Profile not found' } })
    return { ok: true, profile: publicProfile(removed) }
  })
}

module.exports = { registerProfileRoutes, publicProfile }

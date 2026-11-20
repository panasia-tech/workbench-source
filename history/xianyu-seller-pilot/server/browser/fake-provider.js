"use strict"

const { BrowserProviderError, assertProvider } = require('./provider.js')

function createFakeProvider({ now = () => new Date().toISOString(), fixture = null } = {}) {
  const sessions = new Map()
  const pages = new Map()
  const defaultFixture = fixture || {
    title: 'Fake Goofish result',
    items: [{ id: 'fixture-1', title: 'Fixture item', price: 128 }]
  }

  const provider = {
    name: 'fake',
    capabilities: { cdp: false, playwright: false, persistentProfile: true, remoteView: false },
    async health() {
      return { ok: true, provider: 'fake', checkedAt: now() }
    },
    async openSession(profile = {}) {
      const profileId = String(profile.id || profile.profileId || '').trim()
      if (!profileId) throw new BrowserProviderError('profile id is required', { code: 'profile_required' })
      const sessionId = `fake-session-${sessions.size + 1}`
      const session = { sessionId, profileId, openedAt: now(), closed: false }
      sessions.set(sessionId, session)
      pages.set(sessionId, { sessionId, url: 'about:blank', fixture: defaultFixture })
      return session
    },
    async getPage(session) {
      const page = pages.get(session?.sessionId)
      if (!page || session?.closed) throw new BrowserProviderError('session is not available', { code: 'session_unavailable', retryable: true })
      return page
    },
    async navigate(page, url) {
      if (!page) throw new BrowserProviderError('page is not available', { code: 'page_unavailable' })
      page.url = String(url || 'about:blank')
      return { ok: true, url: page.url }
    },
    async evaluate(page, expression) {
      if (!page) throw new BrowserProviderError('page is not available', { code: 'page_unavailable' })
      const script = String(expression || '').trim()
      if (script === 'fixture.results' || script === 'window.__fixture' || script === 'window.__sellerFixture') return page.fixture
      return { url: page.url, evaluated: true, expressionLength: script.length, fixture: page.fixture }
    },
    async closeSession(session) {
      if (!session || !sessions.has(session.sessionId)) return { ok: true, alreadyClosed: true }
      session.closed = true
      sessions.delete(session.sessionId)
      pages.delete(session.sessionId)
      return { ok: true, sessionId: session.sessionId }
    }
  }
  return assertProvider(provider, 'fake provider')
}

module.exports = { createFakeProvider }

"use strict"

const crypto = require('node:crypto')
const { BrowserProviderError } = require('../browser/provider.js')

const SESSION_TTL_MS = 8 * 60 * 60 * 1000

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const secret = String(password || '')
  if (secret.length < 8) throw new BrowserProviderError('password must be at least 8 characters', { code: 'password_too_short' })
  const digest = crypto.scryptSync(secret, salt, 32).toString('hex')
  return `scrypt$${salt}$${digest}`
}

function verifyPassword(password, encoded) {
  const [scheme, salt, expected] = String(encoded || '').split('$')
  if (scheme !== 'scrypt' || !salt || !expected) return false
  const actual = crypto.scryptSync(String(password || ''), salt, 32).toString('hex')
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer)
}

function publicUser(row) {
  if (!row) return null
  return { id: row.id, username: row.username, displayName: row.display_name, role: row.role, active: Boolean(row.active) }
}

function createAuthService({ db, now = () => Date.now(), sessionTtlMs = SESSION_TTL_MS } = {}) {
  if (!db) throw new Error('auth database is required')
  const sessions = new Map()
  const service = {
    hashPassword,
    verifyPassword,
    createUser({ username, password, displayName, role = 'read_only', id = null, active = true } = {}) {
      const normalized = String(username || '').trim().toLowerCase()
      if (!/^[a-z0-9._-]{2,64}$/.test(normalized)) throw new BrowserProviderError('invalid username', { code: 'invalid_username' })
      if (!['admin', 'operator', 'read_only'].includes(role)) throw new BrowserProviderError('invalid role', { code: 'invalid_role' })
      return publicUser(db.upsertUser({ id, username: normalized, displayName: displayName || normalized, role, passwordHash: hashPassword(password), active }))
    },
    authenticate(username, password) {
      const row = db.getUserByUsername(username)
      if (!row || !row.active || !verifyPassword(password, row.password_hash)) throw new BrowserProviderError('invalid credentials', { code: 'invalid_credentials' })
      const token = crypto.randomBytes(32).toString('base64url')
      const expiresAt = Number(now()) + sessionTtlMs
      sessions.set(crypto.createHash('sha256').update(token).digest('hex'), { userId: row.id, expiresAt })
      return { token, expiresAt: new Date(expiresAt).toISOString(), user: publicUser(row) }
    },
    verifyToken(token) {
      const value = String(token || '')
      if (!value) return null
      const key = crypto.createHash('sha256').update(value).digest('hex')
      const session = sessions.get(key)
      if (!session || session.expiresAt <= Number(now())) { sessions.delete(key); return null }
      const user = db.getUserById(session.userId)
      return user && user.active ? publicUser(user) : null
    },
    revokeToken(token) {
      sessions.delete(crypto.createHash('sha256').update(String(token || '')).digest('hex'))
    },
    requireRole(user, roles) {
      const allowed = Array.isArray(roles) ? roles : [roles]
      if (!user || !allowed.includes(user.role)) throw new BrowserProviderError('insufficient role', { code: 'forbidden' })
      return user
    }
  }
  return service
}

module.exports = { SESSION_TTL_MS, createAuthService, hashPassword, verifyPassword, publicUser }

"use strict"

const REQUIRED_METHODS = Object.freeze([
  'health',
  'openSession',
  'getPage',
  'navigate',
  'evaluate',
  'closeSession'
])

class BrowserProviderError extends Error {
  constructor(message, { code = 'browser_provider_error', retryable = false, cause = null } = {}) {
    super(String(message || 'Browser provider error'))
    this.name = 'BrowserProviderError'
    this.code = String(code)
    this.retryable = Boolean(retryable)
    this.cause = cause || undefined
  }
}

function assertProvider(provider, name = 'browser provider') {
  if (!provider || typeof provider !== 'object') {
    throw new TypeError(`${name} must be an object`)
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof provider[method] !== 'function') {
      throw new TypeError(`${name}.${method} must be a function`)
    }
  }
  return provider
}

function safeProviderError(error, fallback = 'browser_provider_error') {
  if (error instanceof BrowserProviderError) {
    return { code: error.code, retryable: error.retryable, message: error.message.slice(0, 240) }
  }
  return { code: fallback, retryable: false, message: String(error?.message || error || fallback).slice(0, 240) }
}

module.exports = {
  REQUIRED_METHODS,
  BrowserProviderError,
  assertProvider,
  safeProviderError
}

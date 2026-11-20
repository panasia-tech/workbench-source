"use strict"

const { ALLOWED_PROVIDERS } = require('../config.js')
const { BrowserProviderError, assertProvider } = require('./provider.js')
const { createFakeProvider } = require('./fake-provider.js')
const { createAdsPowerProvider } = require('./adspower-provider.js')
const { createCamoufoxProvider } = require('./camoufox-provider.js')
const path = require('node:path')

function createProviderFromConfig(config = {}, options = {}) {
  const name = String(config.provider || '').trim().toLowerCase()
  if (!ALLOWED_PROVIDERS.has(name)) throw new BrowserProviderError(`unsupported browser provider: ${name || '(empty)'}`, { code: 'provider_not_allowed' })
  const factories = {
    fake: options.fake || createFakeProvider,
    adspower: options.adspower || createAdsPowerProvider,
    camoufox: options.camoufox || createCamoufoxProvider
  }
  const factory = factories[name]
  if (typeof factory !== 'function') throw new BrowserProviderError(`${name} provider is not configured`, { code: 'provider_not_configured' })
  const providerOptions = { ...(options[name + 'Options'] || {}) }
  if (name === 'camoufox') {
    if (!providerOptions.userDataDir && config.dataDir) providerOptions.userDataDir = path.join(config.dataDir, 'camoufox')
    if (providerOptions.useCli == null) providerOptions.useCli = ['1', 'true', 'yes', 'on'].includes(String(process.env.CAMOUFOX_USE_CLI || '').toLowerCase())
  }
  const provider = factory(providerOptions)
  return assertProvider(provider, `${name} provider`)
}

module.exports = { createProviderFromConfig }

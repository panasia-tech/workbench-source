"use strict"

const path = require('node:path')

const DEFAULT_PORT = 3080
const DEFAULT_PROVIDER = 'fake'
const ALLOWED_PROVIDERS = new Set(['fake', 'adspower', 'camoufox'])

function readString(env, key, fallback = '') {
  const value = env?.[key]
  return value == null || String(value).trim() === '' ? fallback : String(value).trim()
}

function readPort(env) {
  const raw = readString(env, 'SERVER_PORT', String(DEFAULT_PORT))
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SERVER_PORT must be an integer from 1 to 65535')
  }
  return port
}

function readBoolean(env, key, fallback = false) {
  const value = readString(env, key, fallback ? 'true' : 'false').toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['0', 'false', 'no', 'off'].includes(value)) return false
  throw new Error(`${key} must be a boolean`)
}

function readWorkerConcurrency(env) {
  const raw = readString(env, 'SERVER_WORKER_CONCURRENCY', '2')
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 8) throw new Error('SERVER_WORKER_CONCURRENCY must be an integer from 1 to 8')
  return value
}

function readOptionalUrl(env, key, fallback = '') {
  const raw = readString(env, key, fallback)
  if (!raw) return ''
  let parsed
  try { parsed = new URL(raw) } catch { throw new Error(`${key} must be a valid URL`) }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${key} must be an https URL without credentials or fragment`)
  }
  return parsed.toString().replace(/\/$/, '')
}

function readWmsConfig(env) {
  const source = readString(env, 'WMS_SOURCE', 'auto').toLowerCase()
  if (!['auto', 'rest', 'mcp'].includes(source)) throw new Error('WMS_SOURCE must be one of: auto, rest, mcp')
  const apiBaseUrl = readOptionalUrl(env, 'WMS_API_BASE_URL', 'http://127.0.0.1:8000')
  const mcpUrl = readOptionalUrl(env, 'WMS_MCP_URL', '')
  return Object.freeze({
    source,
    apiBaseUrl,
    mcpUrl,
    mcpKey: readString(env, 'WMS_MCP_KEY', ''),
    restUsername: readString(env, 'WMS_REST_USERNAME', ''),
    restPassword: readString(env, 'WMS_REST_PASSWORD', '')
  })
}

function loadConfig(env = process.env) {
  const provider = readString(env, 'BROWSER_PROVIDER', DEFAULT_PROVIDER).toLowerCase()
  if (!ALLOWED_PROVIDERS.has(provider)) {
    throw new Error(`BROWSER_PROVIDER must be one of: ${[...ALLOWED_PROVIDERS].join(', ')}`)
  }

  const environment = readString(env, 'NODE_ENV', 'development').toLowerCase()
  const allowFakeProvider = readBoolean(env, 'ALLOW_FAKE_PROVIDER', false)
  if (environment === 'production' && provider === 'fake' && !allowFakeProvider) {
    throw new Error('BROWSER_PROVIDER=fake is disabled in production; configure AdsPower/Camoufox or explicitly set ALLOW_FAKE_PROVIDER=true for a controlled test only')
  }

  const dataDir = path.resolve(readString(env, 'XIAN_YU_SERVER_DATA_DIR', path.join(process.cwd(), 'server-data')))
  return Object.freeze({
    host: readString(env, 'SERVER_HOST', '127.0.0.1'),
    port: readPort(env),
    provider,
    dataDir,
    environment,
    allowFakeProvider,
    workerConcurrency: readWorkerConcurrency(env),
    wms: readWmsConfig(env)
  })
}

function publicConfig(config) {
  return {
    environment: config.environment,
    provider: config.provider,
    dataDirConfigured: Boolean(config.dataDir),
    host: config.host,
    port: config.port,
    workerConcurrency: config.workerConcurrency,
    wms: {
      source: config.wms?.source || 'auto',
      apiConfigured: Boolean(config.wms?.restUsername && config.wms?.restPassword),
      mcpConfigured: Boolean(config.wms?.mcpUrl && config.wms?.mcpKey)
    }
  }
}

module.exports = {
  ALLOWED_PROVIDERS,
  DEFAULT_PORT,
  DEFAULT_PROVIDER,
  loadConfig,
  publicConfig
}

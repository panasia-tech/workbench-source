const api = require('./api')

const STORAGE_KEY = 'listing_form_config'
const VERSION_KEY = 'listing_form_config_version'

function saveConfig(data) {
  const normalized = {
    ...data,
    fetched_at: Date.now(),
  }
  wx.setStorageSync(STORAGE_KEY, normalized)
  if (data && data.version) {
    wx.setStorageSync(VERSION_KEY, data.version)
  }
  return normalized
}

function getConfig() {
  return wx.getStorageSync(STORAGE_KEY) || null
}

function getLocalVersion() {
  return wx.getStorageSync(VERSION_KEY) || ''
}

function getStuffStatusOptions() {
  const cfg = getConfig()
  return (cfg && cfg.stuff_status_options) || []
}

function getDefaults() {
  const cfg = getConfig()
  return (cfg && cfg.defaults) || {}
}

function mapConditionGrade(grade) {
  const cfg = getConfig()
  const map = (cfg && cfg.condition_grade_map) || {}
  const key = (grade || '').trim()
  if (key && map[key] !== undefined) return map[key]
  for (const k in map) {
    if (key.indexOf(k) >= 0) return map[k]
  }
  return 85
}

function refreshFormConfig() {
  const token = wx.getStorageSync('token')
  if (!token) {
    return Promise.resolve(getConfig())
  }
  return api.listingFormConfigVersion().then((verRes) => {
    const remote = (verRes && verRes.version) || ''
    const local = getLocalVersion()
    if (remote && remote === local && getConfig()) {
      return getConfig()
    }
    return api.listingFormConfig().then((data) => saveConfig(data))
  }).catch((err) => {
    console.warn('[listing-form-config] refresh failed', err)
    return getConfig()
  })
}

function ensureFormConfig() {
  const cfg = getConfig()
  const token = wx.getStorageSync('token')
  if (!token) {
    return Promise.resolve(cfg)
  }
  return api.listingFormConfigVersion().then((verRes) => {
    const remote = (verRes && verRes.version) || ''
    const local = getLocalVersion()
    if (remote && remote === local && cfg) {
      return cfg
    }
    return refreshFormConfig()
  }).catch(() => refreshFormConfig())
}

module.exports = {
  STORAGE_KEY,
  VERSION_KEY,
  saveConfig,
  getConfig,
  getLocalVersion,
  getStuffStatusOptions,
  getDefaults,
  mapConditionGrade,
  refreshFormConfig,
  ensureFormConfig,
}

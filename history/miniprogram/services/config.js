const api = require('./api')

const STORAGE_KEY = 'app_config'
const LAST_PURCHASE_ACCOUNT_KEY = 'last_purchase_account'

function normalizeConfig(data) {
  let accounts = (data && data.purchase_accounts) || []
  if (!accounts.length && data && data.purchase_shops) {
    accounts = data.purchase_shops.map((shop) => ({
      code: shop.user_name,
      label: shop.shop_name || shop.user_nick || shop.user_name,
    }))
  }
  const locations = (data && data.locations) || []
  const saleShops = (data && data.sale_shops) || []
  const purchaseExamples = (data && data.purchase_examples) || null
  return {
    purchase_accounts: accounts,
    locations,
    sale_shops: saleShops,
    purchase_examples: purchaseExamples,
    fetched_at: Date.now(),
  }
}

function saveConfig(data) {
  const normalized = normalizeConfig(data)
  wx.setStorageSync(STORAGE_KEY, normalized)
  return normalized
}

function getConfig() {
  return wx.getStorageSync(STORAGE_KEY) || null
}

function getPurchaseAccounts() {
  const cfg = getConfig()
  return (cfg && cfg.purchase_accounts) || []
}

function getLocations() {
  const cfg = getConfig()
  return (cfg && cfg.locations) || []
}

function getSaleShops() {
  const cfg = getConfig()
  return (cfg && cfg.sale_shops) || []
}

function getPurchaseExamples() {
  const cfg = getConfig()
  return (cfg && cfg.purchase_examples) || null
}

function findPurchaseAccountLabel(code) {
  const key = (code || '').trim()
  if (!key) return ''
  const account = getPurchaseAccounts().find((row) => row.code === key)
  return account ? account.label : key
}

function getLastPurchaseAccount() {
  return (wx.getStorageSync(LAST_PURCHASE_ACCOUNT_KEY) || '').trim()
}

function saveLastPurchaseAccount(code) {
  const key = (code || '').trim()
  if (!key) {
    wx.removeStorageSync(LAST_PURCHASE_ACCOUNT_KEY)
    return
  }
  wx.setStorageSync(LAST_PURCHASE_ACCOUNT_KEY, key)
}

function refreshConfig() {
  const token = wx.getStorageSync('token')
  if (!token) {
    return Promise.resolve(getConfig())
  }
  return api.appConfig().then((data) => {
    const saved = saveConfig(data)
    return saved
  }).catch((err) => {
    const detail = (err && err.detail) || '配置加载失败'
    console.warn('[config] refresh failed', err)
    wx.showToast({ title: detail, icon: 'none', duration: 3000 })
    return getConfig()
  })
}

function ensureConfig() {
  const cfg = getConfig()
  if (cfg && cfg.fetched_at) {
    return Promise.resolve(cfg)
  }
  return refreshConfig()
}

module.exports = {
  STORAGE_KEY,
  LAST_PURCHASE_ACCOUNT_KEY,
  saveConfig,
  getConfig,
  getPurchaseAccounts,
  getLocations,
  getSaleShops,
  getPurchaseExamples,
  findPurchaseAccountLabel,
  getLastPurchaseAccount,
  saveLastPurchaseAccount,
  refreshConfig,
  ensureConfig,
}

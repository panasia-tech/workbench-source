import { contextBridge, ipcRenderer } from 'electron'

const erp = {
  // 鉴权
  getAuthState: () => ipcRenderer.invoke('auth:get-state'),
  setServer: (url) => ipcRenderer.invoke('auth:set-server', url),
  login: (payload) => ipcRenderer.invoke('auth:login', payload),
  rememberedLogin: () => ipcRenderer.invoke('auth:remembered'),
  enterLocalMode: () => ipcRenderer.invoke('auth:local'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  // 群控/ERP 返回 401 时主进程推这个事件；收到就回登录页，不再把超时/未登录留在会话页
  onAuthExpired: (cb) => {
    if (typeof cb !== 'function') throw new TypeError('onAuthExpired callback must be a function')
    const handler = (_e, payload) => cb(payload || {})
    ipcRenderer.on('auth:expired', handler)
    let active = true
    return () => {
      if (!active) return
      active = false
      ipcRenderer.removeListener('auth:expired', handler)
    }
  },

  // 账号
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  addAccount: (name) => ipcRenderer.invoke('accounts:add', name),
  updateAccount: (id, patch) => ipcRenderer.invoke('accounts:update', { id, patch }),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  gcUnits: (kind) => ipcRenderer.invoke('gc:units', kind),
  gcUnfreeze: (accountId) => ipcRenderer.invoke('gc:unfreeze', accountId),
  gcUpdateDeviceCode: (deviceId) => ipcRenderer.invoke('gc:update-device-code', deviceId),
  chatConversations: (accountId) => ipcRenderer.invoke('chat:conversations', accountId),
  chatMessages: (id) => ipcRenderer.invoke('chat:messages', id),
  chatReply: (conversationId, text) => ipcRenderer.invoke('chat:reply', { conversationId, text }),
  chatMarkRead: (id) => ipcRenderer.invoke('chat:read', id),
  chatReplyRate: (accountId, byAccount) => ipcRenderer.invoke('chat:reply-rate', { accountId, byAccount }),
  adsPowerHealth: () => ipcRenderer.invoke('adspower:health'),
  adsPowerProfiles: () => ipcRenderer.invoke('adspower:profiles'),
  // 浏览器环境管理：新建 / 改用途 / 删除 / 起停 / 回读登录态
  envList: () => ipcRenderer.invoke('envs:list'),
  envCreate: (payload) => ipcRenderer.invoke('envs:create', payload),
  envSetPurpose: (userId, purpose) => ipcRenderer.invoke('envs:purpose', { userId, purpose }),
  envDelete: (userIds) => ipcRenderer.invoke('envs:delete', { userIds }),
  // 删环境时顺带停用它对应的店铺
  envShops: (userId) => ipcRenderer.invoke('envs:shops', { userId }),
  envDisableShops: (shopIds) => ipcRenderer.invoke('envs:disable-shops', { shopIds }),
  envStart: (userId) => ipcRenderer.invoke('envs:start', { userId }),
  envStop: (userId) => ipcRenderer.invoke('envs:stop', { userId }),
  envLoginState: (userId, openTab = false) => ipcRenderer.invoke('envs:login-state', { userId, openTab }),
  envPurposes: () => ipcRenderer.invoke('envs:purposes'),
  envExecutors: () => ipcRenderer.invoke('envs:executors'),
  envExecutorStart: (userId) => ipcRenderer.invoke('envs:executor-start', { userId }),
  envExecutorStop: (userId, stopBrowser = false) => ipcRenderer.invoke('envs:executor-stop', { userId, stopBrowser }),
  envPurposeSave: (name, owner) => ipcRenderer.invoke('envs:purpose-save', { name, owner }),
  executorVersions: () => ipcRenderer.invoke('executor:versions'),
  executorUpdate: () => ipcRenderer.invoke('executor:update'),
  envPurposeDelete: (name) => ipcRenderer.invoke('envs:purpose-delete', { name }),
  // 执行端自动安装的进度（找不到执行端时自己下载）。返回取消订阅：页面离开再回来不重复挂
  onExecutorInstall: (cb) => {
    const handler = (_e, progress) => cb(progress)
    ipcRenderer.on('executor:install-progress', handler)
    return () => ipcRenderer.removeListener('executor:install-progress', handler)
  },
  // 暂停，准备重启电脑 / 重启后恢复。进度与结果由 onRestartState 推送
  restartState: () => ipcRenderer.invoke('restart:state'),
  restartPause: () => ipcRenderer.invoke('restart:pause'),
  restartResume: () => ipcRenderer.invoke('restart:resume'),
  onRestartState: (cb) => {
    const handler = (_e, state) => cb(state)
    ipcRenderer.on('restart:state', handler)
    return () => ipcRenderer.removeListener('restart:state', handler)
  },
  // Only entry point for opening a login/preview window.  It always targets
  // the account's AdsPower profile; the Electron web view is intentionally
  // not exposed here.
  openAdsPowerProfile: (accountId) => ipcRenderer.invoke('adspower:open-preview', { accountId }),
  openAdsPowerPreview: (accountId) => ipcRenderer.invoke('adspower:open-preview', { accountId }),

  // 设置
  getSettings: () => ipcRenderer.invoke('settings:get'),
  adsPowerDirectUrl: () => ipcRenderer.invoke('adspower:direct-url'),
  adsPowerDocs: () => ipcRenderer.invoke('docs:list-adspower'),
  openAdsPowerDoc: (key) => ipcRenderer.invoke('docs:open-adspower', key),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // 任务 / 爬取
  planTasks: () => ipcRenderer.invoke('tasks:plan'),
  startCrawl: (options) => ipcRenderer.invoke('crawl:start', options || {}),
  startTaskQueue: (kind = 'anomaly') => ipcRenderer.invoke('crawl:start-queue', { kind }),
  stopCrawl: () => ipcRenderer.invoke('crawl:stop'),
  crawlStatus: () => ipcRenderer.invoke('crawl:status'),

  // 本地 Excel 任务中心
  getTaskSummary: () => ipcRenderer.invoke('tasks:summary'),
  getTaskResume: () => ipcRenderer.invoke('tasks:resume'),
  getTaskSample: () => ipcRenderer.invoke('tasks:sample'),
  queryTasks: (params) => ipcRenderer.invoke('tasks:list', params),
  queryUnifiedTasks: (params) => ipcRenderer.invoke('tasks:unified-list', params),
  listTaskCollections: () => ipcRenderer.invoke('tasks:collections'),
  queryTaskRuns: (params) => ipcRenderer.invoke('tasks:runs', params),
  getTaskRankings: (params) => ipcRenderer.invoke('tasks:rankings', params),
  queryTaskResults: (params) => ipcRenderer.invoke('tasks:results', params),
  getTaskAiEvents: (params) => ipcRenderer.invoke('tasks:ai-events', params || {}),
  getTaskQueues: (params) => ipcRenderer.invoke('tasks:queues', params),
  manualTaskCorrection: (taskId, patch) => ipcRenderer.invoke('tasks:manual-correction', { taskId, patch: patch || {} }),
  requestTaskRecollect: (taskId, options = {}) => ipcRenderer.invoke('tasks:recollect', { taskId, ...options }),
  listSpuPolicies: () => ipcRenderer.invoke('spu-policy:list'),
  getSpuPolicy: (spuCode) => ipcRenderer.invoke('spu-policy:get', { spuCode }),
  saveSpuPolicy: (spuCode, policy, changedBy = '') => ipcRenderer.invoke('spu-policy:set', { spuCode, policy, changedBy }),
  previewSpuPolicy: (spuCode) => ipcRenderer.invoke('spu-policy:preview', { spuCode }),
  getTaskAliasStatus: () => ipcRenderer.invoke('tasks:alias-status'),
  suggestTaskAliases: (taskId) => ipcRenderer.invoke('tasks:alias-suggest', { taskId }),
  rejectAiAndSearch: (taskId, reason = '') => ipcRenderer.invoke('tasks:ai-reject-search', { taskId, reason }),
  approveAiReview: (taskId) => ipcRenderer.invoke('tasks:ai-review-approve', { taskId }),
  downloadTaskTemplate: () => ipcRenderer.invoke('tasks:download-template'),
  getTaskSnapshot: (path) => ipcRenderer.invoke('tasks:snapshot', { path }),
  exportInvalidPrices: (runId) => ipcRenderer.invoke('tasks:export-invalid', { runId }),
  exportWmsMapping: () => ipcRenderer.invoke('tasks:export-wms'),
  setTaskEnabled: (id, enabled) => ipcRenderer.invoke('tasks:set-enabled', { id, enabled }),
  getTaskSettings: () => ipcRenderer.invoke('tasks:settings:get'),
  setTaskSettings: (patch) => ipcRenderer.invoke('tasks:settings:set', patch),
  importTaskFile: () => ipcRenderer.invoke('tasks:import-file'),

  // 公司 WMS 型号对接
  syncWmsSkus: (options) => ipcRenderer.invoke('wms:sync', options || {}),
  // 上下架：打 ERP 既有接口，与小程序上架页同一套
  getPendingListings: () => ipcRenderer.invoke('listing:pending'),
  getSkuShops: (skuCode) => ipcRenderer.invoke('listing:shops', skuCode),
  publishSku: (skuCode, shopIds) => ipcRenderer.invoke('listing:publish', { skuCode, shopIds }),
  delistSku: (skuCode, shopIds) => ipcRenderer.invoke('listing:delist', { skuCode, shopIds }),
  // 爬虫租约：互斥由服务端判，端上只发起动作和读现状
  getCrawlerState: () => ipcRenderer.invoke('crawler:state'),
  listCrawlerLeases: () => ipcRenderer.invoke('crawler:list'),
  setCrawler: (feature, on) => ipcRenderer.invoke('crawler:set', { feature, on: Boolean(on) }),
  transferCrawler: (feature, toDeviceId) => ipcRenderer.invoke('crawler:transfer', { feature, toDeviceId }),
  getCrawlRuns: (limit) => ipcRenderer.invoke('crawler:runs', limit),
  runCrawlNow: () => ipcRenderer.invoke('crawler:run-now'),
  fetchRunSnapshot: (runId) => ipcRenderer.invoke('crawler:snapshot', runId),
  renameThisPc: (name) => ipcRenderer.invoke('crawler:rename-pc', { name }),
  // 密码库填进 AdsPower：只有状态，没有密码
  getVaultAdsState: () => ipcRenderer.invoke('vault-ads:state'),
  runVaultAdsNow: () => ipcRenderer.invoke('vault-ads:run-now'),
  onVaultAdsState: (cb) => {
    if (typeof cb !== 'function') throw new TypeError('onVaultAdsState callback must be a function')
    const handler = (_e, state) => cb(state)
    ipcRenderer.on('vault-ads:state', handler)
    return () => ipcRenderer.removeListener('vault-ads:state', handler)
  },
  onCrawlerState: (cb) => {
    if (typeof cb !== 'function') throw new TypeError('onCrawlerState callback must be a function')
    const handler = (_e, state) => cb(state)
    ipcRenderer.on('crawler:state', handler)
    let active = true
    return () => {
      if (!active) return
      active = false
      ipcRenderer.removeListener('crawler:state', handler)
    }
  },
  getWmsState: () => ipcRenderer.invoke('wms:state'),
  getWmsCatalog: (params) => ipcRenderer.invoke('wms:catalog', params || {}),
  getWmsProjection: (params) => ipcRenderer.invoke('wms:projection', params || {}),
  updateWmsSku: (params) => ipcRenderer.invoke('wms:update-sku', params || {}),
  onWmsSyncState: (cb) => {
    if (typeof cb !== 'function') throw new TypeError('onWmsSyncState callback must be a function')
    const handler = (_e, state) => cb(state)
    ipcRenderer.on('wms:sync-state', handler)
    let active = true
    return () => {
      if (!active) return
      active = false
      ipcRenderer.removeListener('wms:sync-state', handler)
    }
  },
  correctWmsSkuAndRecollect: (params) => ipcRenderer.invoke('wms:correct-and-recollect', params || {}),

  // Market records use a bounded main-process projection. Price preview and
  // selection are explicit, auditable intents; neither method is a price PUT.
  previewPriceCandidates: (taskId) => ipcRenderer.invoke('market:price-preview', { taskId }),
  confirmPriceSelection: (payload) => ipcRenderer.invoke('market:price-select', payload || {}),
  // Confirmation is the only renderer entry point that can reach the main
  // process price GET/conditional-PUT gate.  There is deliberately no raw
  // price PUT API exposed to the renderer.
  applyPriceSelection: (payload) => ipcRenderer.invoke('market:price-select', payload || {}),
  queryMarketHistory: (params) => ipcRenderer.invoke('market:history', params || {}),

  // 卖家主页采集（与关键词行情采集分开）
  importSellerFile: () => ipcRenderer.invoke('seller:import-file'),
  getLegacySellerQueueSummary: () => ipcRenderer.invoke('seller:legacy-summary'),
  importLegacySellerQueue: () => ipcRenderer.invoke('seller:import-legacy'),
  getSellerSettings: () => ipcRenderer.invoke('seller:settings:get'),
  setSellerSettings: (patch) => ipcRenderer.invoke('seller:settings:set', patch),
  querySellerSources: (params) => ipcRenderer.invoke('seller:sources:query', params),
  querySellerItems: (params) => ipcRenderer.invoke('seller:items:query', params),
  querySellerSnapshots: (params) => ipcRenderer.invoke('seller:snapshots:query', params || {}),
  getSellerQueueDetail: (params) => ipcRenderer.invoke('seller:queue:detail', params || {}),
  getSellerSnapshot: (snapshotRef) => {
    const value = String(snapshotRef || '')
    return ipcRenderer.invoke('seller:snapshot', /^[a-f0-9]{16,64}$/i.test(value) ? { snapshotId: value } : { path: value })
  },
  sellerStatus: () => ipcRenderer.invoke('seller:status'),
  sellerEvents: () => ipcRenderer.invoke('seller:events'),
  getSellerSummary: () => ipcRenderer.invoke('seller:summary'),
  querySellerQueues: (filter) => ipcRenderer.invoke('seller:queues:query', filter),
  sellerQueuesExport: (filter) => ipcRenderer.invoke('seller:queues:export', filter),
  sellerQueuesDetailExport: (filter) => ipcRenderer.invoke('seller:queues:export-detail', filter),
  querySellerRuns: (params) => ipcRenderer.invoke('seller:runs:query', params),
  getSellerRun: (runId) => ipcRenderer.invoke('seller:run:get', { runId }),
  getSellerSchedule: () => ipcRenderer.invoke('seller:schedule:get'),
  setSellerSchedule: (schedule) => ipcRenderer.invoke('seller:schedule:set', schedule),
  getSellerAccountsStatus: () => ipcRenderer.invoke('seller:accounts:status'),
  startSellerCrawl: (options = {}) => ipcRenderer.invoke('seller:start', options),
  stopSellerCrawl: () => ipcRenderer.invoke('seller:stop'),

  // 结果日志
  queryResults: (params) => ipcRenderer.invoke('results:query', params),
  clearResults: () => ipcRenderer.invoke('results:clear'),

  // 窗口
  hideWindow: () => ipcRenderer.invoke('win:hide'),
  minimizeWindow: () => ipcRenderer.invoke('win:minimize'),

  // 爬取事件订阅；返回取消函数
  onCrawlEvent: (cb) => {
    if (typeof cb !== 'function') throw new TypeError('onCrawlEvent callback must be a function')
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('crawl:event', handler)
    let active = true
    return () => {
      if (!active) return
      active = false
      ipcRenderer.removeListener('crawl:event', handler)
    }
  },
  onSellerEvent: (cb) => {
    if (typeof cb !== 'function') throw new TypeError('onSellerEvent callback must be a function')
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('seller:event', handler)
    let active = true
    return () => {
      if (!active) return
      active = false
      ipcRenderer.removeListener('seller:event', handler)
    }
  },

  clearWmsWritebackCredentials: () => ipcRenderer.invoke('wms:clear-writeback-credentials'),

  // 代码热更新
  getCodeUpdateState: () => ipcRenderer.invoke('code-update:state'),
  checkCodeUpdate: () => ipcRenderer.invoke('code-update:check'),
  downloadCodeUpdate: () => ipcRenderer.invoke('code-update:download'),
  restartForCodeUpdate: () => ipcRenderer.invoke('code-update:restart'),
  rollbackCodeUpdate: () => ipcRenderer.invoke('code-update:rollback'),
  onCodeUpdateState: (cb) => {
    if (typeof cb !== 'function') throw new TypeError('onCodeUpdateState callback must be a function')
    const handler = (_e, data) => cb(data)
    ipcRenderer.on('code-update:state', handler)
    let active = true
    return () => {
      if (!active) return
      active = false
      ipcRenderer.removeListener('code-update:state', handler)
    }
  }
}

contextBridge.exposeInMainWorld('erp', erp)

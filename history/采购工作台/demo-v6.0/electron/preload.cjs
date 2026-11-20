const { contextBridge, ipcRenderer } = require('electron')

// ERP 登录令牌：加载时同步取一次，http 请求头直接读，首批请求就带上
let erpToken = ''
try { erpToken = String(ipcRenderer.sendSync('erp-auth:token-sync') || '') } catch {}
// 主进程续期后推来新令牌
ipcRenderer.on('erp-auth:token-updated', (_e, t) => { erpToken = String(t || '') })

contextBridge.exposeInMainWorld('api', {
  erpToken: () => erpToken,
  erpAuthState: () => ipcRenderer.invoke('erp-auth:state'),
  erpLogin: (body) => ipcRenderer.invoke('erp-auth:login', body),
  erpLoginRemembered: () => ipcRenderer.invoke('erp-auth:login-remembered'),
  erpLogout: (body) => ipcRenderer.invoke('erp-auth:logout', body ?? {}),
  onUpdateAvailable: (cb) => {
    const handler = (_event, data) => cb(data)
    ipcRenderer.on('update-available', handler)
    return () => ipcRenderer.removeListener('update-available', handler)
  },
  onUpdateDownloaded: (cb) => {
    const handler = (_event, data) => cb(data)
    ipcRenderer.on('update-downloaded', handler)
    return () => ipcRenderer.removeListener('update-downloaded', handler)
  },
  onUpdateError: (cb) => {
    const handler = (_event, data) => cb(data)
    ipcRenderer.on('update-error', handler)
    return () => ipcRenderer.removeListener('update-error', handler)
  },
  onUpdateDownloadProgress: (cb) => {
    const handler = (_event, data) => cb(data)
    ipcRenderer.on('update-download-progress', handler)
    return () => ipcRenderer.removeListener('update-download-progress', handler)
  },
  onUpdateChecking: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('update-checking', handler)
    return () => ipcRenderer.removeListener('update-checking', handler)
  },
  onUpdateNotAvailable: (cb) => {
    const handler = (_event, data) => cb(data)
    ipcRenderer.on('update-not-available', handler)
    return () => ipcRenderer.removeListener('update-not-available', handler)
  },
  checkForUpdates: () => ipcRenderer.send('check-for-updates'),
  downloadUpdate: () => ipcRenderer.send('download-update'),
  quitAndInstall: () => ipcRenderer.send('quit-and-install'),
  cancelUpdateDownload: () => {},
  getUpdateState: () => ipcRenderer.invoke('get-update-state'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  exitApp: () => ipcRenderer.invoke('exit-app'),

  listAccounts: () => ipcRenderer.invoke('list-accounts'),
  /** 后台强刷倒计时：下一轮最早唤醒时间 */
  getSxjkMh5ForceRefreshSchedule: () => ipcRenderer.invoke('sxjk-mh5-force-refresh-schedule'),
  saveAccount: (account) => ipcRenderer.invoke('save-account', account),
  addAccountViaPlaywright: (info) => ipcRenderer.invoke('add-account-via-playwright', info),
  openLoginSession: (info) => ipcRenderer.invoke('open-login-session', info),
  captureLoginSession: (info) => ipcRenderer.invoke('capture-login-session', info),
  closeLoginSession: (info) => ipcRenderer.invoke('close-login-session', info),
  setWorkbenchEmbedBounds: (bounds) => ipcRenderer.invoke('set-workbench-embed-bounds', bounds),
  hideWorkbenchEmbed: () => ipcRenderer.invoke('hide-workbench-embed'),
  setWorkbenchEmbedOverlayLock: (locked) =>
    ipcRenderer.invoke('set-workbench-embed-overlay-lock', { locked: !!locked }),
  onSxjkWorkbenchEmbedOverlayLock: (cb) => {
    const handler = (_event, data) => cb(data)
    ipcRenderer.on('sxjk-workbench-embed-overlay-lock', handler)
    return () => ipcRenderer.removeListener('sxjk-workbench-embed-overlay-lock', handler)
  },
  workbenchNavigate: (info) => ipcRenderer.invoke('workbench-navigate', info),
  workbenchEmbedGetNavState: (info) => ipcRenderer.invoke('workbench-embed-get-nav-state', info),
  workbenchEmbedGoBack: (info) => ipcRenderer.invoke('workbench-embed-go-back', info),
  workbenchEmbedReload: (info) => ipcRenderer.invoke('workbench-embed-reload', info),
  onSxjkGoofishEmbedHistory: (cb) => {
    const handler = (_event, data) => cb(data)
    ipcRenderer.on('sxjk-goofish-embed-history', handler)
    return () => ipcRenderer.removeListener('sxjk-goofish-embed-history', handler)
  },
  onSxjkGoofishEmbedSellerRoute: (cb) => {
    const handler = (_event, data) => cb(data)
    ipcRenderer.on('sxjk-goofish-embed-seller-route', handler)
    return () => ipcRenderer.removeListener('sxjk-goofish-embed-seller-route', handler)
  },
  onSxjkGoofishEmbedLoginAutosaved: (cb) => {
    const handler = (_event, data) => cb(data)
    ipcRenderer.on('sxjk-goofish-embed-login-autosaved', handler)
    return () => ipcRenderer.removeListener('sxjk-goofish-embed-login-autosaved', handler)
  },
  onSxjkGoofishEmbedLoginPageRenewed: (cb) => {
    const handler = (_event, data) => cb(data)
    ipcRenderer.on('sxjk-goofish-embed-login-page-renewed', handler)
    return () => ipcRenderer.removeListener('sxjk-goofish-embed-login-page-renewed', handler)
  },
  queryAccounts: (params) => ipcRenderer.invoke('query-accounts', params),
  deleteAccount: (info) => ipcRenderer.invoke('delete-account', info),
  deleteAccounts: (info) => ipcRenderer.invoke('delete-accounts', info),
  setAccountOrder: (info) => ipcRenderer.invoke('set-account-order', info),
  updateAccount: (info) => ipcRenderer.invoke('update-account', info),
  /** 从分区读 Cookie 拉取昵称/头像，写入账号 JSON */
  refreshAccountGoofishProfile: (payload) =>
    ipcRenderer.invoke('refresh-account-goofish-profile', payload ?? {}),
  onSxjkAccountProfileSynced: (cb) => {
    const handler = (_event, data) => cb(data)
    ipcRenderer.on('sxjk-account-profile-synced', handler)
    return () => ipcRenderer.removeListener('sxjk-account-profile-synced', handler)
  },
  /** 验证码/登录窗关窗后 Cookie 已写回本地，需立刻上报服务端 */
  onSxjkAccountCookiePersisted: (cb) => {
    const handler = (_event, data) => cb(data)
    ipcRenderer.on('sxjk-account-cookie-persisted', handler)
    return () => ipcRenderer.removeListener('sxjk-account-cookie-persisted', handler)
  },
  /** 冷启动 mh5 后台预热全部完成后，触发一次批量 syncCookies */
  onSxjkAccountsMh5WarmupDone: (cb) => {
    const handler = (_event, data) => cb(data)
    ipcRenderer.on('sxjk-accounts-mh5-warmup-done', handler)
    return () => ipcRenderer.removeListener('sxjk-accounts-mh5-warmup-done', handler)
  },
  onSxjkAccountGoofishPageOpened: (cb) => {
    const handler = (_event, data) => cb(data)
    ipcRenderer.on('sxjk-account-goofish-page-opened', handler)
    return () => ipcRenderer.removeListener('sxjk-account-goofish-page-opened', handler)
  },
  openInject: (info) => ipcRenderer.invoke('open-inject', info),
  getMonitoringRuntimeSettings: () => ipcRenderer.invoke('get-monitoring-runtime-settings'),
  queryMonitoring: (params) => ipcRenderer.invoke('query-monitoring', params),
  deleteMonitoring: (info) => ipcRenderer.invoke('delete-monitoring', info),
  addMonitoring: (info) => ipcRenderer.invoke('add-monitoring', info),
  updateMonitoring: (info) => ipcRenderer.invoke('update-monitoring', info),
  startMonitoring: (info) => ipcRenderer.invoke('start-monitoring', info),
  stopMonitoring: (info) => ipcRenderer.invoke('stop-monitoring', info),
  openSkuPage: (info) => ipcRenderer.invoke('open-sku-page', info),
  checkLoginStatus: (info) => ipcRenderer.invoke('check-login-status', info),
  queryMonitoringLogs: (params) => ipcRenderer.invoke('query-monitoring-logs', params),
  getMonitoringLogs: (params) => ipcRenderer.invoke('get-monitoring-logs', params),
  clearMonitoringLogs: (params) => ipcRenderer.invoke('clear-monitoring-logs', params),

  getAppConfig: () => ipcRenderer.invoke('get-app-config'),
  updateAppConfig: (config) => ipcRenderer.invoke('update-app-config', config),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('set-always-on-top', enabled),

  getDeviceId: () => ipcRenderer.invoke('get-device-id'),
  validateDeviceId: () => ipcRenderer.invoke('validate-device-id'),
  regenerateDeviceId: () => ipcRenderer.invoke('regenerate-device-id'),
  getDeviceInfo: () => ipcRenderer.invoke('get-device-info'),

  setWindowSize: (width, height) => ipcRenderer.invoke('set-window-size', width, height),

  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),

  sendDingtalkMarkdown: (payload) => ipcRenderer.invoke('send-dingtalk-markdown', payload),
  sendDingtalkActionCard: (payload) => ipcRenderer.invoke('send-dingtalk-action-card', payload),
  sendDingtalkLink: (payload) => ipcRenderer.invoke('send-dingtalk-link', payload),
  getDingtalkConnectTestState: () => ipcRenderer.invoke('get-dingtalk-connect-test-state'),
  recordDingtalkConnectTest: (payload) => ipcRenderer.invoke('record-dingtalk-connect-test', payload),

  getSxjkListenTasks: () => ipcRenderer.invoke('get-sxjk-listen-tasks'),
  saveSxjkListenTasks: (tasks) => ipcRenderer.invoke('save-sxjk-listen-tasks', tasks),
  /** 钉钉签名链接触发后由服务端 Socket 下发，渲染进程再调此 IPC 写本地任务 */
  applySxjkListenTaskQuickCmd: (payload) =>
    ipcRenderer.invoke('apply-sxjk-listen-task-quick-cmd', payload ?? {}),

  getSxjkKeywordHistory: () => ipcRenderer.invoke('get-sxjk-keyword-history'),
  saveSxjkKeywordHistory: (keywords) => ipcRenderer.invoke('save-sxjk-keyword-history', keywords),

  getSxjkPushedItemIds: () => ipcRenderer.invoke('get-sxjk-pushed-item-ids'),
  appendSxjkPushedItemIds: (ids) => ipcRenderer.invoke('append-sxjk-pushed-item-ids', ids),

  appendSxjkPushLog: (entry) => ipcRenderer.invoke('append-sxjk-push-log', entry),
  querySxjkPushLogs: (query) => ipcRenderer.invoke('query-sxjk-push-logs', query),
  getSxjkPushLogDetail: (payload) => ipcRenderer.invoke('get-sxjk-push-log-detail', payload),
  getSxjkPushLogItemIds: () => ipcRenderer.invoke('get-sxjk-push-log-item-ids'),
  deleteSxjkPushLogs: (ids) => ipcRenderer.invoke('delete-sxjk-push-logs', ids),
  deleteSxjkPushLogsByTaskId: (taskId) =>
    ipcRenderer.invoke('delete-sxjk-push-logs-by-task-id', taskId),
  clearSxjkPushLogs: () => ipcRenderer.invoke('clear-sxjk-push-logs'),

  appendSxjkPollCheckLog: (entry) => ipcRenderer.invoke('append-sxjk-poll-check-log', entry),
  querySxjkPollCheckLogs: (query) => ipcRenderer.invoke('query-sxjk-poll-check-logs', query),
  deleteSxjkPollCheckLogs: (ids) => ipcRenderer.invoke('delete-sxjk-poll-check-logs', ids),
  clearSxjkPollCheckLogs: () => ipcRenderer.invoke('clear-sxjk-poll-check-logs'),

  /** 店铺上新监听（独立本地 JSON，与任务管理无关） */
  loadSxjkShopMonitors: () => ipcRenderer.invoke('sxjk-shop-monitors-load'),
  saveSxjkShopMonitors: (list) => ipcRenderer.invoke('sxjk-shop-monitors-save', list),
  sxjkNormalizeMtopCardListJson: (body) => ipcRenderer.invoke('sxjk-normalize-mtop-card-list-json', body ?? {}),
  getSxjkShopPushedItemIds: () => ipcRenderer.invoke('get-sxjk-shop-pushed-item-ids'),
  appendSxjkShopPushedItemIds: (ids) => ipcRenderer.invoke('append-sxjk-shop-pushed-item-ids', ids),
  appendSxjkShopPushLog: (entry) => ipcRenderer.invoke('append-sxjk-shop-push-log', entry),
  querySxjkShopPushLogs: (query) => ipcRenderer.invoke('query-sxjk-shop-push-logs', query),
  getSxjkShopPushLogItemIds: () => ipcRenderer.invoke('get-sxjk-shop-push-log-item-ids'),
  removeSxjkShopPushDedupByItemIds: (payload) =>
    ipcRenderer.invoke('remove-sxjk-shop-push-dedup-by-item-ids', payload ?? {}),
  deleteSxjkShopPushLogs: (ids) => ipcRenderer.invoke('delete-sxjk-shop-push-logs', ids),
  deleteSxjkShopPushLogsByMonitorId: (monitorId) =>
    ipcRenderer.invoke('delete-sxjk-shop-push-logs-by-monitor-id', monitorId),
  clearSxjkShopPushLogs: () => ipcRenderer.invoke('clear-sxjk-shop-push-logs'),

  appendSxjkGrabLog: (entry) => ipcRenderer.invoke('append-sxjk-grab-log', entry),
  querySxjkGrabLogs: (query) => ipcRenderer.invoke('query-sxjk-grab-logs', query),
  deleteSxjkGrabLogs: (ids) => ipcRenderer.invoke('delete-sxjk-grab-logs', ids),
  clearSxjkGrabLogs: () => ipcRenderer.invoke('clear-sxjk-grab-logs'),
  onSxjkGrabLogAppended: (fn) => {
    const handler = (_e, payload) => fn(payload)
    ipcRenderer.on('sxjk-grab-log-appended', handler)
    return () => ipcRenderer.removeListener('sxjk-grab-log-appended', handler)
  },

  /** @param {string | { url: string, accountId?: string, cookieHeader?: string }} payload */
  openXianyuGoofishInSession: (payload) => ipcRenderer.invoke('open-xianyu-goofish-in-session', payload),
  getGuestCookie: (opts) => ipcRenderer.invoke('get-guest-cookie', opts ?? {}),
  setGuestCookie: (opts) => ipcRenderer.invoke('set-guest-cookie', opts ?? {}),
  clearGuestCookie: (opts) => ipcRenderer.invoke('clear-guest-cookie', opts ?? {}),
  /** 游客授权：应用内窗口登录并自动落盘，成功后自动关窗 */
  xianyuGuestAuthInAppWindow: (opts) => ipcRenderer.invoke('xianyu-guest-auth-in-app-window', opts ?? {}),
  getXianyuMtopCookieForTask: (opts) => ipcRenderer.invoke('get-xianyu-mtop-cookie-for-task', opts ?? {}),
  /** 令牌过期：单账号静默进闲鱼刷 _m_h5_tk */
  sxjkRefreshAccountMh5Token: (opts) => ipcRenderer.invoke('sxjk-refresh-account-mh5-token', opts ?? {}),
  getXianyuMtopCookiesForSyncBatch: (opts) =>
    ipcRenderer.invoke('get-xianyu-mtop-cookies-for-sync-batch', opts ?? {}),
  /** 服务端 pull：批量注入云端 Cookie 到本机分区 */
  injectCloudMtopCookiesBatch: (opts) =>
    ipcRenderer.invoke('inject-cloud-mtop-cookies-batch', opts ?? {}),
  /** 已签名 MTOP：主进程本机 POST h5api（兼容旧路径） */
  sxjkPostSignedMtopRequest: (body) => ipcRenderer.invoke('sxjk-post-signed-mtop-request', body),
  /** 本机搜索轮询：POST h5api + normalize + 本地过滤（需已签名包） */
  sxjkExecuteClientSearchPoll: (body) =>
    ipcRenderer.invoke('sxjk-execute-client-search-poll', body ?? {}),
  sxjkExecuteClientPcItemDetail: (body) =>
    ipcRenderer.invoke('sxjk-execute-client-pc-item-detail', body ?? {}),
  /** 店铺列表：POST h5api + normalize（需已签名包） */
  sxjkExecuteClientShopXyhItemList: (body) =>
    ipcRenderer.invoke('sxjk-execute-client-shop-xyh-item-list', body ?? {}),
  /** 本机算签+搜索（不再打后端 /signSearch） */
  sxjkMtopSearch: (body) => ipcRenderer.invoke('sxjk-mtop-search', body ?? {}),
  /** 本机算签+店铺列表 */
  sxjkMtopXyhItemList: (body) => ipcRenderer.invoke('sxjk-mtop-xyh-item-list', body ?? {}),
  /** 本机批量检测过期（读分区 Cookie + nav） */
  sxjkMtopVerifyLoginBatch: (body) =>
    ipcRenderer.invoke('sxjk-mtop-verify-login-batch', body ?? {}),
  sxjkMtopFetchProfile: (body) => ipcRenderer.invoke('sxjk-mtop-fetch-profile', body ?? {}),
  sxjkMtopSearchSuggest: (body) => ipcRenderer.invoke('sxjk-mtop-search-suggest', body ?? {}),
  sxjkMtopUserPageHead: (body) => ipcRenderer.invoke('sxjk-mtop-user-page-head', body ?? {}),
  sxjkMtopPcItemSeller: (body) => ipcRenderer.invoke('sxjk-mtop-pc-item-seller', body ?? {}),
  /** 冷启动：主进程分区迁移完成后再读 Cookie（mh5 后台预热另走 onSxjkAccountsMh5WarmupDone） */
  sxjkAccountsPartitionStartupReady: () =>
    ipcRenderer.invoke('sxjk-accounts-partition-startup-ready'),
  /** 分区无登录态时用云端 mtop_cookie 补回（分区已有 unb 则不覆盖） */
  restoreAccountPartitionLogin: (body) => ipcRenderer.invoke('account-partition-restore-login', body ?? {}),
  /** 等本机 mh5 开窗预热结束（有 unb 无签名的账号刷完） */
  sxjkAccountsPartitionMh5WarmupReady: () =>
    ipcRenderer.invoke('sxjk-accounts-partition-mh5-warmup-ready'),
  accountPartitionHasLogin: (body) => ipcRenderer.invoke('account-partition-has-login', body ?? {}),
  /** 任务表单搜索联想：全局游客 Cookie */
  getXianyuMtopGuestCookieForSuggest: () =>
    ipcRenderer.invoke('get-xianyu-mtop-guest-cookie-for-suggest'),
  /** 上传到闲鱼 stream-upload CDN（须已登录；与 xianyu-login-lite 一致） */
  sxjkUploadGoofishChatImage: (opts) => ipcRenderer.invoke('sxjk-upload-goofish-chat-image', opts ?? {}),
  /** 秒拍 / 锁单：MTOP 接口下单 */
  goofishMiaopaiConfirmBuy: (opts) => ipcRenderer.invoke('goofish-miaopai-confirm-buy', opts ?? {}),
  sxjkMiaopaiListDeliverAddress: (opts) =>
    ipcRenderer.invoke('sxjk-miaopai-list-deliver-address', opts ?? {}),
  /** 锁单遇风控：用锁单账号打开商品详情页引导过滑块 */
  sxjkAssistLockOrderRiskVerify: (opts) =>
    ipcRenderer.invoke('sxjk-assist-lock-order-risk-verify', opts ?? {}),
  /** 仅预热闲鱼 wss-goofish（打开打招呼开关时调用） */
  sxjkGoofishImWarmup: (body) => ipcRenderer.invoke('sxjk-goofish-im-warmup', body ?? {}),
  /** MTOP + wss-goofish 私聊发一条测试文字（须账号 Cookie 含 unb） */
  sxjkGoofishImTestSend: (body) => ipcRenderer.invoke('sxjk-goofish-im-test-send', body ?? {}),
  /** 服务端打招呼批量详情成功后：主进程缓存并向渲染进程推送（供后续私聊发信使用） */
  sxjkGoofishImIngestGreetingPrefetch: (body) =>
    ipcRenderer.invoke('sxjk-goofish-im-ingest-greeting-prefetch', body ?? {}),

  /** 主进程经渲染进程代发已登录后端 API */
  onSxjkBackendBridgeRequest: (cb) => {
    const fn = (_event, data) => cb(data)
    ipcRenderer.on('sxjk-backend-bridge-req', fn)
    return () => ipcRenderer.removeListener('sxjk-backend-bridge-req', fn)
  },
  replySxjkBackendBridge: (requestId, result) =>
    ipcRenderer.send('sxjk-backend-bridge-res', { requestId, result }),
  /** 将本页商品写入列表快照文件，与磁盘上一版比 itemId，返回 newItemIds 后整文件替换 */
  sxjkListingSnapshotDiffAndSave: (body) =>
    ipcRenderer.invoke('sxjk-listing-snapshot-diff-and-save', body ?? {}),
  /** 分页全量同步：合并写入列表快照（replace / append） */
  sxjkListingSnapshotMergeItems: (body) =>
    ipcRenderer.invoke('sxjk-listing-snapshot-merge-items', body ?? {}),
  /** 按 scope 删除 monitoring/sxjk-listing-snapshots 下快照（task | shop | all） */
  sxjkClearListingSnapshots: (payload) =>
    ipcRenderer.invoke('sxjk-clear-listing-snapshots', payload ?? {}),
  sxjkDeleteListingSnapshot: (payload) =>
    ipcRenderer.invoke('sxjk-delete-listing-snapshot', payload ?? {}),
  sxjkReadListingSnapshot: (payload) =>
    ipcRenderer.invoke('sxjk-read-listing-snapshot', payload ?? {}),
  sxjkRemoveListingSnapshotItems: (payload) =>
    ipcRenderer.invoke('sxjk-remove-listing-snapshot-items', payload ?? {}),
  /** 本地映射：列表侧加密卖家 id → 明文 userId（减少重复拉卖家信息） */
  sxjkSellerPlainMapLookup: (body) => ipcRenderer.invoke('sxjk-seller-plain-map-lookup', body ?? {}),
  sxjkSellerPlainMapPut: (body) => ipcRenderer.invoke('sxjk-seller-plain-map-put', body ?? {}),
  /** 渲染进程把关键监控日志同步到主进程控制台（Electron 终端可见）。 */
  sxjkMainLog: (payload) => ipcRenderer.invoke('sxjk-main-log', payload ?? {}),
  /** 本机 SQLite KV（如账号页自动续期节流时间戳） */
  sxjkLocalStateGet: (body) => ipcRenderer.invoke('sxjk-local-state-get', body ?? {}),
  sxjkLocalStateSet: (body) => ipcRenderer.invoke('sxjk-local-state-set', body ?? {}),
  /** 本机全局轮询间隔（pc_client_pref） */
  sxjkPcClientPrefGet: () => ipcRenderer.invoke('sxjk-pc-client-pref-get'),
  sxjkPcClientPrefSet: (body) => ipcRenderer.invoke('sxjk-pc-client-pref-set', body ?? {}),

  onSxjkGreetingDetailPrefetch: (cb) => {
    const fn = (_event, data) => cb(data)
    ipcRenderer.on('sxjk-greeting-detail-prefetch', fn)
    return () => ipcRenderer.removeListener('sxjk-greeting-detail-prefetch', fn)
  },
  onSxjkAccountImRealtimeChanged: (cb) => {
    const fn = (_event, data) => cb(data)
    ipcRenderer.on('sxjk-account-im-realtime-changed', fn)
    return () => ipcRenderer.removeListener('sxjk-account-im-realtime-changed', fn)
  },
  onSxjkGoofishImVerifyOpened: (cb) => {
    const fn = (_event, data) => cb(data)
    ipcRenderer.on('sxjk-goofish-im-verify-opened', fn)
    return () => ipcRenderer.removeListener('sxjk-goofish-im-verify-opened', fn)
  },
})

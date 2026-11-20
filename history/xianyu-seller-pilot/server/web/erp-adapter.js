/* global window, document, fetch, FormData, EventSource */
(function installWebErp() {
  if (window.erp) return

  async function request(url, options = {}) {
    const headers = { ...(options.headers || {}) }
    const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData
    if (!isForm && options.body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(url, { credentials: 'same-origin', ...options, headers })
    const contentType = response.headers.get('content-type') || ''
    const data = contentType.includes('application/json') ? await response.json().catch(() => ({})) : await response.text()
    if (!response.ok) throw new Error(data?.error?.message || data?.error?.code || `HTTP ${response.status}`)
    return data
  }

  function unsupported(name) {
    return Promise.reject(new Error(`${name} 尚未迁移到服务器，请先使用服务器任务控制台`))
  }

  function pickFile(accept = '.xlsx,.xls,.xlsm') {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = accept
      input.onchange = () => resolve(input.files?.[0] || null)
      input.click()
    })
  }

  async function download(url, fallbackName = '下载文件') {
    const response = await fetch(url, { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}）`)
    const blob = await response.blob()
    const objectUrl = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = fallbackName
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    return { ok: true }
  }

  async function previewArtifact(id) {
    const response = await fetch(`/artifacts/${encodeURIComponent(id)}`, { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`快照读取失败（HTTP ${response.status}）`)
    const blob = await response.blob()
    const disposition = response.headers.get('content-disposition') || ''
    const filename = decodeURIComponent((disposition.match(/filename\*=UTF-8''([^;]+)/i) || [])[1] || '').replace(/[\r\n"\\]/g, '')
    const contentType = String(response.headers.get('content-type') || blob.type || '').toLowerCase()
    if (contentType.includes('html') || /\.html?$/i.test(filename)) {
      const htmlBlob = blob.type.includes('html') ? blob : new Blob([await blob.arrayBuffer()], { type: 'text/html;charset=utf-8' })
      return { ok: true, kind: 'html', url: URL.createObjectURL(htmlBlob), name: filename || '网页快照.html' }
    }
    if (contentType.startsWith('image/')) return { ok: true, kind: 'image', dataUrl: URL.createObjectURL(blob), name: filename || '快照图片' }
    return { ok: true, kind: 'html_text', html: await blob.text(), name: filename || '快照内容' }
  }

  async function getAuthState() {
    try {
      const data = await request('/auth/me')
      return { hasToken: true, localMode: false, staff: data.user }
    } catch {
      return { hasToken: false, localMode: false, staff: null }
    }
  }

  function mapProfile(profile) {
    return {
      id: profile.id,
      name: profile.label || profile.vendor_profile_id,
      label: profile.label,
      provider: profile.provider,
      browserProvider: profile.provider,
      bitBrowserId: profile.vendor_profile_id,
      vendorProfileId: profile.vendor_profile_id,
      loggedIn: profile.status === 'logged_in',
      enabled: profile.status !== 'disabled',
      status: profile.status
    }
  }

  async function listAccounts() {
    const data = await request('/profiles')
    return (data.profiles || []).map(mapProfile)
  }

  async function listProfiles() {
    const data = await request('/profiles')
    return data.profiles || []
  }

  async function workbench(path, options) {
    return request(`/workbench${path}`, options)
  }

  const webErp = {
    mode: 'web',
    getAuthState,
    setServer: () => unsupported('服务器地址设置'),
    login: async (payload) => { const data = await request('/auth/login', { method: 'POST', body: JSON.stringify(payload) }); return { ok: true, user: data.user } },
    enterLocalMode: () => Promise.resolve({ ok: false, reason: 'H5 不支持本机模式，请使用服务器账号登录' }),
    logout: () => request('/auth/logout', { method: 'POST', body: '{}' }),

    listAccounts,
    addAccount: async (input) => {
      if (typeof input === 'string') return unsupported('新增账号')
      const vendorProfileId = String(input?.vendorProfileId || '').trim()
      if (!vendorProfileId) throw new Error('Profile ID 不能为空')
      const configuredProvider = input?.provider || (await request('/health')).provider || 'camoufox'
      const data = await request('/profiles', { method: 'POST', body: JSON.stringify({ provider: configuredProvider, vendorProfileId, label: input?.label || vendorProfileId }) })
      return mapProfile(data.profile)
    },
    updateAccount: (id, patch = {}) => {
      const body = { ...patch }
      if (body.bitBrowserId && !body.vendorProfileId) body.vendorProfileId = body.bitBrowserId
      if (body.browserProvider === 'bitbrowser') body.provider = 'adspower'
      if (body.name && !body.label) body.label = body.name
      delete body.bitBrowserId
      delete body.browserProvider
      delete body.name
      return request(`/profiles/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) }).then(data => mapProfile(data.profile))
    },
    removeAccount: (id) => request(`/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    bitBrowserHealth: () => request('/health'),
    bitBrowserProfiles: async () => (await listProfiles()).map(profile => ({ id: profile.vendor_profile_id, name: profile.label, provider: profile.provider })),
    openBitBrowserProfile: (profileId, url) => request(`/profiles/${encodeURIComponent(profileId)}/manual-session`, { method: 'POST', body: JSON.stringify({ url }) }),
    openBitBrowserPreview: (profileId, url) => request(`/profiles/${encodeURIComponent(profileId)}/manual-session`, { method: 'POST', body: JSON.stringify({ url }) }),
    getManualBrowserSession: (profileId, options = {}) => request(`/profiles/${encodeURIComponent(profileId)}/manual-session?${new URLSearchParams(options)}`),
    manualBrowserAction: (profileId, action = {}) => request(`/profiles/${encodeURIComponent(profileId)}/manual-session/action`, { method: 'POST', body: JSON.stringify(action) }),
    closeManualBrowserSession: (profileId, sessionId) => request(`/profiles/${encodeURIComponent(profileId)}/manual-session`, { method: 'DELETE', body: JSON.stringify({ sessionId }) }),

    // H5 is server-authoritative.  Do not silently fall back to renderer
    // defaults when the server is unavailable; that would make an employee
    // believe a schedule/settings change was saved when it was not.
    getSettings: () => request('/settings'),
    setSettings: (patch) => request('/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
    planTasks: () => workbench('/plan'),
    startCrawl: (options = {}) => workbench('/start', { method: 'POST', body: JSON.stringify(options) }),
    startTaskQueue: (kind = 'anomaly', taskId = null) => workbench('/retry', { method: 'POST', body: JSON.stringify({ kind, taskId }) }),
    stopCrawl: () => request('/jobs?status=running').then(data => Promise.all((data.jobs || []).map(job => request(`/jobs/${job.id}/cancel`, { method: 'POST', body: '{}' })))).then(() => ({ ok: true })),
    crawlStatus: () => request('/jobs?status=running').then(data => ({ running: (data.jobs || []).length > 0 })),

    getTaskSummary: () => workbench('/summary'),
    getTaskResume: () => workbench('/resume'),
    getTaskSample: () => workbench('/sample'),
    queryTasks: (params) => workbench(`/tasks?${new URLSearchParams(params || {})}`),
    queryUnifiedTasks: (params) => workbench(`/tasks?${new URLSearchParams(params || {})}`),
    listTaskCollections: () => workbench('/collections'),
    queryTaskRuns: (params) => workbench(`/runs?${new URLSearchParams(params || {})}`),
    getTaskRankings: (params) => workbench(`/rankings?${new URLSearchParams(params || {})}`),
    queryTaskResults: (params) => workbench(`/results?${new URLSearchParams(params || {})}`),
    getTaskAiEvents: (params = {}) => {
      const taskId = params.taskId || params.id || params
      const query = params && typeof params === 'object' ? `?${new URLSearchParams({ limit: params.limit || 20 })}` : ''
      return request(`/workbench/tasks/${encodeURIComponent(taskId || '')}/ai-events${query}`)
    },
    getTaskQueues: (params) => workbench(`/queues?${new URLSearchParams(params || {})}`),
    manualTaskCorrection: (taskIdOrPayload, maybePatch = {}) => {
      const payload = taskIdOrPayload && typeof taskIdOrPayload === 'object'
        ? taskIdOrPayload
        : { taskId: taskIdOrPayload, patch: maybePatch }
      const taskId = payload.taskId || payload.id
      const patch = payload.patch || payload
      return workbench(`/tasks/${encodeURIComponent(taskId || '')}/identity`, { method: 'PATCH', body: JSON.stringify(patch) })
    },
    requestTaskRecollect: (taskId, options = {}) => workbench('/retry', { method: 'POST', body: JSON.stringify({ taskId, ...options }) }),
    listSpuPolicies: () => workbench('/policies'),
    getSpuPolicy: (spuCode) => workbench(`/policies/${encodeURIComponent(spuCode)}`),
    saveSpuPolicy: (spuCode, policy) => workbench(`/policies/${encodeURIComponent(spuCode)}`, { method: 'PUT', body: JSON.stringify(policy) }),
    previewSpuPolicy: (spuCode) => workbench(`/policies/${encodeURIComponent(spuCode)}/preview`),
    getTaskAliasStatus: () => request('/workbench/ai/status'),
    suggestTaskAliases: (taskId) => request(`/workbench/tasks/${encodeURIComponent(taskId || '')}/aliases/suggest`, { method: 'POST', body: '{}' }),
    rejectAiAndSearch: (taskId, reason = '') => request(`/workbench/tasks/${encodeURIComponent(taskId || '')}/ai-search`, { method: 'POST', body: JSON.stringify({ reason }) }),
    approveAiReview: (taskId) => request(`/workbench/tasks/${encodeURIComponent(taskId || '')}/ai-review/approve`, { method: 'POST', body: '{}' }),
    downloadTaskTemplate: () => download('/workbench/template', '巡航台任务清单_sample.xlsx'),
    getTaskSnapshot: previewArtifact,
    exportInvalidPrices: (runId) => download(`/workbench/export-invalid?runId=${encodeURIComponent(runId || '')}`, '错误价格.xlsx'),
    exportWmsMapping: () => download('/workbench/export-wms', 'API-SPU-映射.xlsx'),
    setTaskEnabled: (id, enabled) => workbench(`/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    getTaskSettings: async () => {
      const [settings, wmsConfig] = await Promise.all([workbench('/settings'), request('/wms/config').catch(() => ({}))])
      return {
        ...settings,
        wmsSource: wmsConfig.source || settings.wmsSource || 'auto',
        wmsMcpUrl: '',
        wmsMcpKeyConfigured: Boolean(wmsConfig.mcpConfigured),
        wmsRestUsernameConfigured: Boolean(wmsConfig.apiConfigured),
        wmsRestPasswordConfigured: Boolean(wmsConfig.apiConfigured),
        wmsServerConfigured: Boolean(wmsConfig.apiBaseConfigured && (wmsConfig.apiConfigured || wmsConfig.mcpConfigured))
      }
    },
    setTaskSettings: (patch = {}) => {
      const wmsKeys = ['wmsSource', 'wmsMcpUrl', 'wmsMcpKey', 'wmsRestUsername', 'wmsRestPassword']
      if (wmsKeys.some(key => Object.hasOwn(patch, key))) return unsupported('WMS 凭据配置（请由服务器管理员维护私有环境文件）')
      return workbench('/settings', { method: 'PATCH', body: JSON.stringify(patch) })
    },
    importTaskFile: async () => { const file = await pickFile(); if (!file) return { canceled: true }; const form = new FormData(); form.append('file', file); return workbench('/import', { method: 'POST', body: form }) },

    syncWmsSkus: () => request('/wms/sync', { method: 'POST', body: '{}' }),
    getWmsState: () => request('/wms/state'),
    getWmsCatalog: (params) => request(`/wms/catalog?${new URLSearchParams(params || {})}`),
    getWmsProjection: (params) => request(`/wms/projection?${new URLSearchParams(params || {})}`),
    updateWmsSku: (payload = {}) => request('/wms/identity-writeback', { method: 'POST', body: JSON.stringify(payload) }),
    updateMarketTaskIdentity: (taskId, patch = {}) => workbench(`/tasks/${encodeURIComponent(taskId)}/identity`, { method: 'PATCH', body: JSON.stringify(patch) }).then(data => ({ ok: Boolean(data?.ok), taskId: data?.taskId || taskId, updated: data?.updated || false, localOnly: data?.localOnly !== false, localOnlyReason: data?.localOnlyReason || '服务器任务资料已保存；WMS 上游未写回', task: data?.task || null })),
    previewPriceCandidates: async (taskId) => {
      const data = await workbench(`/tasks?page=1&pageSize=2000&q=`)
      const task = (data.items || []).find(item => String(item.id || item.taskId) === String(taskId))
      if (!task) return { ok: false, reason: '找不到对应任务' }
      const market = task.lastPrice == null ? null : Number(task.lastPrice)
      const cost = task.referencePrice == null ? null : Number(task.referencePrice)
      const candidates = [{ key: 'market', label: '行情观察价', price: market, enabled: market != null, reason: market == null ? '尚未取得行情价' : '' }, { key: 'reference', label: '采购价', price: cost, enabled: cost != null, reason: cost == null ? '未提供采购价' : '' }]
      const preview = { previewId: `${task.id}-${task.updatedAt || ''}`, policyVersion: 'server-workbench-v1', status: candidates.some(item => item.enabled) ? 'ready' : 'blocked', facts: { costPrice: cost, apiCurrentSalePrice: null, apiSuggestPrice: null }, market: { median: market }, candidates }
      return { ok: true, preview }
    },
    confirmPriceSelection: (payload = {}) => {
      const taskId = payload.taskId || payload.id
      return workbench(`/tasks/${encodeURIComponent(taskId || '')}/price-intent`, { method: 'POST', body: JSON.stringify(payload) })
    },
    applyPriceSelection: (payload = {}) => {
      const taskId = payload.taskId || payload.id
      return workbench(`/tasks/${encodeURIComponent(taskId || '')}/price-intent`, { method: 'POST', body: JSON.stringify(payload) })
    },
    queryMarketHistory: (params) => workbench(`/history?${new URLSearchParams(params || {})}`),

    importSellerFile: async () => { const file = await pickFile('.xlsx,.xls,.xlsm'); if (!file) return { canceled: true }; const form = new FormData(); form.append('file', file); return request('/seller-workbench/import', { method: 'POST', body: form }) },
    getLegacySellerQueueSummary: () => Promise.resolve({ total: 0 }),
    importLegacySellerQueue: () => unsupported('旧卖家队列'),
    getSellerSettings: () => request('/seller-workbench/settings'),
    setSellerSettings: (patch) => request('/seller-workbench/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
    querySellerSources: (params) => request(`/seller-workbench/sources?${new URLSearchParams(params || {})}`),
    querySellerItems: (params) => request(`/seller-workbench/items?${new URLSearchParams(params || {})}`),
    querySellerSnapshots: () => Promise.resolve({ items: [], total: 0 }),
    getSellerQueueDetail: (params = {}) => request(`/seller-workbench/queues/${encodeURIComponent(params.sourceId || params.sellerId || params.id || '')}${params.runId ? `?runId=${encodeURIComponent(params.runId)}` : ''}`),
    getSellerDetail: (params) => webErp.getSellerQueueDetail(params),
    getSellerSnapshot: previewArtifact,
    sellerStatus: () => request('/jobs?status=running').then(data => ({ running: (data.jobs || []).some(job => job.type === 'seller_snapshot') })),
    sellerEvents: () => request('/events?limit=100'),
    getSellerSummary: () => request('/seller-workbench/summary'),
    querySellerQueues: (params = {}) => request(`/seller-workbench/queues?${new URLSearchParams({ ...params, group: params.group || (params.dimension === 'status' ? '' : params.group) })}`),
    sellerQueuesExport: (params = {}) => download(`/seller-workbench/export?${new URLSearchParams(params)}`, '卖家队列.xlsx'),
    sellerQueuesDetailExport: (params = {}) => download(`/seller-workbench/export-detail?${new URLSearchParams(params)}`, '卖家商品明细.xlsx'),
    querySellerRuns: (params) => request(`/seller-workbench/runs?${new URLSearchParams(params || {})}`),
    getSellerRun: (runId) => request(`/seller-workbench/runs/${encodeURIComponent(typeof runId === 'string' ? runId : runId?.runId || '')}`),
    getSellerSchedule: () => request('/seller-workbench/schedule'),
    setSellerSchedule: (patch) => request('/seller-workbench/schedule', { method: 'PATCH', body: JSON.stringify(patch) }),
    getSellerAccountsStatus: listAccounts,
    startSellerCrawl: (options = {}) => request('/seller-workbench/start', { method: 'POST', body: JSON.stringify(options) }),
    pauseSellerCrawl: () => request('/seller-workbench/pause', { method: 'POST', body: '{}' }),
    resumeSellerCrawl: () => request('/seller-workbench/resume', { method: 'POST', body: '{}' }),
    stopSellerCrawl: () => request('/seller-workbench/stop', { method: 'POST', body: '{}' }),

    queryResults: (params) => workbench(`/results?${new URLSearchParams(params || {})}`),
    clearResults: () => unsupported('清理结果'),
    minimizeWindow: () => Promise.resolve({ ok: true }),
    hideWindow: () => Promise.resolve({ ok: true }),
    onCrawlEvent: (callback) => subscribe('/events', callback, { crawl: true }),
    onSellerEvent: (callback) => subscribe('/events', callback, { seller: true }),
    onWmsSyncState: (callback) => {
      if (typeof callback !== 'function') return () => {}
      let last = ''
      let stopped = false
      const poll = async () => {
        try {
          const state = await request('/wms/state')
          if (stopped) return
          const signature = JSON.stringify(state || {})
          if (signature === last) return
          last = signature
          callback(state || {})
        } catch {
          // The page's normal load path reports an error. A background poll
          // must stay quiet during a transient network flap and retry later.
        }
      }
      const timer = setInterval(poll, 15_000)
      return () => { stopped = true; clearInterval(timer) }
    }
  }

  function subscribe(url, callback, options = {}) {
    const source = new EventSource(url)
    const activeCounts = { market_snapshot: 0, seller_snapshot: 0 }
    const terminalStatuses = new Map()
    const seenCreates = new Set()
    const seenTerminals = new Set()
    const bufferedEvents = []
    let baselineCursor = 0
    let ready = false
    let runActive = false
    let stopped = false

    const isIncludedJob = (jobType) => options.seller
      ? jobType === 'seller_snapshot'
      : options.crawl
        ? jobType === 'market_snapshot'
        : Boolean(jobType)
    const activeTotal = () => options.seller ? activeCounts.seller_snapshot : options.crawl ? activeCounts.market_snapshot : Object.values(activeCounts).reduce((total, value) => total + value, 0)
    const decrementTerminal = (jobId, jobType, status) => {
      const key = `${jobId}:${status}`
      if (seenTerminals.has(key)) return
      seenTerminals.add(key)
      if (Object.hasOwn(activeCounts, jobType)) activeCounts[jobType] = Math.max(0, activeCounts[jobType] - 1)
      terminalStatuses.set(jobId, status)
    }
    const lifecyclePayload = (envelope, payload, jobType) => ({
      ...payload,
      jobId: envelope.jobId || payload.jobId || null,
      jobType: jobType || null,
      status: envelope.status || payload.status || null
    })
    const prefix = () => options.seller ? 'seller-' : ''
    const notifyStart = (payload) => {
      if (runActive) return
      runActive = true
      callback({ type: `${prefix()}start`, payload })
    }
    const notifyProgress = (type, payload) => {
      if (!activeTotal()) return
      if (!payload.current) {
        payload.accountName = payload.accountName || '服务器 Worker'
        payload.current = type === 'job.retry_scheduled' ? '等待重试' : type === 'task.pause' ? '正在暂停' : type === 'task.resume' ? '正在恢复' : type === 'task.paused' ? '已暂停' : type === 'task.stop' ? '正在停止' : '执行中'
      }
      callback({ type: `${prefix()}progress`, payload })
    }
    const notifyTerminal = (payload) => {
      if (!runActive || activeTotal()) return
      const failed = [...terminalStatuses.values()].some(status => status !== 'succeeded')
      runActive = false
      callback({ type: `${prefix()}${failed ? 'error' : 'done'}`, payload })
      terminalStatuses.clear()
    }

    const processEvent = (event) => {
      let envelope = {}
      try { envelope = JSON.parse(event.data || '{}') } catch {}
      const type = envelope.eventType || event.type
      const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : envelope
      const jobType = String(envelope.jobType || payload.jobType || '').trim()
      if (!isIncludedJob(jobType)) return
      const jobId = String(envelope.jobId || payload.jobId || '').trim()
      if (!jobId) return
      const cursor = Number(envelope.cursor)
      // The active summary establishes the exact event boundary. Events at or
      // before it are historical/replayed state already reflected in counts.
      if (ready && Number.isFinite(cursor) && cursor <= baselineCursor) return
      const nextPayload = lifecyclePayload(envelope, payload, jobType)
      if (type === 'job.created') {
        if (seenCreates.has(jobId)) return
        seenCreates.add(jobId)
        if (Object.hasOwn(activeCounts, jobType)) activeCounts[jobType] += 1
        if (activeTotal() === 1) notifyStart(nextPayload)
        return
      }
      if (type === 'job.claimed') {
        notifyProgress(type, nextPayload)
      } else if (type === 'job.retry_scheduled') {
        notifyProgress(type, nextPayload)
      } else if (['task.pause', 'task.resume', 'task.paused', 'task.stop'].includes(type)) {
        notifyProgress(type, nextPayload)
      } else if (['job.succeeded', 'job.failed', 'job.cancelled'].includes(type)) {
        decrementTerminal(jobId, jobType, type === 'job.succeeded' ? 'succeeded' : type === 'job.cancelled' ? 'cancelled' : 'failed')
        notifyTerminal(nextPayload)
      }
    }

    // If an employee opens a page after a run has already started, seed the
    // aggregate from the server's authoritative counts and event cursor.
    request('/jobs/active-summary').catch(() => ({ counts: {}, eventCursor: 0 })).then((summary) => {
      if (stopped) return
      for (const jobType of Object.keys(activeCounts)) {
        const counts = summary?.counts?.[jobType] || {}
        activeCounts[jobType] = (Number(counts.pending) || 0) + (Number(counts.running) || 0)
      }
      baselineCursor = Number(summary?.eventCursor) || 0
      ready = true
      if (activeTotal()) notifyStart({ jobType: options.seller ? 'seller_snapshot' : 'market_snapshot', status: 'running', current: '服务器 Worker 执行中' })
      while (bufferedEvents.length) processEvent(bufferedEvents.shift())
    }).catch(() => { ready = true; while (bufferedEvents.length) processEvent(bufferedEvents.shift()) })

    const handler = (event) => { if (ready) processEvent(event); else bufferedEvents.push(event) }
    for (const type of ['job.created', 'job.claimed', 'job.succeeded', 'job.failed', 'job.cancelled', 'job.retry_scheduled', 'task.pause', 'task.resume', 'task.paused', 'task.stop']) source.addEventListener(type, handler)
    // EventSource reconnects automatically after a finite SSE response or a
    // transient network failure. Keep the instance open so the browser sends
    // its Last-Event-ID header on the next request and the server can replay
    // events that arrived while the employee's connection was down. Cleanup
    // remains explicit through the unsubscribe function below.
    source.onerror = () => {}
    return () => { stopped = true; bufferedEvents.length = 0; source.close() }
  }

  window.erp = webErp
})()

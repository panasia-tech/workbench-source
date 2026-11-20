"use strict"

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const Database = require('better-sqlite3')
const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')

const MAX_PAYLOAD_BYTES = 256 * 1024
const JOB_STATUSES = new Set(['pending', 'running', 'succeeded', 'failed', 'cancelled'])
const DEFAULT_WORKBENCH_SETTINGS = Object.freeze({
  dailyEnabled: false,
  dailyTime: '02:00',
  launchAtLogin: false,
  throttleMinMs: 12000,
  throttleMaxMs: 20000,
  queryDelayMinMs: 8000,
  queryDelayMaxMs: 14000,
  maxTasks: 0,
  recycleEvery: 50,
  blacklistKeywords: [],
  categorySearchModes: {}
})
const DEFAULT_SELLER_SETTINGS = Object.freeze({
  throttleMinMs: 15000,
  throttleMaxMs: 30000,
  weeklyEnabled: false,
  weeklyDay: 1,
  weeklyTime: '09:00',
  timezone: 'Asia/Shanghai'
})

function json(value, fallback = {}) {
  try { return JSON.stringify(value == null ? fallback : value) } catch { throw new Error('json_serialization_failed') }
}

function parse(value, fallback = {}) {
  try { return value == null ? fallback : JSON.parse(value) } catch { return fallback }
}

function safeJob(row) {
  if (!row) return null
  const {
    payload_json: _payloadJson,
    result_json: _resultJson,
    lease_token: _leaseToken,
    worker_id: _workerId,
    lease_expires_at: _leaseExpiresAt,
    retry_at: _retryAt,
    ...safe
  } = row
  return {
    ...safe,
    payload: parse(_payloadJson),
    result: parse(_resultJson, null)
  }
}

function safeCollection(row) {
  if (!row) return null
  return { ...row }
}

function safeWorkbenchTask(row, latest = null, override = null) {
  if (!row) return null
  const storedOverride = override && typeof override === 'object'
    ? override
    : parse(row.override_json, {})
  const identity = {
    brand: storedOverride.brand == null ? row.brand : storedOverride.brand,
    name: storedOverride.name == null ? row.name : storedOverride.name,
    model: storedOverride.model == null ? row.model : storedOverride.model,
    alias: storedOverride.alias == null ? row.alias : storedOverride.alias,
    searchKeywords: Array.isArray(storedOverride.searchKeywords)
      ? storedOverride.searchKeywords
      : parse(row.search_keywords_json, [])
  }
  const aliases = Array.isArray(storedOverride.aliases)
    ? storedOverride.aliases.map(value => String(value || '').trim()).filter(Boolean).slice(0, 12)
    : (identity.alias ? [identity.alias] : [])
  const metadata = {}
  for (const key of [
    'aiReviewStatus', 'aiReviewReason', 'aiReviewUpdatedAt', 'aiCorrectionStatus', 'aiCorrectionReason',
    'aiCorrectionSource', 'aiCorrectionCandidate', 'aiCorrectionUpdatedAt', 'aiWebSearchStatus', 'aiWebSearchQuery', 'aiWebSearchSource', 'aiWebSearchResults', 'aiEvents',
    'aliasSource', 'aliasUpdatedAt',
    'correctionWorkflowStatus', 'correctionWorkflowReason', 'correctionWorkflowUpdatedAt', 'correctionVersion',
    'correctionOperator', 'correctionReviewStatus', 'correctionAudit', 'writebackAudit', 'correctionRecollectKey',
    'correctionRecollectRequestedAt', 'localizedDisplayName', 'effectiveAlias', 'spuSearchPolicy',
    'effectiveSearchPolicy', 'effectiveBlacklist', 'effectivePriceFence', 'effectivePageFilter', 'priceIntent'
  ]) if (Object.hasOwn(storedOverride, key)) metadata[key] = storedOverride[key]
  return {
    id: row.id,
    taskId: row.id,
    collectionId: row.collection_id,
    category: row.category || '',
    brand: identity.brand || '',
    name: identity.name || '',
    model: identity.model || '',
    alias: identity.alias || '',
    aliases,
    spuCode: row.spu_code || '',
    referencePrice: row.reference_price == null ? null : Number(row.reference_price),
    enabled: Boolean(row.enabled),
    searchKeywords: identity.searchKeywords,
    ...metadata,
    lastStatus: latest?.status || 'pending',
    status: latest?.status || 'pending',
    lastPrice: latest?.price == null ? null : Number(latest.price),
    lastReason: latest?.reason || '',
    lastRunAt: latest?.created_at || null,
    result: latest ? parse(latest.result_json, null) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function safeWorkbenchRun(row) {
  if (!row) return null
  return {
    ...row,
    invalidPrice: Number(row.invalid_price || 0),
    riskControl: Number(row.risk_control || 0),
    total: Number(row.total || 0),
    success: Number(row.success || 0),
    empty: Number(row.empty || 0),
    fail: Number(row.fail || 0)
  }
}

function safeWorkbenchResult(row) {
  if (!row) return null
  return { ...row, price: row.price == null ? null : Number(row.price), result: parse(row.result_json, null) }
}

function safeSellerSource(row) {
  if (!row) return null
  return {
    id: row.id,
    sourceId: row.id,
    sellerId: row.seller_id || '',
    url: row.seller_url,
    sellerUrl: row.seller_url,
    sellerName: row.seller_name || '',
    name: row.seller_name || '',
    mainContent: row.main_content || '',
    mainType: row.main_type || '',
    category: row.category || '',
    board: row.board || '',
    boardName: row.board_name || '',
    sourceBoardRanks: row.source_board_ranks || '',
    sourceRank: row.source_rank == null ? null : Number(row.source_rank),
    sourceOrdinal: row.source_ordinal == null ? null : Number(row.source_ordinal),
    sourceSlotCount: row.source_slot_count == null ? null : Number(row.source_slot_count),
    cities: row.cities || '',
    excelRow: row.excel_row == null ? null : Number(row.excel_row),
    status: row.status,
    reasonCode: row.reason_code || '',
    reason: row.reason || '',
    activeCount: row.active_count == null ? null : Number(row.active_count),
    expectedActive: row.expected_active == null ? null : Number(row.expected_active),
    soldCount: row.sold_count == null ? null : Number(row.sold_count),
    expectedSold: row.expected_sold == null ? null : Number(row.expected_sold),
    attemptCount: Number(row.attempt_count || 0),
    snapshotPath: row.snapshot_artifact_id || '',
    latestSnapshotPath: row.snapshot_artifact_id || '',
    snapshotAt: row.snapshot_at || null,
    lastRunId: row.last_run_id || null,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function safeSellerRun(row) {
  if (!row) return null
  return { ...row, runId: row.id, total: Number(row.total || 0), success: Number(row.success || 0), incomplete: Number(row.incomplete || 0), failed: Number(row.failed || 0) }
}

function safeSellerItem(row) {
  if (!row) return null
  return { id: row.id, sourceId: row.source_id, runId: row.run_id, itemId: row.item_id || '', title: row.title || '', name: row.title || '', category: row.category || '', branch: row.branch || '', status: row.item_status || '', itemStatus: row.item_status || '', price: row.price == null ? null : Number(row.price), url: row.item_url || '', itemUrl: row.item_url || '', capturedAt: row.captured_at, result: parse(row.result_json, {}) }
}

function safeWmsInventory(row) {
  if (!row) return null
  const payload = parse(row.payload_json, {})
  return {
    ...payload,
    sku_code: row.sku_code,
    skuCode: row.sku_code,
    spu_code: row.spu_code || payload.spu_code || payload.spuCode || '',
    status: row.status,
    syncedAt: row.synced_at
  }
}

function createDatabase({ filename = ':memory:', now = () => new Date().toISOString() } = {}) {
  const dbPath = String(filename)
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true })
  const database = new Database(dbPath)
  database.pragma('foreign_keys = ON')
  database.pragma('busy_timeout = 5000')
  if (dbPath !== ':memory:') database.pragma('journal_mode = WAL')
  database.exec(schema)
  const jobColumns = database.prepare('PRAGMA table_info(jobs)').all().map(column => column.name)
  if (!jobColumns.includes('retry_at')) database.exec('ALTER TABLE jobs ADD COLUMN retry_at TEXT')
  if (!jobColumns.includes('control_requested')) database.exec("ALTER TABLE jobs ADD COLUMN control_requested TEXT CHECK (control_requested IN ('pause') OR control_requested IS NULL)")
  database.prepare("INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (3, 'job retry_at')").run()
  database.prepare("INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (5, 'durable job pause intent')").run()
  database.prepare("INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (6, 'server seller workbench authority')").run()
  database.prepare("INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (7, 'server WMS inventory snapshot')").run()
  database.prepare("INSERT OR IGNORE INTO schema_version(version, applied_at) VALUES (9, 'durable browser profile locks')").run()

  const insertEvent = database.prepare('INSERT INTO job_events(job_id, event_type, status, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
  const insertAudit = database.prepare('INSERT INTO audit_log(id, actor_id, action, entity_type, entity_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')

  function appendEvent({ jobId, eventType, status, payload = {} }) {
    const result = insertEvent.run(String(jobId), String(eventType), String(status), json(payload), now())
    return { cursor: Number(result.lastInsertRowid), jobId: String(jobId), eventType: String(eventType), status: String(status), payload, createdAt: now() }
  }

  function audit({ actorId = null, action, entityType, entityId = null, metadata = {} }) {
    const id = crypto.randomUUID()
    insertAudit.run(id, actorId ? String(actorId) : null, String(action), String(entityType), entityId == null ? null : String(entityId), json(metadata), now())
    return { id, actorId, action, entityType, entityId, metadata }
  }

  const api = {
    raw: database,
    close: () => database.close(),
    schemaVersion: () => Number(database.prepare('SELECT MAX(version) AS version FROM schema_version').get()?.version || 0),
    upsertUser(user = {}) {
      const id = String(user.id || crypto.randomUUID())
      const timestamp = now()
      database.prepare(`INSERT INTO users(id, username, display_name, role, password_hash, active, created_at, updated_at)
        VALUES (@id, @username, @display_name, @role, @password_hash, @active, @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET username=@username, display_name=@display_name, role=@role, password_hash=@password_hash, active=@active, updated_at=@updated_at`).run({
        id,
        username: String(user.username || '').trim(),
        display_name: String(user.displayName || user.username || '').trim(),
        role: String(user.role || 'read_only'),
        password_hash: String(user.passwordHash || ''),
        active: user.active === false ? 0 : 1,
        created_at: timestamp,
        updated_at: timestamp
      })
      return api.getUserById(id)
    },
    getUserByUsername(username) { return database.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim()) || null },
    getUserById(id) { return database.prepare('SELECT * FROM users WHERE id = ?').get(String(id || '')) || null },
    countUsers() { return Number(database.prepare('SELECT COUNT(*) AS count FROM users').get().count) },
    upsertBrowserProfile(profile = {}) {
      const id = String(profile.id || crypto.randomUUID())
      const timestamp = now()
      database.prepare(`INSERT INTO browser_profiles(id, provider, vendor_profile_id, label, user_data_dir, proxy_label, capabilities_json, status, created_by, created_at, updated_at)
        VALUES (@id, @provider, @vendor_profile_id, @label, @user_data_dir, @proxy_label, @capabilities_json, @status, @created_by, @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET provider=@provider, vendor_profile_id=@vendor_profile_id, label=@label, user_data_dir=@user_data_dir, proxy_label=@proxy_label, capabilities_json=@capabilities_json, status=@status, updated_at=@updated_at`).run({
        id,
        provider: String(profile.provider || 'fake'),
        vendor_profile_id: String(profile.vendorProfileId || profile.vendor_profile_id || ''),
        label: String(profile.label || id),
        user_data_dir: profile.userDataDir ? String(profile.userDataDir) : null,
        proxy_label: profile.proxyLabel ? String(profile.proxyLabel) : null,
        capabilities_json: json(profile.capabilities || {}),
        status: String(profile.status || 'ready'),
        created_by: profile.createdBy ? String(profile.createdBy) : null,
        created_at: timestamp,
        updated_at: timestamp
      })
      return api.getBrowserProfile(id)
    },
    getBrowserProfile(id) {
      const row = database.prepare('SELECT * FROM browser_profiles WHERE id = ?').get(String(id || ''))
      return row ? { ...row, capabilities: parse(row.capabilities_json), capabilities_json: undefined } : null
    },
    deleteBrowserProfile(id, actorId = null) {
      const profile = api.getBrowserProfile(id)
      if (!profile) return null
      database.prepare('DELETE FROM browser_profiles WHERE id = ?').run(String(id))
      audit({ actorId, action: 'profile.delete', entityType: 'browser_profile', entityId: id, metadata: { provider: profile.provider } })
      return profile
    },
    listBrowserProfiles(input = 100) {
      const limit = typeof input === 'object' ? input.limit : input
      return database.prepare('SELECT * FROM browser_profiles ORDER BY created_at DESC LIMIT ?').all(Math.min(100, Math.max(1, Number(limit) || 100)).toString()).map(row => ({ ...row, capabilities: parse(row.capabilities_json), capabilities_json: undefined }))
    },
    acquireBrowserProfileLock({ profileId, ownerId, leaseMs = 60_000 } = {}) {
      const profile = String(profileId || '').trim()
      const owner = String(ownerId || '').trim()
      if (!profile || !owner) return false
      const timestamp = now()
      const expiry = new Date(Date.now() + Math.max(1_000, Number(leaseMs) || 60_000)).toISOString()
      const transaction = database.transaction(() => {
        const current = database.prepare('SELECT owner_id, lease_expires_at FROM browser_profile_locks WHERE profile_id = ?').get(profile)
        if (current && current.owner_id !== owner && String(current.lease_expires_at || '') > timestamp) return false
        database.prepare(`INSERT INTO browser_profile_locks(profile_id, owner_id, lease_expires_at, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(profile_id) DO UPDATE SET owner_id=excluded.owner_id, lease_expires_at=excluded.lease_expires_at, updated_at=excluded.updated_at`).run(profile, owner, expiry, timestamp)
        return true
      })
      try { return transaction.immediate() } catch (error) {
        if (/database is locked|database table is locked/i.test(String(error?.message || error))) return false
        throw error
      }
    },
    releaseBrowserProfileLock({ profileId, ownerId } = {}) {
      const profile = String(profileId || '').trim()
      const owner = String(ownerId || '').trim()
      if (!profile || !owner) return false
      return Boolean(database.prepare('DELETE FROM browser_profile_locks WHERE profile_id = ? AND owner_id = ?').run(profile, owner).changes)
    },
    listBrowserProfileLocks() {
      return database.prepare('SELECT profile_id, owner_id, lease_expires_at, updated_at FROM browser_profile_locks ORDER BY profile_id').all()
    },
    createWorkbenchCollection({ id = crypto.randomUUID(), sourceFile = '任务清单.xlsx', sheetName = '行情任务', tasks = [], createdBy = null } = {}) {
      const collectionId = String(id)
      const timestamp = now()
      const insertCollection = database.prepare(`INSERT INTO task_collections(id, source_file, sheet_name, row_count, status, imported_at, created_by)
        VALUES (?, ?, ?, ?, 'active', ?, ?)`)
      const insertTask = database.prepare(`INSERT INTO workbench_tasks(id, collection_id, category, brand, name, model, alias, spu_code, reference_price, enabled, search_keywords_json, created_at, updated_at)
        VALUES (@id, @collection_id, @category, @brand, @name, @model, @alias, @spu_code, @reference_price, @enabled, @search_keywords_json, @created_at, @updated_at)`)
      const transaction = database.transaction(() => {
        database.prepare("UPDATE task_collections SET status='archived', archived_at=? WHERE status='active'").run(timestamp)
        insertCollection.run(collectionId, String(sourceFile).slice(0, 240), String(sheetName).slice(0, 120), tasks.length, timestamp, createdBy ? String(createdBy) : null)
        for (const task of tasks) {
          const brand = String(task.brand || '').trim().slice(0, 160)
          const model = String(task.model || task.name || '').trim().slice(0, 240)
          const name = String(task.name || model).trim().slice(0, 240)
          const keywords = Array.isArray(task.searchKeywords) && task.searchKeywords.length ? task.searchKeywords : [model, [brand, model].filter(Boolean).join(' ')].filter(Boolean)
          insertTask.run({
            id: String(task.id || crypto.randomUUID()),
            collection_id: collectionId,
            category: String(task.category || '').trim().slice(0, 120) || null,
            brand,
            name,
            model,
            alias: task.alias ? String(task.alias).trim().slice(0, 240) : null,
            spu_code: task.spuCode ? String(task.spuCode).trim().slice(0, 120) : null,
            reference_price: task.referencePrice == null || task.referencePrice === '' ? null : Number(task.referencePrice),
            enabled: task.enabled === false ? 0 : 1,
            search_keywords_json: json([...new Set(keywords.map(value => String(value || '').trim()).filter(Boolean))].slice(0, 12)),
            created_at: timestamp,
            updated_at: timestamp
          })
        }
      })
      transaction()
      return api.getWorkbenchCollection(collectionId)
    },
    getActiveWorkbenchCollection() {
      const row = database.prepare("SELECT * FROM task_collections WHERE status='active' ORDER BY imported_at DESC LIMIT 1").get()
      return safeCollection(row)
    },
    getWorkbenchCollection(id) {
      return safeCollection(database.prepare('SELECT * FROM task_collections WHERE id = ?').get(String(id || '')))
    },
    listWorkbenchCollections({ limit = 100 } = {}) {
      const bounded = Math.min(100, Math.max(1, Number(limit) || 100))
      return database.prepare('SELECT * FROM task_collections ORDER BY imported_at DESC LIMIT ?').all(bounded).map(safeCollection)
    },
    listWorkbenchTasks({ page = 1, pageSize = 1000, q = '', category = '', includeDisabled = true, collectionId = null } = {}) {
      const active = collectionId ? api.getWorkbenchCollection(collectionId) : api.getActiveWorkbenchCollection()
      if (!active) return { items: [], total: 0, page: Number(page) || 1, pageSize: Number(pageSize) || 1000 }
      const values = []
      const clauses = ['t.collection_id = ?']
      values.push(active.id)
      if (!includeDisabled) clauses.push('t.enabled = 1')
      if (category) { clauses.push('t.category = ?'); values.push(String(category)) }
      if (q) {
        clauses.push('(LOWER(t.brand) LIKE ? OR LOWER(t.name) LIKE ? OR LOWER(t.model) LIKE ? OR LOWER(COALESCE(t.alias, \'\')) LIKE ? OR LOWER(COALESCE(t.spu_code, \'\')) LIKE ? OR LOWER(COALESCE(o.override_json, \'\')) LIKE ?)')
        const term = `%${String(q).trim().toLowerCase()}%`
        values.push(term, term, term, term, term, term)
      }
      const where = clauses.join(' AND ')
      const total = Number(database.prepare(`SELECT COUNT(*) AS count FROM workbench_tasks t LEFT JOIN workbench_task_overrides o ON o.task_id = t.id WHERE ${where}`).get(...values).count)
      const safePageSize = Math.min(2000, Math.max(1, Number(pageSize) || 1000))
      const safePage = Math.max(1, Number(page) || 1)
      const rows = database.prepare(`SELECT t.*, o.override_json FROM workbench_tasks t LEFT JOIN workbench_task_overrides o ON o.task_id = t.id WHERE ${where} ORDER BY t.created_at, t.id LIMIT ? OFFSET ?`).all(...values, safePageSize, (safePage - 1) * safePageSize)
      const latest = database.prepare('SELECT * FROM workbench_results WHERE task_id = ? ORDER BY created_at DESC LIMIT 1')
      return { items: rows.map(row => safeWorkbenchTask(row, latest.get(row.id))), total, page: safePage, pageSize: safePageSize }
    },
    getWorkbenchTask(id) {
      const row = database.prepare('SELECT t.*, o.override_json FROM workbench_tasks t LEFT JOIN workbench_task_overrides o ON o.task_id = t.id WHERE t.id = ?').get(String(id || ''))
      if (!row) return null
      const latest = database.prepare('SELECT * FROM workbench_results WHERE task_id = ? ORDER BY created_at DESC LIMIT 1').get(row.id)
      return safeWorkbenchTask(row, latest)
    },
    setWorkbenchTaskEnabled(id, enabled, actorId = null) {
      const timestamp = now()
      const result = database.prepare('UPDATE workbench_tasks SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, timestamp, String(id))
      if (!result.changes) return null
      audit({ actorId, action: enabled ? 'workbench.task.enable' : 'workbench.task.disable', entityType: 'workbench_task', entityId: id, metadata: {} })
      return api.getWorkbenchTask(id)
    },
    getWorkbenchTaskOverride(id) {
      const row = database.prepare('SELECT override_json FROM workbench_task_overrides WHERE task_id = ?').get(String(id || ''))
      return row ? parse(row.override_json, {}) : {}
    },
    setWorkbenchTaskOverride(id, override = {}, actorId = null) {
      const taskId = String(id || '').trim()
      if (!taskId || !database.prepare('SELECT 1 FROM workbench_tasks WHERE id = ?').get(taskId)) return null
      const timestamp = now()
      database.prepare(`INSERT INTO workbench_task_overrides(task_id, override_json, updated_at, updated_by)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET override_json=excluded.override_json, updated_at=excluded.updated_at, updated_by=excluded.updated_by`).run(taskId, json(override), timestamp, actorId ? String(actorId) : null)
      database.prepare('UPDATE workbench_tasks SET updated_at = ? WHERE id = ?').run(timestamp, taskId)
      return api.getWorkbenchTask(taskId)
    },
    updateWorkbenchTaskIdentity(id, patch = {}, actorId = null) {
      const taskId = String(id || '').trim()
      const current = api.getWorkbenchTask(taskId)
      if (!current) throw Object.assign(new Error('当前行情任务不存在，不能编辑商品资料'), { code: 'task_not_found' })
      const productName = String(patch.product_name ?? patch.name ?? '').trim().slice(0, 240)
      const brand = String(patch.brand || '').trim().slice(0, 160)
      const model = String(patch.model || '').trim().slice(0, 240)
      if (!productName || !brand || !model) throw Object.assign(new Error('商品名称、品牌和型号都不能为空'), { code: 'identity_required' })
      const previous = api.getWorkbenchTaskOverride(taskId)
      const aliases = [...new Set([
        ...(Array.isArray(previous.aliases) ? previous.aliases : []),
        ...(Array.isArray(current.aliases) ? current.aliases : []),
        current.alias
      ].map(value => String(value || '').trim()).filter(Boolean))].slice(0, 12)
      const searchKeywords = [...new Set([model, `${brand} ${model}`.trim(), ...aliases].map(value => String(value || '').trim()).filter(Boolean))].slice(0, 12)
      const timestamp = now()
      const auditRow = {
        at: timestamp,
        action: 'identity_edit',
        taskId,
        operator: actorId ? String(actorId) : 'server',
        requested: { product_name: productName, brand, model },
        previous: { product_name: current.name, brand: current.brand, model: current.model },
        result: 'saved_server_override'
      }
      const next = {
        ...previous,
        brand,
        model,
        name: productName,
        searchKeywords,
        aliases,
        aiCorrectionStatus: 'done',
        aiCorrectionReason: '服务器人工编辑商品资料',
        aiReviewStatus: 'approved',
        aiReviewReason: '服务器人工编辑商品资料，直接采用',
        correctionReviewStatus: 'approved',
        correctionWorkflowStatus: 'completed',
        correctionWorkflowReason: '服务器任务资料已保存，后续复采使用新资料',
        correctionWorkflowUpdatedAt: timestamp,
        correctionOperator: actorId ? String(actorId) : 'server',
        correctionAudit: [...(Array.isArray(previous.correctionAudit) ? previous.correctionAudit.slice(-19) : []), auditRow].slice(-20),
        writebackAudit: [...(Array.isArray(previous.writebackAudit) ? previous.writebackAudit.slice(-19) : []), { ...auditRow, result: 'blocked_local_only', reason: 'H5 服务器只保存任务覆盖；WMS 上游写回需单独配置凭据与版本门禁' }].slice(-20)
      }
      api.setWorkbenchTaskOverride(taskId, next, actorId)
      audit({ actorId, action: 'workbench.task.identity_edit', entityType: 'workbench_task', entityId: taskId, metadata: { result: 'saved_server_override', searchKeywords } })
      return { task: api.getWorkbenchTask(taskId), updated: true, localOnly: true, localOnlyReason: '服务器任务资料已保存；WMS 上游未写回' }
    },
    createWorkbenchRun({ id = crypto.randomUUID(), collectionId = null, trigger = 'manual', total = 0, createdBy = null } = {}) {
      const timestamp = now()
      database.prepare(`INSERT INTO workbench_runs(id, collection_id, trigger, status, total, started_at, created_by) VALUES (?, ?, ?, 'running', ?, ?, ?)`).run(String(id), collectionId ? String(collectionId) : null, String(trigger || 'manual').slice(0, 40), Math.max(0, Number(total) || 0), timestamp, createdBy ? String(createdBy) : null)
      return api.getWorkbenchRun(id)
    },
    getWorkbenchRun(id) {
      return safeWorkbenchRun(database.prepare('SELECT * FROM workbench_runs WHERE id = ?').get(String(id || '')))
    },
    listWorkbenchRuns({ page = 1, pageSize = 20 } = {}) {
      const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20))
      const safePage = Math.max(1, Number(page) || 1)
      const total = Number(database.prepare('SELECT COUNT(*) AS count FROM workbench_runs').get().count)
      const rows = database.prepare('SELECT * FROM workbench_runs ORDER BY started_at DESC LIMIT ? OFFSET ?').all(safePageSize, (safePage - 1) * safePageSize)
      return { items: rows.map(safeWorkbenchRun), total, page: safePage, pageSize: safePageSize }
    },
    finishWorkbenchRun(id, { status = 'completed', finishedAt = null } = {}) {
      const timestamp = finishedAt || now()
      database.prepare('UPDATE workbench_runs SET status = ?, finished_at = ? WHERE id = ?').run(String(status), timestamp, String(id))
      return api.getWorkbenchRun(id)
    },
    recordWorkbenchResult({ taskId, runId, status = 'fail', price = null, reason = '', result = null } = {}) {
      if (!taskId || !runId) return null
      const id = crypto.randomUUID()
      const timestamp = now()
      const normalized = String(status || 'fail')
      database.prepare('INSERT INTO workbench_results(id, task_id, run_id, status, price, reason, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, String(taskId), String(runId), normalized, price == null ? null : Number(price), String(reason || '').slice(0, 240), json(result || {}), timestamp)
      const run = api.getWorkbenchRun(runId)
      if (run) {
        const column = normalized === 'succeeded' ? 'success' : normalized === 'empty' ? 'empty' : normalized === 'invalid_price' ? 'invalid_price' : normalized === 'risk_control' ? 'risk_control' : 'fail'
        database.prepare(`UPDATE workbench_runs SET ${column} = ${column} + 1, finished_at = CASE WHEN success + empty + fail + invalid_price + risk_control + 1 >= total THEN ? ELSE finished_at END, status = CASE WHEN success + empty + fail + invalid_price + risk_control + 1 >= total THEN 'completed' ELSE status END WHERE id = ?`).run(timestamp, String(runId))
      }
      return safeWorkbenchResult(database.prepare('SELECT * FROM workbench_results WHERE id = ?').get(id))
    },
    listWorkbenchResults({ page = 1, pageSize = 100, q = '', runId = null, status = null } = {}) {
      const safePageSize = Math.min(500, Math.max(1, Number(pageSize) || 100))
      const safePage = Math.max(1, Number(page) || 1)
      const clauses = ['1=1']; const values = []
      if (runId) { clauses.push('r.run_id = ?'); values.push(String(runId)) }
      if (status) { clauses.push('r.status = ?'); values.push(String(status)) }
      if (q) { clauses.push('(LOWER(t.name) LIKE ? OR LOWER(t.brand) LIKE ? OR LOWER(t.model) LIKE ? OR LOWER(COALESCE(o.override_json, \'\')) LIKE ?)'); const term = `%${String(q).toLowerCase()}%`; values.push(term, term, term, term) }
      const where = clauses.join(' AND ')
      const total = Number(database.prepare(`SELECT COUNT(*) AS count FROM workbench_results r JOIN workbench_tasks t ON t.id = r.task_id LEFT JOIN workbench_task_overrides o ON o.task_id = t.id WHERE ${where}`).get(...values).count)
      const rows = database.prepare(`SELECT r.*, t.brand, t.name, t.model, t.category, t.alias, t.spu_code, t.reference_price, t.search_keywords_json, o.override_json FROM workbench_results r JOIN workbench_tasks t ON t.id = r.task_id LEFT JOIN workbench_task_overrides o ON o.task_id = t.id WHERE ${where} ORDER BY r.created_at DESC LIMIT ? OFFSET ?`).all(...values, safePageSize, (safePage - 1) * safePageSize)
      return {
        items: rows.map(row => {
          const task = safeWorkbenchTask(row, null)
          return {
            ...safeWorkbenchResult(row),
            brand: task?.brand || '', name: task?.name || '', model: task?.model || '', category: task?.category || '',
            spuCode: task?.spuCode || '', referencePrice: task?.referencePrice ?? null,
            searchKeywords: task?.searchKeywords || [], aliases: task?.aliases || [],
            aiReviewStatus: task?.aiReviewStatus, aiReviewReason: task?.aiReviewReason,
            correctionWorkflowStatus: task?.correctionWorkflowStatus, correctionReviewStatus: task?.correctionReviewStatus,
            correctionAudit: task?.correctionAudit || [], writebackAudit: task?.writebackAudit || []
          }
        }),
        total,
        page: safePage,
        pageSize: safePageSize
      }
    },
    getWorkbenchSummary() {
      const active = api.getActiveWorkbenchCollection()
      const page = api.listWorkbenchTasks({ page: 1, pageSize: 2000, includeDisabled: true })
      const categories = {}
      for (const item of page.items) categories[item.category || '未分类'] = (categories[item.category || '未分类'] || 0) + 1
      const latestRun = api.listWorkbenchRuns({ page: 1, pageSize: 1 }).items[0] || null
      const pendingCount = page.items.filter(item => item.enabled && ['pending', 'failed', 'empty', 'invalid_price', 'risk_control'].includes(item.lastStatus)).length
      const dailySchedule = database.prepare("SELECT enabled, next_run_at FROM schedules WHERE id='system-workbench-daily'").get()
      return {
        active: active ? { id: active.id, sourceFile: active.source_file, sheetName: active.sheet_name, rowCount: active.row_count, importedAt: active.imported_at } : null,
        activeCount: page.items.filter(item => item.enabled).length,
        totalCount: page.total,
        categoryCount: Object.keys(categories).length,
        categories,
        latestRun,
        resume: { available: pendingCount > 0, pendingCount, completedCount: page.items.length - pendingCount, nextTask: page.items.find(item => item.enabled && item.lastStatus === 'pending')?.name || '' },
        nextSchedule: dailySchedule?.enabled ? dailySchedule.next_run_at : null
      }
    },
    getWorkbenchSample() {
      const active = api.getActiveWorkbenchCollection()
      const page = api.listWorkbenchTasks({ page: 1, pageSize: 20, includeDisabled: true })
      return { sourceFile: active?.source_file || '', sheetName: active?.sheet_name || '', rowCount: active?.row_count || 0, rows: page.items }
    },
    getWorkbenchRankings({ limit = 6 } = {}) {
      const bounded = Math.min(50, Math.max(1, Number(limit) || 6))
      return api.listWorkbenchResults({ page: 1, pageSize: 500, status: 'succeeded' }).items.filter(item => item.price != null).sort((a, b) => Number(a.price) - Number(b.price)).slice(0, bounded).map((item, index) => ({ taskId: item.task_id, name: item.name, category: item.category || '', price: item.price, at: item.created_at, rank: index + 1 }))
    },
    getWorkbenchSettings() {
      const row = database.prepare('SELECT * FROM workbench_settings WHERE id = \'default\'').get()
      return { ...DEFAULT_WORKBENCH_SETTINGS, ...(row ? parse(row.settings_json, {}) : {}), blacklistKeywords: row ? parse(row.settings_json, {}).blacklistKeywords || [] : [], categorySearchModes: row ? parse(row.settings_json, {}).categorySearchModes || {} : {} }
    },
    setWorkbenchSettings(patch = {}, actorId = null) {
      const current = api.getWorkbenchSettings()
      const allowed = Object.fromEntries(Object.entries(patch).filter(([key]) => Object.hasOwn(DEFAULT_WORKBENCH_SETTINGS, key)))
      const next = { ...current, ...allowed }
      const timestamp = now()
      database.prepare(`INSERT INTO workbench_settings(id, settings_json, updated_at, updated_by) VALUES ('default', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json, updated_at=excluded.updated_at, updated_by=excluded.updated_by`).run(json(next), timestamp, actorId ? String(actorId) : null)
      return next
    },
    getWmsSyncState() {
      const row = database.prepare("SELECT * FROM wms_sync_state WHERE id='default'").get()
      if (!row) return { status: 'unconfigured', source: '', skuTotal: 0, spuTotal: 0, invalidSpuRows: 0, lastAttemptAt: null, lastSuccessAt: null, safeError: '', syncedAt: null, available: false }
      return {
        status: row.status || 'unconfigured',
        source: row.source || '',
        skuTotal: Number(row.sku_total || 0),
        spuTotal: Number(row.spu_total || 0),
        invalidSpuRows: Number(row.invalid_spu_rows || 0),
        lastAttemptAt: row.last_attempt_at || null,
        lastSuccessAt: row.last_success_at || null,
        safeError: row.safe_error || '',
        syncedAt: row.last_success_at || null,
        available: Number(row.spu_total || 0) > 0
      }
    },
    setWmsSyncState(patch = {}) {
      const current = api.getWmsSyncState()
      const next = {
        status: String(patch.status || current.status || 'unconfigured').slice(0, 40),
        source: String(patch.source ?? current.source ?? '').slice(0, 80),
        skuTotal: Math.max(0, Number(patch.skuTotal ?? current.skuTotal) || 0),
        spuTotal: Math.max(0, Number(patch.spuTotal ?? current.spuTotal) || 0),
        invalidSpuRows: Math.max(0, Number(patch.invalidSpuRows ?? current.invalidSpuRows) || 0),
        lastAttemptAt: patch.lastAttemptAt ?? current.lastAttemptAt ?? null,
        lastSuccessAt: patch.lastSuccessAt ?? current.lastSuccessAt ?? null,
        safeError: String(patch.safeError ?? current.safeError ?? '').slice(0, 240)
      }
      const timestamp = now()
      database.prepare(`INSERT INTO wms_sync_state(id,status,source,sku_total,spu_total,invalid_spu_rows,last_attempt_at,last_success_at,safe_error,updated_at)
        VALUES ('default',?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status=excluded.status,source=excluded.source,sku_total=excluded.sku_total,spu_total=excluded.spu_total,invalid_spu_rows=excluded.invalid_spu_rows,last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,safe_error=excluded.safe_error,updated_at=excluded.updated_at`).run(next.status, next.source, next.skuTotal, next.spuTotal, next.invalidSpuRows, next.lastAttemptAt, next.lastSuccessAt, next.safeError, timestamp)
      return api.getWmsSyncState()
    },
    replaceWmsInventory(rows = [], { source = '', spuTotal = 0, invalidSpuRows = 0, syncedAt = null, actorId = null } = {}) {
      const timestamp = syncedAt || now()
      const insert = database.prepare('INSERT INTO wms_inventory_items(sku_code,spu_code,status,payload_json,synced_at) VALUES (?,?,?,?,?)')
      const transaction = database.transaction(() => {
        database.prepare('DELETE FROM wms_inventory_items').run()
        let insertedCount = 0
        for (const row of Array.isArray(rows) ? rows : []) {
          const skuCode = String(row?.sku_code || row?.skuCode || '').trim()
          if (!skuCode) continue
          const status = String(row?.status || '').trim().toUpperCase()
          if (status !== 'IN_STOCK') continue
          const spuCode = String(row?.spu_code || row?.spuCode || '').trim().slice(0, 160)
          insert.run(skuCode.slice(0, 200), spuCode || null, status, json(row), timestamp)
          insertedCount += 1
        }
        api.setWmsSyncState({ status: 'synced', source, skuTotal: insertedCount, spuTotal, invalidSpuRows, lastAttemptAt: timestamp, lastSuccessAt: timestamp, safeError: '' })
        return insertedCount
      })
      const insertedCount = transaction()
      if (actorId) audit({ actorId, action: 'wms.snapshot.replace', entityType: 'wms_inventory', entityId: null, metadata: { source, skuTotal: insertedCount, spuTotal } })
      return api.getWmsSyncState()
    },
    listWmsInventory({ page = 1, pageSize = 100, q = '' } = {}) {
      const safePage = Math.max(1, Number(page) || 1)
      const safePageSize = Math.min(1000, Math.max(1, Number(pageSize) || 100))
      const term = String(q || '').trim().toLowerCase()
      const rows = term
        ? database.prepare("SELECT * FROM wms_inventory_items WHERE LOWER(sku_code) LIKE ? OR LOWER(COALESCE(spu_code,'')) LIKE ? OR LOWER(payload_json) LIKE ? ORDER BY sku_code LIMIT ? OFFSET ?").all(`%${term}%`, `%${term}%`, `%${term}%`, safePageSize, (safePage - 1) * safePageSize)
        : database.prepare('SELECT * FROM wms_inventory_items ORDER BY sku_code LIMIT ? OFFSET ?').all(safePageSize, (safePage - 1) * safePageSize)
      const total = term
        ? Number(database.prepare("SELECT COUNT(*) AS count FROM wms_inventory_items WHERE LOWER(sku_code) LIKE ? OR LOWER(COALESCE(spu_code,'')) LIKE ? OR LOWER(payload_json) LIKE ?").get(`%${term}%`, `%${term}%`, `%${term}%`).count)
        : Number(database.prepare('SELECT COUNT(*) AS count FROM wms_inventory_items').get().count)
      return { items: rows.map(safeWmsInventory), total, page: safePage, pageSize: safePageSize }
    },
    listAllWmsInventory() {
      return database.prepare('SELECT * FROM wms_inventory_items ORDER BY sku_code').all().map(safeWmsInventory)
    },
    updateWmsInventoryRow(skuCode, row = {}, actorId = null) {
      const code = String(skuCode || row?.sku_code || row?.skuCode || '').trim()
      if (!code) return null
      const existing = database.prepare('SELECT * FROM wms_inventory_items WHERE sku_code = ?').get(code)
      if (!existing) return null
      const status = String(row?.status || existing.status || '').trim().toUpperCase()
      if (status !== 'IN_STOCK') throw Object.assign(new Error('WMS 回写后的 SKU 不在 IN_STOCK，拒绝更新服务器快照'), { code: 'wms_snapshot_status_invalid' })
      const spuCode = String(row?.spu_code || row?.spuCode || existing.spu_code || '').trim().slice(0, 160)
      const syncedAt = existing.synced_at || now()
      database.prepare('UPDATE wms_inventory_items SET spu_code = ?, status = ?, payload_json = ?, synced_at = ? WHERE sku_code = ?').run(spuCode || null, status, json({ ...row, sku_code: code, spu_code: spuCode || null, status }), syncedAt, code)
      if (actorId) audit({ actorId, action: 'wms.snapshot.row_update', entityType: 'wms_inventory', entityId: code, metadata: { source: 'verified_writeback' } })
      return api.listAllWmsInventory().find(item => item.sku_code === code) || null
    },
    getSpuPolicy(spuCode) {
      const row = database.prepare('SELECT policy_json FROM spu_policies WHERE spu_code = ?').get(String(spuCode || '').trim())
      return row ? parse(row.policy_json, {}) : null
    },
    listSpuPolicies() {
      return database.prepare('SELECT spu_code, policy_json, updated_at, updated_by FROM spu_policies ORDER BY updated_at DESC LIMIT 1000').all().map(row => ({ spuCode: row.spu_code, ...parse(row.policy_json, {}), updatedAt: row.updated_at }))
    },
    setSpuPolicy(spuCode, policy = {}, actorId = null) {
      const code = String(spuCode || '').trim()
      if (!code) throw Object.assign(new Error('spu code is required'), { code: 'spu_required' })
      const timestamp = now()
      database.prepare(`INSERT INTO spu_policies(spu_code, policy_json, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(spu_code) DO UPDATE SET policy_json=excluded.policy_json, updated_at=excluded.updated_at, updated_by=excluded.updated_by`).run(code, json(policy), timestamp, actorId ? String(actorId) : null)
      return { spuCode: code, ...policy, updatedAt: timestamp }
    },
    getSellerSettings() {
      const row = database.prepare("SELECT * FROM seller_settings WHERE id='default'").get()
      return { ...DEFAULT_SELLER_SETTINGS, ...(row ? parse(row.settings_json, {}) : {}) }
    },
    setSellerSettings(patch = {}, actorId = null) {
      const current = api.getSellerSettings()
      const allowed = Object.fromEntries(Object.entries(patch).filter(([key]) => Object.hasOwn(DEFAULT_SELLER_SETTINGS, key)))
      const next = { ...current, ...allowed, throttleMinMs: Math.max(15000, Number(allowed.throttleMinMs ?? current.throttleMinMs) || 15000), throttleMaxMs: Math.max(15000, Number(allowed.throttleMaxMs ?? current.throttleMaxMs) || 15000) }
      if (next.throttleMaxMs < next.throttleMinMs) next.throttleMaxMs = next.throttleMinMs
      const timestamp = now()
      database.prepare("INSERT INTO seller_settings(id, settings_json, updated_at, updated_by) VALUES ('default', ?, ?, ?) ON CONFLICT(id) DO UPDATE SET settings_json=excluded.settings_json, updated_at=excluded.updated_at, updated_by=excluded.updated_by").run(json(next), timestamp, actorId ? String(actorId) : null)
      return next
    },
    upsertSellerSources(rows = [], actorId = null) {
      const timestamp = now()
      const insert = database.prepare(`INSERT INTO seller_sources(id, seller_id, seller_url, seller_name, main_content, main_type, category, board, board_name, source_board_ranks, source_rank, source_ordinal, source_slot_count, cities, excel_row, status, enabled, created_at, updated_at)
        VALUES (@id,@seller_id,@seller_url,@seller_name,@main_content,@main_type,@category,@board,@board_name,@source_board_ranks,@source_rank,@source_ordinal,@source_slot_count,@cities,@excel_row,'pending',1,@created_at,@updated_at)
        ON CONFLICT(id) DO UPDATE SET seller_id=excluded.seller_id,seller_url=excluded.seller_url,seller_name=excluded.seller_name,main_content=excluded.main_content,main_type=excluded.main_type,category=excluded.category,board=excluded.board,board_name=excluded.board_name,source_board_ranks=excluded.source_board_ranks,source_rank=excluded.source_rank,source_ordinal=excluded.source_ordinal,source_slot_count=excluded.source_slot_count,cities=excluded.cities,excel_row=excluded.excel_row,updated_at=excluded.updated_at`)
      const transaction = database.transaction(() => {
        for (const row of rows) insert.run({
          id: String(row.id || crypto.randomUUID()), seller_id: row.sellerId ? String(row.sellerId).slice(0, 160) : null, seller_url: String(row.url || row.sellerUrl || '').trim().slice(0, 2000), seller_name: String(row.sellerName || row.name || '').trim().slice(0, 240) || null, main_content: String(row.mainContent || '').trim().slice(0, 240) || null, main_type: String(row.mainType || '').trim().slice(0, 120) || null, category: String(row.category || '').trim().slice(0, 120) || null, board: String(row.board || '').trim().slice(0, 160) || null, board_name: String(row.boardName || '').trim().slice(0, 160) || null, source_board_ranks: String(row.sourceBoardRanks || '').trim().slice(0, 240) || null, source_rank: Number.isFinite(Number(row.sourceRank ?? row.rank)) ? Number(row.sourceRank ?? row.rank) : null, source_ordinal: Number.isFinite(Number(row.sourceOrdinal)) ? Number(row.sourceOrdinal) : null, source_slot_count: Number.isFinite(Number(row.sourceSlotCount)) ? Number(row.sourceSlotCount) : null, cities: String(row.cities || '').trim().slice(0, 240) || null, excel_row: Number.isFinite(Number(row.excelRow)) ? Number(row.excelRow) : null, created_at: timestamp, updated_at: timestamp
        })
      })
      transaction()
      if (rows.length) api.audit({ actorId, action: 'seller.sources.import', entityType: 'seller_source', entityId: null, metadata: { count: rows.length } })
      return rows.map(row => api.getSellerSource(row.id)).filter(Boolean)
    },
    getSellerSource(id) { return safeSellerSource(database.prepare('SELECT * FROM seller_sources WHERE id=?').get(String(id || ''))) },
    listSellerSources({ page = 1, pageSize = 100, q = '', status = null, group = null } = {}) {
      const safePage = Math.max(1, Number(page) || 1); const safePageSize = Math.min(1000, Math.max(1, Number(pageSize) || 100)); const clauses = ['1=1']; const values = []
      if (status) { clauses.push('s.status=?'); values.push(String(status)) }
      if (group === 'pending') clauses.push("s.status IN ('pending','running','incomplete','needs_review','login_expired','risk_control')")
      if (group === 'completed') clauses.push("s.status IN ('completed','no_active')")
      if (group === 'failed') clauses.push("s.status IN ('failed')")
      if (q) { const term = `%${String(q).trim().toLowerCase()}%`; clauses.push("(LOWER(COALESCE(s.seller_id,'')) LIKE ? OR LOWER(COALESCE(s.seller_name,'')) LIKE ? OR LOWER(s.seller_url) LIKE ? OR LOWER(COALESCE(s.category,'')) LIKE ?)"); values.push(term, term, term, term) }
      const where = clauses.join(' AND '); const total = Number(database.prepare(`SELECT COUNT(*) AS count FROM seller_sources s WHERE ${where}`).get(...values).count)
      const rows = database.prepare(`SELECT s.* FROM seller_sources s WHERE ${where} ORDER BY s.updated_at DESC, s.id LIMIT ? OFFSET ?`).all(...values, safePageSize, (safePage - 1) * safePageSize)
      return { items: rows.map(safeSellerSource), total, page: safePage, pageSize: safePageSize }
    },
    createSellerRun({ id = crypto.randomUUID(), trigger = 'manual', total = 0, createdBy = null } = {}) {
      const timestamp = now(); database.prepare("INSERT INTO seller_runs(id,trigger,status,total,started_at,created_by) VALUES (?,?, 'running', ?, ?, ?)").run(String(id), String(trigger || 'manual').slice(0, 40), Math.max(0, Number(total) || 0), timestamp, createdBy ? String(createdBy) : null); return api.getSellerRun(id)
    },
    getSellerRun(id) { return safeSellerRun(database.prepare('SELECT * FROM seller_runs WHERE id=?').get(String(id || ''))) },
    listSellerRuns({ page = 1, pageSize = 20 } = {}) { const safePage = Math.max(1, Number(page) || 1); const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 20)); const total = Number(database.prepare('SELECT COUNT(*) AS count FROM seller_runs').get().count); const rows = database.prepare('SELECT * FROM seller_runs ORDER BY started_at DESC LIMIT ? OFFSET ?').all(safePageSize, (safePage - 1) * safePageSize); return { items: rows.map(safeSellerRun), total, page: safePage, pageSize: safePageSize } },
    recordSellerResult({ sourceId, runId, result = {}, artifactId = null } = {}) {
      const source = database.prepare('SELECT * FROM seller_sources WHERE id=?').get(String(sourceId || '')); if (!source) return null
      const timestamp = now(); const status = String(result.status || 'failed'); const evidence = result.evidence || {}; const counts = result.counts || {}; const expected = result.expected || {}
      const persistedStatus = ['completed', 'succeeded', 'no_active'].includes(status) ? (status === 'no_active' || (Number(counts.active || counts.activeCount || 0) === 0 && Number(counts.sold || counts.soldCount || 0) === 0) ? 'no_active' : 'completed') : (status === 'login_expired' ? 'login_expired' : status === 'risk_cooldown' ? 'risk_control' : status === 'needs_review' ? 'needs_review' : status === 'incomplete' ? 'incomplete' : 'failed')
      database.prepare(`UPDATE seller_sources SET seller_name=COALESCE(NULLIF(?,''),seller_name),status=?,reason_code=?,reason=?,active_count=?,expected_active=?,sold_count=?,expected_sold=?,attempt_count=attempt_count+1,snapshot_artifact_id=COALESCE(?,snapshot_artifact_id),snapshot_at=CASE WHEN ? IS NOT NULL THEN ? ELSE snapshot_at END,last_run_id=?,updated_at=? WHERE id=?`).run(String(result.sellerName || '').trim().slice(0, 240), persistedStatus, result.reasonCode || result.error?.code || null, result.reason || result.error?.message || '', counts.active ?? counts.activeCount ?? evidence.activeCount ?? null, expected.active ?? expected.activeCount ?? evidence.expectedActive ?? null, counts.sold ?? counts.soldCount ?? evidence.soldCount ?? null, expected.sold ?? expected.soldCount ?? evidence.expectedSold ?? null, artifactId, artifactId, timestamp, runId ? String(runId) : null, timestamp, source.id)
      const items = Array.isArray(result.items) ? result.items : []
      const insert = database.prepare('INSERT INTO seller_items(id,source_id,run_id,item_id,title,category,branch,price,item_status,item_url,captured_at,result_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      const tx = database.transaction(() => { database.prepare('DELETE FROM seller_items WHERE source_id=? AND run_id=?').run(source.id, runId ? String(runId) : null); for (const item of items.slice(0, 100000)) insert.run(crypto.randomUUID(), source.id, runId ? String(runId) : null, String(item.itemId || item.id || '').slice(0, 200) || null, String(item.title || item.name || '').slice(0, 500) || null, String(item.category || '').slice(0, 120) || null, String(item.branch || item.statusBranch || item.source || '').slice(0, 40) || null, item.price == null ? null : Number(item.price), String(item.status || item.itemStatus || '').slice(0, 80) || null, String(item.url || item.itemUrl || '').slice(0, 2000) || null, timestamp, json(item)) })
      tx()
      const run = api.getSellerRun(runId); if (run) { const ok = ['completed','succeeded','no_active'].includes(status); const incomplete = ['incomplete','needs_review','login_expired','risk_control'].includes(status); const failed = !ok && !incomplete; const column = ok ? 'success' : incomplete ? 'incomplete' : 'failed'; database.prepare(`UPDATE seller_runs SET ${column}=${column}+1, finished_at=CASE WHEN success+incomplete+failed+1>=total THEN ? ELSE finished_at END, status=CASE WHEN success+incomplete+failed+1>=total THEN 'completed' ELSE status END WHERE id=?`).run(timestamp, String(runId)) }
      return api.getSellerSource(source.id)
    },
    listSellerItems({ sourceId = null, runId = null, page = 1, pageSize = 100 } = {}) { const safePage = Math.max(1, Number(page) || 1); const safePageSize = Math.min(1000, Math.max(1, Number(pageSize) || 100)); const clauses=['1=1']; const values=[]; if (sourceId) { clauses.push('source_id=?'); values.push(String(sourceId)) } if (runId) { clauses.push('run_id=?'); values.push(String(runId)) } const where=clauses.join(' AND '); const total=Number(database.prepare(`SELECT COUNT(*) AS count FROM seller_items WHERE ${where}`).get(...values).count); const rows=database.prepare(`SELECT * FROM seller_items WHERE ${where} ORDER BY captured_at DESC LIMIT ? OFFSET ?`).all(...values,safePageSize,(safePage-1)*safePageSize); return {items:rows.map(safeSellerItem),total,page:safePage,pageSize:safePageSize} },
    getSellerSummary() {
      const indexed = Number(database.prepare('SELECT COUNT(*) AS count FROM seller_sources WHERE enabled=1').get().count)
      const rows = database.prepare('SELECT status, COUNT(*) AS count FROM seller_sources WHERE enabled=1 GROUP BY status').all()
      const statuses = Object.fromEntries(rows.map(row => [row.status, Number(row.count)]))
      const activeJobs = database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='seller_snapshot' AND status IN ('pending','running')").get().count
      const pausedJobs = database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type='seller_snapshot' AND status IN ('pending','running') AND control_requested='pause'").get().count
      return {
        indexed,
        statuses,
        running: Number(activeJobs) > 0,
        paused: Number(pausedJobs) > 0,
        activeJobs: Number(activeJobs),
        pausedJobs: Number(pausedJobs),
        loaded: Number(database.prepare("SELECT COUNT(*) AS count FROM seller_sources WHERE enabled=1 AND status NOT IN ('pending')").get().count),
        crawled: Number(database.prepare("SELECT COUNT(*) AS count FROM seller_sources WHERE enabled=1 AND status IN ('completed','no_active')").get().count),
        groupCounts: {
          all: indexed,
          pending: Number(database.prepare("SELECT COUNT(*) AS count FROM seller_sources WHERE enabled=1 AND status IN ('pending','running','incomplete','needs_review','login_expired','risk_control')").get().count),
          completed: Number(database.prepare("SELECT COUNT(*) AS count FROM seller_sources WHERE enabled=1 AND status IN ('completed','no_active')").get().count),
          failed: Number(database.prepare("SELECT COUNT(*) AS count FROM seller_sources WHERE enabled=1 AND status='failed'").get().count)
        }
      }
    },
    createSchedule(schedule = {}) {
      const id = String(schedule.id || crypto.randomUUID())
      const payloadJson = json(schedule.payload || {})
      if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) throw Object.assign(new Error('schedule payload too large'), { code: 'payload_too_large' })
      const intervalMs = Math.max(1_000, Number(schedule.intervalMs) || 60_000)
      const timestamp = now()
      const nextRunAt = schedule.nextRunAt ? new Date(schedule.nextRunAt).toISOString() : new Date(Date.now() + intervalMs).toISOString()
      database.prepare(`INSERT INTO schedules(id, name, job_type, payload_json, profile_id, interval_ms, enabled, next_run_at, created_by, created_at, updated_at)
        VALUES (@id, @name, @job_type, @payload_json, @profile_id, @interval_ms, @enabled, @next_run_at, @created_by, @created_at, @updated_at)`).run({
        id,
        name: String(schedule.name || id).trim().slice(0, 120),
        job_type: String(schedule.jobType || 'market_snapshot'),
        payload_json: payloadJson,
        profile_id: schedule.profileId ? String(schedule.profileId) : null,
        interval_ms: intervalMs,
        enabled: schedule.enabled === false ? 0 : 1,
        next_run_at: nextRunAt,
        created_by: schedule.createdBy ? String(schedule.createdBy) : null,
        created_at: timestamp,
        updated_at: timestamp
      })
      return api.getSchedule(id)
    },
    /**
     * Idempotently install a named schedule owned by a server-side subsystem.
     * Recurring H5 settings are edited more than once and the scheduler must
     * not create duplicate rows on every PATCH or process restart.  A caller
     * may omit nextRunAt to preserve the existing due time while refreshing
     * the payload/profile binding.
     */
    upsertSchedule(schedule = {}) {
      const id = String(schedule.id || '').trim()
      if (!id) throw Object.assign(new Error('schedule id is required'), { code: 'schedule_required' })
      const payloadJson = json(schedule.payload || {})
      if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) throw Object.assign(new Error('schedule payload too large'), { code: 'payload_too_large' })
      const intervalMs = Math.max(1_000, Number(schedule.intervalMs) || 60_000)
      const timestamp = now()
      const existing = database.prepare('SELECT * FROM schedules WHERE id = ?').get(id)
      let nextRunAt = existing?.next_run_at || null
      if (schedule.nextRunAt != null && String(schedule.nextRunAt).trim()) {
        const parsed = new Date(schedule.nextRunAt)
        if (!Number.isFinite(parsed.getTime())) throw Object.assign(new Error('nextRunAt is invalid'), { code: 'schedule_time_invalid' })
        nextRunAt = parsed.toISOString()
      }
      if (!nextRunAt) nextRunAt = new Date(Date.now() + intervalMs).toISOString()
      const values = {
        id,
        name: String(schedule.name || id).trim().slice(0, 120),
        job_type: String(schedule.jobType || 'market_snapshot'),
        payload_json: payloadJson,
        profile_id: schedule.profileId ? String(schedule.profileId) : null,
        interval_ms: intervalMs,
        enabled: schedule.enabled === false ? 0 : 1,
        next_run_at: nextRunAt,
        created_by: schedule.createdBy ? String(schedule.createdBy) : (existing?.created_by || null),
        created_at: existing?.created_at || timestamp,
        updated_at: timestamp
      }
      if (existing) {
        database.prepare(`UPDATE schedules SET name=@name, job_type=@job_type, payload_json=@payload_json,
          profile_id=@profile_id, interval_ms=@interval_ms, enabled=@enabled, next_run_at=@next_run_at,
          created_by=@created_by, updated_at=@updated_at WHERE id=@id`).run(values)
      } else {
        database.prepare(`INSERT INTO schedules(id, name, job_type, payload_json, profile_id, interval_ms, enabled, next_run_at, created_by, created_at, updated_at)
          VALUES (@id, @name, @job_type, @payload_json, @profile_id, @interval_ms, @enabled, @next_run_at, @created_by, @created_at, @updated_at)`).run(values)
      }
      return api.getSchedule(id)
    },
    getSchedule(id) {
      const row = database.prepare('SELECT * FROM schedules WHERE id = ?').get(String(id || ''))
      return row ? { ...row, payload: parse(row.payload_json), payload_json: undefined, enabled: Boolean(row.enabled) } : null
    },
    listSchedules({ limit = 100, enabled = null } = {}) {
      const bounded = Math.min(100, Math.max(1, Number(limit) || 100))
      const rows = enabled == null
        ? database.prepare('SELECT * FROM schedules ORDER BY created_at DESC LIMIT ?').all(bounded)
        : database.prepare('SELECT * FROM schedules WHERE enabled = ? ORDER BY created_at DESC LIMIT ?').all(enabled ? 1 : 0, bounded)
      return rows.map(row => ({ ...row, payload: parse(row.payload_json), payload_json: undefined, enabled: Boolean(row.enabled) }))
    },
    setScheduleEnabled(id, enabled, actorId = null) {
      const timestamp = now()
      const result = database.prepare('UPDATE schedules SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, timestamp, String(id))
      if (!result.changes) return null
      const schedule = api.getSchedule(id)
      audit({ actorId, action: enabled ? 'schedule.enable' : 'schedule.disable', entityType: 'schedule', entityId: id, metadata: {} })
      return schedule
    },
    enqueueDueSchedules(at = new Date()) {
      const atDate = new Date(at)
      const atIso = atDate.toISOString()
      const enqueue = database.transaction(() => {
        const due = database.prepare('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at LIMIT 50').all(atIso)
        return due.map(row => {
          const intervalMs = Math.max(1_000, Number(row.interval_ms) || 60_000)
          const nextRunAt = new Date(atDate.getTime() + intervalMs).toISOString()
          const advanced = database.prepare('UPDATE schedules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ? AND enabled = 1 AND next_run_at <= ?').run(atIso, nextRunAt, atIso, row.id, atIso)
          if (!advanced.changes) return null
          const job = api.createJob({ type: row.job_type, payload: parse(row.payload_json), profileId: row.profile_id, operatorId: row.created_by })
          appendEvent({ jobId: job.id, eventType: 'schedule.enqueued', status: 'pending', payload: { scheduleId: row.id, scheduledAt: atIso } })
          return { schedule: api.getSchedule(row.id), job }
        }).filter(Boolean)
      })
      return enqueue()
    },
    createJob(job = {}) {
      const id = String(job.id || crypto.randomUUID())
      const payloadJson = json(job.payload || {})
      if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) throw Object.assign(new Error('job payload too large'), { code: 'payload_too_large' })
      const timestamp = now()
      database.prepare(`INSERT INTO jobs(id, type, payload_json, status, profile_id, operator_id, attempt, created_at, updated_at)
        VALUES (@id, @type, @payload_json, 'pending', @profile_id, @operator_id, 0, @created_at, @updated_at)`).run({
        id,
        type: String(job.type || 'browser_probe'),
        payload_json: payloadJson,
        profile_id: job.profileId ? String(job.profileId) : null,
        operator_id: job.operatorId ? String(job.operatorId) : null,
        created_at: timestamp,
        updated_at: timestamp
      })
      const record = api.getJob(id)
      appendEvent({ jobId: id, eventType: 'job.created', status: 'pending', payload: { type: record.type, operatorId: record.operator_id || null } })
      return record
    },
    getJob(id) { return safeJob(database.prepare('SELECT * FROM jobs WHERE id = ?').get(String(id || ''))) },
    listJobs({ limit = 50, status = null } = {}) {
      const bounded = Math.min(100, Math.max(1, Number(limit) || 50))
      const rows = status && JOB_STATUSES.has(String(status))
        ? database.prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(String(status), bounded)
        : database.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(bounded)
      return rows.map(safeJob)
    },
    getActiveJobSummary() {
      const rows = database.prepare("SELECT type, status, COUNT(*) AS count FROM jobs WHERE status IN ('pending','running') GROUP BY type, status").all()
      const counts = {}
      for (const row of rows) {
        const type = String(row.type || '').trim()
        if (!type) continue
        counts[type] = { ...(counts[type] || {}), [String(row.status)]: Number(row.count) || 0 }
      }
      const eventCursor = Number(database.prepare('SELECT MAX(cursor) AS cursor FROM job_events').get()?.cursor || 0)
      return { counts, eventCursor }
    },
    listActiveJobs({ type = null } = {}) {
      const rows = type
        ? database.prepare("SELECT * FROM jobs WHERE type=? AND status IN ('pending','running') ORDER BY created_at").all(String(type))
        : database.prepare("SELECT * FROM jobs WHERE status IN ('pending','running') ORDER BY created_at").all()
      return rows.map(safeJob)
    },
    claimJob({ workerId, leaseToken, leaseMs = 60_000, excludeProfileIds = [], profileLockOwner = null, profileLockLeaseMs = leaseMs } = {}) {
      const worker = String(workerId || '').trim()
      const token = String(leaseToken || '').trim()
      if (!worker || !token) throw new Error('worker lease identity required')
      const timestamp = now()
      const expiry = new Date(Date.now() + Math.max(1_000, Number(leaseMs) || 60_000)).toISOString()
      const excluded = [...new Set((Array.isArray(excludeProfileIds) ? excludeProfileIds : []).map(value => String(value || '').trim()).filter(Boolean))]
      const exclusionSql = excluded.length ? ` AND (profile_id IS NULL OR profile_id NOT IN (${excluded.map(() => '?').join(',')}))` : ''
      const lockOwner = String(profileLockOwner || '').trim()
      const transaction = database.transaction(() => {
        const rows = database.prepare(`SELECT * FROM jobs WHERE control_requested IS NULL AND ((status = 'pending' AND (retry_at IS NULL OR retry_at <= ?)) OR (status = 'running' AND lease_expires_at < ?))${exclusionSql} ORDER BY created_at LIMIT 100`).all(timestamp, timestamp, ...excluded)
        let row = null
        for (const candidate of rows) {
          if (lockOwner && candidate.profile_id) {
            const currentLock = database.prepare('SELECT owner_id, lease_expires_at FROM browser_profile_locks WHERE profile_id = ?').get(candidate.profile_id)
            if (currentLock && currentLock.owner_id !== lockOwner && String(currentLock.lease_expires_at || '') > timestamp) continue
            const lockExpiry = new Date(Date.now() + Math.max(1_000, Number(profileLockLeaseMs) || leaseMs)).toISOString()
            database.prepare(`INSERT INTO browser_profile_locks(profile_id, owner_id, lease_expires_at, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(profile_id) DO UPDATE SET owner_id=excluded.owner_id, lease_expires_at=excluded.lease_expires_at, updated_at=excluded.updated_at`).run(candidate.profile_id, lockOwner, lockExpiry, timestamp)
          }
          row = candidate
          break
        }
        if (!row) return null
        database.prepare(`UPDATE jobs SET status='running', worker_id=?, lease_token=?, lease_expires_at=?, retry_at=NULL, attempt=attempt+1, started_at=COALESCE(started_at, ?), updated_at=? WHERE id=?`).run(worker, token, expiry, timestamp, timestamp, row.id)
        const current = api.getJob(row.id)
        // The lease token is an internal Worker capability. Keep it out of the
        // enumerable DTO while allowing the Worker that claimed the row to
        // complete the transition without a second secret channel.
        Object.defineProperty(current, '_leaseToken', { value: token, enumerable: false, configurable: false })
        appendEvent({ jobId: row.id, eventType: 'job.claimed', status: 'running', payload: { workerId: worker, attempt: current.attempt } })
        return current
      })
      try { return transaction.immediate() } catch (error) {
        if (/database is locked|database table is locked/i.test(String(error?.message || error))) return null
        throw error
      }
    },
    heartbeat({ jobId, workerId, leaseToken, leaseMs = 60_000 } = {}) {
      const timestamp = now()
      const expiry = new Date(Date.now() + Math.max(1_000, Number(leaseMs) || 60_000)).toISOString()
      const result = database.prepare(`UPDATE jobs SET lease_expires_at=?, updated_at=? WHERE id=? AND status='running' AND worker_id=? AND lease_token=?`).run(expiry, timestamp, String(jobId), String(workerId), String(leaseToken))
      if (!result.changes) return null
      const current = api.getJob(jobId)
      appendEvent({ jobId, eventType: 'worker.heartbeat', status: current.status, payload: { workerId: String(workerId), leaseExpiresAt: expiry } })
      return current
    },
    requestJobControl({ jobId, command, actorId = null } = {}) {
      const action = String(command || '').trim().toLowerCase()
      if (!['pause', 'resume'].includes(action)) throw Object.assign(new Error('job control must be pause or resume'), { code: 'invalid_control' })
      const timestamp = now()
      const result = database.prepare('UPDATE jobs SET control_requested = ?, updated_at = ? WHERE id = ? AND status IN (\'pending\', \'running\')').run(action === 'pause' ? 'pause' : null, timestamp, String(jobId))
      if (!result.changes) return api.getJob(jobId)
      const current = api.getJob(jobId)
      appendEvent({ jobId, eventType: `task.${action}`, status: current.status, payload: { control: action } })
      audit({ actorId, action: `task.${action}`, entityType: 'job', entityId: jobId, metadata: { status: current.status } })
      return current
    },
    releasePausedJob({ jobId, workerId, leaseToken } = {}) {
      const timestamp = now()
      const result = database.prepare("UPDATE jobs SET status='pending', worker_id=NULL, lease_token=NULL, lease_expires_at=NULL, updated_at=? WHERE id=? AND status='running' AND control_requested='pause' AND worker_id=? AND lease_token=?").run(timestamp, String(jobId), String(workerId), String(leaseToken))
      if (!result.changes) return null
      const current = api.getJob(jobId)
      appendEvent({ jobId, eventType: 'task.paused', status: 'pending', payload: { control: 'pause' } })
      return current
    },
    completeJob({ jobId, workerId, leaseToken, result = {} } = {}) {
      return api._finishJob({ jobId, workerId, leaseToken, status: 'succeeded', result })
    },
    failJob({ jobId, workerId, leaseToken, errorCode = 'job_failed', errorMessage = 'Job failed' } = {}) {
      return api._finishJob({ jobId, workerId, leaseToken, status: 'failed', errorCode, errorMessage })
    },
    cancelJob({ jobId, actorId = null } = {}) {
      const timestamp = now()
      const result = database.prepare(`UPDATE jobs SET status='cancelled', error_code='cancelled_by_operator', error_message='Cancelled by operator', retry_at=NULL, control_requested=NULL, finished_at=?, updated_at=? WHERE id=? AND status IN ('pending','running')`).run(timestamp, timestamp, String(jobId))
      if (!result.changes) return api.getJob(jobId)
      const current = api.getJob(jobId)
      appendEvent({ jobId, eventType: 'job.cancelled', status: 'cancelled', payload: { actorId } })
      audit({ actorId, action: 'job.cancel', entityType: 'job', entityId: jobId, metadata: { status: 'cancelled' } })
      return current
    },
    retryJob({ jobId, workerId, leaseToken, errorCode = 'retryable_failure', errorMessage = 'Retry scheduled', delayMs = 0 } = {}) {
      const timestamp = now()
      const nextAt = new Date(Date.now() + Math.max(0, Number(delayMs) || 0)).toISOString()
      const result = database.prepare(`UPDATE jobs SET status='pending', error_code=?, error_message=?, retry_at=?, lease_token=NULL, lease_expires_at=NULL, worker_id=NULL, updated_at=? WHERE id=? AND status='running' AND worker_id=? AND lease_token=?`).run(String(errorCode), String(errorMessage).slice(0, 240), nextAt, timestamp, String(jobId), String(workerId), String(leaseToken))
      if (!result.changes) return null
      const current = api.getJob(jobId)
      appendEvent({ jobId, eventType: 'job.retry_scheduled', status: 'pending', payload: { errorCode: String(errorCode), retryAt: nextAt, attempt: current.attempt } })
      return current
    },
    _finishJob({ jobId, workerId, leaseToken, status, result = null, errorCode = null, errorMessage = null }) {
      const timestamp = now()
      const changes = database.prepare(`UPDATE jobs SET status=?, result_json=?, error_code=?, error_message=?, finished_at=?, updated_at=?, retry_at=NULL, lease_token=NULL, lease_expires_at=NULL WHERE id=? AND status='running' AND worker_id=? AND lease_token=?`).run(status, result == null ? null : json(result), errorCode, String(errorMessage || '').slice(0, 240) || null, timestamp, timestamp, String(jobId), String(workerId), String(leaseToken))
      if (!changes.changes) return null
      const current = api.getJob(jobId)
      appendEvent({ jobId, eventType: `job.${status}`, status, payload: { errorCode: current.error_code || null, result: current.result || null } })
      return current
    },
    listEvents({ after = 0, limit = 100, jobId = null } = {}) {
      const bounded = Math.min(200, Math.max(1, Number(limit) || 100))
      const base = `SELECT events.*, jobs.type AS job_type
        FROM job_events AS events
        LEFT JOIN jobs ON jobs.id = events.job_id
        WHERE events.cursor > ?`
      const rows = jobId
        ? database.prepare(`${base} AND events.job_id = ? ORDER BY events.cursor LIMIT ?`).all(Number(after) || 0, String(jobId), bounded)
        : database.prepare(`${base} ORDER BY events.cursor LIMIT ?`).all(Number(after) || 0, bounded)
      return rows.map(row => ({ cursor: row.cursor, jobId: row.job_id, jobType: row.job_type || null, eventType: row.event_type, status: row.status, payload: parse(row.payload_json), createdAt: row.created_at }))
    },
    appendEvent,
    audit
  }
  return api
}

module.exports = { MAX_PAYLOAD_BYTES, createDatabase }

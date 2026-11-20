/**
 * 闲鱼上新监听任务：仅存本地 JSON（用户数据目录），不上传服务端
 */
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { PIPE_KW_RAW_MAX_LEN } from '../../shared/pipe-keywords-limits.js'
import { normalizeGreetingDeliveryMode } from '../../shared/sxjk-greeting-delivery-mode.js'

const ALLOWED_INTERVAL = new Set([1, 2, 3, 4, 5, 10, 15, 30, 45, 60])
/** 游客模式轮询间隔（秒），与前端 Tasks.vue 校验一致 */
const GUEST_POLL_SEC_MIN = 3
const GUEST_POLL_SEC_MAX = 86400
const MAX_GUEST_COOKIE_LEN = 24 * 1024
const ALLOWED_PUBLISH_DAYS = new Set(['', 'latest', '1', '3', '7', '14'])
/** 与前端 Tasks.vue SORT_MODE_OPTIONS 一致 */
const ALLOWED_SORT_MODE = new Set([
  '',
  'create_desc',
  'modify_desc',
  'credit_desc',
  'pos_asc',
  'reduce_desc',
  'price_asc',
  'price_desc',
  'publish_latest',
  'publish_1',
  'publish_3',
  'publish_7',
  'publish_14'
])
/** 与前端 sxjkTaskNormalize QUICK_FILTER_ALLOWED 一致 */
const QUICK_FILTER_ALLOWED = new Set([
  'filterPersonal',
  'filterAppraise',
  'gameAccountInsurance',
  'filterFreePostage',
  'filterHighLevelYxpSeller',
  'filterNew',
  'inspectedPhone',
  'filterOneKeyResell'
])
/** 与前端 sxjkTaskNormalize MAX_DIVISION_LEAVES 一致 */
const MAX_DIVISION_LEAVES = 24

function normalizePublishDays(v) {
  const s = String(v == null ? '' : v).trim()
  return ALLOWED_PUBLISH_DAYS.has(s) ? s : ''
}

/** 与闲鱼 PC searchFilter 一致，非负整数或最多两位小数 */
function normalizePriceField(v) {
  const s = String(v == null ? '' : v).trim()
  if (!s) return ''
  return /^\d+(\.\d{1,2})?$/.test(s) ? s : ''
}

/** 与渲染层 `normalizeLooseMatchKey` / 主进程 `normalizeLooseTextForMatch` 一致 */
function normalizeLooseMatchKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\s+/gu, '')
}

/**
 * 每段「包含词」可单独设最低价/最高价；落盘为对象，key 为宽松规范化后的词段。
 * @returns {Record<string, { min: string, max: string }>}
 */
function normalizeMatchSubPriceRangesPersist(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    const key = normalizeLooseMatchKey(k)
    if (!key || key.length > 200) continue
    if (v == null || typeof v !== 'object') continue
    const min = normalizePriceField(v.min ?? v.price_from)
    const max = normalizePriceField(v.max ?? v.price_to)
    out[key] = { min, max }
    if (Object.keys(out).length >= 60) break
  }
  return out
}

function normalizeSortMode(v) {
  const s = String(v == null ? '' : v).trim()
  return ALLOWED_SORT_MODE.has(s) ? s : ''
}

function normalizeQuickFiltersPersist(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const x of raw) {
    const s = String(x || '').trim()
    if (!QUICK_FILTER_ALLOWED.has(s) || out.includes(s)) continue
    out.push(s)
  }
  return out
}

/** 秒拍绑定的账号 id（与账号管理里 account.id 一致） */
function normalizeMiaopaiAccountId(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  return s.slice(0, 64)
}

/** 排序选「最新」时：只保留发布时间在该分钟数内的商品（本地过滤，默认 30） */
function normalizeSortLatestWithinMinutes(v) {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n < 1) return 30
  return Math.min(24 * 60, Math.max(1, n))
}

function normalizeXianyuMode(v) {
  return String(v || '').trim() === 'account' ? 'account' : 'guest'
}

const SCHEDULE_HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/

function normalizeScheduleTimePersist(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const m = s.match(SCHEDULE_HHMM_RE)
  if (!m) return ''
  const h = Number(m[1])
  const min = Number(m[2])
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}

function normalizeGuestCookieHeader(v) {
  let s = String(v ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('; ')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
  if (s.length > MAX_GUEST_COOKIE_LEN) s = s.slice(0, MAX_GUEST_COOKIE_LEN)
  if (!/(?:^|;\s*)_m_h5_tk=/.test(s)) return ''
  return s
}

function normalizeXianyuAccountId(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  return s.slice(0, 64)
}

/** 账号模式多账号轮询：最多条数，与前端任务表单一致 */
const MAX_XIANYU_LISTEN_ACCOUNT_IDS = 16

/**
 * @returns {string[]}
 */
function normalizeXianyuListenAccountIdsPersist(t, xianyu_mode) {
  if (xianyu_mode !== 'account') return []
  const raw = t?.xianyu_listen_account_ids
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const x of raw) {
    const id = normalizeXianyuAccountId(x)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_XIANYU_LISTEN_ACCOUNT_IDS) break
  }
  return out
}

function normalizeDivisionLeafIdsPersist(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const x of raw) {
    if (typeof x === 'string') {
      const s = x.trim()
      if (/^p:\d+$/.test(s) || /^c:\d+$/.test(s)) {
        if (seen.has(s)) continue
        seen.add(s)
        out.push(s)
        if (out.length >= MAX_DIVISION_LEAVES) break
      }
      continue
    }
    const id = typeof x === 'number' && Number.isInteger(x) ? x : parseInt(x, 10)
    if (!Number.isFinite(id) || id <= 0) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= MAX_DIVISION_LEAVES) break
  }
  return out
}

/** 与 app 配置里 dingtalkRobots 下标对应；去重、非负整数 */
function normalizeDingtalkRobotIndicesPersist(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const x of raw) {
    const n = Math.floor(Number(x))
    if (!Number.isFinite(n) || n < 0 || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

/** 任务关联「全局配置」→「打招呼」模板 id，与服务端 xy_sxjk_global_greeting.id 一致 */
function normalizeGreetingTemplateIdsPersist(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const x of raw) {
    const n = Math.floor(Number(x))
    if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue
    seen.add(n)
    out.push(n)
    if (out.length >= 50) break
  }
  return out
}

function normalizeGuestPollIntervalSec(t, xianyu_mode, interval_minutes) {
  if (xianyu_mode !== 'guest') return null
  const raw = Math.floor(Number(t?.guest_poll_interval_sec))
  if (Number.isFinite(raw) && raw >= GUEST_POLL_SEC_MIN && raw <= GUEST_POLL_SEC_MAX) {
    return raw
  }
  const m = Math.floor(Number(t?.interval_minutes))
  const mi = ALLOWED_INTERVAL.has(m) ? m : 5
  const sec = mi * 60
  return Math.min(GUEST_POLL_SEC_MAX, Math.max(GUEST_POLL_SEC_MIN, sec))
}

/** 账号模式：检查间隔（秒）；缺省或非法时由 interval_minutes×60 推导，与游客 guest_poll_interval_sec 规则一致；允许小数（风控按比例拉长间隔） */
function normalizeAccountPollIntervalSec(t, xianyu_mode, interval_minutes) {
  if (xianyu_mode !== 'account') return null
  const raw = Number(t?.account_poll_interval_sec)
  if (Number.isFinite(raw) && raw >= GUEST_POLL_SEC_MIN && raw <= GUEST_POLL_SEC_MAX) {
    return Math.round(raw * 100) / 100
  }
  const mi = ALLOWED_INTERVAL.has(interval_minutes) ? interval_minutes : 5
  const sec = mi * 60
  return Math.min(GUEST_POLL_SEC_MAX, Math.max(GUEST_POLL_SEC_MIN, sec))
}

export function normalizeTask(t) {
  const intervalRaw = Number(t?.interval_minutes)
  const interval_minutes = ALLOWED_INTERVAL.has(intervalRaw) ? intervalRaw : 5
  const division_nationwide =
    t?.division_nationwide === true || t?.division_nationwide === 1 || t?.division_nationwide === '1'
  let division_leaf_ids = normalizeDivisionLeafIdsPersist(t?.division_leaf_ids)
  if (division_nationwide) division_leaf_ids = []
  let dingtalk_robot_indices = normalizeDingtalkRobotIndicesPersist(t?.dingtalk_robot_indices)
  if (t && typeof t === 'object' && !Object.prototype.hasOwnProperty.call(t, 'dingtalk_robot_indices')) {
    dingtalk_robot_indices = [0]
  }
  const interval_jitter_enabled =
    t?.interval_jitter_enabled === true ||
    t?.interval_jitter_enabled === 1 ||
    t?.interval_jitter_enabled === '1'
  // 已推送去重固定开启（界面不再提供开关）
  const filter_pushed_enabled = true
  const dingtalk_push_enabled =
    t?.dingtalk_push_enabled === true || t?.dingtalk_push_enabled === 1 || t?.dingtalk_push_enabled === '1'
  const xianyu_mode = normalizeXianyuMode(t?.xianyu_mode)
  const guest_poll_interval_sec = normalizeGuestPollIntervalSec(t, xianyu_mode, interval_minutes)
  const account_poll_interval_sec = normalizeAccountPollIntervalSec(t, xianyu_mode, interval_minutes)
  const guest_cookie_header = xianyu_mode === 'guest' ? normalizeGuestCookieHeader(t?.guest_cookie_header) : ''
  const guest_cookie_updated_at =
    guest_cookie_header && t?.guest_cookie_updated_at != null
      ? String(t.guest_cookie_updated_at).trim().slice(0, 64)
      : ''
  let xianyu_listen_account_ids = normalizeXianyuListenAccountIdsPersist(t, xianyu_mode)
  let xianyu_account_id = normalizeXianyuAccountId(t?.xianyu_account_id)
  if (xianyu_mode !== 'account') {
    xianyu_listen_account_ids = []
  }
  const greeting_enabled_raw =
    t?.greeting_enabled === true || t?.greeting_enabled === 1 || t?.greeting_enabled === '1'
  // 游客 / 账号模式均可打招呼，但须已选私聊账号
  const greeting_enabled = greeting_enabled_raw && !!xianyu_account_id
  const greeting_template_ids = normalizeGreetingTemplateIdsPersist(t?.greeting_template_ids)
  const greeting_delivery_mode = normalizeGreetingDeliveryMode(t?.greeting_delivery_mode)
  const miaopai_account_id = normalizeMiaopaiAccountId(t?.miaopai_account_id)
  const hasMiaopaiEnabledKey =
    t && typeof t === 'object' && Object.prototype.hasOwnProperty.call(t, 'miaopai_enabled')
  const miaopai_enabled = hasMiaopaiEnabledKey
    ? t?.miaopai_enabled === true || t?.miaopai_enabled === 1 || t?.miaopai_enabled === '1'
    : !!miaopai_account_id
  return {
    id: String(t?.id || ''),
    keyword: String(t?.keyword || '').trim(),
    match_sub: t?.match_sub != null ? String(t.match_sub).trim().slice(0, PIPE_KW_RAW_MAX_LEN) : '',
    match_sub_price_ranges: normalizeMatchSubPriceRangesPersist(t?.match_sub_price_ranges),
    exclude_keywords:
      t?.exclude_keywords != null ? String(t.exclude_keywords).trim().slice(0, PIPE_KW_RAW_MAX_LEN) : '',
    exclude_seller_keywords:
      t?.exclude_seller_keywords != null ? String(t.exclude_seller_keywords).trim().slice(0, PIPE_KW_RAW_MAX_LEN) : '',
    price_from: normalizePriceField(t?.price_from),
    price_to: normalizePriceField(t?.price_to),
    publish_days: normalizePublishDays(t?.publish_days),
    sort_mode: normalizeSortMode(t?.sort_mode),
    sort_latest_within_minutes: normalizeSortLatestWithinMinutes(t?.sort_latest_within_minutes),
    quick_filters: normalizeQuickFiltersPersist(t?.quick_filters),
    division_nationwide,
    division_leaf_ids,
    interval_minutes,
    guest_poll_interval_sec,
    guest_cookie_header,
    guest_cookie_updated_at,
    account_poll_interval_sec,
    interval_jitter_enabled,
    enabled: t?.enabled !== false && t?.enabled !== '0',
    xianyu_mode,
    xianyu_listen_account_ids,
    xianyu_account_id,
    miaopai_account_id,
    miaopai_enabled,
    miaopai_deliver_id: String(t?.miaopai_deliver_id || '').trim().slice(0, 32),
    miaopai_deliver_label: String(t?.miaopai_deliver_label || '').trim().slice(0, 160),
    filter_pushed_enabled,
    dingtalk_push_enabled,
    dingtalk_robot_indices,
    greeting_enabled,
    greeting_template_ids,
    greeting_delivery_mode,
    schedule_enabled: (() => {
      const on =
        t?.schedule_enabled === true || t?.schedule_enabled === 1 || t?.schedule_enabled === '1'
      const start = normalizeScheduleTimePersist(t?.schedule_start)
      const stop = normalizeScheduleTimePersist(t?.schedule_stop)
      return on && !!start && !!stop && start !== stop
    })(),
    schedule_start: (() => {
      const on =
        t?.schedule_enabled === true || t?.schedule_enabled === 1 || t?.schedule_enabled === '1'
      const start = normalizeScheduleTimePersist(t?.schedule_start)
      const stop = normalizeScheduleTimePersist(t?.schedule_stop)
      return on && start && stop && start !== stop ? start : ''
    })(),
    schedule_stop: (() => {
      const on =
        t?.schedule_enabled === true || t?.schedule_enabled === 1 || t?.schedule_enabled === '1'
      const start = normalizeScheduleTimePersist(t?.schedule_start)
      const stop = normalizeScheduleTimePersist(t?.schedule_stop)
      return on && start && stop && start !== stop ? stop : ''
    })(),
    /** 旧字段：不再参与去重，统一保留为空 */
    seen_ids: [],
    last_run_at: t?.last_run_at != null ? String(t.last_run_at) : null
  }
}

export function registerSxjkListenTasksIPC(ipcMain, tasksFilePath) {
  ipcMain.handle('get-sxjk-listen-tasks', async () => {
    try {
      const raw = await fs.readFile(tasksFilePath, 'utf-8')
      const data = JSON.parse(raw)
      const list = Array.isArray(data)
        ? data
        : data && Array.isArray(data.tasks)
          ? data.tasks
          : []
      const tasks = list.map(normalizeTask).filter((t) => t.id && t.keyword)
      return { ok: true, tasks }
    } catch (e) {
      if (e && e.code === 'ENOENT') return { ok: true, tasks: [] }
      return { ok: false, error: String(e.message || e), tasks: [] }
    }
  })

  ipcMain.handle('save-sxjk-listen-tasks', async (_e, tasks) => {
    try {
      if (!Array.isArray(tasks)) return { ok: false, error: 'invalid_tasks' }
      const cleaned = tasks.map(normalizeTask).filter((t) => t.id && t.keyword)
      const dir = dirname(tasksFilePath)
      await fs.mkdir(dir, { recursive: true })
      const json = JSON.stringify(cleaned, null, 2)
      const tmp = `${tasksFilePath}.${process.pid}.tmp`
      await fs.writeFile(tmp, json, 'utf-8')
      await fs.rename(tmp, tasksFilePath)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e.message || e) }
    }
  })

  /** 服务端 Socket 下发：启停监听任务（写本地 JSON，不上传服务端） */
  ipcMain.handle('apply-sxjk-listen-task-quick-cmd', async (_e, payload) => {
    try {
      const cmd = String(payload?.cmd || '')
        .trim()
        .toLowerCase()
      if (!['start', 'pause', 'pause_all'].includes(cmd)) {
        return { ok: false, error: 'invalid_cmd' }
      }
      if (cmd !== 'pause_all') {
        const tid = String(payload?.taskId ?? '').trim()
        if (!tid) return { ok: false, error: 'missing_task' }
      }

      const raw = await fs.readFile(tasksFilePath, 'utf-8')
      const data = JSON.parse(raw)
      const list = Array.isArray(data)
        ? data
        : data && Array.isArray(data.tasks)
          ? data.tasks
          : []

      /** @type {unknown[]} */
      let nextList
      if (cmd === 'pause_all') {
        nextList = list.map((t) => ({ ...t, enabled: false }))
      } else {
        const taskId = String(payload?.taskId ?? '').trim()
        let found = false
        nextList = list.map((t) => {
          if (String(t?.id || '') !== taskId) return t
          found = true
          return { ...t, enabled: cmd === 'start' }
        })
        if (!found) return { ok: false, error: 'task_not_found' }
      }

      const cleaned = nextList.map(normalizeTask).filter((t) => t.id && t.keyword)
      const dir = dirname(tasksFilePath)
      await fs.mkdir(dir, { recursive: true })
      const json = JSON.stringify(cleaned, null, 2)
      const tmp = `${tasksFilePath}.${process.pid}.tmp`
      await fs.writeFile(tmp, json, 'utf-8')
      await fs.rename(tmp, tasksFilePath)
      return { ok: true }
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        return { ok: false, error: 'no_tasks_file' }
      }
      return { ok: false, error: String(e.message || e) }
    }
  })
}

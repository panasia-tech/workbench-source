// 应用配置相关 IPC 模块
// 职责：负责读取和更新应用配置文件（用户数据目录/data/config/app.js）
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  clipDingtalkRobotName,
  DINGTALK_ROBOT_NAME_MAX_LEN,
  normalizeDingtalkRobots
} from '../utils/dingtalk-robots.js'
import { formatAppWindowTitle } from '../utils/app-window-title.js'
import { applyPreventSleep } from '../utils/power-save-blocker.js'
import { PIPE_KW_RAW_MAX_LEN } from '../../shared/pipe-keywords-limits.js'

// 获取默认配置文件路径（用于后备）
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const defaultConfigFile = join(__dirname, '..', 'data', 'config', 'app.js')

const require = createRequire(import.meta.url)

/** 配置结构版本：旧文件无此字段时视为需要迁移（推荐「收到系统托盘」） */
const CURRENT_CONFIG_SCHEMA_VERSION = 2

/** 与 renderer `dingtalkPushMarkdown.js` 中 DEFAULT_DINGTALK_PUSH_FIELDS 保持一致 */
const DEFAULT_DINGTALK_PUSH_FIELDS = {
  itemTitle: true,
  price: true,
  city: true,
  time: true,
  sellerNick: true,
  yanhuobao: true,
  sellerCredit: true,
  want: true,
  buyerCredit: true,
  services: true,
  link: true
}

function mergeDingtalkPushFields(raw) {
  const base = { ...DEFAULT_DINGTALK_PUSH_FIELDS }
  if (!raw || typeof raw !== 'object') return base
  for (const k of Object.keys(base)) {
    if (Object.prototype.hasOwnProperty.call(raw, k)) base[k] = !!raw[k]
  }
  return base
}

/** multi=多条上新合并一条消息；single=每个商品一条消息 */
function normalizeDingtalkPushCardMode(v) {
  return String(v || '').toLowerCase() === 'single' ? 'single' : 'multi'
}

/** markdown | actionCard | link（后两者仅单条 1 商品） */
function normalizeDingtalkPushDisplayMode(v) {
  const s = String(v || '').toLowerCase()
  if (s === 'actioncard') return 'actionCard'
  if (s === 'link') return 'link'
  return 'markdown'
}

const SXJK_GLOBAL_KW_MAX = PIPE_KW_RAW_MAX_LEN

function normalizeSxjkGlobalKeywordStr(v) {
  return String(v ?? '').trim().slice(0, SXJK_GLOBAL_KW_MAX)
}

/**
 * @param {unknown} raw
 * @returns {{ userId: string, plainUserId?: string, nick?: string, addedAt?: string }[]}
 * userId 存列表侧卖家标识（多为加密），仅用于轮询过滤；plainUserId 为可选明文，仅用于头像/个人页，不参与过滤。
 */
function normalizeSxjkSellerBlacklist(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue
    const userId = String(x.userId ?? '').trim().slice(0, 256)
    if (!userId || seen.has(userId)) continue
    seen.add(userId)
    const plainUserId = String(x.plainUserId ?? '').trim().slice(0, 256)
    const nick = x.nick != null ? String(x.nick).trim().slice(0, 120) : ''
    let addedAt = x.addedAt != null ? String(x.addedAt).trim().slice(0, 48) : ''
    if (addedAt && !/^\d{4}-\d{2}-\d{2}/.test(addedAt)) addedAt = ''
    const row = { userId }
    if (plainUserId && plainUserId !== userId) row.plainUserId = plainUserId
    if (nick) row.nick = nick
    if (addedAt) row.addedAt = addedAt
    out.push(row)
  }
  return out
}

/**
 * 规范化 dingtalkRobots，并与 dingtalkWebhook/dingtalkSecret（首个机器人）对齐
 * @param {object} merged
 */
function syncDingtalkRobotsAndLegacy(merged) {
  const robots = normalizeDingtalkRobots(merged)
  merged.dingtalkRobots = robots
  if (robots.length) {
    merged.dingtalkWebhook = robots[0].webhook
    merged.dingtalkSecret = robots[0].secret
  } else {
    merged.dingtalkWebhook = ''
    merged.dingtalkSecret = ''
  }
  return merged
}

// 默认配置
const defaultConfig = {
  appName: '咸鱼外卖助手', // 窗口标题栏显示的名称
  configSchemaVersion: CURRENT_CONFIG_SCHEMA_VERSION,
  closeButtonAction: 'tray', // 可选值: 'tray' | 'quit' | 'minimize'
  theme: 'dark', // 可选值: 'dark' | 'light'
  primaryColor: '#f0a020', // 默认主题色（橙）
  layout: 'sidebar', // 可选值: 'sidebar' | 'top'
  autoLaunch: false, // 可选值: true | false
  alwaysOnTop: false, // 可选值: true | false
  enablePrivacyMask: true, // 可选值: true | false
  dingtalkWebhook: '', // 钉钉机器人 Webhook 地址（与 dingtalkRobots[0] 同步，兼容旧逻辑）
  dingtalkSecret: '', // 钉钉机器人加签密钥
  /** 多个钉钉机器人；由各监听任务绑定使用，不再全局随机 */
  dingtalkRobots: [],
  /** 单次轮询中每条钉钉消息最多包含几条上新（1～50，多出的会拆成多条消息发送） */
  dingtalkMaxPushPerBatch: 8,
  /** 钉钉 Markdown 各段落是否推送（与前端 utils/dingtalkPushMarkdown 字段一致） */
  dingtalkPushFields: { ...DEFAULT_DINGTALK_PUSH_FIELDS },
  /** 钉钉推送聚合：multi=多条合并一条；single=一商品一条 */
  dingtalkPushCardMode: 'multi',
  /** 钉钉展示：markdown | actionCard（互动卡片）| link（图文链接，带头图） */
  dingtalkPushDisplayMode: 'markdown',
  /** 全局「包含的关键词」，与任务内字段语义一致，轮询时与任务条件合并后再过滤 */
  sxjkGlobalMatchSub: '',
  /** 全局「排除关键词」 */
  sxjkGlobalExcludeKeywords: '',
  /** 商家黑名单：userId=列表侧标识（多为加密）参与过滤；plainUserId=明文仅展示 */
  sxjkSellerBlacklist: []
}

function normalizeCloseButtonAction(v) {
  return ['tray', 'quit', 'minimize'].includes(v) ? v : 'tray'
}

/**
 * 将合并后的配置写入磁盘（不写读回，避免与 readConfig 循环）
 */
async function writeConfigFile(mergedConfig, configFile) {
  const dingtalkMaxPushPerBatch = Math.min(
    50,
    Math.max(1, Math.floor(Number(mergedConfig.dingtalkMaxPushPerBatch)) || 8)
  )
  const schema = Math.max(
    1,
    Math.floor(Number(mergedConfig.configSchemaVersion)) || CURRENT_CONFIG_SCHEMA_VERSION
  )
  const closeButtonAction = normalizeCloseButtonAction(mergedConfig.closeButtonAction)
  const theme = mergedConfig.theme === 'light' || mergedConfig.theme === 'dark' ? mergedConfig.theme : 'dark'
  const layout = mergedConfig.layout === 'top' || mergedConfig.layout === 'sidebar' ? mergedConfig.layout : 'sidebar'
  const dingtalkPushFields = mergeDingtalkPushFields(mergedConfig.dingtalkPushFields)
  const dingtalkPushCardMode = normalizeDingtalkPushCardMode(mergedConfig.dingtalkPushCardMode)
  const dingtalkSync = syncDingtalkRobotsAndLegacy({ ...mergedConfig })
  const dingtalkRobotsJson = JSON.stringify(dingtalkSync.dingtalkRobots || [])
  const dingtalkWebhookStr = dingtalkSync.dingtalkWebhook || ''
  const dingtalkSecretStr = dingtalkSync.dingtalkSecret || ''
  const dingtalkPushDisplayMode = normalizeDingtalkPushDisplayMode(mergedConfig.dingtalkPushDisplayMode)
  const sxjkGlobalMatchSub = normalizeSxjkGlobalKeywordStr(mergedConfig.sxjkGlobalMatchSub)
  const sxjkGlobalExcludeKeywords = normalizeSxjkGlobalKeywordStr(mergedConfig.sxjkGlobalExcludeKeywords)
  const sxjkSellerBlacklist = normalizeSxjkSellerBlacklist(mergedConfig.sxjkSellerBlacklist)

  const configContent = `// 应用配置文件
export default {
  // 应用名称配置（窗口标题栏显示的名称）
  appName: '${mergedConfig.appName || '咸鱼外卖助手'}', // 窗口标题栏显示的名称
  // 配置结构版本（有该字段后不再自动改关闭行为；旧文件缺省会迁移一次为推荐「收到系统托盘」）
  configSchemaVersion: ${schema},
  // 关闭按钮行为配置
  // 'tray': 点击关闭收到系统托盘，进程继续（托盘右键可退出）
  // 'quit': 点击关闭按钮直接退出应用
  // 'minimize': 点击关闭按钮最小化到任务栏/Dock
  closeButtonAction: '${closeButtonAction}', // 可选值: 'tray' | 'quit' | 'minimize'
  // 主题模式配置
  // 'dark': 深色模式
  // 'light': 浅色模式
  theme: '${theme}', // 可选值: 'dark' | 'light'
  // 主题色配置（主色调）
  // 支持十六进制颜色值，如 '#f0a020'（橙色）、'#2080f0'（蓝色）等
  primaryColor: '${mergedConfig.primaryColor || '#f0a020'}', // 默认橙色
  // 导航布局配置
  // 'sidebar': 左侧菜单
  // 'top': 顶部菜单
  layout: '${layout}', // 可选值: 'sidebar' | 'top'
  // 开机自启动配置
  // true: 系统启动时自动运行应用
  // false: 不自动启动
  autoLaunch: ${!!mergedConfig.autoLaunch}, // 可选值: true | false
  // 窗口置顶配置
  // true: 窗口始终保持在最前面
  // false: 窗口正常显示
  alwaysOnTop: ${!!mergedConfig.alwaysOnTop}, // 可选值: true | false
  // 隐私脱敏配置
  // true: 开启敏感信息脱敏显示（手机号等会显示为 158****3240）
  // false: 关闭脱敏，显示完整信息
  enablePrivacyMask: ${mergedConfig.enablePrivacyMask !== undefined ? !!mergedConfig.enablePrivacyMask : true}, // 可选值: true | false
  // 钉钉机器人配置（可多机器人；推送时随机选一个）
  dingtalkRobots: ${dingtalkRobotsJson},
  // 以下为首个机器人副本，便于兼容仅读取 dingtalkWebhook 的旧代码
  dingtalkWebhook: '${dingtalkWebhookStr.replace(/'/g, "\\'")}', // 钉钉机器人 Webhook 地址
  dingtalkSecret: '${dingtalkSecretStr.replace(/'/g, "\\'")}', // 钉钉机器人加签密钥
  // 每条钉钉消息最多几条上新（1～50）；一次轮询内超出会拆多条消息，避免漏推
  dingtalkMaxPushPerBatch: ${dingtalkMaxPushPerBatch},
  // 钉钉推送聚合：multi=多条上新合并为一条消息；single=每个商品单独一条消息
  dingtalkPushCardMode: '${dingtalkPushCardMode}',
  // 钉钉展示：markdown | actionCard（底部按钮）| link（头图+摘要+跳转）
  dingtalkPushDisplayMode: '${dingtalkPushDisplayMode}',
  // 钉钉推送正文中包含哪些字段（true 为推送该段）
  dingtalkPushFields: ${JSON.stringify(dingtalkPushFields)},
  // 上新监听：全局包含 / 排除关键词（| 分隔；与任务内合并后过滤）
  sxjkGlobalMatchSub: ${JSON.stringify(sxjkGlobalMatchSub)},
  sxjkGlobalExcludeKeywords: ${JSON.stringify(sxjkGlobalExcludeKeywords)},
  sxjkSellerBlacklist: ${JSON.stringify(sxjkSellerBlacklist)}
}
`

  await fs.writeFile(configFile, configContent, 'utf-8')

  return {
    ...mergedConfig,
    ...dingtalkSync,
    dingtalkMaxPushPerBatch,
    configSchemaVersion: schema,
    closeButtonAction,
    theme,
    layout,
    dingtalkPushFields,
    dingtalkPushCardMode,
    dingtalkPushDisplayMode,
    sxjkGlobalMatchSub,
    sxjkGlobalExcludeKeywords,
    sxjkSellerBlacklist
  }
}

/**
 * 读取配置文件
 * @param {string} configFile - 配置文件路径
 */
async function readConfig(configFile) {
  try {
    // 确保配置文件目录存在
    const configDir = dirname(configFile)
    await fs.mkdir(configDir, { recursive: true })
    
    // 尝试读取配置文件
    const content = await fs.readFile(configFile, 'utf-8')
    
    // 使用 eval 或动态导入来解析 ES 模块格式的配置文件
    // 由于配置文件是 ES 模块格式，我们需要提取 export default 的内容
    const match = content.match(/export\s+default\s+({[\s\S]*})/m)
    if (match) {
      // 使用 Function 构造函数来安全地解析对象
      const configObj = new Function('return ' + match[1])()
      let merged = { ...defaultConfig, ...configObj }
      merged.dingtalkPushFields = mergeDingtalkPushFields(merged.dingtalkPushFields)
      // 与 renderer `dingtalkBatchSettings.js` clamp 一致（1～50，默认 8）
      merged.dingtalkMaxPushPerBatch = Math.min(
        50,
        Math.max(1, Math.floor(Number(merged.dingtalkMaxPushPerBatch)) || 8)
      )
      merged.dingtalkPushCardMode = normalizeDingtalkPushCardMode(merged.dingtalkPushCardMode)
      merged.dingtalkPushDisplayMode = normalizeDingtalkPushDisplayMode(merged.dingtalkPushDisplayMode)
      merged.sxjkGlobalMatchSub = normalizeSxjkGlobalKeywordStr(merged.sxjkGlobalMatchSub)
      merged.sxjkGlobalExcludeKeywords = normalizeSxjkGlobalKeywordStr(merged.sxjkGlobalExcludeKeywords)
      merged.sxjkSellerBlacklist = normalizeSxjkSellerBlacklist(merged.sxjkSellerBlacklist)
      delete merged.sxjkSearchProxyFetchApiUrl
      delete merged.sxjkStrongChatEnabled
      delete merged.preventSleep
      syncDingtalkRobotsAndLegacy(merged)
      /** 互动卡片 / 图文链接仅支持单条消息一个商品 */
      if (
        (merged.dingtalkPushDisplayMode === 'actionCard' || merged.dingtalkPushDisplayMode === 'link') &&
        merged.dingtalkPushCardMode === 'multi'
      ) {
        merged.dingtalkPushCardMode = 'single'
        merged = await writeConfigFile(merged, configFile)
      }
      // 旧版 app.js 无 configSchemaVersion：一次性落盘 schema；关闭行为仅把历史默认「quit」升为推荐「tray」，「minimize」保留
      if (!Object.prototype.hasOwnProperty.call(configObj, 'configSchemaVersion')) {
        let closeButtonAction = merged.closeButtonAction
        if (closeButtonAction === 'quit') {
          closeButtonAction = 'tray'
        } else {
          closeButtonAction = normalizeCloseButtonAction(closeButtonAction)
        }
        merged = {
          ...merged,
          closeButtonAction,
          configSchemaVersion: CURRENT_CONFIG_SCHEMA_VERSION
        }
        merged = await writeConfigFile(merged, configFile)
      }
      // 产品改名：把仍写着旧默认名的本机配置升到新名称
      if (String(merged.appName || '').trim() === '闲鱼上新监控') {
        merged = { ...merged, appName: '咸鱼外卖助手' }
        merged = await writeConfigFile(merged, configFile)
      }
      return { ok: true, config: merged }
    }
    
    // 如果解析失败，返回默认配置
    return { ok: true, config: defaultConfig }
  } catch (error) {
    // 如果文件不存在或读取失败，返回默认配置
    if (error.code === 'ENOENT') {
      return { ok: true, config: defaultConfig }
    }
    return { ok: false, error: String(error) }
  }
}

/**
 * 更新配置文件
 * @param {Object} newConfig - 新配置对象
 * @param {string} configFile - 配置文件路径
 */
async function updateConfig(newConfig, configFile) {
  try {
    // 确保配置文件目录存在
    const configDir = dirname(configFile)
    await fs.mkdir(configDir, { recursive: true })
    
    // 读取当前配置
    const currentResult = await readConfig(configFile)
    if (!currentResult.ok) {
      return { ok: false, error: '读取配置失败' }
    }
    
    // 合并配置（确保使用默认配置作为基础，然后合并当前配置，最后应用新配置）
    const mergedConfig = { ...defaultConfig, ...currentResult.config, ...newConfig }

    // 仅更新 webhook/secret 且未带 dingtalkRobots 时，用单条列表覆盖（避免仍沿用磁盘上的多机器人列表）
    if (
      newConfig.dingtalkRobots === undefined &&
      (newConfig.dingtalkWebhook !== undefined || newConfig.dingtalkSecret !== undefined)
    ) {
      const w = String(mergedConfig.dingtalkWebhook ?? '').trim()
      const s = String(mergedConfig.dingtalkSecret ?? '').trim()
      mergedConfig.dingtalkRobots = w ? [{ webhook: w, secret: s, name: '' }] : []
    }

    // 验证配置值
    if (mergedConfig.appName !== undefined && (typeof mergedConfig.appName !== 'string' || mergedConfig.appName.trim() === '')) {
      return { ok: false, error: 'appName 必须是非空字符串' }
    }
    if (
      mergedConfig.closeButtonAction &&
      !['quit', 'minimize', 'tray'].includes(mergedConfig.closeButtonAction)
    ) {
      return { ok: false, error: 'closeButtonAction 必须是 "tray" | "quit" | "minimize"' }
    }
    if (mergedConfig.theme && !['dark', 'light'].includes(mergedConfig.theme)) {
      return { ok: false, error: 'theme 必须是 "dark" 或 "light"' }
    }
    if (mergedConfig.layout && !['sidebar', 'top'].includes(mergedConfig.layout)) {
      return { ok: false, error: 'layout 必须是 "sidebar" 或 "top"' }
    }
    // 验证主题色格式（十六进制颜色值）
    if (mergedConfig.primaryColor && !/^#[0-9A-Fa-f]{6}$/i.test(mergedConfig.primaryColor)) {
      return { ok: false, error: 'primaryColor 必须是有效的十六进制颜色值（如 #f0a020）' }
    }
    if (mergedConfig.autoLaunch !== undefined && typeof mergedConfig.autoLaunch !== 'boolean') {
      return { ok: false, error: 'autoLaunch 必须是布尔值' }
    }
    if (mergedConfig.alwaysOnTop !== undefined && typeof mergedConfig.alwaysOnTop !== 'boolean') {
      return { ok: false, error: 'alwaysOnTop 必须是布尔值' }
    }
    if (mergedConfig.enablePrivacyMask !== undefined && typeof mergedConfig.enablePrivacyMask !== 'boolean') {
      return { ok: false, error: 'enablePrivacyMask 必须是布尔值' }
    }
    if (mergedConfig.dingtalkWebhook !== undefined && typeof mergedConfig.dingtalkWebhook !== 'string') {
      return { ok: false, error: 'dingtalkWebhook 必须是字符串' }
    }
    if (mergedConfig.dingtalkSecret !== undefined && typeof mergedConfig.dingtalkSecret !== 'string') {
      return { ok: false, error: 'dingtalkSecret 必须是字符串' }
    }
    if (mergedConfig.dingtalkRobots !== undefined) {
      if (!Array.isArray(mergedConfig.dingtalkRobots)) {
        return { ok: false, error: 'dingtalkRobots 必须是数组' }
      }
      for (const r of mergedConfig.dingtalkRobots) {
        if (!r || typeof r !== 'object') {
          return { ok: false, error: 'dingtalkRobots 的每一项必须是对象' }
        }
        if (typeof r.webhook !== 'string' || typeof r.secret !== 'string') {
          return { ok: false, error: 'dingtalkRobots 中 webhook、secret 须为字符串' }
        }
        if (r.name !== undefined && typeof r.name !== 'string') {
          return { ok: false, error: 'dingtalkRobots 中 name 须为字符串' }
        }
        if (typeof r.name === 'string' && r.name.length > DINGTALK_ROBOT_NAME_MAX_LEN) {
          r.name = clipDingtalkRobotName(r.name)
        }
      }
    }
    if (mergedConfig.dingtalkMaxPushPerBatch !== undefined) {
      const n = Number(mergedConfig.dingtalkMaxPushPerBatch)
      if (!Number.isFinite(n) || n < 1 || n > 50 || Math.floor(n) !== n) {
        return { ok: false, error: '单次推送条数必须是 1～50 的整数' }
      }
      mergedConfig.dingtalkMaxPushPerBatch = Math.floor(n)
    }
    if (mergedConfig.dingtalkPushFields !== undefined && mergedConfig.dingtalkPushFields !== null) {
      if (typeof mergedConfig.dingtalkPushFields !== 'object') {
        return { ok: false, error: 'dingtalkPushFields 必须是对象' }
      }
    }
    if (mergedConfig.dingtalkPushCardMode !== undefined && mergedConfig.dingtalkPushCardMode !== null) {
      const m = String(mergedConfig.dingtalkPushCardMode).toLowerCase()
      if (m !== 'multi' && m !== 'single') {
        return { ok: false, error: 'dingtalkPushCardMode 必须是 "multi" 或 "single"' }
      }
    }
    if (mergedConfig.dingtalkPushDisplayMode !== undefined && mergedConfig.dingtalkPushDisplayMode !== null) {
      const d = String(mergedConfig.dingtalkPushDisplayMode).toLowerCase()
      if (d !== 'markdown' && d !== 'actioncard' && d !== 'link') {
        return {
          ok: false,
          error: 'dingtalkPushDisplayMode 必须是 "markdown"、"actionCard" 或 "link"'
        }
      }
    }
    if (mergedConfig.sxjkGlobalMatchSub !== undefined && mergedConfig.sxjkGlobalMatchSub !== null) {
      if (typeof mergedConfig.sxjkGlobalMatchSub !== 'string') {
        return { ok: false, error: 'sxjkGlobalMatchSub 必须是字符串' }
      }
    }
    if (mergedConfig.sxjkGlobalExcludeKeywords !== undefined && mergedConfig.sxjkGlobalExcludeKeywords !== null) {
      if (typeof mergedConfig.sxjkGlobalExcludeKeywords !== 'string') {
        return { ok: false, error: 'sxjkGlobalExcludeKeywords 必须是字符串' }
      }
    }
    if (mergedConfig.sxjkSellerBlacklist !== undefined && mergedConfig.sxjkSellerBlacklist !== null) {
      if (!Array.isArray(mergedConfig.sxjkSellerBlacklist)) {
        return { ok: false, error: 'sxjkSellerBlacklist 必须是数组' }
      }
    }
    mergedConfig.dingtalkPushFields = mergeDingtalkPushFields(mergedConfig.dingtalkPushFields)
    mergedConfig.dingtalkPushCardMode = normalizeDingtalkPushCardMode(mergedConfig.dingtalkPushCardMode)
    mergedConfig.dingtalkPushDisplayMode = normalizeDingtalkPushDisplayMode(mergedConfig.dingtalkPushDisplayMode)
    if (mergedConfig.dingtalkPushDisplayMode === 'actionCard' || mergedConfig.dingtalkPushDisplayMode === 'link') {
      mergedConfig.dingtalkPushCardMode = 'single'
    }

    mergedConfig.dingtalkMaxPushPerBatch = Math.min(
      50,
      Math.max(1, Math.floor(Number(mergedConfig.dingtalkMaxPushPerBatch)) || 8)
    )
    mergedConfig.configSchemaVersion =
      mergedConfig.configSchemaVersion ?? CURRENT_CONFIG_SCHEMA_VERSION

    mergedConfig.sxjkGlobalMatchSub = normalizeSxjkGlobalKeywordStr(mergedConfig.sxjkGlobalMatchSub)
    mergedConfig.sxjkGlobalExcludeKeywords = normalizeSxjkGlobalKeywordStr(mergedConfig.sxjkGlobalExcludeKeywords)
    mergedConfig.sxjkSellerBlacklist = normalizeSxjkSellerBlacklist(mergedConfig.sxjkSellerBlacklist)
    delete mergedConfig.sxjkSearchProxyFetchApiUrl
    delete mergedConfig.sxjkStrongChatEnabled
    delete mergedConfig.preventSleep

    const written = await writeConfigFile(mergedConfig, configFile)
    return { ok: true, config: written }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/**
 * 注册应用配置相关的 IPC 处理器
 * @param {import('electron').IpcMain} ipcMain - IPC 主进程对象
 * @param {import('electron').BrowserWindow} win - 窗口对象（可选，用于更新窗口标题）
 * @param {string} configFilePath - 配置文件路径（用户数据目录中的配置文件）
 */
export function registerAppConfigIPC(ipcMain, win = null, configFilePath = null) {
  // 使用传入的配置文件路径，如果没有则使用默认路径
  const configFile = configFilePath || defaultConfigFile
  
  // 读取应用配置
  ipcMain.handle('get-app-config', async () => {
    return await readConfig(configFile)
  })
  
  // 更新应用配置
  ipcMain.handle('update-app-config', async (_, config) => {
    const result = await updateConfig(config, configFile)
    // 如果更新成功且包含 appName，更新窗口标题
    if (result && result.ok && config.appName && win) {
      win.setTitle(formatAppWindowTitle(config.appName))
    }
    return result
  })

  void applyPreventSleep(true)
}


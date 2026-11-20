/**
 * 全程只用 Playwright（API：`chromium.launch` / `context` / `page` / `cookies`）。
 * 未使用系统默认浏览器、未使用 shell 打开外链。
 *
 * 默认优先用 Playwright 内置 Chromium（若已 `playwright install` 或存在项目内 `playwright-browsers`）。
 * 内置失败时再试本机 Chrome/Edge（`channel: 'chrome'|'msedge'`）。需要优先系统浏览器可设：
 * `XIANYU_PLAYWRIGHT_CHANNEL=chrome|msedge|...`
 *
 * 【不是「监听接口」】仅定时 context.cookies() 读 Cookie 罐。
 * 【成功自动关窗】guest：合并串含 _m_h5_tk；account（有界面）：H5 消息页以 Cookie 账号态为准，主站以顶栏昵称为准；account（无头续期）：以 _m_h5_tk 为准。关窗后由调用方写入本地。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { chromium, firefox } from 'playwright'
import { fetchDmProxyPlaywrightSettings } from './xianyu-playwright-dm-proxy.js'
import {
  getGoofishPlaywrightContextOptions,
  applyMonitoringStealth,
  applyGoofishSensorAntiBot
} from './xianyu-playwright-config.js'
import {
  GOOFISH_WINDOW_LOGIN_URL,
  isGoofishWindowLoginPageUrl
} from '../config/goofish.js'
import { inferXianyuAccountLoginFromCookieHeader } from '../lib/xy_sxjk/xianyu-cookie-profile.js'
import {
  GOOFISH_NAV_LOGIN_STATE_JS,
  GOOFISH_NAV_NICKNAME_EXTRACT_JS
} from './goofish-nav-login-state.js'

/** Playwright 支持的 channel 列表（见文档 BrowserType.launch） */
const VALID_CHANNELS = new Set([
  'chrome',
  'msedge',
  'bundled',
  'firefox',
  'qq',
  '360se',
  '360chrome',
  'uc'
])
const LAUNCH_TIMEOUT_MS = 25_000
const EXECUTABLE_SEARCH_BUDGET_MS = 5000
const executablePathCache = new Map()
const executableResolveInfoCache = new Map()

function searchExecutableInRoots(exeNames, roots) {
  const names = new Set((exeNames || []).map((x) => String(x || '').toLowerCase()).filter(Boolean))
  if (names.size === 0) return ''
  const queue = []
  for (const r of roots || []) {
    const root = String(r || '').trim()
    if (root && existsSync(root)) queue.push(root)
  }
  const visited = new Set()
  const start = Date.now()
  while (queue.length > 0 && Date.now() - start < EXECUTABLE_SEARCH_BUDGET_MS) {
    const cur = queue.shift()
    if (!cur || visited.has(cur)) continue
    visited.add(cur)
    let entries = []
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      const full = `${cur}\\${ent.name}`
      if (ent.isFile()) {
        const lower = ent.name.toLowerCase()
        if (names.has(lower)) return full
        continue
      }
      if (!ent.isDirectory()) continue
      try {
        const st = statSync(full)
        if (!st.isDirectory()) continue
      } catch {
        continue
      }
      queue.push(full)
    }
  }
  return ''
}

function resolveExecutableFromRegistry(exeName) {
  if (process.platform !== 'win32') return ''
  const safeExe = String(exeName || '').trim()
  if (!safeExe) return ''
  const keys = [
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${safeExe}`,
    `HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${safeExe}`
  ]
  for (const key of keys) {
    try {
      const out = execSync(`reg query "${key}" /ve`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true
      })
      const m = String(out).match(/REG_SZ\s+([^\r\n]+)/i)
      const p = String(m?.[1] || '').trim()
      if (p && existsSync(p)) return p
    } catch {
      /* 忽略单个键查询失败 */
    }
  }
  return ''
}

function resolveBundledChromiumExecutablePath() {
  if (executablePathCache.has('bundled')) return executablePathCache.get('bundled') || ''
  const browserRoot = String(process.env.PLAYWRIGHT_BROWSERS_PATH || '').trim()
  if (!browserRoot || !existsSync(browserRoot)) {
    executablePathCache.set('bundled', '')
    executableResolveInfoCache.set('bundled', `PLAYWRIGHT_BROWSERS_PATH 不存在：${browserRoot || '(empty)'}`)
    return ''
  }
  let dirs = []
  try {
    dirs = readdirSync(browserRoot, { withFileTypes: true })
  } catch {
    dirs = []
  }
  const chromiumDirs = dirs
    .filter((d) => d?.isDirectory?.() && /^chromium-\d+$/i.test(String(d.name || '')))
    .map((d) => String(d.name || ''))
    .sort((a, b) => Number(b.split('-')[1] || 0) - Number(a.split('-')[1] || 0))
  const platformCandidates =
    process.platform === 'win32'
      ? ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']
      : process.platform === 'darwin'
        ? ['chrome-mac/Chromium.app/Contents/MacOS/Chromium']
        : ['chrome-linux/chrome']
  for (const dir of chromiumDirs) {
    for (const rel of platformCandidates) {
      const full = join(browserRoot, dir, ...rel.split('/'))
      if (existsSync(full)) {
        executablePathCache.set('bundled', full)
        executableResolveInfoCache.set('bundled', `内置浏览器命中：${full}`)
        return full
      }
    }
  }
  executablePathCache.set('bundled', '')
  executableResolveInfoCache.set(
    'bundled',
    `未在 ${browserRoot} 找到 Chromium 可执行文件（已检查 ${platformCandidates.join(', ')}）`
  )
  return ''
}

function resolveCustomExecutablePath(target) {
  if (executablePathCache.has(target)) return executablePathCache.get(target) || ''
  if (target === 'bundled') return resolveBundledChromiumExecutablePath()
  if (process.platform !== 'win32') return ''
  const local = String(process.env.LOCALAPPDATA || '').trim()
  const roaming = String(process.env.APPDATA || '').trim()
  const pf = String(process.env.ProgramFiles || '').trim()
  const pfx86 = String(process.env['ProgramFiles(x86)'] || '').trim()
  /** @type {Record<string, string[]>} */
  const candidates = {
    qq: [
      `${local}\\Tencent\\QQBrowser\\Application\\QQBrowser.exe`,
      `${pf}\\Tencent\\QQBrowser\\Application\\QQBrowser.exe`,
      `${pfx86}\\Tencent\\QQBrowser\\Application\\QQBrowser.exe`
    ],
    '360se': [
      `${pf}\\360\\360se6\\Application\\360se.exe`,
      `${pfx86}\\360\\360se6\\Application\\360se.exe`
    ],
    '360chrome': [
      `${pf}\\360\\360Chrome\\Chrome\\Application\\360chrome.exe`,
      `${pfx86}\\360\\360Chrome\\Chrome\\Application\\360chrome.exe`
    ],
    uc: [
      `${local}\\UCBrowser\\Application\\UCBrowser.exe`,
      `${pf}\\UCBrowser\\Application\\UCBrowser.exe`,
      `${pfx86}\\UCBrowser\\Application\\UCBrowser.exe`
    ]
  }
  const arr = candidates[target] || []
  for (const p of arr) {
    if (p && existsSync(p)) {
      executablePathCache.set(target, p)
      executableResolveInfoCache.set(target, `固定路径命中：${p}`)
      return p
    }
  }
  const envKeyByTarget = {
    qq: 'XIANYU_BROWSER_PATH_QQ',
    '360se': 'XIANYU_BROWSER_PATH_360SE',
    '360chrome': 'XIANYU_BROWSER_PATH_360CHROME',
    uc: 'XIANYU_BROWSER_PATH_UC'
  }
  const envKey = envKeyByTarget[target]
  if (envKey) {
    const envPath = String(process.env[envKey] || '').trim()
    if (envPath && existsSync(envPath)) {
      executablePathCache.set(target, envPath)
      executableResolveInfoCache.set(target, `环境变量 ${envKey} 命中：${envPath}`)
      return envPath
    }
  }
  const exeNameByTarget = {
    qq: 'QQBrowser.exe',
    '360se': '360se.exe',
    '360chrome': '360chrome.exe',
    uc: 'UCBrowser.exe'
  }
  const registryHit = resolveExecutableFromRegistry(exeNameByTarget[target] || '')
  if (registryHit) {
    executablePathCache.set(target, registryHit)
    executableResolveInfoCache.set(target, `注册表命中：${registryHit}`)
    return registryHit
  }
  const exeNamesByTarget = {
    qq: ['QQBrowser.exe'],
    '360se': ['360se.exe'],
    '360chrome': ['360chrome.exe'],
    uc: ['UCBrowser.exe', 'ucbrowser.exe']
  }
  const rootsByTarget = {
    qq: [`${local}\\Tencent`, `${roaming}\\Tencent`, `${pf}\\Tencent`, `${pfx86}\\Tencent`],
    '360se': [`${pf}\\360`, `${pfx86}\\360`, `${local}\\360`, `${roaming}\\360`],
    '360chrome': [`${pf}\\360`, `${pfx86}\\360`, `${local}\\360`, `${roaming}\\360`],
    uc: [`${local}\\UCBrowser`, `${roaming}\\UCBrowser`, `${pf}\\UCBrowser`, `${pfx86}\\UCBrowser`]
  }
  const found = searchExecutableInRoots(exeNamesByTarget[target] || [], rootsByTarget[target] || [])
  if (found) {
    executablePathCache.set(target, found)
    executableResolveInfoCache.set(target, `递归搜索命中：${found}`)
    return found
  }
  executablePathCache.set(target, '')
  executableResolveInfoCache.set(
    target,
    `未找到可执行文件。已搜索根目录：${(rootsByTarget[target] || []).filter(Boolean).join(' | ')}`
  )
  return ''
}

/**
 * @param {import('playwright').ProxySettings | null | undefined} proxySettings 账号登录浏览器：大麦动态代理
 * @param {{ devtools?: boolean }} [launchOpts]
 */
function createPlaywrightLaunchTask(target, headless, proxySettings, launchOpts = {}) {
  const proxyLaunch = proxySettings?.server ? { proxy: proxySettings } : {}
  const devtools = launchOpts.devtools === true && !headless
  if (target === 'firefox') return firefox.launch({ headless, devtools, ...proxyLaunch })
  const executablePath = resolveCustomExecutablePath(target)
  if (executablePath) {
    return chromium.launch({ headless, devtools, executablePath, ...proxyLaunch })
  }
  return chromium.launch({
    headless,
    devtools,
    ...(target && target !== 'bundled' ? { channel: target } : {}),
    ...proxyLaunch
  })
}

async function probePlaywrightLaunch(target) {
  const launchTask = createPlaywrightLaunchTask(target, true)
  const timeoutTask = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`启动超时（>${LAUNCH_TIMEOUT_MS}ms）`)), LAUNCH_TIMEOUT_MS)
  )
  const browser = await Promise.race([launchTask, timeoutTask])
  try {
    await browser.close().catch(() => {})
  } catch {
    /* */
  }
}

/**
 * 仅用 Playwright 启动浏览器：默认先试内置 Chromium，再试本机 Chrome / Edge 等。
 * @param {{ headless?: boolean, preferredBrowser?: string, preferredChannel?: string, bundledOnly?: boolean, devtools?: boolean }} [opts] 定时续期等场景可 headless: true；bundledOnly 为 true 时仅用项目内 playwright-browsers
 */
async function launchBrowserWithPlaywrightOnly(opts = {}) {
  const headless = opts.headless === true
  const devtools = opts.devtools === true
  /** 一键登录 / Playwright 采集：写死大麦提取链接，失败则直连 */
  let proxySettings = null
  try {
    proxySettings = await fetchDmProxyPlaywrightSettings()
    if (proxySettings?.server) {
      console.log('[浏览器自动化] 使用大麦动态代理', proxySettings.server)
    }
  } catch (e) {
    console.warn('[浏览器自动化] 动态代理获取失败，直连', e?.message || e)
  }

  const preferredChannel = String(opts.preferredBrowser || opts.preferredChannel || '')
    .trim()
    .toLowerCase()
  const fromEnv = String(process.env.XIANYU_PLAYWRIGHT_CHANNEL || '')
    .trim()
    .toLowerCase()
  const bundledOnly = opts.bundledOnly === true
  const order = []
  if (preferredChannel && VALID_CHANNELS.has(preferredChannel)) order.push(preferredChannel)
  if (!bundledOnly) {
    if (fromEnv && VALID_CHANNELS.has(fromEnv)) order.push(fromEnv)
    if (!order.includes('bundled')) order.push('bundled')
    if (!order.includes('chrome')) order.push('chrome')
    if (!order.includes('msedge')) order.push('msedge')
    if (!order.includes('firefox')) order.push('firefox')
  } else if (!order.length) {
    order.push('bundled')
  }

  const launchErrors = []
  for (const target of order) {
    try {
      const launchTask = createPlaywrightLaunchTask(target, headless, proxySettings, { devtools })
      const timeoutTask = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`启动超时（>${LAUNCH_TIMEOUT_MS}ms）`)), LAUNCH_TIMEOUT_MS)
      )
      const browser = await Promise.race([launchTask, timeoutTask])
      return browser
    } catch (e) {
      const msg = String(e?.message || e)
      launchErrors.push({ target, msg })
      console.warn('[浏览器自动化] browser.launch', target, msg)
    }
  }
  const failedTargets = launchErrors.map((x) => x.target)
  const missingChrome = failedTargets.includes('chrome')
  const missingEdge = failedTargets.includes('msedge')
  const missingBundled = failedTargets.includes('bundled')
  const missingFirefox = failedTargets.includes('firefox')
  const missingQQ = failedTargets.includes('qq')
  const missing360Se = failedTargets.includes('360se')
  const missing360Chrome = failedTargets.includes('360chrome')
  const missingUC = failedTargets.includes('uc')
  const likelyNoSystemBrowser =
    missingChrome && missingEdge && missingFirefox && missingQQ && missing360Se && missing360Chrome && missingUC
  const likelyNoBundledBrowser = missingBundled
  if (bundledOnly && likelyNoBundledBrowser) {
    const detail = launchErrors.map((x) => `[${x.target}] ${x.msg}`).join('\n')
    throw new Error(
      `内置 Chromium 不可用。请在项目目录执行：npm install（会自动下载到 playwright-browsers），或手动执行：cross-env PLAYWRIGHT_BROWSERS_PATH=playwright-browsers npx playwright install chromium\n\n启动日志：\n${detail}`
    )
  }
  if (likelyNoSystemBrowser && likelyNoBundledBrowser) {
    const detail = launchErrors.map((x) => `[${x.target}] ${x.msg}`).join('\n')
    throw new Error(
      `未检测到可用浏览器：系统未安装 Chrome/Edge/Firefox/QQ/360/UC，且 Playwright 内置 Chromium 也不可用。\n请在项目目录执行：npx playwright install chromium\n\n启动日志：\n${detail}`
    )
  }
  const detail = launchErrors.map((x) => `[${x.target}] ${x.msg}`).join('\n')
  throw new Error(`Playwright 无法启动浏览器。\n\n启动日志：\n${detail}`)
}

/**
 * 仅用于账号弹窗展示：检测常见浏览器通道是否可启动。
 */
export async function detectPlaywrightBrowserEnvironment() {
  /** @type {Record<string, {ok:boolean,msg:string}>} */
  const channels = {}
  const targets = /** @type {const} */ ([
    'bundled',
    'chrome',
    'msedge',
    'firefox',
    'qq',
    '360se',
    '360chrome',
    'uc'
  ])
  for (const target of targets) {
    try {
      await probePlaywrightLaunch(target)
      channels[target] = { ok: true, msg: '可用' }
    } catch (e) {
      const info = executableResolveInfoCache.get(target)
      const msg = String(e?.message || e).slice(0, 280)
      channels[target] = {
        ok: false,
        msg: info ? `${msg}；${info}` : msg
      }
    }
  }
  const anyUsable = Object.values(channels).some((x) => x.ok)
  const recommended = channels.chrome?.ok
    ? 'chrome'
    : channels.msedge?.ok
      ? 'msedge'
      : channels.firefox?.ok
        ? 'firefox'
        : channels.qq?.ok
          ? 'qq'
          : channels['360se']?.ok
            ? '360se'
            : channels['360chrome']?.ok
              ? '360chrome'
              : channels.uc?.ok
                ? 'uc'
        : channels.bundled?.ok
          ? 'bundled'
          : 'none'
  const hint = anyUsable
    ? recommended === 'bundled'
      ? '当前将使用 Playwright 内置 Chromium；建议安装 Chrome、Edge、Firefox、QQ、360 或 UC 以提升稳定性。'
      : `当前优先使用 ${recommended}。`
    : '未检测到可用浏览器。请先安装 Chrome、Edge、Firefox、QQ、360 或 UC，或在项目目录执行：npx playwright install chromium'
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    channels,
    summary: { anyUsable, recommended, hint }
  }
}

const GOOFISH_URLS = [
  'https://www.goofish.com',
  'https://goofish.com',
  'https://h5api.m.goofish.com'
]

/**
 * 多账号可同时各开一个 Playwright Chromium；key 为账号 id，无账号时共用 `__global__`。
 * 同一 key 再次「打开闲鱼」会先关掉该 key 已有窗口再新开（不影响其它 key）。
 */
const goofishBrowseBrowsers = new Map()

function closeGoofishBrowseByKey(key) {
  const b = goofishBrowseBrowsers.get(key)
  if (!b) return
  goofishBrowseBrowsers.delete(key)
  try {
    b.removeAllListeners('disconnected')
  } catch {
    /* */
  }
  b.close().catch(() => {})
}

/** 应用退出时关闭所有「打开闲鱼」遗留的 Playwright 窗口（采集流程内会自行关窗） */
export function closeDetachedPlaywrightBrowserIfAny() {
  for (const k of [...goofishBrowseBrowsers.keys()]) {
    closeGoofishBrowseByKey(k)
  }
}

function headerHasMh5Tk(header) {
  return /(?:^|;\s*)_m_h5_tk=/i.test(String(header || ''))
}

/**
 * 从首页顶栏「个人」入口读取闲鱼昵称（class 为 CSS Modules，用 [class*="nick--"] 匹配）。
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
export async function tryExtractGoofishNicknameFromPage(page) {
  if (!page || page.isClosed()) return ''
  try {
    const raw = await page.evaluate(GOOFISH_NAV_NICKNAME_EXTRACT_JS)
    return String(raw || '')
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 64)
  } catch {
    return ''
  }
}

/**
 * 顶栏 user-order-container：昵称为「登录」视为未登录；非空且非「登录」视为已登录（与 CSS Modules 兼容）。
 * @param {import('playwright').Page} page
 * @returns {Promise<{ loggedIn: boolean, nick: string, reason: string }>}
 */
export async function readGoofishNavLoginStateFromPage(page) {
  if (!page || page.isClosed()) return { loggedIn: false, nick: '', reason: 'no_page' }
  try {
    const raw = await page.evaluate(GOOFISH_NAV_LOGIN_STATE_JS)
    if (!raw || typeof raw !== 'object') {
      return { loggedIn: false, nick: '', reason: 'bad_result' }
    }
    return {
      loggedIn: raw.loggedIn === true,
      nick: String(raw.nick || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 64),
      reason: String(raw.reason || '')
    }
  } catch {
    return { loggedIn: false, nick: '', reason: 'evaluate_error' }
  }
}

/** 用户关掉窗口或浏览器已断开时，不能再静默吞掉，否则轮询会空转直到超时、界面一直 loading */
function isBrowserOrContextClosedError(e) {
  const msg = String(e?.message || e)
  return (
    e?.name === 'BrowserClosedError' ||
    /has been closed|Target page|Browser closed|Connection closed|ECONNRESET/i.test(msg)
  )
}

/** @type {() => void} */
let goofishPlaywrightCaptureDisconnectNotifier = () => {}

/**
 * IPC：游览器采集窗口被用户关闭时立即通知渲染进程（不等 invoke 收尾）。
 * 仅应在注册闲鱼 IPC 时调用一次。
 */
export function registerGoofishPlaywrightCaptureDisconnectNotifier(fn) {
  goofishPlaywrightCaptureDisconnectNotifier = typeof fn === 'function' ? fn : () => {}
}

/**
 * 与浏览器断开竞速：`page.goto`/`reload` 在用户关窗后有时卡住很久才 reject，
 * 渲染进程一直等 invoke。
 */
async function raceAgainstBrowserDisconnect(browser, promise) {
  /** @type {() => void} */
  let onDisconnect = () => {}
  const disconnectRace = new Promise((_, reject) => {
    onDisconnect = () => {
      const err = new Error('Browser closed')
      err.name = 'BrowserClosedError'
      reject(err)
    }
    browser.once('disconnected', onDisconnect)
  })
  try {
    return await Promise.race([promise, disconnectRace])
  } finally {
    try {
      browser.off('disconnected', onDisconnect)
    } catch {
      /* */
    }
  }
}

/** 与 Playwright 采集一致：用整罐 Cookie 拼请求头（含淘宝系子域），供 MTOP 使用 */
export function cookiesArrayToHeader(list) {
  const map = new Map()
  for (const c of list || []) {
    if (c?.name) map.set(c.name, c.value ?? '')
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

async function cookiesToHeaderFromContext(context) {
  const list = await context.cookies()
  return cookiesArrayToHeader(list)
}

/** 从磁盘恢复的 Cookie 对象只保留 addCookies 接受的字段 */
function normalizeStoredCookieForPlaywright(c) {
  if (!c || !c.name) return null
  const o = {
    name: String(c.name),
    value: String(c.value ?? ''),
    domain: String(c.domain || '.goofish.com'),
    path: String(c.path || '/')
  }
  const exp = c.expires
  if (typeof exp === 'number' && exp > 0) o.expires = exp
  if (typeof c.httpOnly === 'boolean') o.httpOnly = c.httpOnly
  if (typeof c.secure === 'boolean') o.secure = c.secure
  if (c.sameSite) o.sameSite = c.sameSite
  return o
}

/** 旧版仅保存 Cookie 串时的兜底：只能保证 goofish 主域，淘宝系会话可能仍不完整 */
function syntheticCookiesFromHeader(header) {
  const pairs = []
  const s = String(header || '').trim()
  if (!s) return pairs
  for (const part of s.split(';')) {
    const p = part.trim()
    if (!p) continue
    const eq = p.indexOf('=')
    if (eq <= 0) continue
    const name = p.slice(0, eq).trim()
    const value = p.slice(eq + 1).trim()
    if (name) pairs.push({ name, value })
  }
  return pairs.map(({ name, value }) => ({
    name,
    value,
    domain: '.goofish.com',
    path: '/',
    secure: true,
    sameSite: 'Lax'
  }))
}

/** 新一次「游客/账号登录采集」会关闭上一实例的浏览器，避免主进程用 busy 直接拒绝导致前端连点堆 Toast */
let mtopCaptureGeneration = 0
let mtopCaptureBrowserRef = null
let mtopCaptureBusy = false

export function isGoofishMtopCaptureBusy() {
  return mtopCaptureBusy
}

async function abortOngoingMtopCaptureBrowserForNewRequest() {
  const b = mtopCaptureBrowserRef
  mtopCaptureBrowserRef = null
  if (!b) return
  try {
    await b.close()
  } catch {
    /* */
  }
}

/**
 * 弹出非无头 Chromium，用户登录闲鱼后轮询 Cookie，直到满足结束条件或超时。
 * @param {{ timeoutMs?: number, mode?: 'guest' | 'account', playwrightCookies?: import('playwright').Cookie[], cookieHeader?: string, headless?: boolean, preferredBrowser?: string, preferredChannel?: string, bundledOnly?: boolean }} [opts]
 * - guest：出现 _m_h5_tk 即成功关窗
 * - account：有界面时以页面可读到的真实昵称为准；无头（续期）以 _m_h5_tk 为准
 * - playwrightCookies / cookieHeader：可选，先注入再进首页（用于「重新登录」带旧会话续期）
 * - headless：为 true 时不显示窗口（定时续期用；若站点拦截无头可设环境变量改回有头）
 * - preferredBrowser / preferredChannel：与 launch 一致（如 msedge、chrome）；二者任填其一即可
 */
export async function captureGoofishMtopCookiesFromPlaywright({
  timeoutMs = 900_000,
  mode = 'guest',
  playwrightCookies: injectPlaywrightCookies = null,
  cookieHeader: injectCookieHeader = '',
  headless = false,
  allowConcurrent = false,
  batchQuickLogin = false,
  preferredBrowser = '',
  preferredChannel: preferredChannelOpt = '',
  bundledOnly = false
} = {}) {
  const preferredChannel = String(preferredBrowser || preferredChannelOpt || '')
    .trim()
    .toLowerCase()
  const concurrent = allowConcurrent === true
  const myGen = concurrent ? mtopCaptureGeneration : ++mtopCaptureGeneration
  if (!concurrent) {
    await abortOngoingMtopCaptureBrowserForNewRequest()
    mtopCaptureBusy = true
  }
  try {
    return await captureGoofishMtopCookiesFromPlaywrightImpl(
      {
        timeoutMs,
        mode,
        playwrightCookies: injectPlaywrightCookies,
        cookieHeader: injectCookieHeader,
        headless,
        preferredChannel,
        bundledOnly: bundledOnly === true,
        allowConcurrent: concurrent,
        batchQuickLogin: batchQuickLogin === true
      },
      myGen
    )
  } finally {
    if (!concurrent && myGen === mtopCaptureGeneration) {
      mtopCaptureBusy = false
    }
  }
}

async function captureGoofishMtopCookiesFromPlaywrightImpl(
  {
    timeoutMs = 900_000,
    mode = 'guest',
    playwrightCookies: injectPlaywrightCookies = null,
    cookieHeader: injectCookieHeader = '',
    headless = false,
    preferredChannel = '',
    bundledOnly = false,
    allowConcurrent = false,
    batchQuickLogin = false
  },
  myGen
) {
  const isAccount = mode === 'account'
  const quickBatch = batchQuickLogin === true
  const navTimeoutMs = quickBatch ? 20_000 : 120_000
  const postInjectSettleMs = quickBatch ? 350 : 2000
  const pollIntervalMs = quickBatch ? 350 : 1500
  let browser
  let context
  try {
    browser = await launchBrowserWithPlaywrightOnly({
      headless,
      preferredBrowser: preferredChannel,
      preferredChannel,
      bundledOnly
    })
    if (!allowConcurrent && myGen !== mtopCaptureGeneration) {
      await browser.close().catch(() => {})
      return { ok: false, error: '已取消' }
    }
    if (!allowConcurrent) mtopCaptureBrowserRef = browser
    let userClosedBrowser = false
    browser.on('disconnected', () => {
      userClosedBrowser = true
      /** 用户关窗后主进程 invoke 可能仍在收尾；立刻通知渲染进程收起等待态 */
      try {
        goofishPlaywrightCaptureDisconnectNotifier()
      } catch {
        /* */
      }
    })
    context = await browser.newContext(
      getGoofishPlaywrightContextOptions({
        headless,
        overrides: { viewport: { width: 1280, height: 800 } }
      })
    )
    await applyGoofishSensorAntiBot(context)
    await applyMonitoringStealth(context)
    let toInject = Array.isArray(injectPlaywrightCookies)
      ? injectPlaywrightCookies.map(normalizeStoredCookieForPlaywright).filter(Boolean)
      : []
    if (!toInject.length && String(injectCookieHeader || '').trim()) {
      toInject = syntheticCookiesFromHeader(String(injectCookieHeader).trim())
    }
    if (toInject.length) {
      try {
        await context.addCookies(toInject)
      } catch (e) {
        console.warn('[浏览器自动化] capture: 注入旧 Cookie 失败，将冷启动', e?.message || e)
      }
    }
    const page = await context.newPage()
    const captureStartUrl = GOOFISH_WINDOW_LOGIN_URL
    await raceAgainstBrowserDisconnect(
      browser,
      page.goto(captureStartUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs })
    )
    /**
     * 注入旧 Cookie 时：首屏即可从罐里读出 _m_h5_tk，原逻辑会立刻 return，
     * 页面几乎未与服务器完成一轮请求，合并串与磁盘一致（用户误以为「续期没变」）。
     * 与「重新登录」对齐：先整页 reload，让站点有机会下发 Set-Cookie，再进入轮询。
     * 冷启动（无注入）不 reload，避免拖慢首次扫码登录。
     */
    if (toInject.length) {
      try {
        await raceAgainstBrowserDisconnect(
          browser,
          page.reload({ waitUntil: 'domcontentloaded', timeout: navTimeoutMs })
        )
      } catch (e) {
        if (isBrowserOrContextClosedError(e)) throw e
        console.warn('[浏览器自动化] capture: inject 后 reload 失败，继续轮询', e?.message || e)
      }
      await new Promise((r) => setTimeout(r, postInjectSettleMs))
    }
    const pollBudgetMs = Math.max(500, Number(timeoutMs) || 0)
    const deadline = Date.now() + pollBudgetMs
    const closedMsg =
      '已关闭浏览器窗口。如需继续请重新发起游客授权或账号登录。'
    while (Date.now() < deadline) {
      if (userClosedBrowser) {
        await context.close().catch(() => {})
        await browser.close().catch(() => {})
        return { ok: false, error: closedMsg }
      }
      let raw
      try {
        raw = await cookiesToHeaderFromContext(context)
      } catch (e) {
        if (userClosedBrowser || isBrowserOrContextClosedError(e)) {
          await context.close().catch(() => {})
          await browser.close().catch(() => {})
          return { ok: false, error: closedMsg }
        }
        throw e
      }
      const hasMh5Tk = headerHasMh5Tk(raw)
      let navLoggedIn = !isAccount
      let navNick = ''
      if (isAccount && page && !page.isClosed()) {
        let pageUrl = captureStartUrl
        try {
          pageUrl = page.url()
        } catch {
          /* */
        }
        if (isGoofishWindowLoginPageUrl(pageUrl)) {
          const prof = inferXianyuAccountLoginFromCookieHeader(raw)
          navLoggedIn = hasMh5Tk && prof.accountLoggedIn
        } else {
          const st = await readGoofishNavLoginStateFromPage(page)
          let nick = String(st.nick || '')
            .trim()
            .replace(/\s+/g, ' ')
          if (!nick || nick === '登录') {
            nick = (await tryExtractGoofishNicknameFromPage(page)).trim().replace(/\s+/g, ' ')
          }
          if (nick && nick !== '登录') {
            navLoggedIn = true
            navNick = nick.slice(0, 64)
          } else {
            navLoggedIn = false
            navNick = ''
          }
        }
      }
      const cookieAccountOk = hasMh5Tk
      // 有界面账号登录：以可读到的真实昵称为准；无头续期仍依赖 Cookie，避免 headless 下顶栏不可用。
      const accountDone = headless ? cookieAccountOk : navLoggedIn
      const done = isAccount ? accountDone : hasMh5Tk
      if (done) {
        let goofishNickname = ''
        if (isAccount) {
          await new Promise((r) => setTimeout(r, 450))
          goofishNickname = navNick || (await tryExtractGoofishNicknameFromPage(page))
          if (!goofishNickname) {
            await new Promise((r) => setTimeout(r, 800))
            goofishNickname = await tryExtractGoofishNicknameFromPage(page)
          }
        }
        const playwrightCookies = await context.cookies()
        const mergedHeader = cookiesArrayToHeader(playwrightCookies)
        await context.close().catch(() => {})
        await browser.close().catch(() => {})
        return {
          ok: true,
          cookieHeader: mergedHeader,
          playwrightCookies,
          goofishNickname
        }
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs))
    }

    await context.close().catch(() => {})
    await browser.close().catch(() => {})
    if (quickBatch) {
      return {
        ok: false,
        error: `${Math.round(pollBudgetMs / 1000)}秒内未检测到已登录，已自动关闭窗口，未保存凭证`
      }
    }
    return {
      ok: false,
      error: isAccount
        ? headless
          ? '超时：无头续期未检测到 _m_h5_tk。若无法启动浏览器，可执行：npx playwright install chromium'
          : '超时：未能从页面读取到闲鱼昵称（顶栏仍显示「登录」或未加载完成）。请在窗口中完成登录并等待显示昵称。若无法启动浏览器，可执行：npx playwright install chromium'
        : '超时：未检测到 _m_h5_tk。请在弹出的浏览器窗口中完成闲鱼登录后再试。若无法启动浏览器，可执行：npx playwright install chromium'
    }
  } catch (e) {
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
    const closedBrowserMsg =
      '已关闭浏览器窗口。如需继续请重新发起游客授权或账号登录。'
    if (isBrowserOrContextClosedError(e)) {
      return { ok: false, error: closedBrowserMsg }
    }
    return { ok: false, error: String(e?.message || e) }
  } finally {
    if (!allowConcurrent && mtopCaptureBrowserRef === browser) {
      mtopCaptureBrowserRef = null
    }
  }
}

/**
 * 用 Playwright 打开闲鱼页面（与登录同一 Chromium 渠道），先注入完整 Cookie 再导航。
 * 不再使用 Electron BrowserWindow + cookies.set：与 Playwright 会话不兼容，易出现「已登录却显示未登录」。
 *
 * @param {{ url: string, playwrightCookies?: import('playwright').Cookie[], cookieHeader?: string, browserKey?: string, preferredBrowser?: string, preferredChannel?: string, bundledOnly?: boolean, openDevTools?: boolean, onContextClosed?: (snap: { playwrightCookies: import('playwright').Cookie[], cookieHeader: string }) => void | Promise<void> }} opts browserKey：账号 id 各开独立浏览器；缺省为 `__global__`（推送日志等）。
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function openGoofishWithPlaywright({
  url,
  playwrightCookies,
  cookieHeader,
  browserKey,
  preferredBrowser = '',
  preferredChannel = '',
  bundledOnly = false,
  openDevTools = false,
  onContextClosed
}) {
  const key = String(browserKey ?? '').trim() || '__global__'
  closeGoofishBrowseByKey(key)

  let cookies = Array.isArray(playwrightCookies)
    ? playwrightCookies.map(normalizeStoredCookieForPlaywright).filter(Boolean)
    : []
  if (!cookies.length && cookieHeader) {
    cookies = syntheticCookiesFromHeader(cookieHeader)
  }
  if (!cookies.length) {
    return { ok: false, error: '没有可恢复的 Cookie，请重新用本页「添加咸鱼账号」保存一次。' }
  }

  let browser
  try {
    browser = await launchBrowserWithPlaywrightOnly({
      preferredBrowser,
      preferredChannel,
      bundledOnly,
      devtools: openDevTools === true
    })
    const context = await browser.newContext(
      getGoofishPlaywrightContextOptions({
        headless: false,
        overrides: { viewport: { width: 1280, height: 800 } }
      })
    )
    if (typeof onContextClosed === 'function') {
      context.on('close', () => {
        void (async () => {
          try {
            const freshCookies = await context.cookies()
            const mergedHeader = cookiesArrayToHeader(freshCookies)
            await onContextClosed({
              playwrightCookies: freshCookies,
              cookieHeader: mergedHeader
            })
          } catch (e) {
            console.warn('[浏览器自动化] 闲鱼浏览窗关窗写回跳过', e?.message || e)
          }
        })()
      })
    }
    await applyGoofishSensorAntiBot(context)
    await applyMonitoringStealth(context)
    await context.addCookies(cookies)
    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    goofishBrowseBrowsers.set(key, browser)
    browser.on('disconnected', () => {
      if (goofishBrowseBrowsers.get(key) === browser) goofishBrowseBrowsers.delete(key)
    })
  } catch (e) {
    await browser?.close().catch(() => {})
    const msg = String(e?.message || e)
    return {
      ok: false,
      error:
        msg.includes('Executable doesn') || msg.includes('browserType.launch')
          ? `${msg}\n若首次使用，请在项目目录执行：npx playwright install chromium`
          : msg
    }
  }
  return { ok: true }
}

/** 与推送日志 `goofishCreateOrderUrl`、网页「立即购买」、秒拍应用内窗口一致 */
const GOOFISH_CREATE_ORDER_SPM = 'a21ybx.im.head.2.47784f10cuSj2x'

export function buildGoofishCreateOrderUrl(itemId) {
  const id = String(itemId || '').trim()
  if (!id) return ''
  const q = new URLSearchParams()
  q.set('spm', GOOFISH_CREATE_ORDER_SPM)
  q.set('itemId', id)
  return `https://www.goofish.com/create-order?${q.toString()}`
}

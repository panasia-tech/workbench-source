// 桌面端代码热更新：清单驱动，逐文件下载 + MD5 校验，整目录原子落位，重启生效。
//
// 与 groupcontrol-desktop 的 desktop-code 机制同源：安装包入口 loader.js 永不变，
// 优先加载 userData/code/main/index.js。所以发新版只要把 out/ 传到静态目录 +
// 更新清单，客户端下载后重启即换新，不用重打 dmg（也就绕开了 macOS 未签名
// 应用没法走 Squirrel 自动更新这件事）。
//
// 网络与文件系统之外的判断都放在纯函数里（manifest 解析、版本比较、路径校验），
// 便于离线回归覆盖，不需要真服务器。
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'

export const CODE_VERSION_URL = 'http://127.0.0.1:8000'
export const CODE_BASE_URL = CODE_VERSION_URL.replace(/\/[^/]*$/, '/')
const DOWNLOAD_TIMEOUT_MS = 60_000
const MANIFEST_TIMEOUT_MS = 15_000
const MAX_FILES = 500
const MAX_TOTAL_BYTES = 200 * 1024 * 1024

function text(value) {
  return String(value ?? '').trim()
}

/**
 * 清单里的相对路径来自服务器，必须当成不可信输入校验。
 * 只允许普通相对路径：不得绝对、不得含 `..`、不得带盘符或反斜杠——
 * 否则一份被改过的清单就能往 userData 之外写文件。
 */
export function assertSafeRelPath(rel) {
  const value = text(rel)
  if (!value) throw new Error('代码清单里有空路径')
  if (value.length > 200) throw new Error(`代码清单路径过长：${value.slice(0, 40)}…`)
  if (value.includes('\\')) throw new Error(`代码清单路径不能含反斜杠：${value}`)
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) throw new Error(`代码清单路径不能是绝对路径：${value}`)
  if (value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`代码清单路径不合法：${value}`)
  }
  return value
}

/** 解析并校验远端清单；任何缺字段都直接拒绝，不做「尽力而为」的猜测。 */
export function parseCodeManifest(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (!data || typeof data !== 'object') throw new Error('代码清单不是对象')
  const codeVersion = Number(data.codeVersion)
  if (!Number.isInteger(codeVersion) || codeVersion <= 0) throw new Error('代码清单缺少 codeVersion')
  const versionName = text(data.versionName)
  if (!versionName) throw new Error('代码清单缺少 versionName')
  const entries = Object.entries(data.files || {})
  if (!entries.length) throw new Error('代码清单没有文件')
  if (entries.length > MAX_FILES) throw new Error(`代码清单文件数超过上限 ${MAX_FILES}`)
  const files = {}
  for (const [rel, md5] of entries) {
    const safe = assertSafeRelPath(rel)
    const digest = text(md5).toLowerCase()
    if (!/^[0-9a-f]{32}$/.test(digest)) throw new Error(`${safe} 缺少合法 MD5`)
    files[safe] = digest
  }
  return { versionName, codeVersion, files, notes: text(data.notes), minAppVersion: text(data.minAppVersion) }
}

/**
 * 是否该升级。只认 codeVersion 严格变大：versionName 只是给人看的，
 * 用它比较会在 0.2.10 vs 0.2.9 这种地方出错。
 */
export function shouldUpdate(current, latest) {
  return Number(latest?.codeVersion || 0) > Number(current?.codeVersion || 0)
}

/** 正在运行的代码版本：热更新副本优先，其次安装包内置。 */
export function readCurrentVersion({ userDataDir, appDir }) {
  for (const file of [join(userDataDir, 'code', 'code-version.json'), join(appDir, 'code-version.json')]) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return { versionName: text(parsed.versionName) || '?', codeVersion: Number(parsed.codeVersion) || 0 }
    } catch { /* 试下一个 */ }
  }
  return { versionName: '?', codeVersion: 0 }
}

async function fetchBuffer(url, timeoutMs, fetchImpl) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return Buffer.from(await response.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchManifest({ fetchImpl = fetch, url = CODE_VERSION_URL, timeoutMs = MANIFEST_TIMEOUT_MS } = {}) {
  const buf = await fetchBuffer(url, timeoutMs, fetchImpl)
  return parseCodeManifest(buf.toString('utf8'))
}

/**
 * 下载整份新代码到暂存目录，全部校验通过后才替换正式目录。
 *
 * 半份代码比旧代码更糟：main 是新的、renderer 还是旧的，症状会非常难查。
 * 所以先落 code-tmp，全绿再一次性 rename，中途任何失败都清掉暂存、不碰现有副本。
 */
export async function downloadCodeUpdate({
  manifest,
  userDataDir,
  fetchImpl = fetch,
  baseUrl = CODE_BASE_URL,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  onProgress = null
} = {}) {
  if (!manifest?.files) throw new Error('尚未取到代码清单')
  const stage = join(userDataDir, 'code-tmp')
  const dest = join(userDataDir, 'code')
  const previous = join(userDataDir, 'code-prev')
  rmSync(stage, { recursive: true, force: true })
  let total = 0
  const entries = Object.entries(manifest.files)
  try {
    for (const [index, [rel, md5]] of entries.entries()) {
      const buf = await fetchBuffer(baseUrl + rel, timeoutMs, fetchImpl)
      const actual = createHash('md5').update(buf).digest('hex')
      if (actual !== md5) throw new Error(`${rel} MD5 校验失败`)
      total += buf.length
      if (total > MAX_TOTAL_BYTES) throw new Error('代码包体积超过安全上限')
      const target = join(stage, ...rel.split('/'))
      if (!target.startsWith(stage + sep)) throw new Error(`${rel} 越出暂存目录`)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, buf)
      onProgress?.({ done: index + 1, total: entries.length, rel })
    }
    // 副本自带版本号，loader 和下次检查都读它
    writeFileSync(
      join(stage, 'code-version.json'),
      JSON.stringify({ versionName: manifest.versionName, codeVersion: manifest.codeVersion }, null, 2)
    )
    // 留一份上一版，坏版本可以人工回滚，不用重装
    rmSync(previous, { recursive: true, force: true })
    if (existsSync(dest)) renameSync(dest, previous)
    renameSync(stage, dest)
    return { ok: true, versionName: manifest.versionName, codeVersion: manifest.codeVersion, files: entries.length, bytes: total }
  } catch (error) {
    rmSync(stage, { recursive: true, force: true })
    throw error
  }
}

/** 回滚到上一份热更新副本；没有上一版时回落安装包内置代码。 */
export function rollbackCodeUpdate({ userDataDir }) {
  const dest = join(userDataDir, 'code')
  const previous = join(userDataDir, 'code-prev')
  if (existsSync(previous)) {
    rmSync(dest, { recursive: true, force: true })
    renameSync(previous, dest)
    return { ok: true, to: 'previous', version: readCurrentVersion({ userDataDir, appDir: '' }) }
  }
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true })
    return { ok: true, to: 'builtin' }
  }
  return { ok: false, reason: '当前已经是安装包内置版本' }
}

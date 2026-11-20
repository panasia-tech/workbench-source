/**
 * 热更新（替代 electron-updater：未签名的 Mac 应用装不了它的更新）。
 * - 启动 20 秒后查一次版本，之后每 30 分钟查一次；有新版本照旧发 update-available，界面沿用 UpdateDialog。
 * - 只下载我们自己的代码（dist / electron / server / shared / package.json，约几 MB），
 *   和本机 app.asar 里的 node_modules 合成新的 app.asar；点「立即安装」时换上并重启。
 * - 第三方库或 Electron 变了（hotBase 不同）、或应用目录不可写时，改为打开完整安装包下载链接。
 * IPC 与事件名保持原样：check-for-updates / download-update / quit-and-install / get-update-state。
 */
import { ipcMain, app, shell } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import asar from '@electron/asar'
import { sxjkBackendPost } from '../utils/sxjk-backend-client.js'

// original-fs：直接读写 .asar 文件本身（Electron 的 fs 会把 .asar 当成目录）
const ofs = createRequire(import.meta.url)('original-fs')
const execFileP = promisify(execFile)

const FIRST_CHECK_DELAY_MS = 20 * 1000
const CHECK_INTERVAL_MS = 30 * 60 * 1000
const ASAR_ENTRIES = ['dist', 'electron', 'server', 'shared', 'package.json']

const isDev = !app.isPackaged

let updateState = emptyState()
/** @type {null | { version: string, notes: string[], mandatory: boolean, releaseDate: string, hot: null | { url: string, sha256: string, size: number }, fullUrl: string }} */
let latest = null
let readyAsarPath = ''
let checkingNow = false
let downloadingNow = false
let checkTimer = null

function emptyState() {
  return {
    available: false,
    version: null,
    releaseDate: null,
    releaseNotes: [],
    mandatory: false,
    downloaded: false,
    downloadProgress: 0,
    error: null
  }
}

function workDir() {
  return join(app.getPath('userData'), 'hot-update')
}

function currentAsarPath() {
  return join(process.resourcesPath, 'app.asar')
}

function readHotBase() {
  try {
    const pkg = JSON.parse(fs.readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'))
    return String(pkg.hotBase || '')
  } catch {
    return ''
  }
}

/** 1.2.10 > 1.2.9 */
function isNewer(a, b) {
  const pa = String(a || '').split('.').map(x => parseInt(x, 10) || 0)
  const pb = String(b || '').split('.').map(x => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  }
  return false
}

function canWriteApp() {
  try {
    ofs.accessSync(process.resourcesPath, ofs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

function send(win, channel, payload) {
  if (!win || win.isDestroyed()) return
  try {
    win.webContents.send(channel, payload)
  } catch {
    /* 状态已保存，渲染进程可轮询 get-update-state */
  }
}

function fail(win, message, suggestion = '') {
  updateState.error = message
  console.error(`[热更新] ${message}`)
  send(win, 'update-error', { message, suggestion, originalMessage: message })
}

async function checkForUpdates(win, { manual = false } = {}) {
  if (isDev || checkingNow || downloadingNow) return
  checkingNow = true
  if (manual) send(win, 'update-checking')
  try {
    const res = await sxjkBackendPost('/app/xy-sxjk/clientUpdate/manifest', {
      version: app.getVersion(),
      hotBase: readHotBase(),
      arch: process.arch
    }, { timeoutMs: 20000 })
    const m = res?.data && typeof res.data === 'object' && 'version' in res.data ? res.data : res
    if (!m?.version || !isNewer(m.version, app.getVersion())) {
      updateState.available = false
      updateState.error = null
      if (manual) send(win, 'update-not-available', { version: app.getVersion() })
      return
    }
    latest = {
      version: String(m.version),
      notes: Array.isArray(m.notes) ? m.notes.map(String) : [],
      mandatory: m.mandatory === true,
      releaseDate: String(m.releaseDate || ''),
      hot: m.hot && m.hot.url ? m.hot : null,
      fullUrl: String(m.fullUrl || '')
    }
    if (updateState.downloaded && updateState.version === latest.version) return
    Object.assign(updateState, {
      available: true,
      version: latest.version,
      releaseDate: latest.releaseDate,
      releaseNotes: latest.notes,
      mandatory: latest.mandatory,
      error: null
    })
    console.log(`[热更新] 发现新版本 ${latest.version}（当前 ${app.getVersion()}）${latest.hot ? '' : '，需完整安装包'}`)
    send(win, 'update-available', {
      version: latest.version,
      releaseDate: latest.releaseDate,
      releaseNotes: latest.notes,
      mandatory: latest.mandatory
    })
  } catch (e) {
    // 窗口未就绪或网络问题：自动检查静默，手动检查才提示
    if (manual) fail(win, '检查更新失败，请稍后再试', String(e?.message || e))
  } finally {
    checkingNow = false
  }
}

async function downloadTo(url, file, expectedSize, onProgress) {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`下载失败（HTTP ${res.status}）`)
  const total = Number(res.headers.get('content-length')) || expectedSize || 0
  const fh = await fsp.open(file, 'w')
  const hash = createHash('sha256')
  let got = 0
  try {
    for await (const chunk of res.body) {
      hash.update(chunk)
      await fh.write(chunk)
      got += chunk.length
      if (total) onProgress(got / total, got, total)
    }
  } finally {
    await fh.close()
  }
  return hash.digest('hex')
}

/** 把 app.asar 里的 node_modules 原样拷到 dest（经 Electron 的 fs 读归档内文件） */
async function copyFromAsar(src, dest) {
  await fsp.mkdir(dest, { recursive: true })
  for (const name of await fsp.readdir(src)) {
    const s = join(src, name)
    const t = join(dest, name)
    const st = await fsp.stat(s).catch(() => null)
    if (!st) continue
    if (st.isDirectory()) await copyFromAsar(s, t)
    else await fsp.writeFile(t, await fsp.readFile(s))
  }
}

async function downloadUpdate(win) {
  if (downloadingNow || !latest) return
  // 已经下好的同一版本：直接告诉界面可以安装，不重复下载
  if (updateState.downloaded && updateState.version === latest.version && readyAsarPath && ofs.existsSync(readyAsarPath)) {
    send(win, 'update-downloaded', { version: latest.version, releaseDate: latest.releaseDate, releaseNotes: latest.notes, mandatory: latest.mandatory, downloadedFile: readyAsarPath })
    return
  }
  if (!latest.hot || !canWriteApp()) {
    if (latest.fullUrl) await shell.openExternal(latest.fullUrl)
    fail(win, '这次更新需要安装完整安装包', latest.fullUrl
      ? '已在浏览器打开下载，下载后照之前的方式安装。'
      : '请联系管理员获取新版安装包。')
    return
  }
  downloadingNow = true
  updateState.downloadProgress = 0
  const dir = workDir()
  const ver = latest.version
  const tgz = join(dir, `patch-${ver}.tar.gz`)
  const staging = join(dir, `staging-${ver}`)
  const next = join(process.resourcesPath, 'app.asar.next')
  const progress = (p) => {
    const percent = Math.max(0, Math.min(99, Math.round(p)))
    updateState.downloadProgress = percent
    send(win, 'update-download-progress', { percent, transferred: 0, total: 0 })
  }
  try {
    await fsp.rm(dir, { recursive: true, force: true })
    await fsp.mkdir(staging, { recursive: true })
    // 下载占 0~70%，合成新程序包占 70~99%
    const sha = await downloadTo(latest.hot.url, tgz, latest.hot.size, f => progress(f * 70))
    if (sha !== latest.hot.sha256) throw new Error('更新包校验失败，请重试')
    await execFileP('/usr/bin/tar', ['-xzf', tgz, '-C', staging])
    const pkg = JSON.parse(await fsp.readFile(join(staging, 'package.json'), 'utf8'))
    if (pkg.version !== ver || pkg.hotBase !== readHotBase()) throw new Error('更新包内容与版本不符')
    progress(75)
    await copyFromAsar(join(app.getAppPath(), 'node_modules'), join(staging, 'node_modules'))
    progress(90)
    ofs.rmSync(next, { force: true })
    await asar.createPackage(staging, next)
    const check = JSON.parse(asar.extractFile(next, 'package.json').toString('utf8'))
    for (const e of ASAR_ENTRIES) {
      if (!asar.listPackage(next).some(p => p === `/${e}` || p.startsWith(`/${e}/`))) throw new Error(`新程序包缺少 ${e}`)
    }
    if (check.version !== ver) throw new Error('新程序包版本不符')
    readyAsarPath = next
    Object.assign(updateState, { downloaded: true, downloadProgress: 100, error: null })
    console.log(`[热更新] ${ver} 已就绪，等待安装`)
    send(win, 'update-downloaded', {
      version: ver,
      releaseDate: latest.releaseDate,
      releaseNotes: latest.notes,
      mandatory: latest.mandatory,
      downloadedFile: next
    })
  } catch (e) {
    ofs.rmSync(next, { force: true })
    updateState.downloadProgress = 0
    fail(win, String(e?.message || e) || '更新失败')
  } finally {
    downloadingNow = false
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 换上新的 app.asar（旧的留作 app.asar.prev 以便手工回退），然后重启 */
function quitAndInstall(win) {
  if (!readyAsarPath || !ofs.existsSync(readyAsarPath)) {
    fail(win, '更新包还没准备好，请重新下载')
    return
  }
  const cur = currentAsarPath()
  const prev = join(process.resourcesPath, 'app.asar.prev')
  try {
    ofs.rmSync(prev, { force: true })
    ofs.renameSync(cur, prev)
    try {
      ofs.renameSync(readyAsarPath, cur)
    } catch (e) {
      ofs.renameSync(prev, cur)
      throw e
    }
  } catch (e) {
    fail(win, `安装更新失败：${e?.message || e}`)
    return
  }
  console.log(`[热更新] 已换上 ${updateState.version}，重启`)
  app.relaunch()
  app.quit()
}

/**
 * 注册更新相关的 IPC 处理器
 * @param {import('electron').BrowserWindow} win 主窗口实例（用于发送更新事件）
 */
export function registerUpdaterIPC(win) {
  if (!isDev) {
    // 上次没装完留下的半成品
    ofs.rmSync(join(process.resourcesPath, 'app.asar.next'), { force: true })
    void fsp.rm(workDir(), { recursive: true, force: true }).catch(() => {})
  }

  setTimeout(() => void checkForUpdates(win), FIRST_CHECK_DELAY_MS)
  if (checkTimer) clearInterval(checkTimer)
  checkTimer = setInterval(() => void checkForUpdates(win), CHECK_INTERVAL_MS)
  app.on('before-quit', () => {
    if (checkTimer) clearInterval(checkTimer)
    checkTimer = null
  })

  ipcMain.on('check-for-updates', () => void checkForUpdates(win, { manual: true }))
  ipcMain.on('download-update', () => void downloadUpdate(win))
  ipcMain.on('quit-and-install', () => quitAndInstall(win))
  ipcMain.handle('get-update-state', () => ({ ok: true, state: { ...updateState } }))
}

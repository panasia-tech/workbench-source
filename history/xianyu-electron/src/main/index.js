import { appendFileSync } from 'fs'
import { join } from 'path'
import { app, BrowserWindow, ipcMain, Menu, nativeImage, session, shell, Tray } from 'electron'
import * as api from './api.js'
import { gotoHome } from './goofish.js'
import * as scheduler from './scheduler.js'
import * as sm from './session-manager.js'
import * as store from './store.js'

let win = null
let tray = null
let isQuiting = false

// 崩溃兜底：主进程未捕获异常默认会直接退出（用户看到的就是"自己退出"），
// 这里记到 userData/crash.log 并保持进程存活；排查问题让用户把这个文件发回来
function logCrash(kind, err) {
  try {
    const line = `[${new Date().toISOString()}] ${kind}: ${err?.stack || err}\n`
    appendFileSync(join(app.getPath('userData'), 'crash.log'), line)
  } catch {
    /* ignore */
  }
  console.error(kind, err)
}
process.on('uncaughtException', (e) => logCrash('uncaughtException', e))
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e))

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 680,
    title: '闲鱼行情爬虫',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())

  // 外链用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // 关闭 = 收进托盘（除非设置为关闭即退出，或托盘菜单点了退出）
  win.on('close', (e) => {
    const closeToTray = store.getSettings().closeToTray
    if (!isQuiting && closeToTray) {
      e.preventDefault()
      win.hide()
    }
  })

  sm.initSessionManager(win)

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray() {
  // 用 1x1 透明占位图，避免缺资源；生产可换 resources/tray.png
  const img = nativeImage.createEmpty()
  tray = new Tray(img)
  tray.setToolTip('闲鱼行情爬虫')
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => { win.show(); win.focus() } },
    { label: '开始爬取', click: () => scheduler.start() },
    { label: '停止', click: () => scheduler.stop() },
    { type: 'separator' },
    { label: '退出', click: () => { isQuiting = true; app.quit() } }
  ])
  tray.setContextMenu(menu)
  tray.on('click', () => { win.show(); win.focus() })
}

// 把账号对象按 id 取出
function accountById(id) {
  return store.getAccounts().find((a) => a.id === id) || null
}

// 通过分区 cookie 粗判是否已登录闲鱼
async function checkXianyuLogin(account) {
  try {
    const ses = session.fromPartition(account.partition)
    const cookies = await ses.cookies.get({ domain: '.goofish.com' })
    const cookies2 = await ses.cookies.get({ domain: '.taobao.com' })
    const all = [...cookies, ...cookies2]
    return all.some((c) => ['unb', 'munb', '_l_g_', 'cookie2'].includes(c.name) && c.value)
  } catch {
    return false
  }
}

function registerIpc() {
  // ---- 鉴权 ----
  ipcMain.handle('auth:get-state', () => ({
    serverBaseUrl: store.getServerBaseUrl(),
    staff: store.getStaff(),
    hasToken: !!store.getToken()
  }))
  ipcMain.handle('auth:set-server', (_e, url) => {
    store.setServerBaseUrl(url)
    return store.getServerBaseUrl()
  })
  ipcMain.handle('auth:login', async (_e, { serverBaseUrl, username, password }) => {
    if (serverBaseUrl) store.setServerBaseUrl(serverBaseUrl)
    try {
      const data = await api.login(username, password)
      store.setToken(data.token)
      store.setStaff(data.staff)
      return { ok: true, staff: data.staff }
    } catch (e) {
      return { ok: false, reason: e?.response?.data?.detail || e?.message || '登录失败' }
    }
  })
  ipcMain.handle('auth:logout', () => {
    store.clearAuth()
    return { ok: true }
  })

  // ---- 账号 ----
  ipcMain.handle('accounts:list', async () => {
    const list = store.getAccounts()
    const withStatus = await Promise.all(
      list.map(async (a) => ({ ...a, loggedIn: await checkXianyuLogin(a) }))
    )
    return withStatus
  })
  ipcMain.handle('accounts:add', (_e, name) => store.addAccount(name))
  ipcMain.handle('accounts:update', (_e, { id, patch }) => store.updateAccount(id, patch))
  ipcMain.handle('accounts:remove', (_e, id) => {
    sm.destroyView(id)
    store.removeAccount(id)
    return { ok: true }
  })

  // ---- 设置 ----
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:set', (_e, patch) => {
    store.setSettings(patch)
    scheduler.rearmDaily()
    return store.getSettings()
  })

  // ---- 任务 / 爬取 ----
  ipcMain.handle('tasks:plan', () => scheduler.previewPlan())
  ipcMain.handle('crawl:start', () => scheduler.start())
  ipcMain.handle('crawl:stop', () => scheduler.stop())
  ipcMain.handle('crawl:status', () => ({ running: scheduler.isRunning() }))

  // ---- 结果日志 ----
  ipcMain.handle('results:query', (_e, params) => store.queryResults(params))
  ipcMain.handle('results:clear', () => {
    store.clearResults()
    return { ok: true }
  })

  // ---- 预览（attach/detach WebContentsView） ----
  ipcMain.handle('preview:attach', (_e, { accountId, bounds }) => {
    const acc = accountById(accountId)
    if (!acc) return { ok: false }
    sm.attach(acc, bounds)
    return { ok: true }
  })
  ipcMain.handle('preview:set-bounds', (_e, bounds) => {
    sm.setBounds(bounds)
    return { ok: true }
  })
  ipcMain.handle('preview:detach', () => {
    sm.detach()
    return { ok: true }
  })
  ipcMain.handle('preview:goto-home', async (_e, accountId) => {
    const acc = accountById(accountId)
    if (!acc) return { ok: false }
    await gotoHome(sm.getWebContents(acc))
    return { ok: true }
  })
  ipcMain.handle('preview:reload', (_e, accountId) => {
    const acc = accountById(accountId)
    if (acc) sm.getWebContents(acc).reload()
    return { ok: true }
  })

  // ---- 窗口 ----
  ipcMain.handle('win:hide', () => { win.hide(); return { ok: true } })
  ipcMain.handle('win:minimize', () => { win.minimize(); return { ok: true } })
}

// GPU/工具进程崩溃也记下来（不影响运行，纯诊断）
app.on('child-process-gone', (_e, details) => {
  if (details?.reason && details.reason !== 'clean-exit') {
    logCrash('child-process-gone', `${details.type} ${details.reason} exitCode=${details.exitCode}`)
  }
})

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  createTray()

  // 调度进度事件 → 转发渲染层
  scheduler.setEmitter((type, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send('crawl:event', { type, payload })
  })
  scheduler.rearmDaily()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else win.show()
  })
})

app.on('before-quit', () => {
  isQuiting = true
  sm.destroyAll()
})

// 收托盘后台运行：不在所有窗口关闭时退出
app.on('window-all-closed', () => {
  // 故意留空——靠托盘退出，保证后台爬取继续
})

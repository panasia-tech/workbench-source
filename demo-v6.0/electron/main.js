import { app, ipcMain, Menu, shell, nativeImage } from 'electron'
import { existsSync, cpSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import dotenv from 'dotenv'
import { registerAccountIPC, resetAllGoofishImRealtimeOnAppStart } from './ipc/accounts.js'
import { registerMonitoringIPC } from './ipc/monitoring.js'
import { registerMonitoringLogsIPC } from './ipc/monitoring-logs.js'
import { registerAppConfigIPC } from './ipc/app-config.js'
import { registerDeviceBindingIPC } from './ipc/device-binding.js'
import { registerUpdaterIPC } from './ipc/updater.js'
import { registerErpAuthIPC } from './ipc/erp-auth.js'
import { registerWindowIPC } from './ipc/window.js'
import { registerDingtalkIPC } from './ipc/dingtalk.js'
import { registerDingtalkConnectTestIPC } from './ipc/dingtalk-connect-test.js'
import { registerSxjkListenTasksIPC } from './ipc/sxjk-listen-tasks.js'
import { registerSxjkKeywordHistoryIPC } from './ipc/sxjk-keyword-history.js'
import { registerSxjkSellerPlainMapIPC } from './ipc/sxjk-seller-plain-map.js'
import { registerSxjkPushedItemIdsIPC } from './ipc/sxjk-pushed-item-ids.js'
import { registerSxjkPushLogsIPC } from './ipc/sxjk-push-logs.js'
import { registerSxjkGrabLogsIPC } from './ipc/sxjk-grab-logs.js'
import { registerSxjkPollCheckLogsIPC } from './ipc/sxjk-poll-check-logs.js'
import { registerGoofishSessionIPC } from './ipc/goofish-session-ipc.js'
import { registerSxjkMainLogIPC } from './ipc/sxjk-main-log.js'
import { registerSxjkLoginMtopIPC } from './ipc/sxjk-login-mtop-ipc.js'
import { registerSxjkLocalMtopIPC } from './ipc/sxjk-local-mtop.js'
import { registerSxjkBackendBridgeIPC } from './utils/sxjk-backend-bridge.js'
import { initSxjkBackendClient } from './utils/sxjk-backend-client.js'
import { registerSxjkShopMonitorsIPC, registerSxjkNormalizeMtopCardListIPC } from './ipc/sxjk-shop-monitors.js'
import { registerSxjkShopPushLogsIPC } from './ipc/sxjk-shop-push-logs.js'
import { registerSxjkShopPushedItemIdsIPC } from './ipc/sxjk-shop-pushed-item-ids.js'
import { registerSxjkListingSnapshotsIPC } from './ipc/sxjk-listing-snapshots.js'
import { registerSxjkLocalStateIPC } from './ipc/sxjk-local-state.js'
import { getOrCreateDeviceId } from './utils/device-binding.js'
import { APP_PRODUCT } from './config/app-product.js'
import { initUserDataDirectories } from './utils/data-init.js'
import { openSxjkLocalDb } from './utils/sxjk-local-db.js'
import { applySxjkLocalSchemaMigrations } from './utils/sxjk-local-db-schema-migrations.js'
import { migrateSxjkJsonToSqlite } from './utils/sxjk-json-to-sqlite-migrate.js'
import { getAppConfig } from './utils/config.js'
import { createAppWindow, setupWindowCloseBehavior, resolveAppIcon } from './utils/window.js'
import { createAppTray } from './utils/tray.js'
import { setupAppLifecycle } from './utils/app-lifecycle.js'
import {
  ensureAccountPartitionsStartupFast,
  ensureAccountPartitionsStartupMh5Warmup,
  notifyAccountsMh5WarmupDone,
  registerAccountPartitionStartupIPC
} from './utils/goofish-partition-startup.js'
import { formatAppWindowTitle } from './utils/app-window-title.js'

/**
 * 允许渲染进程在非用户手势场景播放提示音（如监听轮询里秒拍成功后的 HTMLAudioElement.play）。
 * 须在 app ready 之前设置；否则 Chrome 自动播放策略会静默拒绝 play()。
 */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** 全局单实例：避免重复启动多进程、数据目录争用（须在 setPath / 业务初始化之前） */
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.exit(0)
}

let win
let isExplicitQuit = false

app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  } else {
    createWindow()
  }
})

/** 独立数据根目录（须与 package.json → build.appId 一致；勿与其它产品线共用） */
const USER_DATA_ROOT = 'cn.com.mazen.xianyu.listing.monitor'

/** 曾用目录名：仅当新路径尚不存在时整目录复制一次，避免升级后重复账号/丢配置 */
const LEGACY_USER_DATA_DIRS = ['xianyu_listing_monitor']

function resolveUserDataPath() {
  const appDataRoot = app.getPath('appData')
  const target = join(appDataRoot, USER_DATA_ROOT)
  if (!existsSync(target)) {
    for (const legacy of LEGACY_USER_DATA_DIRS) {
      const src = join(appDataRoot, legacy)
      if (!existsSync(src)) continue
      try {
        cpSync(src, target, { recursive: true })
        console.log('[数据存储] 已从旧目录迁移至独立包:', src, '->', target)
      } catch (e) {
        console.error('[数据存储] 迁移失败，将使用新空目录:', e)
      }
      break
    }
  }
  return target
}

dotenv.config({ path: join(__dirname, '..', '.env') })
const userDataPath = resolveUserDataPath()
app.setPath('userData', userDataPath)
// ERP 登录：preload 一加载就同步取令牌，须在窗口创建前注册
registerErpAuthIPC()

/**
 * Windows：默认缓存目录在升级/多实例/杀软占用时易出现「Unable to move the cache / Gpu Cache Creation failed」。
 * 将 HTTP/GPU 磁盘缓存放到 userData 下独立子目录，并关闭 GPU shader 磁盘缓存，减轻 0x5 拒绝访问类日志。
 * （须在 app ready 之前设置。）
 */
if (process.platform === 'win32') {
  try {
    const cacheRoot = join(userDataPath, 'browser-cache')
    const httpCache = join(cacheRoot, 'http')
    const gpuCache = join(cacheRoot, 'gpu')
    mkdirSync(httpCache, { recursive: true })
    mkdirSync(gpuCache, { recursive: true })
    app.commandLine.appendSwitch('disk-cache-dir', httpCache)
    app.commandLine.appendSwitch('gpu-disk-cache-dir', gpuCache)
  } catch (e) {
    console.warn('[浏览器内核] 自定义缓存目录不可用，使用默认路径:', e)
  }
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')
}

const defaultDataPath = join(__dirname, 'data')
let dataPaths = null
try {
  dataPaths = initUserDataDirectories(userDataPath, defaultDataPath)
} catch (error) {
  console.error('[数据初始化] 初始化失败:', error)
  dataPaths = {
    accountsDir: join(__dirname, 'data', 'account'),
    monitoringFile: join(__dirname, 'data', 'monitoring', 'monitoring.json'),
    sxjkTasksFile: join(__dirname, 'data', 'monitoring', 'xy-sxjk-tasks.json'),
    sxjkShopMonitorsFile: join(__dirname, 'data', 'monitoring', 'xy-sxjk-shop-monitors.json'),
    sxjkShopPushLogsFile: join(__dirname, 'data', 'monitoring', 'xy-sxjk-shop-push-logs.json'),
    sxjkShopPushedItemIdsFile: join(__dirname, 'data', 'monitoring', 'xy-sxjk-shop-pushed-item-ids.json'),
    sxjkKeywordHistoryFile: join(__dirname, 'data', 'monitoring', 'xy-sxjk-keyword-history.json'),
    sxjkPushedItemIdsFile: join(__dirname, 'data', 'monitoring', 'xy-sxjk-pushed-item-ids.json'),
    sxjkPushLogsFile: join(__dirname, 'data', 'monitoring', 'xy-sxjk-push-logs.json'),
    sxjkPollCheckLogsFile: join(__dirname, 'data', 'monitoring', 'xy-sxjk-poll-check-logs.json'),
    sxjkGrabLogsFile: join(__dirname, 'data', 'monitoring', 'xy-sxjk-grab-logs.json'),
    sxjkDingtalkConnectTestFile: join(__dirname, 'data', 'monitoring', 'xy-dingtalk-connect-test.json'),
    sxjkSellerPlainMapFile: join(__dirname, 'data', 'monitoring', 'xy-sxjk-seller-plain-map.json'),
    sxjkGuestCookiesFile: join(__dirname, 'data', 'monitoring', 'xy-sxjk-guest-cookies.json'),
    sxjkListingSnapshotsDir: join(__dirname, 'data', 'monitoring', 'sxjk-listing-snapshots'),
    sxjkLocalDbFile: join(__dirname, 'data', 'monitoring', 'sxjk-local.sqlite'),
    logsDir: join(__dirname, 'data', 'logs'),
    configFile: join(__dirname, 'data', 'config', 'app.js'),
    monitoringSettingsFile: join(__dirname, 'data', 'config', 'monitoring-settings.js')
  }
}

if (dataPaths?.sxjkListingSnapshotsDir) {
  try {
    mkdirSync(dataPaths.sxjkListingSnapshotsDir, { recursive: true })
  } catch {
    /* */
  }
}

try {
  getOrCreateDeviceId(userDataPath, APP_PRODUCT)
} catch (error) {
  console.error('[设备绑定] 初始化失败:', error)
}

const accountsDir = dataPaths.accountsDir
const monitoringFile = dataPaths.monitoringFile
const logsDir = dataPaths.logsDir
const configFile = dataPaths.configFile
const monitoringSettingsFile = dataPaths.monitoringSettingsFile
const sxjkTasksFile = dataPaths.sxjkTasksFile
const sxjkShopMonitorsFile = dataPaths.sxjkShopMonitorsFile
const sxjkShopPushLogsFile = dataPaths.sxjkShopPushLogsFile
const sxjkShopPushedItemIdsFile = dataPaths.sxjkShopPushedItemIdsFile
const sxjkKeywordHistoryFile = dataPaths.sxjkKeywordHistoryFile
const sxjkPushedItemIdsFile = dataPaths.sxjkPushedItemIdsFile
const sxjkPushLogsFile = dataPaths.sxjkPushLogsFile
const sxjkPollCheckLogsFile = dataPaths.sxjkPollCheckLogsFile
const sxjkGrabLogsFile = dataPaths.sxjkGrabLogsFile
const sxjkDingtalkConnectTestFile = dataPaths.sxjkDingtalkConnectTestFile
const sxjkSellerPlainMapFile = dataPaths.sxjkSellerPlainMapFile
const sxjkGuestCookiesFile = dataPaths.sxjkGuestCookiesFile
const sxjkListingSnapshotsDir = dataPaths.sxjkListingSnapshotsDir
const sxjkLocalDbFile =
  dataPaths.sxjkLocalDbFile ||
  join(dirname(sxjkPushLogsFile || join(__dirname, 'data', 'monitoring', 'x.json')), 'sxjk-local.sqlite')

try {
  openSxjkLocalDb(sxjkLocalDbFile)
} catch (e) {
  console.error('[本机SQL] 打开失败', e)
}
try {
  applySxjkLocalSchemaMigrations(openSxjkLocalDb(sxjkLocalDbFile))
} catch (e) {
  console.error('[本机SQL] schema 升级失败', e)
}
try {
  migrateSxjkJsonToSqlite(openSxjkLocalDb(sxjkLocalDbFile), {
    sxjkPushLogsFile,
    sxjkPollCheckLogsFile,
    sxjkGrabLogsFile,
    sxjkShopPushLogsFile,
    sxjkPushedItemIdsFile,
    sxjkShopPushedItemIdsFile,
    sxjkSellerPlainMapFile,
    sxjkListingSnapshotsDir
  })
} catch (e) {
  console.error('[本机SQL] 迁移失败', e)
}

const getIsExplicitQuit = () => isExplicitQuit
const setIsExplicitQuit = (value) => {
  isExplicitQuit = value
}

const createWindow = () => {
  if (win && !win.isDestroyed()) {
    return
  }

  win = createAppWindow({
    configFile,
    defaultDataPath,
    __dirname
  })

  setupWindowCloseBehavior(win, getIsExplicitQuit, setIsExplicitQuit, configFile, defaultDataPath)
}

function getTrayTooltip() {
  try {
    const c = getAppConfig(configFile, defaultDataPath)
    return formatAppWindowTitle(c.appName)
  } catch {
    return formatAppWindowTitle('咸鱼外卖助手')
  }
}

/**
 * macOS 必须保留「编辑」菜单角色，否则 Cmd+C / Cmd+V / 全选等与系统不一致（常退化成 Ctrl 习惯）。
 * Windows 仍隐藏菜单栏。
 */
function setupApplicationMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }
  const template = [
    {
      label: app.name || '咸鱼外卖助手',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' },
        { role: 'delete', label: '删除' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '全部置于顶层' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  app.setAppUserModelId('咸鱼外卖助手')
  try {
    const iconPath = resolveAppIcon(__dirname)
    if (iconPath) {
      const iconImage = nativeImage.createFromPath(iconPath)
      if (!iconImage.isEmpty() && process.platform === 'darwin' && app.dock) {
        app.dock.setIcon(iconImage)
      }
    }
  } catch (e) {
    console.warn('[启动] 设置 Dock 图标失败', e?.message || e)
  }
  setupApplicationMenu()

  try {
    await resetAllGoofishImRealtimeOnAppStart(accountsDir)
  } catch (e) {
    console.warn('[启动] 清空私聊实时状态失败', e?.message || e)
  }

  try {
    await ensureAccountPartitionsStartupFast(accountsDir)
  } catch (e) {
    console.warn('[启动] 分区快速预热失败', e?.message || e)
  }
  registerAccountPartitionStartupIPC(ipcMain, {
    accountsDir,
    electronDirname: __dirname
  })

  try {
    process.env.DATA_DIR = join(userDataPath, 'compatible-server')
    const { startCompatibleServer } = await import('../server/server.js')
    await startCompatibleServer({
      port: 8787,
      areasFile: join(__dirname, 'lib', 'xy_sxjk', 'areas.json'),
      publicBaseUrl: 'http://127.0.0.1:8787'
    })
    console.log('[兼容后端] 已启动 http://127.0.0.1:8787')
  } catch (e) {
    if (e?.code === 'EADDRINUSE') {
      console.log('[兼容后端] 8787 已有服务在运行，直接复用')
    } else {
      console.error('[兼容后端] 启动失败:', e)
    }
  }

  createWindow()

  void ensureAccountPartitionsStartupMh5Warmup(accountsDir, __dirname)
    .then((r) => {
      notifyAccountsMh5WarmupDone(() => win, { accounts: r?.accounts })
    })
    .catch((e) => {
      console.warn('[启动] 分区 mh5 后台预热失败', e?.message || e)
      notifyAccountsMh5WarmupDone(() => win, { accounts: 0 })
    })

  createAppTray({
    getWindow: () => win,
    setIsExplicitQuit,
    electronDirname: __dirname,
    tooltip: getTrayTooltip()
  })

  const config = getAppConfig(configFile, defaultDataPath)
  if (config.autoLaunch !== undefined) {
    app.setLoginItemSettings({
      openAtLogin: config.autoLaunch,
      openAsHidden: false
    })
  }

  registerAccountIPC(ipcMain, accountsDir, () => win, { electronDirname: __dirname })
  registerMonitoringIPC(ipcMain, monitoringFile, accountsDir, monitoringSettingsFile)
  registerMonitoringLogsIPC(ipcMain, logsDir, monitoringFile)
  registerAppConfigIPC(ipcMain, win, configFile)
  registerDingtalkIPC(ipcMain)
  if (sxjkDingtalkConnectTestFile) registerDingtalkConnectTestIPC(ipcMain, sxjkDingtalkConnectTestFile)
  if (sxjkTasksFile) registerSxjkListenTasksIPC(ipcMain, sxjkTasksFile)
  if (sxjkKeywordHistoryFile) registerSxjkKeywordHistoryIPC(ipcMain, sxjkKeywordHistoryFile)
  registerSxjkSellerPlainMapIPC(ipcMain)
  registerSxjkPushedItemIdsIPC(ipcMain)
  if (sxjkShopMonitorsFile) {
    registerSxjkShopMonitorsIPC(ipcMain, sxjkShopMonitorsFile)
    registerSxjkNormalizeMtopCardListIPC(ipcMain)
  }
  registerSxjkShopPushLogsIPC(ipcMain, { syncShopPushedIds: true })
  registerSxjkShopPushedItemIdsIPC(ipcMain)
  registerSxjkPushLogsIPC(ipcMain, { syncPushedIds: true })
  registerSxjkPollCheckLogsIPC(ipcMain)
  registerSxjkGrabLogsIPC(ipcMain)
  registerSxjkBackendBridgeIPC(ipcMain)
  initSxjkBackendClient(() => win)
  registerSxjkMainLogIPC(ipcMain)
  registerSxjkLoginMtopIPC(ipcMain)
  registerSxjkLocalMtopIPC(ipcMain)
  registerGoofishSessionIPC(ipcMain, {
    guestCookiesFilePath: sxjkGuestCookiesFile || '',
    accountsDir,
    getMainWindow: () => win,
    electronDirname: __dirname
  })
  registerSxjkListingSnapshotsIPC(ipcMain)
  registerSxjkLocalStateIPC(ipcMain)
  registerDeviceBindingIPC(ipcMain, userDataPath)
  registerWindowIPC(win, configFile, defaultDataPath)
  registerUpdaterIPC(win)

  ipcMain.handle('set-auto-launch', (_, enabled) => {
    try {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: false
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  })

  ipcMain.handle('get-app-version', () => {
    try {
      return app.getVersion()
    } catch {
      return '1.0.0'
    }
  })

  ipcMain.handle('exit-app', () => {
    app.exit(1)
    return { ok: true }
  })

  ipcMain.handle('open-external-url', async (_e, url) => {
    try {
      if (typeof url !== 'string' || !url.trim()) {
        return { ok: false, error: 'invalid_url' }
      }
      const u = new URL(url.trim())
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        return { ok: false, error: 'invalid_protocol' }
      }
      await shell.openExternal(u.toString())
      return { ok: true }
    } catch (error) {
      console.error('[主进程] open-external-url:', error)
      return { ok: false, error: String(error) }
    }
  })
})

setupAppLifecycle(createWindow, getIsExplicitQuit, setIsExplicitQuit, configFile, defaultDataPath, accountsDir)

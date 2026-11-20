import { app, BrowserWindow, screen } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getAppConfig } from './config.js'
import { formatAppWindowTitle } from './app-window-title.js'

/** 打包后 asar 内 dist/index.html；开发为 electron/../dist */
function resolveRendererIndexHtml(electronDirname) {
  const candidates = [
    join(app.getAppPath(), 'dist', 'index.html'),
    join(electronDirname, '..', 'dist', 'index.html')
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return candidates[0]
}

/**
 * 将窗口整体（外框）在主显示器工作区内居中。
 * 注意：仅 setSize 不移动左上角时，大窗口会相对小窗口「往右下长出去」，看起来像只居中了左边——
 * 路由里 setWindowSize 后必须再调一次本函数。
 */
export function centerWindowInPrimaryWorkArea(win) {
  if (!win || win.isDestroyed()) return
  try {
    const b = win.getBounds()
    const wa = screen.getPrimaryDisplay().workArea
    const w = Math.max(b.width, 1)
    const h = Math.max(b.height, 1)
    const x = Math.round(wa.x + (wa.width - w) / 2)
    const y = Math.round(wa.y + (wa.height - h) / 2)
    win.setPosition(x, y)
  } catch {
    try {
      win.center()
    } catch {
      /* */
    }
  }
}

/** 与 package.json build.icon 同源：开发时任务栏/窗口图标；安装版 exe 由 electron-builder 内嵌图标 */
export function resolveAppIcon(electronDirname) {
  const fromSrc = join(electronDirname, '..', 'src', 'assets', 'image.png')
  if (existsSync(fromSrc)) return fromSrc
  const fromBuild = join(electronDirname, '..', 'build', 'icon.png')
  if (existsSync(fromBuild)) return fromBuild
  return undefined
}

export function createAppWindow({ configFile, defaultDataPath, __dirname }) {
  const windowWidth = 378
  const windowHeight = 640

  const config = getAppConfig(configFile, defaultDataPath)
  const appTitle = formatAppWindowTitle(config.appName)
  const icon = resolveAppIcon(__dirname)

  const win = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    show: false,
    maximizable: true,
    fullscreenable: true,
    resizable: true,
    title: appTitle,
    ...(icon ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      devTools: true,
      /** 托盘/最小化时仍按时执行渲染层定时任务（凭证同步轮询、定时一键登录等），避免只剩点开窗口才触发 */
      backgroundThrottling: false
    },
    autoHideMenuBar: true
  })

  win.once('ready-to-show', () => {
    /** 激活页默认尺寸；主界面最小限制由 set-window-size IPC 在进入主路由时提升 */
    try {
      win.setMinimumSize(windowWidth, windowHeight)
    } catch {
      /* */
    }

    centerWindowInPrimaryWorkArea(win)
    win.show()

    const currentConfig = getAppConfig(configFile, defaultDataPath)
    if (currentConfig.alwaysOnTop !== undefined) {
      win.setAlwaysOnTop(currentConfig.alwaysOnTop)
    }
    if (currentConfig.appName) {
      win.setTitle(formatAppWindowTitle(currentConfig.appName))
    }
  })

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    win.loadURL(devUrl)
    // 开发态自动打开调试器，便于排查白屏/控制台报错
    win.webContents.once('did-finish-load', () => {
      try {
        if (!win.isDestroyed()) win.webContents.openDevTools({ mode: 'detach' })
      } catch {
        /* */
      }
    })
  } else {
    const indexPath = resolveRendererIndexHtml(__dirname)
    if (!existsSync(indexPath)) {
      console.error('[window] 未找到界面文件 dist/index.html:', indexPath, 'appPath=', app.getAppPath())
    }
    win.loadFile(indexPath).catch((e) => {
      console.error('[window] loadFile 失败', indexPath, e?.message || e)
    })
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error('[window] did-fail-load', { code, desc, url, indexPath })
    })
  }

  win.setMenuBarVisibility(false)

  return win
}

export function setupWindowCloseBehavior(win, getIsExplicitQuit, setIsExplicitQuit, configFile, defaultDataPath) {
  win.on('close', (event) => {
    if (getIsExplicitQuit()) {
      return
    }

    const config = getAppConfig(configFile, defaultDataPath)
    if (config.closeButtonAction === 'minimize') {
      event.preventDefault()
      win.minimize()
      return
    }
    if (config.closeButtonAction === 'quit') {
      return
    }
    // 'tray'（默认）：关窗收到托盘，进程继续（监听/定时任务不停）
    event.preventDefault()
    win.hide()
  })
}

import { app, BrowserWindow, globalShortcut } from 'electron'

const DISCONNECT_PRESENCE_JS =
  'try { if (typeof window.__DISCONNECT_PRESENCE_SOCKET__ === "function") window.__DISCONNECT_PRESENCE_SOCKET__() } catch (e) {}'
import { getAppConfig } from './config.js'
import { destroyTray } from './tray.js'
import { flushAllAccountPartitionStores } from './goofish-partition-persist.js'
import { stopAllGoofishFeedBrowseWarmupTimers } from './goofish-feed-browse-warmup-scheduler.js'
import { closeAllGoofishImSessions } from './goofish-im-session-pool.js'
import { disposeBxEnvSign } from './goofish-bx-env-sign.js'

let isFlushingPartitionsOnQuit = false

function flushPartitionsAndExit(exitCode) {
  if (!accountsDir || isFlushingPartitionsOnQuit) {
    process.exit(exitCode)
    return
  }
  isFlushingPartitionsOnQuit = true
  void (async () => {
    try {
      await flushAllAccountPartitionStores(accountsDir)
    } catch (e) {
      console.warn('[应用生命周期] signal flush partitions:', e?.message || e)
    }
    process.exit(exitCode)
  })()
}

function registerPartitionFlushOnSignals() {
  const onSigint = () => flushPartitionsAndExit(130)
  const onSigterm = () => flushPartitionsAndExit(0)
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
}

export function setupAppLifecycle(
  createWindow,
  getIsExplicitQuit,
  setIsExplicitQuit,
  configFile,
  defaultDataPath,
  accountsDir = null
) {
  registerPartitionFlushOnSignals()

  app.on('before-quit', (event) => {
    setIsExplicitQuit(true)
    destroyTray()
    stopAllGoofishFeedBrowseWarmupTimers()
    closeAllGoofishImSessions()
    try {
      disposeBxEnvSign()
    } catch {
      /* */
    }

    if (accountsDir && !isFlushingPartitionsOnQuit) {
      isFlushingPartitionsOnQuit = true
      event.preventDefault()
      void (async () => {
        try {
          await flushAllAccountPartitionStores(accountsDir)
        } catch (e) {
          console.warn('[应用生命周期] flush partitions:', e?.message || e)
        }
        for (const w of BrowserWindow.getAllWindows()) {
          if (w.isDestroyed()) continue
          void w.webContents.executeJavaScript(DISCONNECT_PRESENCE_JS, true).catch(() => {})
        }
        app.quit()
      })()
      return
    }

    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      void w.webContents.executeJavaScript(DISCONNECT_PRESENCE_JS, true).catch(() => {})
    }
  })

  app.on('window-all-closed', () => {
    globalShortcut.unregisterAll()

    if (getIsExplicitQuit()) {
      app.quit()
      return
    }

    const config = getAppConfig(configFile, defaultDataPath)
    if (config.closeButtonAction === 'quit') {
      app.quit()
    } else if (config.closeButtonAction === 'tray' || config.closeButtonAction === 'minimize') {
      // 窗口仍存活（隐藏或最小化），不应退出进程
    } else if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  app.on('will-quit', () => {
    setIsExplicitQuit(false)
  })

  app.on('activate', () => {
    const wins = BrowserWindow.getAllWindows()
    if (wins.length === 0) {
      createWindow()
      return
    }
    const w = wins[0]
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
  })
}

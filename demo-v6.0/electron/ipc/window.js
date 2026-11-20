import { ipcMain } from 'electron'
import { centerWindowInPrimaryWorkArea } from '../utils/window.js'
import { formatAppWindowTitle } from '../utils/app-window-title.js'

export function registerWindowIPC(win, configFile, defaultDataPath) {
  ipcMain.handle('set-always-on-top', (_, enabled) => {
    try {
      if (win && !win.isDestroyed()) {
        win.setAlwaysOnTop(enabled)
        return { ok: true }
      }
      return { ok: false, error: '窗口未创建' }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  })

  ipcMain.handle('set-app-name', (_, appName) => {
    try {
      if (win && !win.isDestroyed() && appName) {
        win.setTitle(formatAppWindowTitle(appName))
        return { ok: true }
      }
      return { ok: false, error: '窗口未创建或应用名称为空' }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  })

  ipcMain.handle('set-window-size', (_, width, height) => {
    try {
      if (!win || win.isDestroyed()) {
        return { ok: false, error: '窗口未创建' }
      }

      const defaultWidth = 1165
      const defaultHeight = 700
      const activationWidth = 378
      const activationHeight = 640
      /** 主界面允许略缩小，但不低于此值（避免顶栏/侧栏布局挤成窄条） */
      const mainMinWidth = 1000
      const mainMinHeight = 650

      const targetWidth = width || defaultWidth
      const targetHeight = height || defaultHeight
      const isActivationWindow = targetWidth <= activationWidth

      win.removeAllListeners('will-resize')
      win.removeAllListeners('resize')

      win.setResizable(true)
      win.setMaximizable(true)
      try {
        win.setFullScreenable(true)
      } catch {
        /* 个别平台可能无此方法 */
      }

      if (isActivationWindow) {
        win.setMinimumSize(activationWidth, activationHeight)
        win.setSize(activationWidth, activationHeight)
        centerWindowInPrimaryWorkArea(win)
        return { ok: true }
      }

      win.setMinimumSize(mainMinWidth, mainMinHeight)
      try {
        win.setMaximumSize(0, 0)
      } catch {
        /* */
      }

      const [curW, curH] = win.getSize()
      const tooSmall = curW < mainMinWidth || curH < mainMinHeight
      if (tooSmall) {
        win.setSize(
          Math.max(targetWidth, mainMinWidth),
          Math.max(targetHeight, mainMinHeight)
        )
        centerWindowInPrimaryWorkArea(win)
      } else if (curW <= targetWidth && curH <= targetHeight) {
        // 从激活页进入主界面等：当前仍为小窗，抬到默认主界面尺寸
        win.setSize(targetWidth, targetHeight)
        centerWindowInPrimaryWorkArea(win)
      }

      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  })

}

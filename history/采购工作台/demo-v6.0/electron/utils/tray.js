import { Tray, Menu, nativeImage, app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

let tray = null

function resolveTrayIconPath(electronDirname) {
  if (app.isPackaged) {
    const packed = join(process.resourcesPath, 'tray.png')
    if (existsSync(packed)) return packed
  }
  const candidates = [
    join(electronDirname, '..', 'src', 'assets', 'image.png'),
    join(electronDirname, '..', 'build', 'icon.png')
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return null
}

/** macOS 菜单栏约 18pt；Windows 托盘 16px；Linux 略大 */
function prepareTrayIconImage(image) {
  if (image.isEmpty()) return image
  const size =
    process.platform === 'darwin' ? 18 : process.platform === 'win32' ? 16 : 22
  return image.resize({ width: size, height: size, quality: 'best' })
}

export function destroyTray() {
  if (tray) {
    tray.destroy()
    tray = null
  }
}

export function createAppTray(opts) {
  const { getWindow, setIsExplicitQuit, electronDirname, tooltip } = opts
  if (tray) return tray

  const iconPath = resolveTrayIconPath(electronDirname)
  let image = iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  if (image.isEmpty()) {
    console.warn(
      '[Tray] 未找到托盘图标，已跳过托盘（开发请保留 src/assets/image.png；打包依赖 extraResources → tray.png）'
    )
    return null
  }
  image = prepareTrayIconImage(image)

  tray = new Tray(image)
  tray.setToolTip(tooltip || '咸鱼外卖助手')

  const reopenWindow = () => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    if (!win.isVisible()) win.show()
    if (win.isMinimized()) win.restore()
    win.focus()
  }

  const menu = Menu.buildFromTemplate([
    {
      label: '重新打开软件',
      click: () => {
        reopenWindow()
      }
    },
    {
      label: '刷新',
      click: () => {
        const win = getWindow()
        if (!win || win.isDestroyed()) return
        if (!win.isVisible()) win.show()
        if (win.isMinimized()) win.restore()
        win.webContents.reload()
        win.focus()
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        setIsExplicitQuit(true)
        destroyTray()
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)

  tray.on('click', () => {
    reopenWindow()
  })

  return tray
}

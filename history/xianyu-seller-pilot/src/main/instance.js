import { app } from 'electron'

// 一个工位只跑一个巡航台。
//
// 多开时两个进程会同时写 %APPDATA%\xianyu-seller-pilot 下的 JSON；Windows 上
// 先发生的不是“后写的赢”，而是 rename 报 EPERM，退出登录/保存设置全部卡死。
// 这里在加载任何会写配置的模块之前拿锁；第二个实例直接退出，把第一个窗口叫到前面。
export const isPrimaryInstance = app.requestSingleInstanceLock()

export function focusMainWindow(getWindow) {
  const win = getWindow?.()
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

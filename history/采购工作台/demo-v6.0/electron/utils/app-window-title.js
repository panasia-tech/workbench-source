import { app } from 'electron'

/**
 * 窗口标题：应用名 + package 版本（与 app.getVersion() 一致）
 * @param {string} [appName]
 */
export function formatAppWindowTitle(appName) {
  const name = String(appName || '').trim() || '咸鱼外卖助手'
  let ver = ''
  try {
    if (typeof app.getVersion === 'function') {
      ver = String(app.getVersion() || '').trim()
    }
  } catch {
    /* */
  }
  if (!ver) return name
  return ver.startsWith('v') ? `${name} ${ver}` : `${name} v${ver}`
}

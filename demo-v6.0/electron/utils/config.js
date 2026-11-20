import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { app } from 'electron'

const DEFAULT_UPDATE_SERVER_URL = 'http://127.0.0.1:10087/updates/xianyu-sxjk/'

function normalizeUpdateServerUrl(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  return s.endsWith('/') ? s : `${s}/`
}

/**
 * 自动更新 generic 源地址（每次检查前应重新调用，勿在启动时缓存死值）。
 * 优先级：UPDATE_SERVER_URL 环境变量 → package.json build.publish[0].url → 默认地址
 */
export function getUpdateServerUrl() {
  const fromEnv = normalizeUpdateServerUrl(process.env.UPDATE_SERVER_URL)
  if (fromEnv) return fromEnv

  try {
    let packageJsonPath = ''
    try {
      packageJsonPath = join(app.getAppPath(), 'package.json')
    } catch {
      const __filename = fileURLToPath(import.meta.url)
      const __dirname = dirname(__filename)
      packageJsonPath = join(__dirname, '../../package.json')
    }
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
    const publishList = packageJson?.build?.publish
    if (Array.isArray(publishList) && publishList.length > 0) {
      const url = normalizeUpdateServerUrl(publishList[0]?.url)
      if (url) return url
    }
  } catch (error) {
    console.error('[配置] 读取 package.json 失败:', error)
  }

  return DEFAULT_UPDATE_SERVER_URL
}

export function getAppConfig(configFile, defaultDataPath) {
  try {
    const configPath = configFile || join(defaultDataPath, 'config', 'app.js')
    const content = readFileSync(configPath, 'utf-8')
    const config = {}

    const closeMatch = content.match(/closeButtonAction:\s*['"](quit|minimize|tray)['"]/)
    if (closeMatch) {
      config.closeButtonAction = closeMatch[1]
    }

    const autoLaunchMatch = content.match(/autoLaunch:\s*(true|false)/)
    if (autoLaunchMatch) {
      config.autoLaunch = autoLaunchMatch[1] === 'true'
    }

    const alwaysOnTopMatch = content.match(/alwaysOnTop:\s*(true|false)/)
    if (alwaysOnTopMatch) {
      config.alwaysOnTop = alwaysOnTopMatch[1] === 'true'
    }

    const primaryColorMatch = content.match(/primaryColor:\s*['"](#[0-9A-Fa-f]{6})['"]/i)
    if (primaryColorMatch) {
      config.primaryColor = primaryColorMatch[1]
    }

    const appNameMatch = content.match(/appName:\s*['"]([^'"]+)['"]/)
    if (appNameMatch) {
      const rawName = String(appNameMatch[1] || '').trim()
      config.appName = rawName === '闲鱼上新监控' ? '咸鱼外卖助手' : rawName
    }

    return config
  } catch (error) {
    return {
      appName: '咸鱼外卖助手',
      closeButtonAction: 'tray',
      autoLaunch: false,
      alwaysOnTop: false,
      primaryColor: '#f0a020'
    }
  }
}

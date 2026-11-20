import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname_utils = dirname(fileURLToPath(import.meta.url))
const BUNDLED_MONITORING_SETTINGS = join(__dirname_utils, '..', 'data', 'config', 'monitoring-settings.js')

/** 安装包内 data/account 仅做「首次环境」拷贝；写标记后不再从包内补拷，避免用户删号后重启又被拷回 */
const ACCOUNTS_BUNDLE_SEED_FLAG = '.sxjk-bundle-account-seed.done'

export function initUserDataDirectories(userDataPath, defaultDataPath) {
  const result = {
    accountsDir: null,
    monitoringFile: null,
    sxjkTasksFile: null,
    sxjkShopMonitorsFile: null,
    sxjkShopPushLogsFile: null,
    sxjkShopPushedItemIdsFile: null,
    sxjkKeywordHistoryFile: null,
    sxjkPushedItemIdsFile: null,
    sxjkPushLogsFile: null,
    sxjkPollCheckLogsFile: null,
    sxjkGrabLogsFile: null,
    sxjkDingtalkConnectTestFile: null,
    sxjkSellerPlainMapFile: null,
    sxjkXianyuSessionFile: null,
    sxjkGuestCookiesFile: null,
    sxjkListingSnapshotsDir: null,
    sxjkLocalDbFile: null,
    logsDir: null,
    configFile: null,
    monitoringSettingsFile: null,
    migrated: false
  }

  try {
    const dataDir = join(userDataPath, 'data')
    const accountsDir = join(dataDir, 'account')
    const monitoringDir = join(dataDir, 'monitoring')
    const logsDir = join(dataDir, 'logs')
    const configDir = join(dataDir, 'config')

    mkdirSync(accountsDir, { recursive: true })
    mkdirSync(monitoringDir, { recursive: true })
    const sxjkListingSnapshotsDir = join(monitoringDir, 'sxjk-listing-snapshots')
    mkdirSync(sxjkListingSnapshotsDir, { recursive: true })
    mkdirSync(logsDir, { recursive: true })
    mkdirSync(configDir, { recursive: true })

    result.accountsDir = accountsDir
    result.monitoringFile = join(monitoringDir, 'monitoring.json')
    result.sxjkTasksFile = join(monitoringDir, 'xy-sxjk-tasks.json')
    result.sxjkShopMonitorsFile = join(monitoringDir, 'xy-sxjk-shop-monitors.json')
    result.sxjkShopPushLogsFile = join(monitoringDir, 'xy-sxjk-shop-push-logs.json')
    result.sxjkShopPushedItemIdsFile = join(monitoringDir, 'xy-sxjk-shop-pushed-item-ids.json')
    result.sxjkKeywordHistoryFile = join(monitoringDir, 'xy-sxjk-keyword-history.json')
    result.sxjkPushedItemIdsFile = join(monitoringDir, 'xy-sxjk-pushed-item-ids.json')
    result.sxjkPushLogsFile = join(monitoringDir, 'xy-sxjk-push-logs.json')
    result.sxjkPollCheckLogsFile = join(monitoringDir, 'xy-sxjk-poll-check-logs.json')
    result.sxjkGrabLogsFile = join(monitoringDir, 'xy-sxjk-grab-logs.json')
    result.sxjkDingtalkConnectTestFile = join(monitoringDir, 'xy-dingtalk-connect-test.json')
    result.sxjkSellerPlainMapFile = join(monitoringDir, 'xy-sxjk-seller-plain-map.json')
    result.sxjkGuestCookiesFile = join(monitoringDir, 'xy-sxjk-guest-cookies.json')
    result.sxjkListingSnapshotsDir = sxjkListingSnapshotsDir
    result.sxjkLocalDbFile = join(monitoringDir, 'sxjk-local.sqlite')
    result.logsDir = logsDir
    result.configFile = join(configDir, 'app.js')
    const monitoringSettingsFile = join(configDir, 'monitoring-settings.js')
    result.monitoringSettingsFile = monitoringSettingsFile

    if (!existsSync(monitoringSettingsFile)) {
      const defaultFromPack = join(defaultDataPath || '', 'config', 'monitoring-settings.js')
      if (defaultDataPath && existsSync(defaultFromPack)) {
        copyFileSync(defaultFromPack, monitoringSettingsFile)
      } else if (existsSync(BUNDLED_MONITORING_SETTINGS)) {
        copyFileSync(BUNDLED_MONITORING_SETTINGS, monitoringSettingsFile)
      }
    }

    if (defaultDataPath && existsSync(defaultDataPath)) {
      const migrated = migrateDataFromDefault(defaultDataPath, {
        accountsDir,
        monitoringFile: result.monitoringFile,
        logsDir,
        configFile: result.configFile
      })
      result.migrated = migrated
    }

    return result
  } catch (error) {
    console.error('[数据初始化] 初始化失败:', error)
    throw error
  }
}

function migrateDataFromDefault(defaultDataPath, userPaths) {
  let migrated = false

  try {
    const defaultAccountsDir = join(defaultDataPath, 'account')
    const accountsSeedFlag = join(userPaths.accountsDir, ACCOUNTS_BUNDLE_SEED_FLAG)
    if (!existsSync(accountsSeedFlag)) {
      if (existsSync(defaultAccountsDir)) {
        const files = readdirSync(defaultAccountsDir).filter((f) => f.endsWith('.json'))
        for (const file of files) {
          const srcFile = join(defaultAccountsDir, file)
          const destFile = join(userPaths.accountsDir, file)

          if (!existsSync(destFile)) {
            copyFileSync(srcFile, destFile)
            migrated = true
          }
        }
      }
      try {
        mkdirSync(userPaths.accountsDir, { recursive: true })
        writeFileSync(
          accountsSeedFlag,
          JSON.stringify({ finishedAt: new Date().toISOString() }, null, 2),
          'utf-8'
        )
      } catch (e) {
        console.warn('[数据迁移] 写入账户迁移标记失败:', e)
      }
    }

    const defaultMonitoringFile = join(defaultDataPath, 'monitoring', 'monitoring.json')
    if (existsSync(defaultMonitoringFile) && !existsSync(userPaths.monitoringFile)) {
      copyFileSync(defaultMonitoringFile, userPaths.monitoringFile)
      migrated = true
    }

    const defaultLogsDir = join(defaultDataPath, 'logs')
    if (existsSync(defaultLogsDir)) {
      const files = readdirSync(defaultLogsDir).filter(f => f.endsWith('.json'))
      for (const file of files) {
        const srcFile = join(defaultLogsDir, file)
        const destFile = join(userPaths.logsDir, file)

        if (!existsSync(destFile)) {
          copyFileSync(srcFile, destFile)
          migrated = true
        }
      }
    }

    const defaultConfigFile = join(defaultDataPath, 'config', 'app.js')
    if (existsSync(defaultConfigFile) && !existsSync(userPaths.configFile)) {
      copyFileSync(defaultConfigFile, userPaths.configFile)
      migrated = true
    } else if (!existsSync(userPaths.configFile)) {
      createDefaultConfig(userPaths.configFile)
    }

    return migrated
  } catch (error) {
    console.error('[数据迁移] 迁移失败:', error)
    return false
  }
}

function createDefaultConfig(configFile) {
  const defaultConfig = `// 应用配置文件
export default {
  appName: '咸鱼外卖助手',
  configSchemaVersion: 2,
  closeButtonAction: 'tray',
  theme: 'light',
  primaryColor: '#f0a020',
  autoLaunch: false,
  alwaysOnTop: false,
  enablePrivacyMask: true,
  dingtalkWebhook: '',
  dingtalkSecret: '',
  dingtalkRobots: [],
  dingtalkMaxPushPerBatch: 8,
  dingtalkPushCardMode: 'multi',
  dingtalkPushDisplayMode: 'markdown',
  dingtalkPushFields: {"sectionTitle":true,"itemTitle":true,"price":true,"city":true,"time":true,"sellerNick":true,"yanhuobao":true,"sellerCredit":true,"want":true,"buyerCredit":true,"services":true,"link":true}
}
`

  mkdirSync(dirname(configFile), { recursive: true })
  writeFileSync(configFile, defaultConfig, 'utf-8')
}

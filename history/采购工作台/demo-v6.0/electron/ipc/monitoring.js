/**
 * 闲鱼上新监控：监控业务已移除，仅注册与原项目一致的 IPC 名称，返回空数据/不可用
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import defaults from '../config/monitoring-settings.defaults.js'

export function registerMonitoringIPC(ipcMain, monitoringFile, _accountsDir, _monitoringSettingsPath) {
  const monitoringDir = join(monitoringFile, '..')
  fs.mkdir(monitoringDir, { recursive: true }).catch(() => {})

  const settingsPayload = {
    ok: true,
    settings: {
      defaultPollIntervalMs: defaults.defaultPollIntervalMs,
      minPollIntervalMs: defaults.minPollIntervalMs,
      maxPollIntervalMs: defaults.maxPollIntervalMs,
      pollJitterMs: defaults.pollJitterMs,
      defaultPurchaseQuantity: defaults.defaultPurchaseQuantity,
      minPurchaseQuantity: defaults.minPurchaseQuantity,
      maxPurchaseQuantity: defaults.maxPurchaseQuantity
    }
  }

  ipcMain.handle('get-monitoring-runtime-settings', async () => settingsPayload)

  ipcMain.handle('query-monitoring', async () => ({ items: [], total: 0 }))

  const no = async () => ({ ok: false, error: 'not_supported' })
  ipcMain.handle('delete-monitoring', no)
  ipcMain.handle('add-monitoring', no)
  ipcMain.handle('update-monitoring', no)
  ipcMain.handle('start-monitoring', no)
  ipcMain.handle('stop-monitoring', no)
  ipcMain.handle('open-sku-page', no)
}

// 闲鱼上新监控：监控日志仅为占位
import { promises as fs } from 'node:fs'

export function subscribeMonitoringBrowserOverlay() {
  return () => {}
}

export async function getMonitoringLogsChronological() {
  return []
}

export const logMonitoring = {
  info: async () => {},
  success: async () => {},
  warning: async () => {},
  error: async () => {}
}

export function registerMonitoringLogsIPC(ipcMain, logsDir, _monitoringFile) {
  fs.mkdir(logsDir, { recursive: true }).catch(() => {})
  ipcMain.handle('query-monitoring-logs', async () => ({ ok: true, logs: [], total: 0 }))
  ipcMain.handle('get-monitoring-logs', async () => ({ ok: true, logs: [], total: 0 }))
  ipcMain.handle('clear-monitoring-logs', async () => ({ ok: true }))
}

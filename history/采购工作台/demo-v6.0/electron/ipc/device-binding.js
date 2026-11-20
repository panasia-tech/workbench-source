// 设备绑定相关 IPC 模块
// 职责：负责处理设备ID相关的 IPC 通信

import { getDeviceId, validateDeviceId, getOrCreateDeviceId } from '../utils/device-binding.js'
import { APP_PRODUCT } from '../config/app-product.js'
import { buildDeviceInfoPayload } from '../utils/machine-display.js'

/**
 * 注册设备绑定相关的 IPC 处理器
 * @param {import('electron').IpcMain} ipcMain - IPC 主进程对象
 * @param {string} userDataPath - 用户数据目录路径
 */
export function registerDeviceBindingIPC(ipcMain, userDataPath) {
  // 获取设备ID
  ipcMain.handle('get-device-id', async () => {
    try {
      const deviceId = getDeviceId(userDataPath)
      if (deviceId) {
        return { ok: true, deviceId }
      } else {
        // 如果不存在，则创建
        const result = getOrCreateDeviceId(userDataPath, APP_PRODUCT)
        return { ok: true, deviceId: result.deviceId, isNew: result.isNew }
      }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  })

  // 验证设备ID
  ipcMain.handle('validate-device-id', async () => {
    try {
      const result = validateDeviceId(userDataPath)
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, valid: false, reason: String(error) }
    }
  })

  // 重新生成设备ID（用于测试或特殊情况）
  ipcMain.handle('regenerate-device-id', async () => {
    try {
      const result = getOrCreateDeviceId(userDataPath, APP_PRODUCT, { forceNew: true })
      return { ok: true, deviceId: result.deviceId, isNew: result.isNew }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  })

  // 获取设备信息（含 WMI/DMI 品牌机型，见 machine-display.js）
  ipcMain.handle('get-device-info', async () => {
    try {
      const payload = await buildDeviceInfoPayload()
      return {
        ok: true,
        deviceInfo: payload
      }
    } catch (error) {
      return { ok: false, error: String(error) }
    }
  })
}


// 设备硬件绑定工具模块
// 用于生成、存储和验证设备的唯一标识符

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import os from 'node:os'

/** 取排序后首个有效 MAC，避免网卡枚举顺序随重启变化 */
function getStableMacAddress() {
  const candidates = []
  try {
    const networkInterfaces = os.networkInterfaces()
    for (const name of Object.keys(networkInterfaces).sort()) {
      const interfaces = networkInterfaces[name]
      if (!interfaces) continue
      for (const iface of interfaces) {
        if (iface.internal) continue
        const mac = String(iface.mac || '').trim().toLowerCase()
        if (mac && mac !== '00:00:00:00:00:00') {
          candidates.push(mac)
        }
      }
    }
  } catch (error) {
    console.warn('[设备绑定] 获取网络接口信息失败:', error.message)
  }
  candidates.sort()
  return candidates[0] || ''
}

function readWindowsSerialNumber() {
  try {
    const result = execSync('wmic baseboard get serialnumber', {
      encoding: 'utf-8',
      timeout: 5000
    })
    const lines = result.split('\n').filter((line) => line.trim() && !line.includes('SerialNumber'))
    const serial = lines.length > 0 ? lines[0].trim() : ''
    if (serial && !/^default string$/i.test(serial)) return serial
  } catch {
    /* wmic 在 Win11 可能不可用，走 PowerShell 兜底 */
  }

  try {
    const result = execSync(
      'powershell -NoProfile -Command "(Get-CimInstance -ClassName Win32_BIOS).SerialNumber"',
      { encoding: 'utf-8', timeout: 8000 }
    )
    const serial = String(result || '').trim()
    if (serial && !/^default string$/i.test(serial) && !/^to be filled by o\.e\.m\.$/i.test(serial)) {
      return serial
    }
  } catch (error) {
    console.warn('[设备绑定] PowerShell 获取序列号失败:', error.message)
  }

  return ''
}

/**
 * 获取硬件指纹信息
 * 结合多个硬件特征生成唯一标识
 */
function getHardwareFingerprint() {
  const fingerprint = {
    cpuModel: os.cpus()[0]?.model || '',
    cpuCount: os.cpus().length,
    platform: os.platform(),
    arch: os.arch(),
    macAddress: getStableMacAddress(),
    serialNumber: ''
  }

  if (os.platform() === 'darwin') {
    try {
      const result = execSync('system_profiler SPHardwareDataType', {
        encoding: 'utf-8',
        timeout: 5000
      })
      const serialMatch = result.match(/Serial Number \(system\):\s*(.+)/i)
      if (serialMatch && serialMatch[1]) {
        fingerprint.serialNumber = serialMatch[1].trim()
      }
    } catch (error) {
      console.warn('[设备绑定] 获取硬件序列号失败:', error.message)
    }
  }

  if (os.platform() === 'win32') {
    fingerprint.serialNumber = readWindowsSerialNumber()
  }

  return fingerprint
}

/**
 * 根据硬件指纹生成设备ID
 * appProductKey：产品线盐值（JD / XY_GZT / XY_SXJK / TB），不同项目设备码不同，需分别激活
 */
function generateDeviceId(fingerprint, appProductKey = '') {
  const serial = String(fingerprint.serialNumber || '').trim()
  const parts = serial
    ? [serial, fingerprint.platform, fingerprint.arch, fingerprint.cpuModel, String(appProductKey || '')]
    : [
        fingerprint.cpuModel,
        fingerprint.cpuCount.toString(),
        fingerprint.platform,
        fingerprint.arch,
        fingerprint.macAddress,
        String(appProductKey || '')
      ]

  const hash = createHash('sha256')
  hash.update(parts.join('|'))
  return hash.digest('hex').substring(0, 32).toUpperCase()
}

function readStoredDeviceRecord(deviceIdFile) {
  if (!existsSync(deviceIdFile)) return null
  try {
    const data = JSON.parse(readFileSync(deviceIdFile, 'utf-8'))
    const deviceId = String(data?.deviceId || '')
      .trim()
      .toUpperCase()
    if (!deviceId) return null
    return { ...data, deviceId }
  } catch (error) {
    console.warn('[设备绑定] 读取 device-id.json 失败:', error?.message || error)
    return null
  }
}

function persistDeviceIdFile(deviceIdFile, data) {
  mkdirSync(dirname(deviceIdFile), { recursive: true })
  const payload = JSON.stringify(data, null, 2)
  try {
    const tmp = `${deviceIdFile}.${process.pid}.tmp`
    writeFileSync(tmp, payload, 'utf-8')
    renameSync(tmp, deviceIdFile)
    return true
  } catch (e) {
    try {
      writeFileSync(deviceIdFile, payload, 'utf-8')
      return true
    } catch (e2) {
      console.error('[设备绑定] 写入 device-id.json 失败:', e2?.message || e2)
      return false
    }
  }
}

function buildDeviceRecord(deviceId, fingerprint, appProduct, createdAt) {
  const now = new Date().toISOString()
  return {
    deviceId,
    fingerprint,
    appProduct,
    createdAt: createdAt || now,
    updatedAt: now
  }
}

/**
 * @param {string} userDataPath
 * @param {string} appProduct JD | XY_GZT | XY_SXJK | TB，与后端 app_product 一致
 * @param {{ forceNew?: boolean }} [opts] forceNew：测试用强制重算（会毁掉已激活码，默认 false）
 */
export function getOrCreateDeviceId(userDataPath, appProduct = 'JD', opts = {}) {
  const deviceIdFile = join(userDataPath, 'device-id.json')
  const forceNew = opts?.forceNew === true

  try {
    if (!forceNew) {
      const stored = readStoredDeviceRecord(deviceIdFile)
      if (stored?.deviceId) {
        const currentFingerprint = getHardwareFingerprint()
        const storedProduct = stored.appProduct
        const legacyNoProduct = storedProduct == null || storedProduct === ''
        const sameProduct = legacyNoProduct || String(storedProduct) === String(appProduct)

        if (sameProduct) {
          const next = buildDeviceRecord(
            stored.deviceId,
            currentFingerprint,
            legacyNoProduct ? appProduct : storedProduct,
            stored.createdAt
          )
          if (!persistDeviceIdFile(deviceIdFile, next)) {
            console.warn('[设备绑定] 刷新指纹落盘失败，仍使用已存设备ID')
          }
          return {
            deviceId: stored.deviceId,
            isNew: false,
            fingerprint: currentFingerprint
          }
        }

        console.warn(
          '[设备绑定] device-id.json 产品线为',
          storedProduct,
          '与当前应用',
          appProduct,
          '不一致，将重新生成'
        )
      }
    }

    const fingerprint = getHardwareFingerprint()
    const deviceId = generateDeviceId(fingerprint, appProduct)
    const data = buildDeviceRecord(deviceId, fingerprint, appProduct)

    if (!persistDeviceIdFile(deviceIdFile, data)) {
      console.error('[设备绑定] 新设备ID落盘失败，本次会话可能在下一次启动变更')
    }

    return {
      deviceId,
      isNew: true,
      fingerprint
    }
  } catch (error) {
    console.error('[设备绑定] 获取设备ID失败:', error)

    const stored = readStoredDeviceRecord(deviceIdFile)
    if (stored?.deviceId) {
      return {
        deviceId: stored.deviceId,
        isNew: false,
        fingerprint: getHardwareFingerprint(),
        error: error.message
      }
    }

    const fingerprint = getHardwareFingerprint()
    const deviceId = generateDeviceId(fingerprint, appProduct)
    persistDeviceIdFile(deviceIdFile, buildDeviceRecord(deviceId, fingerprint, appProduct))

    return {
      deviceId,
      isNew: true,
      fingerprint,
      error: error.message
    }
  }
}

/**
 * 获取设备ID（不创建，仅读取）
 */
export function getDeviceId(userDataPath) {
  const deviceIdFile = join(userDataPath, 'device-id.json')
  const stored = readStoredDeviceRecord(deviceIdFile)
  return stored?.deviceId || null
}

/**
 * 验证设备ID是否有效
 */
export function validateDeviceId(userDataPath) {
  const deviceIdFile = join(userDataPath, 'device-id.json')

  try {
    const stored = readStoredDeviceRecord(deviceIdFile)
    if (!stored?.deviceId) {
      return { valid: false, reason: '设备ID文件不存在或无效' }
    }

    const currentFingerprint = getHardwareFingerprint()

    if (!stored.fingerprint) {
      return { valid: true, deviceId: stored.deviceId }
    }

    const storedFingerprint = stored.fingerprint
    const isMatch =
      storedFingerprint.cpuModel === currentFingerprint.cpuModel &&
      storedFingerprint.cpuCount === currentFingerprint.cpuCount &&
      storedFingerprint.platform === currentFingerprint.platform &&
      storedFingerprint.arch === currentFingerprint.arch

    if (!isMatch) {
      return { valid: false, reason: '硬件指纹不匹配，可能已更换设备' }
    }

    return { valid: true, deviceId: stored.deviceId }
  } catch (error) {
    return { valid: false, reason: `验证失败: ${error.message}` }
  }
}

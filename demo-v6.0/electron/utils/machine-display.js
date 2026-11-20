/**
 * 组装管理端展示字段 + 详细硬件快照（device_detail，入库 JSON）
 */
import os from 'node:os'

/** 控制单行入库体积（MySQL TEXT 上限约 64KB） */
function trimSnapshotForTransport(obj, maxChars) {
  let s = JSON.stringify(obj)
  if (s.length <= maxChars) return obj
  const lean = {
    ...obj,
    disks: Array.isArray(obj.disks) ? obj.disks.slice(0, 4) : obj.disks,
    network: Array.isArray(obj.network) ? obj.network.slice(0, 6) : obj.network,
    graphics: Array.isArray(obj.graphics) ? obj.graphics.slice(0, 3) : obj.graphics,
    _truncated: true
  }
  s = JSON.stringify(lean)
  if (s.length <= maxChars) return lean
  return {
    collectedAt: obj.collectedAt,
    runtime: obj.runtime,
    system: obj.system,
    os: obj.os,
    cpu: obj.cpu,
    memory: obj.memory,
    bios: obj.bios,
    baseboard: obj.baseboard,
    _truncated: true
  }
}

/** 常见 BIOS 占位符，无展示价值 */
function isPlaceholderModel(s) {
  if (!s || !String(s).trim()) return true
  const t = String(s).trim()
  return /^(unknown|default string|system product name|to be filled|o\.e\.m\.|default string)$/i.test(
    t
  )
}

export async function getHardwareProductLine() {
  let manufacturer = ''
  let model = ''
  try {
    const { default: si } = await import('systeminformation')
    const sys = await si.system()
    manufacturer = String(sys.manufacturer || '').trim()
    model = String(sys.model || '').trim()
  } catch {
    /* ignore */
  }

  if (isPlaceholderModel(manufacturer)) manufacturer = ''
  if (isPlaceholderModel(model)) model = ''

  const parts = [manufacturer, model].filter(Boolean)
  const hardwareLabel = parts.join(' ').trim()
  return { hardwareLabel, manufacturer, model }
}

/**
 * 详细快照（写入 mz_user.last_login_device_detail，JSON）
 */
export async function buildDeviceDetailSnapshot() {
  const { default: si } = await import('systeminformation')
  const snap = {
    collectedAt: new Date().toISOString(),
    runtime: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome
    }
  }

  try {
    const [system, osInfo, cpu, mem, graphics, diskLayout, baseboard, bios, net] = await Promise.all([
      si.system().catch(() => null),
      si.osInfo().catch(() => null),
      si.cpu().catch(() => null),
      si.mem().catch(() => null),
      si.graphics().catch(() => null),
      si.diskLayout().catch(() => null),
      si.baseboard().catch(() => null),
      si.bios().catch(() => null),
      si.networkInterfaces().catch(() => null)
    ])

    if (system) {
      snap.system = {
        manufacturer: system.manufacturer,
        model: system.model,
        version: system.version,
        serial: system.serial,
        sku: system.sku,
        virtual: system.virtual,
        virtualHost: system.virtualHost
      }
    }
    if (osInfo) {
      snap.os = {
        platform: osInfo.platform,
        distro: osInfo.distro,
        release: osInfo.release,
        codename: osInfo.codename,
        kernel: osInfo.kernel,
        arch: osInfo.arch,
        hostname: osInfo.hostname,
        fqdn: osInfo.fqdn,
        build: osInfo.build
      }
    }
    if (cpu) {
      snap.cpu = {
        manufacturer: cpu.manufacturer,
        brand: cpu.brand,
        speed: cpu.speed,
        speedMin: cpu.speedMin,
        speedMax: cpu.speedMax,
        cores: cpu.cores,
        physicalCores: cpu.physicalCores,
        processors: cpu.processors,
        socket: cpu.socket,
        vendor: cpu.vendor,
        family: cpu.family,
        stepping: cpu.stepping
      }
    }
    if (mem) {
      snap.memory = {
        total: mem.total,
        free: mem.free,
        used: mem.used,
        active: mem.active,
        available: mem.available,
        totalGb: Math.round((mem.total / 1024 ** 3) * 100) / 100,
        freeGb: Math.round((mem.free / 1024 ** 3) * 100) / 100
      }
    }
    if (graphics?.controllers?.length) {
      snap.graphics = graphics.controllers.slice(0, 8).map((c) => ({
        vendor: c.vendor,
        model: c.model,
        bus: c.bus,
        vram: c.vram,
        vramDynamic: c.vramDynamic,
        subDeviceId: c.subDeviceId
      }))
    }
    if (Array.isArray(diskLayout) && diskLayout.length) {
      snap.disks = diskLayout.slice(0, 12).map((d) => ({
        type: d.type,
        name: d.name,
        vendor: d.vendor,
        size: d.size,
        sizeGb: d.size != null ? Math.round((d.size / 1024 ** 3) * 100) / 100 : null,
        serialNum: d.serialNum
      }))
    }
    if (baseboard) {
      snap.baseboard = {
        manufacturer: baseboard.manufacturer,
        model: baseboard.model,
        version: baseboard.version,
        serial: baseboard.serial,
        assetTag: baseboard.assetTag
      }
    }
    if (bios) {
      snap.bios = {
        vendor: bios.vendor,
        version: bios.version,
        releaseDate: bios.releaseDate,
        revision: bios.revision
      }
    }
    if (Array.isArray(net)) {
      snap.network = net
        .filter((n) => n && !n.internal && (n.ip4 || n.mac))
        .slice(0, 16)
        .map((n) => ({
          iface: n.iface,
          ifaceName: n.ifaceName,
          ip4: n.ip4,
          ip4subnet: n.ip4subnet,
          mac: n.mac,
          type: n.type,
          speed: n.speed,
          default: n.default
        }))
    }
  } catch (e) {
    snap._collectError = String(e?.message || e)
  }

  return snap
}

/**
 * @returns {Promise<Record<string, unknown> & { device_detail: object }>}
 */
export async function buildDeviceInfoPayload() {
  const platform = os.platform()
  const arch = os.arch()
  const type = os.type()
  const release = os.release()
  const hostname = os.hostname()
  const osLine = `${type} ${arch} ${release}`

  const { hardwareLabel } = await getHardwareProductLine()

  let device = hostname || ''
  if (!device) {
    if (platform === 'darwin') device = 'Mac'
    else if (platform === 'win32') device = 'Windows PC'
    else if (platform === 'linux') device = 'Linux'
    else device = type || platform
  }
  if (device.length > 200) device = device.slice(0, 197) + '...'

  const deviceType = 'desktop'
  const deviceModel = hardwareLabel ? `${hardwareLabel} · ${osLine}` : osLine

  let device_detail = await buildDeviceDetailSnapshot()
  device_detail = trimSnapshotForTransport(device_detail, 58000)

  return {
    device,
    deviceType,
    deviceModel,
    platform,
    arch,
    hostname,
    osType: type,
    osRelease: release,
    device_detail
  }
}

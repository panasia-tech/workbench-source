// 密码库填进 AdsPower（11-17）：这台电脑领台账密码库里要填的账号，写进本机 AdsPower 环境（自动填充用）。
//
// 不走群控（任务内容会明文留在群控库和操作留痕里）。流程：
//   1. 第一次用时生成一对 X25519 密钥。私钥用系统加密（Windows DPAPI / safeStorage）存在本机；系统加密用不了就
//      不干——绝不退回明文存（和 WMS 密钥同一个口径，见 store.js setWmsSecrets）；
//   2. 公钥连同电脑 id 交给 ERP，等密码库主人在台账「密码库」页对着指纹批准（界面上显示同一串指纹）；
//   3. 批准后每分钟带上本机 AdsPower 的全部环境 id 去领要填的，领到的是按本机公钥加密的包；
//   4. 解包 → user/update 写 → 读回来核对 → 把包里的回执交回去（算法见 vault-ads-core.js）。
// 明文只在 processItem 那一小段里，不打日志、不过 IPC、不落盘。
import electron from 'electron'
import Store from 'electron-store'
import { vaultAdsPoll, vaultAdsResult, vaultStationRegister, vaultStationState } from './api.js'
import { adsAllProfileIds, adsReadAccount, adsWriteAccount } from './adspower.js'
import { getToken } from './store.js'
import { fingerprint, newKeyPair, processItem } from './vault-ads-core.js'
import { deviceId, deviceName } from './workbench-device.js'

const { safeStorage } = electron
const store = new Store({ name: 'xianyu-vault-ads' })
const TICK_MS = 60_000

let timer = null
let running = false
let registeredKey = ''
let state = { fingerprint: '', status: 'unknown', statusLabel: '还没登记', lastRunAt: null, lastError: '', filled: 0, failed: 0 }
const listeners = new Set()

function emit() {
  for (const fn of listeners) {
    try { fn(getState()) } catch { /* 界面关了 */ }
  }
}

export function getState() { return { ...state } }
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn) }

/** 本机私钥（PKCS8 DER）和公钥。没有就生成；系统加密用不了返回 null。 */
function keys() {
  if (!safeStorage.isEncryptionAvailable()) return null
  const enc = store.get('privEnc')
  if (enc) {
    try {
      const privDer = Buffer.from(safeStorage.decryptString(Buffer.from(enc, 'base64')), 'base64')
      return { privDer, pubB64: store.get('pubB64') }
    } catch {
      // 解不开（换了 Windows 用户、系统重装）：只能换一对新的，主人要重新批准
    }
  }
  const { privDer, pubB64 } = newKeyPair()
  store.set('privEnc', safeStorage.encryptString(privDer.toString('base64')).toString('base64'))
  store.set('pubB64', pubB64)
  return { privDer, pubB64 }
}

function setState(patch) {
  state = { ...state, ...patch }
  emit()
}

function reason(error) {
  const d = error?.response?.data?.detail
  return typeof d === 'string' ? d : String(error?.message || error || '出错了').slice(0, 160)
}

/** 跑一轮：登记 / 看批没批 / 领 / 填。手动「现在检查」也走这里。 */
export async function runOnce() {
  if (running || !getToken()) return getState()
  running = true
  try {
    const k = keys()
    if (!k) {
      setState({ status: 'no_safe_storage', statusLabel: '这台电脑没法安全保存密钥，不能填密码', lastError: '' })
      return getState()
    }
    const stationId = deviceId()
    setState({ fingerprint: fingerprint(k.pubB64) })
    let st
    if (registeredKey !== k.pubB64) {
      st = await vaultStationRegister({ station_id: stationId, name: deviceName(), public_key: k.pubB64 })
      registeredKey = k.pubB64
    } else {
      st = await vaultStationState(stationId)
    }
    if (!st.registered) {
      registeredKey = ''
      setState({ status: 'unknown', statusLabel: '还没登记' })
      return getState()
    }
    setState({ status: st.status, statusLabel: st.status === 'trusted' ? '已批准，会自动填' : st.status_label })
    if (st.status !== 'trusted') return getState()

    const ids = await adsAllProfileIds()
    if (ids === null) {
      setState({ lastError: 'AdsPower 免费版列不出全部环境，没法知道该填哪些', lastRunAt: new Date().toISOString() })
      return getState()
    }
    const items = await vaultAdsPoll(stationId, ids)
    let filled = 0
    let failed = 0
    let lastError = ''
    for (const item of items) {
      let res
      try {
        res = await processItem(item, { privDer: k.privDer, stationId, write: adsWriteAccount, read: adsReadAccount })
      } catch (error) {
        // 解不开：不是给这台电脑的（或者换过密钥）。没有回执交不了，等服务端 5 分钟后放给别的工位
        failed += 1
        lastError = `有一条解不开：${reason(error)}`
        continue
      }
      try {
        await vaultAdsResult({ station_id: stationId, item_id: item.item_id, ...res })
      } catch (error) {
        lastError = `回执没交上：${reason(error)}`
      }
      if (res.ok && res.verified) filled += 1
      else {
        failed += 1
        lastError = res.error || lastError
      }
    }
    setState({ lastRunAt: new Date().toISOString(), filled: state.filled + filled, failed: state.failed + failed, lastError })
  } catch (error) {
    setState({ lastError: reason(error), lastRunAt: new Date().toISOString() })
  } finally {
    running = false
  }
  return getState()
}

export function start() {
  if (timer) return
  void runOnce()
  timer = setInterval(() => { void runOnce() }, TICK_MS)
}

export function stop() {
  if (timer) clearInterval(timer)
  timer = null
}

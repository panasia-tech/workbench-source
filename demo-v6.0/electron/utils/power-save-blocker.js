import { powerSaveBlocker } from 'electron'

let blockerId = null

/**
 * 阻止系统休眠（监听、定时任务在合盖/长时间空闲时仍可跑）。
 * @param {boolean} enabled
 */
export function applyPreventSleep(enabled) {
  const on = enabled === true
  if (on) {
    if (blockerId != null && powerSaveBlocker.isStarted(blockerId)) {
      return { ok: true, active: true }
    }
    blockerId = powerSaveBlocker.start('prevent-app-suspension')
    console.log('[防休眠] 防休眠已开启', blockerId)
    return { ok: true, active: true }
  }
  if (blockerId != null && powerSaveBlocker.isStarted(blockerId)) {
    powerSaveBlocker.stop(blockerId)
    console.log('[防休眠] 防休眠已关闭')
  }
  blockerId = null
  return { ok: true, active: false }
}

export function isPreventSleepActive() {
  return blockerId != null && powerSaveBlocker.isStarted(blockerId)
}

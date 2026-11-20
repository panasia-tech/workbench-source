/**
 * 已成功推送钉钉的商品 itemId（全局、跨任务去重）— SQLite
 */
import {
  getSxjkLocalDb,
  getPushedItemIds,
  appendPushedItemIds,
  PUSHED_SCOPE
} from '../utils/sxjk-local-db.js'

const MAX_IDS = 5000

export function registerSxjkPushedItemIdsIPC(ipcMain) {
  ipcMain.handle('get-sxjk-pushed-item-ids', async () => {
    try {
      const ids = getPushedItemIds(getSxjkLocalDb(), PUSHED_SCOPE.global)
      return { ok: true, ids }
    } catch (e) {
      return { ok: false, error: String(e.message || e), ids: [] }
    }
  })

  ipcMain.handle('append-sxjk-pushed-item-ids', async (_e, newIds) => {
    try {
      const ids = appendPushedItemIds(getSxjkLocalDb(), PUSHED_SCOPE.global, newIds, MAX_IDS)
      return { ok: true, ids }
    } catch (e) {
      return { ok: false, error: String(e.message || e), ids: [] }
    }
  })
}

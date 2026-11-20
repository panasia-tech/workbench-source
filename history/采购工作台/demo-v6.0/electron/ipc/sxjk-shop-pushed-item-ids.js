/**
 * 店铺已推商品 itemId — SQLite
 */
import {
  getSxjkLocalDb,
  getPushedItemIds,
  appendPushedItemIds,
  PUSHED_SCOPE
} from '../utils/sxjk-local-db.js'

const MAX_IDS = 5000

export function registerSxjkShopPushedItemIdsIPC(ipcMain) {
  ipcMain.handle('get-sxjk-shop-pushed-item-ids', async () => {
    try {
      const ids = getPushedItemIds(getSxjkLocalDb(), PUSHED_SCOPE.shop)
      return { ok: true, ids }
    } catch (e) {
      return { ok: false, error: String(e.message || e), ids: [] }
    }
  })

  ipcMain.handle('append-sxjk-shop-pushed-item-ids', async (_e, newIds) => {
    try {
      const ids = appendPushedItemIds(getSxjkLocalDb(), PUSHED_SCOPE.shop, newIds, MAX_IDS)
      return { ok: true, ids }
    } catch (e) {
      return { ok: false, error: String(e.message || e), ids: [] }
    }
  })
}

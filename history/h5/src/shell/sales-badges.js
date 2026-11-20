// 销售工作台的菜单红点（电脑侧边菜单、顶栏「真实任务先锁着」用）：/api/sales-workbench/badges。
// 只有销售、管理员拉；切页时顺手刷新，但 30 秒内不重复拉（后端每人也缓存 60 秒）
import { ref } from 'vue'
import requestModule from '../overrides/services/request.js'

const { request } = requestModule
const ROLES = ['SALES', 'ADMIN']
const MIN_GAP_MS = 30000

export const salesBadges = ref(null)
let last = 0
let pending = null

export function refreshSalesBadges(role, force = false) {
  if (!ROLES.includes(role)) {
    salesBadges.value = null
    return Promise.resolve(null)
  }
  if (pending || (!force && Date.now() - last < MIN_GAP_MS)) return pending || Promise.resolve(salesBadges.value)
  last = Date.now()
  pending = request({ url: '/api/sales-workbench/badges', _noAuthRedirect: true })
    .then((b) => { salesBadges.value = b || null; return b })
    .catch(() => salesBadges.value)
    .finally(() => { pending = null })
  return pending
}

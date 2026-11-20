export const staffRoleLabels = {
  ADMIN: '管理员',
  PURCHASER: '采购',
  WAREHOUSE: '仓管',
  NEGOTIATOR: '议价员',
  BUSINESS: '业务员',
  SALES: '销售',
  FINANCE: '财务',
  RFID_DEVICE: 'RFID设备',
  CRAWLER: '行情爬虫',
}

export const staffRoleTypes = {
  ADMIN: 'danger',
  PURCHASER: '',
  WAREHOUSE: 'warning',
  NEGOTIATOR: 'info',
  BUSINESS: 'warning',
  SALES: 'success',
  FINANCE: '',
  RFID_DEVICE: 'info',
  CRAWLER: 'info',
}

export const staffStatusLabels = {
  PENDING: '待激活',
  ACTIVE: '正常',
  DISABLED: '已禁用',
}

export const staffStatusTypes = {
  PENDING: 'info',
  ACTIVE: 'success',
  DISABLED: 'danger',
}

export const orderStatusLabels = {
  PENDING_INSPECT: '待验货',
  IN_STOCK: '在库',
  SHIPPED: '已出库',
  LOSS: '盘亏',
  CANCELLED: '已取消',
}

export const orderStatusTypes = {
  PENDING_INSPECT: 'warning',
  IN_STOCK: 'success',
  SHIPPED: '',
  LOSS: 'danger',
  CANCELLED: 'info',
}

export const skuStatusLabels = {
  IN_STOCK: '在库',
  SHIPPED: '已出库',
  LOSS: '盘亏',
}

export const skuStatusTypes = {
  IN_STOCK: 'success',
  SHIPPED: '',
  LOSS: 'danger',
}

export const inspectionStatusLabels = {
  PENDING: '待验货',
  DONE: '已完成',
}

export const inspectionStatusTypes = {
  PENDING: 'warning',
  DONE: 'success',
}

export const saleOrderStatusLabels = {
  PENDING: '待发货',
  SHIPPED: '已发货',
  COMPLETED: '已完成',
}

export const saleOrderStatusTypes = {
  PENDING: 'warning',
  SHIPPED: '',
  COMPLETED: 'success',
}

export const stocktakeStatusLabels = {
  IN_PROGRESS: '盘点中',
  PAUSED: '已暂停',
  COMPLETED: '有差异',
  PENDING_APPROVAL: '审批中',
  APPROVED: '账实相符',
  REJECTED: '已驳回',
}

export const stocktakeStatusTypes = {
  IN_PROGRESS: 'info',
  PAUSED: 'warning',
  COMPLETED: '',
  PENDING_APPROVAL: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
}

export const proposalStatusLabels = {
  PROPOSED: '已标记',
  PENDING: '待审批',
  APPROVED: '已通过',
  REJECTED: '已驳回',
  APPLIED: '已平账',
  SKIPPED: '已忽略',
}

export const autoListingStageLabels = {
  RESOLVING: '解析中',
  COLLECTING: '等行情',
  WAIT_NEGOTIATION: '等议价',
  READY: '待发布',
  PUBLISHING: '发布中',
  DONE: '已上架',
  NEEDS_HUMAN: '转人工',
  FAILED: '失败',
}

export const autoListingStageTypes = {
  RESOLVING: 'info',
  COLLECTING: 'info',
  WAIT_NEGOTIATION: 'warning',
  READY: 'primary',
  PUBLISHING: 'primary',
  DONE: 'success',
  NEEDS_HUMAN: 'danger',
  FAILED: 'danger',
}

export function formatPrice(value) {
  if (value == null || value === '') return '—'
  return `¥${Number(value).toFixed(2)}`
}

export function formatDateTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return value
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

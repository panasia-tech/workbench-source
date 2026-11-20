import api from '../../../../../../miniprogram/services/api.js'
import { desktopPager, commonMethods } from '../../../lib/pager.js'

// 出库记录（电脑版）：表格 + 页码。类型标签跟手机版 index.js 里的 enrich 一致（那边没导出，这里照抄一份）
const TYPE_LABEL = { ORDER_SHIP: '发货', MANUAL: '手动', PICKUP: '自提', SWITCH: '切单' }
const TYPE_TAG = { ORDER_SHIP: 'tag-info', MANUAL: 'tag-info', PICKUP: 'tag-success', SWITCH: 'tag-pending' }

const pager = desktopPager({
  fetch: (params) => api.listOutbounds(params).then((res) => ({
    ...res,
    items: (res.items || []).map((item) => ({
      ...item,
      typeLabel: TYPE_LABEL[item.outbound_type] || '出库',
      typeTag: TYPE_TAG[item.outbound_type] || 'tag-pending',
    })),
  })),
  params() {
    const { q, typeKey, dateFrom, dateTo } = this.data
    const p = { mine: true }
    if (typeKey) p.outbound_type = typeKey
    if (q) p.q = q
    if (dateFrom) p.date_from = dateFrom
    if (dateTo) p.date_to = dateTo
    return p
  },
})

export default {
  data: { ...pager.data },
  methods: {
    ...pager.methods,
    ...commonMethods,

    dkClearDates() {
      if (!this.data.dateFrom && !this.data.dateTo) return
      this.setData({ dateFrom: '', dateTo: '' }, () => this.reload())
    },
  },
}

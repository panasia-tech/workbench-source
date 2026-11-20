import api from '../../../../../../miniprogram/services/api.js'
import { desktopPager, commonMethods } from '../../../lib/pager.js'

// 销售记录（电脑版）：表格 + 页码；状态、关键词、日期跟手机版同一套筛选
const pager = desktopPager({
  fetch: (params) => api.listSales(params),
  params() {
    const { q, status, dateFrom, dateTo } = this.data
    const p = {}
    if (q) p.q = q
    if (status) p.status = status
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

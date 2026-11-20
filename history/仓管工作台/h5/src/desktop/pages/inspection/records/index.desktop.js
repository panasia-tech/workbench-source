import api from '../../../../../../miniprogram/services/api.js'
import { desktopPager, commonMethods } from '../../../lib/pager.js'

// 验货记录（电脑版）：表格 + 页码（每页 50）。筛选和手机版一样：关键词、日期起止、状态
// 手机上状态是「再点一次取消」，电脑上摆成「全部 / 待验货 / 已完成」三个 tab
const pager = desktopPager({
  fetch: (params) => api.listInspection(params),
  params() {
    const { q, dateFrom, dateTo, status } = this.data
    const p = {}
    if (q) p.q = q
    if (dateFrom) p.date_from = dateFrom
    if (dateTo) p.date_to = dateTo
    if (status) p.status = status
    return p
  },
})

export default {
  data: { ...pager.data },
  methods: {
    ...pager.methods,
    ...commonMethods,

    dkAllStatus() {
      if (!this.data.status) return
      this.setData({ status: '' }, () => this.reload())
    },

    dkPickStatus(e) {
      const { status } = e.currentTarget.dataset
      if (status === this.data.status) return
      this.setData({ status }, () => this.reload())
    },

    dkClearDates() {
      this.setData({ dateFrom: '', dateTo: '' }, () => this.reload())
    },
  },
}

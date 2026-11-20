import api from '../../../../../../miniprogram/services/api.js'
import { desktopPager, commonMethods } from '../../../lib/pager.js'

// 采购记录（电脑版）：表格 + 页码（每页 50）；筛选条件和手机版一样（关键词、录入日期起止）
// 这页小程序没有 .wxss，所以电脑版也没法挂补充样式，模板里只用 dk- 通用类 + 少量行内样式
const pager = desktopPager({
  fetch: (params) => api.listPurchase(params),
  params() {
    const { q, dateFrom, dateTo } = this.data
    const p = {}
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
      this.setData({ dateFrom: '', dateTo: '' }, () => this.reload())
    },
  },
}

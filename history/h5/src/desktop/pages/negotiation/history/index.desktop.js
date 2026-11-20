import api from '../../../../../../miniprogram/services/api.js'
import { desktopPager, commonMethods } from '../../../lib/pager.js'

// 议价记录（电脑版）：表格 + 页码（每页 50 条），筛选条件和手机版同一套
const pager = desktopPager({
  fetch: (params) => api.listNegotiationHistory(params),
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

    // 手机版只能分别改开始/结束日，电脑上多一个「清除日期」
    dkClearDate() {
      this.setData({ dateFrom: '', dateTo: '' }, () => this.reload())
    },
  },
}

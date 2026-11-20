import api from '../../../../../../miniprogram/services/api.js'
import { desktopPager, commonMethods } from '../../../lib/pager.js'

// 拒签记录（电脑版）：表格 + 页码（每页 50）。查询条件和手机版一样：已完成且 action_type=REJECT，加关键词和日期
const pager = desktopPager({
  fetch: (params) => api.listInspection(params),
  params() {
    const { q, dateFrom, dateTo } = this.data
    const p = { status: 'DONE', action_type: 'REJECT' }
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
  },
}

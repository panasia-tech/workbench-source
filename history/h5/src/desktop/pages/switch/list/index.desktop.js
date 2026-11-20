import api from '../../../../../../miniprogram/services/api.js'
import { desktopPager } from '../../../lib/pager.js'

// 切单管理（电脑版）：表格 + 页码（每页 50 条），顶替 reload / loadMore
const pager = desktopPager({
  fetch: (params) => api.listSwitch(params),
  params: () => ({}),
})

export default {
  data: { ...pager.data },
  methods: { ...pager.methods },
}

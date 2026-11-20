import api from '../../../../../miniprogram/services/api.js'
import { desktopPager, commonMethods } from '../../lib/pager.js'

// 手机号管理（电脑版）：表格 + 页码
const pager = desktopPager({
  fetch: (params) => api.listPhones(params),
  params() {
    const q = (this.data.q || '').trim()
    return q ? { q } : {}
  },
})

export default {
  data: { ...pager.data },
  methods: {
    ...pager.methods,
    ...commonMethods,
  },
}

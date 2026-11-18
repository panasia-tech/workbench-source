import api from '../../../../../../miniprogram/services/api.js'
import { desktopPager } from '../../../lib/pager.js'

// 货号更换（电脑版）：表格 + 页码（每页 50）；换号弹层改成居中对话框，提交还是原页面的 submitRecode
const pager = desktopPager({
  fetch: (params) => api.listSkuMigration(params),
  params() {
    return { tab: this.data.tab, q: (this.data.q || '').trim() }
  },
})

export default {
  data: { ...pager.data },
  methods: {
    ...pager.methods,
    dkNoop() {},
  },
}

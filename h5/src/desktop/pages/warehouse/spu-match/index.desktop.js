import api from '../../../../../../miniprogram/services/api.js'
import { desktopPager } from '../../../lib/pager.js'

// 商品匹配（电脑版）：表格 + 页码（每页 50）。状态标签的配色和原页面 decorate 一样（原函数不导出，抄一份）
const STATE_TAG = { NORMAL: 'tag-success', CONFLICT: 'tag-warning', NONE: 'tag-danger' }

function decorate(items = []) {
  return items.map((item) => ({
    ...item,
    tagClass: item.state ? STATE_TAG[item.state] : (item.match_status === 'CONFIRMED' ? 'tag-success' : 'tag-warning'),
    tagText: item.state_title || item.match_label,
  }))
}

const pager = desktopPager({
  fetch: (params) => api.listSpuMatch(params).then((res) => ({ ...res, items: decorate(res.items) })),
  params() {
    return { tab: this.data.tab, q: this.data.q }
  },
})

export default {
  data: { ...pager.data },
  methods: { ...pager.methods },
}

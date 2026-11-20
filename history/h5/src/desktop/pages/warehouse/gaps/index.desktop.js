import api from '../../../../../../miniprogram/services/api.js'
import { desktopPager } from '../../../lib/pager.js'

// 库存缺口（电脑版）：表格 + 页码（每页 50）。种类 tab 的件数、标签配色照原页面 fetch 里的算法（原常量不导出，抄一份）
const KIND_TAG = {
  unresolved: 'tag-warning',
  no_price: 'tag-info',
  no_image: 'tag-warning',
  below_cost: 'tag-danger',
  unlisted: 'tag-success',
  other: 'tag-pending',
}

const pager = desktopPager({
  fetch: (params) => api.listStockGaps(params).then((res) => ({
    ...res,
    items: (res.items || []).map((x) => ({ ...x, tagClass: KIND_TAG[x.kind] || 'tag-pending' })),
  })),
  params() {
    const p = {}
    if (this.data.kind) p.kind = this.data.kind
    if (this.data.q.trim()) p.q = this.data.q.trim()
    return p
  },
  after(res) {
    const all = (res.kinds || []).reduce((n, k) => n + k.total, 0)
    this.setData({ kinds: [{ key: '', label: '全部', total: all }].concat(res.kinds || []) })
  },
})

export default {
  data: { ...pager.data },
  methods: {
    ...pager.methods,
    dkNoop() {},
  },
}

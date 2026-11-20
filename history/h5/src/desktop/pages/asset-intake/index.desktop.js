import api from '../../../../../miniprogram/services/api.js'
import { desktopPager, commonMethods } from '../../lib/pager.js'

// 资产录入列表（电脑版）：表格 + 页码；状态标签色和手机版 decorate 一致
const STATUS_TAG = {
  pending: 'tag-warning',
  listing: 'tag-info',
  on_sale: 'tag-success',
  to_ship: 'tag-warning',
  sold: 'tag-pending',
  locked: 'tag-pending',
  loss: 'tag-danger',
  split: 'tag-pending',
}

const pager = desktopPager({
  fetch: (params) => api.listAssetIntakes(params).then((res) => ({
    ...res,
    items: (res.items || []).map((item) => ({ ...item, statusCls: STATUS_TAG[item.status] || 'tag-pending' })),
  })),
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

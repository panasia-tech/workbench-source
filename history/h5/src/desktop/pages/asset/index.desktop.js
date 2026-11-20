import api from '../../../../../miniprogram/services/api.js'
import { desktopPager, commonMethods } from '../../lib/pager.js'

// 资产管理（电脑版）：表格 + 页码。行数据的加工（状态文案、缩略图）和手机版 decorate 一致
const STATUS_META = {
  IDLE: { text: '在库', cls: 'tag-info' },
  IN_USE: { text: '使用中', cls: 'tag-success' },
  SCRAPPED: { text: '已报废', cls: 'tag-warning' },
  SOLD: { text: '已售出', cls: 'tag-danger' },
}

function decorate(item) {
  const meta = STATUS_META[item.status] || STATUS_META.IDLE
  const firstHttp = (arr) => (arr || []).find((u) => /^https?:\/\//.test(u)) || ''
  const thumb = firstHttp(item.image_files) || firstHttp(item.product_images)
  return { ...item, statusText: meta.text, statusCls: meta.cls, thumb }
}

const pager = desktopPager({
  fetch: (params) => api.listAssets(params).then((res) => ({ ...res, items: (res.items || []).map(decorate) })),
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

import api from '../../../../../miniprogram/services/api.js'
import { desktopPager, commonMethods } from '../../lib/pager.js'

// 仓库（电脑版）：表格 + 页码；标签筛选直接平铺成一排，点一下就筛，不用弹层
const pager = desktopPager({
  silent: true,
  fetch: (params) => api.listSkus(params),
  params() {
    const { q, listTab, selectedTags } = this.data
    const p = listTab === 'all' ? { in_warehouse: true } : { phase: listTab }
    if (q) p.q = q
    if (selectedTags && selectedTags.length) p.tags = selectedTags.join(',')
    return p
  },
  after(res, page) {
    this.setData({ legacyMatches: page === 1 ? (res.legacy_matches || []) : [] })
  },
})

export default {
  data: { ...pager.data },
  methods: {
    ...pager.methods,
    ...commonMethods,

    dkToggleTag(e) {
      const { name } = e.currentTarget.dataset
      if (!name) return
      const selected = this.data.selectedTags.slice()
      const i = selected.indexOf(name)
      if (i >= 0) selected.splice(i, 1)
      else selected.push(name)
      this.setData({ selectedTags: selected, tagSheetDraft: selected.slice() })
      this.reload()
    },

    dkClearTags() {
      if (!this.data.selectedTags.length) return
      this.setData({ selectedTags: [], tagSheetDraft: [] })
      this.reload()
    },
  },
}

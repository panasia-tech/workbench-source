import api from '../../../../../../miniprogram/services/api.js'
import { isDesktop } from '../../../../runtime/viewport.js'
import { wx } from '../../../../runtime/globals.js'
import { commonMethods } from '../../../lib/pager.js'

// 上架审批（电脑版）：手机是「滑到底再拉 20 条」，电脑上换成表格 + 页码（每页 50 件）。
// 原页面的 fetch(page) 是追加，这里电脑上顶替成「换页」；接口、参数、格子状态的算法照原样。
const PAGE_SIZE = 50
const STATE_CLASS = {
  NONE: 'lap-st--none',
  DRAFT: 'lap-st--draft',
  SUBMITTED: 'lap-st--wait',
  APPROVED: 'lap-st--ok',
  REJECTED: 'lap-st--bad',
  STALE: 'lap-st--bad',
}

function itemView(item, shops) {
  const cells = shops.map((s) => {
    const c = item.cells[s.id] || {}
    return { id: s.id, label: s.label, state: c.label, cls: STATE_CLASS[c.state] || '', fix: !!c.needs_fix }
  })
  return { ...item, shopCells: cells }
}

export default {
  data: { dkPage: 1, dkPages: 1, dkPageSize: PAGE_SIZE },
  methods: {
    ...commonMethods,

    fetch(page) {
      if (!isDesktop.value) return this.__mobile_fetch(page)
      const seq = (this.__dkSeq = (this.__dkSeq || 0) + 1)
      this.setData({ loading: true })
      const params = { state: this.data.tab, page, size: PAGE_SIZE }
      if (this.data.q.trim()) params.keyword = this.data.q.trim()
      return api.listingApprovalTasks(params)
        .then((res) => {
          if (seq !== this.__dkSeq) return
          const total = res.total || 0
          this.setData({
            counts: res.counts || {},
            costHidden: !!res.cost_hidden,
            list: (res.items || []).map((x) => itemView(x, res.shops || [])),
            page,
            total,
            noMore: true, // 电脑上不靠滑到底加载
            dkPage: page,
            dkPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
          })
          const host = this.__mpHost
          const scroller = host && host.scroller && host.scroller()
          if (scroller) scroller.scrollTop = 0
        })
        .catch((err) => wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }))
        .finally(() => { if (seq === this.__dkSeq) this.setData({ loading: false }) })
    },

    dkPrev() {
      if (this.data.dkPage > 1 && !this.data.loading) this.fetch(this.data.dkPage - 1)
    },

    dkNext() {
      if (this.data.dkPage < this.data.dkPages && !this.data.loading) this.fetch(this.data.dkPage + 1)
    },
  },
}

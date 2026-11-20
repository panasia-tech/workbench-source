import api from '../../../../../../miniprogram/services/api.js'
import { isDesktop } from '../../../../runtime/viewport.js'
import { wx } from '../../../../runtime/globals.js'

// 经营账单（电脑版）：逐笔明细从「滑到底再加载 20 条」换成表格 + 页码（每页 50 条）。
// 页面原来的 reloadDetails / loadMoreDetails 在手机上照旧；电脑上顶替成按页拉。
const PAGE_SIZE = 50

export default {
  data: { dkPage: 1, dkPages: 1, dkTotal: 0, dkPageSize: PAGE_SIZE },
  methods: {
    reloadDetails() {
      if (!isDesktop.value) return this.__mobile_reloadDetails()
      return this.dkLoadDetails(1)
    },

    loadMoreDetails() {
      if (!isDesktop.value) return this.__mobile_loadMoreDetails()
      return Promise.resolve()
    },

    dkLoadDetails(page) {
      const seq = (this.__dkSeq = (this.__dkSeq || 0) + 1)
      const { detailTab, dateFrom, dateTo } = this.data
      const fn = detailTab === 'purchase' ? api.financePurchaseDetails : api.financeSalesDetails
      this.setData({ listLoading: true })
      return fn({ date_from: dateFrom, date_to: dateTo, page, size: PAGE_SIZE }).then((res) => {
        if (seq !== this.__dkSeq) return
        const total = (res && res.total) || 0
        this.setData({
          list: (res && res.items) || [],
          dkTotal: total,
          dkPage: page,
          dkPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
          page: page + 1,
          noMore: true,
          listLoading: false,
        })
      }).catch(() => {
        if (seq !== this.__dkSeq) return
        this.setData({ listLoading: false })
        wx.showToast({ title: '明细加载失败', icon: 'none' })
      })
    },

    dkPrev() {
      if (this.data.dkPage > 1 && !this.data.listLoading) this.dkLoadDetails(this.data.dkPage - 1)
    },

    dkNext() {
      if (this.data.dkPage < this.data.dkPages && !this.data.listLoading) this.dkLoadDetails(this.data.dkPage + 1)
    },
  },
}

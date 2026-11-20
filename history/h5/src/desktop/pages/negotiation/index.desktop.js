import api from '../../../../../miniprogram/services/api.js'
import { isDesktop } from '../../../runtime/viewport.js'
import { wx } from '../../../runtime/globals.js'
import { commonMethods } from '../../lib/pager.js'

// 待议价（电脑版）：待议价接口本来就一次给全，照旧；待召回快递从「滑到底加载 20 条」换成页码（每页 50 条）
const PAGE_SIZE = 50

export default {
  data: { dkRecallPage: 1, dkRecallPages: 1, dkPageSize: PAGE_SIZE },
  methods: {
    ...commonMethods,

    reloadRecall() {
      if (!isDesktop.value) return this.__mobile_reloadRecall()
      return this.dkRecallLoad(1)
    },

    loadMoreRecall() {
      if (!isDesktop.value) return this.__mobile_loadMoreRecall()
      return Promise.resolve()
    },

    dkRecallLoad(page) {
      const seq = (this.__dkSeq = (this.__dkSeq || 0) + 1)
      this.setData({ loading: true })
      const params = Object.assign(this._filterParams(), { page, size: PAGE_SIZE })
      return api.listNegotiationRecallPending(params)
        .then((res) => {
          if (seq !== this.__dkSeq) return
          const total = res.total || 0
          this.setData({
            recallList: res.items || [],
            recallTotal: total,
            recallPage: page + 1,
            recallNoMore: true,
            dkRecallPage: page,
            dkRecallPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
            loading: false,
          })
          const host = this.__mpHost
          const scroller = host && host.scroller && host.scroller()
          if (scroller) scroller.scrollTop = 0
        })
        .catch((err) => {
          if (seq !== this.__dkSeq) return
          this.setData({ loading: false })
          wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
        })
    },

    dkRecallPrev() {
      if (this.data.dkRecallPage > 1 && !this.data.loading) this.dkRecallLoad(this.data.dkRecallPage - 1)
    },

    dkRecallNext() {
      if (this.data.dkRecallPage < this.data.dkRecallPages && !this.data.loading) this.dkRecallLoad(this.data.dkRecallPage + 1)
    },
  },
}

import { isDesktop } from '../../runtime/viewport.js'
import { wx } from '../../runtime/globals.js'

/**
 * 电脑版列表的翻页：手机上是「滑到底再加载 20 条」，电脑上换成表格 + 页码（每页 50 条）。
 * 顶替页面的 reload / loadMore（还有 refreshSilent，如果页面有），手机上照旧调原来的。
 * 页面那边要求：列表在 data.list，总数在 data.total，加载状态在 data.loading。
 *
 *   fetch(params)  → Promise<{ items, total }>，this 是页面
 *   params()       → 当前筛选条件（不含 page / size），this 是页面
 *   after(res)     → 每次拉完再做的事（比如顺手存 legacy_matches），可选
 */
export function desktopPager({ fetch, params, pageSize = 50, after, silent = false }) {
  const methods = {
    reload() {
      if (!isDesktop.value) return this.__mobile_reload()
      return this.dkLoad(1)
    },

    loadMore() {
      if (!isDesktop.value) return this.__mobile_loadMore()
      return Promise.resolve()
    },

    dkLoad(page) {
      const seq = (this.__dkSeq = (this.__dkSeq || 0) + 1)
      const size = this.data.dkPageSize
      this.setData({ loading: true })
      return fetch.call(this, { ...params.call(this), page, size }).then((res) => {
        if (seq !== this.__dkSeq) return
        const total = res.total || 0
        this.setData({
          list: res.items || [],
          total,
          dkPage: page,
          dkPages: Math.max(1, Math.ceil(total / size)),
          loading: false,
          noMore: true,
        })
        if (after) after.call(this, res, page)
        const host = this.__mpHost
        const scroller = host && host.scroller && host.scroller()
        if (scroller) scroller.scrollTop = 0
      }).catch(() => {
        if (seq !== this.__dkSeq) return
        this.setData({ loading: false })
        wx.showToast({ title: '加载失败', icon: 'none' })
      })
    },

    dkPrev() {
      if (this.data.dkPage > 1 && !this.data.loading) this.dkLoad(this.data.dkPage - 1)
    },

    dkNext() {
      if (this.data.dkPage < this.data.dkPages && !this.data.loading) this.dkLoad(this.data.dkPage + 1)
    },
  }
  if (silent) {
    methods.refreshSilent = function refreshSilent() {
      if (!isDesktop.value) return this.__mobile_refreshSilent()
      return this.dkLoad(this.data.dkPage || 1)
    }
  }
  return {
    data: { dkPage: 1, dkPages: 1, dkPageSize: pageSize },
    methods,
  }
}

/** 几个电脑版共用的小方法：点缩略图看大图、按 data-url 打开页面 */
export const commonMethods = {
  dkPreview(e) {
    const { url, urls } = e.currentTarget.dataset
    if (!url) return
    wx.previewImage({ current: url, urls: Array.isArray(urls) && urls.length ? urls : [url] })
  },

  dkOpen(e) {
    const { url } = e.currentTarget.dataset
    if (url) wx.navigateTo({ url })
  },
}

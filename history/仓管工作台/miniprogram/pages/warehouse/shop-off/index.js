const api = require('@services/api')
const shopsWs = require('@services/shops_ws')

const POLL_MS = 4000
const POLL_MAX = 30 // ≈2 分钟;真机异步下架收敛后自动停

// 处理中(在途 gc 作业):在架但正在下架。此态不可再勾选、需轮询收敛到已下架。
function isTransient(s) {
  return s.publish_status === 'LISTING' || (s.publish_status === 'LISTED' && s.gc_pending)
}

function enrichShops(shops) {
  const list = (shops || []).map((s) => {
    const canDelist = s.publish_status === 'LISTED' && !s.gc_pending
    const selected = s.selected === undefined ? canDelist : canDelist && s.selected
    return { ...s, canDelist, selected, transient: isTransient(s) }
  })
  const delistable = list.filter((s) => s.canDelist)
  const selectedCount = delistable.filter((s) => s.selected).length
  return {
    shops: list,
    delistableCount: delistable.length,
    selectedCount,
    allSelected: delistable.length > 0 && selectedCount === delistable.length,
    hasTransient: list.some((s) => s.transient),
  }
}

function mergeSelection(fresh, current) {
  const sel = {}
  ;(current || []).forEach((s) => {
    sel[s.shop_id] = s.selected
  })
  return (fresh || []).map((s) => (sel[s.shop_id] === undefined ? s : { ...s, selected: sel[s.shop_id] }))
}

Page({
  data: {
    skuCode: '',
    shops: [],
    delistableCount: 0,
    selectedCount: 0,
    allSelected: true,
    loading: true,
    submitting: false,
    hasTransient: false,
    pollExhausted: false,
  },

  onLoad(options) {
    this._alive = true
    this.setData({ skuCode: options.code || '' })
    this.loadShops()
  },

  onUnload() {
    this._alive = false
    this.stopPolling()
  },

  onHide() {
    this.stopPolling()
  },

  onShow() {
    if (this._alive && this.data.hasTransient) this.startPolling()
  },

  loadShops() {
    if (!this.data.skuCode) {
      this.setData({ loading: false })
      return
    }
    this.setData({ loading: true })
    api
      .listingShops(this.data.skuCode)
      .then((shops) => {
        if (!this._alive) return
        this.setData({ ...enrichShops(shops), loading: false })
        this.startPolling()
      })
      .catch((err) => {
        this.setData({ loading: false })
        wx.showToast({ title: err.detail || '加载失败', icon: 'none' })
      })
  },

  // 优先 WS 推送(服务端代轮询,变了才推);连不上/异常断开回退 HTTP 轮询。
  startPolling() {
    if (!this._alive || this._pollTimer || this._ws || !this.data.hasTransient) return
    this._pollTries = 0
    this._ws = shopsWs.watchSkuShops(this.data.skuCode, {
      onShops: (shops, settled) => {
        if (!this._alive) return
        this.setData(enrichShops(mergeSelection(shops, this.data.shops)))
        if (settled) this._clearWs()
      },
      onFallback: () => {
        this._clearWs()
        this._startHttpPoll()
      },
      onClose: ({ settled }) => {
        this._clearWs()
        if (!settled && this._alive && this.data.hasTransient) this._startHttpPoll()
      },
    })
  },

  _clearWs() {
    if (this._ws) {
      this._ws.close()
      this._ws = null
    }
  },

  _startHttpPoll() {
    if (!this._alive || this._pollTimer || !this.data.hasTransient) return
    this._scheduleNext()
  },

  _scheduleNext() {
    this._pollTimer = setTimeout(() => {
      this._pollTimer = null
      this._pollOnce()
    }, POLL_MS)
  },

  stopPolling() {
    this._clearWs()
    if (this._pollTimer) {
      clearTimeout(this._pollTimer)
      this._pollTimer = null
    }
  },

  _pollOnce() {
    if (!this._alive) return
    this._pollTries += 1
    api
      .listingShops(this.data.skuCode)
      .then((shops) => {
        if (!this._alive) return
        this.setData(enrichShops(mergeSelection(shops, this.data.shops)))
        if (this.data.hasTransient && this._pollTries < POLL_MAX) {
          this._scheduleNext()
        } else if (this.data.hasTransient) {
          this.setData({ pollExhausted: true })
        }
      })
      .catch(() => {
        if (this._alive && this.data.hasTransient && this._pollTries < POLL_MAX) this._scheduleNext()
      })
  },

  manualRefresh() {
    this.stopPolling()
    this.setData({ pollExhausted: false })
    this.loadShops()
  },

  toggleShop(e) {
    const id = e.currentTarget.dataset.id
    const shops = this.data.shops.map((s) => {
      if (s.shop_id !== id || !s.canDelist) return s
      return { ...s, selected: !s.selected }
    })
    this.setData(enrichShops(shops))
  },

  toggleSelectAll() {
    const selectAll = !this.data.allSelected
    const shops = this.data.shops.map((s) => (s.canDelist ? { ...s, selected: selectAll } : s))
    this.setData(enrichShops(shops))
  },

  submitDelist() {
    if (this.data.submitting || !this.data.selectedCount) return
    const ids = this.data.shops.filter((s) => s.canDelist && s.selected).map((s) => s.shop_id)
    const all = ids.length === this.data.delistableCount
    wx.showModal({
      title: '确认下架',
      content: all
        ? `将从全部 ${ids.length} 个在架店铺下架 ${this.data.skuCode}，是否继续？`
        : `将从 ${ids.length} 个所选店铺下架 ${this.data.skuCode}，是否继续？`,
      success: (res) => {
        if (!res.confirm) return
        this.setData({ submitting: true })
        // 全选也带上店铺:不带 = 服务端按全账号下,会连「下架中」的店再派一遍
        const payload = { sale_shop_ids: ids }
        api
          .delistShops(this.data.skuCode, payload)
          .then((r) => {
            if (r && r.async) {
              // 真机异步:留在页面看「下架中→已下架」,轮询收敛。
              wx.showToast({ title: '已提交下架，真机处理中' })
              this.loadShops()
            } else {
              wx.showToast({ title: '已下架' })
              setTimeout(() => wx.navigateBack(), 500)
            }
          })
          .catch((err) => {
            wx.showToast({ title: err.detail || '下架失败', icon: 'none' })
            this.loadShops()
          })
          .finally(() => {
            this.setData({ submitting: false })
          })
      },
    })
  },
})

const api = require('@services/api')
const appConfig = require('@services/config')

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp)$/i

function isImageUrl(url) {
  return IMAGE_EXT.test(String(url || '').split('?')[0])
}

function fileBaseName(url) {
  const text = String(url || '').trim()
  const parts = text.split('/')
  return parts[parts.length - 1] || '附件'
}

function normalizeExpressResult(result) {
  if (!result) return null
  const traces = (result.traces || []).map((item) => ({
    time: item.time || '',
    context: (item.context || item.status || item.desc || '').trim(),
  }))
  return { ...result, traces }
}

function formatDisplayDatetime(val) {
  if (val == null || val === '') return ''
  const text = String(val).replace('T', ' ').trim()
  if (text.length >= 19) return text.slice(0, 19)
  return text
}

Page({
  data: {
    order: null,
    screenshotUrls: [],
    productImageUrls: [],
    productImageDisplayUrls: [],
    orderTimeText: '',
    paidAtText: '',
    purchaseAccountLabel: '',
    expressLoading: false,
    expressResult: null,
    canEdit: false,
    canDelete: false,
    snapshots: [],
    bargain: null,
  },

  onLoad(options) {
    this.orderId = options.id
    api.getPurchase(options.id).then((order) => {
      const screenshotUrls = [order.screenshot_url, order.screenshot_url_2].filter(Boolean)
      const productImageUrls = order.product_images || []
      const attachmentUrls = order.attachments || []
      const attachmentImageUrls = attachmentUrls.filter(isImageUrl)
      const attachmentFileNames = attachmentUrls.filter((url) => !isImageUrl(url)).map(fileBaseName)
      const patch = {
        order,
        screenshotUrls,
        productImageUrls,
        productImageDisplayUrls: productImageUrls,
        attachmentUrls,
        attachmentImageUrls,
        attachmentImageDisplayUrls: attachmentImageUrls,
        attachmentFileNames,
        orderTimeText: formatDisplayDatetime(order.order_time),
        paidAtText: formatDisplayDatetime(order.paid_at),
        purchaseAccountLabel: appConfig.findPurchaseAccountLabel(order.purchase_account),
      }
      if (order.express_tracking) {
        patch.expressResult = normalizeExpressResult(order.express_tracking)
      }
      const user = getApp().globalData.user || {}
      patch.canEdit = user.role === 'ADMIN'
        || (user.role === 'PURCHASER' && order.created_by_id === user.id)
      // 仅管理员、且未验货（PENDING_INSPECT）才可删除，与后端约束一致
      patch.canDelete = user.role === 'ADMIN' && order.status === 'PENDING_INSPECT'
      this.setData(patch)
      api.listPurchaseSnapshots(options.id)
        .then((res) => this.setData({ snapshots: res.items || [] }))
        .catch(() => {})
      api.listBargainSessions({ purchase_order_id: options.id, page: 1, size: 1 })
        .then((res) => {
          const row = (res.items || [])[0]
          if (!row) return
          this.setData({
            bargain: {
              ...row,
              stateLabel: ({ IDENTIFY: '识别', QUOTE: '报价', COUNTER: '还价', DEAL: '谈妥', PAUSING: '待确认暂停', PAUSED: '已暂停', CLOSED: '结束' })[row.state] || row.state,
            },
          })
        })
        .catch(() => {})
    })
  },

  goBargain() {
    if (!this.data.bargain) return
    wx.navigateTo({ url: `/pages/purchase/bargain/detail/index?id=${this.data.bargain.id}` })
  },

  goEdit() {
    if (!this.orderId) return
    wx.navigateTo({ url: `/pages/purchase/edit/index?id=${this.orderId}` })
  },

  onDelete() {
    const order = this.data.order
    if (!this.orderId || !order) return
    wx.showModal({
      title: '删除采购单',
      content: `确认删除采购单 ${order.order_no}？该操作不可恢复。`,
      confirmText: '删除',
      confirmColor: '#e54d42',
      success: (r) => {
        if (!r.confirm) return
        wx.showLoading({ title: '删除中…', mask: true })
        api.deletePurchase(this.orderId)
          .then(() => {
            wx.hideLoading()
            wx.showToast({ title: '已删除', icon: 'success' })
            setTimeout(() => wx.navigateBack(), 600)
          })
          .catch((err) => {
            wx.hideLoading()
            wx.showToast({ title: (err && err.detail) || '删除失败', icon: 'none' })
          })
      },
    })
  },

  onTrackExpress(e) {
    const no = (this.data.order && this.data.order.tracking_no) || ''
    if (!no.trim()) return
    if (this.data.expressLoading) return
    const refresh = e.currentTarget.dataset.refresh === '1'
    const phone = (this.data.order && this.data.order.tracking_phone_suffix) || ''
    this.setData({ expressLoading: true })
    api.trackExpress(no.trim(), { refresh, phone })
      .then((result) => {
        this.setData({ expressResult: normalizeExpressResult(result), expressLoading: false })
        if (result.cached && result.traces.length) {
          wx.showToast({ title: '已显示缓存物流', icon: 'none', duration: 2000 })
        } else if (result.msg && !result.traces.length) {
          wx.showToast({ title: result.msg, icon: 'none', duration: 3000 })
        }
      })
      .catch((err) => {
        this.setData({ expressLoading: false })
        wx.showToast({ title: (err && err.detail) || '物流查询失败', icon: 'none' })
      })
  },
})

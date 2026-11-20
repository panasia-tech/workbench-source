// 采购议价（W07）：识别 → 报价 → 还价 → 谈妥
const api = require('@services/api')
const auth = require('@services/auth')

const STATE_LABEL = {
  IDENTIFY: '识别', QUOTE: '报价', COUNTER: '还价', DEAL: '谈妥',
  PAUSING: '待确认暂停', PAUSED: '已暂停', CLOSED: '结束',
}

Page({
  data: {
    tab: 'open',
    list: [],
    loading: false,
    STATE_LABEL,
  },

  onShow() {
    auth.ensureLogin().then(() => this.load())
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.key }, () => this.load())
  },

  load() {
    this.setData({ loading: true })
    const state = this.data.tab === 'open'
      ? 'IDENTIFY,QUOTE,COUNTER,PAUSING,PAUSED'
      : this.data.tab === 'deal' ? 'DEAL' : 'CLOSED'
    return api.listBargainSessions({ state, page: 1, size: 50 })
      .then((res) => {
        const list = (res.items || []).map((x) => ({
          ...x,
          stateLabel: STATE_LABEL[x.state] || x.state,
          priceLine: `${x.our_price ?? '—'} / ${x.their_price ?? '—'} / ${x.deal_price ?? '—'}`,
        }))
        this.setData({ list, loading: false })
      })
      .catch((err) => {
        this.setData({ loading: false })
        wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
      })
  },

  openCreate() {
    wx.showModal({
      title: '开聊',
      editable: true,
      placeholderText: '闲鱼商品 ID 或商品链接',
      success: (res) => {
        if (!res.confirm || !(res.content || '').trim()) return
        // 采购顺手粘整条链接：取里面的 id（链接超过 64 字后端直接 422）
        const text = res.content.trim()
        const m = text.match(/[?&](?:id|itemId)=(\d+)/) || text.match(/(\d{9,})/)
        const platform_item_id = m ? m[1] : text
        if (platform_item_id.length > 64) {
          wx.showToast({ title: '没认出商品 ID，复制链接里 id= 后面那串数字', icon: 'none' })
          return
        }
        wx.showLoading({ title: '开聊中' })
        api.openBargainSession({ platform_item_id })
          .then((row) => {
            wx.hideLoading()
            wx.navigateTo({ url: `/pages/purchase/bargain/detail/index?id=${row.id}` })
          })
          .catch((err) => {
            wx.hideLoading()
            wx.showToast({ title: (err && err.detail) || '开聊失败', icon: 'none' })
          })
      },
    })
  },

  openItem(e) {
    wx.navigateTo({ url: `/pages/purchase/bargain/detail/index?id=${e.currentTarget.dataset.id}` })
  },
})

const auth = require('@services/auth')
const { request } = require('@services/request')

// 实物接管台：在等我们回复的买家，超过考核时限的红、标「已升级」，先红后黄、等得久的在前；点进去就是聊天页。
// 下面是今天各负责人的回复情况。数据在群控（消息响应考核），连不上时明说。
// 11-14 照交付包：页顶四个数（回复率、回复超时、还没回、平均回复），电脑上三栏（会话 / 完整对话 / 这件货的信息页）。

// 今天全员合起来：回复率 = 回了 / 收到；平均回复按各人回了几轮加权
function summarize(stats, waiting) {
  if (!stats) return null
  let cycles = 0
  let replied = 0
  let late = 0
  let weighted = 0
  let weight = 0
  stats.forEach((s) => {
    cycles += s.cycles
    replied += s.replied
    late += s.late_reply
    if (s.avg_reply_min !== null) {
      weighted += s.avg_reply_min * s.replied
      weight += s.replied
    }
  })
  return {
    rate: cycles ? Math.round((replied * 100) / cycles) : null,
    replied,
    cycles,
    late,
    waiting,
    avg: weight ? Math.round(weighted / weight) : null,
  }
}

Page({
  data: {
    loading: false,
    loaded: false,
    d: null,
    red: 0,
    yellow: 0,
    sum: null,
    showStats: false,
    showHelp: false,
  },

  // 常开着的页面：等了几分钟、超没超时要跟着变，30 秒自己刷一次（离开页面就停）
  onShow() {
    auth.ensureLogin().then(() => this.load())
    clearInterval(this._timer)
    this._timer = setInterval(() => this.load(true), 30000)
  },

  onHide() {
    clearInterval(this._timer)
  },

  onUnload() {
    clearInterval(this._timer)
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  load(quiet) {
    if (quiet && this.data.loading) return Promise.resolve()
    if (!quiet) this.setData({ loading: true })
    return request({ url: '/api/sales-workbench/assist' })
      .then((d) => {
        const rows = d.rows || []
        this.setData({
          d,
          red: rows.filter((r) => r.level === 'red').length,
          yellow: rows.filter((r) => r.level === 'yellow').length,
          sum: summarize(d.stats, rows.length),
          loaded: true,
        })
      })
      .catch((err) => { if (!quiet) wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }) })
      .finally(() => this.setData({ loading: false }))
  },

  toggleStats() {
    this.setData({ showStats: !this.data.showStats })
  },

  toggleHelp() {
    this.setData({ showHelp: !this.data.showHelp })
  },

  // 请同事帮忙：发一条协同请求（先给这个号的负责人，60 秒没人接转所有在岗同事，再 60 秒转主管）
  // 原来一点就发、不能写要帮什么，误触或连点会给负责人、全体销售、主管连发几条；和电脑版一样先写一句
  ask(e) {
    const r = this.data.d.rows[e.currentTarget.dataset.i]
    if (!r || this._asking) return
    wx.showModal({
      title: '请同事帮忙',
      editable: true,
      placeholderText: '要帮什么，如：帮我回下价格，我在路上',
      confirmText: '发出去',
      success: (m) => {
        if (!m.confirm) return
        const what = (m.content || '').trim()
        if (!what) {
          wx.showToast({ title: '写一句要帮什么', icon: 'none' })
          return
        }
        this._asking = true
        request({
          url: '/api/sales-workbench/collab',
          method: 'POST',
          data: {
            title: what,
            detail: [r.last_message ? `${r.buyer}问：${r.last_message}` : `${r.buyer}在等回复`, r.item_title].filter(Boolean).join(' · '),
            conversation_id: r.key,
            owner_names: r.owners || [],
          },
        })
          .then((c) => {
            wx.showToast({ title: c.to ? `已发给 ${c.to}` : '已发给在岗同事', icon: 'none' })
            if (typeof window !== 'undefined') window.dispatchEvent(new Event('mp:collab'))
          })
          .catch((err) => wx.showToast({ title: (err && err.detail) || '没发出去', icon: 'none' }))
          .finally(() => { this._asking = false })
      },
    })
  },

  go(e) {
    const url = e.currentTarget.dataset.url
    if (url) wx.navigateTo({ url })
  },
})

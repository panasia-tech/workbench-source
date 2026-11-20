const auth = require('@services/auth')
const { request } = require('@services/request')
const platform = require('@utils/platform')

const PAGE_SIZE = 20

function _pad(n) {
  return n < 10 ? '0' + n : '' + n
}

// 会话时间:今天→HH:MM,今年→MM-DD,更早→YYYY-MM-DD。
// 群控回的是 UTC 朴素时间串(无时区标记),按 UTC 解析,否则显示会比北京时间慢 8 小时
function shortTime(ts) {
  if (!ts) return ''
  let norm = String(ts).replace(' ', 'T')
  if (norm.indexOf('Z') < 0 && norm.indexOf('+') < 0) norm += 'Z'
  const d = new Date(norm)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return `${_pad(d.getHours())}:${_pad(d.getMinutes())}`
  if (d.getFullYear() === now.getFullYear()) return `${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`
  return `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`
}

function decorate(item) {
  const nick = (item.peer_nick || '').trim()
  return {
    ...item,
    _nick: nick || '未知会员',
    _avatar: (nick || item.item_title || '客').trim().charAt(0) || '客',
    _time: shortTime(item.updated_at),
    _unread: item.unread > 99 ? '99+' : item.unread,
  }
}

Page({
  data: {
    list: [],
    page: 1,
    loading: false,
    noMore: false,
    navPadTop: '0px',
    navHeight: 44,
    navPadRight: 0,
  },

  onLoad() {
    this.setData(platform.navMetrics())
  },

  goBack() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack()
      return
    }
    wx.reLaunch({ url: '/pages/workbench/index' })
  },

  // 第一次进来正常加载;从详情页回来、切回前台只在后台静默刷新,不清空列表——
  // 原来每次 onShow 都清空重载,列表闪一下、滚动位置也丢了,看着像页面自己在乱刷
  onShow() {
    auth.ensureLogin().then(() => (this.data.list.length ? this.refreshSilently() : this.reload()))
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    this.loadMore()
  },

  reload() {
    this.setData({ page: 1, list: [], noMore: false })
    return this.loadMore()
  },

  // 静默刷新:按已加载的条数重拉第一页(接口一页最多 100),整体替换,不清空、不出「加载中」
  refreshSilently() {
    if (this.data.loading || this._refreshing) return Promise.resolve()
    this._refreshing = true
    const size = Math.min(100, Math.ceil(this.data.list.length / PAGE_SIZE) * PAGE_SIZE)
    return request({ url: '/gc/chat/conversations', data: { page: 1, size } })
      .then((res) => {
        const items = (Array.isArray(res) ? res : (res && res.items) || []).map(decorate)
        this.setData({ list: items, page: size / PAGE_SIZE + 1, noMore: items.length < size })
      })
      .catch(() => {})   // 刷不下来就留着原列表,不弹错打扰
      .finally(() => { this._refreshing = false })
  },

  loadMore() {
    if (this.data.loading || this.data.noMore || this._refreshing) return Promise.resolve()
    this.setData({ loading: true })
    const { page } = this.data
    return request({ url: '/gc/chat/conversations', data: { page, size: PAGE_SIZE } })
      .then((res) => {
        const items = (Array.isArray(res) ? res : (res && res.items) || []).map(decorate)
        const merged = page === 1 ? items : this.data.list.concat(items)
        const noMore = items.length < PAGE_SIZE
        this.setData({
          list: merged,
          page: page + 1,
          noMore,
          loading: false,
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
      })
  },

  openDetail(e) {
    const { id, title, item, price, image, status, acc } = e.currentTarget.dataset
    if (!id) return
    const query = [
      `id=${id}`,
      `title=${encodeURIComponent(title || '')}`,
      `item=${encodeURIComponent(item || '')}`,
      `price=${encodeURIComponent(price || '')}`,
      `image=${encodeURIComponent(image || '')}`,
      `status=${encodeURIComponent(status || '')}`,
      `acc=${encodeURIComponent(acc || '')}`,
    ].join('&')
    wx.navigateTo({ url: `/pages/gc-chat/detail/index?${query}` })
  },
})

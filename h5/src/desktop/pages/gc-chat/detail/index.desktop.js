// 注意：要用 H5 版 request（src/overrides/services/request.js，同源 /gc）；直接引 miniprogram/services/request.js 会打到写死的生产域名
import requestModule from '../../../../overrides/services/request.js'
import { isDesktop } from '../../../../runtime/viewport.js'
import { wx } from '../../../../runtime/globals.js'

// 会话详情（电脑版）：像桌面聊天软件——左边会话列表、中间聊天、右边买家 / 商品 / SKU 槽。
// 收发消息、盯回复任务、自动拉新消息全照原页面（loadMessages / sendReply / _poll…），这里一行不碰。
// 只多两件事：左边的会话列表（电脑上才拉，切会话用 redirectTo，不叠页面）；手机「•••」菜单里的几项直接摆成按钮。
const { request } = requestModule
const CONV_SIZE = 50
const CONV_REFRESH_MS = 15000

function pad(n) {
  return n < 10 ? `0${n}` : `${n}`
}

// 同列表页：群控回的是 UTC 朴素时间串，按 UTC 解析；今天 HH:MM，今年 MM-DD，更早 YYYY-MM-DD
function shortTime(ts) {
  if (!ts) return ''
  let norm = String(ts).replace(' ', 'T')
  if (norm.indexOf('Z') < 0 && norm.indexOf('+') < 0) norm += 'Z'
  const d = new Date(norm)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function convView(item) {
  const nick = (item.peer_nick || '').trim()
  return {
    id: item.id,
    peer_nick: item.peer_nick || '',
    account_nick: item.account_nick || '',
    item_title: item.item_title || '',
    item_price: item.item_price || '',
    item_image: item.item_image || '',
    order_status: item.order_status || '',
    last_message: item.last_message || '',
    unread: item.unread || 0,
    _nick: nick || '未知会员',
    _avatar: (nick || item.item_title || '客').trim().charAt(0) || '客',
    _time: shortTime(item.updated_at),
    _unread: item.unread > 99 ? '99+' : item.unread,
  }
}

export default {
  data: {
    dkConvs: [],
    dkConvLoading: false,
    dkListingSku: '',
  },

  onShow() {
    if (!isDesktop.value) return
    this.dkLoadConvs()
    if (!this.__dkConvTimer) this.__dkConvTimer = setInterval(() => this.dkLoadConvs(true), CONV_REFRESH_MS)
  },

  onHide() {
    if (this.__dkConvTimer) { clearInterval(this.__dkConvTimer); this.__dkConvTimer = null }
  },

  onUnload() {
    if (this.__dkConvTimer) { clearInterval(this.__dkConvTimer); this.__dkConvTimer = null }
  },

  methods: {
    // 会话详情拉回来以后记下对上的货号（「查看这件货」按钮要用）；电脑上 SKU 槽常驻右栏，没对上货号就先给出提示
    loadConversation() {
      return this.__mobile_loadConversation().then((r) => {
        const sku = (this._conv && this._conv.listing_sku) || ''
        this.setData({ dkListingSku: sku })
        if (isDesktop.value && !sku && !this.data.slots.length && !this.data.slotsLoading) this.loadSlots()
        return r
      })
    },

    dkLoadConvs(silent) {
      if (this.__dkConvBusy) return
      this.__dkConvBusy = true
      if (!silent) this.setData({ dkConvLoading: true })
      request({ url: '/gc/chat/conversations', data: { page: 1, size: CONV_SIZE } })
        .then((res) => {
          const items = (Array.isArray(res) ? res : (res && res.items) || []).map(convView)
          this.setData({ dkConvs: items })
        })
        .catch(() => {})
        .finally(() => {
          this.__dkConvBusy = false
          this.setData({ dkConvLoading: false })
        })
    },

    // 换一个会话：替换当前页（返回仍回到进来之前那页），参数和列表页 openDetail 一样
    dkSwitchConv(e) {
      const { id, title, item, price, image, status, acc } = e.currentTarget.dataset
      if (!id || id === this.data.id) return
      const query = [
        `id=${id}`,
        `title=${encodeURIComponent(title || '')}`,
        `item=${encodeURIComponent(item || '')}`,
        `price=${encodeURIComponent(price || '')}`,
        `image=${encodeURIComponent(image || '')}`,
        `status=${encodeURIComponent(status || '')}`,
        `acc=${encodeURIComponent(acc || '')}`,
      ].join('&')
      wx.redirectTo({ url: `/pages/gc-chat/detail/index?${query}` })
    },

    // 手机「•••」菜单的几项
    dkRefresh() {
      this.loadMessages()
    },

    dkCopyNick() {
      if (this.data.title) wx.setClipboardData({ data: this.data.title })
    },

    dkCopyLink() {
      if (this.data.itemUrl) wx.setClipboardData({ data: this.data.itemUrl })
    },

    dkViewSku() {
      this.openProductDetail()
    },

    // 发送按钮：原模板 button 的 disabled 挡空草稿和发送中；sendReply 自己也挡
    dkSend() {
      if (!(this.data.draft || '').trim() || this.data.sending) return
      this.sendReply()
    },

    dkGoConfirm() {
      if (this.data.pickedCount) this.goConfirm()
    },

    dkSendPicked() {
      if (this.data.pickedCount && !this.data.sendingMedia) this.sendPicked()
    },

    dkOpenItem() {
      if (this.data.itemUrl) this.openItemLink()
    },
  },
}

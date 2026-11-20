// 注意：要用 H5 版 request（同源 /gc）；直接引 miniprogram/services/request.js 会打到写死的生产域名
import requestModule from '../../../overrides/services/request.js'
import { wx } from '../../../runtime/globals.js'
import { isDesktop } from '../../../runtime/viewport.js'

// 实物接管台（电脑版）：照交付包三栏——左边在等的会话，中间这段对话（只看最近的，为什么轮到你），右边这件货的信息页。
// 回复、发实拍、发仓库位置都在聊天页里做（电脑上聊天页本身就是三栏，收发、盯回复任务都在那），
// 这里不另写一套发消息：点「我来接管」进那个会话。
const { request } = requestModule
const TAIL = 30

function hhmm(ts) {
  if (!ts) return ''
  let norm = String(ts).replace(' ', 'T')
  if (norm.indexOf('Z') < 0 && norm.indexOf('+') < 0) norm += 'Z'
  const d = new Date(norm)
  if (isNaN(d.getTime())) return ''
  const p = (n) => (n < 10 ? `0${n}` : `${n}`)
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export default {
  data: {
    dkTab: 'red',
    dkRows: [],
    dkSel: null,
    dkWhy: '',
    dkConv: null,
    dkMsgs: [],
    dkMsgErr: '',
    dkItem: null,
    dkSlots: [],
    dkPickup: '',
    dkLoadingConv: false,
    dkAsk: null,
  },
  methods: {
    load(quiet) {
      return this.__mobile_load(quiet).then(() => {
        // 手机宽度上不开右边两栏（原来手机上每次刷新也去拉会话详情、消息、货的图）
        if (!isDesktop.value) return
        this._dkRender()
        if (this._dkPickupLoaded) return
        this._dkPickupLoaded = true
        request({ url: '/api/config' }).then((c) => this.setData({ dkPickup: (c && c.pickup_address) || '' })).catch(() => {})
      })
    },

    _dkRender() {
      const rows = (this.data.d && this.data.d.rows) || []
      // 没有要接管的就看全部
      const tab = this.data.dkTab === 'red' && !rows.some((r) => r.level === 'red') ? 'all' : this.data.dkTab
      const list = tab === 'red' ? rows.filter((r) => r.level === 'red') : rows
      this.setData({ dkTab: tab, dkRows: list })
      const sel = this.data.dkSel && rows.find((r) => r.key === this.data.dkSel.key)
      if (sel) this.setData({ dkSel: sel })
      else if (list.length) this._dkOpen(list[0])
      else this.setData({ dkSel: null, dkConv: null, dkMsgs: [], dkItem: null, dkSlots: [] })
    },

    dkPickTab(e) {
      this.setData({ dkTab: e.currentTarget.dataset.key })
      this._dkRender()
    },

    dkPick(e) {
      const row = (this.data.d.rows || []).find((r) => r.key === e.currentTarget.dataset.key)
      if (row) this._dkOpen(row)
    },

    _dkOpen(row) {
      const id = row.key
      const mins = Math.floor((row.waited_sec || 0) / 60)
      const limit = (this.data.d && this.data.d.reply_min) || 15
      const why = row.level === 'red'
        ? `买家等了 ${mins} 分钟还没人回，超过 ${limit} 分钟的考核，已升级。`
        : `买家等了 ${mins} 分钟，还没到 ${limit} 分钟的考核，尽快回。`
      this.setData({ dkSel: row, dkWhy: row.read_by ? `${why}${row.read_by} 看过还没回。` : why, dkConv: null, dkMsgs: [], dkMsgErr: '', dkItem: null, dkSlots: [], dkLoadingConv: true, dkAsk: null })
      const conv = request({ url: `/gc/chat/conversations/${id}` }).catch(() => null)
      const msgs = request({ url: `/gc/chat/conversations/${id}/messages`, data: { page: 1, size: TAIL, tail: 1 } })
        .then((list) => (list || []).map((m) => ({
          id: m.id,
          out: m.direction !== 'in',
          text: m.text || '',
          imgs: (m.media || []).filter((x) => x.type === 'image').map((x) => x.thumb || x.url),
          video: (m.media || []).some((x) => x.type === 'video'),
          card: !!m.card,
          at: hhmm(m.msg_at || m.created_at),
        })))
        .catch(() => null)
      return Promise.all([conv, msgs]).then(([c, list]) => {
        if (!this.data.dkSel || this.data.dkSel.key !== id) return null
        this.setData({ dkConv: c, dkMsgs: list || [], dkMsgErr: list ? '' : '这段对话没拉到（群控没连上？），点「我来接管」进聊天页看', dkLoadingConv: false })
        const sku = c && c.listing_sku
        if (!sku) return null
        return Promise.all([
          request({ url: `/api/chat-assist/skus/${encodeURIComponent(sku)}/media` }).catch(() => null),
          request({ url: '/api/chat-assist/slots', data: { sku } }).catch(() => null),
        ]).then(([media, slots]) => {
          if (!this.data.dkSel || this.data.dkSel.key !== id) return
          const same = []
          ;((slots && slots.slots) || []).forEach((s) => (s.items || []).forEach((it) => same.push({ ...it, label: s.label })))
          this.setData({
            dkItem: media ? {
              ...media,
              photos: (media.media || []).filter((m) => m.type === 'image').slice(0, 6).map((m) => m.thumb || m.url),
              videos: (media.media || []).filter((m) => m.type === 'video').length,
            } : null,
            dkSlots: same.slice(0, 8),
          })
        })
      })
    },

    dkTakeOver() {
      if (this.data.dkSel) wx.navigateTo({ url: this.data.dkSel.url })
    },

    // 请同事帮忙：发一条协同请求，先给这个号的负责人，60 秒没人接转所有在岗同事，再 60 秒转主管（角上浮着倒计时）
    dkAskOpen() {
      const r = this.data.dkSel
      if (r) this.setData({ dkAsk: r.last_message ? `${r.buyer}问：${r.last_message}` : '' })
    },

    dkAskInput(e) {
      this.setData({ dkAsk: e.detail.value })
    },

    dkAskClose() {
      this.setData({ dkAsk: null })
    },

    dkAskSend() {
      const r = this.data.dkSel
      const title = String(this.data.dkAsk || '').trim()
      if (!r || !title) {
        wx.showToast({ title: '写一句要同事帮什么', icon: 'none' })
        return
      }
      request({
        url: '/api/sales-workbench/collab',
        method: 'POST',
        data: {
          title,
          detail: r.item_title || '',
          conversation_id: r.key,
          sku_code: (this.data.dkItem && this.data.dkItem.sku_code) || '',
          owner_names: r.owners || [],
        },
      })
        .then((c) => {
          wx.showToast({ title: c.to ? `已发给 ${c.to}，60 秒没人接转同事` : '已发给在岗同事', icon: 'none' })
          this.setData({ dkAsk: null })
          window.dispatchEvent(new Event('mp:collab'))
        })
        .catch((err) => wx.showToast({ title: (err && err.detail) || '没发出去', icon: 'none' }))
    },

    dkGoItem(e) {
      const code = e.currentTarget.dataset.code
      if (code) wx.navigateTo({ url: `/pages/sales-goods/item/index?code=${encodeURIComponent(code)}` })
    },
  },
}

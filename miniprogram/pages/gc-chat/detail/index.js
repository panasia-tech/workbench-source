const { request } = require('@services/request')
const api = require('@services/api')
const { friendlyText, friendlyStep } = require('@utils/errmsg')
const platform = require('@utils/platform')

const PAGE_SIZE = 200
// 提交回复只是建单,归属账号的设备排到了才进会话去发(同号两次操作至少隔 30 秒,
// 设备在忙别的单还要等它做完)。提交后盯着这条回复任务,出结果为止,最多盯 5 分钟
const POLL_INTERVAL_MS = 3000
const POLL_MAX_MS = 5 * 60 * 1000
const DONE_STATUSES = ['SUCCESS', 'FAILED', 'CANCELLED', 'TIMEOUT']
// 页面开着就隔几秒拉一次新消息(服务端扫到的新消息不会自己推过来)
const REFRESH_MS = 5000
// 两条消息隔这么久以上,中间插一行时间
const SEP_GAP_MS = 5 * 60 * 1000
// 闲鱼一次选图上限 9 张
const MAX_IMAGES = 9

// 本地回显气泡的状态 → 时间那一格显示的字(sent 照常显示时间)
const ECHO_LABEL = {
  pending: '发送中…',
  unsure: '可能已发出，刷新看看',
  failed: '没发出去',
  queued: '还在排队，稍后刷新看看',
}

const EMOJIS = [
  '😀', '😁', '😂', '😊', '😍', '😘', '😉', '🙂',
  '🤗', '🤔', '😅', '😭', '😢', '😡', '😮', '😴',
  '👍', '👌', '🙏', '👏', '💪', '🤝', '✌️', '👀',
  '🎉', '❤️', '🌹', '☕', '📦', '🚚', '💰', '✅',
]

// gc 返回的是 UTC 朴素时间串(无时区标记),按 UTC 解析
function utcMs(ts) {
  if (!ts) return NaN
  let norm = String(ts).replace(' ', 'T')
  if (norm.indexOf('Z') < 0 && norm.indexOf('+') < 0) norm += 'Z'
  return new Date(norm).getTime()
}

function pad(n) {
  return n < 10 ? `0${n}` : `${n}`
}

function hm(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// 时间分隔行:今天 16:00 / 昨天 19:06 / 10-21 09:30 / 2025-12-30 09:30
function sepLabel(ms) {
  const d = new Date(ms)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const dayStart = new Date(d.getTime())
  dayStart.setHours(0, 0, 0, 0)
  const days = Math.round((today.getTime() - dayStart.getTime()) / 86400000)
  if (days === 0) return `今天 ${hm(d)}`
  if (days === 1) return `昨天 ${hm(d)}`
  if (d.getFullYear() === today.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm(d)}`
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm(d)}`
}

// 消息加上展示用字段:_hm 每条下面的时间,_sep 要不要先插一行时间,_media 发出去的图片视频
function decorate(list) {
  let prev = NaN
  return list.map((m) => {
    const ms = utcMs(m.msg_at || m.created_at)
    const out = { ...m }
    out._hm = isNaN(ms) ? '' : hm(new Date(ms))
    const newDay = !isNaN(prev) && new Date(prev).toDateString() !== new Date(ms).toDateString()
    out._sep = !isNaN(ms) && (isNaN(prev) || ms - prev > SEP_GAP_MS || newDay) ? sepLabel(ms) : ''
    const media = Array.isArray(m.media) && m.media.length ? m.media : (m._media || null)
    out._media = media ? media.map(withCover) : null
    out._card = m.card || m._card || null
    if (!isNaN(ms)) prev = ms
    return out
  })
}

// 列表签名:条数 + 最后一条,没变就不 setData,免得自动刷新时画面抖
function signature(rows) {
  const last = rows[rows.length - 1]
  return `${rows.length}|${last ? last.id : ''}`
}

// 格子里显示的图:图片用缩略图(没有就原图);视频只用截帧封面,没有就空着显示深色底——
// 别把 mp4 地址塞给 <image>,那是一张破图
function withCover(m) {
  return { ...m, cover: m.type === 'video' ? (m.thumb || '') : (m.thumb || m.url) }
}

// 发商品时买家收到的那句文字
function cardText(card) {
  return [card.title, card.grade, card.price ? `¥${card.price}` : ''].filter(Boolean).join(' ')
}

function videoDuration(sec) {
  const s = Math.round(Number(sec) || 0)
  if (!s) return ''
  return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`
}

// 商品卡要提示「待补全」的字段（和 chat-assist 接口 missing 的取值一致）
const CARD_REQUIRED_FIELDS = ['image', 'name', 'price', 'grade', 'location']

Page({
  data: {
    id: '',
    title: '',
    itemTitle: '',
    itemModel: '',
    itemPrice: '',
    itemImage: '',
    itemGrade: '',
    itemState: '',
    itemLocation: '',
    itemCode: '',
    itemSku: '',
    itemMissing: false,
    itemNeedMatch: false,
    itemMissingFields: [],
    itemTags: [],
    itemUrl: '',
    orderStatus: '',
    accountNick: '',
    peerAvatar: '客',
    myAvatar: '我',
    navPadTop: '0px',
    navHeight: 44,
    navPadRight: 0,
    anchorId: '',
    messages: [],
    loading: false,
    draft: '',
    sending: false,
    // 面板:'' / 'emoji' / 'more'
    panel: '',
    emojis: EMOJIS,
    // SKU 槽
    slotsLoading: false,
    slotsError: '',
    slots: [],
    slotKey: '',
    spuName: '',
    linkDraft: '',
    // 弹层:'' / 'pick'(商品详情 WMS) / 'confirm'(发送给买家)
    sheet: '',
    sku: { items: [], skuId: '', title: '', media: [], cur: 0, tab: 'all', loading: false, error: '' },
    pickedCount: 0,
    pickedImages: [],
    pickedVideos: [],
    confirmTab: 'image',
    confirmAnchor: '',
    sendingMedia: false,
    productCard: null,   // 发商品时的小卡片 {title, grade, price};相册 / 拍摄发图没有
  },

  onLoad(options) {
    const id = options.id || ''
    const title = decodeURIComponent(options.title || '')
    const accountNick = decodeURIComponent(options.acc || '')
    this.setData({
      ...platform.navMetrics(),
      id,
      title,
      itemTitle: decodeURIComponent(options.item || ''),
      itemPrice: decodeURIComponent(options.price || ''),
      itemImage: decodeURIComponent(options.image || ''),
      orderStatus: decodeURIComponent(options.status || ''),
      accountNick,
      peerAvatar: (title || '客').trim().charAt(0) || '客',
      myAvatar: (accountNick || '我').trim().charAt(0) || '我',
    })
    this._watch = {}   // 盯着的回复任务:task_id → { echoId, deadline }
    this._picked = {}  // 已选的实拍:url → 媒体项(跨货号也记得住)
    this._skuFacts = {}  // 货号 → 发商品要用的 {title, grade, price}
    this._sig = ''
    this._conv = null
    if (id) {
      this.loadMessages()
      this.loadConversation()
    }
  },

  // 切回来接着盯还没出结果的回复、接着自动拉新消息;离开就停,不在后台空转
  onShow() {
    this._startPoll()
    this._startRefresh()
    // 商品详情页点「去匹配」返回后，打开 + 面板里的商品匹配入口；不重置聊天和输入框。
    const pending = wx.getStorageSync('gcChatMatchPending')
    if (pending && pending.conversationId === this.data.id) {
      wx.removeStorageSync('gcChatMatchPending')
      setTimeout(() => this.openSkuMatcher(), 0)
    }
  },

  onHide() {
    this._stopPoll()
    this._stopRefresh()
  },

  onUnload() {
    this._stopPoll()
    this._stopRefresh()
    this._watch = {}
  },

  noop() {},

  goBack() {
    const pages = getCurrentPages()
    if (pages.length > 1) {
      wx.navigateBack()
      return
    }
    wx.redirectTo({ url: '/pages/gc-chat/list/index' })
  },

  // ------------------------------------------------------------------ 会话和商品
  // 会话详情:商品对上了哪件货(listing_sku)、闲鱼链接。老版本群控没有这个接口,失败就只用列表带过来的字段
  loadConversation() {
    return api.gcChatConversation(this.data.id)
      .then((conv) => {
        this._conv = conv || null
        if (!conv) return
        const patch = {}
        if (conv.peer_nick && !this.data.title) patch.title = conv.peer_nick
        if (conv.item_title) patch.itemTitle = conv.item_title
        if (conv.item_price) patch.itemPrice = conv.item_price
        if (conv.item_image) patch.itemImage = conv.item_image
        if (conv.account_nick) patch.accountNick = conv.account_nick
        patch.orderStatus = conv.order_status || ''
        patch.itemUrl = conv.item_url || ''
        patch.itemSku = conv.listing_sku || ''
        patch.itemNeedMatch = !conv.listing_sku
        patch.itemMissing = !conv.listing_sku
        if (!conv.listing_sku && !this.data.itemTitle) patch.itemTitle = '商品信息待补全'
        this.setData(patch)
        if (conv.listing_sku) this.loadProductCard(conv.listing_sku)
      })
      .catch(() => {})
  },

  // 商品卡优先读 ERP 同一货号（listing_sku）下的真实商品资料；闲鱼链接 item_url 单独保留。
  loadProductCard(skuCode) {
    return api.chatSkuMedia(skuCode)
      .then((res) => {
        const images = ((res && res.media) || []).filter((m) => m.type === 'image')
        const first = images[0] || {}
        const missing = Array.isArray(res && res.missing) ? res.missing : []
        const title = ((res && res.product_name) || '').trim() || '商品信息待补全'
        const model = (res && res.model) || ''
        this._detail = res
        this.setData({
          itemSku: (res && res.sku_code) || skuCode,
          itemTitle: title,
          // 名称里已经带型号就不重复显示（AOC 24G2Z / 24G2Z）
          itemModel: model && !title.toLowerCase().includes(model.toLowerCase()) ? model : '',
          itemPrice: (res && res.price) || this.data.itemPrice || '',
          // 已匹配到货号时只用这件货自己的图；没有图就标“商品图待补”，不拿会话里的闲鱼缩略图冒充。
          itemImage: first.thumb || first.url || '',
          itemGrade: (res && res.grade) || '',
          itemState: (res && res.state_label) || '',
          itemLocation: res && res.location_code ? `库位 ${res.location_code}` : '',
          itemCode: res && res.short_code ? `#${res.short_code}` : (res && res.sku_code ? `货号 ${res.sku_code}` : ''),
          // 卡片上只在核心几项缺时提示待补全；描述、配置、备注常年为空，缺了只在详情页里列出来
          itemMissing: missing.some((k) => CARD_REQUIRED_FIELDS.includes(k)),
          itemNeedMatch: false,
          itemMissingFields: missing,
        })
        this._skuFacts[skuCode] = {
          title: (res && res.product_name) || '',
          grade: (res && res.grade) || '',
          price: (res && res.price) || '',
        }
        return this.loadItemFacts(skuCode)
      })
      .catch(() => {
        // 会话有货号但 ERP 查不到/资料不全：保留会话里的图价，标待补全并允许去匹配。
        this.setData({
          itemMissing: true,
          itemNeedMatch: true,
          itemTitle: this.data.itemTitle || '商品信息待补全',
        })
        return this.loadItemFacts(skuCode)
      })
  },

  // 商品卡上的成色和标签来自 ERP 那件货
  loadItemFacts(skuCode) {
    return api.chatSkuSlots({ sku: skuCode })
      .then((res) => {
        const item = (res && res.item) || {}
        this.setData({
          itemGrade: item.grade || this.data.itemGrade || '',
          // 库位/编号/状态已经在商品卡单独展示，标签只留包邮等补充信息，避免重复。
          itemTags: (item.tags || []).filter((t) => !/^库位 /.test(t) && !/^#/.test(t)),
        })
        this._applySlots(res)
      })
      .catch(() => {})
  },

  openProductDetail() {
    const sku = this.data.itemSku || (this._conv && this._conv.listing_sku) || ''
    const params = [`conversation_id=${encodeURIComponent(this.data.id)}`]
    if (sku) params.push(`sku=${encodeURIComponent(sku)}`)
    wx.navigateTo({ url: `/pages/gc-chat/product/index?${params.join('&')}` })
  },

  openSkuMatcher() {
    this.setData({ panel: 'more' })
    this._scrollToEnd()
    this.loadSlots()
  },

  previewItemImage() {
    const { itemImage } = this.data
    if (!itemImage) return
    wx.previewImage({ urls: [itemImage] })
  },

  openItemLink() {
    platform.openUrl(this.data.itemUrl)
  },

  onMore() {
    const actions = [{ label: '刷新消息', run: () => this.loadMessages() }]
    if (this.data.title) {
      actions.push({ label: '复制买家昵称', run: () => wx.setClipboardData({ data: this.data.title }) })
    }
    if (this.data.itemUrl) {
      actions.push({ label: '复制商品链接', run: () => wx.setClipboardData({ data: this.data.itemUrl }) })
    }
    const sku = this._conv && this._conv.listing_sku
    if (sku) {
      actions.push({ label: '查看商品详情', run: () => this.openProductDetail() })
    }
    actions.push({ label: '开议价', run: () => this.openBargain() })
    wx.showActionSheet({
      itemList: actions.map((a) => a.label),
      success: (res) => {
        const a = actions[res.tapIndex]
        if (a) a.run()
      },
    })
  },

  // 把本群控会话绑到采购议价（开聊或复用未结束单）
  openBargain() {
    const conv = this._conv || {}
    const listed = this.data.itemPrice || conv.item_price
    const payload = {
      gc_conversation_id: this.data.id || null,
      platform_item_id: conv.item_id || null,
      source_url: this.data.itemUrl || conv.item_url || null,
      purchase_account: this.data.accountNick || conv.account_nick || null,
      seller_name: this.data.title || conv.peer_nick || null,
      title: this.data.itemTitle || conv.item_title || null,
      listed_price: listed ? Number(listed) : null,
    }
    if (!payload.gc_conversation_id && !payload.platform_item_id && !payload.title) {
      wx.showToast({ title: '会话信息不完整', icon: 'none' })
      return
    }
    wx.showLoading({ title: '开议价…' })
    api.openBargainSession(payload)
      .then((row) => {
        wx.hideLoading()
        wx.navigateTo({ url: `/pages/purchase/bargain/detail/index?id=${row.id}` })
      })
      .catch((err) => {
        wx.hideLoading()
        wx.showToast({ title: (err && err.detail) || '开议价失败', icon: 'none' })
      })
  },

  // ------------------------------------------------------------------ 消息
  loadMessages(silent) {
    const { id } = this.data
    if (!id) return Promise.resolve()
    if (!silent) this.setData({ loading: true })
    return api.gcChatMessages(id, { page: 1, size: PAGE_SIZE, tail: 1 })
      .then((res) => {
        const rows = Array.isArray(res) ? res : (res && res.items) || []
        const sig = signature(rows)
        const echoes = this._unsettledEchoes(rows)
        const changed = sig !== this._sig
        if (silent && !changed && !this._echoDirty) return
        const hadNewIn = changed && this._sig && rows.length && rows[rows.length - 1].direction === 'in'
        this._sig = sig
        this._echoDirty = false
        // 还没出结果/没发成的本地回显接在后面,别被刷新冲掉
        this.setData({ messages: decorate(rows.concat(echoes)), loading: false })
        if (changed) this._scrollToEnd()
        if (!silent || hadNewIn) this._markRead()
      })
      .catch((err) => {
        if (silent) return
        this.setData({ loading: false })
        wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
      })
  },

  // 小程序侧未读清零(不影响闲鱼端红点)
  _markRead() {
    api.gcChatMarkRead(this.data.id).catch(() => {})
  },

  _startRefresh() {
    if (this._refreshTimer || !this.data.id) return
    this._refreshTimer = setInterval(() => {
      if (this.data.loading || this._refreshing) return
      this._refreshing = true
      this.loadMessages(true).finally(() => { this._refreshing = false })
    }, REFRESH_MS)
  },

  _stopRefresh() {
    if (this._refreshTimer) { clearInterval(this._refreshTimer); this._refreshTimer = null }
  },

  onDraftInput(e) {
    this.setData({ draft: e.detail.value })
  },

  // 回复是异步链路:提交即建单,由归属账号的设备进会话发送。提交后盯着这条回复任务
  // (接口回的 task_id):发出去了就刷新消息列表(服务端已落库),没发成就说清原因。
  sendReply() {
    const { id, draft, sending } = this.data
    const text = (draft || '').trim()
    if (!id || !text || sending) return
    this.setData({ sending: true })
    this._submitReply({ text }, { text })
      .then(() => this.setData({ draft: '', sending: false }))
      .catch(() => this.setData({ sending: false }))
  },

  // 文字或图片视频都走这里:建单 → 本地回显 → 盯任务
  _submitReply(body, echoFields) {
    const { id } = this.data
    return api.gcChatReply(id, body)
      .then((res) => {
        api.collabReplied(id).catch(() => {})
        const echo = {
          id: `local-${Date.now()}`,
          direction: 'out',
          text: echoFields.text || '',
          msg_at: null,
          created_at: new Date().toISOString(),
          _media: echoFields.media || null,
          _card: echoFields.card || null,
          _echo: true,
          _sentAt: Date.now(),
          _state: 'pending',
          _label: ECHO_LABEL.pending,
        }
        this.setData({ messages: decorate(this.data.messages.concat([echo])) })
        this._scrollToEnd()
        const taskId = res && res.task_id
        if (!taskId) {
          wx.showToast({ title: '已提交，设备发送中', icon: 'none' })
          return res
        }
        this._watch[taskId] = { echoId: echo.id, deadline: Date.now() + POLL_MAX_MS }
        this._startPoll()
        return res
      })
      .catch((err) => {
        wx.showToast({ title: (err && err.detail) || '发送失败', icon: 'none' })
        throw err
      })
  },

  _startPoll() {
    if (this._pollTimer || !this._watch || !Object.keys(this._watch).length) return
    this._pollTimer = setInterval(() => this._poll(), POLL_INTERVAL_MS)
  },

  _stopPoll() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null }
  },

  // 这单不盯了;一单都不剩就停表
  _unwatch(taskId) {
    delete this._watch[taskId]
    if (!Object.keys(this._watch).length) this._stopPoll()
  },

  _poll() {
    const ids = Object.keys(this._watch || {})
    if (!ids.length) { this._stopPoll(); return }
    ids.forEach((taskId) => {
      const w = this._watch[taskId]
      if (w.busy) return
      w.busy = true
      api.gcOpsTask(taskId)
        .then((t) => {
          w.busy = false
          if (this._watch[taskId] !== w) return   // 页面已离开
          if (DONE_STATUSES.indexOf(t.status) >= 0) {
            this._unwatch(taskId)
            this._onReplyDone(w.echoId, t)
          } else if (Date.now() > w.deadline) {
            this._unwatch(taskId)
            this._settle(w.echoId, 'queued')
            wx.showToast({ title: '设备还没轮到发这条，稍后再看', icon: 'none' })
          }
        })
        .catch((err) => {
          w.busy = false
          if (this._watch[taskId] !== w) return
          // 断网、群控一时连不上:下一拍再查;这单查不到(404)或盯满时限就不盯了
          if ((err && err.statusCode === 404) || Date.now() > w.deadline) {
            this._unwatch(taskId)
            this._settle(w.echoId, 'queued')
          }
        })
    })
  },

  _onReplyDone(echoId, t) {
    if (t.status === 'SUCCESS') {
      this._settle(echoId, 'sent')
      this.loadMessages(true)
      return
    }
    if (t.failed_step === 'reply_verify') {
      // 点了发送、回读没核对上:多半已经到买家那边了,再发就是两遍
      this._settle(echoId, 'unsure')
      wx.showModal({ title: '可能已经发出去了', content: '先别重发，过一会儿看看消息有没有出现。', showCancel: false })
      return
    }
    this._settle(echoId, 'failed')
    const lines = []
    if (t.failed_step) lines.push(`失败环节：${friendlyStep(t.failed_step)}`)
    lines.push(`原因：${t.status === 'CANCELLED'
      ? '账号暂停了自动操作（掉登录或被平台限制），排队的消息被取消了'
      : (friendlyText(t.error) || '没说原因')}`)
    wx.showModal({ title: '这条没发出去', content: lines.join('\n'), showCancel: false })
  },

  // 本地回显换状态:时间那一格换成状态字,没发成的标警示色
  _settle(echoId, state) {
    const messages = this.data.messages.map((m) => (m.id === echoId
      ? { ...m, _state: state, _label: ECHO_LABEL[state] || '', _warn: state !== 'sent' && state !== 'pending' }
      : m))
    this._echoDirty = true
    this.setData({ messages })
  },

  // 刷新时还要留着的本地回显:发送中、没发出去的留着;没核对上/还在排队的,服务端已经有了
  // 同一句(会话扫描读回来了)就不再留;发成功的服务端已落库,不留
  _unsettledEchoes(rows) {
    return this.data.messages.filter((m) => {
      if (!m._echo || m._state === 'sent') return false
      if (m._state === 'pending' || m._state === 'failed') return true
      if (m._media) return true
      return !rows.some((r) => r.direction === 'out' && r.text === m.text &&
        utcMs(r.created_at) >= m._sentAt - 60000)
    })
  },

  // 滚到最新消息:先复位再定位,确保连续触发也生效
  _scrollToEnd() {
    this.setData({ anchorId: '' })
    wx.nextTick(() => this.setData({ anchorId: 'anchorEnd' }))
  },

  previewMessageMedia(e) {
    const { index, mi } = e.currentTarget.dataset
    const msg = this.data.messages[index]
    const list = (msg && msg._media) || []
    const md = list[mi]
    if (!md) return
    if (md.type === 'video') {
      wx.previewMedia({ sources: [{ url: md.url, type: 'video', poster: md.thumb || '' }] })
      return
    }
    const urls = list.filter((x) => x.type !== 'video').map((x) => x.url)
    wx.previewImage({ urls, current: md.url })
  },

  // ------------------------------------------------------------------ 面板
  closePanel() {
    if (this.data.panel) this.setData({ panel: '' })
  },

  // 输入框开了 hold-keyboard(点发送不先收键盘),点消息区要自己收;H5 由浏览器失焦收
  onStreamTap() {
    this.closePanel()
    if (!platform.isH5()) wx.hideKeyboard()
  },

  toggleEmoji() {
    this.setData({ panel: this.data.panel === 'emoji' ? '' : 'emoji' })
    this._scrollToEnd()
  },

  pickEmoji(e) {
    this.setData({ draft: `${this.data.draft || ''}${e.currentTarget.dataset.emoji}` })
  },

  toggleMore() {
    const open = this.data.panel !== 'more'
    this.setData({ panel: open ? 'more' : '' })
    this._scrollToEnd()
    if (open && !this.data.slots.length && !this.data.slotsLoading) this.loadSlots()
  },

  explainSkuSlots() {
    wx.showModal({
      title: 'SKU 槽是什么',
      content: '买家看的闲鱼链接是一款商品（SPU）。这里按成色列出同款在库的实物，点开看实拍，挑图片发给买家。',
      showCancel: false,
    })
  },

  // SKU 槽:先按会话对上的那件货找同款;对不上就等人粘贴链接
  loadSlots() {
    const sku = this._conv && this._conv.listing_sku
    if (!sku) {
      this.setData({ slotsError: '没认出这条链接是哪件货，在下面粘贴商品链接试试', slots: [] })
      return Promise.resolve()
    }
    return this._fetchSlots({ sku })
  },

  _fetchSlots(params) {
    this.setData({ slotsLoading: true, slotsError: '' })
    return api.chatSkuSlots(params)
      .then((res) => {
        this.setData({ slotsLoading: false })
        this._applySlots(res)
      })
      .catch((err) => {
        this.setData({ slotsLoading: false, slots: [], slotsError: (err && err.detail) || '没查到在库货' })
      })
  },

  _applySlots(res) {
    const slots = (res && res.slots) || []
    const total = slots.reduce((n, s) => n + (s.count || 0), 0)
    this._slotItems = {}
    slots.forEach((s) => { this._slotItems[s.key] = s.items || [] })
    this.setData({
      slots,
      spuName: (res && res.spu && res.spu.name) || '',
      slotsError: total ? '' : '同款现在没有在库的货',
    })
  },

  onLinkInput(e) {
    this.setData({ linkDraft: e.detail.value })
  },

  clearLink() {
    this.setData({ linkDraft: '' })
  },

  // 粘贴的是闲鱼链接:先让群控认出是哪件货;不是链接就当货号 / 上架编码 / 型号去 ERP 找
  applyLink() {
    const text = (this.data.linkDraft || '').trim()
    if (!text) return
    if (/^https?:\/\//i.test(text) || /goofish|xianyu|taobao|tb\.cn/i.test(text)) {
      this.setData({ slotsLoading: true, slotsError: '' })
      api.gcChatResolveItem(text)
        .then((res) => {
          if (!res || !res.sku) throw { detail: '这条链接不是我们店里在架的货' }
          return this._fetchSlots({ sku: res.sku })
        })
        .catch((err) => {
          this.setData({ slotsLoading: false, slots: [], slotsError: (err && err.detail) || '没认出这条链接' })
        })
      return
    }
    this._fetchSlots({ q: text })
  },

  // ------------------------------------------------------------------ 商品详情（WMS）
  openSlot(e) {
    const key = e.currentTarget.dataset.key
    const items = (this._slotItems && this._slotItems[key]) || []
    if (!items.length) {
      wx.showToast({ title: '这个成色现在没货', icon: 'none' })
      return
    }
    this.setData({
      slotKey: key,
      sheet: 'pick',
      sku: { items, skuId: '', title: '', media: [], cur: 0, tab: 'all', loading: true, error: '' },
    })
    this._loadSkuMedia(items[0].sku_id, items[0].sku_code)
  },

  switchSku(e) {
    const id = e.currentTarget.dataset.id
    const item = this.data.sku.items.find((x) => x.sku_id === id)
    if (!item || id === this.data.sku.skuId) return
    this._loadSkuMedia(item.sku_id, item.sku_code)
  },

  _loadSkuMedia(skuId, skuCode) {
    this.setData({ 'sku.skuId': skuId, 'sku.loading': true, 'sku.error': '', 'sku.media': [], 'sku.cur': 0 })
    api.chatSkuMedia(skuCode)
      .then((res) => {
        if (this.data.sku.skuId !== skuId) return
        const media = ((res && res.media) || []).map((m) => withCover({
          ...m,
          duration: videoDuration(m.duration),
          _on: !!this._picked[m.url],
        }))
        this._skuFacts[skuCode] = { title: res.product_name || '', grade: res.grade || '', price: res.price || '' }
        const parts = [res.product_name, res.grade, res.location_code ? `库位 ${res.location_code}` : '', res.short_code ? `#${res.short_code}` : '']
        this.setData({
          'sku.loading': false,
          'sku.media': media,
          'sku.title': parts.filter(Boolean).join(' · '),
          'sku.imageCount': media.filter((m) => m.type === 'image').length,
          'sku.videoCount': media.filter((m) => m.type === 'video').length,
        })
        this._showHero(0)
      })
      .catch((err) => {
        if (this.data.sku.skuId !== skuId) return
        this.setData({ 'sku.loading': false, 'sku.error': (err && err.detail) || '实拍没加载出来' })
      })
  },

  _showHero(i) {
    const media = this.data.sku.media
    if (!media.length) return
    const cur = (i + media.length) % media.length
    const m = media[cur]
    this.setData({
      'sku.cur': cur,
      // 大图用原图(缩略图只有 240 宽,放大发糊);视频用截帧封面
      'sku.heroSrc': m.type === 'video' ? (m.thumb || '') : m.url,
      'sku.heroIsVideo': m.type === 'video',
      'sku.stripAnchor': `strip${Math.max(0, cur - 1)}`,
    })
  },

  showMedia(e) {
    this._showHero(Number(e.currentTarget.dataset.index))
  },

  prevMedia() {
    this._showHero(this.data.sku.cur - 1)
  },

  nextMedia() {
    this._showHero(this.data.sku.cur + 1)
  },

  previewHero() {
    const media = this.data.sku.media
    const m = media[this.data.sku.cur]
    if (!m) return
    if (m.type === 'video') {
      wx.previewMedia({ sources: [{ url: m.url, type: 'video', poster: m.thumb || '' }] })
      return
    }
    const urls = media.filter((x) => x.type === 'image').map((x) => x.url)
    wx.previewImage({ urls, current: m.url })
  },

  switchTab(e) {
    this.setData({ 'sku.tab': e.currentTarget.dataset.tab })
  },

  toggleMedia(e) {
    const index = Number(e.currentTarget.dataset.index)
    const m = this.data.sku.media[index]
    if (!m) return
    // 视频留着给人看,闲鱼网页版聊天发不了
    if (m.type === 'video') {
      wx.showToast({ title: '闲鱼网页版发不了视频，请选图片', icon: 'none' })
      this._showHero(index)
      return
    }
    if (!m._on) {
      const counts = this._pickedCounts()
      if (m.type === 'image' && counts.image >= MAX_IMAGES) {
        wx.showToast({ title: `图片一次最多发 ${MAX_IMAGES} 张`, icon: 'none' })
        return
      }
      this._picked[m.url] = withCover({
        type: m.type, url: m.url, thumb: m.thumb || '', duration: m.duration || '', skuCode: this._curSkuCode(),
      })
    } else {
      delete this._picked[m.url]
    }
    this.setData({ [`sku.media[${index}]._on`]: !m._on })
    this._syncPicked()
    if (!m._on) this._showHero(index)
  },

  _pickedCounts() {
    const all = Object.keys(this._picked).map((k) => this._picked[k])
    return { image: all.filter((x) => x.type === 'image').length, video: all.filter((x) => x.type === 'video').length }
  },

  _syncPicked() {
    const all = Object.keys(this._picked).map((k) => this._picked[k])
    this.setData({
      pickedCount: all.length,
      pickedImages: all.filter((x) => x.type === 'image'),
      pickedVideos: all.filter((x) => x.type === 'video'),
    })
  },

  _curSkuCode() {
    const item = this.data.sku.items.find((x) => x.sku_id === this.data.sku.skuId)
    return item ? item.sku_code : ''
  },

  // 选的图都是同一件货才有卡片。价格优先用会话页上闲鱼显示的(台账价可能和页面不一样)
  _buildProductCard() {
    const codes = Object.keys(this._picked).map((k) => this._picked[k].skuCode)
    const code = codes[0]
    if (!code || codes.some((c) => c !== code) || !this._skuFacts[code]) return null
    const facts = this._skuFacts[code]
    const sameAsConv = this._conv && this._conv.listing_sku === code
    const pagePrice = sameAsConv ? String(this.data.itemPrice || '').replace(/[^\d.]/g, '') : ''
    return { title: facts.title, grade: facts.grade, price: pagePrice || facts.price || '' }
  },

  goConfirm() {
    if (!this.data.pickedCount) return
    this.setData({
      sheet: 'confirm',
      confirmTab: this.data.pickedImages.length ? 'image' : 'video',
      confirmAnchor: '',
      productCard: this._fromDevice ? null : this._buildProductCard(),
    })
  },

  onCardPriceInput(e) {
    this.setData({ 'productCard.price': e.detail.value.trim() })
  },

  backToPick() {
    // 从相册 / 拍摄直接进来的没有「商品详情」那一步,返回就是关掉
    if (this._fromDevice) {
      this.closeSheet()
      return
    }
    const media = this.data.sku.media.map((m) => ({ ...m, _on: !!this._picked[m.url] }))
    this.setData({ sheet: 'pick', 'sku.media': media })
  },

  switchConfirmTab(e) {
    const tab = e.currentTarget.dataset.tab
    this.setData({ confirmTab: tab, confirmAnchor: tab === 'video' ? 'confirmVideos' : 'confirmImages' })
  },

  unpick(e) {
    delete this._picked[e.currentTarget.dataset.url]
    this._syncPicked()
    if (!this.data.pickedCount) this.backToPick()
  },

  closeSheet() {
    this._picked = {}
    this._fromDevice = false
    this._syncPicked()
    this.setData({ sheet: '', slotKey: '' })
  },

  // 买家收到图片和一句文字;卡片只在我们这边显示。没有卡片(相册 / 拍摄、跨货号)就只发图片
  sendPicked() {
    const items = this.data.pickedImages.concat(this.data.pickedVideos)
    if (!items.length || this.data.sendingMedia) return
    const media = items.map((m) => ({ type: m.type, url: m.url }))
    const echoMedia = items.map((m) => withCover({ type: m.type, url: m.url, thumb: m.thumb }))
    this.setData({ sendingMedia: true })
    const card = this.data.productCard
    const body = { media }
    const echo = { media: echoMedia }
    if (card) {
      body.card = card
      body.text = cardText(card)
      echo.card = card
      echo.text = body.text
    }
    this._submitReply(body, echo)
      .then(() => {
        this.setData({ sendingMedia: false, panel: '' })
        this.closeSheet()
      })
      .catch(() => this.setData({ sendingMedia: false }))
  },

  // ------------------------------------------------------------------ 相册 / 拍摄 / 仓库位置
  pickFromAlbum() {
    this._pickFromDevice(['album'])
  },

  pickFromCamera() {
    this._pickFromDevice(['camera'])
  },

  // 手机里的图:先传到 OSS,再走同一个「发送给买家」确认
  _pickFromDevice(sourceType) {
    wx.chooseMedia({
      count: MAX_IMAGES,
      mediaType: ['image'],
      sourceType,
      sizeType: ['compressed'],
      success: (res) => {
        const files = (res.tempFiles || []).slice(0, MAX_IMAGES)
        if (!files.length) return
        wx.showLoading({ title: '上传中…', mask: true })
        const uploads = files.map((f) => api.uploadMedia('chat/outbox', 'chat.jpg', f.tempFilePath).then((tk) => withCover({
          type: 'image',
          url: tk.public_url || tk.access_url,
          thumb: tk.access_url || tk.public_url,
          duration: '',
        })))
        Promise.all(uploads)
          .then((items) => {
            wx.hideLoading()
            this._picked = {}
            items.forEach((m) => { this._picked[m.url] = m })
            this._fromDevice = true
            this._syncPicked()
            this.setData({ sheet: 'confirm', confirmTab: this.data.pickedImages.length ? 'image' : 'video' })
          })
          .catch((err) => {
            wx.hideLoading()
            wx.showToast({ title: (err && err.detail) || '上传失败', icon: 'none' })
          })
      },
    })
  },

  // 发出去的是一段地址文字,发之前给人看一眼原文。地址由管理员在这里直接填 / 改
  sendWarehouseLocation() {
    const isAdmin = ((getApp().globalData || {}).user || {}).role === 'ADMIN'
    api.appConfig()
      .then((cfg) => {
        const text = ((cfg && cfg.pickup_address) || '').trim()
        if (!text) {
          if (isAdmin) {
            this._editPickupAddress('')
            return
          }
          wx.showModal({ title: '还没填仓库地址', content: '请管理员在聊天页「发送仓库位置」里填好自提地址。', showCancel: false })
          return
        }
        if (!isAdmin) {
          this._confirmSendAddress(text)
          return
        }
        wx.showActionSheet({
          itemList: ['发给买家', '修改地址'],
          success: (r) => (r.tapIndex === 0 ? this._confirmSendAddress(text) : this._editPickupAddress(text)),
        })
      })
      .catch(() => wx.showToast({ title: '没取到仓库地址', icon: 'none' }))
  },

  _confirmSendAddress(text) {
    wx.showModal({
      title: '发给买家这段地址？',
      content: text,
      confirmText: '发送',
      success: (r) => {
        if (!r.confirm) return
        this.setData({ panel: '' })
        this._submitReply({ text }, { text }).catch(() => {})
      },
    })
  },

  _editPickupAddress(current) {
    wx.showModal({
      title: '仓库自提地址',
      editable: true,
      content: current,
      placeholderText: '如：杭州市余杭区 xx 路 xx 号 A 仓，自提请提前联系',
      confirmText: '保存',
      success: (r) => {
        if (!r.confirm) return
        const text = (r.content || '').trim()
        api.setPickupAddress(text)
          .then(() => {
            // 存好了直接问发不发(弹窗本身就说明存上了);清空的才提示一句
            if (text) this._confirmSendAddress(text)
            else wx.showToast({ title: '地址已清空', icon: 'none' })
          })
          .catch((err) => wx.showToast({ title: (err && err.detail) || '保存失败', icon: 'none' }))
      },
    })
  },
})

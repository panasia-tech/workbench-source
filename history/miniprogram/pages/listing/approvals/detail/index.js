const api = require('@services/api')
const auth = require('@services/auth')

// 一件货的上架审批：每个号一格，填价、挑图排序、存草稿、提交；管理员勾几个号一起通过或退回。
// 各号的图一张都不能重复（11-05 定，11-10 重申）：别的号已经选了的图这里点不上。
// 缩略图只用这件货的实拍图、上架图、同款图，不用封面（封面里有过买家订单截图）。
const STATE_CLASS = {
  NONE: 'lap-st--none',
  DRAFT: 'lap-st--draft',
  SUBMITTED: 'lap-st--wait',
  APPROVED: 'lap-st--ok',
  REJECTED: 'lap-st--bad',
  STALE: 'lap-st--bad',
}
const EDITABLE = ['NONE', 'DRAFT', 'REJECTED', 'STALE', 'APPROVED']

// 爬虫评成 bad 的同款图，角标写出毛病（水印、海报字……）
function sourceText(c) {
  if (!c.crawled) return c.source
  const bad = (c.flags || []).filter((f) => f !== '白底' && f !== '纯色背景')
  return c.grade === 'bad' && bad.length ? `同款·${bad[0]}` : '同款'
}

function intPrice(v) {
  const n = parseInt(String(v === null || v === undefined ? '' : v).replace(/[^\d]/g, ''), 10)
  return n > 0 ? n : null
}

Page({
  data: {
    loading: true,
    res: null,
    readonly: '',
    cards: [],
    pickedCount: 0,
    allPicked: false,
    saving: false,
    canSubmit: false,
    canReview: false,
    sheet: null,
    reject: null,
  },

  onLoad(options) {
    this.code = decodeURIComponent((options && options.code) || '')
    this.drafts = {}
    this.picked = {}
    auth.ensureLogin().then(() => {
      // 去水印能用才给按钮（京东云那台连不上就不显示）
      api.dewatermarkStatus().then((r) => { this.dewmOk = !!(r && r.available) }).catch(() => {})
      return this.load()
    })
  },

  load() {
    return api.listingApprovalSku(this.code)
      .then((res) => this.apply(res))
      .catch((err) => {
        this.setData({ loading: false })
        wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
      })
  },

  // 接口回来的是存好的样子：没存的改动以服务端为准（存草稿 / 提交以后都是这样）
  apply(res) {
    const urls = {}
    ;(res.candidates || []).forEach((c) => { urls[c.raw] = c })
    res.shops.forEach((s) => {
      ;((s.approval && s.approval.images) || []).forEach((img) => { if (!urls[img.raw]) urls[img.raw] = img })
    })
    this.urls = urls
    // 后端算好的「哪些图已经被别的号占了」：已提交/已批审批、在架号、停用号都在里面，
    // 选图时直接禁用。不能只看别的号的草稿，否则草稿没存/在架共用图都能点，提交才报重复。
    this.occupied = res.occupied || {}
    this.drafts = {}
    res.shops.forEach((s) => {
      const a = s.approval
      this.drafts[s.id] = {
        price: a && a.price ? String(a.price) : '',
        images: ((a && a.images) || []).map((x) => x.raw),
        note: (a && a.note) || '',
        dirty: false,
      }
    })
    const picked = {}
    res.shops.forEach((s) => { if (this.picked[s.id]) picked[s.id] = true })
    this.picked = picked
    const sku = res.sku
    const readonly = sku.status !== 'IN_STOCK' || sku.reserved ? '货不在库或已锁定，只能看' : ''
    this.res = res
    this.setData({ loading: false, res, readonly })
    this._render()
  },

  _render() {
    const res = this.res
    const floor = res.floor_price
    const high = this._highLine()
    const cards = res.shops.map((s) => {
      const d = this.drafts[s.id]
      const a = s.approval || {}
      const price = intPrice(d.price)
      return {
        id: s.id,
        label: s.label,
        state: s.cell.state,
        stateLabel: s.cell.label,
        stateClass: STATE_CLASS[s.cell.state] || '',
        listed: s.cell.listed,
        needsFix: s.cell.needs_fix,
        problem: s.cell.problem,
        version: a.version || 0,
        rejected: a.status === 'REJECTED',
        reviewNote: a.review_note || '',
        reviewMedia: a.review_media || [],
        who: a.submitted_by_name ? `${a.submitted_by_name} 提交${a.reviewed_by_name ? `，${a.reviewed_by_name} 审批` : ''}` : '',
        mine: !!a.submitted_by_me,
        editable: !this.data.readonly && EDITABLE.indexOf(s.cell.state) >= 0,
        price: d.price,
        low: !!(floor && price && price < floor),
        // 高于成本 5 倍：标黄提醒，不拦
        high: !!(high && price && price > high),
        note: d.note,
        images: d.images.map((raw) => ({ raw, thumb: (this.urls[raw] && this.urls[raw].thumb) || raw })),
        dirty: d.dirty,
        picked: !!this.picked[s.id],
      }
    })
    const picked = cards.filter((c) => c.picked)
    this.setData({
      cards,
      pickedCount: picked.length,
      allPicked: picked.length === cards.length && cards.length > 0,
      canSubmit: !this.data.readonly && picked.length > 0 && picked.every((c) => c.state !== 'SUBMITTED'),
      canReview: !!res.can_review && picked.length > 0 && picked.every((c) => c.state === 'SUBMITTED'),
    })
  },

  _index(id) {
    return this.data.cards.findIndex((c) => c.id === id)
  },

  // ------------------------------------------------------------ 勾号
  togglePick(e) {
    const id = e.currentTarget.dataset.id
    if (this.picked[id]) delete this.picked[id]
    else this.picked[id] = true
    this._render()
  },

  toggleAll() {
    const all = !this.data.allPicked
    this.picked = {}
    if (all) this.res.shops.forEach((s) => { this.picked[s.id] = true })
    this._render()
  },

  // ------------------------------------------------------------ 价
  onPrice(e) {
    const id = e.currentTarget.dataset.id
    const value = String(e.detail.value || '').replace(/[^\d]/g, '')
    const d = this.drafts[id]
    d.price = value
    d.dirty = true
    const i = this._index(id)
    const floor = this.res.floor_price
    const high = this._highLine()
    const n = intPrice(value)
    this.setData({
      [`cards[${i}].price`]: value,
      [`cards[${i}].dirty`]: true,
      [`cards[${i}].low`]: !!(floor && n && n < floor),
      [`cards[${i}].high`]: !!(high && n && n > high),
    })
    return value
  },

  // 成本 × 5：高于它标黄
  _highLine() {
    const cost = Number(this.res.sku.cost_price)
    return cost > 0 ? cost * (this.res.high_price_multiple || 5) : 0
  },

  // 低于最低价要写理由（管理员看了才批）
  onNote(e) {
    const id = e.currentTarget.dataset.id
    const d = this.drafts[id]
    d.note = e.detail.value
    d.dirty = true
    const i = this._index(id)
    this.setData({ [`cards[${i}].note`]: d.note, [`cards[${i}].dirty`]: true })
  },

  fillPrice(e) {
    const id = e.currentTarget.dataset.id
    const price = this.drafts[id].price
    if (!intPrice(price)) {
      wx.showToast({ title: '先填这个号的价', icon: 'none' })
      return
    }
    let n = 0
    this.data.cards.forEach((c) => {
      if (c.id !== id && c.editable && !intPrice(this.drafts[c.id].price)) {
        this.drafts[c.id].price = price
        this.drafts[c.id].dirty = true
        n += 1
      }
    })
    this._render()
    wx.showToast({ title: n ? `填了 ${n} 个号，记得存` : '别的号都填过了', icon: 'none' })
  },

  // ------------------------------------------------------------ 已选的图：设首图 / 去水印 / 拿掉 / 看大图
  tapPicked(e) {
    const { id, index } = e.currentTarget.dataset
    const card = this.data.cards[this._index(id)]
    const i = Number(index)
    const raw = card.images[i] && card.images[i].raw
    if (!raw) return
    const items = card.editable ? ['看大图', '设为首图'].concat(this.dewmOk ? ['去水印'] : [], ['拿掉']) : ['看大图']
    wx.showActionSheet({
      itemList: items,
      success: (r) => {
        const act = items[r.tapIndex]
        const d = this.drafts[id]
        if (act === '看大图') {
          const urls = d.images.map((u) => (this.urls[u] && this.urls[u].url) || u)
          wx.previewImage({ urls, current: urls[i] })
          return
        }
        if (act === '去水印') {
          this._dewatermark(id, raw)
          return
        }
        d.images = act === '设为首图' ? [raw].concat(d.images.filter((u) => u !== raw)) : d.images.filter((u) => u !== raw)
        d.dirty = true
        this._render()
      },
    })
  },

  // 去右下角闲鱼水印：去好的另存一张换到原位置（原图不动，还在候选里）；
  // 检查没过的不替换，放进候选让人看过再换；没认出的原样不动
  _dewatermark(id, raw) {
    wx.showLoading({ title: '去水印中…', mask: true })
    api.dewatermarkImage(raw).then((r) => {
      wx.hideLoading()
      if (!r.result_url) {
        wx.showToast({ title: r.status === 'not_found' ? '没认出闲鱼水印，原图没动' : ((r.reasons && r.reasons[0]) || r.status_label), icon: 'none' })
        return
      }
      const c = { raw: r.result_url, url: r.result_url, thumb: r.result_url, source: r.status === 'done' ? '去水印' : '去水印·要看' }
      this.res.candidates.push(c)
      this.urls[r.result_url] = c
      if (r.status !== 'done') {
        this._render()
        wx.showModal({
          title: '去过了，要人看一眼',
          content: `${(r.reasons || []).join('；')}。新图放进「改图」里了，看过没问题再换上。`,
          showCancel: false,
          confirmText: '知道了',
        })
        return
      }
      const d = this.drafts[id]
      d.images = d.images.map((u) => (u === raw ? r.result_url : u))
      d.dirty = true
      this._render()
      wx.showToast({ title: '已去水印，记得存草稿', icon: 'none' })
    }).catch((err) => {
      wx.hideLoading()
      wx.showToast({ title: (err && err.detail) || '去水印失败', icon: 'none' })
    })
  },

  previewReview(e) {
    const { id, index } = e.currentTarget.dataset
    const card = this.data.cards[this._index(id)]
    const urls = card.reviewMedia.map((m) => m.url)
    wx.previewImage({ urls, current: urls[Number(index)] })
  },

  // ------------------------------------------------------------ 挑图
  openSheet(e) {
    const id = e.currentTarget.dataset.id
    this._sheetFor(id, this.drafts[id].images.slice())
  },

  _sheetFor(id, sel) {
    const card = this.data.cards[this._index(id)]
    // 别的号（含没存的改动）已经选了的图 → 号名
    const taken = {}
    this.data.cards.forEach((c) => {
      if (c.id === id) return
      this.drafts[c.id].images.forEach((u) => { if (!taken[u]) taken[u] = c.label })
    })
    const held = this.res.held || {}
    const occupied = this.occupied || {}
    const items = (this.res.candidates || []).map((c) => {
      // 别的号（已提交/已批、在架、停用）占着的图：和后端 _clash 同一个口径，直接禁用
      const holders = (occupied[c.raw] || []).filter((h) => h.id !== id)
      return {
        raw: c.raw,
        thumb: c.thumb || c.url,
        source: sourceText(c),
        bad: c.crawled && c.grade === 'bad',
        takenBy: taken[c.raw] || (holders.length ? holders[0].label : ''),
        live: held[c.raw] && held[c.raw] !== card.label ? held[c.raw] : '',
        no: sel.indexOf(c.raw) + 1,
      }
    })
    this.setData({
      sheet: {
        id,
        label: card.label,
        items,
        sel,
        max: this.res.max_images || 9,
        crawlStatus: this.res.crawl_status || '',
      },
    })
  },

  closeSheet() {
    this.setData({ sheet: null })
  },

  noop() {},

  tapSheetItem(e) {
    const sheet = this.data.sheet
    const item = sheet.items[Number(e.currentTarget.dataset.index)]
    if (!item) return
    const sel = sheet.sel.slice()
    const at = sel.indexOf(item.raw)
    if (at >= 0) {
      // 已经选了的（包括历史上撞上的图）必须能点掉；先判 takenBy 会导致冲突图永远拿不掉，
      // 怎么换别的图提交都还是同一张冲突
      sel.splice(at, 1)
    } else if (item.takenBy) {
      wx.showToast({ title: `已给「${item.takenBy}」用了，每个号的图不能重复`, icon: 'none' })
      return
    } else if (sel.length >= sheet.max) {
      wx.showToast({ title: `一个号最多 ${sheet.max} 张`, icon: 'none' })
      return
    } else sel.push(item.raw)
    this.setData({
      'sheet.sel': sel,
      'sheet.items': sheet.items.map((x) => ({ ...x, no: sel.indexOf(x.raw) + 1 })),
    })
  },

  previewSheetItem(e) {
    const sheet = this.data.sheet
    const urls = sheet.items.map((x) => (this.urls[x.raw] && this.urls[x.raw].url) || x.thumb)
    wx.previewImage({ urls, current: urls[Number(e.currentTarget.dataset.index)] })
  },

  uploadInSheet() {
    const sheet = this.data.sheet
    const room = sheet.max - sheet.sel.length
    if (room <= 0) {
      wx.showToast({ title: `一个号最多 ${sheet.max} 张`, icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: room,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (r) => {
        wx.showLoading({ title: '上传中' })
        const tasks = r.tempFiles.map((f, i) => api.uploadMedia(this.res.upload_dir, `${Date.now()}_${i}.jpg`, f.tempFilePath))
        Promise.all(tasks).then((out) => {
          wx.hideLoading()
          const added = out.map((x) => x.public_url).filter(Boolean)
          added.forEach((u) => {
            const c = { raw: u, url: u, thumb: u, source: '新上传' }
            this.res.candidates.push(c)
            this.urls[u] = c
          })
          this._sheetFor(sheet.id, sheet.sel.concat(added))
        }).catch(() => {
          wx.hideLoading()
          wx.showToast({ title: '上传失败', icon: 'none' })
        })
      },
    })
  },

  confirmSheet() {
    const sheet = this.data.sheet
    const d = this.drafts[sheet.id]
    d.images = sheet.sel.slice()
    d.dirty = true
    this.setData({ sheet: null })
    this._render()
  },

  // ------------------------------------------------------------ 存草稿 / 提交
  _put(id) {
    const d = this.drafts[id]
    return api.saveListingApprovalDraft(this.code, id, { price: intPrice(d.price), images: d.images, note: d.note })
  },

  saveShop(e) {
    const id = e.currentTarget.dataset.id
    if (this.data.saving) return
    this.setData({ saving: true })
    const others = this._unsavedOthers([id])
    this._put(id)
      .then((res) => {
        this._applyKeeping(res, others)
        wx.showToast({ title: '已存草稿', icon: 'none' })
      })
      .catch((err) => wx.showModal({ title: '没存上', content: (err && err.detail) || '保存失败', showCancel: false }))
      .finally(() => this.setData({ saving: false }))
  },

  // 存一个号的时候，别的号没存的改动留在页面上
  _unsavedOthers(ids) {
    const keep = {}
    Object.keys(this.drafts).forEach((k) => {
      if (ids.indexOf(k) < 0 && this.drafts[k].dirty) keep[k] = { ...this.drafts[k], images: this.drafts[k].images.slice() }
    })
    return keep
  },

  _applyKeeping(res, keep) {
    this.apply(res)
    Object.keys(keep).forEach((k) => { if (this.drafts[k]) this.drafts[k] = keep[k] })
    this._render()
  },

  submitPicked() {
    if (!this.data.canSubmit || this.data.saving) return
    const ids = this.data.cards.filter((c) => c.picked).map((c) => c.id)
    const empty = this.data.cards.filter((c) => c.picked && (!c.images.length || !intPrice(c.price)))
    if (empty.length) {
      wx.showToast({ title: `「${empty[0].label}」还没填价或没选图`, icon: 'none' })
      return
    }
    const noReason = this.data.cards.find((c) => c.picked && c.low && (c.note || '').trim().length < 4)
    if (noReason) {
      wx.showToast({ title: `「${noReason.label}」低于最低价，要写理由（至少 4 个字）`, icon: 'none', duration: 2800 })
      return
    }
    this.setData({ saving: true })
    const others = this._unsavedOthers(ids)
    // 先把勾的号存成草稿，再一起提交
    ids.reduce((p, id) => p.then(() => this._put(id)), Promise.resolve())
      .then(() => api.submitListingApproval(this.code, ids))
      .then((res) => {
        const auto = !!(res && res.auto_publish)
        this.picked = {}
        this._applyKeeping(res, others)
        wx.showToast({ title: auto ? '已提交，正在发布' : '已提交审批', icon: 'success' })
        // 提交即发布是后台任务；过一会儿刷新，让 LISTING / 失败原因显示出来
        if (auto) setTimeout(() => this.load(), 1500)
      })
      .catch((err) => {
        wx.showModal({ title: '没提交上', content: (err && err.detail) || '提交失败', showCancel: false })
        return api.listingApprovalSku(this.code).then((res) => this._applyKeeping(res, others)).catch(() => {})
      })
      .finally(() => this.setData({ saving: false }))
  },

  // ------------------------------------------------------------ 管理员：通过 / 退回
  _mineInPicked() {
    const mine = this.data.cards.find((c) => c.picked && c.mine)
    if (mine) wx.showToast({ title: `「${mine.label}」是你提交的，要别人来批`, icon: 'none' })
    return !!mine
  },

  approvePicked() {
    if (!this.data.canReview || this.data.saving || this._mineInPicked()) return
    const low = this.data.cards.find((c) => c.picked && c.low)
    if (low && !this.res.can_review_low_price) {
      wx.showToast({ title: `「${low.label}」低于最低价，只有管理员能批`, icon: 'none', duration: 2800 })
      return
    }
    wx.showModal({
      title: `通过 ${this.data.pickedCount} 个号？`,
      content: '通过后这些号按批过的价和图发布。',
      confirmText: '通过',
      success: (r) => { if (r.confirm) this._review(true) },
    })
  },

  openReject() {
    if (!this.data.canReview || this.data.saving || this._mineInPicked()) return
    this.setData({ reject: { note: '', media: [], uploading: false } })
  },

  closeReject() {
    this.setData({ reject: null })
  },

  onRejectNote(e) {
    this.setData({ 'reject.note': e.detail.value })
  },

  addRejectMedia() {
    const media = this.data.reject.media
    const room = 9 - media.length
    if (room <= 0) return
    wx.chooseMedia({
      count: room,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (r) => {
        this.setData({ 'reject.uploading': true })
        const tasks = r.tempFiles.map((f, i) => api.uploadMedia('listing-approval/review', `${Date.now()}_${i}.jpg`, f.tempFilePath))
        Promise.all(tasks)
          .then((out) => this.setData({ 'reject.media': media.concat(out.map((x) => x.public_url).filter(Boolean)) }))
          .catch(() => wx.showToast({ title: '上传失败', icon: 'none' }))
          .finally(() => this.setData({ 'reject.uploading': false }))
      },
    })
  },

  removeRejectMedia(e) {
    const media = this.data.reject.media.slice()
    media.splice(Number(e.currentTarget.dataset.index), 1)
    this.setData({ 'reject.media': media })
  },

  confirmReject() {
    const reject = this.data.reject
    if (reject.uploading) return
    if (!reject.note.trim()) {
      wx.showToast({ title: '写一下原因：哪里不对、要补什么', icon: 'none' })
      return
    }
    this._review(false, reject.note.trim(), reject.media)
  },

  _review(approve, note, media) {
    const ids = this.data.cards.filter((c) => c.picked).map((c) => c.id)
    this.setData({ saving: true })
    const others = this._unsavedOthers([])
    api.reviewListingApproval(this.code, { shop_ids: ids, approve, note: note || '', media: media || [] })
      .then((res) => {
        this.picked = {}
        this.setData({ reject: null })
        this._applyKeeping(res, others)
        wx.showToast({ title: approve ? '已通过' : '已退回', icon: 'success' })
      })
      .catch((err) => wx.showModal({ title: '没办成', content: (err && err.detail) || '操作失败', showCancel: false }))
      .finally(() => this.setData({ saving: false }))
  },
})

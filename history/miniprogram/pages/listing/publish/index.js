const api = require('@services/api')
const shopsWs = require('@services/shops_ws')
const { friendlyText } = require('@utils/errmsg')
const material = require('@utils/image-material')

const SKIP_PUBLISH = { LISTED: true, SOLD: true }
const POLL_MS = 4000
// ≈4 分钟;真机异步上架收敛后自动停。没商品图的货要先 AI 生成主图(约 1 分钟)再上架,2 分钟不够
const POLL_MAX = 60
// 同款图还在爬:每 10s 刷一次候选,≈5 分钟后停;页面关掉/切走会清理
const IMG_POLL_MS = 10000
const IMG_POLL_MAX = 30

// 处理中(在途 gc 作业):上架中,或在架但正在下架。此态不可再操作、需轮询收敛。
// 等人确认 AI 主图的不算——它在等人,轮询也等不来。
function isTransient(s) {
  return (s.publish_status === 'LISTING' && !s.ai_image_awaiting_confirm) ||
    (s.publish_status === 'LISTED' && s.gc_pending)
}

// 设备类型:browser 严格按 device_kind;android = 非 browser(含未绑设备,默认真机)
function inKind(s, kind) {
  return kind === 'all' || (kind === 'browser' ? s.device_kind === 'browser' : s.device_kind !== 'browser')
}

// 勾选框三种样子:全选中 ✓ / 选了一部分 – / 一个没选;组里没有可上架的店铺就置灰点不动
function checkState(list, kind) {
  const group = list.filter((s) => s.canPublish && inKind(s, kind))
  if (!group.length) return { state: 'none', cls: 'dl-check--disabled' }
  const n = group.filter((s) => s.selected).length
  if (n === group.length) return { state: 'on', cls: 'dl-check--on' }
  return n ? { state: 'partial', cls: 'dl-check--partial' } : { state: 'off', cls: '' }
}

function enrichShops(shops) {
  const list = (shops || []).map((s) => {
    const canPublish =
      !SKIP_PUBLISH[s.publish_status] && s.publish_status !== 'LISTING' && !s.gc_pending
    // 首次(来自接口,无 selected)默认勾选全部可上架;之后保留用户的勾选。
    const selected = s.selected === undefined ? canPublish : canPublish && s.selected
    return { ...s, canPublish, selected, transient: isTransient(s), last_error: friendlyText(s.last_error) }
  })
  const publishable = list.filter((s) => s.canPublish)
  return {
    shops: list,
    publishableCount: publishable.length,
    selectedCount: publishable.filter((s) => s.selected).length,
    checks: {
      all: checkState(list, 'all'),
      android: checkState(list, 'android'),
      browser: checkState(list, 'browser'),
    },
    hasTransient: list.some((s) => s.transient),
  }
}

// 上排 tab 只管列表里看哪些,不动勾选——切到「手机」时,已勾的浏览器店铺照样算在已选里
function viewOf(list, tab) {
  return {
    visibleShops: list.filter((s) => inKind(s, tab)),
    tabCounts: {
      all: list.length,
      android: list.filter((s) => inKind(s, 'android')).length,
      browser: list.filter((s) => inKind(s, 'browser')).length,
    },
  }
}

// 上架信息里的主图是 AI 按型号生成、待人确认的 → 页面顶上给人看一眼
function aiConfirmOf(info) {
  const image = (info && info.ai_image_unconfirmed && (info.images || [])[0]) || ''
  return { aiConfirm: Boolean(image), aiImage: image }
}

// 轮询刷新时用接口最新状态,但保留用户当前勾选(按 shop_id 对齐)。
function mergeSelection(fresh, current) {
  const sel = {}
  ;(current || []).forEach((s) => {
    sel[s.shop_id] = s.selected
  })
  return (fresh || []).map((s) => (sel[s.shop_id] === undefined ? s : { ...s, selected: sel[s.shop_id] }))
}

// 上架前按店铺选图(11-05):候选 = 这件货自己的图 + 图片爬虫搜到的同款图;每个店至少 1 张,店铺之间不能重复
const MAX_PER_SHOP = 9

function imageOptionsOf(opts) {
  // 淘汰的图服务端已经不给了；待复核的（爬虫评成水印、海报字、拼图、人像）角标写出毛病，自动分配不用
  const photos = ((opts && opts.photos) || []).map((o) => ({
    ...o,
    kind: material.badgeOf(o, o.kind || '实拍'),
  }))
  const crawled = ((opts && opts.crawled) || []).map((o) => ({
    ...o,
    kind: material.badgeOf(o, o.kind || '同款'),
  }))
  return {
    imgOptions: photos.concat(crawled),
    imgPhotoCount: photos.length,
    imgCrawledCount: crawled.length,
    imgCrawledUsableCount: crawled.filter((o) => o.status !== 'review').length,
    crawlStatus: (opts && opts.crawl_status) || '',
    crawlProgress: (opts && opts.crawl_progress) || null,
    crawlError: (opts && opts.crawl_error) || '',
    archiveCount: (opts && opts.archive_count) || 0,
    crawlerEnabled: !opts || opts.crawler_enabled !== false,
    spuMatch: (opts && opts.spu_match) || null,
    imgHeld: (opts && opts.held) || {},
    imgRejectReasons: (opts && opts.reject_reasons) || [],
  }
}

// 只留还勾着的店铺的选择:取消勾选的店铺,它占的图放回去给别的店铺用
function pruneShopImages(shopImages, shops) {
  const keep = {}
  shops.filter((s) => s.canPublish && s.selected).forEach((s) => {
    if (shopImages[s.shop_id] && shopImages[s.shop_id].length) keep[s.shop_id] = shopImages[s.shop_id]
  })
  return keep
}

function imageView(data) {
  const selected = data.shops.filter((s) => s.canPublish && s.selected)
  const shopImages = pruneShopImages(data.shopImages || {}, data.shops)
  const metaOf = {}
  data.imgOptions.forEach((o) => { metaOf[o.url] = o })
  const owner = {}
  selected.forEach((s) => {
    ;(shopImages[s.shop_id] || []).forEach((u) => { owner[u] = s })
  })
  const pickRows = selected.map((s) => {
    const mine = shopImages[s.shop_id] || []
    const open = data.pickShopId === s.shop_id
    return {
      shop_id: s.shop_id,
      label: s.shop_label,
      count: mine.length,
      open,
      thumbs: mine.map((u) => metaOf[u]).filter(Boolean).map((o) => ({
        url: o.url, thumb: o.thumb, preview: o.preview,
      })),
      grid: open
        ? data.imgOptions.map((o) => {
          const idx = mine.indexOf(o.url)
          const held = data.imgHeld[o.url] && data.imgHeld[o.url] !== s.shop_label ? data.imgHeld[o.url] : ''
          const other = owner[o.url] && owner[o.url].shop_id !== s.shop_id ? owner[o.url].shop_label : held
          return {
            url: o.url, thumb: o.thumb, preview: o.preview, kind: o.kind,
            review: o.status === 'review', order: idx + 1, takenBy: other,
          }
        })
        : [],
    }
  })
  return {
    shopImages,
    pickRows,
    imgNotEnough: data.imgOptions.length > 0 && data.imgOptions.length < selected.length,
    imgAllPicked: selected.length > 0 && selected.every((s) => (shopImages[s.shop_id] || []).length),
  }
}

Page({
  data: {
    skuCode: '',
    listingInfo: null,
    shops: [],
    // 两排各管一件事:kindTab 是上排 tab(看哪些),checks 是下排勾选框(选哪些)
    kindTab: 'all',
    visibleShops: [],
    tabCounts: { all: 0, android: 0, browser: 0 },
    checks: {},
    publishableCount: 0,
    selectedCount: 0,
    loading: true,
    submitting: false,
    hasTransient: false,
    pollExhausted: false,
    // AI 按型号生成的主图待确认(没有同款实拍图可参考,可能猜错品类)
    aiConfirm: false,
    aiImage: '',
    aiHint: '',
    aiBusy: false,
    // 选图(第二步):step = shops 选店铺 / images 给每个店铺选图
    step: 'shops',
    imgOptions: [],
    imgHeld: {},
    imgPhotoCount: 0,
    imgCrawledCount: 0,
    imgCrawledUsableCount: 0,
    crawlStatus: '',
    crawlProgress: null,
    crawlError: '',
    archiveCount: 0,
    crawlerEnabled: true,
    spuMatch: null,
    imgNewCount: 0,
    shopImages: {},
    pickShopId: '',
    pickRows: [],
    imgNotEnough: false,
    imgAllPicked: false,
  },

  onLoad(options) {
    this._alive = true
    this.setData({ skuCode: options.code || '' })
    this.refresh()
  },

  onUnload() {
    this._alive = false
    this.stopPolling()
    this.stopImagePolling()
  },

  onHide() {
    this.stopPolling()
    this.stopImagePolling()
  },

  onShow() {
    // 从别处返回:若仍有处理中的店铺,恢复轮询；同款图还在爬也恢复。
    if (this._alive && this.data.hasTransient) this.startPolling()
    if (this._alive && this.data.crawlStatus === '爬取中') this.startImagePolling()
  },

  // 无忧卖(账号×商品覆盖):写 SkuShopListing.worry_free_sell,发布时按账号扇出。
  toggleWorryFree(e) {
    const shopId = e.currentTarget.dataset.id
    const value = e.detail.value
    const apply = (v) =>
      this.setData({ shops: this.data.shops.map((s) => (s.shop_id === shopId ? { ...s, worry_free_sell: v } : s)) })
    apply(value)
    api.setShopWorryFree(this.data.skuCode, shopId, value).catch((err) => {
      apply(!value) // 失败回滚
      wx.showToast({ title: err.detail || '设置失败', icon: 'none' })
    })
  },

  refresh() {
    if (!this.data.skuCode) {
      this.setData({ loading: false })
      return Promise.resolve()
    }
    this.setData({ loading: true })
    return Promise.all([
      api.getListing(this.data.skuCode).catch(() => null),
      api.listingShops(this.data.skuCode).catch(() => []),
      api.listingImageOptions(this.data.skuCode).catch(() => null),
    ])
      .then(([listingInfo, shops, imgOpts]) => {
        if (!this._alive) return
        this._setShops(shops, { listingInfo, loading: false, ...aiConfirmOf(listingInfo), ...imageOptionsOf(imgOpts) })
        this.startPolling()
        this.startImagePolling()
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
        this._setShops(mergeSelection(shops, this.data.shops))
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

  // 同款图爬取中:只刷新图片候选,不动店铺勾选和已选图;状态变了或到顶自动停
  startImagePolling() {
    if (!this._alive || this._imgTimer || this.data.crawlStatus !== '爬取中') return
    this._imgTries = 0
    this._scheduleImagePoll()
  },

  stopImagePolling() {
    if (this._imgTimer) {
      clearTimeout(this._imgTimer)
      this._imgTimer = null
    }
  },

  _scheduleImagePoll() {
    this._imgTimer = setTimeout(() => {
      this._imgTimer = null
      this._pollImagesOnce()
    }, IMG_POLL_MS)
  },

  _pollImagesOnce() {
    if (!this._alive || this.data.crawlStatus !== '爬取中') return
    this._imgTries = (this._imgTries || 0) + 1
    api.listingImageOptions(this.data.skuCode)
      .then((opts) => {
        if (!this._alive) return
        const patch = imageOptionsOf(opts)
        const before = this.data.imgOptions.length
        const added = Math.max(0, patch.imgOptions.length - before)
        this._setImages({ ...patch, imgNewCount: added || this.data.imgNewCount })
        if (patch.crawlStatus !== '爬取中' || this._imgTries >= IMG_POLL_MAX) {
          this.stopImagePolling()
          return
        }
        this._scheduleImagePoll()
      })
      .catch(() => {
        if (this._alive && this.data.crawlStatus === '爬取中' && this._imgTries < IMG_POLL_MAX) {
          this._scheduleImagePoll()
        }
      })
  },

  _pollOnce() {
    if (!this._alive) return
    this._pollTries += 1
    api
      .listingShops(this.data.skuCode)
      .then((shops) => {
        if (!this._alive) return
        this._setShops(mergeSelection(shops, this.data.shops))
        if (this.data.hasTransient && this._pollTries < POLL_MAX) {
          this._scheduleNext()
        } else if (this.data.hasTransient) {
          this.setData({ pollExhausted: true }) // 到顶仍未收敛,提示手动刷新
        }
      })
      .catch(() => {
        if (this._alive && this.data.hasTransient && this._pollTries < POLL_MAX) this._scheduleNext()
      })
  },

  manualRefresh() {
    this.stopPolling()
    this.setData({ pollExhausted: false })
    this.refresh()
  },

  // 店铺列表一变,勾选状态和当前 tab 下看到的那部分一起重算
  _setShops(shops, extra = {}) {
    const next = enrichShops(shops)
    const merged = { ...this.data, ...extra, ...next }
    this.setData({ ...extra, ...next, ...viewOf(next.shops, this.data.kindTab), ...imageView(merged) })
    // 推送/轮询只带店铺行;主图刚生成好、等确认时,补拉一次上架信息拿到那张图
    const awaiting = next.shops.some((s) => s.ai_image_awaiting_confirm)
    if (awaiting && !this.data.aiConfirm && !this._loadingAi) {
      this._loadingAi = true
      api.getListing(this.data.skuCode)
        .then((info) => this._alive && this.setData({ listingInfo: info, ...aiConfirmOf(info) }))
        .catch(() => {})
        .then(() => { this._loadingAi = false })
    }
  },

  onAiHintInput(e) {
    this.setData({ aiHint: e.detail.value })
  },

  previewAiImage() {
    if (this.data.aiImage) wx.previewImage({ urls: [this.data.aiImage] })
  },

  confirmAiImage() {
    if (this.data.aiBusy) return
    this.setData({ aiBusy: true })
    api.confirmAiImage(this.data.skuCode)
      .then((r) => {
        wx.showToast({ title: '已确认，马上上架', icon: 'none' })
        this.setData({ aiConfirm: false, aiImage: '' })
        return this.refresh()
      })
      .catch((err) => wx.showModal({ title: '没有确认成功', content: err.detail || '请稍后再试', showCancel: false }))
      .finally(() => this.setData({ aiBusy: false }))
  },

  regenerateAiImage() {
    if (this.data.aiBusy) return
    this.setData({ aiBusy: true })
    api.regenerateAiImage(this.data.skuCode, (this.data.aiHint || '').trim())
      .then((r) => {
        wx.showToast({ title: '正在重新生成', icon: 'none' })
        this.setData({ aiConfirm: false, aiImage: '' })
        return this.refresh()
      })
      .catch((err) => wx.showModal({ title: '没能重新生成', content: err.detail || '请稍后再试', showCancel: false }))
      .finally(() => this.setData({ aiBusy: false }))
  },

  setKindTab(e) {
    const kindTab = e.currentTarget.dataset.kind || 'all'
    this.setData({ kindTab, ...viewOf(this.data.shops, kindTab) })
  },

  toggleShop(e) {
    const id = e.currentTarget.dataset.id
    const shops = this.data.shops.map((s) => {
      if (s.shop_id !== id || !s.canPublish) return s
      return { ...s, selected: !s.selected }
    })
    this._setShops(shops)
  },

  // 下排勾选框:all=全部可上架;android=手机(含未绑设备);browser=AdsPower 浏览器环境。
  // 组内已全选时再点 = 取消该组,否则全选该组;不管上排 tab 停在哪。
  selectGroup(e) {
    const kind = e.currentTarget.dataset.kind || 'all'
    const targets = this.data.shops.filter((s) => s.canPublish && inKind(s, kind))
    if (!targets.length) return
    const allOn = targets.every((s) => s.selected)
    const shops = this.data.shops.map((s) => {
      if (!s.canPublish || !inKind(s, kind)) return s
      return { ...s, selected: !allOn }
    })
    this._setShops(shops)
  },

  _setImages(patch) {
    this.setData({ ...patch, ...imageView({ ...this.data, ...patch }) })
  },

  // 第一步「下一步」:有图可挑就去给每个店铺选图;一张候选都没有走老路(AI 生成主图)
  nextStep() {
    if (!this.data.selectedCount) return
    if (!this.data.imgOptions.length) {
      // 只有「爬取中」会自动刷新；「待审核」不会自动轮询，放行 AI 生图兜底，避免没实拍的货卡死。
      if (this.data.crawlStatus === '爬取中') {
        wx.showToast({ title: '同款图还在补充，页面会自动刷新', icon: 'none' })
        this.startImagePolling()
        return
      }
      this.submitPublish()
      return
    }
    const first = this.data.shops.find((s) => s.canPublish && s.selected)
    this._setImages({ step: 'images', pickShopId: first ? first.shop_id : '' })
  },

  backToShops() {
    this.setData({ step: 'shops' })
  },

  togglePickShop(e) {
    const id = e.currentTarget.dataset.id
    this._setImages({ pickShopId: this.data.pickShopId === id ? '' : id })
  },

  togglePickImage(e) {
    const { shop, url, taken } = e.currentTarget.dataset
    if (taken) {
      wx.showToast({ title: `这张已给「${taken}」用了`, icon: 'none' })
      return
    }
    const mine = (this.data.shopImages[shop] || []).slice()
    const idx = mine.indexOf(url)
    if (idx >= 0) mine.splice(idx, 1)
    else if (mine.length >= MAX_PER_SHOP) {
      wx.showToast({ title: `每个店铺最多 ${MAX_PER_SHOP} 张`, icon: 'none' })
      return
    } else mine.push(url)
    this._setImages({ shopImages: { ...this.data.shopImages, [shop]: mine } })
  },

  // 点图放大:用原图 preview，不是 120x120 缩略图；所有候选一起传，可左右滑
  previewImageOnly(e) {
    const ds = e.currentTarget.dataset || {}
    const current = ds.preview || ds.url
    if (!current) return
    const urls = this.data.imgOptions.map((o) => o.preview || o.url).filter(Boolean)
    wx.previewImage({ urls: urls.length ? urls : [current], current })
  },

  // 长按：看大图，或把不能用的淘汰掉（以后挑图都不出现）
  previewPickImage(e) {
    const { preview, url } = e.currentTarget.dataset
    wx.showActionSheet({
      itemList: ['看大图', '淘汰这张'],
      success: (r) => {
        if (r.tapIndex === 0) {
          const urls = this.data.imgOptions.map((o) => o.preview || o.url).filter(Boolean)
          wx.previewImage({ urls: urls.length ? urls : [preview || url], current: preview || url })
          return
        }
        material.reject(this.data.skuCode, url, this.data.imgRejectReasons).then((res) => {
          if (!res) return
          const shopImages = {}
          Object.keys(this.data.shopImages || {}).forEach((id) => {
            shopImages[id] = this.data.shopImages[id].filter((u) => u !== url)
          })
          return api.listingImageOptions(this.data.skuCode).then((opts) => {
            this._setImages({ ...imageOptionsOf(opts), shopImages })
          })
        })
      },
    })
  },

  // 自动分配:候选图按顺序轮流发给各店铺(实拍在前),每张只给一个店铺;人再看一眼改
  autoAssign() {
    const shops = this.data.shops.filter((s) => s.canPublish && s.selected)
    if (!shops.length) return
    const shopImages = {}
    shops.forEach((s) => { shopImages[s.shop_id] = [] })
    // 已经挂在别的号上的图不分出去,不然提交时会被打回
    const held = this.data.imgHeld || {}
    let i = 0
    // 待复核的（水印、海报字……）不自动分，要用自己点
    this.data.imgOptions.filter((o) => o.status !== 'review').forEach((o) => {
      const shop = shops[i % shops.length]
      if (held[o.url] && held[o.url] !== shop.shop_label) return
      const list = shopImages[shop.shop_id]
      if (list.length < MAX_PER_SHOP) list.push(o.url)
      i += 1
    })
    this._setImages({ shopImages })
  },

  submitPublish() {
    if (this.data.submitting || !this.data.selectedCount) return
    const ids = this.data.shops.filter((s) => s.canPublish && s.selected).map((s) => s.shop_id)
    const all = ids.length === this.data.publishableCount
    const picking = this.data.step === 'images'
    if (picking && !this.data.imgAllPicked) {
      const missing = this.data.pickRows.find((r) => !r.count)
      wx.showToast({ title: missing ? `「${missing.label}」还没选图` : '每个店铺都要选图', icon: 'none' })
      return
    }
    wx.showModal({
      title: '确认上架',
      content: all
        ? `将向全部 ${ids.length} 个所选店铺上架 ${this.data.skuCode}，是否继续？`
        : `将向 ${ids.length} 个所选店铺上架 ${this.data.skuCode}，是否继续？`,
      success: (res) => {
        if (!res.confirm) return
        this.setData({ submitting: true })
        const payload = all ? {} : { sale_shop_ids: ids }
        if (picking) payload.shop_images = this.data.shopImages
        api
          .publishShops(this.data.skuCode, payload)
          .then((r) => {
            if (r && r.ai_image) {
              // 没商品图:服务端先 AI 生成主图,出图后自动上架——说清楚,别让人以为没反应又去点
              wx.showModal({ title: '先生成主图', content: r.message || '正在用 AI 生成主图，生成好后自动上架', showCancel: false })
            } else {
              wx.showToast({ title: r && r.async ? '已提交，真机处理中' : '已提交上架' })
            }
            this.setData({ step: 'shops', shopImages: {}, pickShopId: '' })
            return this.refresh()
          })
          .catch((err) => {
            // 弹窗不用 toast:toast 一闪就没,原因(缺图、售价不对…)看不到,只会以为没反应
            wx.showModal({ title: '没有上架', content: err.detail || '上架失败', showCancel: false })
          })
          .finally(() => {
            this.setData({ submitting: false })
          })
      },
    })
  },
})

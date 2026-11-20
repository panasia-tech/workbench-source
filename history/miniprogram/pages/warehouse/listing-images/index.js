const api = require('@services/api')
const material = require('@utils/image-material')

// 上架图片管理（禅道 #102）：按账号看每个号挂到闲鱼上的图，改的是这个号自己那组。
// 各号的图一张都不能重复（11-05 口径，11-10 重申），所以没有「复制 / 同步到其他账号」。
const STATUS_LABEL = {
  LISTED: '在架',
  LISTING: '上架中',
  DELISTED: '已下架',
  FAILED: '上架失败',
  SOLD: '已售出',
  PENDING: '没上过',
}

function accountView(a) {
  return {
    ...a,
    statusLabel: a.gc_pending && a.publish_status === 'LISTED' ? '处理中' : (STATUS_LABEL[a.publish_status] || a.publish_status),
    live: a.publish_status === 'LISTED' || a.publish_status === 'LISTING',
    sharesText: (a.shares_with || []).join('、'),
  }
}

// 角标：待复核的写出毛病（同款·水印），淘汰的写原因
function usedView(list) {
  return (list || []).map((x) => ({
    ...x,
    usedText: (x.used_by || []).join('、'),
    kindText: x.status === 'rejected' ? x.reason : material.badgeOf(x, x.kind),
  }))
}

Page({
  data: {
    loading: true,
    res: null,
    tab: 'account',
    accounts: [],
    shopId: '', // '' = 全部账号
    current: null,
    grid: [],
    selected: {},
    selectedCount: 0,
    sorting: false,
    sortOrder: [],
    editable: false,
    saving: false,
    sheet: false,
    sheetItems: [],
    sheetPicked: {},
    sheetCount: 0,
  },

  onLoad(options) {
    this.code = decodeURIComponent(options.code || '')
    this.load()
  },

  load() {
    return api.listingImages(this.code).then((res) => {
      const accounts = (res.accounts || []).map(accountView)
      res.library = usedView(res.library)
      res.crawled = usedView(res.crawled)
      res.rejected = usedView(res.rejected)
      const tab = this.data.tab === 'rejected' && !res.rejected.length ? 'library' : this.data.tab
      const keep = accounts.some((a) => a.shop_id === this.data.shopId) ? this.data.shopId : ''
      this.setData({
        loading: false,
        res,
        tab,
        accounts,
        editable: !!res.can_edit && !res.readonly_reason,
      })
      this._pick(keep)
    }).catch((err) => {
      this.setData({ loading: false })
      wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
    })
  },

  _pick(shopId) {
    const current = this.data.accounts.find((a) => a.shop_id === shopId) || null
    this.setData({
      shopId: current ? shopId : '',
      current,
      grid: current ? current.images.map((img, i) => ({ ...img, order: i + 1 })) : [],
      selected: {},
      selectedCount: 0,
      sorting: false,
      sortOrder: [],
    })
  },

  switchTab(e) {
    this.setData({ tab: e.currentTarget.dataset.tab })
  },

  pickAccount(e) {
    this._pick(e.currentTarget.dataset.id || '')
  },

  goBack() {
    wx.navigateBack()
  },

  preview(e) {
    const { list, index } = e.currentTarget.dataset
    const src = list === 'grid' ? this.data.grid : (this.data.res[list] || [])
    const urls = src.map((x) => x.preview || x.thumb)
    wx.previewImage({ urls, current: urls[Number(index)] })
  },

  // ------------------------------------------------------------ 素材：淘汰 / 放回
  // 全部图片、同款图、淘汰三页点图：能改的人多一个「淘汰」或「放回」
  tapMaterial(e) {
    const { list, index } = e.currentTarget.dataset
    const item = (this.data.res[list] || [])[Number(index)]
    if (!item || !this.data.res.can_edit) {
      this.preview(e)
      return
    }
    const gone = list === 'rejected'
    wx.showActionSheet({
      itemList: ['看大图', gone ? '放回候选' : '淘汰这张'],
      success: (r) => {
        if (r.tapIndex === 0) {
          this.preview(e)
          return
        }
        const done = gone
          ? material.restore(this.code, item.url)
          : material.reject(this.code, item.url, this.data.res.reject_reasons)
        done.then((res) => { if (res) this.load() })
      },
    })
  },

  // ------------------------------------------------------------ 选图 / 排序
  tapImage(e) {
    const index = Number(e.currentTarget.dataset.index)
    const img = this.data.grid[index]
    if (!img) return
    if (this.data.sorting) {
      const order = this.data.sortOrder.slice()
      const at = order.indexOf(img.url)
      if (at >= 0) order.splice(at, 1)
      else order.push(img.url)
      this.setData({ sortOrder: order, grid: this.data.grid.map((g) => ({ ...g, sortNo: order.indexOf(g.url) + 1 })) })
      return
    }
    if (!this.data.editable) {
      this.preview({ currentTarget: { dataset: { list: 'grid', index } } })
      return
    }
    const selected = { ...this.data.selected }
    if (selected[img.url]) delete selected[img.url]
    else selected[img.url] = true
    this.setData({ selected, selectedCount: Object.keys(selected).length })
  },

  toggleAll() {
    const all = this.data.selectedCount < this.data.grid.length
    const selected = {}
    if (all) this.data.grid.forEach((g) => { selected[g.url] = true })
    this.setData({ selected, selectedCount: all ? this.data.grid.length : 0 })
  },

  startSort() {
    if (this.data.grid.length < 2) {
      wx.showToast({ title: '只有一张，不用排', icon: 'none' })
      return
    }
    this.setData({ sorting: true, sortOrder: [], selected: {}, selectedCount: 0, grid: this.data.grid.map((g) => ({ ...g, sortNo: 0 })) })
  },

  cancelSort() {
    this._pick(this.data.shopId)
  },

  finishSort() {
    const order = this.data.sortOrder
    if (!order.length) {
      this.cancelSort()
      return
    }
    // 没点到的按原来的顺序排在后面
    const rest = this.data.grid.map((g) => g.url).filter((u) => order.indexOf(u) < 0)
    this._save(order.concat(rest), '顺序已保存')
  },

  setMain() {
    const urls = Object.keys(this.data.selected)
    if (urls.length !== 1) {
      wx.showToast({ title: '只勾一张，再设为主图', icon: 'none' })
      return
    }
    const list = this.data.grid.map((g) => g.url).filter((u) => u !== urls[0])
    this._save([urls[0]].concat(list), '已设为主图')
  },

  removeSelected() {
    const picked = this.data.selected
    const left = this.data.grid.map((g) => g.url).filter((u) => !picked[u])
    if (!this.data.selectedCount) {
      wx.showToast({ title: '先勾要拿掉的图', icon: 'none' })
      return
    }
    wx.showModal({
      title: `从「${this.data.current.shop_label}」拿掉 ${this.data.selectedCount} 张？`,
      content: left.length ? '图本身不删，还在「全部图片」里，别的号可以用。' : '全拿掉后这个号改回用公用那组图。',
      confirmText: '拿掉',
      success: (r) => { if (r.confirm) this._save(left, left.length ? '已拿掉' : '已改回公用图') },
    })
  },

  backToShared() {
    wx.showModal({
      title: '改回公用图？',
      content: '这个号以后用公用那组图，单独选的这组作废。',
      success: (r) => { if (r.confirm) this._save([], '已改回公用图') },
    })
  },

  // ------------------------------------------------------------ 加图：上传 / 从这件货的图里挑
  upload() {
    const room = this.data.res.max_per_shop - this.data.grid.length
    if (room <= 0) {
      wx.showToast({ title: `一个号最多 ${this.data.res.max_per_shop} 张`, icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: room,
      mediaType: ['image'],
      success: (res) => {
        wx.showLoading({ title: '上传中' })
        const tasks = res.tempFiles.map((f, i) => api.uploadMedia(this.data.res.upload_dir, `${Date.now()}_${i}.jpg`, f.tempFilePath))
        Promise.all(tasks).then((out) => {
          wx.hideLoading()
          const urls = this.data.grid.map((g) => g.url).concat(out.map((r) => r.public_url))
          this._save(urls, `已加 ${out.length} 张`)
        }).catch(() => {
          wx.hideLoading()
          wx.showToast({ title: '上传失败', icon: 'none' })
        })
      },
    })
  },

  openSheet() {
    const mine = {}
    this.data.grid.forEach((g) => { mine[g.url] = true })
    const label = this.data.current.shop_label
    // 淘汰的不在这两个列表里，加图时看不到
    const items = (this.data.res.library || []).concat(this.data.res.crawled || []).map((c) => ({ ...c, kind: c.kindText }))
      .filter((x) => !mine[x.url])
      .map((x) => {
        const others = (x.used_by || []).filter((n) => n !== label)
        return { ...x, takenBy: others.join('、') }
      })
    if (!items.length) {
      wx.showToast({ title: '没有别的图了，可以上传', icon: 'none' })
      return
    }
    this.setData({ sheet: true, sheetItems: items, sheetPicked: {}, sheetCount: 0 })
  },

  closeSheet() {
    this.setData({ sheet: false })
  },

  noop() {},

  tapSheetItem(e) {
    const item = this.data.sheetItems[Number(e.currentTarget.dataset.index)]
    if (!item) return
    if (item.takenBy) {
      wx.showToast({ title: `这张已给「${item.takenBy}」用了`, icon: 'none' })
      return
    }
    const picked = { ...this.data.sheetPicked }
    if (picked[item.url]) delete picked[item.url]
    else if (this.data.grid.length + this.data.sheetCount >= this.data.res.max_per_shop) {
      wx.showToast({ title: `一个号最多 ${this.data.res.max_per_shop} 张`, icon: 'none' })
      return
    } else picked[item.url] = true
    this.setData({ sheetPicked: picked, sheetCount: Object.keys(picked).length })
  },

  confirmSheet() {
    const add = this.data.sheetItems.filter((x) => this.data.sheetPicked[x.url]).map((x) => x.url)
    if (!add.length) {
      this.closeSheet()
      return
    }
    this.setData({ sheet: false })
    this._save(this.data.grid.map((g) => g.url).concat(add), `已加 ${add.length} 张`)
  },

  // ------------------------------------------------------------ 保存
  _save(urls, okText) {
    if (this.data.saving || !this.data.current) return
    const shop = this.data.current
    this.setData({ saving: true })
    api.setShopImages(this.code, shop.shop_id, urls).then((r) => {
      this.setData({ saving: false })
      return this.load().then(() => {
        if (!r.live) {
          wx.showToast({ title: okText, icon: 'none' })
          return
        }
        // 只存进 ERP，闲鱼上那条链接还是旧图
        wx.showModal({
          title: okText,
          content: `闲鱼上「${shop.shop_label}」那条还是旧图，下次链接焕新时换上。要现在按新图重新上架吗？会删掉旧链接重发，中间几分钟不在架。`,
          confirmText: '现在重发',
          cancelText: '等焕新',
          success: (m) => { if (m.confirm) this._refresh(shop) },
        })
      })
    }).catch((err) => {
      this.setData({ saving: false })
      wx.showModal({ title: '没保存', content: (err && err.detail) || '保存失败', showCancel: false })
    })
  },

  _refresh(shop) {
    api.refreshSkuNow(this.code, [shop.shop_id]).then((r) => {
      const skipped = (r.skipped || []).map((s) => `${s.shop}：${s.why}`)
      wx.showModal({
        title: r.created ? '已提交重新上架' : '这次没有提交',
        content: skipped.join('\n') || '进度在商品详情的「各店铺状态」里看。',
        showCancel: false,
      })
      this.load()
    }).catch((err) => {
      wx.showToast({ title: (err && err.detail) || '提交失败', icon: 'none' })
    })
  },
})

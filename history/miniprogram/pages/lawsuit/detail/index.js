const api = require('@services/api')

const STATUS_META = {
  DRAFT: { text: '待提交证据', cls: 'tag-muted' },
  EVIDENCE_SUBMITTED: { text: '已提交证据', cls: 'tag-warning' },
  SUBMITTED_LAWYER: { text: '已提交律师回复', cls: 'tag-info' },
  PENDING_HEARING: { text: '待开庭', cls: 'tag-warning' },
  JUDGED: { text: '已判决', cls: 'tag-success' },
}

Page({
  data: {
    id: '',
    isEdit: false,
    loading: false,
    submitting: false,

    // 采购单搜索 / 绑定
    q: '',
    searching: false,
    searched: false,
    isSearchResult: false,
    poList: [],
    boundOrder: null,

    // 已有起诉单信息
    lawsuitNo: '',
    statusText: '',
    statusCls: '',

    // 四类材料（public_url 提交 / display 展示）
    evidenceMedia: [],
    evidenceDisplay: [],
    lawyerMedia: [],
    lawyerDisplay: [],
    courtMedia: [],
    courtDisplay: [],
    judgmentMedia: [],
    judgmentDisplay: [],
  },

  onLoad(options) {
    const id = options.id || ''
    this.setData({ id, isEdit: !!id })
    wx.setNavigationBarTitle({ title: id ? '起诉单详情' : '新建起诉单' })
    if (id) this.loadDetail(id)
    else this.loadRecentPO()
  },

  // 新建时默认展示最近 10 条采购单，可直接选
  loadRecentPO() {
    this.setData({ searching: true })
    api.listPurchase({ page: 1, size: 10 })
      .then((res) => {
        this.setData({ poList: res.items || [], searched: true, isSearchResult: false, searching: false })
      })
      .catch(() => this.setData({ searching: false }))
  },

  loadDetail(id) {
    this.setData({ loading: true })
    api.getLawsuit(id)
      .then((d) => {
        const meta = STATUS_META[d.status] || STATUS_META.DRAFT
        this.setData({
          loading: false,
          lawsuitNo: d.lawsuit_no,
          statusText: meta.text,
          statusCls: meta.cls,
          boundOrder: {
            id: d.purchase_order_id,
            order_no: d.order_no,
            product_name: d.product_name,
            brand: d.brand,
            model: d.model,
            spec: d.spec,
            unit_price: d.unit_price,
            product_image: d.product_image,
            product_image_thumb: d.product_image_thumb,
          },
          evidenceMedia: d.evidence_media || [],
          evidenceDisplay: d.evidence_media || [],
          lawyerMedia: d.lawyer_media || [],
          lawyerDisplay: d.lawyer_media || [],
          courtMedia: d.court_media || [],
          courtDisplay: d.court_media || [],
          judgmentMedia: d.judgment_media || [],
          judgmentDisplay: d.judgment_media || [],
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
      })
  },

  // ===== 采购单搜索 / 绑定 =====
  onQInput(e) {
    this.setData({ q: e.detail.value })
  },

  onSearchPO() {
    const q = (this.data.q || '').trim()
    if (!q) {
      // 关键词为空时回到默认的最近采购单
      this.loadRecentPO()
      return
    }
    this.setData({ searching: true, searched: true, isSearchResult: true })
    api.listPurchase({ q, page: 1, size: 30 })
      .then((res) => {
        this.setData({ poList: res.items || [], searching: false })
      })
      .catch((err) => {
        this.setData({ searching: false })
        wx.showToast({ title: (err && err.detail) || '搜索失败', icon: 'none' })
      })
  },

  bindPO(e) {
    const id = e.currentTarget.dataset.id
    const order = this.data.poList.find((o) => o.id === id)
    if (!order) return
    this.setData({ boundOrder: order, poList: [], searched: false, q: '' })
  },

  unbindPO() {
    this.setData({ boundOrder: null, q: '' }, () => this.loadRecentPO())
  },

  // 点击已绑定的采购单 → 跳转采购单详情
  openBoundPO() {
    const o = this.data.boundOrder
    if (!o || !o.id) return
    wx.navigateTo({ url: `/pages/purchase/detail/index?id=${o.id}` })
  },

  onDelete() {
    wx.showModal({
      title: '删除起诉单',
      content: `确认删除起诉单 ${this.data.lawsuitNo}？此操作不可恢复。`,
      confirmColor: '#DC2626',
      success: (res) => {
        if (!res.confirm) return
        api.deleteLawsuit(this.data.id)
          .then(() => {
            wx.showToast({ title: '已删除', icon: 'success' })
            setTimeout(() => wx.navigateBack(), 500)
          })
          .catch((err) => wx.showToast({ title: (err && err.detail) || '删除失败', icon: 'none' }))
      },
    })
  },

  // ===== 材料上传 / 删除 =====
  addMedia(e) {
    const { field, display, dir } = e.currentTarget.dataset
    wx.chooseMedia({
      count: 9,
      mediaType: ['image', 'video'],
      success: (res) => {
        wx.showLoading({ title: '上传中…', mask: true })
        const uploads = res.tempFiles.map((f) => {
          const ext = f.fileType === 'video' ? '.mp4' : '.jpg'
          return api.uploadMedia(dir, `${Date.now()}${ext}`, f.tempFilePath)
        })
        Promise.all(uploads)
          .then((results) => {
            const urls = results.map((r) => r.public_url)
            const disp = results.map((r) => r.access_url || r.public_url)
            this.setData({
              [field]: this.data[field].concat(urls),
              [display]: this.data[display].concat(disp),
            })
          })
          .catch(() => wx.showToast({ title: '上传失败', icon: 'none' }))
          .finally(() => wx.hideLoading())
      },
    })
  },

  removeMedia(e) {
    const { field, display, index } = e.currentTarget.dataset
    const i = Number(index)
    if (Number.isNaN(i)) return
    const media = this.data[field].slice()
    const disp = this.data[display].slice()
    media.splice(i, 1)
    disp.splice(i, 1)
    this.setData({ [field]: media, [display]: disp })
  },

  // ===== 提交 =====
  onSubmit() {
    if (this.data.submitting) return
    const payload = {
      evidence_media: this.data.evidenceMedia,
      lawyer_media: this.data.lawyerMedia,
      court_media: this.data.courtMedia,
      judgment_media: this.data.judgmentMedia,
    }
    this.setData({ submitting: true })
    if (this.data.isEdit) {
      api.updateLawsuit(this.data.id, payload)
        .then(() => {
          wx.showToast({ title: '已保存', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 500)
        })
        .catch((err) => wx.showToast({ title: (err && err.detail) || '保存失败', icon: 'none' }))
        .finally(() => this.setData({ submitting: false }))
      return
    }
    if (!this.data.boundOrder) {
      this.setData({ submitting: false })
      wx.showToast({ title: '请先绑定采购单', icon: 'none' })
      return
    }
    if (!this.data.evidenceMedia.length) {
      this.setData({ submitting: false })
      wx.showToast({ title: '请先上传证据材料', icon: 'none' })
      return
    }
    api.createLawsuit({ purchase_order_id: this.data.boundOrder.id, ...payload })
      .then(() => {
        wx.showToast({ title: '已创建', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 500)
      })
      .catch((err) => wx.showToast({ title: (err && err.detail) || '创建失败', icon: 'none' }))
      .finally(() => this.setData({ submitting: false }))
  },
})

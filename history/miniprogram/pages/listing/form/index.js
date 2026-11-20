const api = require('@services/api')
const listingFormConfig = require('@services/listing-form-config')
const { sanitizeMoneyField } = require('@utils/money')

Page({
  data: {
    skuCode: '',
    form: {
      title: '',
      desc: '',
      price: '',
      original_price: '',
      express_fee: '',
      images: [],
      stuff_status: null,
    },
    imageDisplayUrls: [],
    stuffOptions: [],
    stuffIndex: 0,
    stuffLabel: '',
    productTypeOptions: [],
    productTypeIndex: -1,
    productTypeLabel: '',
    submittingRedraw: false,
    redrawJobs: [],
    t2iPrompt: '',
  },

  // 种类类型（带 AI 提示词）：只保留有提示词的，按 SKU 的 product_type 默认选中，并带出其提示词。
  syncProductType(defaultName) {
    const opts = (this.data.productTypeOptions || []).filter((t) => (t.prompt || '').trim())
    if (!opts.length) {
      this.setData({ productTypeOptions: opts, productTypeIndex: -1, productTypeLabel: '' })
      return
    }
    let idx = 0
    if (defaultName) {
      const i = opts.findIndex((t) => t.name === defaultName)
      if (i >= 0) idx = i
    }
    this.setData({
      productTypeOptions: opts,
      productTypeIndex: idx,
      productTypeLabel: opts[idx].name,
      t2iPrompt: (opts[idx].prompt || '').trim(),
    })
  },

  onProductTypePick(e) {
    const idx = Number(e.detail.value)
    const t = this.data.productTypeOptions[idx]
    if (!t) return
    this.setData({
      productTypeIndex: idx,
      productTypeLabel: t.name,
      t2iPrompt: (t.prompt || '').trim(),
    })
  },

  submitRedraw(e) {
    const slot = Number(e.currentTarget.dataset.slot)
    const image = this.data.form.images[slot]
    if (!image) {
      wx.showToast({ title: '该位无原图', icon: 'none' })
      return
    }
    const prompt = (this.data.t2iPrompt || '').trim()
    if (!prompt) {
      wx.showToast({ title: '请先选择种类或填写提示词', icon: 'none' })
      return
    }
    this._submitRedraw({ sku_code: this.data.skuCode, image_url: image, prompt })
  },

  onT2iPromptInput(e) {
    this.setData({ t2iPrompt: e.detail.value })
  },

  submitTextToImage() {
    const prompt = (this.data.t2iPrompt || '').trim()
    if (!prompt) {
      wx.showToast({ title: '请填写提示词', icon: 'none' })
      return
    }
    this._submitRedraw({ sku_code: this.data.skuCode, prompt })
  },

  _submitRedraw(payload) {
    if (!this.data.skuCode) return
    this.setData({ submittingRedraw: true })
    api.redrawImage(payload)
      .then(() => {
        wx.showToast({ title: '已提交，结果稍后查看', icon: 'success' })
        return this.refreshRedrawJobs()
      })
      .catch((err) => {
        wx.showToast({ title: (err && err.detail) || '提交失败', icon: 'none' })
      })
      .finally(() => {
        this.setData({ submittingRedraw: false })
        this.ensureRedrawPolling()
      })
  },

  refreshRedrawJobs() {
    if (!this.data.skuCode) return Promise.resolve()
    return api.listRedrawJobs({ sku_code: this.data.skuCode, limit: 20 })
      .then((jobs) => {
        this.setData({ redrawJobs: jobs || [] })
      })
      .catch(() => {})
  },

  ensureRedrawPolling() {
    if (this._redrawTimer) return
    const tick = () => {
      this.refreshRedrawJobs().finally(() => {
        const pending = (this.data.redrawJobs || []).some((j) => j.status === 'PENDING' || j.status === 'RUNNING')
        if (!pending) {
          if (this._redrawTimer) {
            clearTimeout(this._redrawTimer)
            this._redrawTimer = null
          }
          return
        }
        this._redrawTimer = setTimeout(tick, 5000)
      })
    }
    this._redrawTimer = setTimeout(tick, 5000)
  },

  previewRedraw(e) {
    const url = e.currentTarget.dataset.url
    if (!url) return
    const urls = (this.data.redrawJobs || [])
      .filter((j) => j.status === 'SUCCEEDED' && j.result_url)
      .map((j) => j.result_url)
    wx.previewImage({ current: url, urls })
  },

  applyJobToSlot(e) {
    const { id, slot } = e.currentTarget.dataset
    const slotIdx = Number(slot)
    const job = (this.data.redrawJobs || []).find((j) => j.id === id)
    if (!job || job.status !== 'SUCCEEDED' || !job.result_url) {
      wx.showToast({ title: '结果不可用', icon: 'none' })
      return
    }
    const images = this.data.form.images.slice()
    const displayUrls = this.data.imageDisplayUrls.slice()
    while (images.length <= slotIdx) {
      images.push('')
      displayUrls.push('')
    }
    images[slotIdx] = job.result_url
    displayUrls[slotIdx] = job.result_url
    this.setData({ 'form.images': images, imageDisplayUrls: displayUrls })
    wx.showToast({ title: `已应用为主图 ${slotIdx + 1}`, icon: 'success' })
  },

  onUnload() {
    if (this._redrawTimer) {
      clearTimeout(this._redrawTimer)
      this._redrawTimer = null
    }
  },

  onHide() {
    if (this._redrawTimer) {
      clearTimeout(this._redrawTimer)
      this._redrawTimer = null
    }
  },

  onLoad(options) {
    const skuCode = options.code || ''
    this.setData({ skuCode })
    // 种类类型（带提示词）+ SKU 的入库种类：都到位后按种类默认选中并带出提示词
    const loadTypes = api.enabledProductTypes().catch(() => [])
    const loadSku = skuCode ? api.skuDetail(skuCode).catch(() => null) : Promise.resolve(null)
    Promise.all([loadTypes, loadSku]).then(([types, sku]) => {
      this.setData({ productTypeOptions: types || [] })
      this.syncProductType(sku && sku.product_type)
    })
    if (skuCode) {
      this.refreshRedrawJobs().then(() => this.ensureRedrawPolling())
    }
    listingFormConfig.ensureFormConfig().then(() => {
      const stuffOptions = listingFormConfig.getStuffStatusOptions()
      const defaults = listingFormConfig.getDefaults()
      this.setData({ stuffOptions })
      if (skuCode) {
        return api.getListing(skuCode).then((info) => {
          const images = info.images || []
          const stuffVal = info.stuff_status != null
            ? info.stuff_status
            : (defaults.stuff_status != null ? defaults.stuff_status : 95)
          let stuffIndex = 0
          stuffOptions.forEach((s, i) => {
            if (s.value === stuffVal) stuffIndex = i
          })
          const stuff = stuffOptions[stuffIndex]
          this.setData({
            form: {
              title: info.title || info.product_name || '',
              desc: info.desc || '',
              // 建议售价/预填价为 0 时按未填处理,别预填 "0.00"(保存必被后端拒,用户还以为是bug)
              price: Number(info.price) > 0 ? String(info.price) : (Number(info.suggest_price) > 0 ? String(info.suggest_price) : ''),
              original_price: info.original_price ? String(info.original_price) : '',
              // 快递费默认不填:存过 0 也当没填(0 元由执行端按「一口价 0」发,不必回填个 0 让人以为要改)
              express_fee: Number(info.express_fee) > 0 ? String(info.express_fee) : (Number(defaults.express_fee) > 0 ? String(defaults.express_fee) : ''),
              images,
              stuff_status: stuffVal,
            },
            imageDisplayUrls: images,
            stuffIndex,
            stuffLabel: stuff ? stuff.label : '请选择成色',
          })
        })
      } else {
        const stuff = stuffOptions.find((s) => s.value === defaults.stuff_status) || stuffOptions[0]
        this.setData({
          'form.stuff_status': stuff ? stuff.value : 95,
          stuffLabel: stuff ? stuff.label : '',
        })
      }
    })
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ [`form.${key}`]: sanitizeMoneyField(key, e.detail.value) })
  },

  onStuffPick(e) {
    const idx = Number(e.detail.value)
    const opt = this.data.stuffOptions[idx]
    if (!opt) return
    this.setData({
      stuffIndex: idx,
      stuffLabel: opt.label,
      'form.stuff_status': opt.value,
    })
  },

  addImage() {
    wx.chooseMedia({
      count: 9 - this.data.form.images.length,
      mediaType: ['image'],
      success: (res) => {
        const images = [...this.data.form.images]
        const displayUrls = [...this.data.imageDisplayUrls]
        res.tempFiles.forEach((file) => {
          api.uploadMedia('inspection/listing/', `${Date.now()}.jpg`, file.tempFilePath).then((result) => {
            images.push(result.public_url)
            displayUrls.push(result.access_url || result.public_url)
            this.setData({ 'form.images': images, imageDisplayUrls: displayUrls })
          }).catch(() => {
            wx.showToast({ title: '上传失败', icon: 'none' })
          })
        })
      },
    })
  },

  removeImage(e) {
    const idx = e.detail.index
    const images = this.data.form.images.slice()
    const displayUrls = this.data.imageDisplayUrls.slice()
    images.splice(idx, 1)
    displayUrls.splice(idx, 1)
    this.setData({ 'form.images': images, imageDisplayUrls: displayUrls })
  },

  saveOnly() {
    this.save(false)
  },

  submit() {
    this.save(true)
  },

  save(goPublish) {
    const f = this.data.form
    const defaults = listingFormConfig.getDefaults()
    if (!f.title || !f.price) {
      wx.showToast({ title: '标题和售价必填', icon: 'none' })
      return
    }
    api.saveListing(this.data.skuCode, {
      title: f.title,
      desc: f.desc,
      price: Number(f.price),
      original_price: f.original_price ? Number(f.original_price) : null,
      express_fee: f.express_fee ? Number(f.express_fee) : null,
      images: f.images,
      stuff_status: f.stuff_status != null ? f.stuff_status : defaults.stuff_status,
    }).then(() => {
      wx.showToast({ title: '已保存' })
      if (goPublish) {
        wx.navigateTo({ url: `/pages/listing/publish/index?code=${this.data.skuCode}` })
      }
    }).catch((err) => {
      // 弹窗不用 toast:原因(不在库、权限不足…)看不到,只会以为没反应
      wx.showModal({ title: '保存失败', content: (err && err.detail) || '保存失败，请稍后重试', showCancel: false })
    })
  },
})

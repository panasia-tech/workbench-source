const auth = require('@services/auth')
const api = require('@services/api')
const appConfig = require('@services/config')
const { scanBarcode } = require('@services/scan')
const { sanitizeDecimal } = require('@utils/money')

// 与手动入库一致
const GRADES = ['95新', '9新', '85新', '8新']
const MAX_IMAGES = 9
// 已经不能改时告诉人去哪改；其余状态（已售出等）就是不能再改
const LOCKED_TIP = {
  listing: '正在上架，改价格或图片请到群控中心',
  on_sale: '已上架，改价格或图片请到群控中心',
}

function emptyForm() {
  return {
    product_type: '',
    brand: '',
    model: '',
    spec: '',
    serial_number: '',
    condition_grade: '',
    price: '',
    express_fee: '',
    cost_price: '',
    images: [],
    desc: '',
    source_asset_no: '',
    location_code: '',
    remark: '',
  }
}

// 后端金额是 "1299.00" 这样的字符串，回填输入框时去掉多余的 0
function moneyText(v) {
  return v === null || v === undefined || v === '' ? '' : String(Number(v))
}

Page({
  data: {
    code: '', // 有值 = 打开的是已录的那台
    editable: true,
    statusLabel: '',
    lockedTip: '',
    submitting: false,
    grades: GRADES,
    gradeIndex: -1,
    productTypes: [],
    productTypeIndex: -1,
    locations: [],
    locationIndex: -1,
    form: emptyForm(),
    imageDisplay: [],
  },

  onLoad(options) {
    const code = options.code || ''
    this.setData({ code })
    if (code) wx.setNavigationBarTitle({ title: '录入详情' })
    auth.ensureLogin().then(() => {
      this.loadLocations()
      const types = api.enabledProductTypes()
        .then((list) => (list || []).map((t) => t.name))
        .catch(() => [])
      if (!code) {
        types.then((names) => this.setData({ productTypes: names }))
        return
      }
      Promise.all([types, api.getAssetIntake(code)])
        .then(([names, detail]) => this.fill(names, detail))
        .catch((err) => wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' }))
    })
  },

  loadLocations() {
    // 第一项「不填」：选错了库位能改回空（不知道库位就留空，仓管之后补）
    const build = () => [{ code: '', label: '不填' }].concat(appConfig.getLocations().map((loc) => ({
      code: loc.code,
      label: loc.label || (loc.zone ? `${loc.code}（${loc.zone}区）` : loc.code),
    })))
    this.setData({ locations: build() })
    if (!appConfig.getLocations().length) {
      appConfig.refreshConfig().then(() => {
        this.setData({ locations: build() })
        this.syncPickers()
      }).catch(() => {})
    }
  },

  fill(names, d) {
    const images = d.images || []
    this.setData({
      productTypes: names,
      editable: !!d.editable,
      statusLabel: d.status_label || '',
      lockedTip: d.editable ? '' : (LOCKED_TIP[d.status] || '这台已经不能改了'),
      form: {
        product_type: d.product_type || '',
        brand: d.brand || '',
        model: d.model || '',
        spec: d.spec || '',
        serial_number: d.serial_number || '',
        condition_grade: d.condition_grade || '',
        price: moneyText(d.price),
        express_fee: moneyText(d.express_fee),
        cost_price: moneyText(d.cost_price),
        images,
        desc: d.desc || '',
        source_asset_no: d.source_asset_no || '',
        location_code: d.location_code || '',
        remark: d.remark || '',
      },
      // 详情返回的已是签名 URL，可直接预览；保存时后端会还原成不带签名的地址
      imageDisplay: images,
    })
    this.syncPickers()
  },

  syncPickers() {
    const f = this.data.form
    this.setData({
      gradeIndex: GRADES.indexOf(f.condition_grade),
      productTypeIndex: this.data.productTypes.indexOf(f.product_type),
      locationIndex: this.data.locations.findIndex((loc) => loc.code === f.location_code),
    })
  },

  onInput(e) {
    this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail.value })
  },

  onMoneyInput(e) {
    this.setData({ [`form.${e.currentTarget.dataset.field}`]: sanitizeDecimal(e.detail.value) })
  },

  scanSerial() {
    scanBarcode({ scanType: ['barCode', 'qrCode'] })
      .then((text) => this.setData({ 'form.serial_number': text }))
      .catch(() => {})
  },

  scanSourceNo() {
    scanBarcode({ scanType: ['barCode', 'qrCode'] })
      .then((text) => this.setData({ 'form.source_asset_no': text }))
      .catch(() => {})
  },

  pickProductType(e) {
    const idx = Number(e.detail.value)
    this.setData({ productTypeIndex: idx, 'form.product_type': this.data.productTypes[idx] || '' })
  },

  pickGrade(e) {
    const idx = Number(e.detail.value)
    this.setData({ gradeIndex: idx, 'form.condition_grade': GRADES[idx] || '' })
  },

  pickLocation(e) {
    const idx = Number(e.detail.value)
    const loc = this.data.locations[idx]
    this.setData({ locationIndex: idx, 'form.location_code': loc ? loc.code : '' })
  },

  addImage() {
    const left = MAX_IMAGES - this.data.form.images.length
    if (left <= 0) return
    wx.chooseMedia({
      count: left,
      mediaType: ['image'],
      sizeType: ['compressed'],
      success: (res) => {
        wx.showLoading({ title: '上传中…', mask: true })
        // 文件名带序号和随机串：一次多选几张同一毫秒也不会同名互相覆盖
        const stamp = Date.now()
        const uploads = res.tempFiles.map((f, i) => api.uploadMedia(
          'sku/product/',
          `${stamp}-${i}-${Math.random().toString(36).slice(2, 8)}.jpg`,
          f.tempFilePath,
        ))
        Promise.all(uploads).then((results) => {
          wx.hideLoading()
          this.setData({
            'form.images': this.data.form.images.concat(results.map((r) => r.public_url)),
            imageDisplay: this.data.imageDisplay.concat(results.map((r) => r.access_url || r.public_url)),
          })
        }).catch(() => {
          wx.hideLoading()
          wx.showToast({ title: '上传失败', icon: 'none' })
        })
      },
    })
  },

  removeImage(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const images = this.data.form.images.slice()
    const display = this.data.imageDisplay.slice()
    images.splice(idx, 1)
    display.splice(idx, 1)
    this.setData({ 'form.images': images, imageDisplay: display })
  },

  submit() {
    if (this.data.submitting || !this.data.editable) return
    const f = this.data.form
    const t = (v) => (v || '').trim()
    const missing = [
      [t(f.product_type), '请选择商品类型'],
      [t(f.brand) && t(f.model), '请填写品牌和型号'],
      [t(f.serial_number), '请填写序列号'],
      [f.condition_grade, '请选择成色'],
      [Number(f.price) > 0, '请填写售价'],
      [f.images.length, '至少传 1 张商品实拍图'],
    ].find(([ok]) => !ok)
    if (missing) {
      wx.showToast({ title: missing[1], icon: 'none' })
      return
    }
    const payload = {
      product_type: t(f.product_type),
      brand: t(f.brand),
      model: t(f.model),
      spec: t(f.spec) || null,
      serial_number: t(f.serial_number),
      condition_grade: f.condition_grade,
      price: Number(f.price),
      express_fee: f.express_fee === '' ? null : Number(f.express_fee),
      cost_price: f.cost_price === '' ? 0 : Number(f.cost_price),
      images: f.images,
      desc: t(f.desc) || null,
      source_asset_no: t(f.source_asset_no) || null,
      location_code: f.location_code || null,
      remark: t(f.remark) || null,
    }
    this.setData({ submitting: true })
    this.save(payload)
      .then((res) => {
        this.setData({ submitting: false })
        this.done(res)
      })
      .catch((err) => {
        this.setData({ submitting: false })
        if (err && err._cancelled) return
        wx.showToast({ title: (err && err.detail) || '保存失败', icon: 'none' })
      })
  },

  // 来源编号录过（409）时问一句，确认是另一台再带 allow_duplicate_source 重提
  save(payload) {
    const call = (data) => (this.data.code
      ? api.updateAssetIntake(this.data.code, data)
      : api.createAssetIntake(data))
    return call(payload).catch((err) => {
      if (!err || err.statusCode !== 409) throw err
      return new Promise((resolve, reject) => {
        wx.showModal({
          title: '来源编号录过',
          content: err.detail || '这个来源编号已经录过，确定是另一台？',
          confirmText: '是另一台',
          cancelText: '取消',
          success: (r) => (r.confirm
            ? resolve(call({ ...payload, allow_duplicate_source: true }))
            : reject({ _cancelled: true })),
          fail: () => reject({ _cancelled: true }),
        })
      })
    })
  },

  done(res) {
    if (this.data.code) {
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 800)
      return
    }
    // 仓管/销售/管理员能直接去上架；其他岗位录完等他们上架
    wx.showModal({
      title: '录入成功',
      content: `货号 ${res.sku_code}，已进待上架`,
      confirmText: res.can_publish ? '去上架' : '再录一台',
      cancelText: res.can_publish ? '再录一台' : '完成',
      success: (r) => {
        if (res.can_publish && r.confirm) {
          wx.redirectTo({ url: `/pages/listing/publish/index?code=${res.sku_code}` })
        } else if (res.can_publish || r.confirm) {
          this.next()
        } else {
          wx.navigateBack()
        }
      },
    })
  },

  // 再录一台：同一批货型号、价格多半一样，留着；序列号、来源编号、照片、瑕疵说明、备注每台不同，清掉
  next() {
    const f = this.data.form
    this.setData({
      form: {
        ...emptyForm(),
        product_type: f.product_type,
        brand: f.brand,
        model: f.model,
        spec: f.spec,
        condition_grade: f.condition_grade,
        price: f.price,
        express_fee: f.express_fee,
        cost_price: f.cost_price,
        location_code: f.location_code,
      },
      imageDisplay: [],
    })
    wx.pageScrollTo({ scrollTop: 0, duration: 200 })
  },
})

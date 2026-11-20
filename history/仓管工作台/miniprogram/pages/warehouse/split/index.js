const api = require('@services/api')
const appConfig = require('@services/config')
const { sanitizeMoneyField } = require('@utils/money')

const GRADES = ['95新', '9新', '85新', '8新']

function toCents(value) {
  return Math.round((Number(value) || 0) * 100)
}

function centsToStr(cents) {
  return (cents / 100).toFixed(2)
}

function blankItem(overrides = {}) {
  return Object.assign({
    brand: '',
    model: '',
    amount: '',
    serial_number: '',
    condition_grade: '',
    location_code: '',
    gradeIndex: -1,
    locationIndex: -1,
  }, overrides)
}

Page({
  data: {
    code: '',
    loading: true,
    submitting: false,
    grades: GRADES,
    locations: [],
    source: null, // { sku_code, product_name, cost_price, ... }
    items: [],
    sumText: '0.00',
    matched: false,
  },

  onLoad(options) {
    const code = options.code || ''
    if (!code) {
      wx.showToast({ title: '缺少货号', icon: 'none' })
      return
    }
    const mapLocs = () => appConfig.getLocations().map((loc) => ({
      code: loc.code,
      label: loc.label || (loc.zone ? `${loc.code}（${loc.zone}区）` : loc.code),
    }))
    let locations = mapLocs()
    this.setData({ code, locations })
    const ensureLocations = locations.length
      ? Promise.resolve(locations)
      : appConfig.refreshConfig().then(() => {
        locations = mapLocs()
        this.setData({ locations })
        return locations
      }).catch(() => locations)
    ensureLocations.then((locs) => api.skuDetail(code).then((detail) => ({ detail, locs }))).then(({ detail, locs }) => {
      if (detail.status !== 'IN_STOCK') {
        wx.showToast({ title: '仅在库商品可拆分', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 800)
        return
      }
      const cents = toCents(detail.cost_price)
      const half = Math.floor(cents / 2)
      const gradeIndex = GRADES.indexOf(detail.condition_grade || '')
      const locationIndex = locs.findIndex((l) => l.code === detail.location_code)
      const base = {
        brand: detail.brand || '',
        model: detail.model || '',
        condition_grade: detail.condition_grade || '',
        location_code: detail.location_code || '',
        gradeIndex,
        locationIndex,
      }
      const items = [
        blankItem(Object.assign({}, base, { amount: centsToStr(cents - half) })),
        blankItem(Object.assign({}, base, { amount: centsToStr(half) })),
      ]
      this.setData({ loading: false, source: detail, items }, () => this._recalc())
    }).catch((err) => {
      wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
      this.setData({ loading: false })
    })
  },

  _recalc() {
    const sum = this.data.items.reduce((acc, it) => acc + toCents(it.amount), 0)
    const target = toCents(this.data.source && this.data.source.cost_price)
    this.setData({ sumText: centsToStr(sum), matched: sum === target })
  },

  onItemInput(e) {
    const { index, field } = e.currentTarget.dataset
    const items = this.data.items.slice()
    items[index][field] = sanitizeMoneyField(field, e.detail.value)
    this.setData({ items }, () => this._recalc())
  },

  pickGrade(e) {
    const index = e.currentTarget.dataset.index
    const idx = Number(e.detail.value)
    const items = this.data.items.slice()
    items[index].gradeIndex = idx
    items[index].condition_grade = GRADES[idx] || ''
    this.setData({ items })
  },

  pickLocation(e) {
    const index = e.currentTarget.dataset.index
    const idx = Number(e.detail.value)
    const loc = this.data.locations[idx]
    const items = this.data.items.slice()
    items[index].locationIndex = idx
    items[index].location_code = loc ? loc.code : ''
    this.setData({ items })
  },

  addItem() {
    this.setData({ items: this.data.items.concat([blankItem()]) }, () => this._recalc())
  },

  removeItem(e) {
    const index = e.currentTarget.dataset.index
    if (this.data.items.length <= 2) {
      wx.showToast({ title: '至少保留 2 件', icon: 'none' })
      return
    }
    const items = this.data.items.filter((_, i) => i !== index)
    this.setData({ items }, () => this._recalc())
  },

  submit() {
    if (this.data.submitting) return
    const items = this.data.items
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i]
      const label = `第 ${i + 1} 件`
      if (!(it.brand || '').trim()) return wx.showToast({ title: `请填写${label}品牌`, icon: 'none' })
      if (!(it.model || '').trim()) return wx.showToast({ title: `请填写${label}型号`, icon: 'none' })
      if (!it.amount || Number(it.amount) <= 0) return wx.showToast({ title: `请填写${label}金额`, icon: 'none' })
    }
    if (!this.data.matched) {
      wx.showToast({ title: `各件金额之和须等于 ¥${this.data.source.cost_price}`, icon: 'none', duration: 2600 })
      return
    }

    const payload = items.map((it) => ({
      brand: it.brand.trim(),
      model: it.model.trim(),
      amount: Number(it.amount),
      condition_grade: it.condition_grade || null,
      location_code: it.location_code || null,
      serial_number: (it.serial_number || '').trim() || null,
    }))

    this.setData({ submitting: true })
    api.splitSku(this.data.code, payload).then((res) => {
      wx.showToast({ title: `已拆为 ${res.new_sku_codes.length} 件` })
      setTimeout(() => wx.navigateBack(), 800)
    }).catch((err) => {
      this.setData({ submitting: false })
      wx.showToast({ title: (err && err.detail) || '拆分失败', icon: 'none', duration: 2600 })
    })
  },
})

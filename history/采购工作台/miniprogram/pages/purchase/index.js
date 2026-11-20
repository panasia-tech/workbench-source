const api = require('@services/api')
const { sanitizeMoneyField } = require('../../utils/money')
const auth = require('@services/auth')
const appConfig = require('@services/config')
const media = require('../../utils/media')

const MAX_SCREENSHOTS = 2
const MAX_PRODUCT_IMAGES = 9

const EMPTY_FORM = {
  brand: '',
  model: '',
  spec: '',
  external_order_no: '',
  transaction_no: '',
  tracking_no: '',
  tracking_phone_suffix: '',
  seller_name: '',
  unit_price: '',
  purchase_account: '',
  remark: '',
  platform_item_id: '',
  source_url: '',
}

function splitDatetime(value) {
  if (!value) return { date: '', time: '' }
  const normalized = String(value).replace('T', ' ').trim()
  const [date = '', time = ''] = normalized.split(/\s+/)
  return { date, time: (time || '00:00').slice(0, 5) }
}

function joinDatetime(date, time) {
  if (!date || !time) return ''
  const t = time.length === 5 ? `${time}:00` : time
  return `${date} ${t}`
}

function mergeParsedList(parsedList) {
  const keys = [
    'product_name',
    'unit_price',
    'seller_name',
    'external_order_no',
    'transaction_no',
    'tracking_no',
    'order_time',
    'paid_at',
  ]
  const merged = {}
  keys.forEach((key) => {
    for (let i = 0; i < parsedList.length; i += 1) {
      const val = parsedList[i][key]
      if (val != null && val !== '') {
        merged[key] = val
        break
      }
    }
  })
  return merged
}

function composeProductName(brand, model) {
  return [brand, model].map((s) => (s || '').trim()).filter(Boolean).join(' ')
}

// 顺丰单（单号 SF 开头）默认手机后四位 5080，仅在用户未填时补
function isSfTracking(no) {
  return String(no || '').trim().toUpperCase().startsWith('SF')
}

function stepListFor(multiEnabled) {
  return multiEnabled ? [1, 2, 3] : [1, 2]
}

function validateProductItem(item, index) {
  const label = index != null ? `商品 ${index + 1} ` : ''
  if (!item.brand || !item.brand.trim()) return `请填写${label}品牌`
  if (!item.model || !item.model.trim()) return `请填写${label}型号`
  if (!item.spec || !item.spec.trim()) return `请填写${label}规格`
  if (!item.unit_price) return `请填写${label}成交金额`
  return ''
}

function validateMultiItem(item, index) {
  const label = `商品 ${index + 1} `
  if (!item.brand || !item.brand.trim()) return `请填写${label}品牌`
  if (!item.model || !item.model.trim()) return `请填写${label}型号`
  if (!item.amount) return `请填写${label}金额`
  return ''
}

function toCents(value) {
  return Math.round((Number(value) || 0) * 100)
}

function multiAmountsMatchTotal(items, total) {
  const sum = items.reduce((acc, item) => acc + toCents(item.amount), 0)
  return sum === toCents(total)
}

function applyOcrFields(form, parsed, fillEmptyOnly = false) {
  const patch = {}
  const keys = [
    'unit_price',
    'seller_name',
    'external_order_no',
    'transaction_no',
    'tracking_no',
  ]
  keys.forEach((key) => {
    if (parsed[key] == null || parsed[key] === '') return
    if (fillEmptyOnly && form[key] != null && String(form[key]).trim() !== '') return
    patch[`form.${key}`] = key === 'unit_price' ? String(parsed[key]) : parsed[key]
  })
  if (parsed.product_name) {
    if (!fillEmptyOnly || !String(form.model || '').trim()) {
      patch['form.model'] = parsed.product_name
    }
  }
  return patch
}

Page({
  data: {
    currentStep: 1,
    stepList: [1, 2],
    form: { ...EMPTY_FORM },
    orderDate: '',
    orderTime: '',
    paidDate: '',
    paidTime: '',
    multiEnabled: false,
    multiItems: [{ brand: '', model: '', amount: '' }],
    screenshotUrls: [],
    screenshotDisplayUrls: [],
    screenshotArchived: false,
    productImageUrls: [],
    productImageDisplayUrls: [],
    maxProductImages: MAX_PRODUCT_IMAGES,
    sourceStatus: '未识别',
    purchaseAccounts: [],
    purchaseAccountIndex: 0,
    purchaseAccountLabel: '',
    exampleScreenshotUrl: '',
    exampleProductUrl: '',
    bargainSessionId: '',
    platformOrderId: '',
    snapTitle: '',
    // W06 公司价：填完品牌型号规格查一次；配件不选时同型号单机全套不一样会提示待核
    quote: null,
    quoteAccessory: '',
    overCeiling: false,
    accessoryOptions: [
      { key: 'unit', label: '单机' }, { key: 'full', label: '全套' }, { key: 'no_box', label: '无盒' }, { key: 'parts', label: '缺配件' },
    ],
  },

  onLoad(options) {
    // 从议价「谈妥后建采购单」带入：会话、商品 ID、卖家、价格等
    const patch = {}
    const formPatch = {}
    if (options.bargain_session_id) patch.bargainSessionId = decodeURIComponent(options.bargain_session_id)
    if (options.platform_item_id) formPatch.platform_item_id = decodeURIComponent(options.platform_item_id)
    if (options.source_url) formPatch.source_url = decodeURIComponent(options.source_url)
    if (options.seller_name) formPatch.seller_name = decodeURIComponent(options.seller_name)
    if (options.purchase_account) formPatch.purchase_account = decodeURIComponent(options.purchase_account)
    if (options.unit_price) formPatch.unit_price = decodeURIComponent(options.unit_price)
    if (options.title) {
      // 闲鱼标题原文进快照；型号栏只是先填上，采购照实改
      patch.snapTitle = decodeURIComponent(options.title)
      formPatch.model = patch.snapTitle
    }
    if (Object.keys(formPatch).length) {
      Object.keys(formPatch).forEach((k) => { patch[`form.${k}`] = formPatch[k] })
      patch.currentStep = 2
    }
    if (Object.keys(patch).length) this.setData(patch)
    // 从「平台订单 · 待建单」一键建单：执行端抓到的订单号、金额、时间、卖家带过来，图和型号采购照实确认
    if (options.platform_order_id) this.loadPlatformDraft(decodeURIComponent(options.platform_order_id))
  },

  loadPlatformDraft(id) {
    api.platformOrderDraft(id).then((d) => {
      const patch = { platformOrderId: id, currentStep: 2 }
      const f = {
        external_order_no: d.external_order_no, purchase_account: d.purchase_account, unit_price: d.unit_price,
        seller_name: d.seller_name, tracking_no: d.tracking_no, platform_item_id: d.platform_item_id,
      }
      Object.keys(f).forEach((k) => { if (f[k]) patch[`form.${k}`] = String(f[k]) })
      if (d.product_name) {
        patch.snapTitle = d.product_name
        patch['form.model'] = d.product_name
      }
      const split = (iso) => (iso ? [iso.slice(0, 10), iso.slice(11, 16)] : null)
      const o = split(d.order_time)
      const p = split(d.paid_at)
      if (o) Object.assign(patch, { orderDate: o[0], orderTime: o[1] })
      if (p) Object.assign(patch, { paidDate: p[0], paidTime: p[1] })
      this.setData(patch, () => this.syncPurchaseAccounts())
    }).catch(() => wx.showToast({ title: '平台订单没带过来，照常手填', icon: 'none' }))
  },

  syncPurchaseExamples() {
    const examples = appConfig.getPurchaseExamples()
    const patch = {}
    if (examples) {
      patch.exampleScreenshotUrl = examples.screenshot_url || ''
      patch.exampleProductUrl = examples.product_url || ''
    }
    if (Object.keys(patch).length) {
      this.setData(patch)
    }
  },

  syncPurchaseAccounts() {
    const accounts = appConfig.getPurchaseAccounts()
    let purchaseAccountIndex = 0
    let purchaseAccountLabel = ''
    let purchaseAccount = (this.data.form.purchase_account || '').trim()
    if (!purchaseAccount) {
      purchaseAccount = appConfig.getLastPurchaseAccount()
    }
    if (purchaseAccount && accounts.length) {
      const idx = accounts.findIndex((row) => row.code === purchaseAccount)
      if (idx >= 0) {
        purchaseAccountIndex = idx
        purchaseAccountLabel = accounts[idx].label
      }
    }
    const patch = {
      purchaseAccounts: accounts,
      purchaseAccountIndex,
      purchaseAccountLabel,
    }
    if (purchaseAccount && purchaseAccountLabel) {
      patch['form.purchase_account'] = purchaseAccount
    }
    this.setData(patch)
  },

  onShow() {
    auth.ensureLogin().then(() => {
      this.syncPurchaseExamples()
      this.syncPurchaseAccounts()
      if (!appConfig.getPurchaseAccounts().length || !appConfig.getPurchaseExamples()) {
        return appConfig.refreshConfig().then(() => {
          this.syncPurchaseExamples()
          this.syncPurchaseAccounts()
        })
      }
      return null
    }).catch(() => {})
  },

  onPurchaseAccountChange(e) {
    const index = Number(e.detail.value)
    const account = this.data.purchaseAccounts[index]
    if (!account) return
    appConfig.saveLastPurchaseAccount(account.code)
    this.setData({
      purchaseAccountIndex: index,
      purchaseAccountLabel: account.label,
      'form.purchase_account': account.code,
    })
  },

  validateStep(step) {
    if (step === 1) {
      if (!this.data.form.purchase_account.trim()) return '请选择采购账号'
      if (!this.data.productImageUrls.length) return '请至少上传 1 张商品图'
      return ''
    }
    if (step === 2) {
      const sharedError = this.validateSharedFields()
      if (sharedError) return sharedError
      if (!this.data.multiEnabled) {
        return validateProductItem({
          brand: this.data.form.brand,
          model: this.data.form.model,
          spec: this.data.form.spec,
          unit_price: this.data.form.unit_price,
        })
      }
      if (!this.data.form.unit_price) return '请填写成交金额'
      return ''
    }
    if (step === 3) {
      const sharedError = this.validateSharedFields()
      if (sharedError) return sharedError
      for (let i = 0; i < this.data.multiItems.length; i += 1) {
        const err = validateMultiItem(this.data.multiItems[i], i)
        if (err) return err
      }
      if (!multiAmountsMatchTotal(this.data.multiItems, this.data.form.unit_price)) {
        return `各商品金额之和须等于成交金额（¥${this.data.form.unit_price}）`
      }
    }
    return ''
  },

  maxStep() {
    return this.data.multiEnabled ? 3 : 2
  },

  nextStep() {
    const err = this.validateStep(this.data.currentStep)
    if (err) {
      wx.showToast({ title: err, icon: 'none' })
      return
    }
    if (this.data.currentStep < this.maxStep()) {
      this.setData({ currentStep: this.data.currentStep + 1 })
    }
  },

  prevStep() {
    if (this.data.currentStep > 1) {
      this.setData({ currentStep: this.data.currentStep - 1 })
    }
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    const value = sanitizeMoneyField(key, e.detail.value)
    const patch = { [`form.${key}`]: value }
    if (key === 'tracking_no' && !this.data.form.tracking_phone_suffix && isSfTracking(value)) {
      patch['form.tracking_phone_suffix'] = '5080'
    }
    this.setData(patch, () => {
      if (['brand', 'model', 'spec'].includes(key)) this.scheduleQuote()
      if (key === 'unit_price') this.checkCeiling()
    })
  },

  scheduleQuote() {
    clearTimeout(this._quoteTimer)
    this._quoteTimer = setTimeout(() => this.refreshQuote(), 600)
  },

  refreshQuote() {
    const { brand, model, spec } = this.data.form
    if (!(brand || '').trim() || !(model || '').trim()) {
      this.setData({ quote: null, overCeiling: false })
      return
    }
    const params = { brand: brand.trim(), model: model.trim() }
    if ((spec || '').trim()) params.spec = spec.trim()
    if (this.data.quoteAccessory) params.accessory = this.data.quoteAccessory
    api.purchaseQuote(params).then((q) => this.setData({ quote: q }, () => this.checkCeiling())).catch(() => {})
  },

  pickAccessory(e) {
    const key = e.currentTarget.dataset.key
    this.setData({ quoteAccessory: this.data.quoteAccessory === key ? '' : key }, () => this.refreshQuote())
  },

  checkCeiling() {
    const q = this.data.quote
    const ceiling = q && q.rule && q.rule.ceiling ? Number(q.rule.ceiling) : 0
    const price = Number(this.data.form.unit_price || 0)
    this.setData({ overCeiling: !!(ceiling && price > ceiling) })
  },

  onPhoneSuffixInput(e) {
    const digits = String(e.detail.value || '').replace(/\D/g, '').slice(0, 4)
    this.setData({ 'form.tracking_phone_suffix': digits })
  },

  onOrderDateChange(e) {
    this.setData({ orderDate: e.detail.value })
  },

  onOrderTimeChange(e) {
    this.setData({ orderTime: e.detail.value })
  },

  onPaidDateChange(e) {
    this.setData({ paidDate: e.detail.value })
  },

  onPaidTimeChange(e) {
    this.setData({ paidTime: e.detail.value })
  },

  onMultiToggle(e) {
    const multiEnabled = e.detail.value
    const patch = {
      multiEnabled,
      stepList: stepListFor(multiEnabled),
    }
    if (multiEnabled) {
      const items = this.data.multiItems.length
        ? this.data.multiItems.slice()
        : [{ brand: '', model: '', amount: '' }]
      items[0] = {
        brand: this.data.form.brand || items[0].brand,
        model: this.data.form.model || items[0].model,
        amount: items[0].amount || '',
      }
      patch.multiItems = items
    } else if (this.data.currentStep > 2) {
      patch.currentStep = 2
    }
    this.setData(patch)
  },

  onMultiInput(e) {
    const { index, field } = e.currentTarget.dataset
    const multiItems = this.data.multiItems.slice()
    multiItems[index][field] = sanitizeMoneyField(field, e.detail.value)
    this.setData({ multiItems })
  },

  addMultiItem() {
    this.setData({
      multiItems: this.data.multiItems.concat([{ brand: '', model: '', amount: '' }]),
    })
  },

  removeMultiItem(e) {
    const index = Number(e.currentTarget.dataset.index)
    const multiItems = this.data.multiItems.filter((_, i) => i !== index)
    this.setData({ multiItems })
  },

  runOcrOnUrls(urls, fillEmptyOnly = false) {
    if (!urls.length) return
    this.setData({ sourceStatus: '识别中' })
    Promise.all(urls.map((url) => api.ocrXianyu(url).then((res) => {
      console.log('[OCR] 单张结果', url, res)
      return res
    }).catch((err) => {
      console.log('[OCR] 识别失败', url, err)
      return null
    }))).then((results) => {
      const valid = results.filter(Boolean)
      if (!valid.length) {
        this.setData({ sourceStatus: '识别失败' })
        wx.showToast({ title: 'OCR 识别失败', icon: 'none' })
        return
      }
      const parsed = mergeParsedList(valid.map((ocr) => ocr.parsed || {}))
      console.log('[OCR] 合并结果', parsed, '原始响应', valid)
      const patch = applyOcrFields(this.data.form, parsed, fillEmptyOnly)
      const trackingNo = patch['form.tracking_no'] != null ? patch['form.tracking_no'] : this.data.form.tracking_no
      if (!this.data.form.tracking_phone_suffix && isSfTracking(trackingNo)) {
        patch['form.tracking_phone_suffix'] = '5080'
      }
      if (parsed.order_time && (!fillEmptyOnly || !this.data.orderDate)) {
        const { date, time } = splitDatetime(parsed.order_time)
        patch.orderDate = date
        patch.orderTime = time
      }
      if (parsed.paid_at && (!fillEmptyOnly || !this.data.paidDate)) {
        const { date, time } = splitDatetime(parsed.paid_at)
        patch.paidDate = date
        patch.paidTime = time
      }
      if (this.data.multiEnabled && parsed.product_name) {
        const first = this.data.multiItems[0] || {}
        if (!fillEmptyOnly || !first.model) {
          patch.multiItems = [{
            brand: first.brand || '',
            model: parsed.product_name,
            amount: first.amount || '',
          }]
        }
      }
      if (this.data.multiEnabled && parsed.unit_price != null && parsed.unit_price !== '') {
        if (!fillEmptyOnly || !this.data.form.unit_price) {
          patch['form.unit_price'] = String(parsed.unit_price)
        }
      }
      const hasParsed = Object.keys(patch).some((key) => (
        key.startsWith('form.')
        || key === 'orderDate' || key === 'orderTime'
        || key === 'paidDate' || key === 'paidTime'
      ))
      patch.sourceStatus = hasParsed ? 'OCR 识别' : '未识别到字段'
      if (!hasParsed) {
        wx.showToast({ title: '未识别到订单字段，请手动填写', icon: 'none' })
      }
      this.setData(patch)
    })
  },

  chooseImage() {
    const remaining = MAX_SCREENSHOTS - this.data.screenshotUrls.length
    if (remaining <= 0) {
      wx.showToast({ title: '最多上传 2 张截图', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: remaining,
      mediaType: ['image'],
      success: (res) => {
        const hadImages = this.data.screenshotUrls.length > 0
        const uploads = res.tempFiles.map((file, i) =>
          api.uploadMedia('purchase/screenshots/', `${Date.now()}_${i}.jpg`, file.tempFilePath)
        )
        Promise.all(uploads).then((results) => {
          const screenshotUrls = [
            ...this.data.screenshotUrls,
            ...results.map((result) => result.public_url),
          ]
          const screenshotDisplayUrls = [
            ...this.data.screenshotDisplayUrls,
            ...results.map((result) => media.uploadAccessUrl(result)),
          ]
          const patch = {
            screenshotUrls,
            screenshotDisplayUrls,
            screenshotArchived: screenshotUrls.some((url) => media.isOssArchived(url)),
          }
          this.setData(patch, () => {
            const newUrls = results.map((result) => result.public_url)
            this.runOcrOnUrls(newUrls, hadImages)
          })
        }).catch(() => {
          wx.showToast({ title: '上传失败', icon: 'none' })
        })
      },
    })
  },

  chooseProductImage() {
    const remaining = MAX_PRODUCT_IMAGES - this.data.productImageUrls.length
    if (remaining <= 0) {
      wx.showToast({ title: `最多上传 ${MAX_PRODUCT_IMAGES} 张商品图`, icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: remaining,
      mediaType: ['image'],
      success: (res) => {
        const uploads = res.tempFiles.map((file, i) =>
          api.uploadMedia('purchase/products/', `${Date.now()}_${i}.jpg`, file.tempFilePath)
        )
        Promise.all(uploads).then((results) => {
          this.setData({
            productImageUrls: [
              ...this.data.productImageUrls,
              ...results.map((result) => result.public_url),
            ],
            productImageDisplayUrls: [
              ...this.data.productImageDisplayUrls,
              ...results.map((result) => media.uploadAccessUrl(result)),
            ],
          })
        }).catch(() => {
          wx.showToast({ title: '上传失败', icon: 'none' })
        })
      },
    })
  },

  removeProductImage(e) {
    const index = Number(e.currentTarget.dataset.index)
    this.setData({
      productImageUrls: this.data.productImageUrls.filter((_, i) => i !== index),
      productImageDisplayUrls: this.data.productImageDisplayUrls.filter((_, i) => i !== index),
    })
  },

  removeScreenshot(e) {
    const index = Number(e.currentTarget.dataset.index)
    const screenshotUrls = this.data.screenshotUrls.filter((_, i) => i !== index)
    const screenshotDisplayUrls = this.data.screenshotDisplayUrls.filter((_, i) => i !== index)
    const patch = { screenshotUrls, screenshotDisplayUrls }
    if (!screenshotUrls.length) {
      patch.sourceStatus = '未识别'
      patch.screenshotArchived = false
    } else {
      patch.screenshotArchived = screenshotUrls.some((url) => media.isOssArchived(url))
    }
    this.setData(patch)
  },

  buildPayload(brand, model, unitPrice, spec) {
    const f = this.data.form
    const urls = this.data.screenshotUrls
    const brandText = (brand || '').trim()
    const modelText = (model || '').trim()
    const specText = (spec || '').trim()
    return {
      brand: brandText,
      model: modelText,
      product_name: composeProductName(brandText, modelText),
      spec: specText || null,
      unit_price: Number(unitPrice),
      external_order_no: f.external_order_no.trim(),
      transaction_no: f.transaction_no.trim(),
      tracking_no: f.tracking_no.trim(),
      tracking_phone_suffix: (f.tracking_phone_suffix || '').replace(/\D/g, '').slice(0, 4) || null,
      seller_name: f.seller_name.trim(),
      order_time: joinDatetime(this.data.orderDate, this.data.orderTime),
      paid_at: joinDatetime(this.data.paidDate, this.data.paidTime),
      purchase_account: f.purchase_account.trim(),
      remark: f.remark.trim() || null,
      screenshot_url: urls[0] || null,
      screenshot_url_2: urls[1] || null,
      attachments: [],
      product_images: [...this.data.productImageUrls],
      // W04 商品快照（选填）：闲鱼商品 ID / 原链接，建单时落首版并冻结
      platform_item_id: (f.platform_item_id || '').trim() || null,
      source_url: (f.source_url || '').trim() || null,
      // 快照记卖家页面原样：标题只在从议价带来时有（闲鱼原文）；我们拼的「品牌 型号」、成交价都不是页面原文，不记
      snapshot_title: this.data.snapTitle || null,
      // W07：谈妥会话，建单后自动绑上
      bargain_session_id: this.data.bargainSessionId || null,
      // W10：从平台订单一键建的，建完自动挂上
      platform_order_id: this.data.platformOrderId || null,
      // W06：查到的那版公司价锁在采购单上
      price_rule_id: (this.data.quote && this.data.quote.rule && ['ok', 'pending'].includes(this.data.quote.status)) ? this.data.quote.rule.id : null,
    }
  },

  validateSharedFields() {
    const f = this.data.form
    if (!f.external_order_no.trim()) return '请填写订单号'
    if (!f.transaction_no.trim()) return '请填写交易流水号'
    if (!f.tracking_no.trim()) return '请填写物流单号'
    if (!f.seller_name.trim()) return '请填写卖家昵称'
    if (!f.purchase_account.trim()) return '请选择采购账号'
    if (!joinDatetime(this.data.orderDate, this.data.orderTime)) return '请选择下单时间'
    if (!joinDatetime(this.data.paidDate, this.data.paidTime)) return '请选择付款时间'
    return ''
  },

  submit() {
    const validateAt = this.data.multiEnabled ? 3 : 2
    const err = this.validateStep(validateAt)
    if (err) {
      wx.showToast({ title: err, icon: 'none' })
      return
    }
    if (!this.data.productImageUrls.length) {
      wx.showToast({ title: '请至少上传 1 张商品图', icon: 'none' })
      return
    }

    const items = this.data.multiEnabled
      ? this.data.multiItems
      : [{
        brand: this.data.form.brand,
        model: this.data.form.model,
        unit_price: this.data.form.unit_price,
        spec: this.data.form.spec,
      }]

    const payloads = items.map((item) => this.buildPayload(
      item.brand.trim(),
      item.model.trim(),
      this.data.multiEnabled ? item.amount : item.unit_price,
      this.data.multiEnabled ? null : item.spec,
    ))
    const created = []
    const submitAll = payloads.reduce(
      (chain, payload) => chain
        .then(() => this.createWithDuplicateConfirm(payload))
        .then((order) => { if (order) created.push(order) }),
      Promise.resolve(),
    )

    submitAll.then(() => {
      const lastAccount = this.data.form.purchase_account
      const lastAccountLabel = this.data.purchaseAccountLabel
      const lastAccountIndex = this.data.purchaseAccountIndex
      if (lastAccount) {
        appConfig.saveLastPurchaseAccount(lastAccount)
      }
      const overdueCount = created.filter((o) => o && o.is_overdue).length
      if (overdueCount > 0) {
        const prefix = created.length > 1 ? `${overdueCount}/${created.length} 单为逾期采购：` : ''
        wx.showModal({
          title: '逾期提交采购单',
          content: `${prefix}快件已到浙江省内，提交过晚，本单不发放基础提成，但仍正常入库走流程。`,
          showCancel: false,
          confirmText: '我知道了',
        })
      } else {
        wx.showToast({ title: payloads.length > 1 ? `已提交 ${payloads.length} 单` : '提交成功' })
      }
      this.setData({
        currentStep: 1,
        stepList: [1, 2],
        form: { ...EMPTY_FORM, purchase_account: lastAccount || '' },
        orderDate: '',
        orderTime: '',
        paidDate: '',
        paidTime: '',
        multiEnabled: false,
        multiItems: [{ brand: '', model: '', amount: '' }],
        screenshotUrls: [],
        screenshotDisplayUrls: [],
        productImageUrls: [],
        productImageDisplayUrls: [],
        sourceStatus: '未识别',
        screenshotArchived: false,
        purchaseAccountIndex: lastAccountIndex,
        purchaseAccountLabel: lastAccountLabel,
        bargainSessionId: '', // 已绑上这单；接着录的下一单和这个议价无关
        snapTitle: '',
      })
      this.syncPurchaseAccounts()
    }).catch((err) => {
      if (err && err._cancelled) {
        wx.showToast({ title: '已取消重复创建', icon: 'none' })
        return
      }
      wx.showToast({ title: (err && err.detail) || '提交失败', icon: 'none' })
    })
  },

  // 创建采购单：命中订单号去重(409)时弹窗二次确认，确认后带 allow_duplicate 重提
  createWithDuplicateConfirm(payload) {
    return api.createPurchase(payload).catch((e) => {
      if (!e || e.statusCode !== 409) throw e
      return new Promise((resolve, reject) => {
        wx.showModal({
          title: '订单号重复',
          content: e.detail || '该订单号已存在采购单，确认仍要创建？',
          confirmText: '仍要创建',
          cancelText: '取消',
          success: (r) => {
            if (r.confirm) {
              resolve(api.createPurchase({ ...payload, allow_duplicate: true }))
            } else {
              reject({ _cancelled: true })
            }
          },
          fail: () => reject({ _cancelled: true }),
        })
      })
    })
  },

  goRecords() {
    wx.navigateTo({ url: '/pages/purchase/records/index' })
  },
})

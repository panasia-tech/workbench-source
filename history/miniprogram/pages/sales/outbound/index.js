const api = require('@services/api')
const { scanBarcode } = require('@services/scan')
const { sanitizeMoneyField } = require('@utils/money')

const TYPE_META = {
  PICKUP: {
    title: '买家自提出库',
    note: '生成收款码让买家扫码支付，支付成功自动出库',
  },
  SWITCH: {
    title: '切单发货出库',
    note: '切单占用库存发货，需填写快递运单号',
  },
}

const PAY_TIMEOUT_SECONDS = 15 * 60
// 未完成的收款单存本地：小程序被杀掉重进后，靠它把二维码和倒计时捞回来
const PENDING_PAY_KEY = 'pending_pickup_pay'
const POLL_INTERVAL_MS = 3000

Page({
  data: {
    pageTitle: '买家自提出库',
    pageNote: '',
    form: {
      sku_code: '',
      buyer_name: '',
      sale_price: '',
      outbound_type: 'PICKUP',
      tracking_no: '',
      tracking_phone_suffix: '',
      express_fee: '',
      platform_fee: '',
      remark: '',
      evidence_urls: [],
      worry_free: false, // 切单发货=平台交易：是否无忧卖（off=普通1.6% / on=无忧2.6%）
    },
    evidenceDisplayUrls: [],
    sku: null,
    skuLoading: false,
    skuError: '',
    submitting: false,
    // 自提收款码
    pay: null, // { out_trade_no, qr_image, status }
    countdownText: '',
    polling: false,
  },

  onLoad(options) {
    const type = options.type === 'SWITCH' ? 'SWITCH' : 'PICKUP'
    const meta = TYPE_META[type]
    this.setData({
      pageTitle: meta.title,
      pageNote: meta.note,
      'form.outbound_type': type,
      'form.sku_code': options.code || '',
    })
    if (options.code) {
      this.lookupSku(options.code, { fillPrice: true })
    }
    if (type === 'PICKUP') this._restorePending()
  },

  // 小程序被杀后重进：把还没完结的收款单恢复出来
  // （状态接口会连带返回 qr_image，所以二维码不用重新生成）
  _restorePending() {
    let saved = null
    try {
      saved = wx.getStorageSync(PENDING_PAY_KEY)
    } catch (e) {
      return
    }
    if (!saved || !saved.out_trade_no) return
    if (Date.now() >= saved.deadline) {
      this._clearPending()
      return
    }
    api.pickupPaymentStatus(saved.out_trade_no)
      .then((pay) => {
        if (pay.status === 'DONE') {
          this._clearPending()
          wx.showToast({ title: '该单已支付并出库', icon: 'none' })
          return
        }
        if (pay.status !== 'PENDING' || !pay.qr_image) {
          this._clearPending()
          return
        }
        this._payDeadline = saved.deadline
        this.setData({
          pay,
          polling: true,
          'form.sku_code': pay.sku_code || '',
          'form.sale_price': String(pay.sale_price),
        })
        this._startCountdown()
        this._startPolling()
      })
      .catch(() => this._clearPending())
  },

  _clearPending() {
    try {
      wx.removeStorageSync(PENDING_PAY_KEY)
    } catch (e) {}
  },

  onUnload() {
    this._stopTimers()
  },

  onHide() {
    // 只停计时器，_payDeadline 保留，onShow 按绝对截止时间接着走
    this._stopTimers()
  },

  onShow() {
    // 切后台再回来要接着轮询：钱可能已经到账（异步通知那路服务端已出库），
    // 界面不能一直卡在「等待支付中」
    if (!this.data.pay || !this._payDeadline) return
    if (Date.now() >= this._payDeadline) {
      this.setData({ countdownText: '已超时', polling: false })
      return
    }
    this._stopTimers() // 防重入：onShow 可能在计时器仍在跑时触发
    this.setData({ polling: true })
    this._startCountdown()
    this._startPolling()
  },

  onInput(e) {
    const key = e.currentTarget.dataset.key
    const value = sanitizeMoneyField(key, e.detail.value)
    this.setData({ [`form.${key}`]: value })
    // 货号一旦改动，清空已展示的商品信息，等待重新查询
    if (key === 'sku_code' && this.data.sku && this.data.sku.sku_code !== value.trim()) {
      this.setData({ sku: null, skuError: '' })
    }
  },

  onCodeBlur(e) {
    const code = (e.detail.value || '').trim()
    if (code) this.lookupSku(code, { fillPrice: !this.data.form.sale_price })
  },

  // 查询并展示货号对应的商品简要信息
  lookupSku(code, { fillPrice = false } = {}) {
    const sku_code = (code || '').trim()
    if (!sku_code) return
    if (this.data.sku && this.data.sku.sku_code === sku_code) return
    this.setData({ skuLoading: true, skuError: '' })
    api.skuDetail(sku_code)
      .then((sku) => {
        const patch = { sku, skuLoading: false }
        if (fillPrice && sku.suggest_price) {
          patch['form.sale_price'] = String(sku.suggest_price)
        }
        this.setData(patch)
      })
      .catch((err) => {
        this.setData({ sku: null, skuLoading: false, skuError: err.detail || '未找到该货号对应的商品' })
      })
  },

  goSkuDetail() {
    const sku = this.data.sku
    if (!sku) return
    wx.navigateTo({ url: `/pages/warehouse/detail/index?code=${sku.sku_code}` })
  },

  onPhoneSuffixInput(e) {
    const digits = String(e.detail.value || '').replace(/\D/g, '').slice(0, 4)
    this.setData({ 'form.tracking_phone_suffix': digits })
  },

  onWorryFreeChange(e) {
    this.setData({ 'form.worry_free': !!e.detail.value })
  },

  scanSku() {
    scanBarcode()
      .then((code) => {
        this.setData({ 'form.sku_code': code })
        this.lookupSku(code, { fillPrice: !this.data.form.sale_price })
      })
      .catch(() => {})
  },

  uploadEvidence() {
    const remain = 3 - this.data.form.evidence_urls.length
    if (remain <= 0) {
      wx.showToast({ title: '最多 3 个凭证', icon: 'none' })
      return
    }
    wx.chooseMedia({
      count: remain,
      mediaType: ['image', 'video'],
      success: (res) => {
        const urls = [...this.data.form.evidence_urls]
        const displayUrls = [...this.data.evidenceDisplayUrls]
        res.tempFiles.forEach((file, i) => {
          const ext = file.fileType === 'video' ? '.mp4' : '.jpg'
          api.uploadMedia('sales/evidence/', `${Date.now()}_${i}${ext}`, file.tempFilePath).then((result) => {
            urls.push(result.public_url)
            displayUrls.push(result.access_url || result.public_url)
            this.setData({ 'form.evidence_urls': urls, evidenceDisplayUrls: displayUrls })
          }).catch(() => {
            wx.showToast({ title: '上传失败', icon: 'none' })
          })
        })
      },
    })
  },

  // ---------- 自提：生成收款码 + 轮询 ----------
  generatePayment() {
    const f = this.data.form
    if (!f.sku_code.trim()) {
      wx.showToast({ title: '请填写货号', icon: 'none' })
      return
    }
    if (!f.buyer_name.trim()) {
      wx.showToast({ title: '请填写买家昵称', icon: 'none' })
      return
    }
    if (!f.sale_price || Number(f.sale_price) <= 0) {
      wx.showToast({ title: '请填写正确售价', icon: 'none' })
      return
    }
    if (!f.evidence_urls.length) {
      wx.showToast({ title: '请上传至少 1 张成交凭证', icon: 'none' })
      return
    }
    const sku = this.data.sku
    if (sku && sku.on_shelf_count > 0) {
      wx.showToast({ title: `仍在 ${sku.on_shelf_count} 个店铺在架，请先全部下架`, icon: 'none', duration: 2800 })
      return
    }

    this.setData({ submitting: true })
    api.createPickupPayment({
      sku_code: f.sku_code.trim(),
      buyer_name: f.buyer_name.trim(),
      sale_price: Number(f.sale_price),
      evidence_urls: f.evidence_urls,
      express_fee: f.express_fee ? Number(f.express_fee) : null,
      remark: f.remark || null,
    })
      .then((pay) => {
        // 【临时】订单码支付未开通前的人工模式：后端 PICKUP_PAYMENT_AUTO_SUCCESS=true 时，
        // create 跳过收款码、凭已上传的成交凭证直接判成交并出库（status=DONE）。
        // 订单码支付开通后后端改回 false，则自动走下面的收款码 + 轮询逻辑，本前端无需再改。
        if (pay && pay.status === 'DONE') {
          wx.showToast({ title: '成交成功，已出库' })
          setTimeout(() => wx.navigateBack(), 800)
          return
        }
        // 正常收款码模式：展示二维码 + 轮询；拿不到收款码即视为失败，不出现“无码即成交”的捷径
        if (!pay || !pay.qr_image) {
          wx.showToast({ title: '生成收款码失败，请重试', icon: 'none' })
          return
        }
        this._payDeadline = Date.now() + PAY_TIMEOUT_SECONDS * 1000
        try {
          wx.setStorageSync(PENDING_PAY_KEY, {
            out_trade_no: pay.out_trade_no,
            deadline: this._payDeadline,
          })
        } catch (e) {}
        this.setData({ pay, polling: true })
        this._startCountdown()
        this._startPolling()
      })
      .catch((err) => {
        wx.showToast({ title: err.detail || '生成收款码失败', icon: 'none' })
      })
      .finally(() => this.setData({ submitting: false }))
  },

  cancelPayment() {
    this._stopTimers()
    this._payDeadline = null
    this._clearPending()
    this.setData({ pay: null, polling: false, countdownText: '' })
  },

  _startCountdown() {
    // 用绝对截止时间而不是自减计数：切后台期间计时器是停的，
    // 自减会把已经流逝的时间白送给买家。
    const tick = () => {
      const left = Math.ceil((this._payDeadline - Date.now()) / 1000)
      if (left <= 0) {
        this._stopTimers()
        this._clearPending()
        this.setData({ countdownText: '已超时', polling: false })
        wx.showToast({ title: '收款超时，请重新生成', icon: 'none' })
        return
      }
      const m = String(Math.floor(left / 60)).padStart(2, '0')
      const s = String(left % 60).padStart(2, '0')
      this.setData({ countdownText: `${m}:${s}` })
    }
    tick()
    this._countdownTimer = setInterval(tick, 1000)
  },

  _startPolling() {
    const poll = () => {
      const pay = this.data.pay
      if (!pay) return
      api.pickupPaymentStatus(pay.out_trade_no).then((res) => {
        if (res.status === 'DONE') {
          this._stopTimers()
          this._clearPending()
          this.setData({ polling: false })
          wx.showToast({ title: '支付成功，已出库' })
          setTimeout(() => wx.navigateBack(), 800)
        } else if (res.status === 'EXPIRED' || res.status === 'CANCELLED') {
          this._stopTimers()
          this._clearPending()
          this.setData({ polling: false, countdownText: '已超时' })
          wx.showToast({ title: '收款超时，请重新生成', icon: 'none' })
        }
      }).catch(() => {})
    }
    poll() // 先查一次：恢复前台时钱可能已经到账，不必再等一个轮询间隔
    this._pollTimer = setInterval(poll, POLL_INTERVAL_MS)
  },

  _stopTimers() {
    if (this._countdownTimer) { clearInterval(this._countdownTimer); this._countdownTimer = null }
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null }
  },

  // ---------- 切单发货：沿用手动出库 ----------
  submit() {
    const f = this.data.form
    if (!f.sku_code.trim()) {
      wx.showToast({ title: '请填写货号', icon: 'none' })
      return
    }
    if (!f.buyer_name.trim()) {
      wx.showToast({ title: '请填写买家昵称', icon: 'none' })
      return
    }
    if (!f.sale_price) {
      wx.showToast({ title: '请填写售价', icon: 'none' })
      return
    }
    if (!(f.tracking_no || '').trim()) {
      wx.showToast({ title: '切单发货请填写运单号', icon: 'none' })
      return
    }
    if (!f.evidence_urls.length) {
      wx.showToast({ title: '请上传至少 1 个成交凭证', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    api.outboundManual({
      sku_code: f.sku_code.trim(),
      buyer_name: f.buyer_name.trim(),
      sale_price: Number(f.sale_price),
      outbound_type: 'SWITCH',
      worry_free: !!f.worry_free,
      platform_fee: f.platform_fee === '' ? null : Number(f.platform_fee),
      evidence_urls: f.evidence_urls,
      payment_screenshot_url: null,
      tracking_no: (f.tracking_no || '').trim() || null,
      tracking_phone_suffix: (f.tracking_phone_suffix || '').replace(/\D/g, '').slice(0, 4) || null,
      express_fee: f.express_fee ? Number(f.express_fee) : null,
      remark: f.remark || null,
    })
      .then(() => {
        wx.showToast({ title: '出库成功' })
        setTimeout(() => wx.navigateBack(), 500)
      })
      .catch((err) => {
        wx.showToast({ title: err.detail || '出库失败', icon: 'none' })
      })
      .finally(() => this.setData({ submitting: false }))
  },
})

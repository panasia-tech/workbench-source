const auth = require('@services/auth')
const api = require('@services/api')
const { scanBarcode } = require('@services/scan')

const CARRIER_OPTIONS = ['中国移动', '中国联通', '中国电信', '中国广电']

Page({
  data: {
    isEdit: false,
    id: '',
    carrierOptions: CARRIER_OPTIONS,
    carrierIndex: 0,
    form: {
      name: '',
      phone_number: '',
      iccid: '',
      carrier: '',
      activation_date: '',
      plan_details: '',
      xianyu_member_name: '',
      remark: '',
    },
    submitting: false,
  },

  onLoad(options) {
    auth.ensureLogin().then(() => {
      // 员工登记自己的号码：新建时姓名预填本人
      if (!this.data.isEdit && !this.data.form.name) {
        const user = getApp().globalData.user || {}
        this.setData({ 'form.name': user.name || user.username || '' })
      }
    })
    if (options.id) {
      this.setData({ isEdit: true, id: options.id })
      this.loadPhone(options.id)
    }
  },

  loadPhone(id) {
    api.getPhone(id).then((res) => {
      const idx = CARRIER_OPTIONS.indexOf(res.carrier)
      this.setData({
        carrierIndex: idx >= 0 ? idx : 0,
        form: {
          name: res.name || '',
          phone_number: res.phone_number || '',
          iccid: res.iccid || '',
          carrier: res.carrier || '',
          activation_date: res.activation_date || '',
          plan_details: res.plan_details || '',
          xianyu_member_name: res.xianyu_member_name || '',
          remark: res.remark || '',
        },
      })
    }).catch(() => {
      wx.showToast({ title: '加载失败', icon: 'none' })
    })
  },

  onInput(e) {
    const { field } = e.currentTarget.dataset
    this.setData({ [`form.${field}`]: e.detail.value })
  },

  onDateChange(e) {
    this.setData({ 'form.activation_date': e.detail.value })
  },

  onCarrierChange(e) {
    const idx = Number(e.detail.value)
    this.setData({ carrierIndex: idx, 'form.carrier': CARRIER_OPTIONS[idx] })
  },

  onScanIccid() {
    scanBarcode({ scanType: ['barCode', 'qrCode'] })
      .then((code) => this.setData({ 'form.iccid': code.slice(0, 50) }))
      .catch(() => {})
  },

  onSubmit() {
    const { form, isEdit, id } = this.data
    if (!form.name.trim()) {
      wx.showToast({ title: '请输入姓名', icon: 'none' })
      return
    }
    if (!form.phone_number.trim()) {
      wx.showToast({ title: '请输入号码', icon: 'none' })
      return
    }
    if (!form.iccid.trim()) {
      wx.showToast({ title: '请扫码或输入 ICCID', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    const payload = {
      name: form.name.trim(),
      phone_number: form.phone_number.trim(),
      iccid: form.iccid.trim(),
      carrier: form.carrier.trim() || undefined,
      activation_date: form.activation_date || undefined,
      plan_details: form.plan_details.trim() || undefined,
      xianyu_member_name: form.xianyu_member_name.trim() || undefined,
      remark: form.remark.trim() || undefined,
    }

    const req = isEdit ? api.updatePhone(id, payload) : api.createPhone(payload)
    req.then(() => {
      wx.showToast({ title: isEdit ? '已保存' : '已创建', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 1000)
    }).catch((err) => {
      wx.showToast({ title: (err && err.detail) || '保存失败', icon: 'none' })
    }).finally(() => this.setData({ submitting: false }))
  },
})

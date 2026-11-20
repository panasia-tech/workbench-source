const auth = require('@services/auth')
const api = require('@services/api')

const CARRIER_OPTIONS = ['中国移动', '中国联通', '中国电信', '中国广电', '其他']
const ACCOUNT_TYPES = ['个人1', '个人2', '企业1', '企业2', '企业3', '企业4', '企业5', '企业6']
const STRATEGIES = [
  { key: 'FACE_SCAN', label: '法人扫脸' },
  { key: 'BAD_REGISTER', label: '不当注册' },
  { key: 'NETWORK_DOWN', label: '断网(续费软路由和话费充值)' },
]

Page({
  data: {
    id: '',
    info: null,             // 自动采集区(只读)
    carrierOptions: CARRIER_OPTIONS,
    carrierIndex: -1,
    typeOptions: ACCOUNT_TYPES,
    typeIndex: -1,
    strategies: STRATEGIES.map((s) => ({ ...s, checked: false })),
    form: {
      member_name: '',
      carrier: '',
      plan_details: '',
      legal_person: '',
      account_type: '',
      remark: '',
    },
    submitting: false,
  },

  onLoad(options) {
    auth.ensureLogin()
    if (!options.id) {
      wx.showToast({ title: '缺少档案 ID', icon: 'none' })
      setTimeout(() => wx.navigateBack(), 800)
      return
    }
    this.setData({ id: options.id })
    this.loadProfile(options.id)
  },

  loadProfile(id) {
    api.getAccountProfile(id).then((res) => {
      const carrierIdx = CARRIER_OPTIONS.indexOf(res.carrier)
      const typeIdx = ACCOUNT_TYPES.indexOf(res.account_type)
      const selected = res.exception_strategies || []
      this.setData({
        info: res,
        carrierIndex: carrierIdx,
        typeIndex: typeIdx,
        strategies: STRATEGIES.map((s) => ({ ...s, checked: selected.includes(s.key) })),
        form: {
          member_name: res.member_name || '',
          carrier: res.carrier || '',
          plan_details: res.plan_details || '',
          legal_person: res.legal_person || '',
          account_type: res.account_type || '',
          remark: res.remark || '',
        },
      })
    }).catch((err) => {
      wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
    })
  },

  onInput(e) {
    const { field } = e.currentTarget.dataset
    this.setData({ [`form.${field}`]: e.detail.value })
  },

  onCarrierChange(e) {
    const idx = Number(e.detail.value)
    this.setData({ carrierIndex: idx, 'form.carrier': CARRIER_OPTIONS[idx] })
  },

  onTypeChange(e) {
    const idx = Number(e.detail.value)
    this.setData({ typeIndex: idx, 'form.account_type': ACCOUNT_TYPES[idx] })
  },

  onStrategyToggle(e) {
    const idx = Number(e.currentTarget.dataset.index)
    this.setData({ [`strategies[${idx}].checked`]: !this.data.strategies[idx].checked })
  },

  onSubmit() {
    const { form, id, strategies } = this.data
    if (!form.carrier) {
      wx.showToast({ title: '请选择运营商', icon: 'none' })
      return
    }
    if (!form.plan_details.trim()) {
      wx.showToast({ title: '请填写套餐资费', icon: 'none' })
      return
    }
    if (!form.legal_person.trim()) {
      wx.showToast({ title: '请填写法人名称', icon: 'none' })
      return
    }
    if (!form.account_type) {
      wx.showToast({ title: '请选择账号种类', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    const payload = {
      member_name: form.member_name.trim() || undefined,
      carrier: form.carrier,
      plan_details: form.plan_details.trim(),
      legal_person: form.legal_person.trim(),
      account_type: form.account_type,
      remark: form.remark.trim() || undefined,
      exception_strategies: strategies.filter((s) => s.checked).map((s) => s.key),
    }
    api.updateAccountProfile(id, payload).then((res) => {
      wx.showToast({
        title: res.status === 'COMPLETE' ? '已完成初始化' : '已保存(仍未完善)',
        icon: res.status === 'COMPLETE' ? 'success' : 'none',
      })
      setTimeout(() => wx.navigateBack(), 1000)
    }).catch((err) => {
      wx.showToast({ title: (err && err.detail) || '保存失败', icon: 'none' })
    }).finally(() => this.setData({ submitting: false }))
  },
})

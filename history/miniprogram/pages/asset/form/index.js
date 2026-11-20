const auth = require('@services/auth')
const api = require('@services/api')
const { scanBarcode } = require('@services/scan')

const STATUS_OPTIONS = [
  { key: 'IDLE', label: '在库' },
  { key: 'IN_USE', label: '使用中' },
  { key: 'SCRAPPED', label: '已报废' },
  { key: 'SOLD', label: '已售出' },
]

Page({
  data: {
    isEdit: false,
    isAdmin: false,
    id: '',
    form: {
      asset_no: '',
      device_name: '',
      device_sn: '',
      device_type: '',
      brand: '',
      model: '',
      spec: '',
      unit_price: '',
      cost: '',
      owner_name: '',
      office_site: '',
      status: 'IDLE',
      purpose: '',
      purchase_date: '',
      remark: '',
      purchase_order_id: '',
      purchase_order_no: '',
      product_images: [],
      image_files: [],
    },
    statusOptions: STATUS_OPTIONS,
    statusIndex: 0,
    // 预览用签名URL(桶私读)，与 form.image_files(存库用 public_url)一一对应
    imageDisplays: [],
    purchaseSearchQ: '',
    purchaseResults: [],
    purchaseSearching: false,
    submitting: false,
  },

  onLoad(options) {
    auth.ensureLogin().then(() => {
      const user = getApp().globalData.user || {}
      const isAdmin = user.role === 'ADMIN'
      // 员工只能登记自己的资产：使用人固定为本人（后端也会强制）
      this.setData({
        isAdmin,
        'form.owner_name': !isAdmin && !this.data.isEdit ? (user.name || user.username || '') : this.data.form.owner_name,
      })
    })
    if (options.id) {
      this.setData({ isEdit: true, id: options.id })
      this.loadDevice(options.id)
    }
  },

  loadDevice(id) {
    api.getAsset(id).then((res) => {
      const idx = STATUS_OPTIONS.findIndex((s) => s.key === res.status)
      this.setData({
        form: {
          asset_no: res.asset_no || '',
          device_name: res.device_name || '',
          device_sn: res.device_sn || '',
          device_type: res.device_type || '',
          brand: res.brand || '',
          model: res.model || '',
          spec: res.spec || '',
          unit_price: res.unit_price != null ? String(res.unit_price) : '',
          cost: res.cost != null ? String(res.cost) : '',
          owner_name: res.owner_name || '',
          office_site: res.office_site || '',
          status: res.status || 'IDLE',
          purpose: res.purpose || '',
          purchase_date: res.purchase_date || '',
          remark: res.remark || '',
          purchase_order_id: res.purchase_order_id || '',
          purchase_order_no: res.purchase_order_no || '',
          product_images: res.product_images || [],
          image_files: res.image_files || [],
        },
        // 详情接口返回的已是签名URL，可直接预览
        imageDisplays: res.image_files || [],
        statusIndex: idx >= 0 ? idx : 0,
      })
    }).catch((err) => {
      wx.showToast({ title: '加载失败', icon: 'none' })
    })
  },

  onInput(e) {
    const { field } = e.currentTarget.dataset
    this.setData({ [`form.${field}`]: e.detail.value })
  },

  onScanAssetNo() {
    scanBarcode({ scanType: ['barCode', 'qrCode'] })
      .then((code) => {
        const cleaned = String(code || '').replace(/\s+/g, '').slice(0, 64)
        if (!cleaned) {
          wx.showToast({ title: '未识别到有效条形码，请重新扫描', icon: 'none' })
          return
        }
        this.setData({ 'form.asset_no': cleaned })
        const params = { asset_no: cleaned }
        if (this.data.isEdit) params.exclude_id = this.data.id
        api.checkAssetNo(params).then((res) => {
          if (!res.exists) {
            wx.showToast({ title: '扫码成功', icon: 'success' })
            return
          }
          wx.showModal({
            title: '该资产编号已存在',
            content: `${res.device_name || '—'}\n使用人：${res.owner_name || '—'}\n状态：${res.status || '—'}\n位置：${res.office_site || '—'}\n更新：${(res.updated_at || '').replace('T', ' ').slice(0, 16)}`,
            showCancel: false,
            confirmText: '知道了',
          })
        }).catch(() => {})
      })
      .catch(() => {})
  },

  onStatusChange(e) {
    const idx = Number(e.detail.value)
    this.setData({
      statusIndex: idx,
      'form.status': STATUS_OPTIONS[idx].key,
    })
  },

  onPurchaseSearchInput(e) {
    const q = e.detail.value
    this.setData({ purchaseSearchQ: q })
    if (!q.trim()) {
      this.setData({ purchaseResults: [] })
      return
    }
    this.setData({ purchaseSearching: true })
    api.listPurchase({ q: q.trim(), size: 10 }).then((res) => {
      this.setData({ purchaseResults: res.items || [], purchaseSearching: false })
    }).catch(() => {
      this.setData({ purchaseSearching: false })
    })
  },

  onSelectPurchase(e) {
    const idx = e.currentTarget.dataset.index
    const po = this.data.purchaseResults[idx]
    if (!po) return
    const updates = {
      'form.purchase_order_id': po.id,
      'form.purchase_order_no': po.order_no,
      purchaseResults: [],
      purchaseSearchQ: '',
    }
    if (!this.data.form.brand) updates['form.brand'] = po.brand || ''
    if (!this.data.form.model) updates['form.model'] = po.model || ''
    if (!this.data.form.spec) updates['form.spec'] = po.spec || ''
    if (!this.data.form.unit_price) updates['form.unit_price'] = po.unit_price != null ? String(po.unit_price) : ''
    if (!this.data.form.product_images.length) updates['form.product_images'] = po.product_images || []
    if (!this.data.form.device_name) updates['form.device_name'] = po.product_name || ''
    this.setData(updates)
  },

  onClearPurchase() {
    this.setData({
      'form.purchase_order_id': '',
      'form.purchase_order_no': '',
    })
  },

  onChooseImage() {
    const existing = this.data.form.image_files
    wx.chooseImage({
      count: 9 - existing.length,
      sizeType: ['compressed'],
      success: (res) => {
        wx.showLoading({ title: '上传中' })
        const tasks = res.tempFilePaths.map((fp) => api.uploadMedia('asset', '', fp))
        Promise.all(tasks).then((results) => {
          const urls = results.map((r) => r.public_url)
          const displays = results.map((r) => r.access_url || r.public_url)
          this.setData({
            'form.image_files': existing.concat(urls),
            imageDisplays: this.data.imageDisplays.concat(displays),
          })
        }).catch(() => {
          wx.showToast({ title: '上传失败', icon: 'none' })
        }).finally(() => wx.hideLoading())
      },
    })
  },

  onRemoveImage(e) {
    const idx = e.currentTarget.dataset.index
    const files = this.data.form.image_files.slice()
    const displays = this.data.imageDisplays.slice()
    files.splice(idx, 1)
    displays.splice(idx, 1)
    this.setData({ 'form.image_files': files, imageDisplays: displays })
  },

  onSubmit() {
    const { form, isEdit, id } = this.data
    if (!form.device_name.trim()) {
      wx.showToast({ title: '请输入设备名称', icon: 'none' })
      return
    }
    this.setData({ submitting: true })
    const payload = {
      device_name: form.device_name.trim(),
      asset_no: form.asset_no.trim() || undefined,
      device_sn: form.device_sn.trim() || undefined,
      device_type: form.device_type.trim() || undefined,
      brand: form.brand.trim() || undefined,
      model: form.model.trim() || undefined,
      spec: form.spec.trim() || undefined,
      unit_price: form.unit_price ? Number(form.unit_price) : undefined,
      cost: form.cost ? Number(form.cost) : 0,
      owner_name: form.owner_name.trim() || undefined,
      office_site: form.office_site.trim() || undefined,
      status: form.status,
      purpose: form.purpose.trim() || undefined,
      purchase_date: form.purchase_date || undefined,
      remark: form.remark.trim() || undefined,
      purchase_order_id: form.purchase_order_id || undefined,
      purchase_order_no: form.purchase_order_no || undefined,
      product_images: form.product_images,
      image_files: form.image_files,
    }

    const req = isEdit ? api.updateAsset(id, payload) : api.createAsset(payload)
    req.then(() => {
      wx.showToast({ title: isEdit ? '已保存' : '已创建', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 1000)
    }).catch((err) => {
      wx.showToast({ title: (err && err.detail) || '保存失败', icon: 'none' })
    }).finally(() => this.setData({ submitting: false }))
  },
})

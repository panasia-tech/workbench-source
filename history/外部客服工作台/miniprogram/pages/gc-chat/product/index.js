const api = require('@services/api')

const FIELD_LABELS = {
  image: '商品主图',
  name: '商品名称/型号',
  price: '价格',
  grade: '成色',
  location: '库位',
  description: '商品描述',
  config: '电脑配置',
  remark: '备注',
}

Page({
  data: {
    loading: true,
    conversationId: '',
    skuCode: '',
    matched: false,
    needMatch: false,
    error: '',
    fallback: { title: '', price: '', image: '' },
    item: null,
    images: [],
    missing: [],
    missingText: '',
    codeText: '',
  },

  onLoad(options) {
    this.setData({
      conversationId: options.conversation_id || '',
      skuCode: options.sku || '',
    })
    this.load()
  },

  load() {
    this.setData({ loading: true, error: '' })
    const convId = this.data.conversationId
    const convPromise = convId
      ? api.gcChatConversation(convId).catch(() => null)
      : Promise.resolve(null)

    convPromise
      .then((conv) => {
        const fallback = {
          title: (conv && conv.item_title) || '',
          price: (conv && conv.item_price) || '',
          image: (conv && conv.item_image) || '',
        }
        const sku = this.data.skuCode || (conv && conv.listing_sku) || ''
        this.setData({ fallback, skuCode: sku })
        if (!sku) {
          this.setData({
            loading: false,
            matched: false,
            needMatch: true,
            error: '这条会话还没匹配到 ERP 商品',
          })
          return
        }
        return api.chatSkuMedia(sku)
          .then((res) => this.apply(res))
          .catch((err) => {
            this.setData({
              loading: false,
              matched: false,
              needMatch: true,
              error: (err && err.detail) || 'ERP 里没查到这件货',
            })
          })
      })
      .catch(() => {
        this.setData({ loading: false, matched: false, needMatch: true, error: '商品资料加载失败' })
      })
  },

  apply(res) {
    const media = (res && res.media) || []
    const images = media.filter((m) => m.type === 'image').map((m) => ({
      url: m.url,
      thumb: m.thumb || m.url,
    }))
    const missing = Array.isArray(res && res.missing) ? res.missing : []
    const name = (res && res.product_name) || ''
    const brand = (res && res.brand) || ''
    const model = (res && res.model) || ''
    const modelLine = model && !name.toLowerCase().includes(model.toLowerCase())
      ? [brand, model].filter(Boolean).join(' ')
      : ''
    const item = {
      skuCode: (res && res.sku_code) || this.data.skuCode,
      name,
      brand,
      model,
      modelLine,
      price: (res && res.price) || this.data.fallback.price || '',
      grade: (res && res.grade) || '',
      state: (res && res.state_label) || '',
      location: (res && res.location_code) || '',
      shortCode: (res && res.short_code) || '',
      description: (res && res.description) || '',
      config: (res && res.config) || '',
      remark: (res && res.remark) || '',
      onSale: !!(res && res.on_sale),
    }
    this.setData({
      loading: false,
      matched: true,
      needMatch: false,
      error: '',
      item,
      images,
      missing,
      missingText: missing.map((k) => FIELD_LABELS[k] || k).join('、'),
      codeText: item.shortCode ? `#${item.shortCode}` : `货号 ${item.skuCode}`,
    })
  },

  previewImage(e) {
    const images = this.data.images || []
    if (!images.length) {
      const fallback = this.data.fallback.image
      if (fallback) wx.previewImage({ urls: [fallback] })
      return
    }
    const index = Number(e.currentTarget.dataset.index) || 0
    wx.previewImage({ urls: images.map((m) => m.url), current: images[index].url })
  },

  previewFallback() {
    if (this.data.fallback.image) wx.previewImage({ urls: [this.data.fallback.image] })
  },

  goMatch() {
    wx.setStorageSync('gcChatMatchPending', { conversationId: this.data.conversationId })
    wx.navigateBack()
  },

  goEdit() {
    if (!this.data.skuCode) return
    wx.navigateTo({ url: `/pages/warehouse/edit/index?code=${encodeURIComponent(this.data.skuCode)}` })
  },
})

const auth = require('@services/auth')
const api = require('@services/api')
const { scanBarcode } = require('@services/scan')

const PHONE_RE = /^1[3-9]\d{9}$/
const ICCID_MAX_LEN = 50
const BLANK_SERIAL_MAX_LEN = 64

let cardSeq = 0
function blankCard() {
  cardSeq += 1
  return { key: `new_${cardSeq}`, id: '', phone: '', iccid: '', blank_serial: '' }
}

Page({
  data: {
    cards: [],
    submitting: false,
    // 部门要用代码仓库（默认技术部）才显示 GitHub 一栏
    needGithub: false,
    github: '',
    githubStatus: '',
    githubSaving: false,
  },

  onShow() {
    auth.ensureLogin().then(() => {
      this.loadCards()
      this.loadGithub()
    })
  },

  loadGithub() {
    api.me()
      .then((res) => {
        const staff = res.staff || {}
        this.setData({
          needGithub: !!(res.need_github || staff.github_account),
          github: staff.github_account || '',
          githubStatus: staff.github_status || '',
        })
      })
      .catch(() => {})
  },

  onGithubInput(e) {
    this.setData({ github: e.detail.value })
  },

  onGithubSave() {
    this.setData({ githubSaving: true })
    api.setMyGithub((this.data.github || '').trim())
      .then((res) => {
        this.setData({ github: res.github_account || '', githubStatus: res.github_status || '' })
        wx.showToast({ title: '已保存', icon: 'success' })
      })
      .catch((err) => wx.showToast({ title: err.detail || '保存失败', icon: 'none' }))
      .finally(() => this.setData({ githubSaving: false }))
  },

  loadCards() {
    api.listSimCards()
      .then((cards) => {
        const list = (cards || []).map((c) => ({
          key: c.id,
          id: c.id,
          phone: c.phone || '',
          iccid: c.iccid || '',
          blank_serial: c.blank_serial || '',
        }))
        // 至少展示一张空卡片，方便直接录入
        this.setData({ cards: list.length ? list : [blankCard()] })
      })
      .catch((err) => {
        wx.showToast({ title: err.detail || '加载失败', icon: 'none' })
      })
  },

  onInput(e) {
    const { idx, key } = e.currentTarget.dataset
    this.setData({ [`cards[${idx}].${key}`]: e.detail.value })
  },

  onScan(e) {
    const { idx } = e.currentTarget.dataset
    scanBarcode({ scanType: ['barCode', 'qrCode'] })
      .then((code) => {
        this.setData({ [`cards[${idx}].blank_serial`]: code.slice(0, BLANK_SERIAL_MAX_LEN) })
      })
      .catch(() => {})
  },

  onAdd() {
    this.setData({ cards: this.data.cards.concat(blankCard()) })
  },

  onRemove(e) {
    const { idx } = e.currentTarget.dataset
    const card = this.data.cards[idx]
    const drop = () => {
      const cards = this.data.cards.slice()
      cards.splice(idx, 1)
      this.setData({ cards: cards.length ? cards : [blankCard()] })
    }
    // 未保存的空白卡片直接移除；已存在的走后端删除
    if (!card.id) {
      drop()
      return
    }
    wx.showModal({
      title: '删除卡片',
      content: '确定删除这张卡片吗？',
      success: (res) => {
        if (!res.confirm) return
        api.deleteSimCard(card.id)
          .then(() => {
            drop()
            wx.showToast({ title: '已删除', icon: 'success' })
          })
          .catch((err) => wx.showToast({ title: err.detail || '删除失败', icon: 'none' }))
      },
    })
  },

  // 校验单张卡片，返回归一化 payload；不合法抛出提示文案，全空返回 null
  _validateCard(card, order) {
    const phone = (card.phone || '').trim()
    const iccid = (card.iccid || '').trim()
    const blank = (card.blank_serial || '').trim()
    if (!phone && !iccid && !blank) {
      // 全空：已保存的需报错，新建的忽略
      if (card.id) throw new Error(`卡片 ${order} 至少填写一项`)
      return null
    }
    if (phone && !PHONE_RE.test(phone)) throw new Error(`卡片 ${order} 手机号格式不正确`)
    if (iccid.length > ICCID_MAX_LEN) throw new Error(`卡片 ${order} ICCID 不能超过 ${ICCID_MAX_LEN} 位`)
    if (blank.length > BLANK_SERIAL_MAX_LEN) throw new Error(`卡片 ${order} 空卡序列号不能超过 ${BLANK_SERIAL_MAX_LEN} 位`)
    return { phone, iccid, blank_serial: blank }
  },

  onSubmit() {
    let ops
    try {
      ops = this.data.cards
        .map((card, i) => {
          const payload = this._validateCard(card, i + 1)
          if (!payload) return null
          return card.id ? api.updateSimCard(card.id, payload) : api.createSimCard(payload)
        })
        .filter(Boolean)
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' })
      return
    }

    if (!ops.length) {
      wx.showToast({ title: '请至少填写一张卡片', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    Promise.all(ops)
      .then(() => {
        wx.showToast({ title: '已保存', icon: 'success' })
        this.loadCards()
        setTimeout(() => wx.navigateBack(), 800)
      })
      .catch((err) => {
        wx.showToast({ title: err.detail || '保存失败', icon: 'none' })
        this.loadCards()
      })
      .finally(() => this.setData({ submitting: false }))
  },
})

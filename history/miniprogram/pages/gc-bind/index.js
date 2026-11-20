const api = require('@services/api')

// 自动绑定后此页是「对账看板」:每个店铺是否有一台在线、就绪、且登录了正确闲鱼的设备。
// match(后端算) = 在线 && 就绪 && 设备当前登录闲鱼 == 期望闲鱼。其余按失败原因给可读标签。
// device_kind = browser 时提示语带「浏览器」前缀,区分 AdsPower 环境与真机。
function shopStatus(s) {
  const dev = `${s.device_kind === 'browser' ? '浏览器·' : ''}${s.device_name || '设备'}`
  if (!s.nick) {
    return { key: 'no_nick', label: '未配置账号', tag: 'tag-pending', hint: '店铺未填闲鱼账号名' }
  }
  if (s.match) {
    return {
      key: 'ready',
      label: '就绪',
      tag: 'tag-success',
      hint: `${dev} · 已登录 ${s.reported_nick}`,
    }
  }
  if (!s.bound) {
    return { key: 'unbound', label: '未绑定', tag: 'tag-danger', hint: '暂无设备登录此闲鱼;开机自检会自动绑定,或手动指定' }
  }
  if (!s.device_online) {
    return { key: 'offline', label: '设备离线', tag: 'tag-pending', hint: `${dev} 当前不在线` }
  }
  if (s.reported_nick && s.reported_nick !== s.expected_nick) {
    return { key: 'mismatch', label: '串号', tag: 'tag-danger', hint: `设备当前登录「${s.reported_nick}」,与期望不符` }
  }
  if (!s.ready) {
    return { key: 'not_ready', label: '未就绪', tag: 'tag-warning', hint: '设备在线但权限/闲鱼未就绪(见群控端自检)' }
  }
  return { key: 'no_login', label: '未登录', tag: 'tag-warning', hint: '设备在线但未读到已登录的闲鱼账号' }
}

function summarize(shops) {
  const list = (shops || []).map((s) => ({ ...s, _st: shopStatus(s) }))
  return {
    shops: list,
    total: list.length,
    readyCount: list.filter((s) => s._st.key === 'ready').length,
    issueCount: list.filter((s) => s.nick && s._st.key !== 'ready').length,
  }
}

Page({
  data: {
    loading: true,
    error: '',
    shops: [],
    total: 0,
    readyCount: 0,
    issueCount: 0,
    // 手动指定设备的 bottom-sheet(兜底:自动读不到闲鱼 / 要强制纠正时)
    sheetVisible: false,
    activeNick: '',
    activeLabel: '',
    activeDeviceId: '',
    devices: [],
    devLoading: false,
    binding: false,
  },

  onLoad() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  load() {
    this.setData({ loading: true, error: '' })
    return api
      .gcBindShops()
      .then((shops) => {
        this.setData({ ...summarize(shops), loading: false })
      })
      .catch((err) => {
        this.setData({
          loading: false,
          error: err.detail || '加载失败，请确认群控服务是否已连接',
          shops: [],
          total: 0,
          readyCount: 0,
          issueCount: 0,
        })
      })
  },

  openSheet(e) {
    const { nick, label, deviceId } = e.currentTarget.dataset
    if (!nick) {
      wx.showToast({ title: '该店铺未配置闲鱼账号', icon: 'none' })
      return
    }
    this.setData({
      sheetVisible: true,
      activeNick: nick,
      activeLabel: label,
      activeDeviceId: deviceId || '',
      devices: [],
      devLoading: true,
    })
    api
      .gcBindDevices()
      .then((devices) => {
        this.setData({ devices: devices || [], devLoading: false })
      })
      .catch((err) => {
        this.setData({ devLoading: false })
        wx.showToast({ title: err.detail || '设备列表加载失败', icon: 'none' })
      })
  },

  closeSheet() {
    if (this.data.binding) return
    this.setData({ sheetVisible: false })
  },

  noop() {},

  pickDevice(e) {
    const id = e.currentTarget.dataset.id
    if (!id || this.data.binding) return
    if (id === this.data.activeDeviceId) {
      this.setData({ sheetVisible: false })
      return
    }
    this._bind(id)
  },

  unbind() {
    if (this.data.binding || !this.data.activeDeviceId) return
    this._bind(null)
  },

  _bind(deviceId) {
    this.setData({ binding: true })
    api
      .gcBind({ nick: this.data.activeNick, device_id: deviceId })
      .then((r) => {
        wx.showToast({ title: r && r.bound ? '已指定设备' : '已解绑' })
        this.setData({ sheetVisible: false })
        return this.load()
      })
      .catch((err) => {
        wx.showToast({ title: err.detail || '操作失败', icon: 'none' })
      })
      .finally(() => {
        this.setData({ binding: false })
      })
  },
})

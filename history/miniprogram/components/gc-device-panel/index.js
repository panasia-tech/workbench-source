const auth = require('@services/auth')
const api = require('@services/api')

// 群控设备看板(群控中心内嵌面板):状态点 + 登录闲鱼 + 就绪/阻塞。操作(自检/重启/停用)仅 ADMIN。
// kind: android(手机)/browser(AdsPower 浏览器环境);浏览器设备无 brand/model/serial,副标题改显示「浏览器环境」。
function decorate(d) {
  const status = d.status || 'OFFLINE'
  const dotClass = status === 'ONLINE' ? 'gc-dot--on' : status === 'DISABLED' ? 'gc-dot--err' : 'gc-dot--off'
  const statusLabel = status === 'ONLINE' ? '在线' : status === 'DISABLED' ? '已停用' : '离线'
  let readyLabel = '未就绪'
  let readyTag = 'tag-warning'
  if (d.blocking) {
    readyLabel = '阻塞'
    readyTag = 'tag-danger'
  } else if (d.last_ready) {
    readyLabel = '就绪'
    readyTag = 'tag-success'
  }
  const kind = d.kind === 'browser' ? 'browser' : 'android'
  return {
    ...d,
    kind,
    _dot: dotClass,
    _statusLabel: statusLabel,
    _readyLabel: readyLabel,
    _readyTag: readyTag,
    _kindLabel: kind === 'browser' ? '浏览器' : '手机',
    _sub: kind === 'browser'
      ? '浏览器环境 · AdsPower'
      : `${d.brand || ''} ${d.model || ''} · ${d.serial || '—'}`,
    _nick: d.reported_nick || '未识别',
  }
}

Component({
  options: {
    addGlobalClass: true,
  },

  data: {
    loading: true,
    error: '',
    devices: [],
    filtered: [],
    kindFilter: 'all', // all / android / browser
    total: 0,
    onlineCount: 0,
    androidCount: 0,
    browserCount: 0,
    isAdmin: false,
  },

  lifetimes: {
    attached() {
      auth.ensureLogin().then(() => {
        const user = getApp().globalData.user
        this.setData({ isAdmin: !!(user && user.role === 'ADMIN') })
        this.load()
      })
    },
  },

  methods: {
    _applyFilter(list, kindFilter) {
      const filtered = kindFilter === 'all' ? list : list.filter((d) => d.kind === kindFilter)
      return {
        devices: list,
        filtered,
        total: list.length,
        onlineCount: list.filter((d) => d.status === 'ONLINE').length,
        androidCount: list.filter((d) => d.kind === 'android').length,
        browserCount: list.filter((d) => d.kind === 'browser').length,
      }
    },

    setKindFilter(e) {
      const k = e.currentTarget.dataset.kind || 'all'
      this.setData({ kindFilter: k, ...this._applyFilter(this.data.devices, k) })
    },

    load() {
      this.setData({ loading: true, error: '' })
      return api
        .gcOpsDevices()
        .then((devices) => {
          const list = (devices || []).map(decorate)
          this.setData({
            ...this._applyFilter(list, this.data.kindFilter),
            loading: false,
          })
        })
        .catch((err) => {
          this.setData({
            loading: false,
            error: err.detail || '加载失败，请确认群控服务是否已连接',
            devices: [],
            filtered: [],
            total: 0,
            onlineCount: 0,
            androidCount: 0,
            browserCount: 0,
          })
        })
    },

    // 点一行:看这个号发过的商品(#101)。没绑号的设备不跳。
    openAccount(e) {
      const device = this.data.devices.find((d) => String(d.id) === String(e.currentTarget.dataset.id))
      if (!device || !device.account_id) return
      const nick = encodeURIComponent(device.account_nick || device.reported_nick || '')
      wx.navigateTo({ url: `/pages/listing/account-items/index?account_id=${device.account_id}&nick=${nick}` })
    },

    openActions(e) {
      const id = e.currentTarget.dataset.id
      const device = this.data.devices.find((d) => String(d.id) === String(id))
      if (!device) return
      const disabled = device.status === 'DISABLED'
      const items = ['自检', '重启引擎', disabled ? '启用' : '停用']
      wx.showActionSheet({
        itemList: items,
        success: (res) => {
          const action = items[res.tapIndex]
          wx.showModal({
            title: '确认操作',
            content: `确定对「${device.name}」执行「${action}」吗？`,
            success: (r) => {
              if (!r.confirm) return
              this._act(device, action)
            },
          })
        },
      })
    },

    _act(device, action) {
      const id = device.id
      let p
      if (action === '自检') {
        p = api.gcOpsDeviceSelfCheck(id)
      } else if (action === '重启引擎') {
        p = api.gcOpsDeviceRestart(id)
      } else {
        p = api.gcOpsDeviceToggle(id, action === '停用' ? 'DISABLED' : 'ONLINE')
      }
      p.then(() => {
        wx.showToast({ title: `${action}已下发` })
        return this.load()
      }).catch((err) => {
        wx.showToast({ title: err.detail || '操作失败', icon: 'none' })
      })
    },
  },
})

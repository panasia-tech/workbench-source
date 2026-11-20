const auth = require('@services/auth')
const api = require('@services/api')
const { friendlyText, friendlyStep } = require('@utils/errmsg')

const PAGE_SIZE = 20

// 顶部分类:当前任务(进行中+待开始) / 历史任务(已完结)
const SECTION_TABS = [
  { key: 'current', label: '当前任务' },
  { key: 'history', label: '历史任务' },
]

// 当前任务/历史任务的状态集合(gc 侧 status 支持逗号多值 IN 过滤)
const CURRENT_STATUSES = 'RUNNING,DISPATCHED,PENDING'
const HISTORY_STATUSES = 'SUCCESS,FAILED,TIMEOUT,CANCELLED'

const STATUS_LABEL = {
  PENDING: '待开始',
  DISPATCHED: '已派发',
  RUNNING: '进行中',
  SUCCESS: '成功',
  FAILED: '失败',
  TIMEOUT: '超时',
  CANCELLED: '已取消',
}

const STATUS_TAG = {
  PENDING: 'tag-pending',
  DISPATCHED: 'tag-info',
  RUNNING: 'tag-info',
  SUCCESS: 'tag-success',
  FAILED: 'tag-danger',
  TIMEOUT: 'tag-danger',
  CANCELLED: 'tag-pending',
}

// 相对创建时间:刚刚 / n分钟前 / n小时前 / n天前(超过7天落回日期)
// gc 返回的是 UTC 朴素时间串(无时区标记),解析时必须按 UTC,否则会差出 8 小时
function relTime(iso) {
  if (!iso) return ''
  const text = String(iso).replace('T', ' ')
  let norm = text.replace(' ', 'T')
  if (norm.indexOf('Z') < 0 && norm.indexOf('+') < 0) norm += 'Z'
  const ts = new Date(norm).getTime()
  if (isNaN(ts)) return text.slice(0, 19)
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
  if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)}天前`
  return text.slice(0, 10)
}

function decorate(t) {
  return {
    ...t,
    _statusLabel: STATUS_LABEL[t.status] || t.status || '—',
    _statusTag: STATUS_TAG[t.status] || 'tag-pending',
    _time: relTime(t.created_at),
  }
}

function byCreatedDesc(a, b) {
  return String(b.created_at || '').localeCompare(String(a.created_at || ''))
}

// 群控任务队列(群控中心内嵌面板);父页面下拉刷新调 reload(),触底调 loadMore()
Component({
  options: {
    addGlobalClass: true,
  },

  data: {
    sectionTabs: SECTION_TABS,
    section: 'current',
    // 当前任务:数量少,一次拉全不分页
    currentList: [],
    currentLoading: false,
    currentLoaded: false,
    // 历史任务:按创建时间倒序分页(后端不支持多状态过滤,拉全量页后客户端剔除未完结)
    historyList: [],
    historyPage: 1,
    historyLoading: false,
    historyNoMore: false,
    historyLoaded: false,
    isAdmin: false,
  },

  lifetimes: {
    attached() {
      auth.ensureLogin().then(() => {
        const user = getApp().globalData.user
        this.setData({ isAdmin: !!(user && user.role === 'ADMIN') })
        this.reload()
      })
    },
  },

  methods: {
    onTabChange(e) {
      const section = e.currentTarget.dataset.section
      if (!section || section === this.data.section) return
      this.setData({ section })
      // 懒加载:首次切到才拉取
      if (section === 'current' && !this.data.currentLoaded) this.loadCurrent()
      if (section === 'history' && !this.data.historyLoaded) this.reloadHistory()
    },

    // 刷新当前分类(父页面下拉用)
    reload() {
      return this.data.section === 'history' ? this.reloadHistory() : this.loadCurrent()
    },

    // 触底加载更多(仅历史任务分页)
    loadMore() {
      if (this.data.section !== 'history') return Promise.resolve()
      return this.loadMoreHistory()
    },

    loadCurrent() {
      if (this.data.currentLoading) return Promise.resolve()
      this.setData({ currentLoading: true })
      // 一次拉全当前任务(数量少不分页),客户端分组:进行中(RUNNING/DISPATCHED)在上,待开始(PENDING)在下,组内时间倒序
      return api.gcOpsTasks({ status: CURRENT_STATUSES, page: 1, page_size: 100 })
        .then((res) => {
          const items = res.items || []
          const running = items.filter((t) => t.status === 'RUNNING' || t.status === 'DISPATCHED')
          const pending = items.filter((t) => t.status === 'PENDING')
          const list = running.sort(byCreatedDesc).concat(pending.sort(byCreatedDesc)).map(decorate)
          this.setData({ currentList: list, currentLoading: false, currentLoaded: true })
        })
        .catch((err) => {
          this.setData({ currentLoading: false })
          wx.showToast({ title: err.detail || '加载失败', icon: 'none' })
        })
    },

    reloadHistory() {
      this.setData({ historyPage: 1, historyList: [], historyNoMore: false })
      return this.loadMoreHistory().then(() => this.setData({ historyLoaded: true }))
    },

    loadMoreHistory() {
      if (this.data.historyLoading || this.data.historyNoMore) return Promise.resolve()
      this.setData({ historyLoading: true })
      const page = this.data.historyPage
      return api.gcOpsTasks({ status: HISTORY_STATUSES, page, page_size: PAGE_SIZE }).then((res) => {
        const items = (res.items || []).map(decorate)
        const merged = page === 1 ? items : this.data.historyList.concat(items)
        const noMore = (res.items || []).length < PAGE_SIZE || merged.length >= (res.total || 0)
        this.setData({
          historyList: merged,
          historyPage: page + 1,
          historyNoMore: noMore,
          historyLoading: false,
        })
      }).catch((err) => {
        this.setData({ historyLoading: false })
        wx.showToast({ title: err.detail || '加载失败', icon: 'none' })
      })
    },

    openDetail(e) {
      const id = e.currentTarget.dataset.id
      const item = this.data.currentList.concat(this.data.historyList)
        .find((t) => String(t.id) === String(id))
      if (!item) return
      const lines = [
        `类型：${item.task_type || '—'}`,
        `设备：${item.device_name || '—'}`,
        `账号：${item.account_nick || '—'}`,
        `状态：${item._statusLabel}`,
      ]
      if (item.failed_step) lines.push(`失败环节：${friendlyStep(item.failed_step)}`)
      if (item.error) lines.push(`原因：${friendlyText(item.error)}`)
      if (item.progress !== undefined && item.progress !== null) lines.push(`进度：${item.progress}`)
      wx.showModal({
        title: '任务详情',
        content: lines.join('\n'),
        showCancel: false,
      })
    },

    retryTask(e) {
      const id = e.currentTarget.dataset.id
      wx.showModal({
        title: '重发任务',
        content: '确定重发该失败任务吗？',
        success: (r) => {
          if (!r.confirm) return
          api.gcOpsTaskRetry(id).then(() => {
            wx.showToast({ title: '已重发' })
            // 重发后任务回到待开始:当前/历史两个分类都刷新
            this.loadCurrent()
            if (this.data.historyLoaded) this.reloadHistory()
          }).catch((err) => {
            wx.showToast({ title: err.detail || '重发失败', icon: 'none' })
          })
        },
      })
    },
  },
})

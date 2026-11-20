const auth = require('@services/auth')
const api = require('@services/api')

const PERIODS = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'pick', label: '任意月' },
]

function cnNow() {
  const now = new Date()
  const utc = now.getTime() + now.getTimezoneOffset() * 60000
  return new Date(utc + 8 * 3600000)
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function fmtDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// 返回预设周期对应的 [date_from, date_to]（中国日历，含首尾）
function rangeForPeriod(key, pickMonth) {
  const today = cnNow()
  const todayStr = fmtDate(today)
  if (key === 'today') return [todayStr, todayStr]
  if (key === 'yesterday') {
    const y = cnNow()
    y.setDate(y.getDate() - 1)
    const s = fmtDate(y)
    return [s, s]
  }
  if (key === 'week') {
    const d = cnNow()
    const dow = d.getDay() === 0 ? 7 : d.getDay() // 周一为一周起点
    d.setDate(d.getDate() - (dow - 1))
    return [fmtDate(d), todayStr]
  }
  if (key === 'month') {
    const d = cnNow()
    d.setDate(1)
    return [fmtDate(d), todayStr]
  }
  // pick：任意月，pickMonth = 'YYYY-MM'
  const pm = pickMonth || todayStr.slice(0, 7)
  const [yy, mm] = pm.split('-').map(Number)
  const lastDay = new Date(yy, mm, 0).getDate() // mm 为 1..12，第 0 天即上月末→该月末
  return [`${pm}-01`, `${pm}-${pad(lastDay)}`]
}

Page({
  data: {
    periods: PERIODS,
    period: 'today',
    pickMonth: '',
    dateFrom: '',
    dateTo: '',
    loading: false,
    payslip: null,
  },

  onLoad() {
    const now = cnNow()
    this.setData({ pickMonth: `${now.getFullYear()}-${pad(now.getMonth() + 1)}` })
  },

  onShow() {
    auth.ensureLogin().then(() => this.applyPeriod(this.data.period))
  },

  onPullDownRefresh() {
    this.load().finally(() => wx.stopPullDownRefresh())
  },

  pickPeriod(e) {
    const period = e.currentTarget.dataset.period
    if (period === this.data.period && period !== 'pick') return
    this.setData({ period })
    this.applyPeriod(period)
  },

  onMonthChange(e) {
    this.setData({ pickMonth: e.detail.value, period: 'pick' }, () => this.applyPeriod('pick'))
  },

  applyPeriod(period) {
    const [dateFrom, dateTo] = rangeForPeriod(period, this.data.pickMonth)
    this.setData({ dateFrom, dateTo })
    this.load()
  },

  load() {
    const { dateFrom, dateTo } = this.data
    this.setData({ loading: true })
    return api.dashboardPayslip({ date_from: dateFrom, date_to: dateTo })
      .then((res) => this.setData({ payslip: res || null, loading: false }))
      .catch((err) => {
        this.setData({ loading: false })
        wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
      })
  },
})

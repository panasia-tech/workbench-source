const api = require('@services/api')

const listingAutosave = require('@services/listing-autosave')
const platform = require('@utils/platform')

// 价格区的成色页签：「7新及以下」把 7 新和 6 新及以下合在一起（同设计图）
const PRICE_TABS = [
  { key: 'all', label: '全部', match: null },
  { key: 'new', label: '全新', match: ['new'] },
  { key: '9', label: '9成', match: ['9'] },
  { key: '8', label: '8成', match: ['8'] },
  { key: '7', label: '7成及以下', match: ['7', '6'] },
]
const RECORDS_FOLDED = 8

// 近期记录图文列表的一行：闲鱼在售有标题/挂牌价，我们卖出的有自家实拍、发布价和成交价
function recordView(r) {
  const sold = r.status === '成交'
  const day = (r.date || '').slice(5)
  const grade = r.grade || '成色未标'
  const publish = r.list_price != null ? `发布 ¥${money(r.list_price)}` : ''
  return {
    _title: r.title || (sold ? '同款' : '闲鱼在售'),
    _grade: grade,
    _channel: r.channel || '',
    _status: sold ? '成交' : '在售',
    _publish: publish,
    _sub: [grade, publish].filter(Boolean).join(' · '),
    _when: `${day} ${r.channel || (sold ? '我们卖出' : '闲鱼在售')}`,
    _priceLabel: sold ? '成交价' : '在售价',
    _price: money(r.price),
    _sold: sold,
    _imgError: false,
  }
}

// 闲鱼记录里的 url 是 fleamarket:// 深链；浏览器/小程序统一转成可打开的网页地址。
// 商品 ID 是所有入口（主图、曲线、记录、跳转）的关联键，缺了 ID 就不能保证落到具体商品页。
function xianyuItemId(r) {
  if (!r) return ''
  const direct = String(r.item_id || '')
  if (/^\d+$/.test(direct)) return direct
  const m = String(r.web_url || r.url || '').match(/[?&]id=(\d+)/)
  return m ? m[1] : ''
}

function xianyuWebUrl(r) {
  if (!r) return ''
  const raw = String(r.web_url || r.url || '')
  if (/^https?:\/\//i.test(raw)) return raw
  const id = xianyuItemId(r)
  return id ? `https://www.goofish.com/item?id=${id}` : ''
}

// 闲鱼官方唤端 scheme：fleamarket://item?id=<商品ID>。只在手机浏览器试，
// 微信内置浏览器会拦自定义 scheme，唤不起来就走网页商品页兜底。
function xianyuAppUrl(r) {
  const id = xianyuItemId(r)
  return id ? `fleamarket://item?id=${id}` : ''
}

function isMobileH5() {
  if (!platform.isH5()) return false
  try {
    return /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(window.navigator.userAgent || '')
  } catch (e) {
    return false
  }
}

// 当前页签的折线统计：最新/30日均价/历史高低，跟着筛选一起变
function seriesStats(series) {
  const pts = (series || []).filter((p) => p && p.date && Number(p.price) > 0)
  if (!pts.length) return {}
  const last = pts[pts.length - 1]
  const lastMs = dayMs(last.date)
  const window30 = pts.filter((p) => dayMs(p.date) >= lastMs - 29 * 86400000)
  const prev30 = pts.filter((p) => dayMs(p.date) >= lastMs - 59 * 86400000 && dayMs(p.date) < lastMs - 29 * 86400000)
  const avgOf = (arr) => (arr.length ? avg(arr.map((p) => Number(p.price))) : null)
  const avg30 = avgOf(window30)
  const prevAvg = avgOf(prev30)
  const latestChange = prevAvg ? (Number(last.price) - prevAvg) / prevAvg * 100 : null
  const high = pts.reduce((a, b) => (Number(b.price) > Number(a.price) ? b : a), pts[0])
  const low = pts.reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a), pts[0])
  return {
    latest: money(last.price),
    latestDate: last.date,
    latestChange: latestChange == null ? '' : change(latestChange).text,
    latestUp: latestChange != null && latestChange > 0,
    avg30: avg30 == null ? '' : money(Math.round(avg30)),
    avgChange: avg30 != null && prevAvg ? change((avg30 - prevAvg) / prevAvg * 100).text : '',
    avgUp: avg30 != null && prevAvg ? avg30 > prevAvg : false,
    high: money(high.price),
    low: money(low.price),
    highDate: high.date,
    lowDate: low.date,
    points: pts.length,
  }
}

function buildInsight(summary, sentiment, tabLabel) {
  if (!summary) return '这段时间同款行情样本还不足，等采集到更多价格后再看趋势。'
  const trend = summary.change_pct == null
    ? '前7日样本不足，暂不能判断涨跌'
    : `较前7日${summary.change_pct > 0 ? '上涨' : summary.change_pct < 0 ? '下跌' : '持平'} ${Math.abs(summary.change_pct)}%`
  const mood = sentiment && sentiment.up_pct != null
    ? (sentiment.up_pct >= sentiment.down_pct
      ? `日价格看涨天数占 ${sentiment.up_pct}%。`
      : `日价格看跌天数占 ${sentiment.down_pct}%。`)
    : ''
  return `近7日${tabLabel}行情均价 ¥${money(summary.avg7)}，${trend}；近期参考区间 ¥${money(summary.band.low)}–¥${money(summary.band.high)}，共 ${summary.listings} 条记录。${mood}`
}

function money(v) {
  if (v == null || v === '') return ''
  const n = Number(v)
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function dayMs(iso) {
  const p = String(iso).split('-').map(Number)
  return Date.UTC(p[0], (p[1] || 1) - 1, p[2] || 1)
}

// 涨跌幅：两位数以上取整，免得把小卡片撑破（「↑74%」而不是「↑ 74.4%」）
function change(pct) {
  if (pct == null) return { text: '', up: false }
  const n = Math.abs(pct)
  return { text: `${pct > 0 ? '↑' : pct < 0 ? '↓' : ''}${n >= 10 ? Math.round(n) : n}%`, up: pct > 0 }
}

function avg(list) {
  return list.length ? list.reduce((n, x) => n + x, 0) / list.length : 0
}

// 库龄条上三条线的位置，和 wxml 里的 left 对齐。线的刻度不等距，所以分段换算
const AGE_BAR_MARKS = [22, 50, 72]

function ageBarPct(a) {
  const stops = [[0, 0], [a.target_days, AGE_BAR_MARKS[0]], [a.clearance_days, AGE_BAR_MARKS[1]], [a.max_days, AGE_BAR_MARKS[2]], [a.max_days * 2, 100]]
  const hi = stops.findIndex((s) => a.days <= s[0])
  if (hi <= 0) return hi === 0 ? 0 : 100
  const [d0, p0] = stops[hi - 1]
  const [d1, p1] = stops[hi]
  return Math.round(p0 + ((a.days - d0) / (d1 - d0)) * (p1 - p0))
}

function ageView(a) {
  const view = { ...a, barPct: ageBarPct(a) }
  if (a.stage === 'normal') {
    return { ...view, goalText: '距离清仓启动还有', goalDays: a.clearance_days - a.days, goalEnd: a.clearance_days, goalPct: Math.round((a.days / a.clearance_days) * 100) }
  }
  if (a.stage === 'clearance') {
    return { ...view, goalText: '距离滞销还有', goalDays: a.max_days - a.days, goalEnd: a.max_days, goalPct: Math.round((a.days / a.max_days) * 100) }
  }
  return { ...view, goalText: '已超过最长库龄', goalDays: a.days - a.max_days, goalEnd: a.max_days, goalPct: 100 }
}

function dayText(n) {
  return n === 0 ? '今天' : `还有 ${n} 天`
}

function shiftDay(days) {
  const d = new Date(Date.now() + 8 * 3600 * 1000 + days * 86400 * 1000)
  return d.toISOString().slice(0, 10)
}

function autoView(a) {
  let nextText = '—'
  let nextHint = '没有在架链接'
  if (a.paused) nextHint = '这件货已暂停'
  else if (!a.ledger_ok) nextHint = '群控暂时查不到'
  else if (!a.enabled) nextHint = '定时上架总开关没开'
  else if (a.next_at) {
    nextText = a.next_at
    nextHint = a.next_in_days === 0 ? '今天轮到' : `距下次还有 ${a.next_in_days} 天`
  }
  return {
    ...a,
    nextText,
    nextHint,
    lastHint: a.last_ago_days == null ? '—' : (a.last_ago_days === 0 ? '今天上架' : `已上架 ${a.last_ago_days} 天`),
    pickerStart: shiftDay(1),
    pickerEnd: shiftDay(90),
    pickerValue: a.not_before || (a.next_at ? a.next_at.slice(0, 10) : shiftDay(1)),
  }
}

// 折叠卡：在架号用的图（去重），没有在架的号就看公用那组；最多 5 格，最后一格盖「+N」
const LIM_CELLS = 5

function limCardView(res) {
  if (!res) return null
  const live = (res.accounts || []).filter((a) => a.publish_status === 'LISTED' || a.publish_status === 'LISTING')
  const seen = {}
  const thumbs = []
  ;(live.length ? live.reduce((all, a) => all.concat(a.images), []) : res.common || []).forEach((img) => {
    if (seen[img.url]) return
    seen[img.url] = true
    thumbs.push(img.thumb || img.url)
  })
  const count = thumbs.length
  return {
    thumbs: thumbs.slice(0, LIM_CELLS),
    more: count > LIM_CELLS ? count - LIM_CELLS + 1 : 0,
    meta: live.length ? `共 ${count} 张 · ${live.length} 个账号在架` : (count ? `共 ${count} 张 · 还没上架` : '去看看'),
  }
}

function buildGallery(detail) {
  const urls = []
  if (detail.cover_url) urls.push(detail.cover_url)
  const images = detail.images || []
  images.forEach((url) => {
    if (url && urls.indexOf(url) < 0) urls.push(url)
  })
  return urls
}

Page({
  data: {
    detail: null,
    listing: null,
    shops: [],
    listedCount: 0,
    galleryUrls: [],
    coverError: false,
    canEditSku: true,
    barcodeLoading: false,
    spuText: '',
    price: null,
    priceLoading: false,
    priceError: '',
    priceTabs: PRICE_TABS.map(({ key, label }) => ({ key, label })),
    priceTab: 'all',
    priceSeries: [],
    priceBand: null,
    priceChartNote: '',
    priceTabNote: '',
    priceStats: {},
    priceSummary: null,
    priceSentiment: null,
    priceInsight: '',
    priceItem: null,
    priceItemUrl: '',
    priceRecords: [],
    priceRecordsAll: [],
    recordsFoldLimit: RECORDS_FOLDED,
    age: null,
    auto: null,
    limCard: null,
    delistedCount: 0,
    canManageListing: false,
    isAdmin: false,
    autoSaving: false,
    refreshing: false,
    syncing: false,
    ageSheet: false,
    ageFields: [
      { key: 'target_days', label: '目标周转' },
      { key: 'clearance_days', label: '清仓启动' },
      { key: 'max_days', label: '最长库龄' },
    ],
    ageForm: {},
  },

  onLoad(options) {
    this.code = options.code || ''
    const role = getApp().globalData.user?.role
    this.setData({
      canEditSku: role !== 'SALES',
      canManageListing: ['WAREHOUSE', 'SALES', 'ADMIN'].indexOf(role) >= 0,
      isAdmin: role === 'ADMIN',
    })
  },

  onShow() {
    this.loadDetail()
    if (!this.data.price && !this.data.priceLoading) this.loadPrice()
  },

  // ------------------------------------------------------------ 价格历史 / 行情价
  loadPrice() {
    const code = this.code
    if (!code) return
    this.setData({ priceLoading: true, priceError: '' })
    api.skuPriceHistory(code)
      .then((res) => {
        const records = (res && res.records) || []
        const item = (res && res.item)
          || records.find((r) => r.status === '在售' && xianyuWebUrl(r))
          || null
        this.setData({
          price: res,
          priceLoading: false,
          priceItem: item,
          priceItemUrl: xianyuWebUrl(item),
        })
        this._applyPriceTab(this.data.priceTab)
      })
      .catch((err) => {
        this.setData({
          priceLoading: false,
          price: null,
          priceError: (err && err.detail) || '行情没加载出来',
          priceSummary: null,
          priceSentiment: null,
          priceInsight: '',
          priceSeries: [],
          priceBand: null,
          priceItem: null,
          priceItemUrl: '',
        })
      })
  },

  switchPriceTab(e) {
    this._applyPriceTab(e.currentTarget.dataset.key)
  },

  // 页签的曲线、统计、看涨/看跌和记录一起切；曲线优先用 by_grade，老接口回退到 series
  _applyPriceTab(key, showAll) {
    const res = this.data.price
    if (!res) return
    const tab = PRICE_TABS.find((t) => t.key === key) || PRICE_TABS[0]
    const gradeData = (res.by_grade && res.by_grade[tab.key]) || {}
    const series = (gradeData.series || (tab.key === 'all' ? res.series || [] : []))
      .filter((p) => p && p.date && Number(p.price) > 0)
      .slice()
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    const summary = gradeData.summary || null
    const sentiment = gradeData.sentiment || (tab.key === 'all' ? res.sentiment : null)
    const band = summary && summary.band && summary.band.low != null && summary.band.high != null
      ? { low: Number(summary.band.low), high: Number(summary.band.high) }
      : null
    const failed = this._imgFailed || {}
    const all = (res.records || [])
      .filter((r) => !tab.match || tab.match.indexOf(r.grade_key) >= 0)
      .map((r, i) => {
        const view = recordView(r)
        return { ...r, _k: `${r.date}-${r.status}-${i}`, ...view, _imgError: !!(view.image && failed[view.image]) }
      })
    const points = series.length
    let note = ''
    if (tab.match) {
      const listed = all.filter((r) => r.status === '在售').map((r) => r.price)
      const sold = all.filter((r) => r.status === '成交').map((r) => r.price)
      const parts = []
      if (listed.length) parts.push(`闲鱼在售 ${listed.length} 条，均价 ¥${money(avg(listed))}`)
      if (sold.length) parts.push(`我们成交 ${sold.length} 单，均价 ¥${money(avg(sold))}`)
      note = `${tab.label}：${parts.join('；') || '暂无记录'}（曲线是行情，不分成色）`
    }
    const chartNote = points
      ? (points < 2 ? `这段时间只有 ${points} 个价格点，攒够 2 个才能画出走势` : '')
      : (res.market_name ? '这款还没抓到行情' : '这款还没进行情监控清单')
    this.setData({
      priceTab: tab.key,
      priceSeries: series,
      priceBand: band,
      priceChartNote: chartNote,
      priceSummary: summary ? {
        avg7: money(summary.avg7),
        low: money(summary.band.low),
        high: money(summary.band.high),
        change_pct: summary.change_pct,
        change_text: summary.change_pct == null
          ? ''
          : `${summary.change_pct > 0 ? '↑' : summary.change_pct < 0 ? '↓' : ''}${Math.abs(summary.change_pct)}%`,
        change_up: summary.change_pct != null && summary.change_pct > 0,
        listings: summary.listings,
        days: summary.days,
      } : null,
      priceSentiment: sentiment || null,
      priceInsight: buildInsight(summary, sentiment, tab.label),
      priceStats: seriesStats(series),
      priceTabNote: note,
      priceRecordsAll: all,
      priceRecords: showAll ? all : all.slice(0, RECORDS_FOLDED),
    })
  },

  showAllRecords() {
    this._applyPriceTab(this.data.priceTab, true)
  },

  foldRecords() {
    this._applyPriceTab(this.data.priceTab, false)
  },

  showPriceSources() {
    const res = this.data.price
    const lines = (res && res.sources) || ['行情：闲鱼搜索的清洗后平均挂牌价，每天一次，按款不分成色']
    const name = res && res.market_name ? `\n监控清单里叫「${res.market_name}」` : ''
    wx.showModal({ title: '数据来源', content: lines.join('\n') + name, showCancel: false })
  },

  openRecord(e) {
    const r = this.data.priceRecords[Number(e.currentTarget.dataset.index)]
    if (!r) return
    if (r.sku_code) {
      // 我们自己卖出的同款：看那件货的详情（卖了多少、什么成色、实拍）
      if (r.sku_code !== this.code) wx.navigateTo({ url: `/pages/warehouse/detail/index?code=${r.sku_code}` })
      return
    }
    this.openXianyu(r)
  },

  openProductXianyu() {
    this.openXianyu(this.data.priceItem)
  },

  // 没有链接时明确提示，绝不退到闲鱼首页。
  openXianyu(r) {
    const web = xianyuWebUrl(r)
    if (!web) {
      wx.showToast({ title: '暂无对应闲鱼商品链接', icon: 'none' })
      return
    }
    // 小程序不能打开外站；按平台能力复制商品链接，让员工去闲鱼里粘。
    if (!platform.isH5()) {
      this._copyXianyu(web)
      return
    }
    // 电脑浏览器直接开商品页，不弹多余的选择。
    if (!isMobileH5()) {
      this._openXianyuWeb(web)
      return
    }
    const app = xianyuAppUrl(r)
    const items = app ? ['打开闲鱼 App', '浏览器打开商品页'] : ['浏览器打开商品页']
    wx.showActionSheet({
      itemList: items,
      success: (res) => {
        if (app && items[res.tapIndex] === '打开闲鱼 App') this._launchXianyuApp(app, web)
        else this._openXianyuWeb(web)
      },
    })
  },

  // 唤端后 1.5 秒页面还在前台，就按「没装闲鱼 / 浏览器拦截」处理，给网页和复制两个兜底。
  _launchXianyuApp(app, web) {
    let settled = false
    const settle = () => {
      settled = true
      try { document.removeEventListener('visibilitychange', onLeave) } catch (e) {}
      try { window.removeEventListener('pagehide', onLeave) } catch (e) {}
    }
    const onLeave = () => {
      if (document.visibilityState === 'hidden') settle()
    }
    try {
      document.addEventListener('visibilitychange', onLeave)
      window.addEventListener('pagehide', onLeave)
    } catch (e) {}
    try {
      window.location.href = app
    } catch (e) {
      settle()
      this._xianyuFallback(web)
      return
    }
    setTimeout(() => {
      if (settled) return
      settle()
      this._xianyuFallback(web)
    }, 1500)
  },

  _xianyuFallback(web) {
    wx.showModal({
      title: '没有打开闲鱼？',
      content: '可能是还没安装闲鱼，或当前浏览器不允许跳转。可以打开网页商品页，也可以复制链接后去闲鱼里粘贴。',
      confirmText: '网页打开',
      cancelText: '复制链接',
      success: (res) => {
        if (res.confirm) this._openXianyuWeb(web)
        else if (res.cancel) this._copyXianyu(web)
      },
    })
  },

  // 新标签页直接落到商品页；被拦截时才复制链接，link 永远不指向闲鱼首页。
  _openXianyuWeb(web) {
    let win = null
    try { win = window.open(web, '_blank') } catch (e) { win = null }
    if (win) {
      try { win.opener = null } catch (e) {}
      return
    }
    this._copyXianyu(web)
  },

  _copyXianyu(url) {
    wx.setClipboardData({
      data: url,
      success: () => {
        wx.showModal({
          title: '前往闲鱼',
          content: platform.isH5()
            ? '链接已复制，请粘贴到浏览器或闲鱼 App 打开。'
            : '小程序不能直接打开闲鱼，链接已复制；请到闲鱼 App 或浏览器粘贴打开。',
          showCancel: false,
        })
      },
    })
  },

  // 记下坏图地址：切页签/展开全部重算列表时不再重复加载，也不会闪回裂图。
  // H5 的 <image> 是 Vue 组件，error 事件从内层 img 冒出来，currentTarget 上没有 data-index；
  // 这时按失败地址回查是哪一条记录，手机端和小程序仍走 dataset.index。
  onRecordImageError(e) {
    const records = this.data.priceRecords || []
    let idx = Number(e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.index)
    let current = Number.isInteger(idx) && idx >= 0 ? records[idx] : null
    if (!current && e) {
      const failed = String(
        (e.target && (e.target.currentSrc || e.target.src))
        || (e.currentTarget && e.currentTarget.src)
        || ''
      )
      if (failed) {
        current = records.find((r) => r.image && (failed === r.image || failed.indexOf(r.image) >= 0)) || null
        if (current) idx = records.indexOf(current)
      }
    }
    if (!current || idx < 0) return
    if (current.image) {
      this._imgFailed = this._imgFailed || {}
      this._imgFailed[current.image] = true
    }
    const all = (this.data.priceRecordsAll || []).map((r) =>
      r._k === current._k ? { ...r, _imgError: true } : r)
    this.setData({ [`priceRecords[${idx}]._imgError`]: true, priceRecordsAll: all })
  },

  previewCover() {
    const urls = this.data.galleryUrls || []
    if (urls.length) wx.previewImage({ urls, current: urls[0] })
  },

  onCoverError() {
    this.setData({ coverError: true })
  },

  loadDetail() {
    const code = this.code
    if (!code) return
    return Promise.all([
      api.skuDetail(code),
      api.getListing(code).catch(() => null),
      api.listingShops(code).catch(() => []),
      api.skuStockAge(code).catch(() => null),
      api.listingImages(code).catch(() => null),
    ]).then(([detail, listing, shops, stock, lim]) => {
      const ageByShop = {}
      ;((stock && stock.shops) || []).forEach((s) => { ageByShop[s.shop_id] = s })
      const shopRows = (shops || []).map((s) => {
        const age = ageByShop[s.shop_id] || {}
        return { ...s, age, nextText: age.next_at ? dayText(age.next_in_days) : '—' }
      })
      const listedCount = shopRows.filter((s) => s.publish_status === 'LISTED').length
      const delistedCount = shopRows.filter((s) => s.publish_status === 'DELISTED').length
      // 流转记录倒序：最新事件排最上面（与时间线首项高亮=当前状态一致）
      if (detail && Array.isArray(detail.stock_events)) {
        detail.stock_events = detail.stock_events.slice().reverse()
      }
      // SPU（69码条码库）：名称+品牌+规格拼接，空格隔开
      const spu = (detail && detail.spu) || {}
      const spuText = [spu.ItemName, spu.BrandName, spu.ItemSpecification]
        .filter((s) => s && String(s).trim())
        .join(' ')
      this.setData({
        detail,
        listing,
        shops: shopRows,
        listedCount,
        delistedCount,
        galleryUrls: buildGallery(detail),
        coverError: false,
        spuText,
        age: stock ? ageView(stock.stock_age) : null,
        auto: stock ? autoView(stock.auto_refresh) : null,
        limCard: limCardView(lim),
      })
    }).catch((err) => {
      if (err && err.statusCode === 404) {
        wx.showToast({ title: '商品不存在', icon: 'none' })
        setTimeout(() => wx.navigateBack(), 800)
      } else {
        wx.showToast({ title: (err && err.detail) || '加载失败', icon: 'none' })
      }
    })
  },

  // ------------------------------------------------------------ 库龄和自动上架
  showAgeHelp(e) {
    const { age, auto } = this.data
    const content = e.currentTarget.dataset.topic === 'age'
      ? `从入库那天算起。到 ${age.clearance_days} 天、${age.max_days} 天只变状态提醒，不会自动降价或下架。`
      : `在架满 ${auto.cycle_days} 天没卖掉，每天 09:30 删掉旧链接重发。频率固定，不随库龄变快。当天额度满了或买家在聊会顺延。`
    wx.showModal({ title: e.currentTarget.dataset.topic === 'age' ? '库存库龄' : '自动上架', content, showCancel: false })
  },

  noop() {},

  openAgeSheet() {
    const { target_days, clearance_days, max_days } = this.data.age
    this.setData({ ageSheet: true, ageForm: { target_days, clearance_days, max_days } })
  },

  closeAgeSheet() {
    this.setData({ ageSheet: false })
  },

  onAgeInput(e) {
    this.setData({ [`ageForm.${e.currentTarget.dataset.key}`]: e.detail.value })
  },

  saveAgeThresholds() {
    const f = this.data.ageForm
    api.setStockAgeThresholds({
      target_days: Number(f.target_days),
      clearance_days: Number(f.clearance_days),
      max_days: Number(f.max_days),
    }).then(() => {
      this.setData({ ageSheet: false })
      wx.showToast({ title: '已保存', icon: 'success' })
      this.loadDetail()
    }).catch((err) => {
      wx.showToast({ title: (err && err.detail) || '保存失败', icon: 'none' })
    })
  },

  _saveAutoRefresh(data, okText) {
    if (this.data.autoSaving) return Promise.resolve()
    this.setData({ autoSaving: true })
    return api.setSkuAutoRefresh(this.code, data).then(() => {
      wx.showToast({ title: okText, icon: 'none' })
      return this.loadDetail()
    }).catch((err) => {
      wx.showToast({ title: (err && err.detail) || '保存失败', icon: 'none' })
      return this.loadDetail()
    }).finally(() => {
      this.setData({ autoSaving: false })
    })
  },

  onAutoSwitch(e) {
    const on = e.detail.value
    this._saveAutoRefresh({ paused: !on }, on ? '已恢复自动上架' : '已暂停自动上架')
  },

  onAutoToggle() {
    const paused = !this.data.auto.paused
    this._saveAutoRefresh({ paused }, paused ? '已暂停自动上架' : '已恢复自动上架')
  },

  onPostpone(e) {
    this._saveAutoRefresh({ not_before: e.detail.value }, `排到 ${e.detail.value}`)
  },

  onClearPostpone() {
    this._saveAutoRefresh({ not_before: null }, '已取消')
  },

  // 删掉旧链接重发是动真店的，先确认。买家在聊、刚上架的后端会跳过并说明
  _confirmRefresh(title, shopIds) {
    if (this.data.refreshing) return
    wx.showModal({
      title,
      content: '会删掉闲鱼上的旧链接再重发，中间有几分钟不在架。',
      confirmText: '重新上架',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ refreshing: true })
        api.refreshSkuNow(this.code, shopIds).then((r) => {
          const skipped = (r.skipped || []).map((s) => `${s.shop}：${s.why}`)
          wx.showModal({
            title: r.created ? `已提交 ${r.created} 个店铺` : '这次没有提交',
            content: skipped.join('\n') || (r.created ? '进度看下面的店铺状态。' : '这件货没有在架链接。'),
            showCancel: false,
          })
          return this.loadDetail()
        }).catch((err) => {
          wx.showToast({ title: (err && err.detail) || '提交失败', icon: 'none' })
        }).finally(() => {
          this.setData({ refreshing: false })
        })
      },
    })
  },

  onRefreshAll() {
    this._confirmRefresh('重新上架全部在架店铺？')
  },

  onSyncShops() {
    if (this.data.syncing) return
    this.setData({ syncing: true })
    this.loadDetail().then(() => {
      wx.showToast({ title: '已同步', icon: 'none' })
    }).finally(() => {
      this.setData({ syncing: false })
    })
  },

  onShopMore(e) {
    const shop = this.data.shops[Number(e.currentTarget.dataset.index)]
    if (!shop) return
    const listed = shop.publish_status === 'LISTED' && !shop.gc_pending
    const items = listed ? ['立即重新上架', '下架'] : ['去上架']
    wx.showActionSheet({
      itemList: items,
      success: (res) => {
        const picked = items[res.tapIndex]
        if (picked === '下架') this.goDelist()
        else if (picked === '去上架') this.goPublish()
        else if (shop.age.can_refresh) this._confirmRefresh(`重新上架「${shop.shop_label}」？`, [shop.shop_id])
        else wx.showToast({ title: shop.age.note || '这家店现在不能重新上架', icon: 'none' })
      },
    })
  },

  goListingImages() {
    if (this.code) wx.navigateTo({ url: `/pages/warehouse/listing-images/index?code=${encodeURIComponent(this.code)}` })
  },

  showLimHelp() {
    wx.showModal({
      title: '上架图片',
      content: '这是挂到闲鱼上给买家看的图。每个号可以用自己的一组，没单独选过的号用公用那组。各号的图不能重复。',
      showCancel: false,
    })
  },

  goSpuMatch() {
    const code = this.data.detail && this.data.detail.sku_code
    if (code) wx.navigateTo({ url: `/pages/warehouse/spu-match/detail/index?code=${encodeURIComponent(code)}` })
  },

  goEdit() {
    if (!this.data.canEditSku) return
    const code = this.data.detail && this.data.detail.sku_code
    if (!code) return
    wx.navigateTo({ url: `/pages/warehouse/edit/index?code=${code}` })
  },

  onLookupBarcode() {
    const detail = this.data.detail
    const code = detail && detail.sku_code
    if (!code || this.data.barcodeLoading) return
    if (!detail.barcode) {
      wx.showToast({ title: '请先编辑填写69码', icon: 'none' })
      return
    }
    this.setData({ barcodeLoading: true })
    api.lookupSkuBarcode(code).then(() => {
      wx.showToast({ title: 'SPU 信息已更新', icon: 'success' })
      this.loadDetail()
    }).catch((err) => {
      wx.showToast({ title: (err && err.detail) || '查询失败', icon: 'none' })
    }).finally(() => {
      this.setData({ barcodeLoading: false })
    })
  },

  goSplit() {
    const code = this.data.detail && this.data.detail.sku_code
    if (!code) return
    wx.navigateTo({ url: `/pages/warehouse/split/index?code=${code}` })
  },

  goDelist() {
    const code = this.data.detail && this.data.detail.sku_code
    if (!code) return
    wx.navigateTo({ url: `/pages/warehouse/shop-off/index?code=${code}` })
  },

  goPublish() {
    const code = this.data.detail && this.data.detail.sku_code
    if (!code) return
    listingAutosave.gotoPublish(code)
  },

  goListingEdit() {
    const detail = this.data.detail
    const code = detail && detail.sku_code
    if (!code) return
    const phase = detail.warehouse_phase
    if (phase === 'pending_create') {
      listingAutosave.gotoPublish(code)
      return
    }
    wx.navigateTo({ url: `/pages/listing/form/index?code=${code}` })
  },
})

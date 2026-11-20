// 行情折线图（小程序）：SVG 图片 + 透明触摸层。
// H5 有同名 override（h5/src/overrides/components/price-trend-chart），用 ECharts 渲染。
// 两边的属性、空状态和对外行为保持一致，页面只认 <price-trend-chart>。
const { buildChartModel } = require('@utils/price-chart')

const TIP_HIDE_MS = 1400

function money(v) {
  if (v == null || v === '') return ''
  const n = Number(v)
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

Component({
  properties: {
    points: { type: Array, value: [] },
    band: { type: Object, value: null },
    emptyText: { type: String, value: '' },
  },

  data: {
    uri: '',
    hasData: false,
    hinted: false,
    tip: { show: false, date: '', price: '', count: '' },
    lineStyle: '',
    dotStyle: '',
    tipStyle: '',
  },

  observers: {
    'points, band': function () {
      this.rebuild()
    },
  },

  lifetimes: {
    attached() {
      this.rebuild()
    },
    detached() {
      clearTimeout(this._hideTimer)
      this._model = null
      this._rect = null
    },
  },

  methods: {
    rebuild() {
      const model = buildChartModel(this.data.points, this.data.band)
      this._model = model
      this._idx = -1
      this.setData({
        uri: model.uri,
        hasData: !!model.uri,
        tip: { show: false, date: '', price: '', count: '' },
      })
    },

    // 手指按下时量一次图表尺寸；之后滑动直接用缓存的 rect
    onTouchStart(e) {
      clearTimeout(this._hideTimer)
      const t = (e.touches && e.touches[0]) || {}
      if (t.clientX == null) return
      this._cx = t.clientX
      // 每次按下都量一次：切页签、旋转屏幕后尺寸可能已经变了
      this.createSelectorQuery()
        .in(this)
        .select('#ptc-stage')
        .boundingClientRect((rect) => {
          if (!rect) return
          this._rect = rect
          this._scrub()
        })
        .exec()
    },

    // catchtouchmove：看行情时手指在图上滑动，不让页面跟着滚
    onTouchMove(e) {
      const t = (e.touches && e.touches[0]) || {}
      if (t.clientX == null) return
      this._cx = t.clientX
      this._scrub()
    },

    onTouchEnd() {
      clearTimeout(this._hideTimer)
      this._hideTimer = setTimeout(() => {
        this._idx = -1
        this.setData({ 'tip.show': false })
      }, TIP_HIDE_MS)
    },

    onTouchCancel() {
      clearTimeout(this._hideTimer)
      this._idx = -1
      this.setData({ 'tip.show': false })
    },

    _scrub() {
      const model = this._model
      const rect = this._rect
      if (!model || !model.uri || !rect || !rect.width || this._cx == null) return
      const scale = rect.width / model.W
      let svgX = (this._cx - rect.left) / scale
      svgX = Math.max(model.plot.left, Math.min(model.plot.right, svgX))
      let idx = 0
      let best = Infinity
      for (let i = 0; i < model.points.length; i++) {
        const d = Math.abs(model.points[i].x - svgX)
        if (d < best) {
          best = d
          idx = i
        }
      }
      if (idx === this._idx && this.data.tip.show) return
      this._idx = idx
      const p = model.points[idx]
      const px = p.x * scale
      const py = p.y * scale
      const tipW = Math.max(118, Math.min(164, rect.width * 0.46))
      const tipH = 66
      const edge = 6
      const left = Math.max(edge, Math.min(px - tipW / 2, rect.width - tipW - edge))
      let top = py - tipH - 14
      if (top < edge) top = Math.min(py + 16, rect.height - tipH - edge)
      const lineTop = model.plot.top * scale
      const lineHeight = model.plot.height * scale
      this.setData({
        hinted: true,
        'tip.show': true,
        'tip.date': p.date,
        'tip.price': money(p.price),
        'tip.count': p.count != null ? `${p.count} 条在售` : '',
        lineStyle: `left:${px.toFixed(1)}px;top:${lineTop.toFixed(1)}px;height:${lineHeight.toFixed(1)}px;`,
        dotStyle: `left:${px.toFixed(1)}px;top:${py.toFixed(1)}px;`,
        tipStyle: `left:${left.toFixed(1)}px;top:${top.toFixed(1)}px;width:${tipW.toFixed(1)}px;`,
      })
    },
  },
})

// 行情折线图（H5）：ECharts 版。小程序同名组件走 SVG + 触摸层。
// 这个文件只在 H5 生效：h5/compiler/paths.js 会优先读取 src/overrides 下的同名文件。
// 注意：这里只能用 ESM import；H5 的小程序 CJS 转换会把裸模块 require 判为构建错误。
import { nextTick } from 'vue'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import {
  GridComponent, TooltipComponent, MarkPointComponent, MarkLineComponent, AxisPointerComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  LineChart, GridComponent, TooltipComponent, MarkPointComponent, MarkLineComponent,
  AxisPointerComponent, CanvasRenderer,
])

const BLUE = '#12AEF8'
const FONT = 'PingFang SC, Microsoft YaHei, Helvetica, Arial, sans-serif'

function nf(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return ''
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function md(iso) {
  return String(iso || '').slice(5).replace('-', '.')
}

// 和 SVG 版同一套清洗规则：坏价格丢掉、同一天只留最后一个、按日期升序
function normalize(points) {
  const seen = {}
  ;(points || []).forEach((p) => {
    if (!p || !p.date) return
    const price = Number(p.price)
    if (!(price > 0)) return
    const date = String(p.date)
    seen[date] = { date, price, count: p.count == null ? null : Number(p.count) }
  })
  return Object.keys(seen).sort().map((d) => seen[d])
}

Component({
  properties: {
    points: { type: Array, value: [] },
    band: { type: Object, value: null },
    emptyText: { type: String, value: '' },
  },

  data: {
    // 先按有数据处理，避免首帧闪一下空状态；_sync 会立刻纠正
    hasData: true,
  },

  observers: {
    'points, band': function () {
      this._sync()
    },
  },

  lifetimes: {
    ready() {
      this._ready = true
      this._sync()
    },
    detached() {
      this._teardown()
    },
  },

  pageLifetimes: {
    show() {
      this._resizeSoon()
    },
  },

  methods: {
    _sync() {
      if (!this._ready) return
      const pts = normalize(this.data.points)
      const band = this.data.band && this.data.band.low != null && this.data.band.high != null
        ? { low: Number(this.data.band.low), high: Number(this.data.band.high) }
        : null
      const hasData = pts.length >= 2
      this.setData({ hasData })
      nextTick(() => {
        if (!this._ready) return
        if (!hasData) {
          this._disposeChart()
          return
        }
        this._ensureChart()
        if (this._chart) this._apply(pts, band)
      })
    },

    _ensureChart() {
      if (this._chart) return
      const host = this.$el
      const el = host && host.querySelector ? host.querySelector('#ptc-echart') : null
      if (!el) return
      this._chart = echarts.init(el, null, { renderer: 'canvas' })
      this._el = el
      this._onResize = () => this._resizeSoon()
      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver(this._onResize)
        this._ro.observe(el)
      } else if (typeof window !== 'undefined') {
        window.addEventListener('resize', this._onResize)
      }
    },

    _resizeSoon() {
      if (typeof requestAnimationFrame === 'undefined') {
        if (this._chart) this._chart.resize()
        return
      }
      cancelAnimationFrame(this._raf)
      this._raf = requestAnimationFrame(() => {
        if (this._chart) this._chart.resize()
      })
    },

    _signature(pts) {
      return pts.map((p) => `${p.date}|${p.price}|${p.count == null ? '' : p.count}`).join(',')
    },

    _apply(pts, band) {
      const sig = this._signature(pts)
      if (sig === this._sig) return
      this._sig = sig
      this._chart.setOption(this._option(pts, band), { notMerge: true })
    },

    _option(pts) {
      const dates = pts.map((p) => p.date)
      const prices = pts.map((p) => p.price)
      const last = pts[pts.length - 1]
      return {
        animation: true,
        animationDuration: 620,
        animationDurationUpdate: 380,
        animationEasing: 'cubicOut',
        textStyle: { fontFamily: FONT },
        grid: { left: 10, right: 10, top: 12, bottom: 24, containLabel: false },
        tooltip: {
          trigger: 'axis',
          confine: true,
          triggerOn: 'mousemove|click',
          backgroundColor: 'rgba(15,23,42,0.94)',
          borderWidth: 0,
          padding: [9, 12],
          textStyle: { color: '#fff', fontSize: 12, fontFamily: FONT },
          extraCssText: 'border-radius:10px;box-shadow:0 10px 28px rgba(15,23,42,.22);',
          axisPointer: {
            type: 'line',
            snap: true,
            lineStyle: { color: '#93B4FF', width: 1, type: 'dashed' },
          },
          formatter: (params) => {
            const i = params && params[0] ? params[0].dataIndex : 0
            const p = pts[i] || {}
            const count = p.count != null ? `<div style="font-size:11px;opacity:.7;margin-top:2px">${p.count} 条在售</div>` : ''
            return `<div style="font-size:11px;opacity:.62;margin-bottom:2px">${p.date || ''}</div>`
              + `<div style="font-size:17px;font-weight:700;line-height:1.2">¥${nf(p.price)}</div>${count}`
          },
        },
        xAxis: {
          type: 'category',
          boundaryGap: false,
          data: dates,
          axisLine: { show: true, lineStyle: { color: '#E3E3E3', type: 'dashed' } },
          axisTick: { show: false },
          axisLabel: {
            color: '#A6A6A6',
            fontSize: 11,
            margin: 10,
            hideOverlap: true,
            showMinLabel: true,
            showMaxLabel: true,
            alignMinLabel: 'left',
            alignMaxLabel: 'right',
            formatter: md,
            // 点很少时只留首尾，避免 11-05 / 11-06 挤在一起
            interval: dates.length <= 4 ? (index) => index === 0 || index === dates.length - 1 : 'auto',
          },
          splitLine: { show: false },
        },
        yAxis: {
          type: 'value',
          show: false,
          scale: true,
          splitNumber: 4,
        },
        series: [{
          name: '行情价',
          type: 'line',
          smooth: 0.35,
          showSymbol: false,
          symbol: 'circle',
          symbolSize: 7,
          data: prices,
          lineStyle: {
            width: 1.8,
            color: BLUE,
            cap: 'round',
            join: 'round',
            shadowColor: 'rgba(18,174,248,0.22)',
            shadowBlur: 5,
            shadowOffsetY: 2,
          },
          itemStyle: { color: BLUE, borderColor: '#fff', borderWidth: 2 },
          emphasis: { scale: 1.6, focus: 'series' },
          areaStyle: {
            color: {
              type: 'linear',
              x: 0,
              y: 0,
              x2: 0,
              y2: 1,
              colorStops: [
                { offset: 0, color: 'rgba(18,174,248,0.17)' },
                { offset: 1, color: 'rgba(18,174,248,0.02)' },
              ],
            },
          },
          markPoint: {
            symbol: 'circle',
            symbolSize: 9,
            silent: true,
            animation: false,
            itemStyle: {
              color: '#FFFFFF',
              borderColor: BLUE,
              borderWidth: 2,
              shadowColor: 'rgba(18,174,248,0.26)',
              shadowBlur: 6,
            },
            label: { show: false },
            data: [{ coord: [last.date, last.price] }],
          },
          markLine: {
            silent: true,
            symbol: 'none',
            animation: false,
            lineStyle: { color: BLUE, type: 'dashed', width: 1, opacity: 0.45 },
            label: { show: false },
            data: [{ xAxis: last.date }],
          },
        }],
      }
    },

    _disposeChart() {
      this._sig = ''
      if (this._raf) {
        cancelAnimationFrame(this._raf)
        this._raf = 0
      }
      if (this._ro) {
        this._ro.disconnect()
        this._ro = null
      }
      if (this._onResize && typeof window !== 'undefined') {
        window.removeEventListener('resize', this._onResize)
      }
      if (this._chart) {
        this._chart.dispose()
        this._chart = null
      }
      this._el = null
    },

    _teardown() {
      this._ready = false
      this._disposeChart()
      this._onResize = null
    },
  },
})

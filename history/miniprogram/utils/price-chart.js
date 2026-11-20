// 价格折线图：拼一张 SVG，转成 data URI 交给 <image> 显示。
// 小程序没有图表库，H5 的旧实现又不认 <canvas>，一张图两边都能用。
//
// 11-12 重构：除了图本身，还返回每个数据点在 SVG 里的坐标和绘图区，
// 页面上的透明触摸层用它做十字线 / 日期价格浮层。SVG 里只放数字和日期（纯 ASCII），
// 这样不用为中文字体操心，base64 也能自己编。

const W = 640
const H = 340
const PAD = { left: 16, right: 16, top: 16, bottom: 38 }
const LINE = '#12AEF8'
const LINE_LIGHT = '#5FC8FA'
const AREA_TOP = '0.17'
const AREA_BOTTOM = '0.02'

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// 只给 ASCII 用（SVG 里没有中文）
function base64(str) {
  let out = ''
  for (let i = 0; i < str.length; i += 3) {
    const a = str.charCodeAt(i)
    const b = i + 1 < str.length ? str.charCodeAt(i + 1) : NaN
    const c = i + 2 < str.length ? str.charCodeAt(i + 2) : NaN
    out += B64[a >> 2]
    out += B64[((a & 3) << 4) | (isNaN(b) ? 0 : b >> 4)]
    out += isNaN(b) ? '=' : B64[((b & 15) << 2) | (isNaN(c) ? 0 : c >> 6)]
    out += isNaN(c) ? '=' : B64[c & 63]
  }
  return out
}

function dayMs(iso) {
  const p = String(iso).split('-').map(Number)
  return Date.UTC(p[0], (p[1] || 1) - 1, p[2] || 1)
}

function mmdd(ms) {
  const d = new Date(ms)
  const m = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  return `${m < 10 ? '0' : ''}${m}.${day < 10 ? '0' : ''}${day}`
}

// 刻度取 1 / 2 / 5 × 10^n
function niceStep(range, count) {
  const raw = range / Math.max(1, count)
  const pow = Math.pow(10, Math.floor(Math.log10(raw || 1)))
  const n = raw / pow
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow
}

function fmtNum(v) {
  return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

function round1(v) {
  return Math.round(v * 10) / 10
}

// 单调三次插值：曲线平滑但不会在数据点之间冲高/探底，比普通 Catmull-Rom 更适合价格
function smoothPath(points) {
  const n = points.length
  if (!n) return ''
  if (n === 1) return `M${round1(points[0].x)} ${round1(points[0].y)}`
  if (n === 2) {
    return `M${round1(points[0].x)} ${round1(points[0].y)} L${round1(points[1].x)} ${round1(points[1].y)}`
  }
  const dx = []
  const m = []
  for (let i = 0; i < n - 1; i++) {
    dx[i] = points[i + 1].x - points[i].x || 0.0001
    m[i] = (points[i + 1].y - points[i].y) / dx[i]
  }
  const t = new Array(n)
  t[0] = m[0]
  t[n - 1] = m[n - 2]
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) t[i] = 0
    else t[i] = (m[i - 1] + m[i]) / 2
  }
  // Fritsch-Carlson 限幅，防止过冲
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0
      t[i + 1] = 0
      continue
    }
    const a = t[i] / m[i]
    const b = t[i + 1] / m[i]
    const s = a * a + b * b
    if (s > 9) {
      const k = 3 / Math.sqrt(s)
      t[i] = k * a * m[i]
      t[i + 1] = k * b * m[i]
    }
  }
  let d = `M${round1(points[0].x)} ${round1(points[0].y)}`
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i]
    const p1 = points[i + 1]
    const h = dx[i] / 3
    d += ` C${round1(p0.x + h)} ${round1(p0.y + t[i] * h)},`
      + `${round1(p1.x - h)} ${round1(p1.y - t[i + 1] * h)},`
      + `${round1(p1.x)} ${round1(p1.y)}`
  }
  return d
}

// 清掉重复日期、按日期升序、丢掉坏价格
function normalize(series) {
  const seen = {}
  ;(series || []).forEach((p) => {
    if (!p || !p.date) return
    const price = Number(p.price)
    if (!(price > 0)) return
    const date = String(p.date)
    seen[date] = {
      date,
      price,
      count: p.count == null ? null : Number(p.count),
    }
  })
  return Object.keys(seen).sort().map((d) => seen[d])
}

/**
 * 生成图表模型。
 * series: [{ date: 'YYYY-MM-DD', price, count }]
 * band:   { low, high } | null（只作为模型信息透传，不画进图里）
 */
function buildChartModel(series, band) {
  const rows = normalize(series)
  const iw = W - PAD.left - PAD.right
  const ih = H - PAD.top - PAD.bottom
  const plot = { left: PAD.left, top: PAD.top, right: W - PAD.right, bottom: H - PAD.bottom, width: iw, height: ih }
  const bandModel = band && band.low != null && band.high != null
    ? { low: Number(band.low), high: Number(band.high) }
    : null
  if (rows.length < 2) {
    return { uri: '', W, H, pad: PAD, plot, points: [], xTicks: [], yTicks: [], band: bandModel }
  }

  const xs = rows.map((p) => dayMs(p.date))
  const ys = rows.map((p) => Number(p.price))
  const x0 = xs[0]
  const x1 = xs[xs.length - 1] === x0 ? x0 + 86400000 : xs[xs.length - 1]
  let lo = Math.min.apply(null, ys)
  let hi = Math.max.apply(null, ys)
  if (hi === lo) {
    lo -= 50
    hi += 50
  }
  const step = niceStep(hi - lo, 4)
  lo = Math.floor(lo / step) * step
  hi = Math.ceil(hi / step) * step
  const sx = (x) => PAD.left + ((x - x0) / (x1 - x0)) * iw
  const sy = (y) => PAD.top + (1 - (y - lo) / (hi - lo)) * ih

  const points = rows.map((p, i) => ({
    index: i,
    x: round1(sx(xs[i])),
    y: round1(sy(ys[i])),
    date: p.date,
    price: Number(p.price),
    count: p.count,
  }))
  const path = smoothPath(points)
  const last = points[points.length - 1]
  const base = H - PAD.bottom

  const parts = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`)
  parts.push('<defs>')
  parts.push(`<linearGradient id="a" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${LINE}" stop-opacity="${AREA_TOP}"/><stop offset="1" stop-color="${LINE}" stop-opacity="${AREA_BOTTOM}"/></linearGradient>`)
  parts.push(`<linearGradient id="l" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${LINE}"/><stop offset="1" stop-color="${LINE_LIGHT}"/></linearGradient>`)
  parts.push('</defs>')

  // 目标样式：不画 y 轴刻度，只保留底部一条浅灰虚线
  const yTicks = []
  parts.push(`<line x1="${PAD.left}" y1="${base}" x2="${W - PAD.right}" y2="${base}" stroke="#E3E3E3" stroke-width="1" stroke-dasharray="4 5"/>`)

  // 日期刻度：最多 5 个，均匀落在首尾之间
  const xTicks = []
  const nx = Math.min(5, points.length)
  for (let i = 0; i < nx; i++) {
    const t = x0 + ((x1 - x0) * i) / Math.max(1, nx - 1)
    const x = round1(sx(t))
    const label = mmdd(t)
    xTicks.push({ x, label })
    const anchor = i === 0 ? 'start' : i === nx - 1 ? 'end' : 'middle'
    parts.push(`<text x="${x}" y="${H - 12}" font-size="18" fill="#A6A6A6" text-anchor="${anchor}" font-family="Helvetica,Arial,sans-serif">${label}</text>`)
  }

  // 末点的竖向虚线（对齐效果图右侧的当前价标记）
  parts.push(`<line x1="${last.x}" y1="${PAD.top}" x2="${last.x}" y2="${base}" stroke="${LINE}" stroke-opacity="0.45" stroke-width="1" stroke-dasharray="3 5"/>`)

  // 面积 + 细线 + 轻微光晕
  parts.push(`<path d="${path} L${round1(last.x)} ${base} L${round1(points[0].x)} ${base} Z" fill="url(#a)"/>`)
  parts.push(`<path d="${path}" fill="none" stroke="${LINE}" stroke-opacity="0.13" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/>`)
  parts.push(`<path d="${path}" fill="none" stroke="${LINE}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`)

  // 小圆点只保留末点，和效果图的空心圆一致
  parts.push(`<circle cx="${last.x}" cy="${last.y}" r="4.6" fill="#FFFFFF" stroke="${LINE}" stroke-width="2" stroke-opacity="0.95"/>`)
  parts.push('</svg>')

  return {
    uri: `data:image/svg+xml;base64,${base64(parts.join(''))}`,
    W,
    H,
    pad: PAD,
    plot,
    points,
    xTicks,
    yTicks,
    band: bandModel,
  }
}

// 兼容旧调用：只要图片地址
function chartDataUri(series) {
  return buildChartModel(series).uri
}

module.exports = { buildChartModel, chartDataUri, smoothPath }

// 实物选品分类字典、双格式规格解析与「95%走量款 / 5%高端款 / 卓威独立表」前端毫秒级分流引擎。
// 原则：只认 100% 确定性的厂商型号前缀；无法确定的保持「品牌待补 / 待分类」，绝不硬猜。

export const TAX = [
  { big: '3C数码', cats: ['显示器', '电脑硬件', '键盘外设', '手机', '智能穿戴', '苹果配件', '数码影像'] },
  { big: '影音', cats: ['音响'] },
  { big: '家电个护', cats: ['空气净化器', '吹风机', '脱毛仪', '扫地机器人'] }
]
export const UNCLS = '待分类'

const BRANDS = [
  '卓威 ZOWIE', '卓威', 'ZOWIE', '泰坦军团', '机械军团', '联合创新', '蚂蚁电竞', '外星人', 'Alienware',
  '哈曼卡顿', '西部数据', 'HyperX', 'Wooting', 'SONOS', 'Ulike', 'Intel', 'ROG', '玩家国度',
  'HKC', 'AOC', 'AGON', 'KTC', 'LG', '云鲸', '优派', '佳明', '创维', '华硕', '宏碁', '小米', '微星',
  '技嘉', 'AORUS', '戴森', '熊猫', '盛色', '科睿', '联想', '苹果', '金士顿', '雷神', '飞利浦',
  '三星', '戴尔', '惠普', '明基', '索尼', '石头', '追觅', 'iiyama'
]

const MONITOR_BRANDS = new Set([
  '卓威 ZOWIE', '泰坦军团', '机械军团', '联合创新', '蚂蚁电竞', '外星人', 'ROG',
  'HKC', 'AOC', 'KTC', 'LG', '优派', '创维', '华硕', '宏碁', '微星', '技嘉',
  '熊猫', '盛色', '科睿', '联想', '雷神', '飞利浦', '三星', '戴尔', '惠普', '明基', 'iiyama'
])

// 100% 确定性的厂商专属型号前缀（绝不匹配有跨厂重名风险的模糊短码）
const DETERMINISTIC_PREFIXES = [
  [/^(XL\d{4}|XQ\d{4})/i, '卓威 ZOWIE'],
  [/^(ROG\b|PG\d{2,3}[A-Z]|XG\d{2,3}[A-Z]{2,})/i, 'ROG'],
  [/^(TUF\b|VG\d{3}[A-Z]|PA\d{3}[A-Z]|VA\d{3}[A-Z]|VP\d{3}[A-Z]|VZ\d{3}[A-Z])/i, '华硕'],
  [/^(AGP?\d{3}[A-Z]|Q2[47]G\d|2[457]G\d|U2[78]G\d|CU34G|CQ27G|CQ32G|2[247]B\d|Q27P\d|U27P\d|I2[2347]\d{2})/i, 'AOC'],
  [/^(2[47]M[12]N|32M[12]N|2[47]E[12]N|27[125689]E|24[1236]E|BDM\d)/i, '飞利浦'],
  [/^(27GP\d|27GR\d|27GS\d|27GN\d|27GL\d|27GX\d|27UL\d|27UP\d|27UQ\d|32GP\d|32GQ\d|32GR\d|32GS\d|32UN\d|32UP\d|34GP\d|34GN\d|34GS\d|34WN\d|34WP\d|34WQ\d|24GN\d|25G590)/i, 'LG'],
  [/^(MAG\s?\d{3}|MPG\s?\d{3}|OPTIX\b|G2[457][1234][A-Z]|MD2[47]\d)/i, '微星'],
  [/^(XV2[4578]\d|XB2[578]\d|KG2[4578]\d|CB2[478]\d|ED2[47]\d|NITRO\b|PREDATOR\b)/i, '宏碁'],
  [/^(AW2[57]\d{2}|AW3[248]\d{2})/i, '外星人'],
  [/^(S2[47]2[125]\d?[A-Z]|U2[457]2[01234][A-Z]|P2[2347]2[1234][A-Z]|E2[247]2[01234][A-Z])/i, '戴尔'],
  [/^(VX2[4578]\d{2}|VX32\d{2}|XG2431|VA2[247]\d{2}-)/i, '优派'],
  [/^(M2[78]Q|M32Q|M32U|G24F|G27F|G27Q|G27FC|G27QC|G32QC|GS27Q|GS32Q|FO27Q|FO32U|FI27Q|FI32U|AORUS\b)/i, '技嘉'],
  [/^(ODYSSEY\b|LS2[47]\d|LC2[47]\d|C2[47]F39|C32F39|C27G[57]|C32G[57]|S27DG|S32BG)/i, '三星'],
  [/^(H2[47]T\d{2}|M27T\d{2}|M27P\d|G27P6)/i, 'KTC'],
  [/^(IG27|SG27|MG2[457]|VG2[47]\d|TG27|CG27|T2[47]\d)/i, 'HKC'],
  [/^(P2[457][15A-Z]\d|P32A\d|C32C\d)/i, '泰坦军团'],
  [/^(XUB2[47]|GB2[4578]|G2730HSU)/i, 'iiyama'],
  [/^(ANT\d{3})/i, '蚂蚁电竞'],
  [/^(EX2[457]\d{2}|PD2[57]\d{2}|GW2[47]\d{2}|EW2[478]\d{2}|MOBIUZ\b)/i, '明基']
]

// 在库常见热销显示器规格补丁（备注为「按在库 SPU 自动同步」的 30+ 个真实在库型号）
const INSTOCK_SPEC_MAP = {
  Q27G3XMN: { size: 27, res: '2K', hz: 180, panel: 'VA MiniLED' },
  P24H3GC: { size: 23.8, res: '1080P', hz: 180, panel: 'Fast IPS' },
  '27GR95GE': { size: 26.5, res: '2K', hz: 240, panel: 'OLED' },
  PG248QP: { size: 24.1, res: '1080P', hz: 540, panel: 'E-TN' },
  '24G15N': { size: 23.8, res: '1080P', hz: 180, panel: 'VA' },
  G24H1: { size: 23.8, res: '1080P', hz: 200, panel: 'Fast IPS' },
  C32C1S: { size: 31.5, res: '2K', hz: 240, panel: 'VA' },
  MG27H3Q1: { size: 27, res: '2K', hz: 180, panel: 'Fast IPS' },
  MAG245FX24: { size: 23.8, res: '1080P', hz: 240, panel: 'Rapid IPS' },
  VX2563HDPRO: { size: 24.5, res: '1080P', hz: 300, panel: 'Fast IPS' },
  '27M2N5510P': { size: 27, res: '2K', hz: 180, panel: 'Fast IPS' },
  '27M2N5511P': { size: 27, res: '2K', hz: 180, panel: 'Fast IPS' },
  '25M2N3200': { size: 24.5, res: '1080P', hz: 180, panel: 'Fast IPS' },
  X71Q27: { size: 27, res: '2K', hz: 180, panel: 'Fast IPS' },
  X71QH: { size: 27, res: '2K', hz: 240, panel: 'Fast IPS' },
  VG25BQM: { size: 24.5, res: '1080P', hz: 280, panel: 'Fast IPS' },
  VG258QM: { size: 24.5, res: '1080P', hz: 280, panel: 'TN' },
  XG259CMS: { size: 24.5, res: '1080P', hz: 310, panel: 'Fast IPS' },
  '27GS820': { size: 27, res: '2K', hz: 180, panel: 'Fast IPS' },
  H27T22S3: { size: 27, res: '2K', hz: 180, panel: 'Fast IPS' },
  '24G10ZNE': { size: 23.8, res: '1080P', hz: 240, panel: 'Fast VA' },
  PF25FA9: { size: 24.5, res: '1080P', hz: 180, panel: 'Fast IPS' },
  'VX3276-4K-MHD': { size: 31.5, res: '4K', hz: 60, panel: 'VA' },
  'P2510G24.5': { size: 24.5, res: '1080P', hz: 180, panel: 'Fast IPS' },
  P2710S: { size: 27, res: '2K', hz: 240, panel: 'Fast IPS' },
  P27W2V: { size: 27, res: '4K', hz: 160, panel: 'Fast IPS' },
  MG25H3F: { size: 24.5, res: '1080P', hz: 240, panel: 'Fast IPS' },
  VG243: { size: 23.8, res: '1080P', hz: 165, panel: 'VA' },
  EG270U: { size: 27, res: '2K', hz: 165, panel: 'IPS' },
  MZQ27F240: { size: 27, res: '2K', hz: 240, panel: 'Fast IPS' },
  G7PROMAX: { size: 27, res: '2K', hz: 240, panel: 'Fast IPS' },
  F24G30F: { size: 23.8, res: '1080P', hz: 180, panel: 'Fast IPS' },
  D75V: { size: 27, res: '2K', hz: 75, panel: 'IPS' }
}

function normBrand(b, rest) {
  const up = b.toUpperCase()
  if (up === 'ZOWIE' || up === '卓威') return '卓威 ZOWIE'
  if (up === 'ALIENWARE') return '外星人'
  if (up === '玩家国度' || up === 'ROG') return 'ROG'
  if (up === 'AGON') return 'AOC'
  if (up === 'AORUS') return '技嘉'
  if ((up === '华硕' || up === 'ASUS') && /^(ROG\b|PG\d|XG\d{2,3}[A-Z]{2,})/i.test(rest || '')) return 'ROG'
  if ((up === '明基' || up === 'BENQ') && /^(XL\d|XQ\d|ZOWIE)/i.test(rest || '')) return '卓威 ZOWIE'
  return b
}

export function parseName(raw) {
  const name = String(raw || '').trim()
  for (const b of BRANDS) {
    if (name.toUpperCase().startsWith(b.toUpperCase())) {
      const rest = name.slice(b.length).trim() || name
      return { brand: normBrand(b, rest), model: rest, name }
    }
  }
  for (const [re, br] of DETERMINISTIC_PREFIXES) {
    if (re.test(name)) return { brand: br, model: name, name }
  }
  return { brand: '', model: name, name }
}

function pixelToRes(w, h) {
  if (w >= 5120 && h >= 2880) return '5K/6K'
  if (w >= 3440 && h < 2160 && w / Math.max(1, h) > 2.0) return '带鱼超宽'
  if (w >= 2560 && h <= 1080) return '带鱼超宽'
  if (w >= 3840) return '4K'
  if (w >= 2560) return '2K'
  if (w >= 1920) return '1080P'
  return `${w}×${h}`
}

// 兼容 catalog-snapshot 的两种规格写法 + 在库热销型号补全
export function parseSpec(note, modelCode = '') {
  const s = String(note || '')
  const m1 = /(\d+(?:\.\d+)?)英寸\s*\/\s*(\d+)\s*[x×]\s*(\d+)\s*\/\s*(\d+)\s*Hz\s*\/?\s*([^/]+)?/i.exec(s)
  if (m1) {
    return { size: +m1[1], res: pixelToRes(+m1[2], +m1[3]), hz: +m1[4], panel: (m1[5] || 'IPS').trim() }
  }
  const ms = /尺寸\s*[:：]\s*(\d+(?:\.\d+)?)\s*英寸/i.exec(s)
  const mr = /分辨率\s*[:：]\s*(\d+)\s*[x×]\s*(\d+)/i.exec(s)
  const mh = /刷新率\s*[:：]\s*(\d+)\s*Hz/i.exec(s)
  if (ms && mr && mh) {
    const mp = /面板类型\s*[:：]\s*([^/\s]+)/i.exec(s)
    return { size: +ms[1], res: pixelToRes(+mr[1], +mr[2]), hz: +mh[1], panel: mp ? mp[1].trim() : 'IPS' }
  }
  const cleanM = String(modelCode || '').toUpperCase().replace(/\s+/g, '')
  if (cleanM && INSTOCK_SPEC_MAP[cleanM]) return { ...INSTOCK_SPEC_MAP[cleanM] }
  return null
}

export function classify(name, note) {
  const { brand, model } = parseName(name)
  const up = String(name).toUpperCase()
  let cat = ''
  if (/净化器|4LITE|ACM/.test(up)) cat = '空气净化器'
  else if (/戴森|DYSON|HT01|HD08/.test(up)) cat = '吹风机'
  else if (/ULIKE|脱毛/.test(up)) cat = '脱毛仪'
  else if (brand === '云鲸' || brand === '石头' || brand === '追觅' || /扫地|YJCC/.test(up)) cat = '扫地机器人'
  else if (brand === '佳明' || /GARMIN|WATCH|手环/.test(up)) cat = '智能穿戴'
  else if (/索尼|相机|镜头|A7M|ZV-E/.test(up)) cat = '数码影像'
  else if (/SONOS|哈曼卡顿|琉璃|^音响|音箱/i.test(name)) cat = '音响'
  else if (brand === '苹果' || /IPHONE|IPAD|MACBOOK|MAC MINI|AIRPODS|APPLE TV|HOMEPOD/.test(up)) cat = '苹果配件'
  else if (/INTEL|RTX|GTX|金士顿|西部数据|NF-HCSAM|I5-|I7-|I9-/.test(up) || ['Intel', '金士顿', '西部数据'].includes(brand)) cat = '电脑硬件'
  else if (['Wooting', 'HyperX'].includes(brand) || /飓风|磁轴/.test(up)) cat = '键盘外设'
  else if (brand === '小米' && /^\d{1,2}(PRO|ULTRA|S)?$/i.test(model)) cat = '手机'
  else if (parseSpec(note, model) || MONITOR_BRANDS.has(brand) || (brand === '小米' && /^[A-Z]?\d{2,3}[A-Z]{1,3}|G\s?PRO/i.test(model))) cat = '显示器'
  const big = TAX.find((t) => t.cats.includes(cat))?.big || UNCLS
  return { big, cat: cat || UNCLS, brand, model }
}

// ---------------- 显示器三路分流与兜底/防呆前端即时计算 ----------------
const SUPER_T1 = new Set(['LG', '三星', 'ROG'])
const T1 = new Set(['AOC', '飞利浦', '优派', '华硕', '微星', '宏碁', '技嘉', '戴尔', '外星人', '明基', '联想', '惠普'])
const BUCKET_MEDIANS = {
  'super:office_1k': 310, 't1:office_1k': 268, 't2:office_1k': 215,
  'super:office_2k': 495, 't1:office_2k': 438, 't2:office_2k': 355,
  'super:office_4k': 880, 't1:office_4k': 735, 't2:office_4k': 585,
  'super:1k_180': 465, 't1:1k_180': 395, 't2:1k_180': 328,
  'super:2k_180': 790, 't1:2k_180': 685, 't2:2k_180': 518,
  'super:1k_240': 660, 't1:1k_240': 565, 't2:1k_240': 435,
  'super:2k_240': 980, 't1:2k_240': 865, 't2:2k_240': 688
}
const BASE_BUY = { office_1k: 95, office_2k: 165, office_4k: 280, '1k_180': 150, '2k_180': 250, '1k_240': 250, '2k_240': 400 }

export function panelGroupOf(panelRaw) {
  const u = String(panelRaw || '').toUpperCase()
  if (u.includes('OLED') && !u.includes('MINI') && !u.includes('QLED')) return '真OLED (WOLED/QD-OLED)'
  if (u.includes('MINI')) return 'Mini LED 背光 LCD'
  if (u.includes('TN')) return 'TN / Fast TN 竞技'
  if (u.includes('VA')) return 'VA / Fast VA'
  if (u.includes('IPS')) return 'IPS / Fast IPS / Nano IPS'
  return '其他 LCD'
}

export function evalMonitorModel(brand, model, spec, crawledPrice) {
  if (!spec) {
    if (crawledPrice && crawledPrice <= 1000) {
      return {
        track: 'volume_95',
        trackShort: '95% 走量款 (≤¥1000·套基准兜底)',
        specBucketLabel: '在库走量款(待补细参)',
        panelGroup: '常规 LCD',
        buyBaseline: Math.round(crawledPrice * 0.52),
        fallbackPrice: crawledPrice,
        effectivePrice: crawledPrice,
        priceState: '实爬正常',
        sanityWarn: ''
      }
    }
    return {
      track: crawledPrice && crawledPrice > 1000 ? 'highend_5' : 'unknown',
      trackShort: crawledPrice && crawledPrice > 1000 ? '5% 高端款 (>¥1000·按实爬算)' : '规格待补',
      specBucketLabel: '规格待补',
      panelGroup: '未知面板',
      buyBaseline: null,
      fallbackPrice: null,
      effectivePrice: crawledPrice || null,
      priceState: crawledPrice ? '实爬正常' : '缺规格无价',
      sanityWarn: ''
    }
  }
  const mUp = String(model || '').toUpperCase()
  const pGrp = panelGroupOf(spec.panel)
  const isOled = pGrp.startsWith('真OLED')
  const hz = Number(spec.hz || 0) // 直接按超频最高刷新率归档！
  const resKey = spec.res === '1080P' ? '1K' : spec.res

  // 1) 卓威 ZOWIE 独立价格体系
  if (brand === '卓威 ZOWIE' || /^(XL\d{4}|XQ\d{4})/i.test(mUp)) {
    const buy = hz >= 360 ? 1950 : hz >= 240 ? (/2546K|2746K/.test(mUp) ? 1180 : /2546X/.test(mUp) ? 1650 : 780) : 420
    const fb = Math.round(buy * 1.52)
    const blocked = crawledPrice && crawledPrice < Math.max(420, buy * 0.72)
    return {
      track: 'zowie',
      trackShort: '卓威 ZOWIE 独立体系',
      specBucketLabel: `卓威独立档 (${resKey}·${hz}Hz)`,
      panelGroup: pGrp,
      buyBaseline: buy,
      fallbackPrice: fb,
      effectivePrice: blocked ? fb : (crawledPrice || fb),
      priceState: blocked ? '异常低价拦截' : crawledPrice ? '实爬正常' : '卓威表参考',
      sanityWarn: blocked ? `实爬 ¥${crawledPrice} 低于卓威独立底线 ¥${buy}，疑似混入无DyAc老款或配件` : ''
    }
  }

  const bMult = SUPER_T1.has(brand) ? 1.5 : T1.has(brand) ? 1.3 : 1.0
  const bKey = SUPER_T1.has(brand) ? 'super' : T1.has(brand) ? 't1' : 't2'
  let bucketId = null
  let bucketLabel = ''
  if ((resKey === '1K' || resKey === '2K') && !isOled && hz <= 280) {
    if (hz <= 110) {
      bucketId = `office_${resKey.toLowerCase()}`
      bucketLabel = `办公低刷 · ${resKey} 60~100Hz`
    } else if (hz <= 200) {
      bucketId = `${resKey.toLowerCase()}_180`
      bucketLabel = `${resKey} · 180Hz档 (120~200Hz)`
    } else {
      bucketId = `${resKey.toLowerCase()}_240`
      bucketLabel = `${resKey} · 240Hz档 (201~280Hz)`
    }
  } else if (resKey === '4K' && !isOled && hz <= 100) {
    bucketId = 'office_4k'
    bucketLabel = '办公低刷 · 4K 60~100Hz'
  }

  // 2) 5% 高端稀缺款（市面 > ¥1000：真OLED / ≥300Hz / 4K / 带鱼超宽 / 5K）→ 不套公式，直接按闲鱼实爬算
  const isHighEnd = isOled || hz >= 300 || !bucketId || (crawledPrice && crawledPrice > 1000 && hz >= 240)
  if (isHighEnd) {
    const hiLabel = isOled ? `高端OLED · ${resKey} ${hz}Hz` : hz >= 300 ? `300Hz+超高刷 · ${resKey} ${hz}Hz` : `高分/超宽 · ${resKey} ${hz}Hz`
    const oledBuy = (resKey === '1K' || resKey === '2K') && isOled && hz >= 120 && hz <= 280
      ? Math.round(BASE_BUY[`${resKey.toLowerCase()}_${hz <= 200 ? '180' : '240'}`] * bMult * 1.5 * 2) / 2
      : null
    const blocked = crawledPrice && crawledPrice < 450
    return {
      track: 'highend_5',
      trackShort: '5% 高端款 (>¥1000·按实爬算)',
      specBucketLabel: hiLabel,
      panelGroup: pGrp,
      buyBaseline: oledBuy,
      fallbackPrice: null, // 高端款严禁套走量公式编造兜底价！
      effectivePrice: blocked ? null : (crawledPrice || null),
      priceState: blocked ? '异常低价拦截' : crawledPrice ? '实爬正常' : '高端待实爬(不套公式)',
      sanityWarn: blocked ? `高端款实爬 ¥${crawledPrice} 低于 ¥450 防呆线，疑似支架/碎屏尸体机` : ''
    }
  }

  // 3) 95% 千元内走量款 → 四档/办公基准 + 同档实爬中位价兜底 + 离谱假价防呆拦截
  const buyBase = Math.round(BASE_BUY[bucketId] * bMult * 2) / 2
  const med = BUCKET_MEDIANS[`${bKey}:${bucketId}`] || BUCKET_MEDIANS[`t2:${bucketId}`] || Math.round(buyBase * 1.85)
  const fb = Math.min(999, Math.round(med * 0.7 + buyBase * 1.85 * 0.3))
  const floor = Math.round(Math.max(buyBase * 1.08, med * 0.52))
  const blocked = crawledPrice && crawledPrice < floor

  return {
    track: 'volume_95',
    trackShort: '95% 走量款 (≤¥1000·套基准兜底)',
    specBucketLabel: bucketLabel,
    panelGroup: pGrp,
    buyBaseline: buyBase,
    fallbackPrice: fb,
    effectivePrice: blocked ? fb : (crawledPrice || fb),
    priceState: blocked ? '异常低价拦截' : crawledPrice ? '实爬正常' : '95%走量同档兜底',
    sanityWarn: blocked ? `收货底价 ¥${buyBase} / 同档中位 ¥${med}，实爬 ¥${crawledPrice} 触发防呆拦截！` : ''
  }
}

// 其他品类的预留规格槽提示（选品阶段提前留好位置，简单品类明确不折腾）
export const PRE_RESERVED_CATEGORY_SLOTS = {
  电脑硬件: { mode: 'reserved', title: '已预留「芯片组核心 × 一二线AIC品牌档 × 显存/容量」规格槽', desc: '甜点走量卡（如4060/i5/常规固态）按芯片组基准兜底与防呆，旗舰卡直接按实爬算。' },
  苹果配件: { mode: 'reserved', title: '已预留「芯片代际(M1~M4/A系) × 内存 × 存储容量 × 国行/外版锁态」规格槽', desc: '国行走量容量阶梯兜底，严防美版有锁/监管锁低价混入国行池。' },
  手机: { mode: 'reserved', title: '已预留「芯片代际 × 运存+存储 × 国行/外版」规格槽', desc: '同型号不同容量与锁态分桶清洗，防低配/有锁假低价污染。' },
  数码影像: { mode: 'reserved', title: '已预留「机身代际/套机 × 镜头卡口恒定光圈」规格槽', desc: '隔离单机身与套机、遮光罩配件价格。' },
  智能穿戴: { mode: 'reserved', title: '已预留「表盘尺寸(42/47/51mm) × 太阳能/蓝宝石版」规格槽', desc: '按表径与镜面版本细分。' },
  键盘外设: { mode: 'reserved', title: '已预留「有线/三模8K × 磁轴/传感器代际」规格槽', desc: '常规外设同模组兜底，Wooting原厂等高保值款独立按实爬算。' },
  扫地机器人: { mode: 'simple', title: '简单标品（仅十几个型号）· 保持「品牌 → 型号」极简直爬', desc: '无需复杂面板/刷新率细分，直接按型号爬闲鱼并过滤尘袋/清洁液耗材。' },
  空气净化器: { mode: 'simple', title: '简单标品 · 保持「品牌 → 型号」极简直爬', desc: '直接按组合词爬闲鱼并过滤滤芯耗材。' },
  吹风机: { mode: 'simple', title: '简单标品 · 保持「品牌 → 型号」极简直爬', desc: '直接按型号爬闲鱼并过滤风嘴/支架配件。' },
  脱毛仪: { mode: 'simple', title: '简单标品 · 保持「品牌 → 型号」极简直爬', desc: '型号极少，无需多维兜底。' },
  音响: { mode: 'simple', title: '简单标品 · 保持「品牌 → 型号」极简直爬', desc: '按品牌+型号直爬闲鱼行情。' }
}

export const daysAgo = (iso) => (iso ? Math.floor((Date.now() - new Date(iso.replace(' ', 'T')).getTime()) / 864e5) : null)

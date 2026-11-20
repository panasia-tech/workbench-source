// 纯函数：行情任务 SPU → 库存 API-SPU 主数据的精确关联，不依赖 Electron。
// 型号、品牌、名称和别称只能作为展示/搜索证据，永远不能成为关联键。

function text(value) {
  return String(value ?? '').trim()
}

/**
 * Inventory trust-boundary normalizer shared by REST and MCP sync paths.
 * Only IN_STOCK rows with a non-empty SKU enter the candidate set; duplicate
 * codes use deterministic first-write-wins semantics.
 */
export function normalizeInStockSkus(rows = []) {
  const seen = new Set()
  const result = []
  for (const raw of Array.isArray(rows) ? rows : []) {
    if (text(raw?.status).toUpperCase() !== 'IN_STOCK') continue
    const sku = text(raw?.sku_code)
    if (!sku || seen.has(sku)) continue
    seen.add(sku)
    const cleaned = {}
    for (const [key, value] of Object.entries(raw || {})) cleaned[key] = value === 'NULL' ? '' : value
    // The inventory API's current SkuOut contract exposes the product's
    // business identity as `barcode` (69/EAN-13), with some deployments also
    // retaining the barcode-library payload under `spu.Barcode`.  Normalize
    // that transport shape once at the trust boundary so every downstream
    // path consumes the same exact SPU key.  Never infer identity from brand,
    // model, or product name.
    const spuCode = canonicalSpu(raw?.spu_code || raw?.spuCode || raw?.barcode || raw?.spu?.Barcode)
    if (spuCode) cleaned.spu_code = spuCode
    result.push(cleaned)
  }
  return result
}

/**
 * Lift the server's own `detail` out of an HTTP error response.
 *
 * axios only puts "Request failed with status code 403" on `error.message`,
 * which tells an operator nothing.  The actionable half — 非管理员账号 /
 * 账号或密码错误 / 未登录 — lives in the response body and would otherwise be
 * dropped at the IPC boundary.  Redaction still runs over the result below.
 */
function httpFailureReason(error) {
  const response = error?.response
  if (!response) return ''
  const data = response.data
  const detail = typeof data === 'string' ? data : text(data?.detail || data?.message)
  const status = Number(response.status) || 0
  if (!detail) return status ? `HTTP ${status}` : ''
  return status ? `HTTP ${status}：${text(detail).slice(0, 160)}` : text(detail).slice(0, 160)
}

/** Remove credential material before an adapter error crosses the WMS IPC boundary. */
export function safeWmsErrorReason(error, fallback = 'WMS 同步失败') {
  let message = text(error?.safeReason || httpFailureReason(error) || error?.message || error?.reason || fallback)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(authorization|password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*[^\s,;)}]+/gi, '$1=[REDACTED]')
  try {
    const parsed = new URL(message)
    for (const key of [...parsed.searchParams.keys()]) {
      if (/(key|token|secret|password|passwd|auth|session|cookie)/i.test(key)) parsed.searchParams.set(key, '[REDACTED]')
    }
    message = parsed.toString()
  } catch { /* 普通错误文本不是 URL */ }
  return message.slice(0, 240) || fallback
}

// SPU 是唯一业务身份。这里只做安全的标识符规范化（去首尾空白、统一大小写），
// 不移除连字符、空格或其他字符，也不把型号/品牌当作备用键。
export function canonicalSpu(value) {
  return text(value).toUpperCase()
}

/** 主进程 API 回写的任务级门禁；返回 true 或抛出可展示的业务错误。 */
export function assertWritebackTaskReady(task = {}, skuCode = '') {
  const code = text(skuCode)
  if (!text(task?.id)) throw new Error('API 回写缺少任务 ID')
  if (!code) throw new Error('API 回写缺少 SKU')
  if (task.apiSpuAssociationStatus !== 'exact' || !task.apiSpuAssociated) throw new Error('任务必须先按 SPU 精确关联 API')
  if (canonicalSpu(task.apiSpuCode) !== canonicalSpu(task.spuCode || task.spu_code)) throw new Error('任务 SPU 与 API SPU 不一致，不能回写')
  if (Object.prototype.hasOwnProperty.call(task, 'apiSkuCount') && Number(task.apiSkuCount) !== 1 || task.apiDataConflict) throw new Error('同一 SPU 必须且只能有一个在库 SKU，或 API 字段存在冲突，请先完成 SKU/数据复核')
  if (text(task.apiSkuCode) !== code) throw new Error('回写 SKU 不是当前任务精确关联的 API SKU')
  if (task.aiReviewStatus !== 'approved') throw new Error('任务尚未完成人工复核，不能回写 API')
  if (task.lastStatus !== 'success') throw new Error('任务最近一次采集未成功，不能回写 API')
  const correctionAt = Date.parse(task.aiCorrectionAt || '')
  const lastRunAt = Date.parse(task.lastRunAt || '')
  if (Number.isFinite(correctionAt) && (!Number.isFinite(lastRunAt) || lastRunAt <= correctionAt)) {
    throw new Error('搜索信息修改后尚未完成一次成功复采，不能回写 API')
  }
  return true
}

function compactSku(sku) {
  return {
    sku_code: text(sku?.sku_code),
    spu_code: canonicalSpu(sku?.spu_code || sku?.spuCode || sku?.barcode || sku?.spu?.Barcode),
    brand: text(sku?.brand),
    model: text(sku?.model),
    product_name: text(sku?.product_name),
    spec: text(sku?.spec),
    suggest_price: text(sku?.suggest_price),
    sale_price: text(sku?.sale_price || sku?.selling_price || sku?.price),
    // 成本价：服务端只对行情工作台（MARKET_BOT）这一个设备角色放行，只读爬虫
    // 仍然拿不到。拿不到时这里是空串，下游按“缺少成本价”处理，不做任何推算。
    cost_price: text(sku?.cost_price ?? sku?.costPrice),
    status: text(sku?.status)
  }
}

function firstNonEmpty(...values) {
  return values.find((value) => text(value)) ?? ''
}

function distinctValues(rows, field) {
  return [...new Set(rows.map((row) => text(row?.[field])).filter(Boolean))]
}

/**
 * 将 SKU 级 API 返回聚合成 SPU 级主数据。
 * 同一 SPU 可以有多个在库 SKU；只要 canonical 字段一致，就作为一个 SPU 展示，
 * 并保留 sku_codes 供库存/回写审计。字段冲突不会静默挑选，而是显式标记。
 */
export function buildSpuCatalog(rows = []) {
  const groups = new Map()
  const invalidRows = []
  const source = Array.isArray(rows)
    ? rows.filter((row) => text(row?.sku_code) && text(row?.status).toUpperCase() === 'IN_STOCK')
    : []
  for (const raw of source) {
    const sku = compactSku(raw)
    const spuCode = canonicalSpu(raw?.spu_code || raw?.spuCode)
    if (!spuCode) {
      invalidRows.push(sku)
      continue
    }
    const group = groups.get(spuCode) || []
    group.push(sku)
    groups.set(spuCode, group)
  }
  const items = [...groups.entries()].map(([spuCode, group]) => {
    const primary = group[0]
    const brands = distinctValues(group, 'brand')
    const models = distinctValues(group, 'model')
    const names = distinctValues(group, 'product_name')
    const specs = distinctValues(group, 'spec')
    // 销售价和建议价是两种不同业务事实：没有 sale_price 时不能把 suggest_price
    // 冒充成“当前销售价”，否则行情回写会误读采购基准。
    const salePrices = distinctValues(group, 'sale_price')
    const suggestPrices = distinctValues(group, 'suggest_price')
    // 同一 SPU 的多个在库 SKU 成本价不同是正常的（不同批次进的货），不是数据冲突，
    // 所以**不进** api_data_conflict——那个标记会挡住商品名回写，与成本无关。
    // 但也不能静默挑一个当成本底价：底价挑错的方向是亏钱。多值时 cost_price 留空，
    // 按“缺少成本价”处理，原始值留在 cost_price_values 里供界面显示区间。
    const costPrices = distinctValues(group, 'cost_price')
    const dataConflict = brands.length > 1 || models.length > 1 || names.length > 1 || specs.length > 1 || salePrices.length > 1 || suggestPrices.length > 1
    return {
      ...primary,
      spu_code: spuCode,
      sku_codes: group.map((row) => row.sku_code),
      sku_count: group.length,
      brand: brands[0] || '',
      model: models[0] || '',
      product_name: names[0] || '',
      spec: specs[0] || '',
      sale_price: salePrices.length === 1 ? salePrices[0] : '',
      sale_price_values: salePrices,
      suggest_price: suggestPrices.length === 1 ? suggestPrices[0] : '',
      suggest_price_values: suggestPrices,
      cost_price: costPrices.length === 1 ? costPrices[0] : '',
      cost_price_values: costPrices,
      api_data_conflict: dataConflict,
      data_quality_status: dataConflict ? 'conflict' : 'clean'
    }
  })
  return {
    items,
    invalidRows,
    bySpu: new Map(items.map((item) => [item.spu_code, item]))
  }
}

function asSpuCatalog(source) {
  if (source && source.bySpu instanceof Map && Array.isArray(source.items)) return source
  return buildSpuCatalog(source)
}

function associationFailure(status, reason) {
  return {
    associated: false,
    associationStatus: status,
    dataQualityStatus: 'unknown',
    associationPercent: null,
    reason,
    apiSkuCodes: [],
    apiDataConflict: false
  }
}

/**
 * 任务和 API 主数据只能按 SPU 精确关联。
 * 注意：绝不使用品牌、型号、名称、别称或包含关系作为备用键。
 */
export function matchTaskToSku(task = {}, skus = []) {
  const taskSpu = canonicalSpu(task.spu_code || task.spuCode)
  const catalog = asSpuCatalog(skus)
  if (!taskSpu) return associationFailure('missing_spu', '任务缺少 SPU，未执行其他字段匹配')
  if (!catalog.items.length && !catalog.invalidRows.length) return associationFailure('api_not_synced', 'API-SPU 尚未同步')
  const item = catalog.bySpu.get(taskSpu)
  if (!item) return associationFailure('spu_not_found', `API 中不存在 SPU：${taskSpu}`)
  return {
    associated: true,
    // SPU 身份相等就是 100% 精确关联。SKU 字段冲突是数据质量问题，不能
    // 改写成“匹配失败”，否则会再次引入旧的模糊匹配语义。
    associationStatus: 'exact',
    associationPercent: 100,
    dataQualityStatus: item.data_quality_status || 'clean',
    ...item,
    reason: item.api_data_conflict ? 'SPU 已精确关联，但 API 同一 SPU 的字段存在冲突' : ''
  }
}

/** 给单个任务附加 API-SPU 关联字段。旧 wms 字段只在持久化历史中兼容读取，不再生成。 */
export function decorateTaskWithWms(task = {}, skus = []) {
  const association = matchTaskToSku(task, skus)
  const cleanTask = { ...task }
  return {
    ...cleanTask,
    apiSpuAssociationStatus: association.associationStatus,
    apiSpuAssociationPercent: association.associationPercent,
    apiSpuAssociated: association.associated,
    apiSpuAssociationReason: association.reason || '',
    apiSpuDataQualityStatus: association.dataQualityStatus || 'unknown',
    apiSkuCodes: association.apiSkuCodes || association.sku_codes || [],
    apiSkuCount: Number(association.sku_count) || 0,
    apiSpuCode: association.spu_code || null,
    apiSkuCode: association.sku_code || null,
    apiBrand: association.brand || null,
    apiModel: association.model || null,
    apiProductName: association.product_name || null,
    apiSpec: association.spec || null,
    apiSalePrice: association.sale_price || null,
    apiSalePriceValues: association.sale_price_values || [],
    apiSuggestPrice: association.suggest_price || null,
    apiSuggestPriceValues: association.suggest_price_values || [],
    apiCostPrice: association.cost_price || null,
    apiCostPriceValues: association.cost_price_values || [],
    apiDataConflict: Boolean(association.api_data_conflict)
  }
}

/** 运行结果使用的精简 API-SPU 关联摘要。 */
export function wmsMatchSummary(task = {}, skus = []) {
  const association = matchTaskToSku(task, skus)
  if (!association.associated) return {
    associated: false,
    associationStatus: association.associationStatus,
    associationPercent: null,
    reason: association.reason || ''
  }
  return {
    associated: true,
    associationStatus: association.associationStatus,
    dataQualityStatus: association.dataQualityStatus || 'unknown',
    associationPercent: 100,
    sku_code: association.sku_code,
    sku_codes: association.sku_codes,
    sku_count: association.sku_count,
    spu_code: association.spu_code,
    brand: association.brand,
    model: association.model,
    product_name: association.product_name,
    spec: association.spec,
    sale_price: association.sale_price,
    suggest_price: association.suggest_price,
    cost_price: association.cost_price,
    sale_price_values: association.sale_price_values,
    suggest_price_values: association.suggest_price_values,
    cost_price_values: association.cost_price_values,
    api_data_conflict: Boolean(association.api_data_conflict),
    reason: association.reason || ''
  }
}

// MCP query_database 的文本结果解析（服务端返回：列: c1, c2\n返回 N 行\n\n行1\t列2...）。
// 纯函数，供同步通道与离线回归共用。
export function parseMcpQueryResult(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim())
  if (!lines.length || !lines[0].startsWith('列:')) return []
  const cols = lines[0].slice(2).split(',').map((column) => column.trim())
  const rows = []
  for (const line of lines.slice(2)) {
    if (!line) continue
    const parts = line.split('\t')
    const row = {}
    cols.forEach((column, index) => { row[column] = parts[index] ?? '' })
    rows.push(row)
  }
  return rows
}

// ---------- 品牌本地补全 ----------
// 后端 sku.brand 常为空（API 也不允许写该字段），巡航台同步时从商品名/型号识别品牌；
// 只有命中明确品牌关键词才补，识别不到留空，不猜测。
const BRAND_PATTERNS = [
  { name: '泰坦军团', pat: /泰坦军团/i }, { name: '机械军团', pat: /机械军团/i }, { name: '坦克军团', pat: /坦克军团/i },
  { name: '哈曼卡顿', pat: /哈曼卡顿/i }, { name: '飞利浦', pat: /飞利浦/i }, { name: '创维', pat: /创维/i },
  { name: '海信', pat: /海信/i }, { name: '华硕', pat: /华硕/i }, { name: '微星', pat: /微星|MSI/i },
  { name: '小米', pat: /小米|米家/i }, { name: '红米', pat: /红米|REDMI/i }, { name: '盛色', pat: /盛色/i },
  { name: '机械师', pat: /机械师/i }, { name: '科睿', pat: /科睿|科瑞|KOORUI/i }, { name: '柯睿', pat: /柯睿/i },
  { name: '熊猫', pat: /熊猫/i }, { name: '优派', pat: /优派|VIEWSONIC/i }, { name: '明基', pat: /明基|BENQ/i },
  { name: '宏碁', pat: /宏碁|ACER/i }, { name: '戴尔', pat: /戴尔|DELL/i }, { name: '联想', pat: /联想|LENOVO/i },
  { name: '雷神', pat: /雷神/i }, { name: '三星', pat: /三星|SAMSUNG/i }, { name: 'AOC', pat: /\bAOC/i },
  { name: 'HKC', pat: /\bHKC/i }, { name: 'KTC', pat: /\bKTC/i }, { name: 'SANC', pat: /\bSANC/i },
  { name: 'LG', pat: /\bLG/i }, { name: 'SONOS', pat: /SONOS/i },
  { name: '苹果', pat: /苹果|APPLE|AIRPODS|HOMEPOD|MACBOOK|IPHONE|IPAD|妙控|TRACKPAD|APPLETV|MAC/i },
  { name: '金士顿', pat: /金士顿|KINGSTON|飓风/i },
  { name: 'Intel', pat: /INTEL|I[3-9]-\d/i }, { name: 'ROG', pat: /ROG/i }, { name: 'ASUS', pat: /\bASUS/i },
  { name: '佳明', pat: /佳明|GARMIN/i }, { name: '戴森', pat: /戴森|DYSON/i }, { name: '西部数据', pat: /西数|西部数据/i },
  { name: 'Ulike', pat: /ULIKE/i }, { name: '云鲸', pat: /云鲸/i }, { name: 'Wooting', pat: /WOOTING/i },
  { name: 'HyperX', pat: /HYPERX/i }, { name: '索尼', pat: /索尼|SONY/i }, { name: '惠普', pat: /惠普|\bHP/i }, { name: '罗技', pat: /罗技|LOGITECH/i }
]
const BRAND_PREFIX = [
  { name: 'AOC', pat: /^\d{2}(?:G|H|P|X|Q|V|N|T|M|C|S|K)\d{2,}/i },
  { name: 'HKC', pat: /^G\d{2}H\d|^VG2(?:5[35]|4[0-9])/i },
  { name: '华硕', pat: /^(?:VG|XG|PG|TUF|MG|PA)\d/i },
  { name: 'LG', pat: /^LG\d/i },
  { name: '苹果', pat: /^(?:HOMEPOD|AIRPODS|APPLETV|MAC)/i },
  { name: 'SANC', pat: /^SANC/i },
  { name: 'SONOS', pat: /^SONOS/i }
]

export function deriveSkuBrand(sku = {}) {
  const orig = String(sku.brand || '').trim()
  const known = BRAND_PATTERNS.find((b) => b.name.toLowerCase() === orig.toLowerCase())
  if (known) return known.name
  const name = String(sku.product_name || '').toLowerCase()
  const model = String(sku.model || '').toLowerCase()
  for (const b of BRAND_PATTERNS) if (b.pat.test(name) || b.pat.test(model)) return b.name
  for (const b of BRAND_PREFIX) if (b.pat.test(name) || b.pat.test(model)) return b.name
  return ''
}

/** 同步时修正品牌：已知品牌大小写归一化；原品牌为空或明显是垃圾值（夹型号/超长）且能识别时用识别结果覆盖。 */
export function enrichSkuBrand(sku = {}) {
  const current = String(sku.brand || '').trim()
  const known = BRAND_PATTERNS.find((b) => b.name.toLowerCase() === current.toLowerCase())
  if (known) return { ...sku, brand: known.name }
  // 垃圾品牌：夹带型号/数字、或超长（如员工把商品名整个填进品牌字段）
  const junk = !current || current.length > 32 || /[A-Za-z\u4e00-\u9fa5]+\d|\d+[A-Za-z\u4e00-\u9fa5]/.test(current)
  if (!junk) return sku
  const derived = deriveSkuBrand(sku)
  return derived ? { ...sku, brand: derived } : sku
}

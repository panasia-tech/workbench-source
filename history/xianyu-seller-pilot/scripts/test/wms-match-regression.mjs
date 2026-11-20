import assert from 'node:assert/strict'
import { buildSpuCatalog, decorateTaskWithWms, deriveSkuBrand, enrichSkuBrand, matchTaskToSku, normalizeInStockSkus, parseMcpQueryResult, wmsMatchSummary } from '../../src/main/wms-match.js'

const skus = [
  { sku_code: 'SKU-001', spu_code: 'SPU-001', brand: '创维', model: '24G30F', product_name: '创维 24 寸显示器', spec: '1K 180HZ', suggest_price: '899', status: 'IN_STOCK' },
  { sku_code: 'SKU-002', spu_code: 'SPU-002', brand: '飞利浦', model: '242M8', product_name: '飞利浦 24 寸显示器', spec: '1K 165HZ', sale_price: '799', suggest_price: '899', status: 'IN_STOCK' },
  { sku_code: 'SKU-003', spu_code: 'SPU-001', brand: '创维', model: '24G30F', product_name: '创维 24 寸显示器', spec: '1K 180HZ', suggest_price: '929', status: 'SHIPPED' },
  { sku_code: 'SKU-004', brand: 'SANC', model: 'G4', product_name: 'SANC 显示器', spec: '', suggest_price: '699', status: 'IN_STOCK' }
]

const catalog = buildSpuCatalog(skus)
assert.equal(catalog.items.length, 2, 'SPU 主表只收录在库且有 SPU 的 API 行')
assert.equal(catalog.invalidRows.length, 1, '缺失 SPU 的 API 行保留为数据异常证据')
assert.equal(catalog.bySpu.get('SPU-001').sku_count, 1, '出库 SKU 不应进入在库 SPU 聚合')

// 当前库存 API 的 SkuOut 使用 69 码作为业务身份，不保证返回 spu_code；
// 同时兼容历史 spu_code/spuCode 和条码库嵌套的 spu.Barcode，但绝不使用品牌/型号兜底。
const apiShapeRows = normalizeInStockSkus([
  { sku_code: 'API-SKU-001', status: 'IN_STOCK', spu_code: 'spu-explicit', spuCode: 'spu-alias', barcode: '690000000001', spu: { Barcode: '690000000099' } },
  { sku_code: 'API-SKU-002', status: 'IN_STOCK', spuCode: 'spu-alias-only', barcode: '690000000002', spu: { Barcode: '690000000098' } },
  { sku_code: 'API-SKU-003', status: 'IN_STOCK', barcode: '690000000003', spu: { Barcode: '690000000097' } },
  { sku_code: 'API-SKU-004', status: 'IN_STOCK', spu: { Barcode: '690000000004' }, brand: '不要作为身份', model: '不要作为身份' },
  { sku_code: 'API-SKU-005', status: 'IN_STOCK', brand: '不要作为身份', model: '不要作为身份' }
])
assert.equal(apiShapeRows[0].spu_code, 'SPU-EXPLICIT', '优先使用 API 已有 spu_code')
assert.equal(apiShapeRows[1].spu_code, 'SPU-ALIAS-ONLY', '兼容 camelCase spuCode')
assert.equal(apiShapeRows[2].spu_code, '690000000003', '无 spu_code 时使用顶层 69 码 barcode')
assert.equal(apiShapeRows[3].spu_code, '690000000004', '无顶层条码时使用嵌套 spu.Barcode')
assert.equal('spu_code' in apiShapeRows[4], false, '缺少所有 SPU/69码字段时不按品牌型号猜测')
const apiShapeCatalog = buildSpuCatalog(apiShapeRows)
assert.equal(apiShapeCatalog.bySpu.get('690000000004').sku_code, 'API-SKU-004', '当前 API 响应形状可按 69 码精确归一化')

// SPU 相同就是唯一的 100% 关联；品牌和型号不参与决策。
const exact = matchTaskToSku({ brand: '完全不同的品牌', model: '错误型号', spuCode: ' spu-001 ' }, skus)
assert.equal(exact.associated, true)
assert.equal(exact.associationStatus, 'exact')
assert.equal(exact.associationPercent, 100)
assert.equal(exact.spu_code, 'SPU-001')
assert.equal(exact.sku_code, 'SKU-001')

// 错误/不存在的 SPU 不能跨 SPU，也不能按型号兜底。
const wrongSpu = matchTaskToSku({ brand: '创维', model: '24G30F', spuCode: 'SPU-999' }, skus)
assert.equal(wrongSpu.associated, false)
assert.equal(wrongSpu.associationStatus, 'spu_not_found')
const missingSpu = matchTaskToSku({ brand: '创维', model: '24G30F' }, skus)
assert.equal(missingSpu.associated, false)
assert.equal(missingSpu.associationStatus, 'missing_spu')
assert.match(missingSpu.reason, /缺少 SPU/)
assert.equal(matchTaskToSku({}, []).associationStatus, 'missing_spu')
assert.equal(matchTaskToSku({ spuCode: 'SPU-001' }, []).associationStatus, 'api_not_synced')

// 结果对象不再暴露旧匹配方式、候选货号或置信度。
for (const result of [exact, wrongSpu, missingSpu]) {
  assert.equal('matchMethod' in result, false)
  assert.equal('candidateCount' in result, false)
  assert.equal('candidates' in result, false)
  assert.equal('confidence' in result, false)
}
const decorated = decorateTaskWithWms({ id: 't1', brand: '创维', model: '24G30F', spuCode: 'SPU-001' }, skus)
assert.equal(decorated.apiSpuAssociated, true)
assert.equal(decorated.apiSpuAssociationStatus, 'exact')
assert.equal(decorated.apiSpuAssociationPercent, 100)
assert.equal(decorated.apiSpuCode, 'SPU-001')
assert.equal(decorated.apiSkuCode, 'SKU-001')
assert.equal('wmsCandidates' in decorated, false)
assert.equal('wmsMatchMethod' in decorated, false)

const summary = wmsMatchSummary({ spuCode: 'SPU-002' }, skus)
assert.equal(summary.associated, true)
assert.equal(summary.associationStatus, 'exact')
assert.equal(summary.associationPercent, 100)
assert.equal(summary.spu_code, 'SPU-002')
assert.equal(summary.sale_price, '799')

// 同一 SPU 的 API 价格冲突必须显式暴露，不能静默挑一个价格。
const conflict = matchTaskToSku({ spuCode: 'SPU-010' }, [
  { sku_code: 'A', spu_code: 'SPU-010', suggest_price: '1500', status: 'IN_STOCK' },
  { sku_code: 'B', spu_code: 'SPU-010', suggest_price: '2500', status: 'IN_STOCK' }
])
assert.equal(conflict.associated, true)
assert.equal(conflict.associationStatus, 'exact')
assert.equal(conflict.dataQualityStatus, 'conflict')
assert.equal(conflict.api_data_conflict, true)
assert.equal(conflict.sale_price, '')
assert.deepEqual(conflict.suggest_price_values, ['1500', '2500'])

// 成本价：服务端只对行情工作台（MARKET_BOT）放行 cost_price，拿到就一路带到 SPU 主表，
// 因为调价的成本底价要用它。拿不到（只读爬虫角色）时是空串，不能被推算出来。
const costRows = [
  { sku_code: 'C1', spu_code: 'SPU-020', cost_price: '1200.00', suggest_price: '1899', status: 'IN_STOCK' },
  { sku_code: 'C2', spu_code: 'SPU-020', cost_price: '1200.00', suggest_price: '1899', status: 'IN_STOCK' }
]
const costMatch = matchTaskToSku({ spuCode: 'SPU-020' }, costRows)
assert.equal(costMatch.cost_price, '1200.00', '同一 SPU 的在库 SKU 成本一致时按成本价展示')
assert.deepEqual(costMatch.cost_price_values, ['1200.00'])
assert.equal(costMatch.api_data_conflict, false)
assert.equal(decorateTaskWithWms({ id: 'c', spuCode: 'SPU-020' }, costRows).apiCostPrice, '1200.00')
assert.equal(wmsMatchSummary({ spuCode: 'SPU-020' }, costRows).cost_price, '1200.00')

// 不同批次进货成本不同是正常业务事实，不是数据冲突：它不能挡住商品名回写
// （api_data_conflict 是回写门禁），但也不能静默挑一个当成本底价——挑错的方向是亏钱。
const mixedCost = matchTaskToSku({ spuCode: 'SPU-021' }, [
  { sku_code: 'D1', spu_code: 'SPU-021', cost_price: '1000', status: 'IN_STOCK' },
  { sku_code: 'D2', spu_code: 'SPU-021', cost_price: '1400', status: 'IN_STOCK' }
])
assert.equal(mixedCost.api_data_conflict, false, '成本价不同不应被判成 API 数据冲突')
assert.equal(mixedCost.dataQualityStatus, 'clean')
assert.equal(mixedCost.cost_price, '', '多个不同成本价时不自动选取')
assert.deepEqual(mixedCost.cost_price_values, ['1000', '1400'], '原始值保留供界面显示区间')

// 服务端把 cost_price 声明为 Decimal，序列化成数字还是字符串取决于框架版本；
// 归一化必须两种都吃下，否则换个序列化行为成本价就整片消失。
const numericCost = matchTaskToSku({ spuCode: 'SPU-023' }, normalizeInStockSkus([
  { sku_code: 'F1', spu_code: 'SPU-023', cost_price: 1200.5, status: 'IN_STOCK' }
]))
assert.equal(numericCost.cost_price, '1200.5')

// 服务端脱敏（只读爬虫角色）时字段直接缺席，不能凭建议价/销售价推算成本。
const maskedCost = matchTaskToSku({ spuCode: 'SPU-022' }, [
  { sku_code: 'E1', spu_code: 'SPU-022', suggest_price: '1899', sale_price: '1799', status: 'IN_STOCK' }
])
assert.equal(maskedCost.cost_price, '')
assert.deepEqual(maskedCost.cost_price_values, [])

// MCP 文本结果解析仍是同步适配器的纯函数。
const parsed = parseMcpQueryResult('列: sku_code, brand, model\n返回 2 行\n\nSKU-001\t创维\t24G30F\nSKU-002\t飞利浦\t242M8')
assert.equal(parsed.length, 2)
assert.equal(parsed[0].sku_code, 'SKU-001')
assert.equal(parsed[1].model, '242M8')
assert.equal(parseMcpQueryResult('no header').length, 0)
assert.equal(parseMcpQueryResult('').length, 0)

// 品牌补全只用于 API 展示，不参与 SPU 关联。
assert.equal(deriveSkuBrand({ product_name: 'vg258qm' }), '华硕')
assert.equal(deriveSkuBrand({ product_name: 'hkcg24h3s' }), 'HKC')
assert.equal(deriveSkuBrand({ product_name: 'aoc24g10ze' }), 'AOC')
assert.equal(deriveSkuBrand({ product_name: '泰坦军团p2710s' }), '泰坦军团')
assert.equal(deriveSkuBrand({ product_name: '小米空气净化器4' }), '小米')
assert.equal(deriveSkuBrand({ product_name: 'unknownxyz123' }), '')
assert.equal(enrichSkuBrand({ sku_code: 'X1', brand: '', product_name: 'sonos play5' }).brand, 'SONOS')
assert.equal(enrichSkuBrand({ sku_code: 'X2', brand: 'AOC', product_name: 'garbage' }).brand, 'AOC')
assert.equal(enrichSkuBrand({ sku_code: 'X3', brand: 'aoc', product_name: 'aoc 24g11ze' }).brand, 'AOC')

console.log('API-SPU association regression: passed (exact identity/missing/not-found/catalog conflict + cost price passthrough + adapter parsing + brand display enrichment)')

// V1 xianyu-seller-pilot 价格筛选与两步直发辅助常量（机器五重初筛 → 员工确认/修改/作废重爬 → 直接上架）
export const REJECTION_META = {
  blacklist: { label: '屏蔽词命中', cls: 'red' },
  relevance: { label: '非目标型号', cls: 'amb' },
  below_spu_min_price: { label: '低于SPU下限', cls: 'amb' },
  above_spu_max_price: { label: '高于SPU上限', cls: 'amb' },
  low_price: { label: '<100元引流价', cls: 'red' },
  over_maximum: { label: '防拍异常占位价', cls: 'red' },
  manual_exclude: { label: '人工剔除', cls: 'red' }
}

export const TIER_OPTIONS = [
  { key: 'strict', label: '严格档 (≥0.72)', desc: '只保留高置信同型号净图' },
  { key: 'balanced', label: '平衡档 (≥0.62)', desc: '默认档：兼顾准确度与张数' },
  { key: 'broad', label: '宽松档 (≥0.55)', desc: '冷门型号放宽召回更多候选' }
]

export function stepLabel(step) {
  if (step === 'waiting_crawl') return '待抓取闲鱼快照'
  if (step === 'active') return '已确认生效'
  return '机器已初筛 · 待确认'
}

export function classifyPurchasePct(price, cost) {
  const p = Number(price || 0)
  const c = Number(cost || 0)
  if (!p || !c) return { lvl: 'amb', text: '待核对成本与售价' }
  const pct = Math.round((p / c) * 100)
  if (p < c) return { lvl: 'red', text: `低于采购成本 ¥${c}（占 ${pct}% · 价格围栏拦截）` }
  if (pct < 120) return { lvl: 'amb', text: `采购价 100%~119% 档（占成本 ${pct}% · 毛利偏薄）` }
  if (pct < 150) return { lvl: 'grn', text: `采购价 120%+ 正常档 ✓（占成本 ${pct}%）` }
  if (pct < 200) return { lvl: 'grn', text: `采购价 150%+ 优质档 ✓（占成本 ${pct}%）` }
  return { lvl: 'grn', text: `采购价 200%+ 档 ✓（占成本 ${pct}% · 请确认未多输零）` }
}

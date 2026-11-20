// 行情结果落盘瘦身：去掉重复/冗余的大对象，避免每次写盘都在整份重写 8~9MB 文件。
// 纯函数，可独立回归。

// 只保留 UI「看构成」真正用到的字段，丢弃重复明细。
export function slimPriceBreakdown(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') return breakdown
  const { allPrices, includedListings, ...core } = breakdown
  return core
}

export function slimResultRow(row) {
  if (!row || typeof row !== 'object') return row
  const { raw, priceBreakdown, ...rest } = row
  return { ...rest, priceBreakdown: slimPriceBreakdown(priceBreakdown) }
}

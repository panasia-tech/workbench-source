export function formatPriceYuan(priceInCent) {
  const n = Number(priceInCent)
  if (!Number.isFinite(n)) return '0.00'
  return (n / 100).toFixed(2)
}

export function buildSkuModel(skuList) {
  const list = Array.isArray(skuList) ? skuList : []
  const dimMap = new Map()
  const skus = []

  for (const sku of list) {
    const props = {}
    const parts = []
    const propertyList = Array.isArray(sku.propertyList) ? sku.propertyList : []
    for (const p of propertyList) {
      const propId = String(p.propertyId ?? '')
      const propName = String(p.propertyText || p.propertyName || '规格').trim()
      const valueText = String(p.valueText || p.actualValueText || '').trim()
      if (!propId || !valueText) continue
      props[propId] = valueText
      parts.push(valueText)
      if (!dimMap.has(propId)) {
        dimMap.set(propId, { key: `prop_${propId}`, name: propName, values: new Set() })
      }
      dimMap.get(propId).values.add(valueText)
    }
    const quantity = Number(sku.quantity) || 0
    skus.push({
      skuId: String(sku.skuId ?? ''),
      priceInCent: Number(sku.priceInCent ?? sku.price) || 0,
      priceYuan: formatPriceYuan(sku.priceInCent ?? sku.price),
      quantity,
      inStock: quantity > 0,
      label: parts.join(' / ') || `SKU ${sku.skuId}`,
      props,
      propertyList: propertyList.map((p) => ({
        propertyId: String(p.propertyId),
        propertyText: p.propertyText,
        valueText: p.valueText || p.actualValueText
      }))
    })
  }

  const dimensions = [...dimMap.values()].map((d) => ({
    key: d.key,
    name: d.name,
    values: [...d.values]
  }))

  return { dimensions, skus }
}

const MONEY_FIELDS = new Set([
  'amount',
  'unit_price',
  'sale_price',
  'express_fee',
  'platform_fee',
  'price',
  'original_price',
  'actual_amount',
])

function sanitizeDecimal(value, maxDecimals = 2) {
  if (value == null || value === '') return ''
  let text = String(value).replace(/[^\d.]/g, '')
  const dotIndex = text.indexOf('.')
  if (dotIndex !== -1) {
    const intPart = text.slice(0, dotIndex)
    const decPart = text.slice(dotIndex + 1).replace(/\./g, '')
    text = `${intPart}.${decPart.slice(0, maxDecimals)}`
  }
  if (text.startsWith('.')) text = `0${text}`
  return text
}

function sanitizeMoneyField(key, value) {
  return MONEY_FIELDS.has(key) ? sanitizeDecimal(value) : value
}

module.exports = { sanitizeDecimal, sanitizeMoneyField, MONEY_FIELDS }

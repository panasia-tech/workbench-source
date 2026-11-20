/** @typedef {'dingtalk_click' | 'auto'} GreetingDeliveryMode */

/**
 * @param {unknown} v
 * @returns {GreetingDeliveryMode}
 */
export function normalizeGreetingDeliveryMode(v) {
  return String(v == null ? '' : v).trim().toLowerCase() === 'auto' ? 'auto' : 'dingtalk_click'
}

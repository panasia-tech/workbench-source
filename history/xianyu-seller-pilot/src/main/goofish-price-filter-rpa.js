// 闲鱼页面价格筛选的最小 RPA 适配器。
// 页面筛选只是减少页面候选，最终价格仍必须经过 goofish.js 的程序侧围栏。

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)))

function text(value) {
  return String(value ?? '').trim()
}

function finitePrice(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function normalizePagePriceFilter(value = {}) {
  const source = value && typeof value === 'object' ? value : {}
  const min = finitePrice(source.minListingPrice ?? source.min ?? source.minimum)
  const max = finitePrice(source.maxListingPrice ?? source.max ?? source.maximum)
  const boundedMin = min !== null && min <= 10_000_000 ? min : null
  const boundedMax = max !== null && max <= 10_000_000 ? max : null
  return {
    enabled: source.enabled === true,
    minListingPrice: boundedMin !== null && boundedMax !== null && boundedMin > boundedMax ? null : boundedMin,
    maxListingPrice: boundedMin !== null && boundedMax !== null && boundedMin > boundedMax ? null : boundedMax
  }
}

export function pageFilterScript(filter = {}) {
  const policy = normalizePagePriceFilter(filter)
  const encoded = JSON.stringify(policy)
  return `(() => {
    const policy = ${encoded};
    const compact = (value) => String(value || '').replace(/\\s+/g, '').toLowerCase();
    const textOf = (node) => String(node?.innerText || node?.textContent || '').replace(/\\s+/g, ' ').trim();
    const priceInput = Array.from(document.querySelectorAll('input')).find((input) => {
      const label = compact(input.getAttribute('aria-label') || input.placeholder || input.name || '');
      return /价格|price|最低|最高|min|max/.test(label);
    });
    const inputs = Array.from(document.querySelectorAll('input')).filter((input) => {
      const label = compact(input.getAttribute('aria-label') || input.placeholder || input.name || '');
      return /价格|price|最低|最高|min|max/.test(label);
    }).slice(0, 2);
    const buttons = Array.from(document.querySelectorAll('button,[role="button"],a')).filter((node) => /筛选|价格|确认|确定|完成/.test(textOf(node)));
    return {
      requested: policy.enabled,
      filterVisible: Boolean(priceInput || inputs.length || buttons.length),
      inputCount: inputs.length,
      inputs: inputs.map((input) => ({ placeholder: input.placeholder || '', value: input.value || '' })),
      confirmCount: buttons.length,
      bodySample: textOf(document.body).slice(0, 240)
    };
  })()`
}

function isFocused(wc) {
  if (typeof wc?.isFocused === 'function' && wc.isFocused()) return true
  const owner = typeof wc?.getOwnerBrowserWindow === 'function' ? wc.getOwnerBrowserWindow() : null
  return Boolean(owner && typeof owner.isFocused === 'function' && owner.isFocused())
}

async function evaluate(wc, script) {
  if (typeof wc?.executeJavaScript !== 'function') throw new Error('页面不支持脚本执行')
  return wc.executeJavaScript(script, true)
}

async function dispatchClick(wc, target) {
  const script = `(() => { const nodes = Array.from(document.querySelectorAll('button,[role="button"],a')); const node = nodes.find((item) => String(item.innerText || item.textContent || '').includes(${JSON.stringify(target)})); if (!node) return { ok: false, reason: 'not_found' }; node.click(); return { ok: true }; })()`
  const result = await evaluate(wc, script)
  if (result?.ok) return result
  if (isFocused(wc) && typeof wc?.sendInputEvent === 'function') {
    return { ok: false, reason: 'not_found', inputFallback: false }
  }
  return result || { ok: false, reason: 'not_found' }
}

export async function applyPagePriceFilter(wc, filter = {}, { timeoutMs = 2500, waitMs = 350 } = {}) {
  const policy = normalizePagePriceFilter(filter)
  const startedAt = new Date().toISOString()
  if (!policy.enabled) return { requested: false, applied: false, verified: false, status: 'not_requested', reasonCode: 'page_filter_not_requested', startedAt }
  if (!wc || typeof wc.executeJavaScript !== 'function') return { requested: true, applied: false, verified: false, status: 'blocked', reasonCode: 'page_filter_adapter_unavailable', reason: '当前页面没有可用 CDP/Runtime 执行能力', startedAt }
  try {
    const before = await Promise.race([evaluate(wc, pageFilterScript(policy)), sleep(timeoutMs).then(() => null)])
    if (!before?.filterVisible) return { requested: true, applied: false, verified: false, status: 'blocked', reasonCode: 'page_filter_control_not_found', reason: '未定位到闲鱼价格筛选控件', before, startedAt }
    const values = [policy.minListingPrice, policy.maxListingPrice].filter((value) => value !== null)
    if (!values.length) return { requested: true, applied: false, verified: false, status: 'blocked', reasonCode: 'page_filter_bounds_missing', reason: '页面价格筛选缺少最低或最高挂牌价', before, startedAt }
    const filled = await evaluate(wc, `(() => { const values = ${JSON.stringify(values)}; const inputs = Array.from(document.querySelectorAll('input')).filter((input) => /价格|price|最低|最高|min|max/i.test(String(input.getAttribute('aria-label') || input.placeholder || input.name || ''))).slice(0, 2); inputs.forEach((input, index) => { if (values[index] == null) return; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; setter?.call(input, String(values[index])); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }); return { inputCount: inputs.length, filledCount: Math.min(inputs.length, values.length) }; })()`)
    if (!filled || filled.filledCount < values.length) return { requested: true, applied: false, verified: false, status: 'blocked', reasonCode: 'page_filter_input_failed', reason: '价格筛选输入框数量不足或写入失败', before, filled, startedAt }
    const clicked = await dispatchClick(wc, '确认')
    if (!clicked?.ok) return { requested: true, applied: false, verified: false, status: 'blocked', reasonCode: 'page_filter_confirm_failed', reason: '未能确认闲鱼价格筛选', before, filled, clicked, startedAt }
    await sleep(waitMs)
    const after = await Promise.race([evaluate(wc, pageFilterScript(policy)), sleep(timeoutMs).then(() => null)])
    const verified = Boolean(after?.filterVisible && (after.inputs || []).some((input) => values.includes(Number(input.value))))
    return { requested: true, applied: verified, verified, status: verified ? 'verified' : 'unverified', reasonCode: verified ? 'page_filter_verified' : 'page_filter_state_mismatch', reason: verified ? '闲鱼页面价格筛选已定位并回读确认' : '页面筛选动作完成但状态回读不一致', before, filled, clicked, after, startedAt }
  } catch (error) {
    return { requested: true, applied: false, verified: false, status: 'blocked', reasonCode: 'page_filter_runtime_error', reason: text(error?.message || error).slice(0, 240), startedAt }
  }
}

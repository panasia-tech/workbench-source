// 在某个账号的 WebContentsView 内打开闲鱼网页版搜索页，读真实结果卡片，
// 合并 Excel 行级配置的多次搜索后清洗垃圾数据，再计算「清洗后平均挂牌价」。
// 每个 Excel 任务依次搜索该行配置的非空字段，再按商品 ID/链接合并去重；
// 没有显式字段的旧任务才走兼容的自然搜索词规则。
//
// 闲鱼网页版 DOM（2026-06 实测）：
//   真实结果： div[class*=search-container] a[class*=feeds-item-wrap]   （「猜你喜欢」在此容器之外，天然排除）
//   价格：     a 卡片内 div[class*=price-wrap] > span[class*=number](整数) + span[class*=decimal](小数)
//             （容器 innerText 会把「X人想要」热度数字粘在价格后面，故必须读子 span，不能读容器文本）
//   无在售：   body 出现「没有找到你想要的宝贝 / 减少筛选内容」→ 不取价、不上报（避免抓到猜你喜欢的脏价）

import { clearCapturedSearchPayloads, readCapturedSearchPayloads } from './search-capture.js'
import { listingPriceFenceCheck, normalizeListingPriceFence } from './price-fence.js'
import { applyPagePriceFilter } from './goofish-price-filter-rpa.js'
// 风控判据来自群控那份共用 JSON（构建期内联），不在本文件硬编码
import { riskSignalsLiteral } from './risk-anchors.js'
// 搜索结果页选择器集中在 selectors.js，改版只改那一个文件
import { selectorsLiteral } from './selectors.js'

const SEARCH_URL = (kw) => `https://www.goofish.com/search?q=${encodeURIComponent(kw)}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const RISK_CONFIRM_DELAY_MS = 350

// 判据表由构建期从群控那份共用 JSON 内联进来（见 risk-anchors.js 的说明）。
// 这段脚本跑在页面上下文里，拿不到模块作用域，所以把表序列化成字面量送进去。
const RISK_PAGE_FN = `(() => {
  // 选择器表随脚本注进页面上下文：这段跑在页面里，拿不到模块作用域。
  const S = ${selectorsLiteral()};
  const body = document.body ? (document.body.innerText || '') : '';
  const currentUrl = (() => { try { return new URL(String(location.href || '')); } catch { return null; } })();
  const url = currentUrl ? currentUrl.href : String(location.href || '');
  const signals = Object.entries(${riskSignalsLiteral()});
  const signalFor = (text) => {
    const haystack = String(text || '');
    return signals.find(([, texts]) => texts.some((t) => haystack.includes(t)))?.[0] || '';
  };
  const visible = (element) => {
    if (!element || element.getAttribute?.('aria-hidden') === 'true') return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const route = currentUrl ? (currentUrl.hostname + currentUrl.pathname).toLowerCase() : '';
  const routeHit = /(?:^|[./_-])(?:captcha|verify|punish|risk|security)(?:[./_-]|$)/.test(route);
  const candidates = Array.from(document.querySelectorAll([
    '[role="dialog"]', '[role="alert"]', '[aria-modal="true"]',
    'form', '[class*="captcha" i]', '[class*="verify" i]', '[class*="risk" i]', '[class*="punish" i]',
    '[id*="captcha" i]', '[id*="verify" i]', '[id*="risk" i]', '[id*="punish" i]'
  ].join(',')));
  const visibleHit = candidates.map((element) => {
    if (!visible(element)) return null;
    const text = String(element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
    const signal = signalFor(text);
    return signal ? { signal, text: text.slice(0, 160), tag: element.tagName?.toLowerCase() || '' } : null;
  }).find(Boolean);
  const normalContent = Boolean(document.querySelector(S.NORMAL_CONTENT));
  const titleSignal = signalFor(document.title || '');
  const bodySignal = signalFor(body);
  // 高置信整页判据：命中任一锚点，**或者**「请…安全验证」这种近距搭配。
  // 前半截原来是把锚点手抄了一遍，抄漏就是静默失效；现在走同一张表。
  const anyAnchor = signals.some(([, texts]) => texts.some((t) => body.includes(t)));
  const proximity = /请[^\\n]{0,40}(?:安全验证|滑块验证|滑动验证|验证码)|(?:安全验证|滑块验证|滑动验证|验证码)[^\\n]{0,40}(?:继续|访问|登录|重试)/.test(body);
  const highConfidencePageText = anyAnchor || proximity;
  const titlePageHit = titleSignal && !normalContent && highConfidencePageText;
  const compactPageHit = bodySignal && highConfidencePageText && body.trim().length <= 2000 && !normalContent;
  const candidate = Boolean(routeHit || visibleHit || titlePageHit || compactPageHit);
  const source = routeHit ? 'challenge-route'
    : (visibleHit ? 'visible-challenge-component'
      : (titlePageHit ? 'document-title' : (compactPageHit ? 'compact-anomaly-page' : '')));
  return {
    candidate,
    signal: routeHit ? '验证页' : (visibleHit?.signal || (titlePageHit ? titleSignal : '') || (compactPageHit ? bodySignal : '')),
    source,
    url,
    route,
    visibleText: visibleHit?.text || '',
    visibleTag: visibleHit?.tag || '',
    bodyLength: body.length,
    normalContent
  };
})()`

function comparableRiskRoute(value) {
  try {
    const url = new URL(String(value || ''))
    return `${url.origin}${url.pathname}`.toLowerCase()
  } catch {
    return String(value || '').split(/[?#]/, 1)[0].toLowerCase()
  }
}

export function confirmRiskObservations(first, second) {
  const firstCandidate = Boolean(first?.candidate)
  const secondCandidate = Boolean(second?.candidate)
  const stableRoute = comparableRiskRoute(first?.url) === comparableRiskRoute(second?.url)
  if (!firstCandidate || !secondCandidate || !stableRoute) {
    const suspected = firstCandidate || secondCandidate
    const observation = secondCandidate ? second : firstCandidate ? first : null
    return {
      riskControl: false,
      suspected,
      signal: String(observation?.signal || ''),
      source: String(observation?.source || ''),
      url: String(observation?.url || ''),
      confirmationCount: suspected ? 1 : 0
    }
  }
  return {
    riskControl: true,
    suspected: true,
    signal: String(second.signal || first.signal || '需要验证'),
    source: String(second.source || first.source || 'confirmed-page-evidence'),
    url: String(second.url || first.url || ''),
    confirmationCount: 2,
    visibleText: String(second.visibleText || first.visibleText || '').slice(0, 160),
    visibleTag: String(second.visibleTag || first.visibleTag || '').slice(0, 40)
  }
}

export async function detectRiskPage(wc, { wait = sleep } = {}) {
  try {
    const first = await executeJavaScriptWithTimeout(wc, RISK_PAGE_FN, 1800)
    if (!first?.candidate) return confirmRiskObservations(first, null)
    await wait(RISK_CONFIRM_DELAY_MS)
    const second = await executeJavaScriptWithTimeout(wc, RISK_PAGE_FN, 1800)
    return confirmRiskObservations(first, second)
  } catch {
    return null
  }
}

async function loadUrlWithTimeout(wc, url, timeoutMs = 15000) {
  let timer = null
  let timedOut = false
  const navigation = wc.loadURL(url)
  navigation.catch(() => {})
  try {
    await Promise.race([
      navigation,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true
          resolve()
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
  // 闲鱼部分响应不会及时结束 loadURL，但页面已经可以执行 DOM 查询；不能让单个任务永久等待。
  return { timedOut }
}

function executeJavaScriptWithTimeout(wc, script, timeoutMs = 2500) {
  const execution = wc.executeJavaScript(script, true)
  execution.catch(() => {})
  return Promise.race([
    execution,
    sleep(timeoutMs).then(() => null)
  ])
}

// 保存页面当前已经渲染出的 DOM，而不是拍照。脚本/iframe 被移除，避免在本地预览时再次执行闲鱼逻辑；
// 商品卡片、内联样式、样式表和当前图片地址仍然保留，员工打开后可以继续滚动查看整页结果。
const SNAPSHOT_FN = `(() => {
  const root = document.documentElement.cloneNode(true);
  root.querySelectorAll('script, noscript, iframe, object, embed, meta[http-equiv="refresh"], meta[http-equiv="Content-Security-Policy"]').forEach((node) => node.remove());
  const originalImages = Array.from(document.querySelectorAll('img'));
  const copiedImages = Array.from(root.querySelectorAll('img'));
  originalImages.forEach((image, index) => {
    const copy = copiedImages[index];
    if (!copy) return;
    if (image.currentSrc) copy.setAttribute('src', image.currentSrc);
    copy.removeAttribute('loading');
    copy.removeAttribute('decoding');
  });
  root.querySelectorAll('*').forEach((node) => {
    Array.from(node.attributes || []).forEach((attribute) => {
      if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
    });
  });
  const head = root.querySelector('head');
  if (head) {
    head.querySelectorAll('base').forEach((node) => node.remove());
    const base = document.createElement('base');
    base.setAttribute('href', location.href);
    head.prepend(base);
  }
  return {
    html: '<!doctype html>\\n' + root.outerHTML,
    width: window.innerWidth || 1280,
    height: window.innerHeight || 820,
    url: location.href
  };
})()`

export async function captureHtmlSnapshot(wc) {
  return wc.executeJavaScript(SNAPSHOT_FN, true)
}

function normalizeItemUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw, 'https://www.goofish.com')
    url.hash = ''
    return url.href
  } catch {
    return raw
  }
}

function candidateKeys(candidate = {}) {
  const keys = []
  const itemId = String(candidate.itemId || '').trim()
  const itemUrl = normalizeItemUrl(candidate.itemUrl || '')
  if (itemId) keys.push(`id:${itemId}`)
  if (itemUrl) keys.push(`url:${itemUrl}`)
  return [...new Set(keys)]
}

const DECISION_PRIORITY = Object.freeze({
  accepted: 0,
  unpriced_card: -1,
  relevance: 20,
  low_price: 30,
  below_spu_min_price: 40,
  above_spu_max_price: 40,
  blacklist: 50,
  unmatchable_card: -1
})

function decisionRecord(candidate, reasonCode = 'accepted') {
  const keys = candidateKeys(candidate)
  return {
    itemId: String(candidate.itemId || '').trim(),
    itemUrl: normalizeItemUrl(candidate.itemUrl || ''),
    title: String(candidate.title || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    price: Number.isFinite(Number(candidate.price)) ? Number(candidate.price) : null,
    decision: reasonCode === 'accepted' ? 'accepted' : reasonCode === 'unpriced_card' ? 'unclassified' : 'rejected',
    reasonCode,
    keys
  }
}

/**
 * Build the only source of truth for snapshot card annotations.  The map is
 * keyed by canonical URL, with an item-id fallback only when that ID points
 * to exactly one URL in this query.  A reused ID must never let one listing's
 * blacklist decision leak onto another listing with a different URL.
 */
export function buildSnapshotDecisionMap(result = {}) {
  const recordsByPrimary = new Map()
  const idToUrls = new Map()
  const add = (candidate, reasonCode) => {
    const next = decisionRecord(candidate, reasonCode)
    const urlKey = next.itemUrl ? `url:${next.itemUrl}` : ''
    const idKey = next.itemId ? `id:${next.itemId}` : ''
    if (!urlKey && !idKey) return
    if (idKey && urlKey) {
      if (!idToUrls.has(idKey)) idToUrls.set(idKey, new Set())
      idToUrls.get(idKey).add(urlKey)
    }
    const primaryKey = urlKey || idKey
    const existing = recordsByPrimary.get(primaryKey)
    if (!existing || (DECISION_PRIORITY[existing.reasonCode] || 0) < (DECISION_PRIORITY[reasonCode] || 0)) {
      recordsByPrimary.set(primaryKey, next)
    }
  }
  for (const candidate of (result.snapshotCandidates || [])) {
    const price = Number(candidate?.price)
    add(candidate, Number.isFinite(price) && price > 0 ? 'accepted' : 'unpriced_card')
  }
  for (const candidate of (result.candidates || [])) {
    const price = Number(candidate?.price)
    add(candidate, Number.isFinite(price) && price > 0 && price < 100 ? 'low_price' : Number.isFinite(price) && price > 0 ? 'accepted' : 'unpriced_card')
  }
  for (const candidate of (result.nonTargetItems || [])) add(candidate, 'relevance')
  for (const candidate of (result.belowSpuMinPriceItems || [])) add(candidate, 'below_spu_min_price')
  for (const candidate of (result.aboveSpuMaxPriceItems || [])) add(candidate, 'above_spu_max_price')
  for (const candidate of (result.blockedItems || [])) add(candidate, 'blacklist')
  const map = {}
  for (const record of recordsByPrimary.values()) {
    if (record.itemUrl) map[`url:${record.itemUrl}`] = record
  }
  const ambiguousKeys = []
  for (const [idKey, urls] of idToUrls.entries()) {
    if (urls.size === 1) {
      const record = recordsByPrimary.get([...urls][0])
      if (record) map[idKey] = record
    } else if (urls.size > 1) {
      ambiguousKeys.push(idKey)
    }
  }
  for (const record of recordsByPrimary.values()) {
    if (!record.itemUrl && record.itemId) map[`id:${record.itemId}`] = record
  }
  return {
    entries: [...new Set(Object.values(map))],
    byKey: map,
    ambiguousKeys
  }
}

export async function annotateSnapshotCards(wc, blacklistKeywords = [], relevanceKeywords = [], decisionMap = null, policyEvidence = null) {
  // No decision map means a legacy direct caller. Keep the old arguments
  // accepted, but never use text matching when the crawl supplied a map.
  const map = decisionMap && typeof decisionMap === 'object' ? decisionMap : null
  const encodedMap = JSON.stringify(map?.byKey || {})
  const terms = JSON.stringify(normalizeBlacklist(blacklistKeywords))
  const relevance = JSON.stringify(normalizeBlacklist(relevanceKeywords))
  const encodedPolicyEvidence = JSON.stringify(policyEvidence && typeof policyEvidence === 'object' ? policyEvidence : null)
  const script = `((decisionMap, terms, relevance, policyEvidence) => {
  // 选择器表随脚本注进页面上下文：这段跑在页面里，拿不到模块作用域。
  const S = ${selectorsLiteral()};
    const root = document.documentElement;
    if (root && policyEvidence) {
      root.setAttribute('data-xianyu-policy-version', String(policyEvidence.policyVersion || policyEvidence.version || '1'));
      root.setAttribute('data-xianyu-effective-queries', JSON.stringify(policyEvidence.effectiveQueries || []));
      root.setAttribute('data-xianyu-effective-blacklist', JSON.stringify(policyEvidence.blacklist || {}));
      root.setAttribute('data-xianyu-price-fence', JSON.stringify(policyEvidence.priceFence || {}));
      root.setAttribute('data-xianyu-page-filter-reason-code', String(policyEvidence.pageFilter?.reasonCode || 'page_filter_not_requested'));
    }
    const compact = (value) => String(value || '').toLowerCase().replace(/[\\s_+\\-/.，。,:：()（）【】\\[\\]]/g, '');
    const canonicalUrl = (value) => { try { const url = new URL(value || '', location.href); url.hash = ''; return url.href; } catch { return String(value || ''); } };
    const keysFor = (card) => {
      const anchor = card.matches('a[href]') ? card : card.querySelector('a[href]');
      const href = anchor?.getAttribute('href') || card.getAttribute('data-item-url') || '';
      const dataId = card.getAttribute('data-item-id') || card.getAttribute('data-id') || '';
      const idFromUrl = (() => { try { const url = new URL(href, location.href); return url.searchParams.get('id') || url.searchParams.get('itemId') || (url.pathname.match(/\\/(?:item|detail)\\/?([^/?#]+)/i) || [])[1] || ''; } catch { return ''; } })();
      const keys = [];
      if (dataId || idFromUrl) keys.push('id:' + String(dataId || idFromUrl).trim());
      const canonical = canonicalUrl(href);
      if (canonical) keys.push('url:' + canonical);
      return [...new Set(keys)];
    };
    const resolveRecord = (keys) => {
      const urlKey = keys.find((key) => key.startsWith('url:'));
      if (urlKey && decisionMap[urlKey]) return decisionMap[urlKey];
      const idKey = keys.find((key) => key.startsWith('id:'));
      return idKey && decisionMap[idKey] ? decisionMap[idKey] : null;
    };
    const cards = Array.from(document.querySelectorAll(S.RESULT_CARD));
    let marked = 0;
    let matched = 0;
    let unmatchable = 0;
    cards.forEach((card) => {
      const keys = keysFor(card);
      const record = resolveRecord(keys);
      card.removeAttribute('data-xianyu-non-target');
      card.removeAttribute('data-xianyu-reason-code');
      card.removeAttribute('data-xianyu-decision');
      card.classList.remove('xianyu-blacklist-card');
      if (!record) {
        card.setAttribute('data-xianyu-decision', 'unmatchable');
        card.setAttribute('data-xianyu-reason-code', 'unmatchable_card');
        unmatchable++;
        return;
      }
      matched++;
      card.setAttribute('data-xianyu-decision', record.decision || 'accepted');
      card.setAttribute('data-xianyu-reason-code', record.reasonCode || 'accepted');
      if (record.reasonCode === 'accepted' || record.reasonCode === 'unpriced_card') return;
      card.classList.add('xianyu-blacklist-card');
      card.setAttribute('data-xianyu-non-target', 'true');
      marked++;
    });
    if (marked && !document.querySelector('style[data-xianyu-snapshot-blacklist]')) {
      const style = document.createElement('style');
      style.setAttribute('data-xianyu-snapshot-blacklist', 'true');
      style.textContent = '.xianyu-blacklist-card{position:relative!important}.xianyu-blacklist-card::before{content:"";position:absolute;left:0;right:0;top:0;height:62%;z-index:2147483645;border:2px solid rgba(110,118,126,.72);border-radius:8px;background:linear-gradient(45deg,transparent 47%,rgba(110,118,126,.66) 49%,rgba(110,118,126,.66) 51%,transparent 53%),linear-gradient(-45deg,transparent 47%,rgba(110,118,126,.66) 49%,rgba(110,118,126,.66) 51%,transparent 53%),rgba(110,118,126,.12);box-sizing:border-box;pointer-events:none}.xianyu-blacklist-card::after{content:"非目标商品";position:absolute;right:8px;top:8px;z-index:2147483646;padding:4px 7px;border:1px solid rgba(255,255,255,.75);border-radius:4px;color:#fff;background:rgba(91,101,110,.84);font:700 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:none}';
      (document.head || document.documentElement).appendChild(style);
    }
    return { marked, matched, unmatchable, cardCount: cards.length };
  })(${encodedMap}, ${terms}, ${relevance}, ${encodedPolicyEvidence})`
  return wc.executeJavaScript(script, true)
}

// 闲鱼图片多为懒加载。保存完整网页前先滚到底并把常见 lazy 属性提升为 src，
// 让 HTMLComplete 能拿到当前页面的图片资源，而不是只保存商品文字。
const PREPARE_SNAPSHOT_RESOURCES_FN = `(() => {
  // 选择器表随脚本注进页面上下文：这段跑在页面里，拿不到模块作用域。
  const S = ${selectorsLiteral()};
  const lazyAttrs = ['data-original', 'data-src', 'data-lazy-src', 'data-image', 'data-image-url', 'data-url'];
  const lazySetAttrs = ['data-srcset', 'data-lazy-srcset'];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const cardSelector = S.RESULT_CARD;
  const isTinyPlaceholder = (img) => {
    const src = img.currentSrc || img.getAttribute('src') || '';
    return /(?:tps-2-2|tps-1-1|transparent|placeholder)/i.test(src)
      || (img.complete && img.naturalWidth > 0 && img.naturalWidth <= 2 && img.naturalHeight <= 2);
  };
  const revealImages = () => {
    const images = Array.from(document.images);
    images.forEach((img) => {
      const current = img.currentSrc || img.getAttribute('src') || '';
      const lazy = lazyAttrs.map((name) => img.getAttribute(name) || '').find((value) => value && !/^data:image\\//i.test(value));
      // 只要页面明确提供了真实 lazy 地址，就优先换成它；避免把占位图一起保存。
      if (lazy && lazy !== current) img.setAttribute('src', lazy);
      const lazySet = lazySetAttrs.map((name) => img.getAttribute(name) || '').find(Boolean);
      if (lazySet) img.setAttribute('srcset', lazySet);
      img.setAttribute('loading', 'eager');
    });
    document.querySelectorAll('source').forEach((source) => {
      const lazySet = lazySetAttrs.map((name) => source.getAttribute(name) || '').find(Boolean);
      if (lazySet) source.setAttribute('srcset', lazySet);
    });
    return images;
  };
  const promoteCurrentSources = () => {
    revealImages().forEach((img) => {
      const active = img.currentSrc || '';
      const current = img.getAttribute('src') || '';
      // savePage 读取的是 src 属性，不是浏览器当前绘制的 currentSrc；把已成功懒加载的真实 URL 固化下来。
      if (active && active !== current && !isTinyPlaceholder(img) && /^(https?:|data:)/i.test(active)) {
        img.setAttribute('src', active);
      }
    });
  };
  const waitForRealImage = (img) => new Promise((resolve) => {
    let finished = false;
    const done = () => { if (!finished) { finished = true; resolve(); } };
    const check = () => {
      if (!isTinyPlaceholder(img) && img.complete && img.naturalWidth > 2 && img.naturalHeight > 2) return done();
      setTimeout(check, 120);
    };
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
    setTimeout(done, 1200);
    check();
  });
  const allImages = new Set();
  const capturedPrimarySources = new Map();
  const collectImages = () => {
    revealImages().forEach((img) => allImages.add(img));
    // 每次滚动后把已经被浏览器选中的真实 currentSrc 固化到 src。
    // 不再逐张卡片等待：闲鱼会同时发起整页图片请求，HTMLComplete 负责保存已声明的资源。
    promoteCurrentSources();
  };
  const walk = async () => {
    const initialY = window.scrollY || 0;
    const pageHeight = document.documentElement.scrollHeight || 0;
    const viewportHeight = window.innerHeight || 820;
    const cards = Array.from(document.querySelectorAll(cardSelector));
    // 闲鱼的懒加载按“行”触发，一行通常有 4 张卡片。按行滚动并发等待，
    // 避免旧逻辑逐张卡片串行等待，同时确保每一行至少有一张真实图片地址被固化。
    const rowEntries = cards.map((card, index) => {
      const rect = card.getBoundingClientRect();
      const absoluteTop = Math.round((rect.top + window.scrollY) / 24) * 24;
      return { card, index, absoluteTop };
    });
    const rowKeys = [...new Set(rowEntries.map((entry) => entry.absoluteTop))].sort((a, b) => a - b);
    for (const rowTop of rowKeys) {
      const row = rowEntries.filter((entry) => entry.absoluteTop === rowTop);
      // 关键：闲鱼的图片 IntersectionObserver 对 element.scrollIntoView 更敏感，
      // 单独 window.scrollTo 可能只改变滚动条而不触发商品图片从 2×2 占位图切换。
      try { row[0].card.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' }); } catch {
        const targetTop = Math.max(0, Math.min(rowTop - Math.round(viewportHeight * 0.18), pageHeight - viewportHeight));
        window.scrollTo({ top: targetTop, left: 0, behavior: 'auto' });
      }
      await wait(360);
      collectImages();
      const rowImages = row.map(({ card }) => card.querySelector(S.CARD_IMAGE) || card.querySelector('img')).filter(Boolean);
      await Promise.all(rowImages.map(waitForRealImage));
      row.forEach(({ card, index }) => {
        const image = card.querySelector(S.CARD_IMAGE) || card.querySelector('img');
        if (image && !isTinyPlaceholder(image) && image.currentSrc) {
          capturedPrimarySources.set(index, image.currentSrc);
          image.setAttribute('src', image.currentSrc);
          image.removeAttribute('srcset');
          image.removeAttribute('loading');
        }
      });
      collectImages();
    }
    await wait(350);
    collectImages();
    // 闲鱼会把离开视口的图片退回占位图。把每一行滚动期间拿到的真实地址
    // 再写回对应卡片，避免 HTMLComplete 保存时只留下最后一屏。
    cards.forEach((card, index) => {
      const source = capturedPrimarySources.get(index);
      if (!source) return;
      const image = card.querySelector(S.CARD_IMAGE) || card.querySelector('img');
      if (!image) return;
      image.setAttribute('src', source);
      image.removeAttribute('srcset');
      image.removeAttribute('loading');
    });
    window.scrollTo(0, initialY);
    return {
      cardCount: cards.length,
      imageCount: allImages.size,
      loadedCount: [...allImages].filter((img) => img.complete && img.naturalWidth > 0).length,
      realImageCount: [...allImages].filter((img) => img.complete && img.naturalWidth > 2 && img.naturalHeight > 2 && !isTinyPlaceholder(img)).length
    };
  };
  return walk();
})()`

export async function prepareSnapshotResources(wc) {
  return wc.executeJavaScript(PREPARE_SNAPSHOT_RESOURCES_FN, true)
}

function normalizeAbsoluteUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.startsWith('//')) return `https:${raw}`
  try { return new URL(raw, 'https://www.goofish.com/').href } catch { return raw }
}

function firstNetworkPrice(value) {
  const text = Array.isArray(value)
    ? value.map((part) => part?.text ?? part?.value ?? '').join('')
    : String(value ?? '')
  const match = text.replace(/,/g, '').match(/\d+(?:\.\d+)?/)
  const price = match ? Number(match[0]) : NaN
  return Number.isFinite(price) && price > 0 ? price : null
}

function findNetworkResultList(payload) {
  const pending = [payload]
  const visited = new Set()
  while (pending.length) {
    const value = pending.shift()
    if (!value || typeof value !== 'object' || visited.has(value)) continue
    visited.add(value)
    if (Array.isArray(value.resultList)) return value.resultList
    if (Array.isArray(value)) pending.push(...value)
    else pending.push(...Object.values(value))
  }
  return null
}

function networkCandidateFromItem(item, query) {
  const main = item?.data?.item?.main || item?.item?.main || item?.data?.main || item?.main || {}
  const ex = main.exContent || item?.exContent || item?.data?.exContent || {}
  const detail = ex.detailParams || {}
  const itemId = String(ex.itemId || detail.itemId || main.clickParam?.args?.itemId || main.clickParam?.args?.id || '').trim()
  if (!itemId) return null
  const itemUrl = normalizeAbsoluteUrl(main.targetUrl || item?.targetUrl || `https://www.goofish.com/item?id=${encodeURIComponent(itemId)}`)
  const price = firstNetworkPrice(ex.price) ?? firstNetworkPrice(detail.soldPrice) ?? firstNetworkPrice(ex.soldPrice)
  return {
    key: itemId || itemUrl,
    itemId,
    itemUrl,
    title: String(ex.title || item?.title || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    price,
    picUrl: normalizeAbsoluteUrl(ex.picUrl || ex.imageUrl || ex.coverUrl || ''),
    query
  }
}

function normalizedEffectivePolicy(value = {}, { blacklistKeywords = [], relevanceKeywords = [] } = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const blacklist = source.blacklist && typeof source.blacklist === 'object' ? source.blacklist : {}
  const pageFilter = source.pageFilter && typeof source.pageFilter === 'object' ? source.pageFilter : {}
  const version = Number(source.version ?? source.policyVersion)
  return {
    version: Number.isInteger(version) && version > 0 ? version : 1,
    blacklist: {
      mode: ['inherit', 'append', 'replace'].includes(String(blacklist.mode || '').toLowerCase())
        ? String(blacklist.mode).toLowerCase()
        : 'inherit',
      terms: normalizeBlacklist(blacklist.terms ?? blacklistKeywords)
    },
    relevanceKeywords: normalizeBlacklist(source.relevanceKeywords ?? relevanceKeywords),
    priceFence: normalizeListingPriceFence(source.priceFence),
    pageFilter: { enabled: pageFilter.enabled === true }
  }
}

function pageFilterEvidence(policy) {
  return policy.pageFilter.enabled
    ? {
        requested: true,
        applied: false,
        verified: false,
        status: 'unverified',
        reasonCode: 'page_filter_unverified',
        reason: '已请求闲鱼页面价格筛选；当前运行未执行或验证页面侧 RPA，程序侧 SPU 价格围栏仍已生效'
      }
    : {
        requested: false,
        applied: false,
        verified: false,
        status: 'not_requested',
        reasonCode: 'page_filter_not_requested',
        reason: '未请求闲鱼页面价格筛选；仅按程序侧 SPU 价格围栏处理候选'
      }
}

function policyEvidenceFor(policy, effectiveQueries = [], queryResults = [], pageFilterOverride = null) {
  const belowSpuMinPriceCount = queryResults.reduce((sum, item) => sum + (Number(item?.result?.belowSpuMinPriceCount) || 0), 0)
  const aboveSpuMaxPriceCount = queryResults.reduce((sum, item) => sum + (Number(item?.result?.aboveSpuMaxPriceCount) || 0), 0)
  return {
    policyVersion: policy.version,
    effectiveQueries: [...new Set((Array.isArray(effectiveQueries) ? effectiveQueries : []).map((query) => String(query || '').trim()).filter(Boolean))],
    blacklist: { mode: policy.blacklist.mode, terms: [...policy.blacklist.terms] },
    priceFence: {
      ...policy.priceFence,
      programSideFilter: 'applied',
      belowSpuMinPriceCount,
      aboveSpuMaxPriceCount
    },
    pageFilter: pageFilterOverride || pageFilterEvidence(policy)
  }
}

async function extractNetworkResult(wc, query, blacklistKeywords = [], relevanceKeywords = [], priceFence = {}) {
  const captured = readCapturedSearchPayloads(wc)
  if (!Array.isArray(captured) || !captured.length) return null
  const blacklist = normalizeBlacklist(blacklistKeywords)
  const normalizedFence = normalizeListingPriceFence(priceFence)
  // A row may provide several model/alias fields. Each navigation has its
  // own query, so a card only needs to match one configured term (the current
  // query or one of the row's accepted aliases), never every term at once.
  const relevance = normalizeBlacklist(relevanceKeywords.length ? [query, ...relevanceKeywords] : [])
  const compact = (value) => String(value || '').toLowerCase().replace(/[\s_+\-/.，。,:：()（）【】\[\]]/g, '')
  for (const entry of [...captured].reverse()) {
    const resultList = findNetworkResultList(entry?.payload)
    if (!Array.isArray(resultList)) continue
    const candidates = []
    const snapshotCandidates = []
    const blockedItems = []
    const nonTargetItems = []
    const belowSpuMinPriceItems = []
    const aboveSpuMaxPriceItems = []
    for (const item of resultList) {
      const candidate = networkCandidateFromItem(item, query)
      if (!candidate) continue
      snapshotCandidates.push(candidate)
      const lowered = candidate.title.toLowerCase()
      if (blacklist.some((term) => lowered.includes(term))) {
        blockedItems.push(candidate)
        continue
      }
      const compactTitle = compact(candidate.title)
      if (relevance.length && !relevance.some((term) => compactTitle.includes(compact(term)))) {
        nonTargetItems.push(candidate)
        continue
      }
      if (Number.isFinite(Number(candidate.price))) {
        const listingFence = listingPriceFenceCheck({ listingPrice: candidate.price, priceFence: normalizedFence })
        if (!listingFence.ok) {
          if (listingFence.reasonCode === 'below_spu_min_price') belowSpuMinPriceItems.push(candidate)
          else if (listingFence.reasonCode === 'above_spu_max_price') aboveSpuMaxPriceItems.push(candidate)
          continue
        }
      }
      candidates.push(candidate)
    }
    const prices = candidates.map((candidate) => candidate.price).filter((price) => Number.isFinite(price)).sort((a, b) => a - b)
    return {
      noResult: resultList.length === 0,
      loggedOut: false,
      cardCount: resultList.length,
      blockedCount: blockedItems.length,
      blockedItems,
      nonTargetCount: nonTargetItems.length,
      nonTargetItems,
      belowSpuMinPriceCount: belowSpuMinPriceItems.length,
      belowSpuMinPriceItems,
      aboveSpuMaxPriceCount: aboveSpuMaxPriceItems.length,
      aboveSpuMaxPriceItems,
      pricedCount: prices.length,
      candidates,
      snapshotCandidates,
      lowest: prices.length ? prices[0] : null,
      prices: prices.slice(0, 60),
      source: 'search_api'
    }
  }
  return null
}

export async function promoteSnapshotImages(wc, candidates = []) {
  const imageCandidates = (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => candidate?.itemId && candidate?.picUrl)
    .map((candidate) => ({ itemId: String(candidate.itemId), itemUrl: candidate.itemUrl || '', picUrl: candidate.picUrl }))
  if (!imageCandidates.length) return { updated: 0, total: 0 }
  const encoded = JSON.stringify(imageCandidates)
  const script = `(() => {
  // 选择器表随脚本注进页面上下文：这段跑在页面里，拿不到模块作用域。
  const S = ${selectorsLiteral()};
    const sources = ${encoded};
    const byId = new Map();
    const getId = (value) => {
      try {
        const url = new URL(value || '', location.href);
        return url.searchParams.get('id') || url.searchParams.get('itemId') || '';
      } catch { return ''; }
    };
    sources.forEach((source) => {
      if (source.itemId) byId.set(String(source.itemId), source.picUrl);
      const id = getId(source.itemUrl);
      if (id) byId.set(String(id), source.picUrl);
    });
    const cards = Array.from(document.querySelectorAll(S.RESULT_CARD));
    let updated = 0;
    cards.forEach((card) => {
      const anchor = card.matches('a[href]') ? card : card.querySelector('a[href]');
      const id = getId(anchor?.getAttribute('href') || card.getAttribute('data-item-id') || '');
      const source = byId.get(String(id));
      if (!source) return;
      const image = card.querySelector(S.CARD_IMAGE) || card.querySelector('img');
      if (!image) return;
      image.setAttribute('src', source);
      image.removeAttribute('srcset');
      image.removeAttribute('data-src');
      image.removeAttribute('data-original');
      image.setAttribute('loading', 'eager');
      image.setAttribute('data-xianyu-source-image', source);
      updated++;
    });
    return { updated, total: cards.length };
  })()`
  const result = await executeJavaScriptWithTimeout(wc, script, 2500)
  return result || { updated: 0, total: 0 }
}

// 防诱饵低价：低于 100 元的价格全部视为垃圾候选；只要存在 >=100 元的挂牌，
// 先丢掉全部低价，再对剩余有效挂牌求平均。这样 39、39、300、319、366 会得到
// 328.33，而不是被第一条或第二条 39 元带偏。若全部候选都低于 100 元，则仍返回
// 清洗前平均价，让调度层把任务送入错误 Excel。
// 返回 { price, average, lowest, median, validPrices, rejectedBelow100, rejectedOverMaximum, ... }
export function pickPrice(prices) {
  const values = (Array.isArray(prices) ? prices : [])
    .map((price) => Number(price))
    .filter((price) => Number.isFinite(price) && price > 0)
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const lowest = sorted[0]
  // 闲鱼偶尔会返回明显的占位/诱饵高价（例如 99999999）。这类数值不能进入平均价，
  // 否则即使低价垃圾被清掉，最终行情仍会被一个异常值抬到几百万。
  const rejectedOverMaximum = sorted.filter((price) => price > 100000)
  const bounded = sorted.filter((price) => price <= 100000)
  const validPrices = bounded.filter((price) => price >= 100)
  const rejectedBelow100 = sorted.filter((price) => price < 100)
  const includedPrices = validPrices.length ? validPrices : bounded
  if (!includedPrices.length) return null
  const average = includedPrices.reduce((sum, price) => sum + price, 0) / includedPrices.length
  const median = includedPrices[Math.floor(includedPrices.length / 2)] ?? null
  const roundedAverage = Math.round((average + Number.EPSILON) * 100) / 100
  return {
    price: roundedAverage,
    average: roundedAverage,
    lowest,
    median,
    validPrices,
    rejectedBelow100,
    rejectedOverMaximum,
    dropped: rejectedBelow100.length > 0,
    droppedBelowMinimum: rejectedBelow100.length,
    droppedOverMaximum: rejectedOverMaximum.length
  }
}

function normalizeBlacklist(blacklistKeywords) {
  const values = Array.isArray(blacklistKeywords) ? blacklistKeywords : []
  return [...new Set(values.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))].slice(0, 100)
}

// 注入页面执行的取价脚本（运行在闲鱼页面上下文）。黑名单在此处按商品卡片文本过滤。
export function extractScript(blacklistKeywords = [], relevanceKeywords = [], priceFence = {}) {
  const encodedBlacklist = JSON.stringify(normalizeBlacklist(blacklistKeywords))
  const encodedRelevance = JSON.stringify(normalizeBlacklist(relevanceKeywords))
  const encodedPriceFence = JSON.stringify(normalizeListingPriceFence(priceFence))
  return `(() => {
  // 选择器表随脚本注进页面上下文：这段跑在页面里，拿不到模块作用域。
  const S = ${selectorsLiteral()};
  const blacklist = ${encodedBlacklist};
  const relevance = ${encodedRelevance};
  const priceFence = ${encodedPriceFence};
  const body = document.body ? (document.body.innerText || '') : '';
  const noResult = /没有找到你想要的宝贝|减少筛选内容/.test(body);
  const loggedOut = /扫码登录|亲，请登录|请先登录/.test(body);
  const abs = (href) => { const raw = String(href || '').trim(); if (!raw) return ''; try { return new URL(raw, location.href).href; } catch { return ''; } };
  const compact = (value) => String(value || '').toLowerCase().replace(/[\\s_+\\-/.，。,:：()（）【】\\[\\]]/g, '');

  // 只取真实结果卡片（search-container 内），排除「猜你喜欢」推荐
  let cards = Array.from(document.querySelectorAll(S.RESULT_CARD));

  const candidates = [];
  const snapshotCandidates = [];
  const blockedItems = [];
  const nonTargetItems = [];
  const belowSpuMinPriceItems = [];
  const aboveSpuMaxPriceItems = [];
  const unmatchableItems = [];
  let blockedCount = 0;
  for (const card of cards) {
    const cardText = (card.innerText || '').replace(/\\s+/g, ' ').trim();
    const loweredText = cardText.toLowerCase();
    const anchor = card.matches('a[href]') ? card : card.querySelector('a[href]');
    const itemUrl = anchor ? abs(anchor.getAttribute('href') || '') : abs(card.getAttribute('data-item-url') || '');
    let itemId = card.dataset?.itemId || card.getAttribute('data-item-id') || card.getAttribute('data-id') || '';
    if (!itemId && itemUrl) {
      try {
        const u = new URL(itemUrl, location.href);
        itemId = u.searchParams.get('id') || u.searchParams.get('itemId') || '';
      } catch {}
      if (!itemId) {
        const m = itemUrl.match(/(?:item[./?]|id=)([0-9]{6,})/i);
        itemId = m ? m[1] : '';
      }
    }
    const identity = { itemId: String(itemId || ''), itemUrl, title: cardText.slice(0, 180), query: location.search };
    if (!identity.itemId && !identity.itemUrl) {
      unmatchableItems.push(identity);
      continue;
    }
    if (blacklist.some((term) => loweredText.includes(term))) {
      blockedCount++;
      blockedItems.push(identity);
      snapshotCandidates.push({ ...identity, price: null });
      continue;
    }
    const wrap = card.querySelector(S.PRICE_WRAP);
    let n = null;
    const numEl = wrap?.querySelector(S.PRICE_INT);
    const intPart = (numEl?.textContent || '').replace(/[^0-9]/g, '');
    if (intPart) {
      const decEl = wrap.querySelector(S.PRICE_DEC);
      const decRaw = decEl ? (decEl.textContent || '').replace(/[^0-9]/g, '') : '';
      const parsed = parseFloat(decRaw ? intPart + '.' + decRaw : intPart);
      if (isFinite(parsed) && parsed > 0) n = parsed;
    }
    const snapshotCandidate = { ...identity, key: String(itemId || itemUrl || ''), price: n };
    snapshotCandidates.push(snapshotCandidate);
    const compactTitle = compact(cardText);
    if (relevance.length && !relevance.some((term) => compactTitle.includes(compact(term)))) {
      nonTargetItems.push(snapshotCandidate);
      continue;
    }
    if (!Number.isFinite(n)) continue;
    if (priceFence.minListingPrice != null && n < priceFence.minListingPrice) {
      belowSpuMinPriceItems.push(snapshotCandidate);
      continue;
    }
    if (priceFence.maxListingPrice != null && n > priceFence.maxListingPrice) {
      aboveSpuMaxPriceItems.push(snapshotCandidate);
      continue;
    }
    candidates.push(snapshotCandidate);
  }
  const prices = candidates.map((item) => item.price).sort((a, b) => a - b);
  return {
    noResult,
    loggedOut: loggedOut && cards.length === 0,
    cardCount: cards.length,
    blockedCount,
    pricedCount: prices.length,
    blockedItems,
    nonTargetCount: nonTargetItems.length,
    nonTargetItems,
    belowSpuMinPriceCount: belowSpuMinPriceItems.length,
    belowSpuMinPriceItems,
    aboveSpuMaxPriceCount: aboveSpuMaxPriceItems.length,
    aboveSpuMaxPriceItems,
    unmatchableCount: unmatchableItems.length,
    unmatchableItems,
    candidates,
    snapshotCandidates,
    lowest: prices.length ? prices[0] : null,
    prices: prices.slice(0, 60),
    sample: body.slice(0, 120)
  };
})()`
}

// 轮询等结果渲染：拿到价格 / 判定无在售 / 判定未登录 即返回
async function waitForResult(wc, { tries = 12, interval = 1000, blacklistKeywords = [], relevanceKeywords = [], priceFence = {} } = {}) {
  const extractFn = extractScript(blacklistKeywords, relevanceKeywords, priceFence)
  let last = null
  for (let i = 0; i < tries; i++) {
    try {
      last = await executeJavaScriptWithTimeout(wc, extractFn)
    } catch {
      last = null
    }
    if (last && (last.lowest != null || last.noResult || last.loggedOut)) return last
    // 中途滚动一下，触发懒加载
    if (i === 2 || i === 5) {
      try {
        await executeJavaScriptWithTimeout(wc, 'window.scrollTo(0, document.body.scrollHeight); setTimeout(()=>window.scrollTo(0,0),300)')
      } catch {
        /* ignore */
      }
    }
    await sleep(interval)
  }
  return last
}

/**
 * 爬一个或多个关键词，合并去重后取清洗后的平均挂牌价。
 * @returns {{ok:boolean, empty?:boolean, price?:number, source?:string, reason?:string, raw?:object}}
 */
export async function crawlOne(wc, keyword, {
  accountName = '',
  blacklistKeywords = [],
  relevanceKeywords = [],
  effectivePolicy = null,
  captureSnapshot = null,
  queryDelayMinMs = 8000,
  queryDelayMaxMs = 14000
} = {}) {
  const keywords = [...new Set((Array.isArray(keyword) ? keyword : [keyword]).map((value) => String(value || '').trim()).filter(Boolean))]
  if (!keywords.length) return { ok: false, reason: '没有可搜索的关键词' }
  const policy = normalizedEffectivePolicy(effectivePolicy, { blacklistKeywords, relevanceKeywords })
  const initialPolicyEvidence = policyEvidenceFor(policy, keywords)

  const queryResults = []
  let pageFilterResult = null
  for (const [queryIndex, query] of keywords.entries()) {
    if (queryIndex > 0) {
      let min = Math.max(0, Number(queryDelayMinMs) || 8000)
      let max = Math.max(min, Number(queryDelayMaxMs) || 14000)
      if (max < min) [min, max] = [max, min]
      await sleep(Math.round(min + Math.random() * (max - min)))
    }
    // 每次导航前清掉上一关键词的响应；轮询期间只读不清空，避免 CDP 响应体晚到时被丢弃。
    clearCapturedSearchPayloads(wc)
    try {
      await loadUrlWithTimeout(wc, SEARCH_URL(query))
    } catch (e) {
      // SPA 自跳转常令原导航 ERR_ABORTED，可忽略后继续读页面
      if (!/ERR_ABORTED/.test(String(e?.message))) {
        queryResults.push({ query, error: '导航失败: ' + (e?.message || e) })
        continue
      }
    }
    const riskPage = await detectRiskPage(wc)
    if (riskPage?.riskControl) {
      queryResults.push({
        query,
        pageUrl: SEARCH_URL(query),
        riskControl: true,
        error: `检测到闲鱼风控页面（${riskPage.signal || '需要验证'}）`
      })
      break
    }
    if (policy.pageFilter.enabled) {
      const adapterResult = await applyPagePriceFilter(wc, { ...policy.pageFilter, ...policy.priceFence })
      pageFilterResult = adapterResult.verified
        ? adapterResult
        : { ...adapterResult, status: 'unverified', reasonCode: 'page_filter_unverified', adapterReasonCode: adapterResult.reasonCode }
      initialPolicyEvidence.pageFilter = pageFilterResult
    }
    // GitHub 上的闲鱼实现直接监听搜索接口，而不是依赖懒加载 DOM。接口结果同时带
    // 商品 ID、价格和 picUrl，优先使用它可以避免卡片图片占位图和逐卡片滚动等待。
    let result = null
    for (let attempt = 0; attempt < 20 && !result; attempt++) {
      result = await extractNetworkResult(wc, query, policy.blacklist.terms, policy.relevanceKeywords, policy.priceFence)
      if (!result) await sleep(250)
    }
    if (!result) result = await waitForResult(wc, {
      blacklistKeywords: policy.blacklist.terms,
      relevanceKeywords: [query, ...policy.relevanceKeywords],
      priceFence: policy.priceFence
    })
    let snapshot = null
    let snapshotError = ''
    const decisionMap = result ? buildSnapshotDecisionMap(result) : { entries: [], byKey: {} }
    if (result && typeof captureSnapshot === 'function') {
      try {
        snapshot = await captureSnapshot({
          query,
          pageUrl: SEARCH_URL(query),
          result,
          decisionMap,
          decisionMapByQuery: { [query]: decisionMap },
          policyEvidence: initialPolicyEvidence
        })
      } catch (error) {
        // DOM 快照失败不影响行情结果；下次运行仍会继续尝试保存。
        snapshot = null
        snapshotError = String(error?.message || error || '快照保存失败').slice(0, 300)
      }
    }
    if (!result) queryResults.push({ query, pageUrl: SEARCH_URL(query), error: '页面无响应', decisionMap, snapshotError })
    else queryResults.push({ query, pageUrl: SEARCH_URL(query), result, snapshot, decisionMap, snapshotError })
  }

  const snapshotPaths = [...new Set(queryResults.map((item) => item.snapshot?.path).filter(Boolean))]
  const firstSnapshot = queryResults.find((item) => item.snapshot?.path)?.snapshot || null
  const snapshotFields = {
    snapshotPath: firstSnapshot?.path || null,
    snapshotQuery: queryResults.find((item) => item.snapshot?.path)?.query || '',
    snapshotPaths,
    snapshotViewport: firstSnapshot?.viewport || null,
    pageUrl: firstSnapshot?.pageUrl || queryResults.find((item) => item.pageUrl)?.pageUrl || ''
  }

  const snapshotEntries = queryResults.map((item) => {
    const records = item.decisionMap?.entries || []
    // Query text is unique within one crawl (keywords are de-duplicated at
    // the start of crawlOne), so it is the stable binding key.  Do not make
    // the UI infer a path from the array position.
    const entryId = `query:${encodeURIComponent(item.query || '')}`
    const countFor = (reasonCode) => records.filter((entry) => entry.reasonCode === reasonCode).length
    const snapshotStatus = item.snapshot?.path
      ? 'saved'
      : item.snapshotError
        ? 'failed'
        : item.result
          ? 'not_captured'
          : 'unavailable'
    return {
      entryId,
      query: item.query,
      path: item.snapshot?.path || null,
      pageUrl: item.snapshot?.pageUrl || item.pageUrl || SEARCH_URL(item.query),
      capturedAt: item.snapshot?.capturedAt || null,
      viewport: item.snapshot?.viewport || null,
      snapshotStatus,
      error: item.snapshotError || item.error || null,
      cardCount: Number(item.result?.cardCount) || records.length,
      acceptedCount: countFor('accepted'),
      blockedCount: Number(item.result?.blockedCount) || countFor('blacklist'),
      nonTargetCount: Number(item.result?.nonTargetCount) || countFor('relevance'),
      lowPriceCount: countFor('low_price'),
      belowSpuMinPriceCount: countFor('below_spu_min_price'),
      aboveSpuMaxPriceCount: countFor('above_spu_max_price'),
      markedCount: Number.isFinite(Number(item.snapshot?.annotation?.marked))
        ? Number(item.snapshot.annotation.marked)
        : records.filter((entry) => ['blacklist', 'relevance', 'low_price', 'below_spu_min_price', 'above_spu_max_price'].includes(entry.reasonCode)).length,
      unmatchableCount: Number(item.snapshot?.annotation?.unmatchable) || Number(item.result?.unmatchableCount) || 0,
      unmappedCount: Number(item.snapshot?.annotation?.unmatchable) || Number(item.result?.unmatchableCount) || 0,
      markReasonCodes: (() => {
        const codes = new Set(records.map((entry) => entry.reasonCode))
        if (Number(item.snapshot?.annotation?.unmatchable) || Number(item.result?.unmatchableCount)) codes.add('unmatchable_card')
        if (initialPolicyEvidence.pageFilter.reasonCode === 'page_filter_unverified') codes.add('page_filter_unverified')
        return [...codes]
      })(),
      cardSummaries: records.slice(0, 10).map((entry) => ({
        itemId: entry.itemId,
        itemUrl: entry.itemUrl,
        title: entry.title,
        price: entry.price,
        decision: entry.decision,
        reasonCode: entry.reasonCode
      })),
      policyEvidence: initialPolicyEvidence
    }
  })
  const queryLogs = snapshotEntries.map((entry, index) => ({
    ...entry,
    entryId: entry.entryId,
    queryIndex: index,
    reason: entry.error || (entry.unmatchableCount
      ? `有 ${entry.unmatchableCount} 张卡片无法绑定商品 ID/链接，未自动判定`
      : entry.markedCount ? `按接口商品 ID/链接标记 ${entry.markedCount} 张卡片` : '接口判定通过，未标记卡片'),
    purchasePriceFence: null,
    policyEvidence: initialPolicyEvidence
  }))
  const decisionMapByQuery = Object.fromEntries(queryResults.map((item) => [item.query, item.decisionMap || { entries: [], byKey: {} }]))
  // Keep a query-scoped price projection even when no final price can be
  // selected. This is the same ordered attempted-query list used by entries
  // and logs, so failed navigation/result/snapshot attempts remain auditable.
  const priceQueryResults = queryResults.map((item) => ({
    query: item.query,
    cards: item.result?.cardCount || 0,
    priced: item.result?.pricedCount || 0,
    blocked: item.result?.blockedCount || 0,
    blockedItems: (item.result?.blockedItems || []).slice(0, 30),
    nonTarget: item.result?.nonTargetCount || 0,
    nonTargetItems: (item.result?.nonTargetItems || []).slice(0, 30),
    belowSpuMinPrice: item.result?.belowSpuMinPriceCount || 0,
    belowSpuMinPriceItems: (item.result?.belowSpuMinPriceItems || []).slice(0, 30),
    aboveSpuMaxPrice: item.result?.aboveSpuMaxPriceCount || 0,
    aboveSpuMaxPriceItems: (item.result?.aboveSpuMaxPriceItems || []).slice(0, 30),
    noResult: !!item.result?.noResult,
    prices: (item.result?.prices || []).slice(0, 60),
    snapshotPath: item.snapshot?.path || null,
    snapshotStatus: snapshotEntries.find((entry) => entry.query === item.query)?.snapshotStatus || 'unavailable',
    pageUrl: item.snapshot?.pageUrl || item.pageUrl || '',
    error: item.snapshotError || item.error || null,
    accepted: item.decisionMap?.entries?.filter((entry) => entry.reasonCode === 'accepted').length || 0,
    lowPrice: item.decisionMap?.entries?.filter((entry) => entry.reasonCode === 'low_price').length || 0,
    markReasonCodes: [...new Set([
      ...(item.decisionMap?.entries || []).map((entry) => entry.reasonCode),
      ...(initialPolicyEvidence.pageFilter.reasonCode === 'page_filter_unverified' ? ['page_filter_unverified'] : [])
    ])],
    cardSummaries: (item.decisionMap?.entries || []).slice(0, 10).map((entry) => ({
      itemId: entry.itemId,
      itemUrl: entry.itemUrl,
      title: entry.title,
      price: entry.price,
      decision: entry.decision,
      reasonCode: entry.reasonCode
    }))
  }))
  const priceBreakdownBase = {
    method: 'cleaned_average',
    sourceLabel: '清洗后平均挂牌价',
    minimumValidPrice: 100,
    finalPrice: null,
    queryResults: priceQueryResults,
    policyEvidence: policyEvidenceFor(policy, keywords, queryResults, pageFilterResult)
  }

  const riskResult = queryResults.find((item) => item.riskControl)
  if (riskResult) {
    return {
      ok: false,
      riskControl: true,
      reason: riskResult.error,
      snapshotEntries,
      queryLogs,
      priceBreakdown: priceBreakdownBase,
      decisionMapByQuery,
      policyEvidence: priceBreakdownBase.policyEvidence,
      ...snapshotFields
    }
  }

  if (queryResults.some((item) => item.result?.loggedOut)) return { ok: false, reason: '该账号未登录闲鱼', snapshotEntries, queryLogs, priceBreakdown: priceBreakdownBase, decisionMapByQuery, policyEvidence: priceBreakdownBase.policyEvidence, ...snapshotFields }

  const rawCandidates = queryResults.flatMap((item) =>
    (item.result?.candidates || []).map((candidate) => ({ ...candidate, query: item.query }))
  )
  const merged = new Map()
  for (const candidate of rawCandidates) {
    const key = String(candidate.key || candidate.itemId || candidate.itemUrl || `${candidate.price}|${candidate.title || ''}`)
    if (!merged.has(key)) merged.set(key, candidate)
  }
  const candidates = [...merged.values()]
  const prices = candidates.map((item) => item.price).filter((price) => Number.isFinite(price) && price > 0)
  const picked = pickPrice(prices)
  if (picked) {
    const validCandidates = candidates.filter((candidate) => Number(candidate.price) >= 100 && Number(candidate.price) <= 100000).sort((a, b) => Number(a.price) - Number(b.price))
    const rejectedBelow100 = candidates.filter((candidate) => Number(candidate.price) < 100).sort((a, b) => Number(a.price) - Number(b.price))
    const rejectedOverMaximum = candidates.filter((candidate) => Number(candidate.price) > 100000).sort((a, b) => Number(a.price) - Number(b.price))
    const compactCandidate = (candidate) => ({
      query: candidate.query || '',
      title: String(candidate.title || '').slice(0, 180),
      price: Number(candidate.price),
      itemId: candidate.itemId || '',
      itemUrl: candidate.itemUrl || '',
      // ERP 商品详情「近期价格记录」拿它当缩略图（11-11 之前没带，那批记录都没图）
      picUrl: candidate.picUrl || ''
    })
    const priceBreakdown = {
      method: 'cleaned_average',
      sourceLabel: '清洗后平均挂牌价',
      minimumValidPrice: 100,
      finalPrice: picked.price,
      allCandidateCount: candidates.length,
      validCount: validCandidates.length,
      rejectedBelow100Count: rejectedBelow100.length,
      rejectedOverMaximumCount: rejectedOverMaximum.length,
      allPrices: [...prices].sort((a, b) => a - b).slice(0, 60),
      validPrices: validCandidates.map((candidate) => Number(candidate.price)).slice(0, 60),
      includedListings: validCandidates.slice(0, 60).map(compactCandidate),
      rejectedBelow100: rejectedBelow100.slice(0, 60).map(compactCandidate),
      rejectedOverMaximum: rejectedOverMaximum.slice(0, 60).map(compactCandidate),
      queryResults: priceQueryResults,
      policyEvidence: policyEvidenceFor(policy, keywords, queryResults)
    }
    const pickedSnapshot = queryResults.find((item) =>
      item.snapshot?.path && (item.result?.candidates || []).some((candidate) => Number(candidate.price) >= 100)
    ) || queryResults.find((item) => item.snapshot?.path)
    const selectedSnapshot = pickedSnapshot?.snapshot || firstSnapshot
    return {
      ok: true,
      price: picked.price,
      source: 'cleaned_average',
      priceBreakdown,
      snapshotPath: selectedSnapshot?.path || null,
      snapshotQuery: pickedSnapshot?.query || snapshotFields.snapshotQuery,
      snapshotPaths,
      snapshotViewport: selectedSnapshot?.viewport || snapshotFields.snapshotViewport,
      pageUrl: selectedSnapshot?.pageUrl || snapshotFields.pageUrl,
      snapshotEntries,
      queryLogs,
      decisionMapByQuery,
      policyEvidence: priceBreakdown.policyEvidence,
      raw: {
        source: 'cleaned_average',
        keywords,
        account: accountName,
        price: picked.price,
        average: picked.average,
        lowest: picked.lowest,
        median: picked.median,
        dropped_bait: picked.dropped,
        dropped_below_minimum: picked.droppedBelowMinimum || 0,
        priceBreakdown,
        queryResults: queryResults.map((item) => ({
          query: item.query,
          error: item.error || null,
          cards: item.result?.cardCount || 0,
          priced: item.result?.pricedCount || 0,
          blocked: item.result?.blockedCount || 0,
          noResult: !!item.result?.noResult,
          snapshotPath: item.snapshot?.path || null,
          pageUrl: item.snapshot?.pageUrl || item.pageUrl || '',
          candidates: (item.result?.prices || []).slice(0, 30)
        })),
        blacklistKeywords: [...policy.blacklist.terms],
        policyEvidence: priceBreakdown.policyEvidence,
        snapshotPaths,
        snapshotEntries,
        queryLogs,
        decisionMapByQuery,
        cards: rawCandidates.length,
        uniqueCards: candidates.length,
        deduped: rawCandidates.length - candidates.length,
        candidates: candidates.slice(0, 60).map(compactCandidate)
      }
    }
  }
  const hasError = queryResults.some((item) => item.error)
  if (hasError && !queryResults.some((item) => item.result)) {
    return { ok: false, reason: queryResults.find((item) => item.error)?.error || '搜索失败', snapshotEntries, queryLogs, priceBreakdown: priceBreakdownBase, decisionMapByQuery, policyEvidence: priceBreakdownBase.policyEvidence, ...snapshotFields }
  }
  if (queryResults.some((item) => item.result?.noResult || item.result?.cardCount === 0)) {
    return { ok: false, empty: true, reason: '闲鱼无此商品在售', snapshotEntries, queryLogs, priceBreakdown: priceBreakdownBase, decisionMapByQuery, policyEvidence: priceBreakdownBase.policyEvidence, ...snapshotFields }
  }
  return { ok: false, empty: true, reason: '未取到价格（卡片无价）', snapshotEntries, queryLogs, priceBreakdown: priceBreakdownBase, decisionMapByQuery, policyEvidence: priceBreakdownBase.policyEvidence, ...snapshotFields }
}

/** 仅用于「去登录」：把某账号导航到闲鱼首页以便扫码 */
export async function gotoHome(wc) {
  try {
    await wc.loadURL('https://www.goofish.com/')
  } catch {
    /* ignore aborted */
  }
}

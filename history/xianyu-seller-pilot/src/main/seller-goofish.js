// 卖家主页采集器：只读取主页列表卡片，不进入单个商品详情。
// 采集字段限定为外层可见信息：商品链接、标题、主图、价格、在售/已售状态。
// 通过页面自身滚动触发懒加载；不调用隐藏接口、不绕过登录/验证码或平台限制。
import { detectRiskPage } from './goofish.js'
import { consumeSellerNavigationEvidence, normalizeSellerHomeUrl } from './seller-worker.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const TEST_FAST_MODE = 'test-fast'
// A trusted tab total is not proof that the current renderer is still making
// progress. Virtualized seller pages can keep returning the same cards when a
// nested scroll container stops responding. Bound that stall, persist the
// partial evidence, and let the scheduler make its one formal retry instead
// of burning the whole scroll budget on identical checkpoints.
const MAX_STABLE_NO_PROGRESS_ROUNDS = 20
// A trusted tab total is stronger evidence than an unknown-length page. Give
// a virtualized renderer extra bounded time to deliver the next batch before
// handing the seller back as incomplete; this is still finite and does not
// bypass the account-level throttle or risk circuit.
const MAX_STABLE_EXPECTED_SHORTFALL_ROUNDS = 40
// 不把某个固定商品数量当成闲鱼主页的完成线。不同账号、页面版本和
// 风控状态可能暴露不同数量；只有页面本身给出“底部加载”信号并持续无
// 新卡片时，才进入短阈值判断。显式 maxItemsPerSeller 仍可作为运维方
// 的安全上限，但默认值为自适应（Number.MAX_SAFE_INTEGER）。
// A bottom-of-list threshold spinner is visually distinct from the ordinary
// request spinner. Five seconds is enough to decide that code-level signal;
// ordinary request loading keeps the longer bounded timeout.
const PLATFORM_LOADING_TIMEOUT_MS = 5_000
const NORMAL_LOADING_TIMEOUT_MS = 20_000
// Goofish briefly exposes a 2x2 transparent image while a product card is
// settling.  Persisting that URL makes the evidence snapshot look as if the
// product image failed to load, even though the real image arrives a moment
// later.  Treat the known placeholder family as an empty observation and let
// the bounded settle pass below re-scan the card.

async function executionWithTimeout(wc, script, timeoutMs) {
  const execution = wc.executeJavaScript(script, true)
  execution.catch(() => {})
  let timer = null
  try {
    return await Promise.race([
      execution,
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs) })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function normalizeCrawlOptions(options = {}) {
  const testFast = options.executionMode === TEST_FAST_MODE
  const requestedMax = Number(options.maxItemsPerSeller)
  const requestedSteps = Number(options.maxScrollSteps)
  const requestedWait = Number(options.pageWaitMs)
  const requestedTimeout = Number(options.executionTimeoutMs)
  const adaptiveMax = Number.isFinite(requestedMax) && requestedMax > 0
    ? Math.floor(requestedMax)
    : Number.MAX_SAFE_INTEGER
  return {
    testFast,
    maxItems: testFast ? Math.min(20, adaptiveMax) : adaptiveMax,
    maxScrollSteps: Math.min(testFast ? 12 : 500, Math.max(testFast ? 1 : 5, Number.isFinite(requestedSteps) ? requestedSteps : (testFast ? 4 : 500))),
    pageWaitMs: Math.min(10000, Math.max(testFast ? 5 : 300, Number.isFinite(requestedWait) ? requestedWait : (testFast ? 10 : 1000))),
    executionTimeoutMs: Math.min(30000, Math.max(testFast ? 50 : 1000, Number.isFinite(requestedTimeout) ? requestedTimeout : (testFast ? 250 : 5000))),
    navigationTimeoutMs: testFast ? 500 : 20000
  }
}

const SCAN_FN = `(() => {
  const body = document.body ? (document.body.innerText || '') : '';
  const loggedOut = /扫码登录|请先登录|登录后查看更多/.test(body);
  const http429 = /(?:^|\D)429(?:\D|$)|请求过多/.test(body);
  const abs = (href) => { try { return new URL(href, location.href).href; } catch { return ''; } };
  const itemIdOf = (href) => {
    try {
      const u = new URL(href, location.href);
      const q = u.searchParams.get('id') || u.searchParams.get('itemId');
      if (q) return q;
    } catch {}
    const m = String(href).match(/(?:item[./?]|id=)([0-9]{6,})/i);
    return m ? m[1] : '';
  };
  const priceOf = (text) => {
    const m = String(text || '').match(/[¥￥]\\s*([0-9][0-9,]*(?:\\.[0-9]+)?)/);
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const cardOf = (el) => {
    let node = el;
    for (let i = 0; i < 6 && node.parentElement; i++) {
      const text = node.innerText || '';
      if (text.length >= 8 && /[¥￥]/.test(text)) return node;
      node = node.parentElement;
    }
    return el;
  };
  const titleOf = (card, text) => {
    const candidate = card.querySelector('[class*=title], [class*=name], [class*=desc]');
    const value = candidate ? (candidate.innerText || candidate.textContent || '').trim() : '';
    if (value) return value.slice(0, 240);
    return String(text || '').split(/\\n+/).map((v) => v.trim()).find((v) => v && !/[¥￥]/.test(v) && v.length > 2)?.slice(0, 240) || '';
  };
  const items = [];
  const seen = new Set();
  for (const el of Array.from(document.querySelectorAll('a[href], [data-item-id], [data-itemid], [data-id]'))) {
    const href = abs(el.getAttribute('href') || el.dataset?.href || '');
    const id = el.dataset?.itemId || el.dataset?.itemid || el.dataset?.id || el.getAttribute('data-item-id') || el.getAttribute('data-itemid') || el.getAttribute('data-id') || itemIdOf(href);
    if (!id || seen.has(id)) continue;
    const card = cardOf(el);
    const text = (card.innerText || el.innerText || '').trim();
    const image = card.querySelector('img');
    const imageCandidates = image ? [
      image.getAttribute('data-src'),
      image.getAttribute('data-lazy-src'),
      image.getAttribute('data-original'),
      image.getAttribute('data-url'),
      image.getAttribute('src'),
      image.currentSrc,
      image.srcset ? image.srcset.split(',')[0]?.trim().split(/\s+/)[0] : ''
    ] : [];
    const naturalWidth = Number(image?.naturalWidth || 0);
    const imageUrls = imageCandidates.map((value) => String(value || '').trim()).filter(Boolean).map(abs).filter((value) => value && !/^(?:data|blob):/i.test(value));
    // Prefer a real lazy-load attribute even while the rendered src is
    // still the 2x2 placeholder. Only mark the card as a placeholder when no
    // non-placeholder candidate exists at all.
    const usableImageUrl = imageUrls.find((value) => !/(?:-2-tps-2-2|placeholder|transparent|spacer|blank(?:\\.gif)?)/i.test(value)) || '';
    const imagePlaceholder = !usableImageUrl && Boolean(imageUrls.some((value) => /(?:-2-tps-2-2|placeholder|transparent|spacer|blank(?:\\.gif)?)/i.test(value)) || (naturalWidth > 0 && naturalWidth <= 2));
    const imageUrl = usableImageUrl;
    const sold = /已售出|交易成功|已卖出|已下架|交易关闭|不可见|售罄/.test(text);
    // Goofish currently renders the primary purchase action as “直接下单”
    // on seller-home cards. Keep the older labels for page-version
    // compatibility, but treat this explicit action as active evidence too.
    const active = /在售|上架中|立即购买|马上抢|直接下单|(?:\d+小时|一周)内发布/.test(text);
    const status = sold ? 'sold' : (active ? 'active' : 'unknown');
    const wantsMatch = text.match(/([0-9][0-9,]*)\s*人想要/);
    const category = (card.querySelector('[class*=category], [data-category]')?.innerText || card.getAttribute('data-category') || '').trim().slice(0, 80);
    items.push({
      itemId: String(id),
      itemUrl: href || (location.origin + '/item?id=' + encodeURIComponent(id)),
      title: titleOf(card, text),
      imageUrl,
      imagePlaceholder,
      price: priceOf(text),
      status,
      wants: wantsMatch ? Number(wantsMatch[1].replace(/,/g, '')) : 0,
      category,
      text: text.slice(0, 500)
    });
    seen.add(id);
  }
  const countOf = (text) => {
    const match = String(text || '').match(/([0-9]+(?:\.[0-9]+)?)\s*(万)?\s*$/);
    if (!match) return null;
    const value = Number(match[1]) * (match[2] ? 10000 : 1);
    return Number.isFinite(value) ? Math.round(value) : null;
  };
  // “加载更多”按钮只是可用操作，不等于当前请求正在加载；只有明确的
  // 加载文案或可见 busy/spinner 元素才进入等待分支，避免到底页被误判成
  // 永久 loading。
  const viewportHeight = window.innerHeight || 720;
  const loadingNodes = Array.from(document.querySelectorAll('[aria-busy="true"], [class*=loading], [class*=Loading], [class*=spinner]')).filter((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < (window.innerHeight || 720);
  });
  // Do not search the whole document for a loading phrase.  Seller pages keep
  // a virtualized bottom-tip node in the DOM even after it has scrolled far
  // outside the viewport; matching body.innerText therefore made every page
  // look permanently busy and produced loading_timeout after a fixed number
  // of scroll rounds.  A loading phrase is meaningful only when it belongs to
  // a currently visible busy/spinner node (the node list below is already
  // clipped to the viewport).
  const loadingText = loadingNodes.some((el) => /加载中|正在加载|努力加载/.test(el.innerText || el.textContent || ''));
  const loadingBottom = loadingNodes.some((el) => {
    const rect = el.getBoundingClientRect();
    return rect.top >= viewportHeight * 0.62 || rect.bottom >= viewportHeight * 0.82;
  });
  const loadingSpinner = loadingNodes.length > 0;
  const loading = loadingText || loadingSpinner;
  // Keep the two UI signals separate: a bottom loader is the platform/list
  // boundary candidate; a normal request spinner should simply be awaited.
  const loadingKind = loadingBottom ? 'bottom' : (loading ? 'request' : 'none');
  const tabEls = Array.from(document.querySelectorAll('button, [role=tab], a, [class*=tab]'));
  const tabs = tabEls.map((el) => {
    const text = (el.innerText || el.textContent || '').trim();
    return { text, count: countOf(text.replace(/,/g, '')), active: el.getAttribute('aria-selected') === 'true' };
  }).filter((x) => /^(综合|全部|在售|出售中|已售|已售出|卖出)(?:\s*(?:[0-9][0-9,.]*|[0-9]+(?:\.[0-9]+)?\s*万))?$/.test(x.text));
  // The first generic nick selector is the logged-in account's order
  // header. The target seller name is inside the seller profile header under
  // personalWrap/infoTop; only use the card seller as a version-compatible
  // fallback. Never persist the account nickname as the crawled seller.
  const sellerName = (
    document.querySelector('[class*=personalWrap] [class*=infoTop] [class*=nick]') ||
    document.querySelector('[class*=personalWrap] [class*=nick]') ||
    document.querySelector('[class*=seller-text-wrap] [class*=seller-text]') ||
    document.querySelector('[class*=seller-name], [class*=user-name]')
  )?.innerText?.trim().slice(0, 128) || '';
  return { loggedOut: loggedOut && items.length === 0, http429, items, imagePlaceholderCount: items.filter((item) => item.imagePlaceholder).length, tabs, sellerName, loading, loadingKind, loadingBottom, endHints: /没有更多|已经到底|到底了|暂无更多/.test(body), bodySample: body.slice(0, 300) };
})()`

const SELECT_SELLER_SECTION_FN = `((section) => {
  const wanted = section === 'sold' ? 'sold' : 'active';
  const pattern = wanted === 'sold'
    ? /^(?:已售出?|卖出)(?:\\s*[0-9,.]+(?:\\s*万)?)?$/
    : /^(?:在售|出售中)(?:\\s*[0-9,.]+(?:\\s*万)?)?$/;
  const nodes = Array.from(document.querySelectorAll('[class*=tabItem], button, [role=tab]'));
  const target = nodes.find((node) => pattern.test((node.innerText || node.textContent || '').trim()));
  if (!target) return { clicked: false, reason: 'TAB_NOT_FOUND', section: wanted };
  const active = String(target.className || '').includes('active') || target.getAttribute('aria-selected') === 'true';
  if (!active) target.click();
  return { clicked: true, alreadyActive: active, section: wanted };
})(__SECTION__)`

async function selectSellerSection(wc, section, timeoutMs = 5000) {
  const script = SELECT_SELLER_SECTION_FN.replace('__SECTION__', JSON.stringify(section))
  const result = await executionWithTimeout(wc, script, timeoutMs)
  return result?.clicked === true
}

const SETTLE_VISIBLE_IMAGES_FN = `(async (waitMs) => {
  const deadline = Date.now() + Math.min(2500, Math.max(250, Number(waitMs) || 1600));
  const visiblePlaceholders = () => Array.from(document.querySelectorAll('a[href*="/item"] img, [data-item-id] img, [data-itemid] img, [data-id] img')).filter((img) => {
    const rect = img.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < (window.innerHeight || 720))) return false;
    const urls = [img.currentSrc, img.src, img.getAttribute('data-src'), img.getAttribute('data-lazy-src'), img.getAttribute('data-original')].filter(Boolean).map(String);
    return urls.some((url) => /(?:-2-tps-2-2|placeholder|transparent|spacer|blank(?:\\.gif)?)/i.test(url)) || (Number(img.naturalWidth || 0) > 0 && Number(img.naturalWidth || 0) <= 2);
  });
  let remaining = visiblePlaceholders().length;
  while (remaining > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    remaining = visiblePlaceholders().length;
  }
  return { remaining };
})(__WAIT_MS__)`

async function scan(wc, timeoutMs = 5000) {
  try {
    return await executionWithTimeout(wc, SCAN_FN, timeoutMs)
  } catch {
    return null
  }
}

async function settleVisibleImages(wc, timeoutMs = 5000, waitMs = 1600) {
  try {
    return await executionWithTimeout(wc, SETTLE_VISIBLE_IMAGES_FN.replace('__WAIT_MS__', String(Math.max(250, Math.min(2500, Number(waitMs) || 1600)))), timeoutMs)
  } catch {
    return null
  }
}

function navigationFailure(wc) {
  const evidence = consumeSellerNavigationEvidence(wc)
  if (!evidence) return null
  if (evidence.reasonCode === 'ITEM_DETAIL_BLOCKED' || evidence.reasonCode === 'NAVIGATION_BLOCKED') return null
  if (evidence.reasonCode === 'LOGIN_EXPIRED') return { ok: false, loggedOut: true, reasonCode: evidence.reasonCode, reason: '账号登录已失效' }
  if (evidence.reasonCode === 'PUBLIC_HOME_FALLBACK') return { ok: false, publicHomeFallback: true, reasonCode: evidence.reasonCode, reason: '卖家页回退到闲鱼公共首页' }
  if (evidence.reasonCode === 'HTTP_429') return { ok: false, http429: true, riskControl: true, reasonCode: evidence.reasonCode, reason: '闲鱼返回 429 限流' }
  if (evidence.reasonCode === 'RISK_CONTROL') return { ok: false, riskControl: true, reasonCode: evidence.reasonCode, reason: '进入闲鱼验证/风控页' }
  if (evidence.reasonCode === 'NAV_TRANSIENT') return { ok: false, transient: true, reasonCode: evidence.reasonCode, reason: '卖家页导航短暂失败' }
  return null
}

function navigationLifecycleFailure(wc, expectedUrl) {
  if (typeof wc?.getNavigationState !== 'function') return null
  const state = wc.getNavigationState()
  const current = String(state?.currentUrl || wc.getURL?.() || '')
  const comparable = (value) => {
    try {
      const url = new URL(String(value || ''))
      url.hash = ''
      return url.href
    } catch {
      return String(value || '').trim()
    }
  }
  if (state?.status !== 'ready') return { ok: false, transient: true, reasonCode: 'NAVIGATION_NOT_READY', reason: '卖家页导航未完成，禁止读取旧页面证据' }
  if (comparable(current) !== comparable(expectedUrl)) return { ok: false, transient: true, reasonCode: 'NAVIGATION_URL_MISMATCH', reason: '卖家页地址与本次请求不一致，禁止读取旧页面证据' }
  return null
}

export function serializeSellerCard(item, capturedAt = new Date().toISOString()) {
  const numericPrice = Number(item?.price)
  const numericWants = Number(item?.wants)
  const safeUrl = (value, kind) => {
    try {
      const url = new URL(String(value || ''))
      if (url.protocol !== 'https:') return ''
      if (kind === 'item') {
        const host = url.hostname.toLowerCase()
        if (host !== 'goofish.com' && !host.endsWith('.goofish.com')) return ''
        const allowed = new Set(['id', 'itemId'])
        for (const key of [...url.searchParams.keys()]) {
          if (!allowed.has(key)) url.searchParams.delete(key)
        }
      } else {
        for (const key of [...url.searchParams.keys()]) {
          if (/token|signature|sig|session|auth|credential|secret|password|cookie|access[_-]?key/i.test(key)) {
            url.searchParams.delete(key)
          }
        }
      }
      url.username = ''
      url.password = ''
      url.hash = ''
      return url.href
    } catch {
      return ''
    }
  }
  return {
    itemId: String(item?.itemId || ''),
    itemUrl: safeUrl(item?.itemUrl, 'item'),
    title: String(item?.title || '').slice(0, 240),
    imageUrl: safeUrl(item?.imageUrl, 'image'),
    price: Number.isFinite(numericPrice) && numericPrice > 0 ? numericPrice : null,
    status: item?.status === 'sold' ? 'sold' : (item?.status === 'active' ? 'active' : 'unknown'),
    wants: Number.isFinite(numericWants) && numericWants >= 0 ? numericWants : 0,
    category: String(item?.category || '').slice(0, 80),
    capturedAt: String(item?.capturedAt || capturedAt)
  }
}

// Imported source workbooks may contain privacy-masked seller names such as
// “N***s”. That value is useful as an import hint, but once the seller home
// has rendered its public profile name we must keep the real page name for the
// crawl result. The source name is only a fallback for an older page version
// that does not expose the profile header.
export function isMaskedSellerName(value) {
  return /[*＊•●…]/.test(String(value || ''))
}

export function resolveAuthoritativeSellerName({ sourceSellerName = '', pageSellerName = '' } = {}) {
  const source = String(sourceSellerName || '').trim().slice(0, 128)
  const page = String(pageSellerName || '').trim().slice(0, 128)
  return page || source
}

async function scrollMetrics(wc, timeoutMs = 5000) {
  try {
    return await executionWithTimeout(wc, `(() => {
      const root = document.scrollingElement || document.documentElement;
      // Do not walk the entire DOM on every scroll step. Large seller pages
      // can contain thousands of virtualized nodes; the card anchor below is
      // the primary target, while these stable containers are only a fallback.
      const cardSelector = 'a[href*="/item"], [data-item-id], [data-itemid], [data-id]';
      const cardNodes = Array.from(document.querySelectorAll(cardSelector)).slice(0, 48);
      const cardScrollers = new Set();
      for (const card of cardNodes) {
        let node = card.parentElement;
        while (node && node !== document.body && node !== document.documentElement) {
          if (node.scrollHeight > node.clientHeight + 40) { cardScrollers.add(node); break; }
          node = node.parentElement;
        }
      }
      const candidates = [...cardScrollers, root, ...Array.from(document.querySelectorAll('main, section, ul, ol, [class*=scroll], [class*=list], [class*=content], [style*=overflow]'))]
        .filter((el, index, list) => el && list.indexOf(el) === index)
        .filter((el) => el.scrollHeight > el.clientHeight + 40)
        .sort((a, b) => {
          const cardPriority = Number(cardScrollers.has(b)) - Number(cardScrollers.has(a));
          return cardPriority || ((b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
        })
        .slice(0, 12);
      const rows = candidates.map((el) => ({
        top: Math.round(el.scrollTop || 0),
        max: Math.max(0, Math.round((el.scrollHeight || 0) - (el.clientHeight || 0))),
        rect: (() => {
          const r = el.getBoundingClientRect();
          return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) };
        })()
      }));
      const rootMax = Math.max(0, Math.round((root?.scrollHeight || 0) - (root?.clientHeight || 0)));
      const rootTop = Math.round(root?.scrollTop || 0);
      const cardCount = cardNodes.length;
      const primary = rows[0];
      const rootAtBottom = rootMax > 0 && rootTop >= rootMax - 8;
      const primaryAtBottom = Boolean(primary && primary.max > 0 && primary.top >= primary.max - 8);
      const viewportWidth = Math.max(1, Math.round(window.innerWidth || document.documentElement?.clientWidth || 1024));
      const viewportHeight = Math.max(1, Math.round(window.innerHeight || document.documentElement?.clientHeight || 720));
      const wheelTargets = rows
        .filter((row) => row.rect.width > 40 && row.rect.height > 40 && row.rect.bottom > 0 && row.rect.top < viewportHeight && row.rect.right > 0 && row.rect.left < viewportWidth)
        .sort((a, b) => b.max - a.max)
        .slice(0, 4)
        .map((row) => ({
          x: Math.max(1, Math.min(viewportWidth - 1, Math.round((Math.max(0, row.rect.left) + Math.min(viewportWidth, row.rect.right)) / 2))),
          y: Math.max(1, Math.min(viewportHeight - 1, Math.round((Math.max(0, row.rect.top) + Math.min(viewportHeight, row.rect.bottom)) / 2)))
        }));
      return {
        windowTop: Math.round(window.scrollY || 0),
        windowMax: Math.max(0, Math.round((root?.scrollHeight || 0) - (root?.clientHeight || 0))),
        rootTop,
        rootMax,
        candidates: rows,
        cardCount,
        // The previous implementation always sent wheel input to (520,420),
        // which can land on a header/sidebar while the actual product list is
        // a nested scroll container. Keep the target coordinates observational
        // only; they never leave the renderer or enter persisted seller data.
        wheelTargets,
        cardScrollerCount: cardScrollers.size,
        // When product cards live in a nested scroller, the outer document can
        // legitimately be at its own bottom while the product list still has
        // pages below it. In that case only the card scroller is authoritative.
        // Fall back to the document root only when no card-owned scroller was
        // found; an empty candidate list is never bottom evidence by itself.
        atBottom: cardScrollers.size > 0
          ? primaryAtBottom
          : (rootAtBottom || primaryAtBottom)
      };
    })()`, timeoutMs)
  } catch {
    return null
  }
}

async function loadingMetrics(wc, timeoutMs = 5000) {
  try {
    return await executionWithTimeout(wc, `(() => {
      const body = document.body ? (document.body.innerText || '') : '';
      const viewportHeight = window.innerHeight || 720;
      const nodes = Array.from(document.querySelectorAll('[aria-busy="true"], [class*=loading], [class*=Loading], [class*=spinner]')).filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < viewportHeight;
      });
      // Keep this in lock-step with SCAN_FN: text below the current viewport
      // is not an active request.  The visible node test avoids waiting for a
      // persistent virtualized bottom-tip that is merely present in the DOM.
      const loadingText = nodes.some((el) => /加载中|正在加载|努力加载/.test(el.innerText || el.textContent || ''));
      const loadingBottom = nodes.some((el) => {
        const rect = el.getBoundingClientRect();
        return rect.top >= viewportHeight * 0.62 || rect.bottom >= viewportHeight * 0.82;
      });
      return { loading: loadingText || nodes.length > 0, loadingBottom };
    })()`, timeoutMs)
  } catch {
    return null
  }
}

async function scrollPage(wc, { timeoutMs = 5000, wheelPauseMs = 160, settleMs = 350, anchorItemId = '' } = {}) {
  const before = await scrollMetrics(wc, timeoutMs)
  // 已经在列表底部时，滚动本身不会产生新证据，继续派发 wheel 只会让
  // 闲鱼反复显示“加载中”或触发无效请求。先把底部证据交回收口逻辑。
  if (before?.atBottom) return { before, after: before, atBottom: true }
  let anchorTarget = null
  let attachedDebugger = false
  try {
    if (anchorItemId) {
      anchorTarget = await executionWithTimeout(wc, `((wanted) => {
        for (const el of Array.from(document.querySelectorAll('a[href], [data-item-id], [data-itemid], [data-id]'))) {
          const href = el.getAttribute('href') || el.dataset?.href || '';
          let id = el.dataset?.itemId || el.dataset?.itemid || el.dataset?.id || el.getAttribute('data-item-id') || el.getAttribute('data-itemid') || el.getAttribute('data-id') || '';
          if (!id) { try { id = new URL(href, location.href).searchParams.get('id') || new URL(href, location.href).searchParams.get('itemId') || ''; } catch {} }
          if (String(id) !== String(wanted)) continue;
          el.scrollIntoView({ block: 'end', inline: 'nearest' });
          let node = el.parentElement;
          while (node && node !== document.body) {
            if (node.scrollHeight > node.clientHeight + 40) {
              const r = node.getBoundingClientRect();
              const width = Math.max(1, Math.round(window.innerWidth || document.documentElement?.clientWidth || 1024));
              const height = Math.max(1, Math.round(window.innerHeight || document.documentElement?.clientHeight || 720));
              return {
                found: true,
                wheelTarget: {
                  x: Math.max(1, Math.min(width - 1, Math.round((Math.max(0, r.left) + Math.min(width, r.right)) / 2))),
                  y: Math.max(1, Math.min(height - 1, Math.round((Math.max(0, r.top) + Math.min(height, r.bottom)) / 2)))
                }
              };
            }
            node = node.parentElement;
          }
          return { found: true, wheelTarget: { x: Math.round((window.innerWidth || 1024) / 2), y: Math.round((window.innerHeight || 720) / 2) } };
        }
        return { found: false, wheelTarget: null };
      })(${JSON.stringify(String(anchorItemId))})`, timeoutMs)
    }
    // 主页商品列表经常放在嵌套容器里，鼠标坐标不一定落在真正的列表上。
    // 先推进可滚动容器和根页面，再用 Chromium wheel 事件触发懒加载。
    await executionWithTimeout(wc, `(() => {
      const root = document.scrollingElement || document.documentElement;
      const wanted = ${JSON.stringify(String(anchorItemId || ''))};
      const containers = [];
      if (wanted) {
        for (const el of Array.from(document.querySelectorAll('a[href], [data-item-id], [data-itemid], [data-id]'))) {
          const href = el.getAttribute('href') || el.dataset?.href || '';
          let id = el.dataset?.itemId || el.dataset?.itemid || el.dataset?.id || el.getAttribute('data-item-id') || el.getAttribute('data-itemid') || el.getAttribute('data-id') || '';
          if (!id) { try { id = new URL(href, location.href).searchParams.get('id') || new URL(href, location.href).searchParams.get('itemId') || ''; } catch {} }
          if (String(id) !== wanted) continue;
          let node = el.parentElement;
          while (node && node !== document.body) {
            if (node.scrollHeight > node.clientHeight + 40) { containers.push(node); break; }
            node = node.parentElement;
          }
          break;
        }
      }
      if (!containers.length) {
        containers.push(...Array.from(document.querySelectorAll('main, section, ul, ol, [class*=scroll], [class*=list], [class*=content], [style*=overflow]'))
          .filter((el) => el.scrollHeight > el.clientHeight + 40)
          .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))
          .slice(0, 8));
      }
      const delta = Math.max(640, Math.round((window.innerHeight || 720) * 0.85));
      for (const el of containers) el.scrollTop = Math.min(el.scrollTop + delta, el.scrollHeight);
      if (root) root.scrollTop = Math.min((root.scrollTop || 0) + delta, root.scrollHeight);
      window.scrollBy(0, delta);
      return { containers: containers.length, delta };
    })()`, timeoutMs)
    const delta = 760
    // The anchor's nearest scroll ancestor is more trustworthy than a second
    // full-page scan. Only scan again when the anchor lookup failed, avoiding
    // an extra renderer round-trip on every production scroll step.
    const afterDom = anchorTarget?.wheelTarget ? null : await scrollMetrics(wc, timeoutMs)
    const candidateTargets = [
      anchorTarget?.wheelTarget,
      ...(Array.isArray(afterDom?.wheelTargets) ? afterDom.wheelTargets : []),
      ...(Array.isArray(before?.wheelTargets) ? before.wheelTargets : []),
      { x: 520, y: 420 }
    ].filter((target) => target && Number.isFinite(Number(target.x)) && Number.isFinite(Number(target.y)))
    const wheelTargets = []
    const seenTargets = new Set()
    for (const target of candidateTargets) {
      const normalized = { x: Math.round(Number(target.x)), y: Math.round(Number(target.y)) }
      const key = `${normalized.x}:${normalized.y}`
      if (seenTargets.has(key)) continue
      seenTargets.add(key)
      wheelTargets.push(normalized)
      if (wheelTargets.length >= 2) break
    }
    // 闲鱼商品列表通常位于嵌套滚动容器；executeJavaScript 的 scrollTop/scrollTo
    // 不一定触发它的懒加载，所以需要产生可信的 Chromium 滚轮事件。
    // 卖家 worker 是隐藏且不可聚焦的 BrowserWindow，sendInputEvent 在这种窗口上
    // 会被 Electron 丢弃（官方要求宿主窗口先获得焦点）。因此后台采集优先走
    // CDP；只有明确确认窗口当前聚焦时，才允许回退到 sendInputEvent，避免把焦点
    // 抢到后台采集器上。
    const protocol = wc.debugger && typeof wc.debugger.sendCommand === 'function' ? wc.debugger : null
    let protocolReady = false
    if (protocol) {
      try {
        const isAttached = typeof protocol.isAttached === 'function' ? protocol.isAttached() : false
        if (!isAttached) {
          protocol.attach('1.3')
          attachedDebugger = true
        }
        protocolReady = true
      } catch {
        protocolReady = false
      }
    }
    if (protocolReady) {
      for (const target of wheelTargets) {
        for (let i = 0; i < 2; i++) {
          await protocol.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: target.x, y: target.y, deltaX: 0, deltaY: delta, buttons: 0 })
          await sleep(wheelPauseMs)
        }
      }
    } else if (typeof wc.sendInputEvent === 'function') {
      const ownerWindow = typeof wc.getOwnerBrowserWindow === 'function' ? wc.getOwnerBrowserWindow() : null
      const focused = typeof wc.isFocused === 'function'
        ? wc.isFocused()
        : Boolean(ownerWindow && typeof ownerWindow.isFocused === 'function' && ownerWindow.isFocused())
      if (focused) {
        for (const target of wheelTargets) {
          for (let i = 0; i < 2; i++) {
            wc.sendInputEvent({ type: 'mouseWheel', x: target.x, y: target.y, deltaX: 0, deltaY: delta, canScroll: true })
            await sleep(wheelPauseMs)
          }
        }
      }
    }
  } catch {
    /* page may have been destroyed during navigation */
  } finally {
    if (attachedDebugger) {
      try { wc.debugger.detach() } catch { /* renderer may already be gone */ }
    }
  }
  await sleep(settleMs)
  let after = await scrollMetrics(wc, timeoutMs)
  if (after?.atBottom) {
    // Reaching the old scrollHeight and starting a lazy request are separate
    // events. Do not close the branch while a bottom loader is still active:
    // wait for the list to either grow or prove a stable, non-loading bottom.
    const deadline = Date.now() + PLATFORM_LOADING_TIMEOUT_MS
    let loading = await loadingMetrics(wc, timeoutMs)
    while (loading?.loading && Date.now() < deadline) {
      await sleep(250)
      after = await scrollMetrics(wc, timeoutMs)
      if (!after?.atBottom) return { before, after, atBottom: false }
      loading = await loadingMetrics(wc, timeoutMs)
    }
    if (loading?.loading) return { before, after, atBottom: false }
  }
  return { before, after, atBottom: Boolean(after?.atBottom) }
}

function mergeItem(map, item, section, excludeIds = new Set()) {
  if (!item?.itemId) return
  if (excludeIds.has(String(item.itemId))) return
  const incoming = {
    ...item,
    // A later virtualized scan may briefly see a card without its image while
    // the real URL is swapping in. Never erase a previously captured real
    // image with that transient empty observation.
    imageUrl: String(item.imageUrl || '').trim() || String(map.get(item.itemId)?.imageUrl || '').trim(),
    status: item.status === 'unknown' && section !== 'combined' ? section : item.status
  }
  const old = map.get(item.itemId)
  // 在售优先：如果同一个商品在切换标签后出现两次，不让已售覆盖在售观测。
  if (old?.status === 'active' && incoming.status === 'sold') return
  map.set(item.itemId, incoming)
}

async function collectSection(wc, section, map, { maxItems, maxScrollSteps, pageWaitMs, executionTimeoutMs, testFast, excludeIds, onEvidence, now = () => Date.now() }) {
  let stableRounds = 0
  let lastCount = 0
  let expectedCount = null
  let expectedActiveCount = null
  let expectedSoldCount = null
  let stopReason = 'safety_limit'
  let loadingObserved = false
  let loadingKind = 'none'
  let loadingStartedAt = 0
  let imagePlaceholderCount = 0
  let steps = 0
  for (; steps < maxScrollSteps && map.size < maxItems; steps++) {
    const blockedNavigation = navigationFailure(wc)
    if (blockedNavigation) return blockedNavigation
    const riskPage = await detectRiskPage(wc)
    if (riskPage?.riskControl) return {
      ok: false,
      riskControl: true,
      reasonCode: 'RISK_CONTROL',
      reason: `连续检测到闲鱼风控页面（${riskPage.signal || '需要验证'}）`,
      riskEvidence: riskPage
    }
    const snap = await scan(wc, executionTimeoutMs)
    if (!snap) return { ok: false, reason: '页面无响应' }
    if (snap.loggedOut) return { ok: false, reason: '该账号未登录闲鱼', loggedOut: true }
    if (snap.http429) return { ok: false, reason: '闲鱼返回 429 限流', http429: true, riskControl: true, reasonCode: 'HTTP_429' }
    imagePlaceholderCount = Math.max(imagePlaceholderCount, Number(snap.imagePlaceholderCount || 0))
    const activeTab = (snap.tabs || []).find((t) => /^(在售|出售中)/.test(t.text))
    const soldTab = (snap.tabs || []).find((t) => /已售|卖出/.test(t.text))
    const combinedTab = (snap.tabs || []).find((t) => /^(综合|全部)/.test(t.text))
    if (section === 'combined') {
      expectedCount = combinedTab?.count ?? (
        activeTab?.count != null && soldTab?.count != null
          ? Number(activeTab.count) + Number(soldTab.count)
          : (activeTab?.count ?? soldTab?.count ?? null)
      )
    } else {
      expectedCount = (section === 'sold' ? soldTab : activeTab)?.count ?? null
    }
    expectedActiveCount = activeTab?.count ?? null
    expectedSoldCount = soldTab?.count ?? null
    for (const item of snap.items || []) mergeItem(map, item, section, excludeIds)
    const sectionCount = section === 'combined'
      ? map.size
      : [...map.values()].filter((item) => item.status === section).length
    const branchItems = section === 'combined'
      ? [...map.values()]
      : [...map.values()].filter((item) => item.status === section)
    if (onEvidence) {
      try {
        await onEvidence({
          branch: section,
          expectedCount,
          expectedActiveCount,
          expectedSoldCount,
          expectedTrusted: expectedCount != null,
          loading: Boolean(snap.loading),
          loadingKind: snap.loadingKind || 'none',
          loadingBottom: Boolean(snap.loadingBottom),
          imagePlaceholderCount: Number(snap.imagePlaceholderCount || 0),
          itemIds: branchItems.map((item) => String(item.itemId)),
          itemIdsActive: branchItems.filter((item) => item.status === 'active').map((item) => String(item.itemId)),
          itemIdsSold: branchItems.filter((item) => item.status === 'sold').map((item) => String(item.itemId)),
          unknownItemIds: branchItems.filter((item) => item.status === 'unknown').map((item) => String(item.itemId)),
          collectedAt: new Date().toISOString()
        })
      } catch (error) {
        return { ok: false, persistenceFailed: true, reason: `断点保存失败: ${error?.message || error}` }
      }
    }
    if (expectedCount != null && sectionCount >= expectedCount) {
      stopReason = 'expected_reached'
      break
    }
    if (map.size >= maxItems) {
      stopReason = 'explicit_cap'
      break
    }
    // “加载中”不是“到底了”：不要在请求尚未完成时继续派发滚轮，也不要
    // 把这几轮当作无进展。让页面完成当前批次；循环本身仍受 maxScrollSteps
    // 有界保护，持续加载异常最终会留下 safety_limit 证据。
    if (snap.loading) {
      loadingObserved = true
      loadingKind = snap.loadingKind || (snap.loadingBottom ? 'bottom' : 'request')
      if (!loadingStartedAt) loadingStartedAt = now()
      const loadingDurationMs = now() - loadingStartedAt
      const loadingLooksLikePlatformBoundary = (snap.loadingKind === 'bottom' || snap.loadingBottom === true) &&
        (expectedCount == null || expectedCount > sectionCount)
      const loadingTimeoutMs = loadingLooksLikePlatformBoundary ? PLATFORM_LOADING_TIMEOUT_MS : NORMAL_LOADING_TIMEOUT_MS
      if (loadingDurationMs >= loadingTimeoutMs) {
        stopReason = loadingLooksLikePlatformBoundary ? 'platform_boundary' : 'loading_timeout'
        break
      }
      stableRounds = 0
      await sleep(Math.max(pageWaitMs, testFast ? 5 : 500))
      continue
    }
    loadingStartedAt = 0
    if (sectionCount === lastCount) stableRounds++
    else stableRounds = 0
    lastCount = sectionCount
    // 有可信的标签总数时，稳定几轮不代表主页真的到底；但连续多轮没有
    // 新卡片也说明当前渲染器/滚动容器没有进展。保存部分证据后交给
    // 调度器做一次有界续采，不能把整个运行锁在同一张页面上。
    const stableRoundLimit = expectedCount != null && sectionCount < expectedCount
      ? MAX_STABLE_EXPECTED_SHORTFALL_ROUNDS
      : MAX_STABLE_NO_PROGRESS_ROUNDS
    if (snap.endHints || stableRounds >= stableRoundLimit) {
      stopReason = snap.endHints ? 'page_end_hint' : 'stable_without_proof'
      break
    }
    const scroll = await scrollPage(wc, {
      timeoutMs: executionTimeoutMs,
      wheelPauseMs: testFast ? 1 : 160,
      settleMs: testFast ? 1 : 350,
      anchorItemId: snap.items?.at(-1)?.itemId || ''
    })
    // 到底是硬收口证据：scrollPage 已经确认所有可见滚动容器都到末端时，
    // 当前分支立即停止，不能再要求“再稳定一轮”或继续派发下一次 wheel。
    // 否则没有“没有更多”文案的主页会在底部反复滚动，表现为一直加载/卡死。
    if (scroll?.atBottom) {
      stopReason = 'page_bottom'
      break
    }
    // Only pay the bounded image-settle wait on viewports that actually
    // exposed a placeholder. The helper exits early as soon as Goofish swaps
    // in the real image, so long seller pages do not incur a fixed delay per
    // scroll step.
    if (!testFast && Number(snap.imagePlaceholderCount || 0) > 0) {
      await settleVisibleImages(wc, executionTimeoutMs, testFast ? 250 : 1600)
    }
    await sleep(pageWaitMs)
  }
  const observedCount = section === 'combined'
    ? map.size
    : [...map.values()].filter((item) => item.status === section).length
  const expectedReached = expectedCount != null && observedCount >= expectedCount
  if (map.size >= maxItems && !expectedReached && stopReason === 'safety_limit') {
    stopReason = 'explicit_cap'
  }
  const platformBoundaryReached = (
    stopReason === 'platform_boundary' ||
    ((stopReason === 'page_bottom' || stopReason === 'page_end_hint') && expectedCount != null && observedCount < expectedCount)
  )
  return {
    ok: true,
    capped: map.size >= maxItems || platformBoundaryReached,
    // Kept as a compatibility alias for persisted rows and older renderers;
    // it now means a code-detected platform boundary, never “count reached”.
    platformCapReached: platformBoundaryReached,
    platformBoundaryReached,
    loadingObserved,
    loadingKind,
    imagePlaceholderCount,
    expectedCount,
    expectedActiveCount,
    expectedSoldCount,
    expectedTrusted: expectedCount != null,
    sectionCount: observedCount,
    steps,
    stopReason,
    safetyLimitReached: !expectedReached && map.size < maxItems && steps >= maxScrollSteps
  }
}

/**
 * 采集一个卖家主页。默认不按固定数量截断；优先分别采集“在售”和
 * “已售出”两个页面分支，再合并 itemId 证据。只有旧页面没有两个可识别
 * 分支时才回退综合列表；综合列表无法证明状态的卡片会保持 unknown，不能
 * 被伪装成成功。
 */
export async function crawlSellerPage(wc, sellerUrl, options = {}) {
  const { maxItems, maxScrollSteps, pageWaitMs, executionTimeoutMs, navigationTimeoutMs, testFast } = normalizeCrawlOptions(options)
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const excludeIds = new Set((options.excludeItemIds || []).map((id) => String(id)))
  let canonicalSellerUrl
  try {
    canonicalSellerUrl = normalizeSellerHomeUrl(sellerUrl)
  } catch (error) {
    return { ok: false, needsReview: true, reasonCode: 'INVALID_SELLER_URL', reason: error?.message || String(error) }
  }
  // 上一次被拦截的弹窗/短暂失败不得污染这一次显式卖家导航的结果。
  consumeSellerNavigationEvidence(wc)
  try {
    const navigation = wc.loadURL(canonicalSellerUrl)
    navigation.catch(() => {})
    let navigationTimer = null
    const outcome = await Promise.race([
      navigation.then(() => ({ status: 'loaded' }), (error) => ({ status: 'error', error })),
      new Promise((resolve) => { navigationTimer = setTimeout(() => resolve({ status: 'timeout' }), navigationTimeoutMs) })
    ])
    if (navigationTimer) clearTimeout(navigationTimer)
    if (outcome.status === 'timeout') {
      try { wc.stop?.() } catch { /* renderer may already be gone */ }
      return { ok: false, transient: true, reasonCode: 'NAV_TIMEOUT', reason: '卖家页导航超时' }
    }
    if (outcome.status === 'error' && !/ERR_ABORTED/.test(String(outcome.error?.message || outcome.error))) throw outcome.error
  } catch (e) {
    if (!/ERR_ABORTED/.test(String(e?.message))) return { ok: false, transient: true, reasonCode: 'NAV_TRANSIENT', reason: '导航失败: ' + (e?.message || e) }
  }
  await sleep(testFast ? pageWaitMs : Math.max(800, pageWaitMs))
  const lifecycleFailure = navigationLifecycleFailure(wc, canonicalSellerUrl)
  if (lifecycleFailure) return lifecycleFailure
  const blockedNavigation = navigationFailure(wc)
  if (blockedNavigation) return blockedNavigation
  const riskPage = await detectRiskPage(wc)
  if (riskPage?.riskControl) return {
    ok: false,
    riskControl: true,
    reasonCode: 'RISK_CONTROL',
    reason: `连续检测到闲鱼风控页面（${riskPage.signal || '需要验证'}）`,
    riskEvidence: riskPage
  }
  // Wait for the first visible card batch to leave Goofish's 2x2 placeholder
  // state before the initial scan. Subsequent viewports are settled after
  // scrolls when the scan reports the same transient marker.
  if (!testFast) await settleVisibleImages(wc, executionTimeoutMs, 1600)
  const first = await scan(wc, executionTimeoutMs)
  if (!first) return { ok: false, transient: true, reasonCode: 'RENDER_CRASH', reason: '页面无响应' }
  if (first.loggedOut) return { ok: false, reason: '该账号未登录闲鱼', loggedOut: true }
  if (first.http429) return { ok: false, reason: '闲鱼返回 429 限流', http429: true, riskControl: true, reasonCode: 'HTTP_429' }

  const tabTexts = new Set((first.tabs || []).map((t) => t.text))
  // The first scan is the seller's own page-level statement of scope. Capture
  // it once before scrolling or switching branches; later virtualized scans
  // may expose only a partial/revised tab DOM and must not redefine the
  // threshold decision.
  const firstPageExpected = {
    active: (first.tabs || []).find((tab) => /^(在售|出售中)/.test(tab.text))?.count ?? null,
    sold: (first.tabs || []).find((tab) => /已售|卖出/.test(tab.text))?.count ?? null
  }
  const hasActiveTab = (first.tabs || []).some((tab) => /^(在售|出售中)/.test(tab.text))
  const hasSoldTab = (first.tabs || []).some((tab) => /已售|卖出/.test(tab.text))
  let activeItems = new Map()
  let soldItems = new Map()
  let fallbackItems = null
  let activeResult = null
  let soldResult = null
  let selection = 'default_combined'

  if (hasActiveTab && hasSoldTab) {
    selection = 'active_sold_tabs'
    if (!await selectSellerSection(wc, 'active', executionTimeoutMs)) {
      return { ok: false, needsReview: true, reasonCode: 'TAB_NOT_FOUND', reason: '未能切换到在售分支' }
    }
    await sleep(testFast ? pageWaitMs : Math.max(500, pageWaitMs))
    if (!testFast) await settleVisibleImages(wc, executionTimeoutMs, 1600)
    activeResult = await collectSection(wc, 'active', activeItems, {
      maxItems, maxScrollSteps, pageWaitMs, executionTimeoutMs, testFast, excludeIds, onEvidence: options.onEvidence, now
    })
    if (!activeResult.ok) return activeResult

    const soldBudget = Math.max(0, maxItems - activeItems.size)
    if (soldBudget > 0) {
      if (!await selectSellerSection(wc, 'sold', executionTimeoutMs)) {
        return { ok: false, needsReview: true, reasonCode: 'TAB_NOT_FOUND', reason: '未能切换到已售分支' }
      }
      await sleep(testFast ? pageWaitMs : Math.max(500, pageWaitMs))
      if (!testFast) await settleVisibleImages(wc, executionTimeoutMs, 1600)
      soldResult = await collectSection(wc, 'sold', soldItems, {
        maxItems: soldBudget, maxScrollSteps, pageWaitMs, executionTimeoutMs, testFast, excludeIds, onEvidence: options.onEvidence, now
      })
      if (!soldResult.ok) return soldResult
    } else {
      const soldTab = (first.tabs || []).find((tab) => /已售|卖出/.test(tab.text))
      soldResult = {
        ok: true,
        capped: true,
        platformCapReached: false,
        platformBoundaryReached: false,
        safetyLimitReached: false,
        loadingObserved: false,
        loadingKind: 'none',
        imagePlaceholderCount: 0,
        expectedCount: soldTab?.count ?? null,
        expectedActiveCount: (first.tabs || []).find((tab) => /^(在售|出售中)/.test(tab.text))?.count ?? null,
        expectedSoldCount: soldTab?.count ?? null,
        expectedTrusted: soldTab?.count != null,
        sectionCount: 0,
        steps: 0,
        stopReason: 'explicit_cap'
      }
    }
  } else {
    // Older page variants expose only a combined feed. Preserve the prior
    // fallback, but its unknown statuses remain visible to the state machine.
    const combinedItems = new Map()
    for (const item of first.items || []) {
      mergeItem(combinedItems, item, 'combined', excludeIds)
      if (combinedItems.size >= maxItems) break
    }
    const combinedResult = await collectSection(wc, 'combined', combinedItems, {
      maxItems, maxScrollSteps, pageWaitMs, executionTimeoutMs, testFast, excludeIds, onEvidence: options.onEvidence, now
    })
    if (!combinedResult.ok) return combinedResult
    fallbackItems = combinedItems
    activeItems = new Map([...combinedItems].filter(([, item]) => item.status === 'active'))
    soldItems = new Map([...combinedItems].filter(([, item]) => item.status === 'sold'))
    activeResult = combinedResult
    soldResult = combinedResult
  }

  const finalItems = new Map()
  for (const item of activeItems.values()) mergeItem(finalItems, item, 'active', excludeIds)
  for (const item of soldItems.values()) mergeItem(finalItems, item, 'sold', excludeIds)
  if (fallbackItems) {
    for (const item of fallbackItems.values()) mergeItem(finalItems, item, 'combined', excludeIds)
  }
  const capturedAt = new Date().toISOString()
  const resultItems = [...finalItems.values()].slice(0, maxItems).map((item) => serializeSellerCard(item, capturedAt))
  const activeIds = [...activeItems.keys()].map(String)
  const soldIds = [...soldItems.keys()].map(String)
  const unknownIds = resultItems.filter((item) => item.status === 'unknown').map((item) => String(item.itemId))
  const overlapIds = soldIds.filter((id) => activeIds.includes(id))
  const afterSections = await scan(wc, executionTimeoutMs)
  const authoritativeSellerName = resolveAuthoritativeSellerName({
    sourceSellerName: options.sourceSellerName,
    pageSellerName: afterSections?.sellerName || first.sellerName
  })
  const branchSummary = (branch) => ({
    stopReason: branch.stopReason,
    steps: branch.steps,
    loadingObserved: branch.loadingObserved,
    loadingKind: branch.loadingKind,
    imagePlaceholderCount: branch.imagePlaceholderCount,
    expectedCount: branch.expectedCount,
    observedCount: branch.sectionCount
  })
  const activeCount = activeIds.length
  const soldCount = soldIds.length
  const branchCapped = Boolean(activeResult.capped || soldResult.capped)
  const branchPlatformBoundary = Boolean(activeResult.platformBoundaryReached || soldResult.platformBoundaryReached)
  const branchSafetyLimit = Boolean(activeResult.safetyLimitReached || soldResult.safetyLimitReached)
  const combinedExpected = Number.isFinite(Number(activeResult.expectedCount)) && Number.isFinite(Number(soldResult.expectedCount))
    ? Number(activeResult.expectedCount) + Number(soldResult.expectedCount)
    : null
  const combinedComplete = activeResult.stopReason === 'expected_reached' && soldResult.stopReason === 'expected_reached'
  return {
    ok: true,
    sellerName: authoritativeSellerName,
    items: resultItems,
    activeCount,
    soldCount,
    capped: branchCapped,
    platformCapReached: branchPlatformBoundary,
    platformBoundaryReached: branchPlatformBoundary,
    evidence: {
      expected: {
        active: firstPageExpected.active ?? activeResult.expectedActiveCount ?? activeResult.expectedCount,
        sold: firstPageExpected.sold ?? soldResult.expectedSoldCount ?? soldResult.expectedCount
      },
      firstPageExpected,
      expectedTrusted: {
        active: firstPageExpected.active != null || activeResult.expectedCount != null,
        sold: firstPageExpected.sold != null || soldResult.expectedCount != null
      },
      itemIds: { active: activeIds, sold: soldIds },
      unknownItemIds: unknownIds,
      branches: {
        combined: { ...branchSummary({ ...activeResult, stopReason: combinedComplete ? 'expected_reached' : `${selection}_partial`, expectedCount: combinedExpected, sectionCount: resultItems.length }), expectedCount: combinedExpected, stopReason: combinedComplete ? 'expected_reached' : `${selection}_partial` },
        active: branchSummary(activeResult),
        sold: branchSummary(soldResult)
      },
      capped: branchCapped,
      platformCapReached: branchPlatformBoundary,
      platformBoundaryReached: branchPlatformBoundary,
      safetyLimitReached: branchSafetyLimit,
      overlapIds,
      domAnomaly: !Array.isArray(first.items) || !Array.isArray(first.tabs)
    },
    raw: { source: 'seller_home', sellerUrl: canonicalSellerUrl, selection, maxItems, tabCount: tabTexts.size, firstPageExpected }
  }
}

// 在某个账号的 WebContentsView 内打开闲鱼网页版搜索页，读真实结果卡片取「第一页最低挂牌价」。
//
// 闲鱼网页版 DOM（2026-06 实测）：
//   真实结果： div[class*=search-container] a[class*=feeds-item-wrap]   （「猜你喜欢」在此容器之外，天然排除）
//   价格：     a 卡片内 div[class*=price-wrap] > span[class*=number](整数) + span[class*=decimal](小数)
//             （容器 innerText 会把「X人想要」热度数字粘在价格后面，故必须读子 span，不能读容器文本）
//   无在售：   body 出现「没有找到你想要的宝贝 / 减少筛选内容」→ 不取价、不上报（避免抓到猜你喜欢的脏价）

const SEARCH_URL = (kw) => `https://www.goofish.com/search?q=${encodeURIComponent(kw)}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 防诱饵低价：价格数 > 3 时，比最低价与中间价；最低价比中间价低超 20% 视为故意标低，
// 丢掉这一个、取原本第二低；否则取最低价。<=3 个直接取最低。
// 返回 { price, lowest, median, dropped }
function pickPrice(prices) {
  if (!prices.length) return null
  const sorted = [...prices].sort((a, b) => a - b)
  const lowest = sorted[0]
  if (sorted.length <= 3) return { price: lowest, lowest, median: null, dropped: false }
  const median = sorted[Math.floor(sorted.length / 2)]
  if (median > 0 && (median - lowest) / median > 0.2) {
    return { price: sorted[1], lowest, median, dropped: true }
  }
  return { price: lowest, lowest, median, dropped: false }
}

// 注入页面执行的取价脚本（运行在闲鱼页面上下文）。
const EXTRACT_FN = `(() => {
  const body = document.body ? (document.body.innerText || '') : '';
  const noResult = /没有找到你想要的宝贝|减少筛选内容/.test(body);
  const loggedOut = /扫码登录|亲，请登录|请先登录/.test(body);

  // 只取真实结果卡片（search-container 内），排除「猜你喜欢」推荐
  let cards = Array.from(document.querySelectorAll('[class*="search-container"] [class*="feeds-item-wrap"]'));

  const prices = [];
  for (const card of cards) {
    const wrap = card.querySelector('[class*="price-wrap"]');
    if (!wrap) continue;
    const numEl = wrap.querySelector('[class*="number"]');
    if (!numEl) continue;
    const intPart = (numEl.textContent || '').replace(/[^0-9]/g, '');
    if (!intPart) continue;
    const decEl = wrap.querySelector('[class*="decimal"]');
    let decRaw = decEl ? (decEl.textContent || '').replace(/[^0-9]/g, '') : '';
    let n = parseFloat(decRaw ? intPart + '.' + decRaw : intPart);
    if (isFinite(n) && n > 0) prices.push(n);
  }
  prices.sort((a, b) => a - b);
  return {
    noResult,
    loggedOut: loggedOut && cards.length === 0,
    cardCount: cards.length,
    pricedCount: prices.length,
    lowest: prices.length ? prices[0] : null,
    prices: prices.slice(0, 60),
    sample: body.slice(0, 120)
  };
})()`

// 轮询等结果渲染：拿到价格 / 判定无在售 / 判定未登录 即返回
async function waitForResult(wc, { tries = 12, interval = 1000 } = {}) {
  let last = null
  for (let i = 0; i < tries; i++) {
    try {
      last = await wc.executeJavaScript(EXTRACT_FN, true)
    } catch {
      last = null
    }
    if (last && (last.lowest != null || last.noResult || last.loggedOut)) return last
    // 中途滚动一下，触发懒加载
    if (i === 2 || i === 5) {
      try {
        await wc.executeJavaScript('window.scrollTo(0, document.body.scrollHeight); setTimeout(()=>window.scrollTo(0,0),300)')
      } catch {
        /* ignore */
      }
    }
    await sleep(interval)
  }
  return last
}

/**
 * 爬一个关键词，取搜索结果第一页最低挂牌价。
 * @returns {{ok:boolean, empty?:boolean, price?:number, source?:string, reason?:string, raw?:object}}
 */
export async function crawlOne(wc, keyword, { accountName = '' } = {}) {
  try {
    await wc.loadURL(SEARCH_URL(keyword))
  } catch (e) {
    // SPA 自跳转常令原导航 ERR_ABORTED，可忽略后继续读页面
    if (!/ERR_ABORTED/.test(String(e?.message))) {
      return { ok: false, reason: '导航失败: ' + (e?.message || e) }
    }
  }
  await sleep(1500) // 等 SPA 起步
  const r = await waitForResult(wc)

  if (!r) return { ok: false, reason: '页面无响应' }
  if (r.loggedOut) return { ok: false, reason: '该账号未登录闲鱼' }
  const picked = pickPrice(r.prices || [])
  if (picked) {
    return {
      ok: true,
      price: picked.price,
      source: 'lowest_listing',
      raw: {
        source: 'lowest_listing',
        keyword,
        account: accountName,
        price: picked.price,
        lowest: picked.lowest,
        median: picked.median,
        dropped_bait: picked.dropped, // 是否因诱饵低价丢了最低价取第二低
        cards: r.cardCount,
        candidates: (r.prices || []).slice(0, 30)
      }
    }
  }
  if (r.noResult || r.cardCount === 0) {
    return { ok: false, empty: true, reason: '闲鱼无此商品在售' }
  }
  return { ok: false, empty: true, reason: '未取到价格（卡片无价）' }
}

/** 仅用于「去登录」：把某账号导航到闲鱼首页以便扫码 */
export async function gotoHome(wc) {
  try {
    await wc.loadURL('https://www.goofish.com/')
  } catch {
    /* ignore aborted */
  }
}

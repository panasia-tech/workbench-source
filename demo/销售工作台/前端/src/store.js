// 数据 + 红黄绿的判断规则 + 「今天」任务的自动生成。规则都在这一个文件里，改规则只改这里。
//
//  红 = 缺东西或有问题，要我现在动手；黄 = 提醒或在等别人，可以继续做；绿 = 没有要处理的事。
import { reactive } from 'vue'
import { api, me as staffOf, ROLE, REAL } from './api.js'

export const LV = {
  red: { icon: '✕', text: '要处理', rank: 0 },
  amb: { icon: '!', text: '注意', rank: 1 },
  grn: { icon: '✓', text: '正常', rank: 2 }
}
export const worst = (issues) => (issues.some((i) => i.lvl === 'red') ? 'red' : issues.some((i) => i.lvl === 'amb') ? 'amb' : 'grn')
const rank = (l) => LV[l].rank

export const state = reactive({
  items: [], priceAlerts: {}, staffRaw: [], imgSearch: null, poolTasks: [], imgTasks: [], imgLoad: {}, imgSummary: { fresh: 0, history: 0 }, staffName: {}, pool: {}, orders: [], ordersCount: {}, me: null, assigned: [], collab: null, exceptions: [], plan: null, owners: {},
  loading: false, error: '', sop: [], loaded: false, tries: 0, partial: [], denied: false
})

/* ---------- 实物（WMS）：库龄周期 7 天一段、最多 4 段 ---------- */
export const daysSince = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).getTime()) / 86400000)) : 0)
export function ageOf(days) {
  const cyc = Math.min(4, Math.floor(days / 7) + 1)
  const lvl = days >= 28 ? 'red' : days >= 14 ? 'amb' : 'grn'
  return { cyc, lvl, short: days >= 28 ? `满 4 周期 · ${days} 天` : `第 ${cyc} 周期 · ${days} 天`, long: days >= 28 ? `已满 4 个周期（${days} 天），算滞销` : `第 ${cyc} 个周期（共 4 个）` }
}
export const cellLvl = (st, fix) => (st === 'REJECTED' || st === 'STALE' || fix ? 'red' : st === 'APPROVED' ? 'grn' : 'amb')
export const money = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 0 }))
export const money2 = (v) => Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 2 })

/* ---------- 虚拟 / 服务：产品卡 ---------- */
export const STEP_NAME = { 1: '领线索', 2: '看三个榜', 3: '查取得路径', 4: '算账', 5: '小额实测', 6: '他人复现', 7: '二审并直接上架', 8: '周复盘' }
export const profit = (p) => +(p.price - p.cost - p.price * p.platform_fee_rate - p.after_sale_reserve).toFixed(2)
export const pctOfCost = (p) => (p.cost ? Math.round((p.price / p.cost) * 100) : 0)

export function virtIssues(p) {
  const out = []
  const s = p.stock
  if (p.delivery === 'card' && s && p.step >= 8) {
    if (s.avail <= s.stop_at) out.push({ lvl: 'red', text: '卡券用完，已自动暂停上架', go: 'stock' })
    else if (s.avail <= s.warn_at) out.push({ lvl: 'amb', text: `卡券只剩 ${s.avail} 张，低于提醒线 ${s.warn_at} 张`, go: 'stock' })
  }
  for (const o of p.orders || []) {
    if (o.status === 'held' || o.status === 'waiting') {
      out.push({ lvl: o.paid_ago_min >= 1 ? 'red' : 'amb', text: `订单 ${o.id} 付款 ${o.paid_ago_min} 分钟还没发：${(o.hit || []).join('；')}`, go: 'orders' })
    }
  }
  for (const q of p.capacity?.queue || []) {
    if (['new', 'accepted'].includes(q.state) && q.due_min <= 10) out.push({ lvl: 'red', text: `「${q.buyer}」一小时时效只剩 ${q.due_min} 分钟，还没交付：疑难急单可以转给同行`, go: 'stock' })
  }
  if (p.refund_rate >= 0.08) out.push({ lvl: 'red', text: `退款率 ${(p.refund_rate * 100).toFixed(1)}%，超过 8% 的停止线，要复盘`, go: 'review' })
  else if (p.refund_rate >= 0.05) out.push({ lvl: 'amb', text: `退款率 ${(p.refund_rate * 100).toFixed(1)}%，接近 8% 的停止线`, go: 'review' })
  const pct = pctOfCost(p)
  if (p.cost && p.price) {
    if (pct < p.floor_pct) out.push({ lvl: 'red', text: `售价只有进价的 ${pct}%，低于 ${p.floor_pct}% 底线`, go: 'money' })
    else if (pct > 500) out.push({ lvl: 'amb', text: `售价是进价的 ${pct}%，高于 500%，确认没输错`, go: 'money' })
  }
  if (p.learn) {
    // 技术服务：走「学习到交付」13 个节点，不走卡券那套 8 步成熟度
    const cur = (p.learn_nodes || []).find((n) => n.state === 'cur')
    const L = p.learn, gaps = ['terminal', 'downloads'].filter((k) => L.capture[k].state !== 'ok')
    if (cur && cur.n === 9 && gaps.length) out.push({ lvl: 'red', text: `证据有缺口：${gaps.map((k) => (k === 'terminal' ? '终端命令正文和输出' : '下载工具的来源')).join('、')}没取到——请同行补录；没补齐不能生成可执行 Skill`, go: 'learn' })
    else if (cur && cur.n < (p.learn_nodes || []).length) out.push({ lvl: 'amb', text: `学习流程卡在第 ${cur.n} 步「${cur.title}」（${cur.role}）`, go: 'learn' })
  } else if (p.step < 7) out.push({ lvl: 'amb', text: `还没上架，卡在第 ${p.step} 步「${STEP_NAME[p.step]}」`, go: 'stages' })
  else if (p.step === 7) out.push({ lvl: 'amb', text: '材料齐了，可人工二审确认并直接上架', go: 'stages' })
  if (p.listing_type === 'follow' && !(p.peers || []).length && p.step >= 3) out.push({ lvl: 'amb', text: '没有填有效的同行在售链接：不能走跟卖，要走路测（8 步全走）', go: 'signals' })
  if (p.compliance?.lawyer === 'risk') out.push({ lvl: 'red', text: '律师意见：有风险，先别卖', go: 'law' })
  if (p.capacity && p.capacity.booked / p.capacity.week_limit >= 0.9) out.push({ lvl: 'amb', text: `本周产能已排 ${p.capacity.booked}/${p.capacity.week_limit}，快满了`, go: 'stock' })
  return out.sort((a, b) => rank(a.lvl) - rank(b.lvl))
}

function fromVirtual(p) {
  const issues = virtIssues(p)
  return {
    key: p.kind + ':' + p.id, kind: p.kind, id: p.id, code: p.code, name: p.name, img: `/api/demo-img/V-${p.cover}.jpg`, imgKind: '功能封面',
    lvl: worst(issues), issues, group: { type: p.path[0], cat: p.path[1], src: p.source_tag }, sub: p.path.slice(1).join(' › '),
    a: p.stock ? `库存 ${p.stock.avail} 张` : p.capacity ? `本周 ${p.capacity.booked}/${p.capacity.week_limit}` : p.delivery_label,
    b: p.learn ? (() => { const c = (p.learn_nodes || []).find((n) => n.state === 'cur'); return c ? `学习第 ${c.n}/${(p.learn_nodes || []).length} 步 · ${c.title}` : `本周 ${p.week_sales} 单` })() : p.step >= 8 ? `本周 ${p.week_sales} 单` : `第 ${p.step} 步 · ${STEP_NAME[p.step]}`, chips: [p.listing_type === 'follow' ? '跟卖型' : '路测型'], raw: p
  }
}

/* ---------- 谁的活 ---------- */
export const ownerOf = (key) => REAL ? '' : state.owners[key] || ['chenxm', 'zhoubb'][[...key].reduce((a, c) => a + c.charCodeAt(0), 0) % 2]
export const NAME = { chenxm: '陈小满', zhoubb: '周小北', newbie: '新同事', admin: '销售主管' }
export const nameOf = (u) => NAME[u] || state.staffName?.[u] || u

/* ---------- 仓库里的三种图（2026-11-11 用户讲的业务逻辑）----------
   库位图：仓管找货、盘点用，和商品图分开（接口字段 location_images）。
   实拍图：这件货自己的照片，验货时拍（images 里 inspection/listing 等），每件货都不一样；瑕疵照也算实拍。
   上架图：每个闲鱼号各用一组，必须互不雷同，不然平台和买家会判我们铺货。从「实拍图 + 商品图素材（sku/product）」里挑，
           各号在审批里存（approval.images）。
   规矩：缺哪种就显示缺哪种，不拿别的类型的图占位——库位图不当实拍，同款爬虫图不当实拍，实拍不当上架图。
   真 ERP 没有「这张是哪种图」的字段，images 里几种混在一起，按存放目录判断；演示数据用同样的目录。 */
const dec = (u) => { try { return decodeURIComponent(u) } catch { return u } }
const RE_REAL = /(^|\/)(inspection\/listing|warehouse\/inspection|purchase)\//
const RE_DEFECT = /(^|\/)inspection\/defect\//
const RE_MAT = /(^|\/)(sku\/product|listing\/shop-images|migrate\/.*goods\/album)\//
export const imgUrl = (x) => (typeof x === 'string' ? x : x?.url || x?.src || x?.image_url || x?.thumb_url || '')
export function imageKinds(s) {
  const out = { loc: [], real: [], defect: [], material: [], other: [] }
  for (const x of s?.location_images || []) { const u = imgUrl(x); if (u && !VIDEO.test(u)) out.loc.push(u) }
  for (const x of s?.images || []) {
    const u = imgUrl(x)
    if (!u || VIDEO.test(u) || x?.type === 'video' || x?.media_type === 'video') continue
    const p = dec(u)
    ;(RE_DEFECT.test(p) ? out.defect : RE_REAL.test(p) ? out.real : RE_MAT.test(p) ? out.material : out.other).push(u)
  }
  return out
}
export const imgKey = (u) => dec(String(u || '')).split('?')[0]   // 判断「是不是同一张图」：去掉签名参数

// 图片任务的自动派发规则（数值是示意，等用户定）
export const IMG_RULES = {
  // 没有每天上限、没有排队（用户 2026-11-11：工作量很小，历史清洗一天做完，别搞限额）。
  // 「历史清洗」= 库龄已满 28 天的老库存，一次性的大扫除，当天清完；以后每天新上货只有十几二十票。
  historyDays: 28,
  priceAlertPct: 10,   // 行情价（每天抓一次）较上一次波动超过 10% 报警，让销售核对
  role: { listing: 'SALES', real: 'WAREHOUSE', loc: 'WAREHOUSE', price: 'SALES' },
  label: { listing: '上架图', real: '实拍图', loc: '库位图', price: '价格报警' }
}
// 谁来做：缺实拍图、缺库位图 → 仓管；上架图 → 销售。按「最急的先派」（红先于黄，库龄长的先）；
// 同一个型号的上架图尽量给同一个人（一个人做才能保证各号的图不雷同）；谁手上少先给谁；超过每天上限的排队，明天自动接着派。
function assignImageTasks(items, staff) {
  const act = (staff || []).filter((x) => x.status === 'ACTIVE' && x.username !== 'newbie')
  const pool = (role) => act.filter((x) => x.role === role).map((x) => x.username)
  const me = localStorage.getItem('erp_user') || ''
  const pools = { SALES: pool('SALES'), WAREHOUSE: pool('WAREHOUSE') }
  for (const k of Object.keys(pools)) if (!pools[k].length) pools[k] = [me].filter(Boolean)
  state.staffName = Object.fromEntries(act.map((x) => [x.username, x.name || x.username]))
  state.pool = Object.fromEntries(act.filter((x) => x.role === 'SALES' || x.role === 'WAREHOUSE').map((x) => [x.username, `${x.name || x.username}（${x.role === 'WAREHOUSE' ? '仓管' : '销售'}）`]))
  const tasks = []
  for (const it of items) {
    if (it.kind !== 'phys') continue
    for (const i of it.issues) {
      if (!i.task) continue
      tasks.push({ id: `im:${i.task.type}:${it.code}`, type: i.task.type, role: IMG_RULES.role[i.task.type], lvl: i.lvl, days: it.days || 0, code: it.code, name: it.name, text: i.text, item: it,
        group: it.raw?.spu?.code || [it.raw?.model || it.name, it.raw?.spec].filter(Boolean).join('|') })
    }
  }
  for (const t of tasks) t.history = t.days >= IMG_RULES.historyDays
  // 新货先于历史清洗；同类里红先于黄，库龄长的先
  tasks.sort((a, b) => Number(a.history) - Number(b.history) || rank(a.lvl) - rank(b.lvl) || b.days - a.days || (a.code < b.code ? -1 : 1))
  const load = {}, hist = {}, byGroup = {}
  for (const t of tasks) {
    let who = state.owners[t.id]
    if (!who) {
      const p = pools[t.role] || []
      const g = t.type === 'listing' ? t.role + '|' + t.group : ''
      if (g && byGroup[g] && p.includes(byGroup[g])) who = byGroup[g]
      else who = [...p].sort((a, b) => (load[a + t.role] || 0) - (load[b + t.role] || 0) || (a < b ? -1 : 1))[0]
      if (g && who) byGroup[g] = who
    }
    t.owner = who || ''
    const key = t.owner + t.role
    load[key] = (load[key] || 0) + 1
    if (t.history) hist[key] = (hist[key] || 0) + 1
    t.queued = false
  }
  // 图池任务（图片服务）：一个型号一次取 100 多张同款图，员工审核「图片合格 / 需处理」，通过的才进图池；搜图失败要重搜
  state.poolTasks = []
  for (const r of state.imgSearch?.items || []) {
    if (r.status !== 'REVIEWING' && r.status !== 'FAILED') continue
    const p = pools.SALES || []
    const who = [...p].sort((a, b) => (load[a + 'SALES'] || 0) - (load[b + 'SALES'] || 0) || (a < b ? -1 : 1))[0] || ''
    load[who + 'SALES'] = (load[who + 'SALES'] || 0) + 1
    state.poolTasks.push({ id: 'pool:' + (r.spu_id || r.query), owner: who, lvl: r.status === 'FAILED' ? 'red' : 'amb', tag: r.status === 'FAILED' ? '搜图失败' : '审核搜图', title: r.query,
      desc: r.status === 'FAILED' ? `同款图没搜到${r.error ? '：' + r.error : ''}，要改型号写法重搜` : `同款图 ${r.formal_count} 张等你审核（图片合格 / 标记需处理），审完才能给各号分图`, url: state.imgSearch.url })
  }
  state.imgTasks = tasks
  state.imgLoad = Object.fromEntries(Object.entries(load).map(([k, n]) => { const role = k.endsWith('WAREHOUSE') ? 'WAREHOUSE' : 'SALES'; return [k, { n, role, user: k.slice(0, -role.length), hist: hist[k] || 0 }] }))
  state.imgSummary = { fresh: tasks.filter((t) => !t.history).length, history: tasks.filter((t) => t.history).length }
}

// 真实 ERP 里没有 /api/demo/*（练习、提成、团队目标、订单对账、虚拟线都是演示接口）。
// 读不到时只用登录返回的人兜底，并标 real，界面上提成/团队目标显示「还没接入」，不编造数字。
function realMe() {
  const s = staffOf()
  return { username: localStorage.getItem('erp_user') || '', name: s.name || s.username || '我', post: ROLE[s.role] || '销售业务员', dept: '销售部',
    supervisor: s.role === 'ADMIN', practice_done: true, real: true, commission: { day_ok: 0, day_pend: 0, mon_ok: 0, mon_pend: 0 }, team: { target: 0, done: 0 } }
}

// 真 ERP 的仓储阶段（接口文档里的原话）
export const PHASE_LABEL = { pending_negotiation: '待议价', pending_inbound: '待入库', pending_create: '待创建上架信息', pending_publish: '待发布', listing: '发布中', on_sale: '在售', locked: '待发货', shipped: '已发货' }
// 品牌：先用接口给的，没有就取名字第一段（只用来分组）
const brandOf = (s) => s.brand || s.spu?.brand || (String(s.product_name || '').trim().split(/\s+/)[0] || '') || '其他品牌'
// 列表接口每页最多 100 条：读完所有页（上限 60 页 = 6000 条，防止失控）
async function pageAll(path, query = '') {
  const q = (n) => `${path}?${query ? query + '&' : ''}page=${n}&size=100`
  const first = await api(q(1))
  const total = first.total ?? (first.items || []).length
  const pages = Math.min(60, Math.ceil(total / 100))
  const items = [...(first.items || [])]
  for (let n = 2; n <= pages; n += 4) {
    const got = await Promise.all(Array.from({ length: Math.min(4, pages - n + 1) }, (_, i) => api(q(n + i))))
    for (const g of got) items.push(...(g.items || []))
  }
  return { ...first, items, total, truncated: total > 6000 }
}
// 真数据里 images 可能是字符串，也可能是 {url} 对象，还混着视频：只取图片地址
const VIDEO = /\.(mp4|mov|m4v|webm|avi)(\?|$)/i
export const imgList = (s) => {
  const out = []
  for (const x of s?.images || []) { const u = typeof x === 'string' ? x : x?.url || x?.src || x?.image_url || x?.thumb_url; if (u && !VIDEO.test(u) && x?.type !== 'video' && x?.media_type !== 'video') out.push(u) }
  if (!out.length) for (const u of [s?.cover_thumb_url, s?.cover_url]) if (u && !VIDEO.test(u)) { out.push(u); break }
  return out
}

/* ---------- 行情价：每天抓一次，较上一次波动超过 10% 就报警，让销售核对 ----------
   取每件货的行情价走势（/price-history 的 series），比较最近两次抓价。结果按天缓存在浏览器里，当天只取一次；后台慢慢取，不挡页面。 */
const PRICE_CACHE = 'price_alerts_v1'
const dayDiff = (d) => Math.floor((Date.now() - new Date(d + 'T00:00:00').getTime()) / 86400000)
async function loadPriceAlerts() {
  const day = new Date().toISOString().slice(0, 10)
  let cache = {}
  try { cache = JSON.parse(localStorage.getItem(PRICE_CACHE) || '{}') } catch { cache = {} }
  if (cache.day !== day) cache = { day, v: {} }
  const todo = state.items.filter((i) => i.kind === 'phys' && !i.locked && i.raw?.warehouse_phase !== 'pending_negotiation' && !(i.code in cache.v))
  if (!todo.length) return
  let idx = 0
  const worker = async () => {
    while (idx < todo.length) {
      const it = todo[idx++]
      try {
        const h = await api(`/inventory/skus/${encodeURIComponent(it.code)}/price-history?days=60`)
        const s = h.series || [], a = s[s.length - 1], b = s[s.length - 2]
        cache.v[it.code] = a && b && b.price ? { to: a.price, from: b.price, date: a.date, prev: b.date, pct: Math.round(((a.price - b.price) / b.price) * 1000) / 10 } : 0
      } catch { cache.v[it.code] = 0 }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  try { localStorage.setItem(PRICE_CACHE, JSON.stringify(cache)) } catch { /* 存不了就算了 */ }
  state.priceAlerts = { ...state.priceAlerts, ...cache.v }
  applyPriceAlerts()
}
function applyPriceAlerts() {
  if (!Object.keys(state.priceAlerts).length) { try { const c = JSON.parse(localStorage.getItem(PRICE_CACHE) || '{}'); if (c.day === new Date().toISOString().slice(0, 10)) state.priceAlerts = c.v || {} } catch { /* 没有缓存 */ } }
  for (const it of state.items) {
    if (it.kind !== 'phys') continue
    it.issues = it.issues.filter((i) => !i.price)
    it.chips = it.chips.filter((c) => !String(c).startsWith('行情'))
    const a = state.priceAlerts[it.code]
    if (a && Math.abs(a.pct) > IMG_RULES.priceAlertPct && dayDiff(a.date) <= 3 && !it.locked && it.raw?.warehouse_phase !== 'pending_negotiation') {
      it.issues.push({ lvl: Math.abs(a.pct) > 20 ? 'red' : 'amb', price: true, text: `行情价波动 ${a.pct > 0 ? '+' : ''}${a.pct}%（${a.prev} ¥${a.from} → ${a.date} ¥${a.to}），超过 ${IMG_RULES.priceAlertPct}%，核对一下`, go: 'price', task: { type: 'price' } })
      it.chips.push(`行情 ${a.pct > 0 ? '↑' : '↓'}${Math.abs(a.pct)}%`)
    }
    it.issues.sort((x, y) => rank(x.lvl) - rank(y.lvl))
    it.lvl = worst(it.issues)
  }
  state.items.sort((a, b) => rank(a.lvl) - rank(b.lvl) || (b.days || 0) - (a.days || 0))
  assignImageTasks(state.items, state.staffRaw)
}

/* ---------- 全部加载（失败自动重试，不清空已有数据，#95 LIB-08） ---------- */
async function once() {
  const partial = []
  const soft = (name, fb) => () => { partial.push(name); return fb }
  // 真数据：库存 / 上架审批 / 缺口来自真 ERP（WMS）；订单对账、虚拟线、练习、协同、加派都是演示接口，真 ERP 里没有，不去读
  const [inv, tasks, gaps, orders, virt, me, mine, collab, exc, plan, staffList, imgSearch] = await Promise.all([
    pageAll('/inventory/skus', 'in_warehouse=true'),
    pageAll('/listing-approvals/tasks', 'state=all').catch(soft('上架审批进度', { items: [], shops: [] })),
    pageAll('/stock-gaps').catch(soft('库存缺口', { items: [] })),
    REAL ? { items: [], counts: {} } : api('/demo/orders').catch(soft('订单对账', { items: [], counts: {} })),
    api('/virtual/products').catch(soft('虚拟/服务（演示）', { items: [], sop: [] })),
    REAL ? realMe() : api('/demo/me').catch(realMe),
    REAL ? { assigned: [], owners: {} } : api('/demo/tasks').catch(() => ({ assigned: [], owners: {} })),
    REAL ? null : api('/demo/collab').catch(() => null),
    REAL ? { items: [] } : api('/demo/exceptions').catch(() => ({ items: [] })),
    REAL ? null : api('/demo/plan').catch(() => null),
    api('/staff?page=1&size=100').catch(() => null),   // 只用来分派图片任务：账号、姓名、角色、是否在职
    api(REAL ? '/product-images' : '/demo/product-images').catch(() => null)   // 图片服务：每个型号一次取 100 多张同款图，员工审核
  ])
  if (inv.truncated) partial.push('库存只读了前 6000 件')
  const gapBy = Object.fromEntries((gaps.items || []).map((g) => [g.sku_code, g]))
  const taskBy = Object.fromEntries((tasks.items || []).map((t) => [t.sku_code, t]))
  const shopName = Object.fromEntries((tasks.shops || []).map((s) => [s.id, s.label]))
  const ordBySku = {}
  for (const o of orders.items || []) {
    for (const c of o.sku ? [o.sku] : o.candidates || []) (ordBySku[c] ||= []).push(o)
  }
  const conflict = new Set((plan?.conflicts || []).map((c) => c.sku))
  const phys = (inv.items || []).map((s) => {
    const phase = s.warehouse_phase
    const kinds = imageKinds(s)
    // 待议价（negotiated_at 还空着，自动上架在这里停住）：还不能上架，销售现在不用处理，不按库龄标红。
    // 待入库（议价完、上架信息还没录好）是销售的主要活，要正常标。
    const notSales = phase === 'pending_negotiation'
    const days = daysSince(s.inbound_at)
    const age = ageOf(days)
    const locked = s.status === 'RESERVED'
    const issues = []
    const shops = []
    if (notSales) {
      issues.push({ lvl: 'grn', text: `这件货还在「${PHASE_LABEL[phase]}」阶段，销售现在不用处理，不按库龄标红` })
    } else if (locked) {
      const o = (ordBySku[s.sku_code] || []).find((x) => x.kind === 'phys')
      issues.push({ lvl: 'amb', text: o ? `买家「${o.buyer}」已拍下 ¥${money(o.amount)}，等发货出库` : '货已锁住，等发货出库' })
      if (conflict.has(s.sku_code)) issues.unshift({ lvl: 'red', text: '货已经锁给买家了，但还有一个号挂着没下架，要联动下架', go: 'shops' })
    } else {
      if (age.lvl === 'red') issues.push({ lvl: 'red', text: `滞销：在库 ${days} 天，已满 4 个周期`, go: 'age' })
      else if (age.lvl === 'amb') issues.push({ lvl: 'amb', text: `第 ${age.cyc} 周期，在库 ${days} 天，该清仓了`, go: 'age' })
      const g = gapBy[s.sku_code]
      if (g) issues.push({ lvl: g.kind === 'unlisted' || g.waiting ? 'amb' : 'red', text: g.kind_label + '：' + g.note, go: 'gap' })
      const t = taskBy[s.sku_code]
      for (const [sid, c] of Object.entries(t?.cells || {})) {
        const nm = shopName[sid] || '号'
        shops.push({ id: sid, label: nm, state: c.needs_fix ? '在架待配图' : c.label, lvl: cellLvl(c.state, c.needs_fix) })
        if (c.needs_fix) issues.push({ lvl: 'red', text: `「${nm}」已在架但未绑定独立上架图，请在三栏图库选图更新`, go: 'shops' })
        else if (c.state === 'REJECTED') issues.push({ lvl: 'amb', text: `「${nm}」待重新选图与确认价格`, go: 'shops' })
        else if (c.state === 'STALE') issues.push({ lvl: 'amb', text: `「${nm}」采购成本已更新，请核对新售价后直接上架`, go: 'shops' })
      }
      const undone = shops.filter((x) => ['未清洗', '草稿', '待选图上架', '已暂存待发'].includes(x.state))
      if (undone.length && !issues.some((i) => i.lvl === 'red' && i.text.includes('选图'))) issues.push({ lvl: 'amb', text: `${undone.length} 个店铺待从大库选图并确认闲鱼均价直接上架`, go: 'shops', task: { type: 'listing' } })
      if (!s.cost_price) issues.unshift({ lvl: 'red', text: '缺成本价：核对异常，不能定价和发布', go: 'price' })
    }
    if (!notSales && !locked) {
      if (!kinds.real.length) {
        const has = kinds.material.length + kinds.defect.length + kinds.other.length
        // 一张图都没有 → 红（没法上架）；只有商品图素材/瑕疵图 → 黄（有素材可以先用，但这件货自己的实拍还是要补）
        issues.push({ lvl: has ? 'amb' : 'red', text: has ? `没有这件货自己的实拍图，只有商品图素材 ${kinds.material.length} 张${kinds.defect.length ? '、瑕疵图 ' + kinds.defect.length + ' 张' : ''}：找仓管补拍` : '一张图都没有：不拿库位图、同款图顶替，找仓管补拍实拍', go: 'imgs', task: { type: 'real' } })
      }
      if (!kinds.loc.length) issues.push({ lvl: 'amb', text: '没有库位图（仓管找货、盘点用）', go: 'imgs', task: { type: 'loc' } })
    }
    for (const o of ordBySku[s.sku_code] || []) {
      if (o.kind !== 'phys' || o.lvl !== 'red') continue
      issues.unshift({ lvl: 'red', text: `订单 ${o.id}「${o.gap_label}」：${o.why}`, go: 'orders', oid: o.id })
    }
    issues.sort((a, b) => rank(a.lvl) - rank(b.lvl))
    // 卡片图：这件货自己的实拍图；没有就用商品图素材并明说「非实拍」；都没有写「待补图」。永远不用库位图、瑕疵图、同款爬虫图占位。
    const cover = kinds.real[0] || kinds.material[0] || ''
    const hasImg = !!cover
    return {
      key: 'phys:' + s.sku_code, kind: 'phys', id: s.sku_code, code: s.sku_code, name: s.product_name, img: cover, imgKind: kinds.real.length ? '实拍图' : kinds.material.length ? '商品图（非实拍）' : '待补图',
      imgs: { loc: kinds.loc.length, real: kinds.real.length, defect: kinds.defect.length, material: kinds.material.length, listed: shops.filter((x) => x.state !== '未清洗').length, shops: shops.length },
      lvl: worst(issues), issues, group: { type: '实物', cat: brandOf(s), src: '采购入库' }, sub: `${s.sku_code} · 库位 ${s.location_code || '—'}`,
      a: `成本 ¥${money(s.cost_price)}`, b: locked ? '已锁单' : age.short, ageLvl: age.lvl, days, locked,
      chips: [locked ? '待发货' : PHASE_LABEL[phase] || '在库'], shops, raw: s
    }
  })
  const vv = (virt.items || []).map(fromVirtual).map((x) => (REAL ? { ...x, chips: [...x.chips, '演示数据'] } : x))
  state.sop = virt.sop || []
  state.items = [...phys, ...vv].sort((a, b) => rank(a.lvl) - rank(b.lvl) || (b.days || 0) - (a.days || 0))
  state.owners = mine.owners || {}
  state.staffRaw = staffList?.items || []
  state.imgSearch = imgSearch ? { counts: imgSearch.counts || {}, items: imgSearch.items || [], url: imgSearch.review_url || '' } : null
  assignImageTasks(state.items, state.staffRaw)
  applyPriceAlerts()   // 先用今天缓存的
  loadPriceAlerts()    // 缺的在后台补，不挡着页面
  state.orders = orders.items || []
  state.ordersCount = orders.counts || {}
  state.me = me
  state.assigned = mine.assigned || []
  state.owners = mine.owners || {}
  state.collab = collab
  state.exceptions = exc.items || []
  state.plan = plan
  state.partial = partial
  if (REAL && window.SNAP_ON) snapshot(inv, tasks, gaps)
}

// 排查用：把汇总（不含令牌、不含完整数据）发给本机开发服务器写成文件
function snapshot(inv, tasks, gaps) {
  try {
    const items = state.items
    const cnt = (f) => items.reduce((m, i) => { const k = f(i); m[k] = (m[k] || 0) + 1; return m }, {})
    const days = items.map((i) => i.days).filter((x) => x != null).sort((a, b) => a - b)
    const first = (inv.items || [])[0] || {}
    const strip = (u) => String(u || '').split('?')[0]
    const out = {
      at: new Date().toISOString(), total_sku: inv.total, loaded: (inv.items || []).length, truncated: !!inv.truncated,
      by_level: cnt((i) => i.lvl), by_age_level: cnt((i) => i.ageLvl), locked: items.filter((i) => i.locked).length,
      with_image: items.filter((i) => i.img).length, without_image: items.filter((i) => !i.img).length,
      status: cnt((i) => i.raw?.status), phase: cnt((i) => i.raw?.warehouse_phase), cost_missing: items.filter((i) => !i.raw?.cost_price).length,
      days: { min: days[0], median: days[Math.floor(days.length / 2)], max: days[days.length - 1] },
      tasks_total: (tasks.items || []).length, shops: (tasks.shops || []).map((s) => s.label), gaps_total: (gaps.items || []).length, gap_counts: gaps.counts || gaps.kinds || null,
      partial: state.partial, images_shape: { type: typeof (first.images || [])[0], sample_keys: typeof (first.images || [])[0] === 'object' ? Object.keys(first.images[0] || {}) : null, sample_url: strip(typeof (first.images || [])[0] === 'string' ? first.images[0] : (first.images || [])[0]?.url), cover: strip(first.cover_url) },
      list_keys: Object.keys(first),
      sample: items.slice(0, 8).map((i) => ({ code: i.code, name: i.name, brand: i.group?.cat, cost: i.raw?.cost_price, days: i.days, lvl: i.lvl, age: i.b, img: i.img ? strip(i.img).slice(-40) : '', issues: i.issues.slice(0, 3).map((x) => x.text) }))
    }
    fetch('/__snap', { method: 'POST', body: JSON.stringify(out) })
  } catch { /* 排查用，失败就算了 */ }
}

export async function loadAll(manual = false) {
  state.loading = true
  state.error = ''
  if (manual) state.tries = 0
  for (let i = 0; i < 4; i++) {
    try {
      await once()
      state.loaded = true
      state.tries = 0
      state.loading = false
      return
    } catch (e) {
      state.denied = /403|无权限|没有权限/.test(e.message)
      state.tries = i + 1
      state.error = `暂时读不到数据（${e.message}），正在重试第 ${i + 1} 次…`
      await new Promise((r) => setTimeout(r, 1200 * (i + 1)))
    }
  }
  state.error = state.denied ? '你的岗位暂时看不到这部分商品：请找主管确认岗位权限（不会给你默认的管理员权限）。' : '读不到数据。已有的内容保持不变，点「重新读取」再试。'
  state.loading = false
}

/* ---------- 今天：系统按缺口和待办自动生成的任务 ---------- */
export function buildTasks(username) {
  const me = state.me
  const mine = (key) => REAL || username === 'admin' || ownerOf(key) === username
  const out = []
  for (const a of state.assigned) {
    if (a.done) continue
    const lvl = !me?.supervisor && ['等待外部', '待验收'].includes(a.status) ? 'amb' : 'red'
    out.push({ id: 'as-' + a.id, lvl, tag: '主管加派', title: `${a.cat}：${a.req}`, desc: (a.files?.length ? '附件：' + a.files.join('、') + ' · ' : '') + `由 ${a.by} 加派`, kind: 'assigned', aid: a.id, owner: a.to, task: a })
  }
  for (const o of state.orders) {
    if (o.lvl !== 'red') continue
    const oit = state.items.find((i) => (i.kind === 'phys' ? i.code : i.id) === (o.sku || (o.candidates || [])[0]))
    out.push({ id: 'or-' + o.id, img: oit?.img || '', lvl: 'red', tag: o.gap_label, title: `${o.title} · ${o.buyer}`, desc: o.why, kind: 'order', go: { type: 'orders', oid: o.id }, owner: ownerOf('order:' + o.id) })
  }
  for (const it of state.items) {
    if (!mine(it.key) || it.lvl === 'grn') continue
    // 图片问题（缺实拍/库位、上架图没做）只出现在「图片任务」里，由系统自动派给仓管或销售，这里不重复
    const own = it.issues.filter((i) => !i.task)
    if (!own.length) continue
    const first = own.find((i) => !i.oid) || own[0]
    out.push({ id: 'it-' + it.key, img: it.img || '', lvl: worst(own), tag: it.kind === 'phys' ? '实物' : it.kind === 'virt' ? '虚拟' : '服务', title: it.name, desc: first.text + (own.length > 1 ? `（另有 ${own.length - 1} 项）` : ''), kind: 'item', go: { type: 'item', item: it }, owner: ownerOf(it.key) })
  }
  const sup = !!state.me?.supervisor || username === 'admin'
  // 图池任务（图片服务）
  for (const t of state.poolTasks) {
    if (!sup && t.owner !== username) continue
    out.push({ id: t.id, img: '', lvl: t.lvl, tag: t.tag, title: t.title, desc: t.desc, kind: 'link', url: t.url, owner: t.owner, imgTask: true })
  }
  // 图片任务：系统按规则自动派（见 IMG_RULES），没有每天上限。
  for (const t of state.imgTasks) {
    if (t.queued || (!sup && t.owner !== username)) continue
    out.push({ id: t.id, img: t.type === 'loc' ? '' : t.item.img || '', lvl: t.lvl, tag: IMG_RULES.label[t.type] + (t.history ? ' · 历史清洗' : ''), title: t.name, desc: t.text, kind: 'item', go: { type: 'item', item: t.item, jump: t.type === 'listing' ? 'shops' : t.type === 'price' ? 'price' : 'imgs' }, owner: t.owner, imgTask: true })
  }
  const rk = { red: 0, amb: 1, grn: 2 }
  void me
  return out.sort((a, b) => rk[a.lvl] - rk[b.lvl])
}

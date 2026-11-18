// 最终版 H5 演示数据层：新增的缺口闭环字段都放这里。
// 只存本浏览器（localStorage），不写生产；页面上一律标「演示」。
import { reactive, watch } from 'vue'

const KEY = 'wb_final_v1'
const today = () => new Date().toISOString().slice(0, 10)
let seq = 0
export const uid = (p = 'D') => `${p}-${Date.now().toString(36).slice(-4)}${(++seq).toString(36)}`

const seed = () => ({
  // G02 询单与报价
  inquiries: [
    { id: 'XJ-2601', platform: '闲鱼', buyer: '小北', product: '《三角洲行动》虚拟化报警处理', pid: 'v-game', owner: 'chenxm', state: '已报价', amount: 39, source: '闲鱼搜索', at: '11-12 09:12', quotes: [{ v: 1, price: 39, valid: '11-14', note: '含一次远程', accepted: false }, { v: 2, price: 35, valid: '11-13', note: '老客户价', accepted: true }], follow: [{ t: '11-12 09:20', text: '已发远程工具包，等客户装好' }], lost: '' },
    { id: 'XJ-2602', platform: '闲鱼', buyer: '阿杰', product: '安卓刷机服务', pid: 'v-and', owner: 'zhoubb', state: '跟进中', amount: 99, source: '闲鱼榜单', at: '11-12 08:40', quotes: [], follow: [{ t: '11-12 08:55', text: '问了机型和系统版本，等回复' }], lost: '' },
    { id: 'XJ-2603', platform: '小红书', buyer: 'momo', product: '小红书种草笔记代写', pid: 'v-xhs', owner: 'chenxm', state: '待客户', amount: 120, source: '小红书私信', at: '11-11 21:10', quotes: [{ v: 1, price: 120, valid: '11-15', note: '3 篇图文', accepted: false }], follow: [{ t: '11-11 21:30', text: '客户说要和老板确认' }], lost: '' },
    { id: 'XJ-2604', platform: '淘宝', buyer: '陈先生', product: '麦当劳 鸡牛双堡双人餐电子券', pid: 'v-mcd', owner: 'zhoubb', state: '已成交', amount: 46, source: '淘宝问大家', at: '11-11 18:02', quotes: [{ v: 1, price: 46, valid: '11-12', note: '', accepted: true }], follow: [{ t: '11-11 18:10', text: '已发券' }], lost: '' },
    { id: 'XJ-2605', platform: '闲鱼', buyer: '老K', product: 'CAD 平面图描图代画', pid: 'v-cad', owner: 'chenxm', state: '新询', amount: 58, source: '闲鱼搜索', at: '11-12 10:02', quotes: [], follow: [], lost: '' },
    { id: 'XJ-2606', platform: '京东', buyer: '王女士', product: 'ChatGPT Plus 月卡代充', pid: 'v-gpt', owner: 'zhoubb', state: '已丢单', amount: 168, source: '京东', at: '11-10 16:20', quotes: [{ v: 1, price: 168, valid: '11-11', note: '', accepted: false }], follow: [], lost: '客户嫌比别家贵 20 元' }
  ],
  // F01 周期交付
  cycles: [
    { id: 'C-2026-W45', at: '2026-11-09 09:00', status: '已交付', scope: '实物 3C + 卡券', items: 1837, images: 620, prices: 8044, missed: 0, note: '第 45 周：闲鱼 43 类目榜 + 淘宝京东卡券榜', snap: '2026-11-09 08:40' },
    { id: 'C-2026-W44', at: '2026-11-02 09:00', status: '已补跑', scope: '实物 3C', items: 1760, images: 588, prices: 7988, missed: 1, note: '10-31 晚平台风控，卡券榜漏跑，11-02 14:00 补跑', snap: '2026-11-02 14:10' },
    { id: 'C-2026-W46', at: '2026-11-16 09:00', status: '未开始', scope: '待定（本周主题：音响）', items: 0, images: 0, prices: 0, missed: 0, note: '等本周主题任务派发', snap: '' }
  ],
  // B10 采购价格表
  pricebook: [
    { id: 'PB-001', model: '27M2N5510P', config: '27 英寸 2K 180Hz', ref: 780, suggest: 899, limit: 950, deal: 820, paid: 0, status: '已生效', ver: 'v3', from: '11-10', to: '11-16', fb: '' },
    { id: 'PB-002', model: 'iPhone 15 Pro 256G', config: '国行 无锁 95 新', ref: 4300, suggest: 4899, limit: 5100, deal: 4450, paid: 4400, status: '已生效', ver: 'v2', from: '11-08', to: '11-14', fb: '到货 3 台，成色与报价一致' },
    { id: 'PB-003', model: 'Mac mini M4 16/256', config: '国行 在保', ref: 2950, suggest: 3399, limit: 3500, deal: 0, status: '待核', ver: 'v1', from: '11-12', to: '11-18', fb: '' },
    { id: 'PB-004', model: 'iPad Air 5 64G', config: 'WiFi 9 成新', ref: 2350, suggest: 2699, limit: 2800, deal: 2400, paid: 2400, status: '已生效', ver: 'v1', from: '11-06', to: '11-12', fb: '已售 2 台' },
    { id: 'PB-005', model: '戴森 V12 Detect', config: '国行 全套', ref: 1450, suggest: 1699, limit: 1800, deal: 0, status: '已失效', ver: 'v1', from: '10-20', to: '11-03', fb: '报价高于行情，暂停' },
    { id: 'PB-006', model: 'Switch OLED 白色', config: '日版 单机', ref: 1380, suggest: 1580, limit: 1650, deal: 1400, paid: 1400, status: '已生效', ver: 'v2', from: '11-11', to: '11-17', fb: '' },
    { id: 'PB-007', model: 'AirPods Pro 2', config: 'USB-C 国行', ref: 980, suggest: 1150, limit: 1200, deal: 0, status: '维护中', ver: 'v1', from: '11-12', to: '11-19', fb: '' },
    { id: 'PB-008', model: '索尼 A7M4 单机身', config: '国行 快门 1.2 万', ref: 9800, suggest: 11200, limit: 11800, deal: 0, status: '待核', ver: 'v1', from: '11-12', to: '11-20', fb: '' }
  ],
  // D05 服务程序化交付
  programs: [
    { id: 'PG-001', pid: 'v-and', name: '安卓刷机服务', mode: '预约码', capacity: 6, booked: 2, slots: ['11-12 14:00', '11-12 15:00', '11-12 16:00', '11-13 10:00'], codes: [{ code: 'YY-8F3K', state: '未用' }, { code: 'YY-2M7Q', state: '已预约', buyer: '阿杰', at: '11-12 15:00' }, { code: 'YY-9X1D', state: '已核销', buyer: '小北' }] },
    { id: 'PG-002', pid: 'v-game', name: '《三角洲行动》虚拟化报警处理', mode: '预约码', capacity: 4, booked: 1, slots: ['11-12 20:00', '11-13 19:00'], codes: [{ code: 'DG-5K2P', state: '已预约', buyer: '小北', at: '11-12 20:00' }] },
    { id: 'PG-003', pid: 'v-cad', name: 'CAD 平面图描图代画', mode: '人工排期', capacity: 8, booked: 3, slots: ['11-13 10:00', '11-13 14:00'], codes: [] }
  ],
  // 经营五阶段（管理验收）
  stages: {
    'v-game': [{ n: 1, name: '同行摸底', state: 'done', ver: 'v1', note: '闲鱼 3 家同行，报价 30–50', review: '通过' }, { n: 2, name: '供给核验', state: 'done', ver: 'v1', note: '同行可远程，工时约 40 分钟', review: '通过' }, { n: 3, name: '实操', state: 'doing', ver: 'v1', note: '公司学习机复现中', review: '' }, { n: 4, name: '经营方案', state: 'todo', ver: '', note: '', review: '' }, { n: 5, name: '复盘', state: 'todo', ver: '', note: '', review: '' }],
    'v-and': [{ n: 1, name: '同行摸底', state: 'done', ver: 'v2', note: '刷机 3 家，均价 99', review: '通过' }, { n: 2, name: '供给核验', state: 'done', ver: 'v2', note: '工具与驱动已核', review: '通过' }, { n: 3, name: '实操', state: 'done', ver: 'v2', note: '10 台真机通过', review: '通过' }, { n: 4, name: '经营方案', state: 'doing', ver: 'v2', note: '定价 99，一小时时效', review: '' }, { n: 5, name: '复盘', state: 'todo', ver: '', note: '', review: '' }]
  },
  // 任务状态机（主管加派的任务）
  tasks: {},
  // 单件整机资料
  units: {},
  // 选品：状态、周主题、开采决定
  selection: {},
  themes: [{ week: '2026-W46', theme: '音响', scope: '蓝牙音箱 / 回音壁', owner: 'chenxm', due: '11-16', state: '进行中', base: 'W45 全量库', note: '本周只调研这个主题' }],
  mining: {},
  // CRM 供货条款（按群 id）
  crm: {},
  // 周复盘动作 / 机会池
  reviews: { 'v-game': { decision: '继续', note: '本周 3 单，退款 0', at: '11-11' }, 'v-and': { decision: '扩大', note: '产能还够，加 2 个号', at: '11-11' } },
  opportunities: [{ id: 'OP-01', text: '客户反复问「Mac 能不能刷机」：暂时做不了，进机会池', from: 'v-and', at: '11-11', state: '待研究' }, { id: 'OP-02', text: '民宿图精修客户要「视频版」，新需求', from: 'v-bnb', at: '11-10', state: '待研究' }],
  // C03 浙江餐饮 / 新品牌研究
  zhejiang: [
    { id: 'ZJ-01', city: '杭州', brand: '星巴克 中杯券', mall: '湖滨银泰 in77', channel: '店群自领 / 闲鱼转卖', test: '买 1 张，当天核销', state: '已核验' },
    { id: 'ZJ-02', city: '温州', brand: '花潮日料自助', mall: '滨江万象城', channel: '同行代订 / 团购', test: '买 1 份，周末用', state: '待核' },
    { id: 'ZJ-03', city: '台州', brand: '中盛城市广场 餐饮券', mall: '中盛城市广场', channel: '商场会员 / 团购', test: '小额试单', state: '待核' },
    { id: 'ZJ-04', city: '杭州', brand: '肯德基 大神卡', mall: '全城', channel: '官方 App / 信用卡权益', test: '买 1 张，核销', state: '失败' }
  ],
  // 提成流水（按订单/产品卡）
  commission: [
    { id: 'CM-001', order: 'XY-88231', product: '麦当劳 鸡牛双堡双人餐电子券', type: '成交提成', base: 3.2, rate: 0.1, amount: 0.32, state: '待确认', refund: false, at: '11-12' },
    { id: 'CM-002', order: 'XY-88230', product: '肯德基 随心配 2+1', type: '成交提成', base: 2.4, rate: 0.1, amount: 0.24, state: '已确认', refund: false, at: '11-11' },
    { id: 'CM-003', order: '—', product: '《三角洲行动》虚拟化报警处理', type: '上新奖', base: 200, rate: 1, amount: 100, state: '待确认', refund: false, at: '11-10' },
    { id: 'CM-004', order: 'XY-88201', product: '安卓刷机服务', type: '成交提成', base: 70, rate: 0.2, amount: 14, state: '已确认', refund: true, at: '11-09' },
    { id: 'CM-005', order: '—', product: '麦当劳 鸡牛双堡双人餐电子券', type: '建卡人分成', base: 3.2, rate: 0.05, amount: 0.16, state: '待确认', refund: false, at: '11-12' }
  ],
  // 票券 / 交通 / 住宿交付条件（按产品 id）
  tickets: {},
  // 利润类型与客户付费理由（按产品 id）
  profit: {},
  // 服务预约 / 接单承诺（按产品 id）
  reservations: {},
  // MCP 配置（A03）
  mcp: [
    { id: 'M1', name: '禅道 MCP', addr: 'http://127.0.0.1:8000', use: '只读需求 / 验收', enabled: true, secret: 'DEMO_ONLY_REDACTED', test: '正常' },
    { id: 'M2', name: '向日葵 MCP', addr: 'https://sunlogin.oray.com/mcp', use: '远控客户电脑', enabled: true, secret: 'DEMO_ONLY_REDACTED', test: '正常' },
    { id: 'M3', name: 'ERP 只读 API', addr: 'http://127.0.0.1:8000', use: '库存 / 商品 / 会话', enabled: true, secret: 'DEMO_ONLY_REDACTED', test: '正常' }
  ],
  // 订单费用与净收益（按订单 id）
  orderFees: {},
  priceCleaning: {},
  // 图片素材池：水印处理 / 视觉筛选
  imageJobs: [
    { id: 'IM-01', sku: 'PH-2601', url: '/api/demo-img/P-1.jpg', kind: '闲鱼右侧水印', state: '待处理', before: '带水印', after: '', note: '' },
    { id: 'IM-02', sku: 'PH-2601', url: '/api/demo-img/P-2.jpg', kind: '无', state: '可用', before: '原图', after: '', note: '' },
    { id: 'IM-03', sku: 'PH-2602', url: '/api/demo-img/P-3.jpg', kind: '店铺广告字', state: '已淘汰', before: '带广告字', after: '', note: '不是这个型号' }
  ]
})

function load() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return seed()
    const d = JSON.parse(raw)
    const base = seed()
    // 合并新增字段，旧缓存也能用
    for (const k of Object.keys(base)) if (d[k] == null) d[k] = base[k]
    return d
  } catch { return seed() }
}

export const finalDb = reactive(load())
watch(finalDb, (v) => { try { localStorage.setItem(KEY, JSON.stringify(v)) } catch { /* 存不了就用内存 */ } }, { deep: true })

export function resetFinal() {
  const s = seed()
  for (const k of Object.keys(finalDb)) delete finalDb[k]
  Object.assign(finalDb, s)
  try { localStorage.removeItem(KEY) } catch { /* ignore */ }
}

export const stageNames = ['同行摸底', '供给核验', '实操', '经营方案', '复盘']

export function stagesOf(pid) {
  if (!finalDb.stages[pid]) finalDb.stages[pid] = stageNames.map((name, i) => ({ n: i + 1, name, state: i === 0 ? 'doing' : 'todo', ver: '', note: '', review: '' }))
  return finalDb.stages[pid]
}

export function unitOf(code) {
  if (!finalDb.units[code]) finalDb.units[code] = { title: '', config: '', defects: '', testScope: '', aiTool: '', aiEvidence: '', sample: false, sampleNote: '', sampleBy: '', sampleAt: '' }
  return finalDb.units[code]
}

export function selectionOf(key) {
  if (!finalDb.selection[key]) finalDb.selection[key] = { stage: '未选', note: '', at: '' }
  return finalDb.selection[key]
}

export function feesOf(oid) {
  if (!finalDb.orderFees[oid]) finalDb.orderFees[oid] = { platform: 0, shipping: 0, repair: 0, other: 0, refund: 0, receivable: 0, note: '' }
  return finalDb.orderFees[oid]
}


export function ticketOf(pid) {
  if (!finalDb.tickets[pid]) finalDb.tickets[pid] = { park: '', date: '', type: '', visitor: '', realName: false, issue: '未出票', book: '未预约', carrier: '', station: '', depart: '', tz: '北京时间', hotel: '', nights: 0, guests: 2, total: 0, refund: '', ver: 'v1' }
  return finalDb.tickets[pid]
}
export function profitOf(pid) {
  if (!finalDb.profit[pid]) finalDb.profit[pid] = { type: '价差', reason: '', lasting: '长期', note: '' }
  return finalDb.profit[pid]
}
export function reserveOf(pid) {
  if (!finalDb.reservations[pid]) finalDb.reservations[pid] = { slots: [], commit: '', note: '', handoffText: '', cost: null }
  return finalDb.reservations[pid]
}

export const money = (n) => (Number(n) || 0).toFixed(2)
export { today }

// 新手导览（销售工作台交付包 TOUR-02/06）：按页面，每一步绑页面上真有的控件，只高亮和说明，不替人点任何按钮。
// 手机版和电脑版模板的类名不一样，sel 两个都写；找不到的步骤自动跳过（比如不是主管就没有「加派任务」）。
import { getApp } from '../runtime/app.js'
export const TOURS = {
  'pages/sales-workbench/index': [
    { sel: '.swb-dk-head, .swb-head', t: '这里是「今天」', d: '上班先看这里：系统按缺口把要做的事排好了，红的先做，黄的有空看，没列出来的不用管。' },
    { sel: '.swb-dk-cards, .swb-cards', t: '提成和今天的任务数', d: '今天和本月的提成、今天成交几件；「我今天的任务」是红几件、黄几件，做完一条回来就少一条。' },
    { sel: '.swb-dk-row--red, .swb-row--red', t: '最上面这一条', d: '从最上面做起。点右边的按钮会直接跳到那件货或那张单要处理的地方，做完回来这条就没了。' },
    { sel: '.swb-assign', t: '加派任务（主管）', d: '要人判断的活从这里派：写清要做什么、做到哪算完、几点交、派给谁。图片、上架这些系统会自己派。' },
    { sel: '.swb-report', t: '遇到没见过的情况', d: '不确定怎么办，别猜：点这里写一句话，主管马上在红灯清单里看到，处理完会记成大家都能看的规则。' },
    { sel: '.swb-dev', t: '提给开发', d: '软件出问题、想要新功能，从这里进禅道提，不要私发给程序员。谁提的谁验收。' },
    { sel: '.cb', t: '协同请求', d: '同事或外包客服转来的求助会浮在这里。60 秒没人接，转给所有在岗同事；再 60 秒，转主管。谁先点「我来接」就是谁的。' },
    { sel: '.swb-help-btn', t: '随时重看', d: '忘了怎么用就点这里，导览从头再走一遍。' },
  ],
  'pages/sales-goods/index': [
    { sel: '.sg-sum', t: '三个数字', d: '几件要处理（红）、几件注意（黄）、几件正常（绿）。点一个数字只看那一类。' },
    { sel: '.sg-seg', t: '按状态筛选', d: '「要处理」只看红的，从最上面一件开始。' },
    { sel: '.sg-seg + .sg-seg', t: '换个看法', d: '可以按状态、品类、来源（采购 / 资产录入）分组。' },
    { sel: '.sg-dk-search, .sg-search', t: '搜索', d: '名称、货号、品牌都能搜。' },
    { sel: '.sg-card', t: '一张卡就是一件货', d: '图只放验货实拍，没有就写「待补图」。卡片下面写着它最急的问题，点卡片进详情。' },
  ],
  'pages/sales-goods/item/index': [
    { sel: '.si-pic', t: '图', d: '只放这件货的验货实拍。没有实拍就写「待补图」，不拿别的图冒充。' },
    { sel: '.si-issues', t: '现在有几件事要看', d: '红的先处理。每一条后面的链接会带你去处理那一项。' },
    { sel: '.si-facts', t: '成本、最低价、建议价、行情', d: '最低价 = 成本 × 管理员定的倍数（数字就写在这里），定价不能低于它；低于要写理由、只有管理员能批。' },
    { sel: '.si-more__head', t: '更多详情（折叠着）', d: '库龄周期、各个号、关联单号都在这里，要查再点开。' },
    { sel: '.si-st', t: '下一步', d: '一步一步来：补齐信息 → 定价选图 → 审批 → 发布上架 → 发货出库。点哪一步看哪一步；点不了的会写明为什么。' },
  ],
}

// 按人记：仓库 / 门店共用电脑上前一个人看过，新来的人登录后照样自动弹
const key = () => {
  const u = (getApp().globalData || {}).user
  return `mp_tour_seen:${(u && u.id) || ''}`
}
const read = () => {
  try { return JSON.parse(localStorage.getItem(key()) || '{}') } catch { return {} }
}
// 看过（看完或点了跳过）就不再自动弹；跳过的记住停在第几步，下次「怎么用」接着看
export const tourSeen = (route) => route in read()
export const tourPos = (route) => read()[route] || 0
export function saveTour(route, pos) {
  try { localStorage.setItem(key(), JSON.stringify({ ...read(), [route]: pos })) } catch { /* 存不了就算了 */ }
}
export function resetTours() {
  try { localStorage.removeItem(key()) } catch { /* 同上 */ }
}

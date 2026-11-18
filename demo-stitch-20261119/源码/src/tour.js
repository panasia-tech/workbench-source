// 逐步导览（#95 TOUR-02/06）：每一步绑定页面上真实的控件，只高亮和说明，不代点任何按钮。
// 找不到控件的步骤自动跳过（比如这个人没有协同请求）。
export const TOURS = {
  today: [
    { sel: '[data-tour="today-head"]', t: '这里是「今天」', d: '上班先看这里：进来就是今天的任务，不用先选功能。' },
    { sel: '[data-tour="today-comm"]', t: '提成', d: '今天和本月的提成，分「已确认」和「待确认」两种。' },
    { sel: '[data-tour="today-team"]', t: '团队目标', d: '只显示团队进度，不排名。' },
    { sel: '[data-tour="today-count"]', t: '我今天的任务', d: '红色几件、黄色几件。做完一条，回来这里会少一条。' },
    { sel: '[data-tour="today-collab"]', t: '协同请求', d: '买家消息工作台转来的求助。60 秒没人接，转给在岗同事；再 60 秒，转主管。' },
    { sel: '[data-tour="today-list"] .tr', t: '最上面这一条', d: '红色的从最上面做起。点右边的「去处理」会直接跳到商品或订单的那一步。做完回来，这条就没了。' },
    { sel: '[data-tour="today-exc"]', t: '遇到没见过的情况', d: '不确定怎么办，别猜：点这里写一句话，主管马上在红灯清单里看到。' }
  ],
  gallery: [
    { sel: '[data-tour="gal-counts"]', t: '三个数字', d: '几件要处理（红）、几件注意（黄）、几件正常（绿）。点一下只看那一类。' },
    { sel: '[data-tour="gal-seg"]', t: '按状态筛选', d: '「要处理」只看红的，从最上面一件开始。' },
    { sel: '[data-tour="gal-by"]', t: '换个看法', d: '可以按状态、类型、品类或来源分组。' },
    { sel: '[data-tour="gal-search"]', t: '搜索', d: '名称、货号、品牌都能搜。' },
    { sel: '.gal .gc', t: '一张卡就是一件货', d: '大图、红黄绿状态、成本和库龄。点进去是详情，库龄、价格、上架、订单都在那一页。' }
  ],
  detail: [
    { sel: '[data-tour="dt-pic"]', t: '图', d: '主图下面是这件货的所有图。图的来源会标在角上：本件实拍、型号资料参考、生成示意。' },
    { sel: '[data-tour="dt-issues"]', t: '现在有几件事要看', d: '红的先处理。每一条后面的「去看」会带你到对应的位置。' },
    { sel: '[data-tour="dt-facts"]', t: '成本、最低价、建议价、行情', d: '最低价 = 成本 × 1.3。定价不能低于它。' },
    { sel: '[data-tour="dt-imgs"]', t: '三种图（折叠着）', d: '上架图（每个号一组，不能雷同）、实拍图、库位图。摘要里红的就是缺的或雷同的；点「展开」看每个号的图。' },
    { sel: '[data-tour="dt-fold"]', t: '更多详情（折叠着）', d: '库龄周期、价格范围、各个号、流转记录、关联单号都在这里。平时折叠，只露一行摘要；要查再点「展开」。上面红框里的「去看」会自动帮你展开。' },
    { sel: '#flow-panel', t: '下一步', d: '一步一步来：补齐信息 → 图库·核对（干净的图进图库，系统自动给每个号分不重复的图和行情价，你淘汰杂图、核对价格）→ 审批 → 发布上架 → 发货出库。灰色的按钮会写明为什么点不了。' }
  ]
}
export const TOUR_OF_HELP = { today: 'today', gallery: 'gallery', detail: 'detail' }
const KEY = 'tour_pos'
const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}') } catch { return {} } }
export const tourPos = (page) => read()[page] ?? 0
export const saveTourPos = (page, i) => { try { const m = read(); if (i == null) delete m[page]; else m[page] = i; localStorage.setItem(KEY, JSON.stringify(m)) } catch { /* 存不了就算了 */ } }

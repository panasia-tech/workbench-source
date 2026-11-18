// 公司钉钉 Wiki 的真实节点（来自 output/employee-wiki-20261107、output/sales-dual-library-wiki-20261109 的回执）。
// 没有已发布节点的制度，不编链接，写「待补」。
const N = (id) => `https://alidocs.dingtalk.com/i/nodes/${id}`
export const WIKI = {
  entry: { t: '员工工作入口', u: N('1zknDm0WRanqQP0YUdeaO5OR8BQEx5rG') },
  rules: { t: '制度查阅与生效版本', u: N('X6GRezwJlA5gBpx3ujbqK5YG8dqbropQ') },
  auth: { t: '公司制度与授权', u: N('nYMoO1rWxa5ny3PXUR5qlQXnV47Z3je9') },
  handoff: { t: '采购、仓管与销售交接规则', u: N('OG9lyrgJPzaqQx70uPpL1XBLWzN67Mw4') },
  listing: { t: '商品上架、客户确认与发货（试运行参考）', u: N('b9Y4gmKWrP5pynLDTr5qypZZJGXn6lpz') },
  role: { t: '岗位授权、替岗与升级', u: N('G53mjyd80pDo1GmEczkEP0NX86zbX04v') },
  manual: { t: '岗位操作手册', u: N('X6GRezwJlA5gBpx3ujbqmk5L8dqbropQ') },
  dual: { t: '销售工作台｜选品与历史库存双 Library 全流程 v1.0', u: N('1DKw2zgV2PMoYdjETdA3Re508B5r9YAn') },
  // 下面这些还没有已发布的 Wiki 节点：只登记名字，界面写「待补」
  remote: { t: '虚拟产品与服务调研 SOP（AI 旁听远程做单学习法）', u: '', note: '原文在本机 output/copilot-gap-analysis-20261031 里，Wiki 节点待补' },
  fingerprint: { t: '指纹浏览器使用管理条例', u: '', note: 'Wiki 节点待补' },
  service: { t: '技术服务：同行实操学习与交付', u: '', note: '服务远控交接包（output/工作台-程序员终极交接-20261101/docs/服务远控）还没发布到 Wiki，节点待补' }
}

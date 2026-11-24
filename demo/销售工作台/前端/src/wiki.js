// 公司钉钉 Wiki 与本版交付资料的稳定节点（2026-11-24 全量对接）。
// 所有已发布节点使用真实 alidocs.dingtalk.com/i/nodes/<nodeId>，未录制章节诚实标注状态。
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
  ui_charter: { t: '00｜泛亚工作台 UI 设计总纲领 v1.1', u: N('1OQX0akWmxAM02eyfNoOlbyn8GlDd3mE') },
  ui_error_report: { t: '04｜销售工作台历史 UI 设计错误复盘与视觉优先整改报告（2026-11-24）', u: N('l6Pm2Db8D49lkzyNiyGG4Egz8xLq0Ee4') },
  dev_norm: { t: '程序员规范全集（全量教程与发单规范）', u: N('vNG4YZ7JnPBj0zyKToEXK4qXW2LD0oRE') },
  sales_home: { t: '销售工作台｜业务说明与发布入口', u: N('y20BglGWO2ZB6yQRiDlD25R08A7depqY') },
  sales_spec: { t: '销售工作台｜合并外部客服全量规格与验收要点', u: N('OG9lyrgJPzaqQx70uPBPb5E0WzN67Mw4') },
  sales_h5: { t: '销售工作台｜统一双视角需求与交付 H5（V6）', u: N('MyQA2dXW7eplaKOETd6dxP3gJzlwrZgb') },
  sales_ai_manual: { t: '销售工作台｜智能体实施手册', u: N('b9Y4gmKWrP5pynLDTrpKDOd1JGXn6lpz') },
  shared_intro_video: { t: '泛亚全公司业务全貌共用开场 MP4（720p）', u: N('P0MALyR8kl5DyXpYsMEM4ky4W3bzYmDO') },
  main_video: { t: '销售工作台｜全量业务与实机主讲 MP4（720p · 57:33）', u: N('P0MALyR8kl5DyXpYsMEM4e6gW3bzYmDO') },
  cs_video: { t: '并入客服 V3｜全流程专项讲解 MP4（720p · 57:58）', u: N('P0MALyR8kl5DyXpYsMZd5O1vW3bzYmDO') },
  tutorial_index: { t: '销售工作台（含外部客服）｜节点通用视频覆盖与原生教程台账索引', u: N('GZLxjv9VGqMl2mDpIqYNLrrO86EDybno') },
  employee_pdf: { t: '销售工作台（含外部客服）｜员工可爱小动物风操作手册 PDF', u: N('vNG4YZ7JnPBj0zyKToqMNz7qW2LD0oRE') },
  remote: { t: '虚拟产品与服务调研 SOP（AI 旁听远程做单学习法）', u: N('b9Y4gmKWrP5pynLDTrpKDOd1JGXn6lpz'), note: '已并入销售工作台智能体实施手册' },
  fingerprint: { t: '群控与指纹浏览器使用规范（见销售主规格群控章节）', u: N('OG9lyrgJPzaqQx70uPBPb5E0WzN67Mw4') },
  service: { t: '技术服务：同行实操学习、CAD/三角洲模板与人工兜底', u: N('vNG4YZ7JnPBj0zyKToEXK4qXW2LD0oRE') }
}

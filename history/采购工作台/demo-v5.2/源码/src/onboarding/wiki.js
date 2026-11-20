// 公司钉钉 Wiki 与飞书 Wiki 真实制度节点（经全库核对，点击直达对应岗位手册与规则原稿）
const D = (id) => `https://alidocs.dingtalk.com/i/nodes/${id}`;
const F = (id) => `https://jcn8yz7sgrhq.feishu.cn/wiki/${id}`;

export const WIKI = {
  // 钉钉 Wiki：采购业务员岗位空间 5 大模块
  buyer_home: {
    t: '钉钉手册 · 采购业务员岗位主页',
    ver: '钉钉 Wiki',
    u: D('P0MALyR8kl5DyXpYsM5EAeNPW3bzYmDO'),
  },
  buyer_daily: {
    t: '钉钉手册 · 01 接任务、核价和下单',
    ver: '钉钉 Wiki',
    u: D('1R7q3QmWeeaQBDjmTKLGvyxrWxkXOEP2'),
  },
  buyer_auth: {
    t: '钉钉手册 · 02 付款审批和超授权处理（含100元规则）',
    ver: '钉钉 Wiki',
    u: D('R4GpnMqJzGrR6xP2hbEXlRxP8Ke0xjE3'),
  },
  buyer_after: {
    t: '钉钉手册 · 03 交仓、发现实物差异和退款报备',
    ver: '钉钉 Wiki',
    u: D('LeBq413JAwKlMXygcqkZAOw4WDOnGvpb'),
  },
  buyer_drill: {
    t: '钉钉手册 · 04 交单自查和异常演练',
    ver: '钉钉 Wiki',
    u: D('LeBq413JAwKlMXygcqkZlqxmWDOnGvpb'),
  },
  buyer_blank: {
    t: '钉钉手册 · 05 采购跟单、交仓与异常空白表',
    ver: '钉钉 Wiki',
    u: D('NkDwLng8ZLDqxG6gcp6z5gdkVKMEvZBY'),
  },

  // 钉钉 Wiki：采购主管与跨岗交接
  sup_home: {
    t: '钉钉手册 · 采购主管岗位主页（盘单·独立复核·拍板）',
    ver: '钉钉 Wiki',
    u: D('ndMj49yWjX09BkqbsgPX1ZdQJ3pmz5aA'),
  },
  handoff: {
    t: '钉钉手册 · 采购、仓管与销售交接规则',
    ver: '钉钉 Wiki',
    u: D('OG9lyrgJPzaqQx70uPpL1XBLWzN67Mw4'),
  },
  ui_master: {
    t: '钉钉手册 · 泛亚工作台防呆与减少培训设计规范',
    ver: 'v1.0',
    u: D('1OQX0akWmxAM02eyfNoOlbyn8GlDd3mE'),
  },

  // 飞书 Wiki：采购制度、两套打法、仓检联动与提成核算
  lark_ep01: {
    t: '飞书知识库 · 一线采购员制度与提成计算说明',
    ver: '飞书 Wiki',
    u: F('LpRrwOha4ivbVpkI8GqcyR4En7g'),
  },
  lark_ecp01: {
    t: '飞书知识库 · 采购业务流程员工白话说明',
    ver: '飞书 Wiki',
    u: F('FptnwEtD7i2jlWkk9L0chd7fnuX'),
  },
  lark_b02: {
    t: '飞书知识库 · 线上闲鱼谈价与到货差异处理细则',
    ver: '飞书 Wiki',
    u: F('PjvIwV4ETiIPTWkpxaHclFpHnrr'),
  },
  lark_two_modes: {
    t: '飞书知识库 · 常备款批量扫盘 + 老链接深翻捡漏两套打法',
    ver: '飞书 Wiki',
    u: F('U3hnwcQgziYXIxkel4UcbrSznId'),
  },
  lark_b04: {
    t: '飞书知识库 · 仓管开箱录像、十分钟联动与隔离放行',
    ver: '飞书 Wiki',
    u: F('Ulljw2gSCiGFMrkBaEtcojf8nPd'),
  },
  lark_b06: {
    t: '飞书知识库 · 资金对账与 10% / 20% 提成确认规则',
    ver: '飞书 Wiki',
    u: F('DZ2OwgeFnipdKMkhgxHcQiaJn4b'),
  },
  lark_high_risk: {
    t: '飞书知识库 · 「几乎全新」高危订单核验规范',
    ver: '飞书 Wiki',
    u: F('D03PwO4DHi0NE8kUMxac6EzDnue'),
  },
  lark_recall: {
    t: '飞书知识库 · 谈妥留货后第一时间拦回快递规定',
    ver: '飞书 Wiki',
    u: F('KLd9w3SFAi08FGkIKgLc9KNlnEc'),
  },

  // 兼容旧引用键名
  proc_sop: {
    t: '钉钉手册 · 接任务、核价和下单',
    ver: '钉钉 Wiki',
    u: D('1R7q3QmWeeaQBDjmTKLGvyxrWxkXOEP2'),
  },
  plan_b_rule: {
    t: '钉钉手册 · 交仓、发现实物差异和留货算账',
    ver: '钉钉 Wiki',
    u: D('LeBq413JAwKlMXygcqkZAOw4WDOnGvpb'),
  },
  entry: {
    t: '钉钉手册 · 泛亚员工手册总入口',
    ver: '钉钉 Wiki',
    u: D('1zknDm0WRanqQP0YUdeaO5OR8BQEx5rG'),
  },
};

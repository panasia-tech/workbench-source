// CS-ESCALATE-05 问题订单：缺视频或链接未绑一键找人处理
import * as T from '../lib/sup.js';
import { LINES, MARKS } from '../layout-escalate.js';

const { C, E, ease, rgba, zt, withA, span } = T;
const { L, M } = T.mkBeats(LINES, MARKS);
const NODE = 'CS-ESCALATE-05';

function issueOrderLogic(ctx, t) {
  // es02 常见两个卡点
  T.node(ctx, 430, 310, 540, 140, '卡点 ①：仓库高拍仪漏传通电视频\n肉眼看不见机器亮屏好不好', { a: E(t, L('es02', 0), L('es02', 0.45), ease.outBack), size: 32, fill: '#FFF8E6', stroke: '#D48806' });
  T.node(ctx, 430, 580, 540, 140, '卡点 ②：买家丢来一个商品链接\n右边查不到对应的仓库货号', { a: E(t, M('es02', 2, -0.1), M('es02', 2, 0.35), ease.outBack), size: 32, fill: '#FFF8E6', stroke: '#D48806' });

  withA(ctx, E(t, L('es03', -0.15), L('es03', 0.2)), () => {
    T.dashed(ctx, [[780, 160], [780, 810]], { lw: 3, color: rgba(C.ink, 0.3) });
  });

  // es03 最怕瞎答应
  T.node(ctx, 1340, 310, 620, 140, '没见视频、没绑货号就开口说「有货」\n发错或缺货都要自己背锅！', { a: E(t, L('es03', 0), L('es03', 0.45), ease.outBack), size: 34, font: 'hand', fill: '#FFE0DA', stroke: T.PEN, lw: 4 });
  T.cross(ctx, 1060, 260, 34, E(t, M('es03', 1, 0), M('es03', 1, 0.4)), T.PEN);
  T.arrow(ctx, [[1340, 395], [1340, 495]], E(t, M('es03', 2, -0.1), M('es03', 2, 0.3)), { lw: 5, color: '#2F8F4E' });
  T.node(ctx, 1340, 580, 620, 140, '正确做法：点一键呼救找对的人 60 秒补齐\n缺视频催仓管 · 缺货号呼叫内部销售', { a: E(t, M('es03', 2, 0), M('es03', 2, 0.45), ease.outBack), size: 34, font: 'hand', fill: rgba(C.teal, 0.2), stroke: C.teal, lw: 4 });
}

function stopDontGuess(ctx, t) {
  T.node(ctx, 960, 230, 880, 110, '停手线：仓库还没传视频、或销售还没绑好货号', { a: E(t, L('es14', 0), L('es14', 0.4), ease.outBack), size: 38, font: 'hand', fill: '#FFE0DA', stroke: T.PEN, lw: 5 });
  T.node(ctx, 470, 520, 460, 140, '严禁口头回「有货放心拍」', { a: E(t, M('es14', 1, -0.1), M('es14', 1, 0.35), ease.outBack), size: 38, font: 'hand', fill: '#FFFDF6', stroke: T.PEN });
  T.cross(ctx, 250, 456, 28, E(t, M('es14', 1, 0.1), M('es14', 1, 0.45)), T.PEN);
  T.arrow(ctx, [[720, 520], [920, 520]], E(t, M('es14', 2, -0.1), M('es14', 2, 0.3)), { lw: 6, color: '#2F8F4E' });
  T.clock(ctx, 1020, 520, 82, 0, 1, E(t, M('es14', 2, 0), M('es14', 2, 0.45), ease.outBack), { label: '先等 60 秒', lsize: 32 });
  T.node(ctx, 1440, 520, 520, 150, '礼貌请买家等 1 分钟\n视频/货号到账再确认成色答复', { a: E(t, M('es14', 2, 0.15), M('es14', 2, 0.55), ease.outBack), size: 34, font: 'hand', fill: rgba(C.teal, 0.2), stroke: C.teal, lw: 5 });
}

function summaryRules(ctx, t) {
  const items = [
    ['缺视频一键催仓管', '60 秒直达仓库补拍'],
    ['链接未绑找销售', '一键呼叫后台挂接货号'],
    ['外网链接坚决不点', '百度网盘红牌直接防掉'],
  ];
  items.forEach(([a, b], i) => {
    const x = 380 + i * 580;
    const tm = [M('es15', 1, -0.1), M('es15', 2, -0.1), M('es15', 3, -0.1)][i];
    const k = E(t, tm, tm + 0.45, ease.outBack);
    T.node(ctx, x, 460, 520, 240, '', { a: k, fill: i === 2 ? '#FFE0DA' : '#FFFDF6', stroke: i === 2 ? T.PEN : C.ink, seed: 8300 + i });
    withA(ctx, k, () => {
      T.penNum(ctx, x - 235, 355, i + 1, 1, { r: 28 });
      zt(ctx, a, x, 430, { size: 44, font: 'hand', color: i === 2 ? T.PEN : C.ink });
      zt(ctx, b, x, 505, { size: 34, color: C.ink2 });
    });
  });
}

export function scene(ctx, t) {
  T.setBenchName('外部客服工作台 V3');
  const t1 = L('es02', -0.2);
  T.titleCard(ctx, t, 0.2, t1, { title: '问题订单一键呼救', sub: '缺视频找仓管，没绑货找销售，不瞎答应不背锅', node: NODE });
  T.header(ctx, t, t1, '问题订单处理');

  withA(ctx, span(t, t1, L('es04', -0.1)), () => issueOrderLogic(ctx, t));

  T.walk(ctx, t, {
    steps: [
      { id: 'ES-01', t0: L('es04', -0.1), t1: L('es05', -0.1), fit: 'all', rings: [[0, M('es04', 1, 0)]] },
      { id: 'ES-01', t0: L('es05', -0.1), t1: L('es06', -0.1), zoom: [0, L('es05', -1), 1.3], rings: [[0, L('es05', 0.3)]] },
      { id: 'ES-01', t0: L('es06', -0.1), t1: L('es07', -0.1), zoom: [1, L('es06', -1), 0.9], rings: [[1, L('es06', 0.3)]] },
      { id: 'ES-01', t0: L('es07', -0.1), t1: L('es08', -0.1), zoom: [T.U('ES-01', 1, 2), L('es07', -1), 0.7], rings: [[2, L('es07', 0.2)], [1, M('es07', 1, 0)]] },
      { id: 'ES-02', t0: L('es08', -0.1), t1: L('es09', -0.1), zoom: [0, L('es08', 0.2), 1.3], rings: [[0, L('es08', 0.3)]] },
      { id: 'ES-02', t0: L('es09', -0.1), t1: L('es10', -0.1), zoom: [1, L('es09', -1), 0.75], rings: [[1, M('es09', 1, 0)]] },
      { id: 'ES-02', t0: L('es10', -0.1), t1: L('es11', -0.1), zoom: [1, L('es10', -1), 0.65], rings: [[1, L('es10', 0.2)]], hls: [[1, M('es10', 1, 0)]] },
      { id: 'ES-02', t0: L('es11', -0.1), t1: L('es12', -0.1), zoom: [T.U('ES-02', 2, 3), L('es11', -1), 0.75], rings: [[2, L('es11', 0.3)], [3, M('es11', 1, 0)]] },
      { id: 'ES-03', t0: L('es12', -0.1), t1: L('es13', -0.1), zoom: [0, L('es12', 0.2), 0.95], rings: [[0, M('es12', 1, 0)]] },
      { id: 'ES-03', t0: L('es13', -0.1), t1: L('es14', -0.1), zoom: [1, L('es13', -1), 0.95], rings: [[1, L('es13', 0.2)]] },
    ],
    card: {
      title: '问题订单呼救步骤',
      size: 28,
      t0: L('es04', -0.1),
      t1: L('es14', -0.1),
      marks: [L('es04', 0), L('es06', 0), L('es08', 0), L('es10', 0), L('es11', 0), L('es12', 0)],
      items: [
        { s: '点开左栏第 3 项「问题订单」' },
        { s: '缺视频 → 点黄钮催仓管 60s 补拍' },
        { s: '打开「链接未绑仓库货号」单' },
        { s: '遇红牌外网链接严禁点击' },
        { s: '点红钮呼叫内部销售 60s 绑货' },
        { s: '看「跨部门协同」工单进度' },
      ],
    },
  });

  withA(ctx, span(t, L('es10', 0.1), L('es11', -0.1)), () => {
    T.sticky(ctx, 1340, 740, 500, '百度网盘等外部地址已被拦截，千万别手痒复制点开。', 1, { head: '安全警示', size: 28, rot: 0.02 });
  });

  withA(ctx, span(t, L('es14', -0.1), L('es15', -0.1)), () => stopDontGuess(ctx, t));
  withA(ctx, span(t, L('es15', -0.1), L('es16', -0.1)), () => summaryRules(ctx, t));

  T.stepBar(ctx, t, [
    ['问题单', L('es04', -0.1)],
    ['催视频', L('es06', -0.1)],
    ['绑货号', L('es08', -0.1)],
    ['看工单', L('es12', -0.1)],
  ].map(([s, a]) => [s, t < L('es14', -0.1) ? a : 1e9]));

  T.endCard(ctx, t, L('es16', -0.1), '找对人 60 秒接应，比自己硬撑靠谱得多', ['① 缺视频点催仓管补拍  ② 没绑货点呼叫销售  ③ 外部网盘链接坚决不点', '不盲答有货，就不怕发错缺货背锅'], { node: NODE });
}

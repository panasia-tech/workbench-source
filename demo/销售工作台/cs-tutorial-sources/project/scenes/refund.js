// CS-REFUND-409-03 申请退款：三步引导秒退与拣货中红屏急停
import * as T from '../lib/sup.js';
import { LINES, MARKS } from '../layout-refund.js';

const { C, E, ease, rgba, zt, withA, span } = T;
const { L, M } = T.mkBeats(LINES, MARKS);
const NODE = 'CS-REFUND-409-03';

function refundTwoCases(ctx, t) {
  // rf02-03 左：未推仓未拣货
  const k1 = E(t, L('rf02', -0.1), L('rf02', 0.35), ease.outBack);
  T.node(ctx, 450, 230, 560, 100, '① 货还没推去仓库拣货', { a: k1, size: 38, font: 'hand', fill: rgba(C.teal, 0.2), stroke: C.teal });
  T.node(ctx, 320, 410, 340, 120, '错选「质量问题」\n人工审核卡几天', { a: E(t, M('rf02', 1, -0.1), M('rf02', 1, 0.35), ease.outBack), size: 30, fill: '#FFE0DA', stroke: T.PEN });
  T.cross(ctx, 165, 365, 32, E(t, M('rf02', 1, 0.15), M('rf02', 1, 0.5)), T.PEN);
  T.arrow(ctx, [[320, 480], [320, 565]], E(t, L('rf03', 0), L('rf03', 0.35)), { lw: 4.5, color: '#2F8F4E' });
  T.node(ctx, 450, 645, 580, 140, '0 秒自动发手机三步引导图\n改「不想要了 / 协商一致」→ 秒退', { a: E(t, L('rf03', 0.1), L('rf03', 0.5), ease.outBack), size: 32, font: 'hand', fill: '#E7F8EE', stroke: '#2F8F4E', lw: 4 });

  // 分割虚线
  withA(ctx, E(t, L('rf04', -0.15), L('rf04', 0.2)), () => {
    T.dashed(ctx, [[960, 160], [960, 810]], { lw: 3, color: rgba(C.ink, 0.3) });
  });

  // rf04 右：已进仓库波次拣货中
  const k2 = E(t, L('rf04', -0.1), L('rf04', 0.35), ease.outBack);
  T.node(ctx, 1430, 230, 600, 100, '② 货已在仓库波次里拣货打包', { a: k2, size: 38, font: 'hand', fill: '#FFE0DA', stroke: T.PEN, lw: 5 });
  T.node(ctx, 1430, 420, 540, 120, '先口头答应直接退钱\n仓库寄走了 → 货款两空！', { a: E(t, M('rf04', 1, -0.1), M('rf04', 1, 0.35), ease.outBack), size: 32, fill: '#FFE0DA', stroke: T.PEN });
  T.cross(ctx, 1180, 375, 34, E(t, M('rf04', 2, -0.1), M('rf04', 2, 0.3)), T.PEN);
  T.node(ctx, 1430, 645, 560, 130, '必须先按「红屏急停」锁死面单\n确认货回架再让买家改原因秒退', { a: E(t, M('rf04', 2, 0.1), M('rf04', 2, 0.55), ease.outBack), size: 34, font: 'hand', fill: '#FFFDF6', stroke: T.PEN, lw: 4 });
}

function stopRedLines(ctx, t) {
  T.node(ctx, 500, 320, 660, 170, '高压红线 ①：严禁点「关闭买家订单」\n不管多急都不许点，否则鱼力值暴跌封店', { a: E(t, L('rf14', 0), L('rf14', 0.45), ease.outBack), size: 34, font: 'hand', fill: '#FFE0DA', stroke: T.PEN, lw: 5 });
  T.cross(ctx, 195, 255, 36, E(t, M('rf14', 1, 0), M('rf14', 1, 0.4)), T.PEN);

  T.node(ctx, 1420, 320, 660, 170, '高压红线 ②：快递已揽收走怎么办？\n红屏已拦不住！立刻停手转内部销售拦件', { a: E(t, L('rf15', -0.1), L('rf15', 0.35), ease.outBack), size: 34, font: 'hand', fill: '#FFE98A', stroke: T.PEN, lw: 4 });
  T.arrow(ctx, [[1420, 420], [1420, 520]], E(t, M('rf15', 1, -0.1), M('rf15', 1, 0.3)), { lw: 5, color: T.PEN });
  T.node(ctx, 1420, 610, 620, 140, '内部联系快递网点拦截 + 引导买家拒签', { a: E(t, M('rf15', 1, 0.1), M('rf15', 1, 0.5), ease.outBack), size: 34, fill: '#FFFDF6', stroke: C.ink });
  T.node(ctx, 500, 610, 620, 140, '正确做法：未出库按红屏 → 货回架再改退', { a: E(t, M('rf14', 2, 0), M('rf14', 2, 0.45), ease.outBack), size: 34, fill: rgba(C.teal, 0.2), stroke: C.teal });
}

function summaryRules(ctx, t) {
  const items = [
    ['未拣货发三步图', '引导改「不想要了」秒退'],
    ['拣货中先按红屏', '扫码三声警报锁死面单'],
    ['永不点卖家关单', '已揽件转销售通知拦回'],
  ];
  items.forEach(([a, b], i) => {
    const x = 380 + i * 580;
    const tm = [M('rf16', 0, 0.1), M('rf16', 1, -0.1), M('rf16', 2, -0.1)][i];
    const k = E(t, tm, tm + 0.45, ease.outBack);
    T.node(ctx, x, 460, 520, 240, '', { a: k, fill: i === 2 ? '#FFE0DA' : '#FFFDF6', stroke: i === 2 ? T.PEN : C.ink, seed: 7100 + i });
    withA(ctx, k, () => {
      T.penNum(ctx, x - 235, 355, i + 1, 1, { r: 28 });
      zt(ctx, a, x, 430, { size: 44, font: 'hand', color: i === 2 ? T.PEN : C.ink });
      zt(ctx, b, x, 505, { size: 34, color: C.ink2 });
    });
  });
}

export function scene(ctx, t) {
  T.setBenchName('外部客服工作台 V3');
  const t1 = L('rf02', -0.2);
  T.titleCard(ctx, t, 0.2, t1, { title: '申请退款与拣货急停', sub: '分清是否已进仓库波次，一步不错防货款两空', node: NODE });
  T.header(ctx, t, t1, '退款与急停');

  withA(ctx, span(t, t1, L('rf05', -0.1)), () => refundTwoCases(ctx, t));

  T.walk(ctx, t, {
    steps: [
      { id: 'RF-01', t0: L('rf05', -0.1), t1: L('rf06', -0.1), fit: 'all', rings: [[0, M('rf05', 1, 0)]] },
      { id: 'RF-01', t0: L('rf06', -0.1), t1: L('rf07', -0.1), zoom: [1, L('rf06', -1), 0.6], rings: [[1, L('rf06', 0.3)]] },
      { id: 'RF-01', t0: L('rf07', -0.1), t1: L('rf08', -0.1), zoom: [3, L('rf07', -1), 1.25], rings: [[3, L('rf07', 0.3)]] },
      { id: 'RF-02', t0: L('rf08', -0.1), t1: L('rf09', -0.1), fit: 'all', rings: [[0, L('rf08', 0.25)], [1, M('rf08', 1, 0)]] },
      { id: 'RF-02', t0: L('rf09', -0.1), t1: L('rf10', -0.1), zoom: [T.U('RF-02', 2, 3), L('rf09', -1), 0.8], rings: [[2, L('rf09', 0.3)]], hls: [[2, M('rf09', 1, 0)]] },
      { id: 'RF-02', t0: L('rf10', -0.1), t1: L('rf11', -0.1), zoom: [T.U('RF-02', 3, 4), L('rf10', -1), 0.8], rings: [[3, L('rf10', 0.2)]] },
      { id: 'RF-02', t0: L('rf11', -0.1), t1: L('rf12', -0.1), zoom: [4, L('rf11', -1), 0.9], rings: [[4, L('rf11', 0.25)]] },
      { id: 'RF-03', t0: L('rf12', -0.1), t1: L('rf13', -0.1), fit: 'all', rings: [[0, M('rf12', 1, 0)], [1, L('rf12', 0.2)], [2, M('rf12', 2, 0)]] },
      { id: 'RF-01', t0: L('rf13', -0.1), t1: L('rf14', -0.1), zoom: [T.U('RF-01', 1, 2), L('rf13', -1), 0.5], rings: [[1, L('rf13', 0.25)]] },
    ],
    card: {
      title: '退款与红屏急停步骤',
      size: 28,
      t0: L('rf05', -0.1),
      t1: L('rf14', -0.1),
      marks: [L('rf05', 0), L('rf07', 0), L('rf08', 0), L('rf11', 0), L('rf12', 0), L('rf13', 0)],
      items: [
        { s: '「售后」找未拣货王女士' },
        { s: '发三步图引导改「不想要了」秒退' },
        { s: '看张同学是否已进「拣货波次」' },
        { s: '第一时间按「红屏急停锁面单」' },
        { s: '确认急停截单已生效 · 扫码报警' },
        { s: '货退回货架后再发图秒退' },
      ],
    },
  });

  withA(ctx, span(t, L('rf13', 0.1), L('rf14', -0.1)), () => {
    T.sticky(ctx, 1340, 740, 500, '仓库扫码确认回架，再让买家改原因秒退，货款两安全。', 1, { head: '正确顺序', size: 28, rot: 0.02 });
  });

  withA(ctx, span(t, L('rf14', -0.1), L('rf16', -0.1)), () => stopRedLines(ctx, t));
  withA(ctx, span(t, L('rf16', -0.1), L('rf17', -0.1)), () => summaryRules(ctx, t));

  T.stepBar(ctx, t, [
    ['未拣货', L('rf05', -0.1)],
    ['查波次', L('rf08', -0.1)],
    ['按急停', L('rf11', -0.1)],
    ['货回架', L('rf12', -0.1)],
  ].map(([s, a]) => [s, t < L('rf14', -0.1) ? a : 1e9]));

  T.endCard(ctx, t, L('rf17', -0.1), '未拣货三步秒退，已进波次先按红屏', ['① 未拣货发三步图秒退  ② 拣货中先按红屏锁面单  ③ 永不点关闭订单', '顺序走对了，一单都不会漏发误发'], { node: NODE });
}

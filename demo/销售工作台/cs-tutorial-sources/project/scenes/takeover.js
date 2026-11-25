// CS-TAKEOVER-06 大额砍价与接管：交给内部销售不乱退回
import * as T from '../lib/sup.js';
import { LINES, MARKS } from '../layout-takeover.js';

const { C, W, E, ease, rgba, zt, withA, span } = T;
const { L, M } = T.mkBeats(LINES, MARKS);
const NODE = 'CS-TAKEOVER-06';

function handoffLogic(ctx, t) {
  // tk02 砍价权限分界
  T.node(ctx, 430, 310, 520, 120, '小幅优惠 ≤ 20 元\n外包坐席可直接决定', { a: E(t, L('tk02', 0), L('tk02', 0.4), ease.outBack), size: 34, font: 'hand', fill: '#E7F8EE', stroke: '#2F8F4E' });
  T.node(ctx, 430, 560, 520, 130, '大刀砍价 / 棘手售后\n必须交给内部销售「陈小满」', { a: E(t, M('tk02', 1, -0.1), M('tk02', 1, 0.35), ease.outBack), size: 34, font: 'hand', fill: '#FFE98A', stroke: T.PEN, lw: 4 });

  withA(ctx, E(t, L('tk03', -0.15), L('tk03', 0.2)), () => {
    T.dashed(ctx, [[780, 160], [780, 810]], { lw: 3, color: rgba(C.ink, 0.3) });
  });

  // tk03-04 为什么交接清楚 + 不能乱甩锅
  T.node(ctx, 1330, 310, 620, 140, '内部手里看得到采购成本底线\n外包不越权答应就不会卖亏！', { a: E(t, L('tk03', 0), L('tk03', 0.45), ease.outBack), size: 34, font: 'hand', fill: rgba(C.teal, 0.2), stroke: C.teal, lw: 4 });
  T.node(ctx, 1330, 570, 620, 150, '注意：右栏实拍卡里已有答案还乱转\n陈小满退回 → 记一次「无效甩锅」！', { a: E(t, L('tk04', 0), L('tk04', 0.45), ease.outBack), size: 32, font: 'hand', fill: '#FFE0DA', stroke: T.PEN, lw: 4 });
  T.cross(ctx, 1045, 515, 34, E(t, M('tk04', 1, 0), M('tk04', 1, 0.4)), T.PEN);
}

function stopCheckFirst(ctx, t) {
  T.node(ctx, 960, 230, 880, 110, '边界红线：转销售前先自查，锁框期间按提示配合', { a: E(t, L('tk15', 0), L('tk15', 0.4), ease.outBack), size: 38, font: 'hand', fill: '#FFE98A', stroke: T.PEN, lw: 4 });
  T.node(ctx, 480, 510, 560, 160, '① 转出去之前先看右栏\n成色、配件、实拍卡有没有写清楚', { a: E(t, M('tk15', 0, 0.2), M('tk15', 0, 0.65), ease.outBack), size: 34, font: 'hand', fill: '#FFFDF6', stroke: C.ink });
  T.node(ctx, 1440, 510, 560, 160, '② 输入框变灰被排他锁住时别硬点\n照黄框锦囊或置顶承诺跟到底', { a: E(t, M('tk15', 2, -0.1), M('tk15', 2, 0.35), ease.outBack), size: 34, font: 'hand', fill: rgba(C.teal, 0.2), stroke: C.teal });
}

function summaryEnding(ctx, t) {
  withA(ctx, E(t, L('tk16', -0.1), L('tk16', 0.35)), () => {
    zt(ctx, '交接内部销售，记住这三条', W / 2, 230, { size: 58, font: 'hand', color: C.ink });
  });
  const items = [
    ['右栏有答案不乱甩', '先自查实拍与成色说明'],
    ['超 20 或难缠点升级', '找内部销售看底线定夺'],
    ['看黄锦囊和排他锁', '锁框不撞车 · 交还再跟进'],
  ];
  items.forEach(([a, b], i) => {
    const x = 380 + i * 580;
    const tm = [M('tk16', 0, 0.1), M('tk16', 1, -0.1), M('tk16', 2, -0.1)][i];
    const k = E(t, tm, tm + 0.45, ease.outBack);
    T.node(ctx, x, 490, 520, 240, '', { a: k, fill: i === 0 ? '#FFE0DA' : '#FFFDF6', stroke: i === 0 ? T.PEN : C.ink, seed: 8400 + i });
    withA(ctx, k, () => {
      T.penNum(ctx, x - 235, 385, i + 1, 1, { r: 28 });
      zt(ctx, a, x, 460, { size: 42, font: 'hand', color: i === 0 ? T.PEN : C.ink });
      zt(ctx, b, x, 535, { size: 32, color: C.ink2 });
    });
  });
  withA(ctx, E(t, M('tk16', 3, 0.2), M('tk16', 3, 0.65)), () => {
    T.chip(ctx, W / 2, 740, NODE, { size: 24, fill: '#fff', stroke: rgba(C.ink, 0.45), font: 'mono' });
  });
}

export function scene(ctx, t) {
  T.setBenchName('外部客服工作台 V3');
  const t1 = L('tk02', -0.2);
  T.titleCard(ctx, t, 0.2, t1, { title: '砍价超限交给内部销售', sub: '超 20 元或难缠售后一键升级，接管防撞车', node: NODE });
  T.header(ctx, t, t1, '砍价与接管');

  withA(ctx, span(t, t1, L('tk05', -0.1)), () => handoffLogic(ctx, t));

  T.walk(ctx, t, {
    steps: [
      { id: 'TK-01', t0: L('tk05', -0.1), t1: L('tk06', -0.1), zoom: [T.U('TK-01', 0, 1, 2), L('tk05', 0.2), 1.05], rings: [[0, L('tk05', 0.3)]] },
      { id: 'TK-01', t0: L('tk06', -0.1), t1: L('tk07', -0.1), zoom: [T.U('TK-01', 0, 1), L('tk06', -1), 0.9], rings: [[0, M('tk06', 1, 0)], [1, M('tk06', 2, 0)]] },
      { id: 'TK-01', t0: L('tk07', -0.1), t1: L('tk08', -0.1), zoom: [2, L('tk07', -1), 0.95], rings: [[2, L('tk07', 0.3)]] },
      { id: 'TK-02', t0: L('tk08', -0.1), t1: L('tk09', -0.1), zoom: [T.U('TK-02', 0, 1, 2, 3), L('tk08', 0.2), 0.85], rings: [[0, L('tk08', 0.3)]] },
      { id: 'TK-02', t0: L('tk09', -0.1), t1: L('tk10', -0.1), zoom: [2, L('tk09', -1), 1.0], rings: [[2, M('tk09', 1, 0)]] },
      { id: 'TK-02', t0: L('tk10', -0.1), t1: L('tk11', -0.1), zoom: [3, L('tk10', -1), 0.95], rings: [[3, M('tk10', 1, 0)]] },
      { id: 'TK-02', t0: L('tk11', -0.1), t1: L('tk12', -0.1), zoom: [1, L('tk11', -1), 1.0], rings: [[1, L('tk11', 0.3)]] },
      { id: 'TK-04', t0: L('tk12', -0.1), t1: L('tk13', -0.1), fit: 'all', rings: [[0, M('tk12', 1, 0)]] },
      { id: 'TK-04', t0: L('tk13', -0.1), t1: L('tk14', -0.1), zoom: [1, L('tk13', -1), 0.7], rings: [[1, L('tk13', 0.2)]] },
      { id: 'TK-03', t0: L('tk14', -0.1), t1: L('tk15', -0.1), zoom: [1, L('tk14', -1), 0.95], rings: [[1, L('tk14', 0.2)]] },
    ],
    card: {
      title: '协同接管与退回规范',
      size: 28,
      t0: L('tk05', -0.1),
      t1: L('tk15', -0.1),
      marks: [L('tk05', 0), L('tk07', 0), L('tk08', 0), L('tk10', 0), L('tk12', 0), L('tk14', 0)],
      items: [
        { s: '折叠区点「砍价转销售 / 售后升级」' },
        { s: '底线灰锁：永远禁用卖家关单' },
        { s: '内部陈小满可退回「无效甩锅」' },
        { s: '发「幕后锦囊」或直接「排他接管」' },
        { s: '黄底锦囊对买家隐藏 · 锁框防撞' },
        { s: '谈妥填备注交还，置顶承诺必看' },
      ],
    },
  });

  withA(ctx, span(t, L('tk13', 0.1), L('tk14', -0.1)), () => {
    T.sticky(ctx, 1340, 740, 500, '接管期间只有陈小满回买家，两个人绝不会聊乱。', 1, { head: '排他锁作用', size: 28, rot: 0.02 });
  });

  withA(ctx, span(t, L('tk15', -0.1), L('tk16', -0.1)), () => stopCheckFirst(ctx, t));
  withA(ctx, span(t, L('tk16', -0.1), 1e9), () => summaryEnding(ctx, t));

  T.stepBar(ctx, t, [
    ['找入口', L('tk05', -0.1)],
    ['销售台', L('tk08', -0.1)],
    ['看锦囊', L('tk12', -0.1)],
    ['交还单', L('tk14', -0.1)],
  ].map(([s, a]) => [s, t < L('tk15', -0.1) ? a : 1e9]));
}

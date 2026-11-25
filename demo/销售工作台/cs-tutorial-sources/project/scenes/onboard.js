// CS-ONBOARD-01 新人上岗：做完三关练习解锁真实接待
import * as T from '../lib/sup.js';
import { LINES, MARKS } from '../layout-onboard.js';

const { C, E, ease, rgba, zt, withA, span } = T;
const { L, M } = T.mkBeats(LINES, MARKS);
const NODE = 'CS-ONBOARD-01';

function firstDayIntro(ctx, t) {
  T.who(ctx, 290, 720, '客服', E(t, L('ob02', -0.1), L('ob02', 0.35), ease.outBack), { id: 4, label: '首日新人' });
  T.miniCard(ctx, 500, 260, 470, 250, '打开工作台第一眼', ['发送按钮 · 暂时锁着', '发实拍钮 · 暂时锁着'], E(t, M('ob02', 0, -0.1), M('ob02', 0, 0.35), ease.outBack));
  T.arrow(ctx, [[400, 560], [520, 490]], E(t, L('ob02', 0.2), L('ob02', 0.6)), { lw: 4.5 });
  T.node(ctx, 1340, 390, 520, 140, '这不是系统坏了！', { a: E(t, M('ob02', 1, -0.1), M('ob02', 1, 0.4), ease.outBack), size: 46, font: 'hand', fill: '#FFE98A', stroke: T.PEN, lw: 4 });
  T.chip(ctx, 1340, 560, '先用 60 秒练兵再碰真单', { a: E(t, M('ob02', 1, 0.2), M('ob02', 1, 0.6), ease.outBack), size: 32, fill: rgba(C.teal, 0.2), stroke: C.teal });
}

function whyLockLogic(ctx, t) {
  const errs = [
    ['发错网图凑数', '收货不对板 → 退单'],
    ['私留个人微信', '触发引流红线 → 封店'],
    ['错点关闭订单', '平台扣分 → 扣当月绩效'],
  ];
  errs.forEach(([a, b], i) => {
    const y = 260 + i * 210;
    const ka = E(t, M('ob03', i, -0.15), M('ob03', i, 0.3), ease.outBack);
    T.node(ctx, 430, y, 420, 120, `${a}\n${b}`, { a: ka, size: 30, fill: '#FFE0DA', stroke: T.PEN, seed: 5100 + i });
    T.cross(ctx, 235, y - 42, 32, E(t, M('ob03', i, 0.15), M('ob03', i, 0.5)), T.PEN);
  });

  withA(ctx, E(t, L('ob04', -0.1), L('ob04', 0.3)), () => {
    T.dashed(ctx, [[760, 160], [760, 810]], { lw: 3, color: rgba(C.ink, 0.3) });
  });
  T.clock(ctx, 1010, 440, 88, 0, 1, E(t, L('ob04', 0), L('ob04', 0.45), ease.outBack), { label: '60 秒三关', lsize: 36 });
  T.arrow(ctx, [[1120, 440], [1240, 440]], E(t, L('ob04', 0.25), L('ob04', 0.6)), { lw: 5 });
  T.node(ctx, 1520, 360, 480, 130, '全是假数据沙盒演练', { a: E(t, M('ob04', 1, -0.1), M('ob04', 1, 0.35), ease.outBack), size: 38, font: 'hand', fill: rgba(C.teal, 0.2), stroke: C.teal });
  T.node(ctx, 1520, 560, 480, 140, '点错立刻弹出防坑提醒\n绝不碰真实买家订单', { a: E(t, M('ob04', 2, -0.1), M('ob04', 2, 0.35), ease.outBack), size: 32, fill: '#FFFDF6', stroke: C.ink });
}

function stopStuck(ctx, t) {
  T.node(ctx, 960, 230, 860, 110, '停手线：连续两关答错卡住了怎么办？', { a: E(t, L('ob15', 0), L('ob15', 0.4), ease.outBack), size: 40, font: 'hand', fill: '#FFE0DA', stroke: T.PEN, lw: 5 });
  T.node(ctx, 470, 520, 460, 140, '别在弹窗里瞎猜乱蒙', { a: E(t, M('ob15', 0, 0.2), M('ob15', 0, 0.65), ease.outBack), size: 38, font: 'hand', fill: '#FFFDF6', stroke: T.PEN });
  T.cross(ctx, 255, 468, 36, E(t, M('ob15', 1, -0.1), M('ob15', 1, 0.3)), T.PEN);
  T.arrow(ctx, [[720, 520], [920, 520]], E(t, M('ob15', 1, 0.1), M('ob15', 1, 0.5)), { lw: 6, color: T.PEN });
  T.node(ctx, 1320, 520, 620, 160, '先关掉弹窗 → 点顶上蓝底「？」\n看懂规则说明再回来重选', { a: E(t, M('ob15', 2, -0.1), M('ob15', 2, 0.4), ease.outBack), size: 36, font: 'hand', fill: rgba(C.teal, 0.2), stroke: C.teal, lw: 5 });
}

function summaryRules(ctx, t) {
  const items = [
    ['假数据练错不怕', '60 秒沙盒不碰真单'],
    ['三关全通自动解锁', '秒开三栏真实接待台'],
    ['守住两条死底线', '不留微信 · 绝不关单'],
  ];
  items.forEach(([a, b], i) => {
    const x = 380 + i * 580;
    const tm = [M('ob16', 1, -0.1), M('ob16', 2, -0.1), M('ob16', 3, -0.1)][i];
    const k = E(t, tm, tm + 0.45, ease.outBack);
    T.node(ctx, x, 460, 520, 240, '', { a: k, fill: i === 2 ? '#FFE0DA' : '#FFFDF6', stroke: i === 2 ? T.PEN : C.ink, seed: 5200 + i });
    withA(ctx, k, () => {
      T.penNum(ctx, x - 235, 355, i + 1, 1, { r: 28 });
      zt(ctx, a, x, 430, { size: 46, font: 'hand', color: i === 2 ? T.PEN : C.ink });
      zt(ctx, b, x, 505, { size: 34, color: C.ink2 });
    });
  });
}

export function scene(ctx, t) {
  T.setBenchName('外部客服工作台 V3');
  const t1 = L('ob02', -0.2);
  T.titleCard(ctx, t, 0.2, t1, { title: '新人首日三关解锁上岗', sub: '假数据先练会防呆底线，再接真实订单', node: NODE });
  T.header(ctx, t, t1, '新人上岗');

  withA(ctx, span(t, t1, L('ob03', -0.15)), () => firstDayIntro(ctx, t));
  withA(ctx, span(t, L('ob03', -0.15), L('ob05', -0.1)), () => whyLockLogic(ctx, t));

  T.walk(ctx, t, {
    steps: [
      { id: 'OB-01', t0: L('ob05', -0.1), t1: L('ob06', -0.1), fit: 'all', rings: [[0, M('ob05', 1, 0)], [1, M('ob05', 2, 0)]] },
      { id: 'OB-01', t0: L('ob06', -0.1), t1: L('ob07', -0.1), zoom: [2, L('ob06', -1), 1.0], rings: [[2, L('ob06', 0.3)]] },
      { id: 'OB-02', t0: L('ob07', -0.1), t1: L('ob08', -0.1), zoom: [T.U('OB-02', 0, 1), L('ob07', -1), 0.7], rings: [[0, L('ob07', 0.2)], [1, M('ob07', 1, 0)]] },
      { id: 'OB-02', t0: L('ob08', -0.1), t1: L('ob09', -0.1), zoom: [2, L('ob08', -1), 0.8], rings: [[2, M('ob08', 1, 0)]], hls: [[2, M('ob08', 2, 0)]] },
      { id: 'OB-02', t0: L('ob09', -0.1), t1: L('ob10', -0.1), zoom: [3, L('ob09', -1), 0.85], rings: [[3, L('ob09', 0.3)]] },
      { id: 'OB-03', t0: L('ob10', -0.1), t1: L('ob12', -0.1), zoom: [T.U('OB-03', 0, 1), L('ob10', -1), 0.65], rings: [[0, M('ob10', 1, 0)]] },
      { id: 'OB-03', t0: L('ob12', -0.1), t1: L('ob13', -0.1), zoom: [T.U('OB-03', 1, 2), L('ob12', -1), 0.75], rings: [[1, L('ob12', 0.2)], [2, M('ob12', 2, -0.1)]] },
      { id: 'OB-04', t0: L('ob13', -0.1), t1: L('ob14', -0.1), fit: 'all', rings: [[0, L('ob13', 0.2)], [2, M('ob13', 1, 0)], [4, M('ob13', 2, 0)]] },
      { id: 'OB-04', t0: L('ob14', -0.1), t1: L('ob15', -0.1), zoom: [4, L('ob14', -1), 1.05], rings: [[4, L('ob14', 0.3)]] },
    ],
    card: {
      title: '新人三关解锁步骤',
      size: 28,
      t0: L('ob05', -0.1),
      t1: L('ob15', -0.1),
      marks: [L('ob05', 0), L('ob06', 0), L('ob07', 0), L('ob10', 0), L('ob12', 0), L('ob13', 0)],
      items: [
        { s: '看防呆锁与 3 关待解锁提示' },
        { s: '点蓝钮打开 60 秒练习窗口' },
        { s: '第 1 关：缺视频先催仓管补拍' },
        { s: '第 2~3 关：认绿灯 · 不留微信不关单' },
        { s: '点「解锁真实接待台」' },
        { s: '进入三栏接待（拿货成本已屏蔽）' },
      ],
    },
  });

  withA(ctx, span(t, L('ob11', 0), L('ob12', -0.1)), () => {
    T.sticky(ctx, 1340, 740, 500, '不留微信号、不主动关单、大额砍价点转销售。', 1, { head: '第 3 关底线', size: 28, rot: 0.02 });
  });
  withA(ctx, span(t, L('ob14', 0.2), L('ob15', -0.1)), () => {
    T.chip(ctx, 1590, 800, '采购底价已在服务端屏蔽', { size: 28, fill: rgba(C.teal, 0.2), stroke: C.teal });
  });

  withA(ctx, span(t, L('ob15', -0.1), L('ob16', -0.1)), () => stopStuck(ctx, t));
  withA(ctx, span(t, L('ob16', -0.1), L('ob17', -0.1)), () => summaryRules(ctx, t));

  T.stepBar(ctx, t, [
    ['开练习', L('ob05', -0.1)],
    ['过三关', L('ob07', -0.1)],
    ['点解锁', L('ob12', -0.1)],
    ['进三栏', L('ob13', -0.1)],
  ].map(([s, a]) => [s, t < L('ob15', -0.1) ? a : 1e9]));

  T.endCard(ctx, t, L('ob17', -0.1), '先练熟三关防呆，上手就能接真单', ['① 60秒假数据练错不怕  ② 三关全通自动解锁真接待  ③ 不留微信不关单', '想重新练习：点右上角「视角与更多」随时打开演练与页面导览'], { node: NODE });
}

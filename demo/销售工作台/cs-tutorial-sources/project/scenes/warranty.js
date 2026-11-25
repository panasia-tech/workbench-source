// CS-WARRANTY-02 激活保修：买家回同意自动推仓与提问暂停
import * as T from '../lib/sup.js';
import { LINES, MARKS } from '../layout-warranty.js';

const { C, E, ease, rgba, zt, withA, span } = T;
const { L, M } = T.mkBeats(LINES, MARKS);
const NODE = 'CS-WARRANTY-02';

function warrantyLogic(ctx, t) {
  // wa02 痛点
  T.node(ctx, 340, 290, 420, 120, '发完实拍照片\n买家去忙没回复', { a: E(t, L('wa02', -0.1), L('wa02', 0.35), ease.outBack), size: 32, fill: '#FFFDF6' });
  T.clock(ctx, 340, 560, 82, 17, 0, E(t, M('wa02', 1, -0.1), M('wa02', 1, 0.35), ease.outBack), { label: '错过 17:00 顺丰截单', lsize: 30, lcolor: T.PEN });
  T.arrow(ctx, [[560, 420], [720, 420]], E(t, L('wa03', -0.1), L('wa03', 0.35)), { lw: 5 });

  // wa03 保修激活确认卡
  T.miniCard(ctx, 730, 270, 440, 290, '保修激活确认卡', ['随实拍自动跟发，不用手复制', '写明：店铺质保服务条款', '写明：杭州市富阳区法院管辖'], E(t, L('wa03', 0), L('wa03', 0.45), ease.outBack), { fill: '#EEF4FF', stroke: '#3E6FB0' });

  // wa04 两条正路 + 一条急刹车
  const b1 = E(t, M('wa04', 0, -0.1), M('wa04', 0, 0.35), ease.outBack);
  const b2 = E(t, M('wa04', 1, -0.1), M('wa04', 1, 0.35), ease.outBack);
  const b3 = E(t, M('wa04', 2, -0.1), M('wa04', 2, 0.35), ease.outBack);
  T.arrow(ctx, [[1190, 320], [1340, 250]], b1, { lw: 4.5, color: '#2F8F4E' });
  T.node(ctx, 1580, 250, 440, 110, '买家回「同意」→ 立刻推仓', { a: b1, size: 32, font: 'hand', fill: '#E7F8EE', stroke: '#2F8F4E' });
  T.arrow(ctx, [[1190, 420], [1340, 440]], b2, { lw: 4.5, color: '#2F8F4E' });
  T.node(ctx, 1580, 440, 440, 110, '静默期满 → 自动推仓发货', { a: b2, size: 32, font: 'hand', fill: '#E7F8EE', stroke: '#2F8F4E' });
  T.arrow(ctx, [[1190, 520], [1340, 640]], b3, { lw: 5, color: T.PEN });
  T.node(ctx, 1580, 640, 440, 125, '买家一提问 → 毫秒急停暂停', { a: b3, size: 34, font: 'hand', fill: '#FFE0DA', stroke: T.PEN, lw: 5 });
}

function stopBoundary(ctx, t) {
  T.node(ctx, 960, 230, 880, 110, '停手线：买家不接受划痕，也不愿加价换 99 新', { a: E(t, L('wa16', 0), L('wa16', 0.45), ease.outBack), size: 38, font: 'hand', fill: '#FFE0DA', stroke: T.PEN, lw: 5 });
  T.node(ctx, 480, 520, 450, 140, '别硬点绿色「恢复发货」', { a: E(t, M('wa16', 1, -0.1), M('wa16', 1, 0.35), ease.outBack), size: 38, font: 'hand', fill: '#FFFDF6', stroke: T.PEN });
  T.cross(ctx, 270, 470, 36, E(t, M('wa16', 1, 0.1), M('wa16', 1, 0.5)), T.PEN);
  T.arrow(ctx, [[730, 520], [930, 520]], E(t, M('wa16', 2, -0.2), M('wa16', 2, 0.2)), { lw: 6, color: T.PEN });
  T.node(ctx, 1320, 520, 600, 150, '直接客气引导买家申请退款\n避免货寄过去再扯皮退货', { a: E(t, M('wa16', 2, 0), M('wa16', 2, 0.45), ease.outBack), size: 36, font: 'hand', fill: rgba(C.teal, 0.2), stroke: C.teal, lw: 5 });
}

function summaryRules(ctx, t) {
  const items = [
    ['实拍自带保修卡', '含富阳法院管辖条款'],
    ['回同意 / 静默推仓', '不用盯人催促自动发'],
    ['提问毫秒级急停', '谈妥后再点恢复推仓'],
  ];
  items.forEach(([a, b], i) => {
    const x = 380 + i * 580;
    const tm = [M('wa17', 0, 0.1), M('wa17', 1, -0.1), M('wa17', 2, -0.1)][i];
    const k = E(t, tm, tm + 0.45, ease.outBack);
    T.node(ctx, x, 460, 520, 240, '', { a: k, fill: i === 2 ? '#FFE0DA' : '#FFFDF6', stroke: i === 2 ? T.PEN : C.ink, seed: 6100 + i });
    withA(ctx, k, () => {
      T.penNum(ctx, x - 235, 355, i + 1, 1, { r: 28 });
      zt(ctx, a, x, 430, { size: 44, font: 'hand', color: i === 2 ? T.PEN : C.ink });
      zt(ctx, b, x, 505, { size: 34, color: C.ink2 });
    });
  });
}

export function scene(ctx, t) {
  T.setBenchName('外部客服工作台 V3');
  const t1 = L('wa02', -0.2);
  T.titleCard(ctx, t, 0.2, t1, { title: '保修激活与提问暂停', sub: '回同意或静默自动推仓，买家提问一毫秒急停', node: NODE });
  T.header(ctx, t, t1, '保修激活');

  withA(ctx, span(t, t1, L('wa05', -0.1)), () => warrantyLogic(ctx, t));

  T.walk(ctx, t, {
    steps: [
      { id: 'WA-01', t0: L('wa05', -0.1), t1: L('wa06', -0.1), zoom: [0, L('wa05', 0.2), 0.9], rings: [[0, M('wa05', 1, 0)]] },
      { id: 'WA-01', t0: L('wa06', -0.1), t1: L('wa07', -0.1), zoom: [T.U('WA-01', 0, 1, 2), L('wa06', -1), 0.7], rings: [[1, M('wa06', 1, 0)], [2, L('wa06', 0.2)]] },
      { id: 'WA-02', t0: L('wa07', -0.1), t1: L('wa08', -0.1), fit: 'all', rings: [[0, L('wa07', 0.2)], [1, M('wa07', 1, 0)]] },
      { id: 'WA-02', t0: L('wa08', -0.1), t1: L('wa09', -0.1), zoom: [T.U('WA-02', 3, 4), L('wa08', -1), 0.85], rings: [[3, M('wa08', 1, 0)]] },
      { id: 'WA-03', t0: L('wa09', -0.1), t1: L('wa10', -0.1), fit: 'all', rings: [[0, L('wa09', 0.2)], [1, M('wa09', 1, 0)]] },
      { id: 'WA-02', t0: L('wa10', -0.1), t1: L('wa11', -0.1), zoom: [2, L('wa10', -1), 1.25], rings: [[2, L('wa10', 0.3)]] },
      { id: 'WA-04', t0: L('wa11', -0.1), t1: L('wa12', -0.1), fit: 'all', rings: [[0, M('wa11', 1, 0)]] },
      { id: 'WA-04', t0: L('wa12', -0.1), t1: L('wa13', -0.1), zoom: [1, L('wa12', -1), 0.75], rings: [[1, L('wa12', 0.3)]] },
      { id: 'WA-04', t0: L('wa13', -0.1), t1: L('wa14', -0.1), zoom: [T.U('WA-04', 1, 2), L('wa13', -1), 0.65], rings: [[2, L('wa13', 0.2)]], hls: [[2, M('wa13', 1, 0)]] },
      { id: 'WA-04', t0: L('wa14', -0.1), t1: L('wa15', -0.1), zoom: [4, L('wa14', -1), 1.6], rings: [[4, M('wa14', 1, 0)]] },
      { id: 'WA-04', t0: L('wa15', -0.1), t1: L('wa16', -0.1), zoom: [3, L('wa15', -1), 0.95], rings: [[3, M('wa15', 1, 0)]] },
    ],
    card: {
      title: '自动激活与暂停规则',
      size: 28,
      t0: L('wa05', -0.1),
      t1: L('wa16', -0.1),
      marks: [L('wa05', 0), L('wa07', 0), L('wa09', 0), L('wa10', 0), L('wa11', 0), L('wa14', 0), L('wa15', 0)],
      items: [
        { s: '看「自动发图」富阳管辖保修卡' },
        { s: '回「同意」或等静默倒计时' },
        { s: '激活序列号质保并自动推仓' },
        { s: '没回话到点也自动推仓' },
        { s: '买家一提问 → 毫秒停发进问题单' },
        { s: '换选 99 新或讲清成色打消疑虑' },
        { s: '认可后点大绿钮「恢复推仓」' },
      ],
    },
  });

  withA(ctx, span(t, L('wa10', 0.1), L('wa11', -0.1)), () => {
    T.sticky(ctx, 1340, 740, 500, '30分钟静默无人提问，同样自动推仓顺丰打单。', 1, { head: '省心推仓', size: 28, rot: 0.02 });
  });

  withA(ctx, span(t, L('wa16', -0.1), L('wa17', -0.1)), () => stopBoundary(ctx, t));
  withA(ctx, span(t, L('wa17', -0.1), L('wa18', -0.1)), () => summaryRules(ctx, t));

  T.stepBar(ctx, t, [
    ['看规则', L('wa05', -0.1)],
    ['回同意', L('wa08', -0.1)],
    ['疑问停', L('wa11', -0.1)],
    ['点恢复', L('wa14', -0.1)],
  ].map(([s, a]) => [s, t < L('wa16', -0.1) ? a : 1e9]));

  T.endCard(ctx, t, L('wa18', -0.1), '省掉催回复工夫，有疑问自动踩刹车', ['① 跟发富阳管辖保修卡  ② 回同意/静默满自动推仓  ③ 提问毫秒停发，答妥再恢复', '保住当日顺丰截单，又保证零错发纠纷'], { node: NODE });
}

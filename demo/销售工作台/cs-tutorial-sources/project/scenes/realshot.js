// CS-REALSHOT-01 发货前挑货：认准绿灯真机发实拍和视频
import * as T from '../lib/sup.js';
import { LINES, MARKS } from '../layout-realshot.js';

const { C, W, H, E, ease, rgba, zt, withA, span } = T;
const { L, M } = T.mkBeats(LINES, MARKS);
const NODE = 'CS-REALSHOT-01';

// rs02 痛点场景：买家已付款，最怕没实拍、没试机视频
function painIntro(ctx, t) {
  T.who(ctx, 270, 720, '买家', E(t, L('rs02', -0.1), L('rs02', 0.35), ease.outBack), { id: 2, label: '已付款买家' });
  T.miniCard(ctx, 480, 250, 430, 240, '待发货订单', ['戴森吹风机 HD08 · ¥1390', '等待确认本机成色与实拍'], E(t, M('rs02', 0, -0.1), M('rs02', 0, 0.35), ease.outBack));
  T.arrow(ctx, [[370, 560], [500, 480]], E(t, M('rs02', 0, 0.1), M('rs02', 0, 0.5)), { lw: 4.5 });
  T.say(ctx, '发我手头这台的真实照片和亮屏试机视频！', 1320, 210, E(t, M('rs02', 1, -0.1), M('rs02', 1, 0.35), ease.outBack), { size: 34, w: 500 });
  T.chip(ctx, 1320, 520, '怕拿不到本机实拍', { a: E(t, M('rs02', 1, 0.1), M('rs02', 1, 0.5), ease.outBack), size: 34, fill: '#FFE0DA', stroke: T.PEN });
  T.chip(ctx, 1320, 650, '怕仓库漏拍亮屏视频', { a: E(t, M('rs02', 2, -0.1), M('rs02', 2, 0.35), ease.outBack), size: 34, fill: '#FFE0DA', stroke: T.PEN });
}

// rs03-rs04 核心逻辑：网图退单 vs 绿灯能挑/灰锁锁死
function logicCompare(ctx, t) {
  // 左半边：两个坑
  const k3 = E(t, L('rs03', -0.1), L('rs03', 0.35), ease.outBack);
  T.node(ctx, 320, 340, 340, 130, '随手拿网图凑数', { a: k3, size: 36, font: 'hand', fill: '#FFE0DA', stroke: T.PEN });
  T.arrow(ctx, [[500, 340], [640, 340]], E(t, M('rs03', 1, -0.1), M('rs03', 1, 0.3)), { lw: 5, color: T.PEN });
  T.node(ctx, 810, 340, 310, 130, '收货不对板 → 退单', { a: E(t, M('rs03', 1, 0), M('rs03', 1, 0.45), ease.outBack), size: 34, fill: '#FFFDF6', stroke: T.PEN });
  T.cross(ctx, 155, 290, 36, E(t, M('rs03', 0, 0.3), M('rs03', 0, 0.7)), T.PEN);

  const k3b = E(t, M('rs03', 2, -0.2), M('rs03', 2, 0.25), ease.outBack);
  T.node(ctx, 320, 620, 340, 130, '没视频强行发货', { a: k3b, size: 36, font: 'hand', fill: '#FFE0DA', stroke: T.PEN });
  T.arrow(ctx, [[500, 620], [640, 620]], E(t, M('rs03', 2, 0.1), M('rs03', 2, 0.45)), { lw: 5, color: T.PEN });
  T.node(ctx, 810, 620, 310, 130, '到货扯皮说不清', { a: E(t, M('rs03', 2, 0.2), M('rs03', 2, 0.6), ease.outBack), size: 34, fill: '#FFFDF6', stroke: T.PEN });
  T.cross(ctx, 155, 570, 36, E(t, M('rs03', 2, 0.3), M('rs03', 2, 0.7)), T.PEN);

  // 分割虚线 + 右半边：系统分两灯
  withA(ctx, E(t, L('rs04', -0.1), L('rs04', 0.3)), () => {
    T.dashed(ctx, [[1020, 170], [1020, 810]], { lw: 3, color: rgba(C.ink, 0.3) });
    zt(ctx, '系统把在库机器分成两类', 1420, 210, { size: 42, font: 'hand', color: C.ink });
  });
  T.light(ctx, 1130, 380, T.GRN, '绿灯 · 可以挑', '实拍图与 16 秒试机视频都齐了', E(t, M('rs04', 1, -0.1), M('rs04', 1, 0.35), ease.outBack), { size: 48 });
  T.light(ctx, 1130, 600, '#9AA3AE', '灰锁 · 不能选', '还缺试机视频，系统直接锁死', E(t, M('rs04', 2, -0.1), M('rs04', 2, 0.35), ease.outBack), { size: 48 });
  T.zstamp(ctx, '不能选', 1660, 720, t - M('rs04', 3, -0.1), { size: 48, rot: -0.08 });
}

// rs16-rs17 停手红线：同款全亮灰锁怎么办
function stopLine(ctx, t) {
  T.node(ctx, 960, 220, 880, 110, '停手线：同款机器全亮灰锁、都缺试机视频', { a: E(t, L('rs16', 0), L('rs16', 0.45), ease.outBack), size: 40, font: 'hand', fill: '#FFE0DA', stroke: T.PEN, lw: 5 });

  [['私下口头答应买家', 340], ['拿网上图片凑数顶替', 680]].forEach(([s, y], i) => {
    const k = E(t, M('rs16', 1 + i, -0.1), M('rs16', 1 + i, 0.35), ease.outBack);
    T.node(ctx, 420, y + 110, 460, 116, s, { a: k, size: 36, fill: '#FFFDF6', stroke: T.PEN });
    T.cross(ctx, 200, y + 66, 36, E(t, M('rs16', 2 + i, 0), M('rs16', 2 + i, 0.45)), T.PEN);
  });

  T.arrow(ctx, [[690, 560], [870, 560]], E(t, L('rs17', -0.1), L('rs17', 0.35)), { lw: 6, color: T.PEN });
  T.clock(ctx, 1020, 540, 88, 0, 1, E(t, L('rs17', 0.1), L('rs17', 0.55), ease.outBack), { label: '60 秒补拍', lsize: 36 });
  T.node(ctx, 1460, 500, 520, 150, '点「催仓库 60 秒补拍」', { a: E(t, L('rs17', 0.2), L('rs17', 0.7), ease.outBack), size: 42, font: 'hand', fill: rgba(C.teal, 0.2), stroke: C.teal, lw: 5 });
  T.arrow(ctx, [[1460, 585], [1460, 675]], E(t, M('rs17', 1, -0.1), M('rs17', 1, 0.35)), { lw: 5, color: C.ink });
  T.node(ctx, 1460, 745, 520, 110, '实拍上传后再回复买家', { a: E(t, M('rs17', 1, 0.1), M('rs17', 1, 0.5), ease.outBack), size: 36, fill: '#FFFDF6', stroke: C.ink });
}

// rs18 结尾记住三条
function summaryRules(ctx, t) {
  const items = [
    ['只挑绿灯真机', '实拍视频齐才点选'],
    ['灰锁不瞎承诺', '一键催仓 60 秒补拍'],
    ['一按钮一次发齐', '实拍 + 视频 + 保修卡'],
  ];
  items.forEach(([a, b], i) => {
    const x = 380 + i * 580;
    const tm = [M('rs18', 1, -0.1), M('rs18', 2, -0.1), M('rs18', 3, -0.1)][i];
    const k = E(t, tm, tm + 0.45, ease.outBack);
    T.node(ctx, x, 460, 520, 240, '', { a: k, fill: i === 1 ? '#FFE0DA' : '#FFFDF6', stroke: i === 1 ? T.PEN : C.ink, seed: 8100 + i });
    withA(ctx, k, () => {
      T.penNum(ctx, x - 235, 355, i + 1, 1, { r: 28 });
      zt(ctx, a, x, 430, { size: 46, font: 'hand', color: i === 1 ? T.PEN : C.ink });
      zt(ctx, b, x, 505, { size: 36, color: C.ink2 });
    });
  });
}

export function scene(ctx, t) {
  T.setBenchName('外部客服工作台 V3');
  const t1 = L('rs02', -0.2);
  T.titleCard(ctx, t, 0.2, t1, { title: '发货前挑绿灯真机', sub: '认准实拍与通电视频，一件一拍防错发', node: NODE });
  T.header(ctx, t, t1, '发货前挑货');

  withA(ctx, span(t, t1, L('rs03', -0.15)), () => painIntro(ctx, t));
  withA(ctx, span(t, L('rs03', -0.15), L('rs05', -0.1)), () => logicCompare(ctx, t));

  // Live GUI Walk: RS-01 -> RS-02 -> RS-03
  T.walk(ctx, t, {
    steps: [
      { id: 'RS-01', t0: L('rs05', -0.1), t1: L('rs06', -0.1), zoom: [0, L('rs05', 0.3), 1.3], rings: [[0, M('rs05', 2, -0.1)]] },
      { id: 'RS-01', t0: L('rs06', -0.1), t1: L('rs07', -0.1), zoom: [1, L('rs06', -1), 0.75], rings: [[1, M('rs06', 1, 0)]] },
      { id: 'RS-01', t0: L('rs07', -0.1), t1: L('rs08', -0.1), zoom: [2, L('rs07', -1), 0.65], rings: [[2, M('rs07', 0, 0)]] },
      { id: 'RS-01', t0: L('rs08', -0.1), t1: L('rs09', -0.1), zoom: [T.U('RS-01', 4, 5), L('rs08', -1), 1.4], rings: [[4, M('rs08', 2, 0)]] },
      { id: 'RS-01', t0: L('rs09', -0.1), t1: L('rs10', -0.1), zoom: [T.U('RS-01', 4, 5), L('rs09', -1), 1.4], rings: [[5, L('rs09', 0.2)]], hls: [[5, M('rs09', 1, 0)]] },
      { id: 'RS-02', t0: L('rs10', -0.1), t1: L('rs11', -0.1), zoom: [0, L('rs10', 0.2), 0.9], rings: [[0, M('rs10', 1, 0)]] },
      { id: 'RS-02', t0: L('rs11', -0.1), t1: L('rs12', -0.1), zoom: [T.U('RS-02', 0, 1), L('rs11', -1), 0.75], rings: [[1, M('rs11', 1, 0)]] },
      { id: 'RS-02', t0: L('rs12', -0.1), t1: L('rs13', -0.1), zoom: [T.U('RS-02', 1, 2), L('rs12', -1), 1.15], rings: [[2, M('rs12', 1, 0)]], hls: [[2, M('rs12', 2, 0)]] },
      { id: 'RS-01', t0: L('rs13', -0.1), t1: L('rs14', -0.1), zoom: [T.U('RS-01', 2, 3), L('rs13', -1), 0.55], rings: [[3, M('rs13', 1, 0)]] },
      { id: 'RS-03', t0: L('rs14', -0.1), t1: L('rs15', -0.1), zoom: [T.U('RS-03', 0, 1), L('rs14', -1), 0.3], rings: [[0, M('rs14', 1, 0)], [1, M('rs14', 2, 0)]] },
      { id: 'RS-03', t0: L('rs15', -0.1), t1: L('rs16', -0.1), zoom: [2, L('rs15', -1), 0.65], rings: [[2, M('rs15', 1, 0)]] },
    ],
    card: {
      title: '挑绿灯发实拍',
      size: 28,
      t0: L('rs05', -0.1),
      t1: L('rs16', -0.1),
      marks: [L('rs05', 0), L('rs07', 0), L('rs08', 0), L('rs10', 0), L('rs12', 0), L('rs13', 0), L('rs14', 0)],
      items: [
        { s: '左栏点开已付款「林先生」' },
        { s: '看右上角当前第 1 步' },
        { s: '绿点可选 · 灰锁禁选' },
        { s: '核对 2 张实拍 + 16s 视频' },
        { s: '展开全检四关 · 隐藏成本' },
        { s: '点蓝色主按钮一次发齐' },
        { s: '自动进入第 2 步等同意' },
      ],
    },
  });

  withA(ctx, span(t, L('rs09', 0.2), L('rs10', -0.1)), () => {
    T.sticky(ctx, 1340, 750, 500, '灰锁说明缺仓库通电视频，系统锁死防错发纠纷。', 1, { head: '灰锁禁选原因', size: 28, rot: 0.02 });
  });
  withA(ctx, span(t, L('rs12', 0.3), L('rs13', -0.1)), () => {
    T.chip(ctx, 1590, 815, '外包端已自动隐藏拿货成本', { size: 28, fill: rgba(C.teal, 0.2), stroke: C.teal });
  });

  withA(ctx, span(t, L('rs16', -0.1), L('rs18', -0.1)), () => stopLine(ctx, t));
  withA(ctx, span(t, L('rs18', -0.1), L('rs19', -0.1)), () => summaryRules(ctx, t));

  T.stepBar(ctx, t, [
    ['选会话', L('rs05', -0.1)],
    ['分红绿', L('rs08', -0.1)],
    ['核实拍', L('rs10', -0.1)],
    ['一键发', L('rs13', -0.1)],
  ].map(([s, a]) => [s, t < L('rs16', -0.1) ? a : 1e9]));

  T.endCard(ctx, t, L('rs19', -0.1), '真机实拍一次发齐，买家放心等收货', ['① 只挑绿灯真机  ② 灰锁缺视频催仓补拍不盲答  ③ 实拍视频保修卡一键发齐', '忘了怎么挑，点标题旁边「？」随时回看本节'], { node: NODE });
}

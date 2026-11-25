// CS-GUARD-KPI-04 合规与绩效：防加微信拦截与日常考核
import * as T from '../lib/sup.js';
import { LINES, MARKS } from '../layout-guard.js';

const { C, W, E, ease, rgba, zt, withA, span } = T;
const { L, M } = T.mkBeats(LINES, MARKS);
const NODE = 'CS-GUARD-KPI-04';

function kpiAndGuardLogic(ctx, t) {
  // gd02 左：盯好 3 个数
  withA(ctx, E(t, L('gd02', -0.1), L('gd02', 0.25)), () => {
    zt(ctx, '平时上班只盯好 3 个数', 440, 210, { size: 42, font: 'hand', color: C.ink });
  });
  const metrics = [
    ['首响尽量 ≤ 30 秒', '别让买家干等超过半分钟'],
    ['3 分钟人工回复率 ≥ 96%', '机器人安抚不算人工真回'],
    ['实拍与保修卡执行到位', '每一笔付款单按流程发齐'],
  ];
  metrics.forEach(([a, b], i) => {
    const y = 330 + i * 165;
    const km = E(t, M('gd02', i, -0.1), M('gd02', i, 0.35), ease.outBack);
    T.miniCard(ctx, 140, y - 55, 600, 125, a, [b], km, { fill: '#EEF8F2', stroke: '#2F8F4E', tsize: 32, size: 26 });
  });

  withA(ctx, E(t, L('gd03', -0.15), L('gd03', 0.2)), () => {
    T.dashed(ctx, [[860, 160], [860, 810]], { lw: 3, color: rgba(C.ink, 0.3) });
  });

  // gd03-04 右：机器人兜底不算数 + 发微信和单字1直拦
  T.clock(ctx, 1080, 320, 78, 0, 1, E(t, L('gd03', 0), L('gd03', 0.4), ease.outBack), { label: '50秒机器人兜底', lsize: 30 });
  T.arrow(ctx, [[1180, 320], [1290, 320]], E(t, M('gd03', 1, -0.1), M('gd03', 1, 0.3)), { lw: 4.5, color: T.PEN });
  T.node(ctx, 1550, 320, 480, 130, '不算人工回复！\n超 5 分钟算漏回', { a: E(t, M('gd03', 1, 0.05), M('gd03', 1, 0.45), ease.outBack), size: 32, font: 'hand', fill: '#FFE0DA', stroke: T.PEN });

  const g4 = E(t, L('gd04', 0), L('gd04', 0.4), ease.outBack);
  T.node(ctx, 1230, 620, 430, 130, '偷发单字「1」\n或留微信 / 手机号', { a: g4, size: 32, fill: '#FFE0DA', stroke: T.PEN });
  T.cross(ctx, 1030, 570, 32, E(t, M('gd04', 1, 0), M('gd04', 1, 0.4)), T.PEN);
  T.arrow(ctx, [[1460, 620], [1565, 620]], E(t, M('gd04', 2, -0.1), M('gd04', 2, 0.25)), { lw: 4.5, color: T.PEN });
  T.node(ctx, 1710, 620, 260, 120, '发送按钮\n当场锁灰', { a: E(t, M('gd04', 2, 0), M('gd04', 2, 0.45), ease.outBack), size: 32, font: 'hand', fill: '#FFFDF6', stroke: T.PEN });
}

function stopWorkaround(ctx, t) {
  T.node(ctx, 960, 230, 860, 110, '停手线：别拿谐音字、拆号去试探守卫', { a: E(t, L('gd15', 0), L('gd15', 0.4), ease.outBack), size: 40, font: 'hand', fill: '#FFE0DA', stroke: T.PEN, lw: 5 });
  T.node(ctx, 470, 520, 460, 140, '谐音「微新」/ 拆两段手机号', { a: E(t, M('gd15', 0, 0.2), M('gd15', 0, 0.65), ease.outBack), size: 34, font: 'hand', fill: '#FFFDF6', stroke: T.PEN });
  T.cross(ctx, 250, 456, 28, E(t, M('gd15', 1, -0.1), M('gd15', 1, 0.3)), T.PEN);
  T.arrow(ctx, [[720, 520], [920, 520]], E(t, M('gd15', 1, 0.1), M('gd15', 1, 0.5)), { lw: 6, color: T.PEN });
  T.node(ctx, 1320, 520, 620, 150, '守卫照样抓痕拦截，记录直接写进档案\n直接影响当月结算与评优', { a: E(t, M('gd15', 2, -0.1), M('gd15', 2, 0.4), ease.outBack), size: 34, font: 'hand', fill: '#FFE0DA', stroke: T.PEN, lw: 5 });
}

function summaryEnding(ctx, t) {
  withA(ctx, E(t, L('gd16', -0.1), L('gd16', 0.35)), () => {
    zt(ctx, '守住合规与绩效，记住这三条', W / 2, 230, { size: 58, font: 'hand', color: C.ink });
  });
  const items = [
    ['机器人兜底不算真回', '抢在三分钟内亲手真答'],
    ['不留微信不发「1」', '站外引流用快捷短语婉拒'],
    ['按流程发实拍保修', '实干拿满当月全额日奖'],
  ];
  items.forEach(([a, b], i) => {
    const x = 380 + i * 580;
    const tm = [M('gd16', 1, -0.1), M('gd16', 2, -0.1), M('gd16', 3, -0.1)][i];
    const k = E(t, tm, tm + 0.45, ease.outBack);
    T.node(ctx, x, 490, 520, 240, '', { a: k, fill: i === 1 ? '#FFE0DA' : '#FFFDF6', stroke: i === 1 ? T.PEN : C.ink, seed: 8200 + i });
    withA(ctx, k, () => {
      T.penNum(ctx, x - 235, 385, i + 1, 1, { r: 28 });
      zt(ctx, a, x, 460, { size: 42, font: 'hand', color: i === 1 ? T.PEN : C.ink });
      zt(ctx, b, x, 535, { size: 32, color: C.ink2 });
    });
  });
  withA(ctx, E(t, M('gd16', 3, 0.2), M('gd16', 3, 0.65)), () => {
    T.chip(ctx, W / 2, 740, NODE, { size: 24, fill: '#fff', stroke: rgba(C.ink, 0.45), font: 'mono' });
  });
}

export function scene(ctx, t) {
  T.setBenchName('外部客服工作台 V3');
  const t1 = L('gd02', -0.2);
  T.titleCard(ctx, t, 0.2, t1, { title: '外发合规与日常考核', sub: '盯好三个关键指标，守住防引流不刷回复红线', node: NODE });
  T.header(ctx, t, t1, '合规与绩效');

  withA(ctx, span(t, t1, L('gd05', -0.1)), () => kpiAndGuardLogic(ctx, t));

  T.walk(ctx, t, {
    steps: [
      { id: 'GD-01', t0: L('gd05', -0.1), t1: L('gd06', -0.1), zoom: [0, L('gd05', 0.2), 1.4], rings: [[0, M('gd05', 1, 0)]] },
      { id: 'GD-01', t0: L('gd06', -0.1), t1: L('gd07', -0.1), fit: 'all', rings: [[1, L('gd06', 0.2)], [2, M('gd06', 1, 0)]] },
      { id: 'GD-01', t0: L('gd07', -0.1), t1: L('gd08', -0.1), zoom: [3, L('gd07', -1), 0.9], rings: [[3, L('gd07', 0.3)]] },
      { id: 'GD-02', t0: L('gd08', -0.1), t1: L('gd09', -0.1), zoom: [T.U('GD-02', 0, 1), L('gd08', -1), 0.8], rings: [[0, M('gd08', 1, 0)]] },
      { id: 'GD-02', t0: L('gd09', -0.1), t1: L('gd10', -0.1), zoom: [T.U('GD-02', 0, 1, 2), L('gd09', -1), 0.7], rings: [[2, L('gd09', 0.2)], [1, M('gd09', 1, 0)]], hls: [[2, M('gd09', 1, 0)]] },
      { id: 'GD-02', t0: L('gd10', -0.1), t1: L('gd11', -0.1), zoom: [T.U('GD-02', 2, 3), L('gd10', -1), 0.8], rings: [[3, L('gd10', 0.3)]] },
      { id: 'GD-03', t0: L('gd11', -0.1), t1: L('gd12', -0.1), zoom: [0, L('gd11', 0.2), 0.9], rings: [[0, M('gd11', 1, 0)]] },
      { id: 'GD-03', t0: L('gd12', -0.1), t1: L('gd13', -0.1), zoom: [T.U('GD-03', 1, 2), L('gd12', -1), 0.55], rings: [[1, L('gd12', 0.2)], [2, M('gd12', 2, 0)]], hls: [[2, M('gd12', 2, 0)]] },
      { id: 'GD-04', t0: L('gd13', -0.1), t1: L('gd14', -0.1), zoom: [0, L('gd13', 0.2), 0.8], rings: [[0, L('gd13', 0.2)], [1, M('gd13', 1, 0)], [2, M('gd13', 2, 0)]] },
      { id: 'GD-03', t0: L('gd14', -0.1), t1: L('gd15', -0.1), zoom: [3, L('gd14', -1), 1.4], rings: [[3, L('gd14', 0.3)]] },
    ],
    card: {
      title: '外发合规与考核大盘',
      size: 28,
      t0: L('gd05', -0.1),
      t1: L('gd15', -0.1),
      marks: [L('gd05', 0), L('gd06', 0), L('gd08', 0), L('gd10', 0), L('gd11', 0), L('gd13', 0)],
      items: [
        { s: '顶栏抬头实时看 5 个成绩' },
        { s: '50s兜底待真回 → 赶快手答' },
        { s: '微信号/单字「1」发送立刻锁灰' },
        { s: '用「防引流婉拒」安全话术' },
        { s: '「全维考核」分开算兜底与真回' },
        { s: '核对反作弊雷达 · 导出结算表格' },
      ],
    },
  });

  withA(ctx, span(t, L('gd14', 0.1), L('gd15', -0.1)), () => {
    T.sticky(ctx, 1340, 740, 500, '每笔奖惩都有当时聊天记录留证，月底清楚对账。', 1, { head: '导出凭证', size: 28, rot: 0.02 });
  });

  withA(ctx, span(t, L('gd15', -0.1), L('gd16', -0.1)), () => stopWorkaround(ctx, t));
  withA(ctx, span(t, L('gd16', -0.1), 1e9), () => summaryEnding(ctx, t));

  T.stepBar(ctx, t, [
    ['盯绩效', L('gd05', -0.1)],
    ['防引流', L('gd08', -0.1)],
    ['全考核', L('gd11', -0.1)],
    ['查预警', L('gd13', -0.1)],
  ].map(([s, a]) => [s, t < L('gd15', -0.1) ? a : 1e9]));
}

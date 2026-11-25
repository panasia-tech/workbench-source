// Shared bits for workbench node videos: beats, title card, header tag, step bar, end card, role people, small icons.
// Built on the tutorial kit (lib/tut.js) used by 《开店全流程 · 员工操作教程》 and its 专项补充 shorts.
import * as T from './tut.js';
export * from './tut.js';
const { C, W, H, E, ease, lerp, clamp, ink, line, rrect, circle, seg, rgba, zt, zw, withA, marker, pop } = T;

let BENCH_NAME = '外部客服工作台 V3';
export function setBenchName(name) { BENCH_NAME = name; }

// extra roles across all 5 workbenches (the kit's roleChip reads ROLE)
Object.assign(T.ROLE, {
  销售: { name: '销售（我们）', color: C.teal }, 外包: { name: '外包客服', color: '#9AA3AE' }, 主管: { name: '主管', color: C.coral },
  仓管: { name: '仓管', color: C.mustard }, 买家: { name: '买家', color: '#8DBB7A' }, 智能体: { name: '智能体 / 机器人', color: C.lav }, 同事: { name: '在岗同事', color: '#7FB3C8' },
  采购: { name: '采购', color: C.teal }, 质检: { name: '质检', color: C.mustard }, 财务: { name: '财务', color: C.coral }, 行政: { name: '行政', color: '#7FB3C8' }, 老板: { name: '老板', color: C.coral }, 客服: { name: '客服', color: C.teal },
});

export function mkBeats(LINES, MARKS) {
  return {
    L: (id, d = 0) => LINES[id].at + d,
    Le: (id, d = 0) => LINES[id].end + d,
    M: (id, i, d = 0) => (MARKS[id][i] ?? MARKS[id][MARKS[id].length - 1]) + d,
  };
}
export const span = (t, a, b, fi = 0.4, fo = 0.35) => T.vis(t, a, b, fi, fo);

// opening card: kicker + big title + sub line
export function titleCard(ctx, t, t0, t1, o) {
  const a = T.vis(t, t0, t1, 0.45, 0.5); if (a <= 0) return;
  withA(ctx, a, () => {
    const k = E(t, t0, t0 + 0.6, ease.outBack);
    pop(ctx, W / 2, 380, k, () => {
      const w = Math.max(zw(ctx, o.title, 104, 'hand'), 820) + 180;
      ink(ctx, rrect(W / 2 - w / 2 + 10, 200 + 14, w, 360, 30), { fill: 'rgba(30,20,15,0.22)', stroke: null, amp: 0 });
      ink(ctx, rrect(W / 2 - w / 2, 200, w, 360, 30), { fill: C.cream, lw: 6, seed: 4100 });
      T.tape(ctx, W / 2 - w / 2 + 70, 202, -0.4, 140); T.tape(ctx, W / 2 + w / 2 - 70, 202, 0.4, 140);
      zt(ctx, o.kicker || `${o.bench || BENCH_NAME} · 节点教程`, W / 2, 272, { size: 46, font: 'hand', color: T.PEN });
      const tw = zw(ctx, o.title, 104, 'hand');
      marker(ctx, W / 2 - tw / 2, 392, tw, 44, E(t, t0 + 0.5, t0 + 1.1), 11);
      zt(ctx, o.title, W / 2, 375, { size: 104, font: 'hand' });
      if (o.sub) zt(ctx, o.sub, W / 2, 482, { size: 38, color: C.ink2 });
    });
    if (o.node) withA(ctx, E(t, t0 + 0.6, t0 + 1.1), () => T.chip(ctx, W / 2, 640, o.node, { size: 26, fill: '#fff', stroke: rgba(C.ink, 0.5), font: 'mono' }));
    if (o.draw) o.draw(k);
  });
}
// small tag top-left for the rest of the video
export function header(ctx, t, t0, title, bench = BENCH_NAME) {
  const a = E(t, t0, t0 + 0.5); if (a <= 0) return;
  withA(ctx, a, () => {
    const s = `${bench} · ${title}`, w = zw(ctx, s, 32, 'hand') + 44;
    ink(ctx, rrect(36, 26, w, 58, 16), { fill: C.cream, lw: 3.5, seed: 4110 });
    zt(ctx, s, 58, 56, { size: 32, font: 'hand', align: 'left' });
  });
}
// top-right progress chips. steps = [[label, tStart]], shows from first start
export function stepBar(ctx, t, steps, o = {}) {
  let cur = -1; steps.forEach(([, ts], i) => { if (t >= ts) cur = i; });
  if (cur < 0) return;
  const gap = o.gap || 136, x0 = W - 110 - (steps.length - 1) * gap;
  steps.forEach(([s], i) => {
    const x = x0 + i * gap, on = i === cur, done = i < cur, w = Math.max(zw(ctx, `${i + 1} ${s}`, 28, 'hand') + 28, 112);
    ink(ctx, rrect(x - w / 2, 30, w, 52, 26), { fill: on ? T.PEN : done ? rgba(C.teal, 0.35) : C.cream, stroke: C.ink, lw: on ? 4 : 3, seed: 4200 + i });
    zt(ctx, `${i + 1} ${s}`, x, 57, { size: 28, font: 'hand', color: on ? '#fff' : C.ink });
  });
}
export function endCard(ctx, t, t0, title, lines, o = {}) {
  const a = E(t, t0, t0 + 0.6); if (a <= 0) return;
  withA(ctx, a, () => {
    T.title(ctx, title, W / 2, 330, { size: 96 });
    lines.forEach((s, i) => zt(ctx, s, W / 2, 470 + i * 64, { size: 36, color: C.ink2 }));
    if (o.node) T.chip(ctx, W / 2, 470 + lines.length * 64 + 50, o.node, { size: 24, fill: '#fff', stroke: rgba(C.ink, 0.45), font: 'mono' });
  });
}

// a person with a role label under the feet. (x,y) = feet
const RC = {
  销售: C.teal, 外包: '#9AA3AE', 主管: C.coral, 仓管: C.mustard, 买家: '#8DBB7A', 同事: '#7FB3C8',
  采购: C.teal, 质检: C.mustard, 财务: C.coral, 行政: '#7FB3C8', 老板: C.coral, 客服: C.teal,
};
export function who(ctx, x, y, role, a = 1, o = {}) {
  if (a <= 0) return;
  pop(ctx, x, y - 60, a, () => {
    T.person(ctx, x, y, { s: o.s ?? 1.6, color: o.color || RC[role] || C.slate, id: o.id ?? role.length, facing: o.facing ?? 1, arm: o.arm, prop: o.prop });
    const lab = o.label || role, w = zw(ctx, lab, 36, 'hand') + 40;
    ink(ctx, rrect(x - w / 2, y + 20, w, 56, 12), { fill: '#FFFDF6', lw: 3, seed: 4300 + lab.length });
    zt(ctx, lab, x, y + 49, { size: 36, font: 'hand' });
  });
}
// the agent: a small terminal window labelled 智能体 (no creature, just a tool). (x,y) centre
export function agentBox(ctx, x, y, a = 1, o = {}) {
  if (a <= 0) return;
  pop(ctx, x, y, a, () => {
    const w = o.w || 200, h = o.h || 140;
    ink(ctx, rrect(x - w / 2 + 7, y - h / 2 + 9, w, h, 14), { fill: 'rgba(40,28,20,0.18)', stroke: null, amp: 0 });
    ink(ctx, rrect(x - w / 2, y - h / 2, w, h, 14), { fill: '#2F2A3A', lw: 4, seed: 4400 });
    [C.coral, C.mustard, C.sage].forEach((col, i) => ink(ctx, circle(x - w / 2 + 22 + i * 20, y - h / 2 + 18, 6, 10), { fill: col, lw: 2, seed: 4401 + i }));
    zt(ctx, o.code || '> _', x - w / 2 + 22, y - 6, { size: 28, font: 'mono', align: 'left', color: '#B9F3C9' });
    zt(ctx, o.state || '', x - w / 2 + 22, y + 34, { size: 22, font: 'mono', align: 'left', color: o.stateColor || '#E8E2F8' });
    const lab = o.label || '智能体', lw2 = zw(ctx, lab, 30, 'hand') + 34;
    ink(ctx, rrect(x - lw2 / 2, y + h / 2 + 14, lw2, 48, 12), { fill: '#FFFDF6', lw: 3, seed: 4410 });
    zt(ctx, lab, x, y + h / 2 + 39, { size: 30, font: 'hand' });
  });
}
// a speech bubble with text (centre x, top y)
export function say(ctx, s, x, y, a = 1, o = {}) {
  if (a <= 0) return;
  const size = o.size || 32, ls = T.wrapZh(ctx, s, size, (o.w || 420) - 40), w = o.w || Math.min(420, Math.max(...ls.map((l) => zw(ctx, l, size))) + 50), h = ls.length * size * 1.35 + 34;
  pop(ctx, x, y + h / 2, a, () => {
    ink(ctx, rrect(x - w / 2 + 6, y + 8, w, h, 22), { fill: 'rgba(40,28,20,0.16)', stroke: null, amp: 0 });
    ink(ctx, rrect(x - w / 2, y, w, h, 22), { fill: o.fill || '#FFFFFF', stroke: o.stroke || C.ink, lw: 3.5, seed: 4500 + s.length });
    const tx = o.tail === 'right' ? x + w / 2 - 50 : x - w / 2 + 50;
    ink(ctx, T.poly([[tx - 14, y + h - 2], [tx + 14, y + h - 2], [tx + (o.tail === 'right' ? 26 : -26), y + h + 26]], 6), { fill: o.fill || '#FFFFFF', stroke: o.stroke || C.ink, lw: 3.5, seed: 4501 });
    ink(ctx, rrect(tx - 16, y + h - 8, 32, 10, 2), { fill: o.fill || '#FFFFFF', stroke: null, amp: 0 });
    ls.forEach((l, i) => zt(ctx, l, x, y + 17 + size * 0.68 + i * size * 1.35, { size, color: C.ink }));
  });
}
// big round clock face showing hh:mm (for deadlines). (x,y) centre
export function clock(ctx, x, y, r, hh, mm, a = 1, o = {}) {
  if (a <= 0) return;
  pop(ctx, x, y, a, () => {
    ink(ctx, circle(x + 6, y + 8, r, 40), { fill: 'rgba(40,28,20,0.16)', stroke: null, amp: 0 });
    ink(ctx, circle(x, y, r, 40), { fill: o.fill || '#FFFDF6', lw: 5, seed: 4600 });
    for (let i = 0; i < 12; i++) { const an = (i / 12) * Math.PI * 2; line(ctx, seg(x + Math.sin(an) * r * 0.82, y - Math.cos(an) * r * 0.82, x + Math.sin(an) * r * 0.92, y - Math.cos(an) * r * 0.92, 4), { lw: 3 }); }
    const ah = ((hh % 12) + mm / 60) / 12 * Math.PI * 2, am = mm / 60 * Math.PI * 2;
    line(ctx, seg(x, y, x + Math.sin(ah) * r * 0.5, y - Math.cos(ah) * r * 0.5, 6), { lw: 7 });
    line(ctx, seg(x, y, x + Math.sin(am) * r * 0.75, y - Math.cos(am) * r * 0.75, 6), { lw: 5, stroke: o.hand || T.PEN });
    T.dot(ctx, x, y, 7, C.ink);
    if (o.label) zt(ctx, o.label, x, y + r + 40, { size: o.lsize || 40, font: 'hand', color: o.lcolor || C.ink });
  });
}
// a coloured status dot + label row (for red/yellow/green legends)
export function light(ctx, x, y, color, label, sub, a = 1, o = {}) {
  if (a <= 0) return;
  pop(ctx, x, y, a, () => {
    ink(ctx, circle(x, y, o.r || 40, 30), { fill: color, lw: 4, seed: 4700 + label.length });
    zt(ctx, label, x + (o.r || 40) + 30, y - (sub ? 18 : 0), { size: o.size || 52, font: 'hand', align: 'left' });
    if (sub) zt(ctx, sub, x + (o.r || 40) + 30, y + 34, { size: 32, color: C.ink2, align: 'left' });
  });
}
export const RED = '#E0655A', YEL = '#F2C14E', GRN = '#8DBB7A';
// a mini order/product card drawn by hand (for logic scenes). (x,y) top-left
export function miniCard(ctx, x, y, w, h, title, rows, a = 1, o = {}) {
  if (a <= 0) return;
  pop(ctx, x + w / 2, y + h / 2, a, () => {
    ink(ctx, rrect(x + 7, y + 9, w, h, 16), { fill: 'rgba(40,28,20,0.16)', stroke: null, amp: 0 });
    ink(ctx, rrect(x, y, w, h, 16), { fill: o.fill || '#FFFDF6', stroke: o.stroke || C.ink, lw: 4, seed: o.seed || 4800 });
    zt(ctx, title, x + 26, y + 44, { size: o.tsize || 36, font: 'hand', align: 'left', color: o.tcolor || C.ink });
    rows.forEach((r, i) => zt(ctx, r, x + 26, y + 96 + i * 46, { size: o.size || 28, align: 'left', color: C.ink2, font: o.mono && i === o.mono ? 'mono' : 'zh' }));
  });
}
// demo-data marker chip
export const demoTag = (ctx, x, y, a = 1, s = '演示数据') => T.chip(ctx, x, y, s, { a, size: 24, fill: '#FFE98A', stroke: T.PEN });
// union of focus boxes (any index, incl. ≥10) of a registered screenshot, in image px — usable wherever walk() takes a focus
export function U(id, ...idx) {
  const s = T.SH(id); if (!s) return null;
  const bs = idx.map((i) => s.focus[i]).filter(Boolean);
  const x0 = Math.min(...bs.map((b) => b[0])), y0 = Math.min(...bs.map((b) => b[1])), x1 = Math.max(...bs.map((b) => b[0] + b[2])), y1 = Math.max(...bs.map((b) => b[1] + b[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

// Tutorial kit for 《开店全流程 · 员工操作教程》: real screenshots inside hand-drawn device frames,
// pen annotations on top (rings, arrows, numbers, highlighter, magnifier), notes cards, chapter cards, flow diagrams.
import * as Z from './zh.js';
export * from './zh.js';
const { C, W, H, G, ink, line, rrect, circle, ellipse, poly, seg, rgba, lerp, clamp, prog, E, ease, zt, zw, marker, paper, rng, dot } = Z;

export const PEN = '#D2463C', HLY = '#FFD84D', BLUE = '#3E6FB0';
export const ROLE = {
  统筹: { name: '统筹负责人', color: C.coral },
  员工: { name: '执行员工', color: C.teal },
  技术: { name: '技术负责人', color: C.lav },
  程序: { name: '程序员', color: C.mustard },
  授权: { name: '授权人 / 法人', color: '#8DBB7A' },
  供应商: { name: '外部供应商', color: '#9AA3AE' },
};

// ---------- assets ----------
const REG = new Map();
export function img(name) {
  if (!REG.has(name)) { const im = new Image(); im.src = new URL(`../assets/${name}`, import.meta.url).href; REG.set(name, im); }
  return REG.get(name);
}
export async function loadAll() {
  await Promise.all([...REG.values()].map((im) => im.decode().catch(() => console.error('IMG FAIL ' + im.src))));
}

// ---------- time helpers ----------
// visibility of a block living in [t0,t1] with fade in/out
export const vis = (t, t0, t1, fi = 0.35, fo = 0.35) => (t < t0 || t > t1 ? 0 : Math.min(prog(t, t0, t0 + fi), 1 - prog(t, t1 - fo, t1)));
export function withA(ctx, a, fn) { if (a <= 0.001) return; ctx.save(); ctx.globalAlpha *= clamp(a); fn(); ctx.restore(); }
export function pop(ctx, x, y, k, fn) { if (k <= 0.001) return; const s = lerp(0.6, 1, ease.outBack(clamp(k))); ctx.save(); ctx.globalAlpha *= clamp(k * 1.6); ctx.translate(x, y); ctx.scale(s, s); ctx.translate(-x, -y); fn(); ctx.restore(); }

// ---------- background ----------
let DESK = null;
export function desk(ctx) {
  if (!DESK) {
    DESK = document.createElement('canvas'); DESK.width = W; DESK.height = H;
    const x = DESK.getContext('2d'); paper(x);
    x.fillStyle = 'rgba(90,110,150,0.13)';
    for (let yy = 30; yy < H; yy += 40) for (let xx = 30; xx < W; xx += 40) { x.beginPath(); x.arc(xx, yy, 1.5, 0, 7); x.fill(); }
  }
  ctx.drawImage(DESK, 0, 0);
}

// ---------- text ----------
export function wrapZh(ctx, s, size, maxW, font = 'zh') {
  const f = { zh: Z.F.zh, hand: Z.F.zhHand }[font] || Z.F.zh;
  ctx.save(); ctx.font = `${font === 'zh' ? 500 : 400} ${size}px ${f}`;
  const out = []; let cur = '';
  for (const part of s.split('\n')) {
    cur = '';
    for (const ch of part) {
      if (ctx.measureText(cur + ch).width > maxW && cur) {
        if (/[，。、；：！？）」』”]/.test(ch)) { cur += ch; out.push(cur); cur = ''; continue; }
        out.push(cur); cur = ch;
      } else cur += ch;
    }
    if (cur) out.push(cur);
  }
  ctx.restore(); return out;
}
// multi-line text block, returns height used
export function para(ctx, s, x, y, maxW, o = {}) {
  const size = o.size || 36, lh = o.lh || size * 1.38;
  const ls = wrapZh(ctx, s, size, maxW, o.font || 'zh');
  ls.forEach((l, i) => zt(ctx, l, o.align === 'center' ? x : x, y + i * lh, { size, color: o.color || C.ink, align: o.align || 'left', font: o.font || 'zh', alpha: o.alpha ?? 1, bold: o.bold }));
  return ls.length * lh;
}

// ---------- pen marks ----------
// a pen ring drawn around a box (canvas coords), p = 0..1 drawing progress
export function penRing(ctx, b, p, o = {}) {
  if (p <= 0) return;
  const [x, y, w, h] = b, pad = o.pad ?? 14;
  const cx = x + w / 2, cy = y + h / 2, rx = w / 2 + pad + Math.min(30, w * 0.08), ry = h / 2 + pad + Math.min(18, h * 0.12);
  const turns = 1.1, a0 = o.a0 ?? -2.5, n = 64, m = Math.max(2, Math.round(n * turns * clamp(p)));
  const pts = [];
  for (let i = 0; i <= m; i++) {
    const u = i / n, a = a0 + u * Math.PI * 2, d = 1 + 0.06 * Math.sin(u * 5.3 + (o.seed || 0)) + 0.05 * u;
    pts.push([cx + Math.cos(a) * rx * d, cy + Math.sin(a) * ry * d]);
  }
  line(ctx, pts, { lw: o.lw || 6, stroke: o.color || PEN, amp: 0.8, seed: o.seed || 7 });
}
// a pen arrow from (x1,y1) to (x2,y2), bent by `bend` px; p = drawing progress
export function penArrow(ctx, x1, y1, x2, y2, p, o = {}) {
  if (p <= 0) return;
  const bend = o.bend ?? 60, mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy) || 1;
  const qx = mx - (dy / L) * bend, qy = my + (dx / L) * bend;
  const k = clamp(p), n = 24, pts = [];
  for (let i = 0; i <= Math.round(n * k); i++) { const u = i / n; pts.push([(1 - u) * (1 - u) * x1 + 2 * (1 - u) * u * qx + u * u * x2, (1 - u) * (1 - u) * y1 + 2 * (1 - u) * u * qy + u * u * y2]); }
  if (pts.length < 2) return;
  const col = o.color || PEN, lw = o.lw || 6;
  line(ctx, pts, { lw, stroke: col, amp: 0.6, seed: o.seed || 3 });
  if (k > 0.92) {
    const [ax, ay] = pts[pts.length - 2], [bx, by] = pts[pts.length - 1], ang = Math.atan2(by - ay, bx - ax), hl = o.head || 26;
    line(ctx, [[bx - Math.cos(ang - 0.45) * hl, by - Math.sin(ang - 0.45) * hl], [bx, by], [bx - Math.cos(ang + 0.45) * hl, by - Math.sin(ang + 0.45) * hl]], { lw, stroke: col, amp: 0.4, seed: (o.seed || 3) + 1 });
  }
}
// highlighter swipe over a box
export function penHL(ctx, b, p, o = {}) {
  if (p <= 0) return;
  const [x, y, w, h] = b, k = clamp(p);
  ctx.save(); ctx.globalCompositeOperation = 'multiply';
  ink(ctx, poly([[x - 6, y + 2], [x - 6 + (w + 12) * k, y - 2], [x - 4 + (w + 12) * k, y + h + 2], [x - 4, y + h + 4]], 10), { fill: rgba(o.color || HLY, o.alpha ?? 0.55), stroke: null, amp: 1.4, seed: o.seed || 5 });
  ctx.restore();
}
// numbered pen badge
export function penNum(ctx, x, y, n, a = 1, o = {}) {
  if (a <= 0) return;
  pop(ctx, x, y, a, () => {
    ink(ctx, circle(x, y, o.r || 26, 22), { fill: o.fill || PEN, stroke: C.ink, lw: 3.5, seed: 40 + n });
    zt(ctx, String(n), x, y + 2, { size: (o.r || 26) * 1.25, color: '#fff', font: 'hand' });
  });
}
// hand-lettered label with marker swash, left-aligned at (x,y)
export function penLabel(ctx, s, x, y, a = 1, o = {}) {
  if (a <= 0) return;
  const size = o.size || 40, w = zw(ctx, s, size, 'hand');
  withA(ctx, a, () => {
    const lx = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x;
    if (o.box) {
      ink(ctx, rrect(lx - 18 + 5, y - size * 0.75 + 7, w + 36, size * 1.5, 14), { fill: 'rgba(30,20,15,0.18)', stroke: null, amp: 0 });
      ink(ctx, rrect(lx - 18, y - size * 0.75, w + 36, size * 1.5, 14), { fill: o.fill || C.cream, stroke: o.stroke || C.ink, lw: 3.5, seed: o.seed || 60 });
    } else if (o.mark !== false) marker(ctx, lx, y + size * 0.2, w, size * 0.45, 1, o.seed || 2, o.mcolor || C.amber);
    zt(ctx, s, lx, y, { size, font: 'hand', align: 'left', color: o.color || C.ink });
  });
}

// ---------- screenshot frames ----------
// view helpers: a view is a source rect [sx, sy, sw, sh] in image pixels
export function fitView(im, cw, ch, mode = 'width', sy = 0) {
  const iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height;
  if (mode === 'all') return [0, 0, iw, ih];
  const sh = Math.min(ih, iw * ch / cw);
  return [0, clamp(sy, 0, ih - sh), iw, sh];
}
// zoomed view centred on box b (image px) with the content aspect cw:ch; zoom so box fits with `pad` (fraction)
export function focusView(im, b, cw, ch, pad = 0.6, minW = 0) {
  const iw = im.naturalWidth || im.width, ih = im.naturalHeight || im.height;
  let sw = Math.max(b[2] * (1 + pad), b[3] * (1 + pad) * cw / ch, minW), sh = sw * ch / cw;
  if (sw > iw) { sw = iw; sh = sw * ch / cw; }
  if (sh > ih) { sh = ih; sw = sh * cw / ch; }
  const sx = clamp(b[0] + b[2] / 2 - sw / 2, 0, iw - sw), sy = clamp(b[1] + b[3] / 2 - sh / 2, 0, ih - sh);
  return [sx, sy, sw, sh];
}
export const lerpView = (a, b, k) => a.map((v, i) => lerp(v, b[i], k));
// keyframed view: keys = [[t, view], ...] eased between consecutive keys over `d` seconds before each key
export function viewAt(t, keys, d = 0.8) {
  let v = keys[0][1];
  for (let i = 1; i < keys.length; i++) { const [tk, vk] = keys[i]; v = lerpView(v, vk, E(t, tk - d, tk)); }
  return v;
}

const PIX = new Map();
function pixelated(im, b) {
  const key = im.src + b.join(',');
  if (!PIX.has(key)) {
    const c = document.createElement('canvas'); c.width = Math.max(2, Math.round(b[2] / 14)); c.height = Math.max(2, Math.round(b[3] / 14));
    const x = c.getContext('2d'); x.imageSmoothingEnabled = true; x.drawImage(im, b[0], b[1], b[2], b[3], 0, 0, c.width, c.height);
    PIX.set(key, c);
  }
  return PIX.get(key);
}

// Draw a screenshot in a hand-drawn frame. o: { im, kind: 'phone'|'web'|'app'|'photo', x, y, w, h (outer rect),
//   view (source rect, default fit width), url, title, rot, masks: [[x,y,w,h] image px], tilt }
// returns a mapper { map(ix,iy) -> [cx,cy], box(b) -> canvas rect, s, clip: [x,y,w,h], view } in the frame's local (unrotated) coords;
// pass `draw(ctx, M)` to paint annotations in the same transform.
export function shot(ctx, o, draw) {
  const { im, kind = 'web' } = o;
  let { x, y, w, h } = o;
  ctx.save();
  if (o.rot) { ctx.translate(x + w / 2, y + h / 2); ctx.rotate(o.rot); ctx.translate(-x - w / 2, -y - h / 2); }
  // drop shadow
  ink(ctx, rrect(x + 10, y + 14, w, h, kind === 'phone' ? 46 : 16), { fill: 'rgba(40,28,20,0.22)', stroke: null, amp: 0 });
  let cx, cy, cw, ch;
  if (kind === 'phone') {
    ink(ctx, rrect(x, y, w, h, 46), { fill: '#2B2522', lw: 5, seed: 190 });
    const bz = 14; cx = x + bz; cy = y + bz; cw = w - bz * 2; ch = h - bz * 2;
  } else if (kind === 'photo') {
    ink(ctx, rrect(x, y, w, h, 6), { fill: '#FFFDF7', lw: 3.5, seed: 191 });
    const bz = 16; cx = x + bz; cy = y + bz; cw = w - bz * 2; ch = h - bz * 2;
  } else {
    const bar = kind === 'web' ? 92 : 50;
    ink(ctx, rrect(x, y, w, h, 16), { fill: '#E6E1D6', lw: 5, seed: 192 });
    [C.coral, C.mustard, C.sage].forEach((col, i) => ink(ctx, circle(x + 30 + i * 28, y + 25, 9, 12), { fill: col, lw: 2.5, seed: 193 + i }));
    if (kind === 'web') {
      ink(ctx, rrect(x + 120, y + 8, Math.min(380, w * 0.4), 36, 10), { fill: '#FBF8F1', lw: 2.5, seed: 197 });
      if (o.title) zt(ctx, o.title, x + 138, y + 27, { size: 20, align: 'left', color: C.ink2, bold: false });
      ink(ctx, rrect(x + 16, y + 50, w - 32, 34, 17), { fill: '#FFFFFF', lw: 2.5, seed: 198 });
      if (o.url) zt(ctx, o.url, x + 40, y + 68, { size: 20, align: 'left', font: 'mono', color: C.ink2, bold: false });
    } else if (o.title) zt(ctx, o.title, x + 130, y + 26, { size: 24, align: 'left', color: C.ink, bold: false });
    cx = x + 10; cy = y + bar; cw = w - 20; ch = h - bar - 10;
  }
  // content
  const v = o.view || fitView(im, cw, ch, o.fit || 'width', o.sy || 0);
  const s = Math.min(cw / v[2], ch / v[3]);
  const dw = v[2] * s, dh = v[3] * s, dx = cx + (cw - dw) / 2, dy = o.top === false ? cy + (ch - dh) / 2 : cy;
  ctx.save();
  ctx.beginPath(); if (kind === 'phone') ctx.roundRect(cx, cy, cw, ch, 34); else ctx.rect(cx, cy, cw, ch); ctx.clip();
  ctx.fillStyle = o.bg || '#FFFFFF'; ctx.fillRect(cx, cy, cw, ch);
  ctx.imageSmoothingQuality = 'high';
  if (im.complete && im.naturalWidth) ctx.drawImage(im, v[0], v[1], v[2], v[3], dx, dy, dw, dh);
  const M = { s, view: v, clip: [cx, cy, cw, ch], map: (ix, iy) => [dx + (ix - v[0]) * s, dy + (iy - v[1]) * s] };
  M.box = (b) => { const [a, c] = M.map(b[0], b[1]); return [a, c, b[2] * s, b[3] * s]; };
  for (const m of o.masks || []) {
    const [mx, my, mw, mh] = M.box(m), pc = pixelated(im, m);
    ctx.save(); ctx.imageSmoothingEnabled = false; ctx.drawImage(pc, mx, my, mw, mh); ctx.restore();
  }
  if (o.dim) { ctx.fillStyle = `rgba(239,235,227,${o.dim})`; ctx.fillRect(cx, cy, cw, ch); }
  ctx.restore();
  if (kind === 'phone') ink(ctx, rrect(cx, cy, cw, ch, 34), { stroke: C.ink, lw: 3, seed: 199 });
  else ink(ctx, rrect(cx, cy, cw, ch, 4), { stroke: rgba(C.ink, 0.55), lw: 2, seed: 199, amp: 0.5 });
  if (o.tape) tape(ctx, x + w / 2, y - 6, -0.04);
  if (draw) draw(ctx, M);
  ctx.restore();
  return M;
}
export function tape(ctx, x, y, rot = 0, w = 150) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
  ink(ctx, rrect(-w / 2, -18, w, 36, 3), { fill: 'rgba(240,226,180,0.78)', stroke: rgba(C.ink, 0.25), lw: 1.5, seed: 77, amp: 0.8 });
  ctx.restore();
}

// magnifier: shows image region around box b (image px) enlarged in a circle at (lx,ly), radius r; connector from the box
export function lens(ctx, M, im, b, lx, ly, r, a = 1, o = {}) {
  if (a <= 0) return;
  const side = Math.max(b[2], b[3]) * (o.pad ?? 1.35), sx = b[0] + b[2] / 2 - side / 2, sy = b[1] + b[3] / 2 - side / 2;
  const [bx, by, bw, bh] = M.box(b), bcx = bx + bw / 2, bcy = by + bh / 2;
  withA(ctx, a, () => {
    const ang = Math.atan2(ly - bcy, lx - bcx);
    Z.dashed(ctx, [[bcx + Math.cos(ang) * Math.max(bw, bh) * 0.6, bcy + Math.sin(ang) * Math.max(bw, bh) * 0.6], [lx - Math.cos(ang) * r, ly - Math.sin(ang) * r]], { lw: 4, color: PEN, dash: 14, gap: 10, p: clamp(a * 1.5) });
    const k = ease.outBack(clamp(a)), rr = r * k;
    ctx.save(); ctx.beginPath(); ctx.arc(lx, ly, rr, 0, 7); ctx.clip();
    ctx.fillStyle = '#fff'; ctx.fillRect(lx - rr, ly - rr, rr * 2, rr * 2);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(im, sx, sy, side, side, lx - rr, ly - rr, rr * 2, rr * 2);
    ctx.restore();
    ink(ctx, circle(lx, ly, rr, 40), { stroke: C.ink, lw: 7, seed: 81 });
    ink(ctx, circle(lx, ly, rr - 7, 40), { stroke: rgba('#ffffff', 0.7), lw: 3, seed: 82, amp: 0.5 });
    if (o.ring) penRing(ctx, [lx - rr * 0.45, ly - rr * 0.32, rr * 0.9, rr * 0.64], clamp((a - 0.6) * 2.5), { pad: 4 });
  });
}

// ---------- cards ----------
// notes card with numbered steps. items: [{s, role?}], cur: index of current step (-1 none); done: count ticked
export function notes(ctx, x, y, w, items, cur, o = {}) {
  const a = o.a ?? 1; if (a <= 0) return;
  const size = o.size || 34, lh = size * 1.32, pad = 30;
  const wrapped = items.map((it) => wrapZh(ctx, it.s || it, size, w - pad * 2 - 56 - (it.role ? 175 : 0)));
  const head = o.title ? 74 : 20;
  const h = head + wrapped.reduce((s, l) => s + l.length * lh + 18, 0) + 20;
  withA(ctx, a, () => {
    ctx.save(); ctx.translate(x, y); ctx.rotate(o.rot ?? 0.012);
    ink(ctx, rrect(8, 12, w, h, 12), { fill: 'rgba(40,28,20,0.18)', stroke: null, amp: 0 });
    ink(ctx, rrect(0, 0, w, h, 12), { fill: '#FFFBF0', lw: 4, seed: 501 });
    for (let yy = head + 4; yy < h - 10; yy += lh) line(ctx, seg(20, yy + lh - 8, w - 20, yy + lh - 8, 30), { lw: 1.2, stroke: 'rgba(80,120,170,0.18)', amp: 0.3 });
    tape(ctx, w / 2, -4, 0.03, 130);
    if (o.title) zt(ctx, o.title, pad, 44, { size: 40, font: 'hand', align: 'left', color: o.tcolor || C.ink });
    let yy = head + 6;
    wrapped.forEach((ls, i) => {
      const isCur = i === cur, isDone = i < (o.done ?? cur);
      const ia = o.reveal != null ? clamp(o.reveal - i) : 1;
      if (ia <= 0) { yy += ls.length * lh + 18; return; }
      withA(ctx, ia, () => {
        if (isCur) marker(ctx, pad + 54, yy + lh * 0.55, Math.min(w - pad * 2 - 56, Math.max(...ls.map((l) => zw(ctx, l, size)))), lh * 0.62 * ls.length + (ls.length - 1) * lh * 0.38, 1, 9 + i);
        ink(ctx, circle(pad + 20, yy + lh / 2, 20, 18), { fill: isCur ? PEN : isDone ? C.sage : C.cream, stroke: C.ink, lw: 3, seed: 510 + i });
        zt(ctx, String(i + 1), pad + 20, yy + lh / 2 + 2, { size: 26, font: 'hand', color: isCur || isDone ? '#fff' : C.ink });
        ls.forEach((l, j) => zt(ctx, l, pad + 54, yy + lh / 2 + j * lh, { size, align: 'left', color: isCur ? C.ink : isDone ? C.ink2 : C.ink }));
        if (items[i].role) roleChip(ctx, w - pad - 8, yy + lh / 2, items[i].role, 1, { align: 'right', size: 22 });
      });
      yy += ls.length * lh + 18;
    });
    ctx.restore();
  });
  return h;
}
// yellow sticky note with a header word (e.g. 注意) and body text
export function sticky(ctx, x, y, w, body, a = 1, o = {}) {
  if (a <= 0) return;
  const size = o.size || 34, ls = wrapZh(ctx, body, size, w - 50), h = (o.head === false ? 30 : 86) + ls.length * size * 1.35 + 24;
  pop(ctx, x + w / 2, y + h / 2, a, () => {
    ctx.save(); ctx.translate(x + w / 2, y + h / 2); ctx.rotate(o.rot ?? -0.025); ctx.translate(-w / 2, -h / 2);
    ink(ctx, rrect(8, 12, w, h, 6), { fill: 'rgba(40,28,20,0.2)', stroke: null, amp: 0 });
    ink(ctx, rrect(0, 0, w, h, 6), { fill: o.fill || '#FFE98A', lw: 3.5, seed: 520 });
    tape(ctx, w / 2, 0, -0.05, 110);
    let yy = 30;
    if (o.head !== false) { zt(ctx, o.head || '注意', 26, 52, { size: 44, font: 'hand', align: 'left', color: o.hcolor || PEN }); yy = 92; }
    ls.forEach((l, i) => zt(ctx, l, 26, yy + i * size * 1.35 + size * 0.5, { size, align: 'left' }));
    ctx.restore();
  });
}
// role chip (person dot + role name)
export function roleChip(ctx, x, y, role, a = 1, o = {}) {
  if (a <= 0) return;
  const R = ROLE[role] || { name: role, color: C.slate }, size = o.size || 26, w = zw(ctx, R.name, size) + 54, h = size + 18;
  const lx = o.align === 'right' ? x - w : o.align === 'center' ? x - w / 2 : x;
  withA(ctx, a, () => {
    ink(ctx, rrect(lx, y - h / 2, w, h, h / 2), { fill: rgba(R.color, 0.28), stroke: R.color, lw: 3, seed: 530 + R.name.length });
    ink(ctx, circle(lx + h / 2 + 2, y - 4, 7, 10), { fill: R.color, stroke: C.ink, lw: 2 });
    ink(ctx, rrect(lx + h / 2 - 9, y + 3, 22, 10, 5), { fill: R.color, stroke: C.ink, lw: 2 });
    zt(ctx, R.name, lx + h + 6, y + 1, { size, align: 'left', color: C.ink });
  });
}

// ---------- diagram atoms ----------
// box with wrapped text, centre (x,y)
export function node(ctx, x, y, w, h, s, o = {}) {
  const a = o.a ?? 1; if (a <= 0) return;
  pop(ctx, x, y, o.popK ?? a, () => {
    if (o.shadow !== false) ink(ctx, rrect(x - w / 2 + 7, y - h / 2 + 9, w, h, o.r ?? 18), { fill: 'rgba(40,28,20,0.18)', stroke: null, amp: 0 });
    ink(ctx, rrect(x - w / 2, y - h / 2, w, h, o.r ?? 18), { fill: o.fill || C.cream, stroke: o.stroke || C.ink, lw: o.lw || 4, seed: o.seed || 600, hatch: o.hatch });
    const size = o.size || 34, ls = wrapZh(ctx, s, size, w - 36, o.font || 'zh'), lh = size * 1.3;
    ls.forEach((l, i) => zt(ctx, l, x, y - ((ls.length - 1) * lh) / 2 + i * lh, { size, color: o.color || C.ink, font: o.font || 'zh' }));
  });
}
export function diamond(ctx, x, y, w, h, s, o = {}) {
  const a = o.a ?? 1; if (a <= 0) return;
  pop(ctx, x, y, a, () => {
    ink(ctx, poly([[x + 7, y - h / 2 + 9], [x + w / 2 + 7, y + 9], [x + 7, y + h / 2 + 9], [x - w / 2 + 7, y + 9]], 14), { fill: 'rgba(40,28,20,0.18)', stroke: null, amp: 0 });
    ink(ctx, poly([[x, y - h / 2], [x + w / 2, y], [x, y + h / 2], [x - w / 2, y]], 14), { fill: o.fill || '#FFE3A8', lw: 4, seed: o.seed || 610 });
    const size = o.size || 32, ls = wrapZh(ctx, s, size, w * 0.62), lh = size * 1.25;
    ls.forEach((l, i) => zt(ctx, l, x, y - ((ls.length - 1) * lh) / 2 + i * lh, { size }));
  });
}
// polyline arrow with progress + optional label at the middle
export function arrow(ctx, pts, p = 1, o = {}) {
  if (p <= 0) return;
  let total = 0; const L = [];
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); L.push(d); total += d; }
  let rem = total * clamp(p); const out = [pts[0]];
  for (let i = 1; i < pts.length && rem > 0; i++) { const k = Math.min(1, rem / L[i - 1]); out.push([lerp(pts[i - 1][0], pts[i][0], k), lerp(pts[i - 1][1], pts[i][1], k)]); rem -= L[i - 1]; }
  const col = o.color || C.ink, lw = o.lw || 4.5;
  if (o.dash) Z.dashed(ctx, out, { lw, color: col }); else line(ctx, out, { lw, stroke: col, amp: 0.7, seed: o.seed || 620 });
  if (p > 0.97 && o.head !== false) {
    const [ax, ay] = out[out.length - 2], [bx, by] = out[out.length - 1], ang = Math.atan2(by - ay, bx - ax), hl = o.hl || 20;
    line(ctx, [[bx - Math.cos(ang - 0.5) * hl, by - Math.sin(ang - 0.5) * hl], [bx, by], [bx - Math.cos(ang + 0.5) * hl, by - Math.sin(ang + 0.5) * hl]], { lw, stroke: col, amp: 0.3 });
  }
  if (o.label && p > 0.6) {
    let acc = 0, mid = pts[0]; const half = total / 2;
    for (let i = 1; i < pts.length; i++) { if (acc + L[i - 1] >= half) { const k = (half - acc) / L[i - 1]; mid = [lerp(pts[i - 1][0], pts[i][0], k), lerp(pts[i - 1][1], pts[i][1], k)]; break; } acc += L[i - 1]; }
    const lx = mid[0] + (o.lx || 0), ly = mid[1] + (o.ly || 0), size = o.lsize || 28, w = zw(ctx, o.label, size) + 30;
    withA(ctx, prog(p, 0.6, 1), () => { ink(ctx, rrect(lx - w / 2, ly - size * 0.75, w, size * 1.5, size * 0.75), { fill: o.lfill || '#FFFFFF', stroke: col, lw: 2.5, seed: 630 }); zt(ctx, o.label, lx, ly + 1, { size, color: o.lcolor || C.ink }); });
  }
}
// small tag/chip, centre (x,y)
export function chip(ctx, x, y, s, o = {}) {
  const a = o.a ?? 1; if (a <= 0) return;
  const size = o.size || 28, w = zw(ctx, s, size, o.font || 'zh') + (o.padX ?? 34), h = size * 1.5;
  pop(ctx, x, y, a, () => {
    ink(ctx, rrect(x - w / 2, y - h / 2, w, h, h / 2), { fill: o.fill || C.cream, stroke: o.stroke || C.ink, lw: o.lw || 3, seed: o.seed || 640 });
    zt(ctx, s, x, y + 1, { size, color: o.color || C.ink, font: o.font || 'zh' });
  });
}

// ---------- chapter card + header ----------
export const STAGES = ['第一段 · 开户配卡与环境', '第二段 · 账号、开店与接口', '第三段 · 备份、复核与日常'];
export const CHAPTERS = {
  s02: [1, '客户建档', 0], s03: [2, '营业执照', 0], s04: [3, '14店清单', 0], s05: [4, '手机卡', 0], s06: [5, '宽带与出口IP', 0],
  s07: [6, '独立浏览器环境', 0], s08: [0, '主体分流', 1], s09: [7, '企业支付宝', 1], s10: [8, '开店：淘宝与闲鱼', 1], s11: [9, '登记账号关系', 1],
  s12: [10, '行政窗口', 1], s13: [11, '开通支付产品', 1], s14: [12, '授权与接口', 1], s15: [13, '备份与恢复演练', 2], s16: [14, '统筹复核', 2],
  s17: [15, '日常管理', 2], s19: [16, '闲鱼验收', 2], s18: [0, '记住这几条', 2],
};
const CN = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六'];
export const chapLabel = (sec) => { const c = CHAPTERS[sec]; return c ? (c[0] ? `第${CN[c[0]]}章 · ${c[1]}` : c[1]) : ''; };

// big title card at the start of a section (t0 = S.start); lasts `d` seconds then flies to the header
export function chapterCard(ctx, t, sec, t0, d = 2.2) {
  const c = CHAPTERS[sec]; if (!c) return;
  const k = t - t0; if (k < 0 || k > d + 0.5) return;
  const a = E(k, 0, 0.45, ease.outBack), out = E(k, d, d + 0.5);
  ctx.save(); ctx.globalAlpha *= 1 - out;
  ctx.fillStyle = `rgba(239,235,227,${0.75 * (1 - out)})`; ctx.fillRect(0, 0, W, H);
  ctx.translate(W / 2, 470 - out * 300); ctx.scale(lerp(0.55, 1, a) * lerp(1, 0.4, out), lerp(0.55, 1, a) * lerp(1, 0.4, out));
  const main = c[0] ? `第${CN[c[0]]}章` : '', sub = c[1];
  const w = Math.max(zw(ctx, sub, 120, 'hand'), 520) + 160;
  ink(ctx, rrect(-w / 2 + 10, -170 + 14, w, 340, 30), { fill: 'rgba(30,20,15,0.22)', stroke: null, amp: 0 });
  ink(ctx, rrect(-w / 2, -170, w, 340, 30), { fill: C.cream, lw: 6, seed: 700 + (c[0] || 20) });
  tape(ctx, -w / 2 + 60, -168, -0.4, 140); tape(ctx, w / 2 - 60, -168, 0.4, 140);
  zt(ctx, STAGES[c[2]], 0, -112, { size: 34, color: C.ink2 });
  if (main) zt(ctx, main, 0, -40, { size: 64, font: 'hand', color: PEN });
  const sw = zw(ctx, sub, 120, 'hand');
  marker(ctx, -sw / 2, main ? 78 : 30, sw, 46, E(k, 0.4, 0.9), 11);
  zt(ctx, sub, 0, main ? 60 : 10, { size: 120, font: 'hand' });
  ctx.restore();
}
// persistent header: chapter tag top-left + three stage dots top-right
export function header(ctx, t, sec, t0) {
  const c = CHAPTERS[sec]; if (!c) return;
  const a = E(t, t0 + 2.2, t0 + 2.8);
  if (a <= 0) return;
  withA(ctx, a, () => {
    const s = chapLabel(sec), size = 34, w = zw(ctx, s, size, 'hand') + 44;
    ink(ctx, rrect(36, 26, w, 58, 16), { fill: C.cream, lw: 3.5, seed: 720 });
    zt(ctx, s, 58, 56, { size, font: 'hand', align: 'left' });
    for (let i = 0; i < 3; i++) {
      const x = W - 360 + i * 120, cur = i === c[2];
      if (i) line(ctx, seg(x - 98, 52, x - 22, 52, 10), { lw: 3, stroke: i <= c[2] ? C.amber : rgba(C.ink, 0.3), amp: 0.4 });
      ink(ctx, circle(x, 52, cur ? 20 : 15, 18), { fill: i < c[2] ? C.amber : cur ? '#FFE3A8' : C.cream, lw: 3, seed: 730 + i });
      zt(ctx, ['一', '二', '三'][i], x, 54, { size: cur ? 26 : 22, font: 'hand', color: C.ink });
    }
    zt(ctx, STAGES[c[2]].split(' · ')[1], W - 240, 98, { size: 22, color: C.ink2 });
  });
}
// a small source credit line for screenshots, bottom-left above captions
export function credit(ctx, s, a = 1) {
  if (a <= 0 || !s) return;
  withA(ctx, a * 0.9, () => zt(ctx, '截图来源：' + s, 40, 1052, { size: 20, align: 'left', color: C.ink2, bold: false }));
}

// ---------- the company's own flowchart as a pinned photo, zooming into a region ----------
// o: { im, from: view, to: view, t0, t1, zoomAt, label, rings: [[box (image px), tAppear], ...] }
export function flowGlimpse(ctx, t, o) {
  const a = vis(t, o.t0, o.t1, 0.45, 0.45); if (a <= 0) return;
  const x = 120, y = 128, w = W - 240, h = 760;
  const im = o.im, cw = w - 32, ch = h - 32;
  const full = o.from || [0, 0, im.naturalWidth || 1, (im.naturalWidth || 1) * ch / cw];
  const v = lerpView(full, o.to, E(t, o.zoomAt ?? o.t0 + 0.6, (o.zoomAt ?? o.t0 + 0.6) + 1.4));
  withA(ctx, a, () => {
    ctx.save(); ctx.translate(W / 2, H / 2); ctx.rotate(-0.006); ctx.translate(-W / 2, -H / 2);
    shot(ctx, { im, kind: 'photo', x, y, w, h, view: v, top: false, bg: '#FFFFFF' }, (c, Mp) => {
      (o.rings || []).forEach(([b, ta], i) => penRing(c, Mp.box(b), E(t, ta, ta + 0.7), { seed: 90 + i, lw: 7 }));
    });
    tape(ctx, x + 90, y + 4, -0.3); tape(ctx, x + w - 90, y + 4, 0.3);
    if (o.label) T_label(ctx, o.label, x + 40, y + h - 10);
    ctx.restore();
  });
}
function T_label(ctx, s, x, y) {
  const size = 28, w = zw(ctx, s, size) + 36;
  ink(ctx, rrect(x, y - 24, w, 48, 10), { fill: '#2F2A28', stroke: null, amp: 0.6 });
  zt(ctx, s, x + 18, y + 1, { size, align: 'left', color: '#FFF4D8', bold: false });
}

// ---------- screenshot registry ----------
import { SHOTS } from './shots.js';
export function SH(id) { const s = SHOTS[id]; if (!s) return null; if (!s.im) s.im = img(s.file); return s; }
// placeholder when a screenshot is missing
export function noShot(ctx, x, y, w, h, label) {
  ink(ctx, rrect(x, y, w, h, 16), { fill: 'rgba(255,255,255,0.5)', stroke: rgba(C.ink, 0.4), lw: 3 });
  zt(ctx, '截图待补：' + label, x + w / 2, y + h / 2, { size: 30, color: C.ink2 });
}
// draw a registry screenshot in a frame; returns mapper (or null). o overrides frame params; ann(ctx, M, s) for annotations
export function regShot(ctx, id, o, ann) {
  const s = SH(id);
  if (!s) { noShot(ctx, o.x, o.y, o.w, o.h, id); return null; }
  return shot(ctx, { im: s.im, kind: s.kind === 'phone' ? 'phone' : s.kind === 'desktop' ? 'app' : 'web', url: s.url, title: s.title, masks: s.masks, ...o }, ann ? (c, M) => ann(c, M, s) : null);
}

// vertical step flow in a panel: steps = [{s, role?, t, fill?}], x = centre, y0 = first centre, gap = distance
export function stepFlow(ctx, t, steps, x, y0, w, gap, o = {}) {
  steps.forEach((st, i) => {
    const y = y0 + i * gap, k = E(t, st.t, st.t + 0.45, ease.outBack);
    if (i) arrow(ctx, [[x, y - gap + (o.h || 96) / 2 + 4], [x, y - (o.h || 96) / 2 - 6]], E(t, st.t - 0.2, st.t + 0.2), { lw: 4.5 });
    node(ctx, x, y, w, o.h || 96, st.s, { a: k, size: o.size || 36, fill: st.fill || '#FFFDF6' });
    if (st.role) roleChip(ctx, x + w / 2 + 16, y, st.role, k, { size: 26 });
  });
}

// ---------- walkthrough: a sequence of real screenshots with pen marks + a step card ----------
// steps: [{ id, t0, t1, at: 'phone'|'phoneL'|'phoneR'|'web'|'wide', rings: [[focusIndex|box, t]], zoom: [focusIndex|box, t, pad],
//           lens: [focusIndex|box, t, lx, ly, r], label: [text, t, x, y], note: index in card }]
// card: { title, items: [{s, role}], x, y, w, size }
const LAY = {
  phone: { x: 470, y: 112, w: 390, h: 800 }, phoneL: { x: 120, y: 112, w: 390, h: 800 }, phoneR: { x: 600, y: 112, w: 390, h: 800 },
  web: { x: 50, y: 120, w: 1230, h: 770 }, wide: { x: 70, y: 120, w: 1780, h: 770 },
};
const fbox = (s, f) => {
  if (Array.isArray(f)) return f;
  if (typeof f === 'string' && f[0] === 'u' && s && s.focus) {   // 'u013' = union of focus boxes 0, 1, 3
    const bs = [...f.slice(1)].map((d) => s.focus[+d]).filter(Boolean); if (!bs.length) return null;
    const x0 = Math.min(...bs.map((b) => b[0])), y0 = Math.min(...bs.map((b) => b[1])), x1 = Math.max(...bs.map((b) => b[0] + b[2])), y1 = Math.max(...bs.map((b) => b[1] + b[3]));
    return [x0, y0, x1 - x0, y1 - y0];
  }
  return s && s.focus && s.focus[f] ? s.focus[f] : null;
};
export function walk(ctx, t, o) {
  let cur = -1, lastCredit = null;
  if (!o.steps.length) return cur;
  o.steps.forEach((st, i) => {
    // when the next step takes over the same slot, keep this one opaque underneath while the next fades in on top
    const nx = o.steps[i + 1], handover = nx && Math.abs(nx.t0 - st.t1) < 0.05 && (nx.at || '') === (st.at || '');
    const a = vis(t, st.t0, handover ? st.t1 + (nx.fi ?? 0.35) : st.t1, st.fi ?? 0.35, handover ? 0.04 : (st.fo ?? 0.35));
    if (t >= st.t0) cur = st.note ?? i;
    if (a <= 0) return;
    const s = SH(st.id), P = { ...LAY[st.at || (s && s.kind === 'phone' ? 'phone' : 'web')], ...(st.frame || {}) };
    const slide = (1 - E(t, st.t0, st.t0 + 0.45)) * 40;
    withA(ctx, a, () => {
      ctx.save(); ctx.translate(slide, 0);
      if (!s) { if (st.mock) mockPhone(ctx, P.x, P.y, P.w, P.h, st.mock, t - st.t0); else noShot(ctx, P.x, P.y, P.w, P.h, st.id); ctx.restore(); return; }
      const iw = s.im.naturalWidth || s.w || 1000, ih = s.im.naturalHeight || s.h || 1000;
      // content size for this frame kind (must match shot())
      const kind = st.kind || (s.kind === 'phone' ? 'phone' : s.kind === 'desktop' ? 'app' : 'web');
      if (kind === 'photo') {   // a taped printout sized to the picture's own aspect, centred in the slot
        const asp = iw / ih, fw = Math.min(P.w, (P.h - 32) * asp + 32), fh = (fw - 32) / asp + 32;
        P.x += (P.w - fw) / 2; P.y += (P.h - fh) / 2; P.w = fw; P.h = fh; st.fit = 'all';
      }
      const cw = kind === 'phone' ? P.w - 28 : kind === 'photo' ? P.w - 32 : P.w - 20, ch = kind === 'phone' ? P.h - 28 : kind === 'photo' ? P.h - 32 : P.h - (kind === 'web' ? 92 : 50) - 10;
      let v = st.fit === 'all' ? [0, 0, iw, ih] : fitView(s.im, cw, ch, 'width', st.sy ?? 0);
      if (st.sy == null && st.fit !== 'all' && st.zoom == null) {   // scroll so the first focus box is in view
        const f0 = fbox(s, st.rings && st.rings.length ? st.rings[0][0] : 0);
        if (f0 && v[3] < ih) v = fitView(s.im, cw, ch, 'width', f0[1] + f0[3] / 2 - v[3] * 0.45);
      }
      if (st.zoom) { const fb = fbox(s, st.zoom[0]); if (fb) v = lerpView(v, focusView(s.im, fb, cw, ch, st.zoom[2] ?? 1.2), E(t, st.zoom[1], st.zoom[1] + 0.9)); }
      shot(ctx, { im: s.im, kind, x: P.x, y: P.y, w: P.w, h: P.h, view: v, url: s.url, title: s.title, masks: s.masks, rot: st.rot ?? (kind === 'phone' ? -0.012 : kind === 'photo' ? 0.015 : -0.005), top: st.fit === 'all' ? false : undefined, fit: st.fit, tape: kind === 'photo' }, (c, Mp) => {
        (st.rings || []).forEach(([f, tr, opt], j) => { const b = fbox(s, f); if (b) penRing(c, Mp.box(b), E(t, tr, tr + 0.6), { seed: 30 + j, ...(opt || {}) }); });
        (st.hls || []).forEach(([f, tr], j) => { const b = fbox(s, f); if (b) penHL(c, Mp.box(b), E(t, tr, tr + 0.5), { seed: 50 + j }); });
        (st.arrows || []).forEach(([f, tr, fx, fy], j) => { const b = fbox(s, f); if (b) { const [bx, by, bw, bh] = Mp.box(b); penArrow(c, fx, fy, bx + bw / 2 + (fx < bx ? -bw / 2 - 10 : bw / 2 + 10), by + bh / 2, E(t, tr, tr + 0.5), { seed: 60 + j }); } });
        if (st.lens) { const b = fbox(s, st.lens[0]); if (b) lens(c, Mp, s.im, b, st.lens[2], st.lens[3], st.lens[4] || 170, E(t, st.lens[1], st.lens[1] + 0.5), { pad: st.lens[5] }); }
        if (st.num != null) penNum(c, P.x + 18, P.y + 18, st.num, E(t, st.t0 + 0.2, st.t0 + 0.6));
      });
      if (st.label) penLabel(ctx, st.label[0], st.label[2], st.label[3], E(t, st.label[1], st.label[1] + 0.4), { size: st.label[4] || 40, box: true });
      ctx.restore();
    });
    if (a > 0.5 && s && o.credit !== false) lastCredit = [s.credit, a];
  });
  if (lastCredit) credit(ctx, lastCredit[0], lastCredit[1]);
  if (o.card) {
    const c = o.card;
    if (c.marks) { cur = -1; c.marks.forEach((m, i) => { if (t >= m) cur = i; }); }
    notes(ctx, c.x ?? 1320, c.y ?? 150, c.w ?? 540, c.items, cur, { title: c.title, size: c.size || 32, a: vis(t, c.t0 ?? o.steps[0].t0, c.t1 ?? o.steps[o.steps.length - 1].t1, 0.4, 0.4), done: cur });
  }
  return cur;
}
// preload every registered screenshot so loadAll() (awaited by the timeline) decodes them before the first frame
for (const k of Object.keys(SHOTS)) SH(k);

// ---------- outsourcing helpers ----------
// a small office building with a sign: the outside supplier. (x,y) = bottom centre
export function supplier(ctx, x, y, label, s = 1, o = {}) {
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
  ink(ctx, rrect(-150 + 8, -230 + 10, 300, 230, 10), { fill: 'rgba(40,28,20,0.18)', stroke: null, amp: 0 });
  ink(ctx, rrect(-150, -230, 300, 230, 10), { fill: o.fill || '#DDE3EA', lw: 5, seed: 3000, hatch: { angle: -0.9, gap: 12, alpha: 0.12 } });
  for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) ink(ctx, rrect(-120 + c * 86, -150 + r * 62, 62, 44, 4), { fill: '#FFF3D2', lw: 3, seed: 3010 + r * 3 + c });
  ink(ctx, rrect(-30, -50, 60, 50, 4), { fill: '#A9784E', lw: 3.5, seed: 3020 });
  const w = zw(ctx, label, 32, 'hand') + 40;
  ink(ctx, rrect(-w / 2, -282, w, 58, 10), { fill: '#FFFDF6', lw: 4, seed: 3021 });
  zt(ctx, label, 0, -252, { size: 32, font: 'hand' });
  ctx.restore();
}
// a request form (需求单) with filled rows; rows = [[label, value]], k = how many rows are filled (float)
export function requestForm(ctx, x, y, w, title, rows, k = 99, o = {}) {
  const h = 100 + rows.length * 64;
  ctx.save(); ctx.translate(x, y); ctx.rotate(o.rot ?? -0.015);
  ink(ctx, rrect(8, 10, w, h, 10), { fill: 'rgba(40,28,20,0.18)', stroke: null, amp: 0 });
  ink(ctx, rrect(0, 0, w, h, 10), { fill: '#FFFDF6', lw: 4, seed: 3030 });
  tape(ctx, w / 2, -2, 0.03, 120);
  zt(ctx, title, 30, 52, { size: 40, font: 'hand', align: 'left', color: o.tcolor || C.ink });
  rows.forEach(([a, b], i) => {
    const yy = 120 + i * 64;
    zt(ctx, a, 30, yy, { size: 30, align: 'left', color: C.ink2 });
    line(ctx, seg(o.lx || 200, yy + 22, w - 30, yy + 22, 20), { lw: 2, stroke: rgba(C.ink, 0.3) });
    withA(ctx, clamp(k - i), () => zt(ctx, b, (o.lx || 200) + 14, yy, { size: 32, align: 'left', font: 'hand', color: BLUE }));
  });
  ctx.restore();
  return h;
}
// follow-up table: cols = [[title, width]], rows = [[cells...]], rk = rows revealed (float), hl = highlighted row
export function followTable(ctx, x, y, cols, rows, rk = 99, o = {}) {
  const RH = o.rh || 62, W0 = cols.reduce((a, c) => a + c[1], 0), h = 70 + rows.length * RH + 20;
  ink(ctx, rrect(x + 8, y + 10, W0 + 40, h, 14), { fill: 'rgba(40,28,20,0.16)', stroke: null, amp: 0 });
  ink(ctx, rrect(x, y, W0 + 40, h, 14), { fill: '#FFFDF6', lw: 4.5, seed: 3040 });
  let cx = x + 20;
  cols.forEach(([n, cw], j) => { ink(ctx, rrect(cx + 3, y + 14, cw - 6, 50, 8), { fill: '#EFE8DA', lw: 2.5, seed: 3041 + j }); zt(ctx, n, cx + cw / 2, y + 39, { size: 28 }); cx += cw; });
  rows.forEach((r, i) => {
    const yy = y + 70 + i * RH + RH / 2;
    if (o.hl === i) penHL(ctx, [x + 20, yy - RH / 2 + 6, W0, RH - 12], o.hlk ?? 1, { color: '#FFD0C4', alpha: 0.5, seed: 3050 + i });
    line(ctx, seg(x + 20, yy + RH / 2, x + 20 + W0, yy + RH / 2, 30), { lw: 1.3, stroke: rgba(C.ink, 0.2), amp: 0.4 });
    let c2 = x + 20;
    withA(ctx, clamp(rk - i), () => r.forEach((v, j) => { zt(ctx, v, c2 + cols[j][1] / 2, yy, { size: 28, font: j ? 'hand' : 'zh', color: j ? BLUE : C.ink }); c2 += cols[j][1]; }));
  });
  return h;
}

// a hand-drawn phone screen standing in for a screen we have no screenshot of. m = { title, rows: [text], button, hl: row index, note }
export function mockPhone(ctx, x, y, w, h, m, age = 9) {
  ink(ctx, rrect(x + 10, y + 14, w, h, 46), { fill: 'rgba(40,28,20,0.22)', stroke: null, amp: 0 });
  ink(ctx, rrect(x, y, w, h, 46), { fill: '#2B2522', lw: 5, seed: 3100 });
  const cx = x + 14, cy = y + 14, cw = w - 28, ch = h - 28;
  ink(ctx, rrect(cx, cy, cw, ch, 34), { fill: '#F7F8FA', lw: 3, seed: 3101 });
  ink(ctx, rrect(cx, cy, cw, 110, 34), { fill: m.color || '#1677FF', stroke: null, amp: 0.4 });
  zt(ctx, m.title, cx + cw / 2, cy + 70, { size: 34, color: m.tcolor || '#fff' });
  (m.rows || []).forEach((r, i) => {
    const yy = cy + 170 + i * 92, k = clamp((age - 0.2 - i * 0.12) * 3);
    withA(ctx, k, () => {
      ink(ctx, rrect(cx + 24, yy - 34, cw - 48, 72, 14), { fill: m.hl === i ? '#E6F0FF' : '#fff', stroke: m.hl === i ? '#1677FF' : rgba(C.ink, 0.35), lw: m.hl === i ? 3.5 : 2, seed: 3110 + i });
      zt(ctx, r, cx + 50, yy + 2, { size: 28, align: 'left', color: C.ink, bold: false });
    });
  });
  if (m.button) {
    const by = cy + ch - 110;
    ink(ctx, rrect(cx + 30, by, cw - 60, 70, 35), { fill: m.color || '#1677FF', stroke: null, amp: 0.4 });
    zt(ctx, m.button, cx + cw / 2, by + 36, { size: 30, color: m.tcolor || '#fff' });
  }
  ink(ctx, rrect(cx + cw - 100, cy + 24, 80, 34, 10), { fill: '#FFE98A', lw: 2.5, seed: 3120 });
  zt(ctx, '示意', cx + cw - 60, cy + 42, { size: 22, font: 'hand', color: PEN });
}

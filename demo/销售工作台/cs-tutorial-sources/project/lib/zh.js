// Shared props + helpers for the partner video (《店铺在前面，我们在后面》).
// Paper world for people and goods, night world for the back office; amber = the thing we are following.
import { C, N, G, W, H, F, ink, line, rrect, circle, ellipse, poly, seg, xform, glow, dot, rgba, mix, rng, noise2,
  lerp, clamp, prog, E, ease, text, stamp, paper, night, stars, nightTexture, nink, camera, vignette } from '../../../engine/kit.js';
import { spriteGlow } from '../../../engine/props.js';

C.red = C.red || '#D9534A'; C.blueInk = C.blueInk || '#3E5C9A';
export const P = {
  wood: '#C99A6B', woodDark: '#A9784E', bezel: '#4B4440', screen: '#FFE7B0', screenHot: '#FFF3D2',
  green: '#8DBB7A', red: '#D9534A', blueInk: '#3E5C9A', grey: '#B9B1A4', cream: C.cream,
};

// ---------- text ----------
export function zt(ctx, s, x, y, o = {}) {
  const font = { zh: F.zh, hand: F.zhHand, stamp: F.zhStamp, brush: F.zhBrush, mono: F.mono }[o.font || 'zh'];
  const weight = o.font === 'zh' || !o.font ? 500 : 400;
  ctx.save();
  ctx.globalAlpha *= o.alpha ?? 1;
  ctx.font = `${weight} ${o.size || 44}px ${font}`;
  ctx.textAlign = o.align || 'center'; ctx.textBaseline = o.base || 'middle';
  if (o.rot) { ctx.translate(x, y); ctx.rotate(o.rot); x = 0; y = 0; }
  if (o.shadow) { ctx.fillStyle = 'rgba(40,28,20,0.16)'; ctx.fillText(s, x + 4, y + 6); }
  if (o.bold !== false && (o.font === 'zh' || !o.font)) { ctx.lineJoin = 'round'; ctx.strokeStyle = o.color || C.ink; ctx.lineWidth = o.boldW ?? Math.max(1.2, (o.size || 44) / 34); ctx.strokeText(s, x, y); }
  ctx.fillStyle = o.color || C.ink;
  ctx.fillText(s, x, y);
  ctx.restore();
}
export function zw(ctx, s, size = 44, font = 'zh') {
  const f = { zh: F.zh, hand: F.zhHand, stamp: F.zhStamp, brush: F.zhBrush, mono: F.mono }[font];
  ctx.save(); ctx.font = `${font === 'zh' ? 500 : 400} ${size}px ${f}`; const w = ctx.measureText(s).width; ctx.restore(); return w;
}
// amber marker swash behind a word (x = left edge)
export function marker(ctx, x, y, w, h = 30, a = 1, seed = 1, color = C.amber) {
  if (a <= 0) return;
  const k = clamp(a);
  ink(ctx, poly([[x - 8, y - h / 2 + 4], [x - 8 + (w + 16) * k, y - h / 2], [x - 6 + (w + 16) * k, y + h / 2], [x - 6, y + h / 2 + 3]], 10), { fill: rgba(color, 0.85), stroke: null, amp: 1.5, seed });
}
// hand-lettered title with optional marker under a substring
export function title(ctx, s, x, y, o = {}) {
  const size = o.size || 96, a = o.alpha ?? 1;
  if (a <= 0) return;
  ctx.save(); ctx.globalAlpha *= a;
  const w = zw(ctx, s, size, 'hand');
  if (o.mark) {
    const i = s.indexOf(o.mark);
    if (i >= 0) { const mx = x - w / 2 + zw(ctx, s.slice(0, i), size, 'hand'); marker(ctx, mx, y + size * 0.18, zw(ctx, o.mark, size, 'hand'), size * 0.42, o.markA ?? 1, 3); }
  }
  zt(ctx, s, x, y, { font: 'hand', size, color: o.color || C.ink, shadow: o.shadow !== false });
  ctx.restore();
}

// ---------- stamps & tags ----------
export function zstamp(ctx, label, x, y, age, o = {}) { stamp(ctx, label, x, y, age, { color: o.color || C.coral, rot: o.rot ?? -0.1, size: o.size || 70 }); }

// small 口径 tag, bottom-left (stacks upward if several). dark = night scenes
export function tags(ctx, t, list, t0, t1, { dark = false } = {}) {
  const a = prog(t, t0, t0 + 0.5) * (1 - prog(t, t1 - 0.4, t1));
  if (a <= 0) return;
  let y = H - 34;
  for (const s of list) {
    const w = zw(ctx, s, 24) + 36;
    ctx.save(); ctx.globalAlpha *= a * 0.95;
    ink(ctx, rrect(36, y - 20, w, 40, 10), { fill: dark ? 'rgba(20,18,50,0.75)' : 'rgba(251,247,238,0.92)', stroke: dark ? '#9d95e0' : C.ink2, lw: 2, amp: 0.8, seed: s.length });
    zt(ctx, s, 54, y + 1, { size: 24, align: 'left', color: dark ? '#e3dcff' : C.ink2, bold: false });
    ctx.restore();
    y -= 50;
  }
}

// speech bubble (the elder's question). tail: 'left' | 'right' | 'down'
export function bubble(ctx, s, x, y, a = 1, o = {}) {
  if (a <= 0) return;
  const size = o.size || 40, w = zw(ctx, s, size, o.font || 'zh') + 64, h = size + 44;
  ctx.save(); ctx.globalAlpha *= clamp(a);
  const sc = 0.8 + 0.2 * ease.outBack(clamp(a));
  ctx.translate(x, y); ctx.scale(sc, sc);
  const tail = o.tail || 'left';
  const tp = tail === 'left' ? [[-w / 2 + 30, h / 2 - 4], [-w / 2 + 6, h / 2 + 34], [-w / 2 + 64, h / 2 - 4]]
    : tail === 'right' ? [[w / 2 - 64, h / 2 - 4], [w / 2 - 6, h / 2 + 34], [w / 2 - 30, h / 2 - 4]]
    : [[-18, h / 2 - 4], [0, h / 2 + 34], [18, h / 2 - 4]];
  ink(ctx, rrect(-w / 2 + 6, -h / 2 + 8, w, h, 26), { fill: 'rgba(40,28,20,0.16)', stroke: null, amp: 0 });
  ink(ctx, poly(tp, 8), { fill: o.fill || C.cream, lw: 4, seed: 9 });
  ink(ctx, rrect(-w / 2, -h / 2, w, h, 26), { fill: o.fill || C.cream, lw: 4, seed: 8 });
  ctx.fillStyle = o.fill || C.cream; ctx.fillRect(tp[0][0] + 4, h / 2 - 8, tp[2][0] - tp[0][0] - 8, 8);
  zt(ctx, s, 0, 2, { size, font: o.font || 'zh', color: o.color || C.ink });
  ctx.restore();
}

// ---------- the mascot: 小屏, a 27" monitor with a face, missing its stand, leaning on books ----------
// (x, y) = ground point under the books (or under the screen if books:false). o: { s, eyes, look, tilt, books, tag, hop, alpha, glow }
export function xiaoping(ctx, x, y, o = {}) {
  const s = o.s ?? 1, t = G.t;
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
  if (o.alpha != null) ctx.globalAlpha *= o.alpha;
  const hop = o.hop ?? 0; // 0..1 phase of a hop
  const hy = -Math.sin(clamp(hop) * Math.PI) * 60;
  const sq = o.squash ?? 0;
  ink(ctx, ellipse(0, 2, 175 * (1 - Math.abs(hy) / 200), 12, 30), { fill: 'rgba(40,30,25,0.16)', stroke: null, amp: 0 });
  let base = 0;
  if (o.books !== false) {
    const B = [[C.teal, 168, 24], [C.coral, 150, 22], [C.mustard, 160, 20]];
    let by = 0;
    B.forEach(([col, w, h], i) => {
      const off = [-6, 8, -2][i];
      ink(ctx, rrect(-w / 2 + off, by - h, w, h, 4), { fill: col, lw: 3.5, seed: 70 + i, hatch: { angle: 0.4, gap: 7, alpha: 0.18, seed: i } });
      line(ctx, seg(-w / 2 + off + 10, by - h / 2, w / 2 + off - 10, by - h / 2, 14), { lw: 1.5, stroke: rgba(C.ink, 0.4), seed: 74 + i });
      by -= h;
    });
    base = by; // top of the stack
  }
  ctx.translate(0, base + hy);
  ctx.rotate((o.tilt ?? -0.035) + Math.sin(t * 1.7) * 0.006);
  ctx.scale(1 + sq * 0.06, 1 - sq * 0.08);
  const bw = 320, bh = 190; // 16:9-ish
  // power cable tail
  line(ctx, [[bw / 2 - 30, -6], [bw / 2 + 10, 12], [bw / 2 + 40, 4], [bw / 2 + 60, 18]], { lw: 5, stroke: C.ink2, seed: 81 });
  // bezel
  ink(ctx, rrect(-bw / 2, -bh - 8, bw, bh + 8, 14), { fill: P.bezel, lw: 5, seed: 82, hatch: { angle: -0.9, gap: 8, color: '#1d1916', alpha: 0.3, seed: 3 } });
  // screen (a real light: allowed to glow)
  const sx = -bw / 2 + 14, sy = -bh + 6, sw = bw - 28, sh = bh - 34;
  if (o.glow !== false) spriteGlow(ctx, 0, sy + sh / 2, 260, C.amber, 0.22);
  ink(ctx, rrect(sx, sy, sw, sh, 8), { fill: P.screen, lw: 3.5, seed: 83 });
  ink(ctx, rrect(sx + 10, sy + 8, sw * 0.42, 10, 5), { fill: rgba('#ffffff', 0.55), stroke: null, amp: 0.6 });
  // power led on the chin
  dot(ctx, bw / 2 - 26, -14, 4.5, C.led);
  // barcode sticker (after 入库)
  if (o.tag) {
    const ta = clamp(o.tag);
    ctx.save(); ctx.globalAlpha *= ta; ctx.translate(-bw / 2 + 58, -22); ctx.rotate(-0.08);
    ink(ctx, rrect(-34, -13, 68, 24, 3), { fill: '#FFF9EA', lw: 2.5, seed: 84 });
    for (let k = 0; k < 11; k++) { const xx = -28 + k * 5.2; line(ctx, seg(xx, -8, xx, 6, 6), { lw: k % 3 ? 1.6 : 3, stroke: C.ink, amp: 0.3 }); }
    ctx.restore();
  }
  // face on the screen
  const look = (o.look ?? 0) * 14, eyes = o.eyes || 'open';
  const blink = eyes !== 'happy' && ((t + (o.blinkSeed ?? 0.4)) % 3.9) < 0.12;
  const ey = sy + sh * 0.44;
  [-46, 46].forEach((ex, i) => {
    const X = ex + look;
    if (eyes === 'happy') { line(ctx, arcPts(X, ey + 10, 17, Math.PI * 1.1, Math.PI * 1.9, 10), { lw: 7, seed: 85 + i }); return; }
    const eh = blink ? 5 : eyes === 'worried' ? 30 : eyes === 'wide' ? 44 : 38;
    ink(ctx, rrect(X - 13, ey - eh / 2, 26, eh, 11), { fill: C.ink, lw: 3, seed: 87 + i });
    if (!blink) dot(ctx, X + 4 + look * 0.15, ey - 7, 5, '#ffffff');
    if (eyes === 'worried') { const d = i ? 1 : -1; line(ctx, seg(X - 17, ey - 32 - d * 6, X + 17, ey - 32 + d * 6, 8), { lw: 5, seed: 89 + i }); }
  });
  const my = sy + sh * 0.76;
  if (eyes === 'happy' || eyes === 'smile') line(ctx, arcPts(0, my - 12, 16, 0.25, Math.PI - 0.25, 10), { lw: 5, seed: 91 });
  else if (eyes === 'worried') line(ctx, arcPts(0, my + 8, 13, Math.PI + 0.45, Math.PI * 2 - 0.45, 10), { lw: 5, seed: 92 });
  else if (eyes === 'wide') ink(ctx, ellipse(0, my, 9, 11, 14), { fill: C.ink, lw: 2, seed: 93 });
  else line(ctx, seg(-11, my, 11, my, 6), { lw: 5, seed: 94 });
  // cheeks
  dot(ctx, -86 + look, ey + 26, 9, rgba(C.coral, 0.35)); dot(ctx, 86 + look, ey + 26, 9, rgba(C.coral, 0.35));
  ctx.restore();
}
export function arcPts(cx, cy, r, a0, a1, n = 18) { const p = []; for (let i = 0; i <= n; i++) { const a = lerp(a0, a1, i / n); p.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } return p; }

// a plain 27" monitor (lineups, shelves). (x,y) = bottom centre of the stand/feet. o: { s, stand, scratch, ports, label, face, screen, seed }
export function monitor(ctx, x, y, o = {}) {
  const s = o.s ?? 1, sd = o.seed ?? 0;
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
  if (o.alpha != null) ctx.globalAlpha *= o.alpha;
  const bw = 220, bh = 132;
  let top = 0;
  if (o.stand !== false) {
    ink(ctx, ellipse(0, -6, 62, 10, 22), { fill: '#6c625a', lw: 3.5, seed: sd + 1 });
    ink(ctx, rrect(-12, -62, 24, 56, 6), { fill: '#6c625a', lw: 3.5, seed: sd + 2 });
    top = -58;
  } else {
    ink(ctx, ellipse(0, 0, 100, 8, 22), { fill: 'rgba(40,30,25,0.14)', stroke: null, amp: 0 });
  }
  ctx.translate(0, top);
  ink(ctx, rrect(-bw / 2, -bh, bw, bh, 10), { fill: o.bezel || P.bezel, lw: 4, seed: sd + 3, hatch: { angle: -0.9, gap: 8, color: '#1d1916', alpha: 0.28, seed: sd } });
  ink(ctx, rrect(-bw / 2 + 10, -bh + 8, bw - 20, bh - 28, 6), { fill: o.screen || '#DCD3C2', lw: 3, seed: sd + 4 });
  if (o.scratch) line(ctx, [[-60, -bh + 26], [-20, -bh + 58], [10, -bh + 66]], { lw: 3, stroke: C.red, seed: sd + 5 });
  if (o.ports) for (let k = 0; k < o.ports; k++) ink(ctx, rrect(bw / 2 - 8, -bh + 24 + k * 22, 14, 12, 2), { fill: '#2a2320', lw: 2, seed: sd + 10 + k });
  if (o.face) { dot(ctx, -24, -bh + 50, 6, C.ink); dot(ctx, 24, -bh + 50, 6, C.ink); line(ctx, seg(-8, -bh + 72, 8, -bh + 72, 6), { lw: 3.5 }); }
  if (o.label) zt(ctx, o.label, 0, -bh / 2 - 6, { size: o.labelSize || 26, color: C.ink2 });
  ctx.restore();
}

// ---------- people ----------
const SK = ['#E9B48F', '#D8A077', '#F2CBA6', '#B97C57', '#E3A982'];
const HR = ['#2A2320', '#5b3a26', '#1c1a1a', '#3b2a22', '#6b5040'];
// (x, y) = feet. o: { s, color, id, facing, phase (walk), arm: 'up'|'out'|'down', prop, hair, apron, sit }
export function person(ctx, x, y, o = {}) {
  const s = o.s ?? 1, id = o.id ?? 0, f = o.facing ?? 1, ph = o.phase;
  ctx.save(); ctx.translate(x, y); ctx.scale(s * f, s);
  if (o.alpha != null) ctx.globalAlpha *= o.alpha;
  const sw = ph != null ? Math.sin(ph * Math.PI * 2) : 0, bob = ph != null ? -Math.abs(Math.cos(ph * Math.PI * 2)) * 3 : Math.sin(G.t * 2 + id) * 1.2;
  ink(ctx, ellipse(0, 2, 34, 6, 18), { fill: 'rgba(40,30,25,0.14)', stroke: null, amp: 0 });
  if (!o.sit) for (const [k, dir] of [[0, 1], [1, -1]]) {
    ctx.save(); ctx.translate(k ? 8 : -8, -32 + bob); ctx.rotate(sw * 0.35 * dir);
    ink(ctx, rrect(-7, 0, 14, 33, 7), { fill: C.ink2, lw: 3.5, seed: id * 10 + k });
    ctx.restore();
  }
  ink(ctx, rrect(-24, -92 + bob, 48, 62, 20), { fill: o.color || C.teal, lw: 4, seed: id * 10 + 3, hatch: { gap: 6, alpha: 0.18, seed: id } });
  if (o.apron) ink(ctx, rrect(-15, -76 + bob, 30, 44, 6), { fill: rgba('#ffffff', 0.7), lw: 2.5, seed: id * 10 + 2 });
  const hy = -116 + bob;
  ink(ctx, circle(0, hy, 22, 24), { fill: o.skin || SK[id % SK.length], lw: 4, seed: id * 10 + 4 });
  ctx.save(); ctx.beginPath(); ctx.arc(0, hy, 22, Math.PI * 1.02, Math.PI * 1.98); ctx.closePath(); ctx.fillStyle = o.hair || HR[id % HR.length]; ctx.fill(); ctx.restore();
  if (o.bun) ink(ctx, circle(-14, hy - 18, 9, 12), { fill: o.hair || HR[id % HR.length], lw: 3, seed: id * 10 + 5 });
  dot(ctx, 8, hy + 3, 2.6, C.ink); dot(ctx, -3, hy + 3, 2.6, C.ink);
  line(ctx, arcPts(3, hy + 9, 6, 0.3, Math.PI - 0.3, 6), { lw: 2.5, seed: id * 10 + 6, amp: 0.4 });
  // arms
  const arm = o.arm || 'down';
  const hand = arm === 'up' ? [30, -150 + bob] : arm === 'out' ? [52, -86 + bob] : arm === 'wave' ? [36 + Math.sin(G.t * 8) * 8, -150 + bob] : [26 + sw * 6, -44 + bob];
  line(ctx, [[-19, -80 + bob], [-28 - sw * 6, -46 + bob]], { lw: 6, amp: 0.5, seed: id * 10 + 7 });
  line(ctx, [[19, -80 + bob], hand], { lw: 6, amp: 0.5, seed: id * 10 + 8 });
  dot(ctx, hand[0], hand[1], 6, o.skin || SK[id % SK.length]);
  if (o.prop) { ctx.save(); ctx.translate(hand[0], hand[1]); o.prop(ctx); ctx.restore(); }
  ctx.restore();
}
// props held in a hand (drawn at the hand, local coords)
export const PROPS = {
  magnifier: (ctx) => { line(ctx, seg(0, 0, 18, -18, 6), { lw: 6, stroke: '#7a5a3a' }); ink(ctx, circle(30, -30, 20, 20), { fill: rgba('#cfe9f2', 0.6), lw: 4, seed: 5 }); },
  phone: (ctx) => { ink(ctx, rrect(-6, -40, 26, 44, 5), { fill: '#2a2320', lw: 3, seed: 6 }); ink(ctx, rrect(-2, -35, 18, 30, 3), { fill: '#bfe6f0', stroke: null }); },
  clipboard: (ctx) => { ink(ctx, rrect(-4, -46, 40, 52, 4), { fill: '#d9b98c', lw: 3, seed: 7 }); ink(ctx, rrect(2, -40, 28, 38, 2), { fill: C.cream, lw: 2, seed: 8 }); for (let k = 0; k < 3; k++) line(ctx, seg(6, -32 + k * 10, 26, -32 + k * 10, 6), { lw: 1.6, stroke: C.ink2 }); },
  card: (ctx) => { ink(ctx, rrect(-2, -44, 44, 34, 4), { fill: C.cream, lw: 3, seed: 9 }); line(ctx, seg(6, -34, 34, -34, 6), { lw: 2, stroke: C.coral }); line(ctx, seg(6, -24, 30, -24, 6), { lw: 1.6, stroke: C.ink2 }); },
  flag: (ctx) => { line(ctx, seg(0, 0, 0, -70, 8), { lw: 4, stroke: '#7a5a3a' }); ink(ctx, poly([[0, -70], [44, -58], [0, -46]], 8), { fill: C.coral, lw: 3, seed: 10 }); },
  baton: (ctx) => { ink(ctx, rrect(-6, -30, 12, 40, 5), { fill: C.amber, lw: 3, seed: 11 }); },
  scanner: (ctx) => { ink(ctx, rrect(-4, -22, 34, 20, 6), { fill: '#e7b745', lw: 3, seed: 12 }); line(ctx, seg(30, -12, 60, -12, 6), { lw: 2, stroke: C.red }); },
};

// ---------- the elder's hands (from the bottom edge) ----------
export function hand(ctx, x, y, o = {}) {
  const s = o.s ?? 1, rot = o.rot ?? 0;
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s * (o.flip ? -1 : 1), s);
  ink(ctx, rrect(-60, 40, 120, 400, 40), { fill: o.sleeve || '#7B8FB0', lw: 5, seed: 120, hatch: { angle: 0.6, gap: 9, alpha: 0.2, seed: 1 } });
  ink(ctx, rrect(-62, 30, 124, 34, 14), { fill: mix(o.sleeve || '#7B8FB0', '#ffffff', 0.25), lw: 4, seed: 121 });
  ink(ctx, poly([[-48, 38], [-56, -20], [-40, -62], [-6, -78], [30, -74], [52, -40], [50, 38]], 10), { fill: '#E7B38E', lw: 5, seed: 122 });
  for (let k = 0; k < 4; k++) line(ctx, [[-30 + k * 18, -66 + Math.abs(k - 1.5) * 6], [-30 + k * 18, -90 + Math.abs(k - 1.5) * 8]], { lw: 16, stroke: '#E7B38E', seed: 123 + k, amp: 0.5 });
  for (let k = 0; k < 4; k++) line(ctx, [[-30 + k * 18, -66 + Math.abs(k - 1.5) * 6], [-30 + k * 18, -90 + Math.abs(k - 1.5) * 8]], { lw: 3, stroke: rgba(C.ink, 0.5), seed: 130 + k, amp: 0.5 });
  line(ctx, [[-20, -10], [10, -6]], { lw: 2, stroke: rgba(C.ink, 0.35) });
  ctx.restore();
}

// ---------- documents & small things ----------
// blank business licence (no real data). (x,y) centre
export function licence(ctx, x, y, w = 360, h = 250, o = {}) {
  ctx.save(); ctx.translate(x, y); if (o.rot) ctx.rotate(o.rot);
  ink(ctx, rrect(-w / 2 + 6, -h / 2 + 8, w, h, 6), { fill: 'rgba(40,28,20,0.18)', stroke: null, amp: 0 });
  ink(ctx, rrect(-w / 2, -h / 2, w, h, 6), { fill: '#FBF3E2', lw: 4, seed: 140 });
  ink(ctx, rrect(-w / 2 + 12, -h / 2 + 12, w - 24, h - 24, 4), { stroke: C.coral, lw: 3, seed: 141 });
  zt(ctx, '营业执照', 0, -h / 2 + 46, { size: Math.round(w / 9), color: C.coral, font: 'zh' });
  for (let k = 0; k < 4; k++) line(ctx, seg(-w / 2 + 40, -h / 2 + 96 + k * 32, w / 2 - 110, -h / 2 + 96 + k * 32, 10), { lw: 2.5, stroke: rgba(C.ink, 0.25), seed: 142 + k });
  ink(ctx, circle(w / 2 - 66, h / 2 - 58, 32, 28), { stroke: rgba(C.coral, 0.75), lw: 4, seed: 147 });
  ctx.restore();
}
export function simCard(ctx, x, y, s = 1, rot = 0) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s);
  ink(ctx, poly([[-50, -64], [30, -64], [50, -44], [50, 64], [-50, 64]], 10), { fill: '#F3F0E8', lw: 4, seed: 150 });
  ink(ctx, rrect(-26, -16, 52, 42, 6), { fill: '#E7B745', lw: 3, seed: 151 });
  line(ctx, seg(-26, 5, 26, 5, 8), { lw: 2, stroke: rgba(C.ink, 0.6) }); line(ctx, seg(0, -16, 0, 26, 8), { lw: 2, stroke: rgba(C.ink, 0.6) });
  ctx.restore();
}
export function teacup(ctx, x, y, s = 1) {
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
  ink(ctx, ellipse(0, 0, 70, 14, 26), { fill: '#E9E2D2', lw: 4, seed: 160 });
  ink(ctx, poly([[-46, -70], [46, -70], [36, -6], [-36, -6]], 10), { fill: '#F4EEDF', lw: 4, seed: 161, hatch: { angle: 0.8, gap: 8, alpha: 0.15 } });
  ink(ctx, ellipse(0, -70, 46, 10, 22), { fill: '#B98A4E', lw: 3.5, seed: 162 });
  for (let k = 0; k < 2; k++) line(ctx, [[-14 + k * 26, -96], [-6 + k * 26, -118 - Math.sin(G.t * 2 + k) * 6], [-16 + k * 26, -140]], { lw: 3, stroke: rgba(C.ink, 0.3), seed: 163 + k });
  ctx.restore();
}
export function glasses(ctx, x, y, s = 1) {
  ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
  ink(ctx, ellipse(-38, 0, 30, 22, 22), { fill: rgba('#d8eef5', 0.5), lw: 4, seed: 170 });
  ink(ctx, ellipse(38, 0, 30, 22, 22), { fill: rgba('#d8eef5', 0.5), lw: 4, seed: 171 });
  line(ctx, arcPts(0, 4, 10, Math.PI * 1.15, Math.PI * 1.85, 8), { lw: 4 });
  line(ctx, [[-68, -4], [-110, -14]], { lw: 4 }); line(ctx, [[68, -4], [104, -20]], { lw: 4 });
  ctx.restore();
}
export function parcel(ctx, x, y, w = 260, h = 170, o = {}) {
  ctx.save(); ctx.translate(x, y);
  const open = o.open ?? 0;
  ink(ctx, rrect(-w / 2, -h, w, h, 6), { fill: '#D9AE78', lw: 4.5, seed: 180 + (o.seed || 0), hatch: { angle: 0.9, gap: 9, alpha: 0.18 } });
  if (open < 0.05) { line(ctx, seg(-w / 2 + 8, -h + 4, w / 2 - 8, -h + 4, 14), { lw: 2 }); ink(ctx, rrect(-24, -h, 48, h, 2), { fill: rgba('#c9b28a', 0.8), stroke: null }); }
  else {
    const a = open * 1.9;
    ink(ctx, poly([[-w / 2, -h], [0, -h], [-Math.cos(a) * 0, -h], [-w / 2 - Math.sin(a) * 40, -h - Math.sin(a) * 70]], 10), { fill: '#C99A62', lw: 4, seed: 186 });
    ink(ctx, poly([[w / 2, -h], [0, -h], [w / 2 + Math.sin(a) * 40, -h - Math.sin(a) * 70]], 10), { fill: '#C99A62', lw: 4, seed: 187 });
  }
  if (o.label) { ink(ctx, rrect(w / 2 - 110, -h + 40, 86, 54, 3), { fill: '#FFFDF5', lw: 2.5, seed: 188 }); for (let k = 0; k < 3; k++) line(ctx, seg(w / 2 - 100, -h + 54 + k * 12, w / 2 - 34, -h + 54 + k * 12, 6), { lw: 1.6, stroke: C.ink2 }); }
  ctx.restore();
}
// phone (screen content via fn(ctx, w, h) drawn in local coords, origin = screen top-left)
export function phone(ctx, x, y, w, h, fn, o = {}) {
  ctx.save(); ctx.translate(x, y); if (o.rot) ctx.rotate(o.rot);
  ink(ctx, rrect(-w / 2 + 8, -h / 2 + 10, w, h, 30), { fill: 'rgba(40,28,20,0.2)', stroke: null, amp: 0 });
  ink(ctx, rrect(-w / 2, -h / 2, w, h, 30), { fill: '#2B2522', lw: 5, seed: 190 });
  ink(ctx, rrect(-w / 2 + 14, -h / 2 + 34, w - 28, h - 64, 14), { fill: o.screen || '#FBF7EE', lw: 3, seed: 191 });
  ink(ctx, rrect(-26, -h / 2 + 14, 52, 9, 4), { fill: '#151110', stroke: null });
  ctx.save(); ctx.beginPath(); ctx.rect(-w / 2 + 16, -h / 2 + 36, w - 32, h - 68); ctx.clip();
  ctx.translate(-w / 2 + 16, -h / 2 + 36); if (fn) fn(ctx, w - 32, h - 68);
  ctx.restore();
  ctx.restore();
}

// a small shop front. (x,y) = bottom centre. o: { w, h, win: color, lit 0..1, awning color, label, night, content(ctx, x,y,w,h), alpha }
export function shop(ctx, x, y, o = {}) {
  const w = o.w || 300, h = o.h || 280, Nn = !!o.night;
  ctx.save(); ctx.translate(x, y); if (o.s) ctx.scale(o.s, o.s);
  if (o.alpha != null) ctx.globalAlpha *= o.alpha;
  const edge = Nn ? N.ink : C.ink;
  ink(ctx, rrect(-w / 2, -h, w, h, 6), { fill: Nn ? (o.wall || N.wall) : (o.wall || '#EADFCB'), stroke: edge, lw: 5, seed: 200 + (o.seed || 0), hatch: Nn ? { angle: -0.9, gap: 8, color: N.ink, alpha: 0.25 } : { angle: -0.9, gap: 11, alpha: 0.12 } });
  // awning with stripes
  const ay = -h + 46, aw = w + 26;
  ink(ctx, poly([[-aw / 2, ay - 40], [aw / 2, ay - 40], [aw / 2 - 6, ay + 16], [-aw / 2 + 6, ay + 16]], 12), { fill: o.awning || C.coral, stroke: edge, lw: 4.5, seed: 210 + (o.seed || 0) });
  for (let k = 1; k < 6; k++) { const xx = -aw / 2 + (aw * k) / 6; ink(ctx, poly([[xx - aw / 24, ay - 40], [xx + aw / 24, ay - 40], [xx + aw / 24 - 2, ay + 16], [xx - aw / 24 + 2, ay + 16]], 10), { fill: rgba('#ffffff', Nn ? 0.18 : 0.55), stroke: null, amp: 0.6 }); }
  // scalloped edge
  for (let k = 0; k < 6; k++) ink(ctx, arcPts(-aw / 2 + 6 + (aw - 12) * (k + 0.5) / 6, ay + 16, (aw - 12) / 12, 0, Math.PI, 8), { fill: o.awning || C.coral, stroke: edge, lw: 3.5, seed: 220 + k });
  // sign board
  if (o.label) { ink(ctx, rrect(-w / 2 + 30, -h + 6, w - 60, 34, 6), { fill: Nn ? N.roof : '#FBF7EE', stroke: edge, lw: 3, seed: 230 }); zt(ctx, o.label, 0, -h + 24, { size: 24, color: Nn ? '#151230' : C.ink }); }
  // window
  const wx = -w / 2 + 28, wy = ay + 44, ww = w - 56, wh = h - (ay + 44 + h) - 30 + h - 0;
  const winH = h - 46 - 44 - 60;
  const lit = o.lit ?? (Nn ? 1 : 0.6);
  const wc = o.win || C.amber;
  ink(ctx, rrect(wx, wy, ww, winH, 6), { fill: lit > 0.05 ? mix(Nn ? '#3a3470' : '#efe6d4', wc === C.amber ? '#FFD58A' : wc, clamp(lit)) : (Nn ? '#2a2660' : '#d9d0bf'), stroke: edge, lw: 4.5, seed: 240 + (o.seed || 0) });
  if (lit > 0.05 && (Nn || o.glowDay)) spriteGlow(ctx, 0, wy + winH / 2, ww * 0.9, wc === C.amber ? C.amber : wc, 0.35 * lit);
  if (o.content) { ctx.save(); ctx.beginPath(); ctx.rect(wx + 4, wy + 4, ww - 8, winH - 8); ctx.clip(); o.content(ctx, wx, wy, ww, winH); ctx.restore(); }
  if (o.mullion !== false) line(ctx, seg(0, wy + 2, 0, wy + winH - 2, 12), { lw: 3.5, stroke: edge, seed: 250 });
  // door-step / sill
  ink(ctx, rrect(-w / 2 - 8, -26, w + 16, 26, 4), { fill: Nn ? N.wallDark : '#CFC2AA', stroke: edge, lw: 4, seed: 260 });
  ctx.restore();
}

// archive book (档案本). (x,y) centre. o: { s, open 0..1, stamps: n filled, labels, page fn, rot }
export const STATIONS = ['认货', '到货', '入库', '上架', '成交', '发货', '售后', '对账'];
export const STAMPS = ['认准了', '验过了', '入库', '已上架', '买家确认', '已发出', '售后跟进', '对清了'];
export function dossier(ctx, x, y, o = {}) {
  const s = o.s ?? 1, open = clamp(o.open ?? 0);
  ctx.save(); ctx.translate(x, y); ctx.rotate(o.rot ?? -0.04); ctx.scale(s, s);
  const w = 260, h = 340;
  ink(ctx, rrect(-w / 2 + 10, -h / 2 + 12, w * (1 + open), h, 14), { fill: 'rgba(40,28,20,0.2)', stroke: null, amp: 0 });
  if (open > 0.02) {
    // right page (paper) and left page
    ink(ctx, rrect(-w / 2, -h / 2, w * 2 * open + 2, h, 12), { fill: '#FFF9EC', lw: 4.5, seed: 300 });
    line(ctx, seg(-w / 2 + w * open, -h / 2 + 6, -w / 2 + w * open, h / 2 - 6, 20), { lw: 3, stroke: rgba(C.ink, 0.35), seed: 301 });
    if (open > 0.95) {
      // stamp grid on the right page: 8 slots
      const n = o.stamps ?? 0;
      for (let i = 0; i < 8; i++) {
        const cx = w / 2 + 64 + (i % 2) * 120 - 8, cy = -h / 2 + 52 + Math.floor(i / 2) * 78;
        ink(ctx, circle(cx, cy, 30, 22), { stroke: rgba(C.ink, 0.25), lw: 2.5, seed: 310 + i });
        if (i < n) {
          ctx.save(); ctx.translate(cx, cy); ctx.rotate(-0.15 + (i % 3) * 0.1);
          ink(ctx, circle(0, 0, 30, 22), { stroke: C.coral, lw: 4, seed: 320 + i });
          zt(ctx, STATIONS[i], 0, 1, { size: 20, font: 'stamp', color: C.coral });
          ctx.restore();
        } else zt(ctx, STATIONS[i], cx, cy + 1, { size: 18, color: rgba(C.ink, 0.25), bold: false });
      }
      if (o.page) { ctx.save(); ctx.translate(-w / 2, -h / 2); o.page(ctx, w, h); ctx.restore(); }
    }
  } else {
    ink(ctx, rrect(-w / 2, -h / 2, w, h, 14), { fill: C.amber, lw: 5, seed: 302, hatch: { angle: 0.7, gap: 9, alpha: 0.2, seed: 3 } });
    ink(ctx, rrect(-w / 2 + 16, -h / 2 + 16, w - 32, h - 32, 8), { stroke: rgba(C.ink, 0.5), lw: 2.5, seed: 303 });
    zt(ctx, '档案', 0, -h / 2 + 90, { size: 62, font: 'hand', color: C.ink });
    // little monitor emblem
    ink(ctx, rrect(-48, 0, 96, 60, 6), { fill: P.screen, lw: 3.5, seed: 304 });
    dot(ctx, -16, 26, 4, C.ink); dot(ctx, 16, 26, 4, C.ink);
    ink(ctx, rrect(-40, 64, 80, 10, 3), { fill: C.teal, lw: 2.5, seed: 305 });
    zt(ctx, `${o.stamps ?? 0} / 8`, 0, h / 2 - 52, { size: 30, color: C.ink2 });
  }
  ctx.restore();
}

// journey HUD: 8 stations along a hand-drawn line at the top. cur = index (0..7), done = number completed
export function routeHUD(ctx, cur, done, a = 1, o = {}) {
  if (a <= 0) return;
  const y = o.y ?? 64, x0 = 470, x1 = 1450, dark = !!o.dark;
  ctx.save(); ctx.globalAlpha *= a;
  ink(ctx, rrect(x0 - 70, y - 40, x1 - x0 + 140, 82, 40), { fill: dark ? 'rgba(20,18,50,0.6)' : 'rgba(251,247,238,0.86)', stroke: dark ? '#8f88d8' : rgba(C.ink, 0.6), lw: 2.5, amp: 0.8, seed: 400 });
  for (let i = 0; i < 7; i++) {
    const xa = lerp(x0, x1, i / 7) + 18, xb = lerp(x0, x1, (i + 1) / 7) - 18;
    for (let xx = xa; xx < xb; xx += 18) line(ctx, seg(xx, y - 8, Math.min(xb, xx + 9), y - 8, 9), { lw: 3, stroke: i < done ? C.amber : (dark ? '#8f88d8' : rgba(C.ink, 0.35)), amp: 0.4 });
  }
  STATIONS.forEach((nm, i) => {
    const x = lerp(x0, x1, i / 7), isCur = i === cur, isDone = i < done;
    ink(ctx, circle(x, y - 8, isCur ? 15 : 11, 18), { fill: isDone ? C.amber : isCur ? '#FFE3A8' : (dark ? '#3a3470' : C.cream), stroke: dark ? N.ink : C.ink, lw: 3, seed: 410 + i });
    if (isDone) line(ctx, [[x - 6, y - 8], [x - 1, y - 2], [x + 8, y - 15]], { lw: 3, stroke: C.ink, amp: 0.3 });
    zt(ctx, nm, x, y + 22, { size: 23, color: dark ? '#e3dcff' : (isCur ? C.ink : C.ink2), bold: isCur });
  });
  ctx.restore();
}

// station title card: "第一站 · 认货" + the elder's question bubble. returns 0..1 visibility
export const CN = ['一', '二', '三', '四', '五', '六', '七', '八'];
export function stationTitle(ctx, t, t0, i, question, o = {}) {
  const k = t - t0;
  const a = E(k, 0, 0.45, ease.outBack), out = E(k, 2.4, 3.0);
  if (k < 0 || out >= 1) return;
  const dark = !!o.dark;
  ctx.save();
  ctx.globalAlpha *= 1 - out;
  const label = i === 7 ? `最后一站 · ${STATIONS[i]}` : `第${CN[i]}站 · ${STATIONS[i]}`;
  ctx.translate(o.x ?? W / 2, (o.y ?? 215) - out * 60); ctx.scale(lerp(0.6, 1, a), lerp(0.6, 1, a));
  const w = zw(ctx, label, 92, 'hand') + 120;
  ink(ctx, rrect(-w / 2 + 8, -70 + 10, w, 140, 30), { fill: 'rgba(30,20,15,0.22)', stroke: null, amp: 0 });
  ink(ctx, rrect(-w / 2, -70, w, 140, 30), { fill: dark ? '#2f2a6a' : C.cream, stroke: dark ? N.ink : C.ink, lw: 5, seed: 430 + i });
  zt(ctx, label, 0, 4, { font: 'hand', size: 92, color: dark ? '#FFE3A8' : C.ink, shadow: false });
  ctx.restore();
  if (question) bubble(ctx, question, (o.qx ?? W / 2 + 330), (o.qy ?? 355) - out * 30, E(k, 0.5, 0.9) * (1 - out), { size: 42, tail: 'left' });
}

// tick mark
export function tick(ctx, x, y, a = 1, s = 1, color = C.teal) {
  if (a <= 0) return;
  const k = clamp(a);
  const p = [[x - 18 * s, y], [x - 4 * s, y + 16 * s], [x + 24 * s, y - 20 * s]];
  const pts = k < 0.5 ? [p[0], [lerp(p[0][0], p[1][0], k * 2), lerp(p[0][1], p[1][1], k * 2)]] : [p[0], p[1], [lerp(p[1][0], p[2][0], (k - 0.5) * 2), lerp(p[1][1], p[2][1], (k - 0.5) * 2)]];
  line(ctx, pts, { lw: 7 * s, stroke: color, amp: 0.6 });
}
export function cross(ctx, x, y, r, a = 1, color = C.red) {
  if (a <= 0) return;
  const k = clamp(a);
  line(ctx, [[x - r, y - r], [lerp(x - r, x + r, Math.min(1, k * 2)), lerp(y - r, y + r, Math.min(1, k * 2))]], { lw: 8, stroke: color, amp: 0.8, seed: 1 });
  if (k > 0.5) line(ctx, [[x + r, y - r], [lerp(x + r, x - r, (k - 0.5) * 2), lerp(y - r, y + r, (k - 0.5) * 2)]], { lw: 8, stroke: color, amp: 0.8, seed: 2 });
}
// dashed hand-drawn arrow along points
export function dashed(ctx, pts, o = {}) {
  const prog_ = clamp(o.p ?? 1); let total = 0; const L = [];
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); L.push(d); total += d; }
  const stop = total * prog_, dash = o.dash || 22, gap = o.gap || 14;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i], d = L[i - 1];
    for (let u = 0; u < d; u += dash + gap) {
      const s0 = acc + u; if (s0 > stop) break;
      const u1 = Math.min(d, u + dash, stop - acc);
      line(ctx, [[lerp(ax, bx, u / d), lerp(ay, by, u / d)], [lerp(ax, bx, u1 / d), lerp(ay, by, u1 / d)]], { lw: o.lw || 4, stroke: o.color || C.ink, amp: 0.4 });
    }
    acc += d;
  }
  if (o.head && prog_ >= 0.999) {
    const [ax, ay] = pts[pts.length - 2], [bx, by] = pts[pts.length - 1], ang = Math.atan2(by - ay, bx - ax);
    line(ctx, [[bx - Math.cos(ang - 0.5) * 22, by - Math.sin(ang - 0.5) * 22], [bx, by], [bx - Math.cos(ang + 0.5) * 22, by - Math.sin(ang + 0.5) * 22]], { lw: o.lw || 4, stroke: o.color || C.ink, amp: 0.4 });
  }
}
// a sampled smooth path (catmull-rom) for motion along a route
export function catmull(pts, n = 16) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      out.push([0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
export function along(pts, u) {
  u = clamp(u); let total = 0; const L = [];
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); L.push(d); total += d; }
  let s = u * total;
  for (let i = 1; i < pts.length; i++) { if (s <= L[i - 1]) { const k = L[i - 1] ? s / L[i - 1] : 0; return [lerp(pts[i - 1][0], pts[i][0], k), lerp(pts[i - 1][1], pts[i][1], k)]; } s -= L[i - 1]; }
  return pts[pts.length - 1];
}

// a hand-drawn table top (wood) across the lower part of the frame
export function tabletop(ctx, y = 640, o = {}) {
  ink(ctx, poly([[-40, y], [W + 40, y], [W + 40, H + 40], [-40, H + 40]], 20), { fill: o.fill || P.wood, lw: 5, seed: 500, hatch: { angle: 0.05, gap: 26, alpha: 0.16, seed: 5 } });
  const r = rng(5);
  for (let i = 0; i < 9; i++) { const yy = y + 40 + i * 48 + r() * 10; line(ctx, [[-20, yy], [W * 0.3, yy + r() * 8 - 4], [W * 0.7, yy - r() * 8], [W + 20, yy + 4]], { lw: 2, stroke: rgba(C.ink, 0.18), seed: 510 + i }); }
  line(ctx, seg(-20, y + 6, W + 20, y + 6, 30), { lw: 3, stroke: rgba('#ffffff', 0.3), seed: 520 });
}

// chalk board with lines of text. (x,y) centre
export function board(ctx, x, y, w, h, rows, o = {}) {
  ctx.save(); ctx.translate(x, y); if (o.rot) ctx.rotate(o.rot);
  ink(ctx, rrect(-w / 2 - 16, -h / 2 - 16, w + 32, h + 32, 10), { fill: '#A9784E', lw: 5, seed: 600 });
  ink(ctx, rrect(-w / 2, -h / 2, w, h, 6), { fill: '#33463C', lw: 4, seed: 601, hatch: { angle: -0.5, gap: 14, color: '#ffffff', alpha: 0.05 } });
  rows.forEach((r, i) => { if ((r.a ?? 1) <= 0) return; zt(ctx, r.s, r.x ?? 0, -h / 2 + (r.y ?? 60 + i * 70), { size: r.size || 44, color: r.color || '#F3EEDF', alpha: r.a ?? 1, font: r.font || 'hand', align: r.align || 'center' }); });
  ctx.restore();
}

// wipe/transition helpers
export function fadeIn(ctx, t, t0, d = 0.5, color = '#EFEBE3') { const a = 1 - prog(t, t0, t0 + d); if (a > 0) { ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = color; ctx.fillRect(0, 0, W, H); ctx.restore(); } }
export function fadeOut(ctx, t, t1, d = 0.5, color = '#EFEBE3') { const a = prog(t, t1 - d, t1); if (a > 0) { ctx.save(); ctx.globalAlpha = a; ctx.fillStyle = color; ctx.fillRect(0, 0, W, H); ctx.restore(); } }
export function paperVeil(ctx, a) { if (a <= 0) return; ctx.save(); ctx.globalAlpha = a; paper(ctx); ctx.restore(); }

export { C, N, G, W, H, F, ink, line, rrect, circle, ellipse, poly, seg, xform, glow, dot, rgba, mix, rng, noise2, lerp, clamp, prog, E, ease, text, stamp, paper, night, stars, nightTexture, nink, camera, vignette, spriteGlow };

// the little AI helper: a lavender pebble with "AI" on its belly. (x,y) centre
export function aiBot(ctx, x, y, o = {}) {
  const s = o.s ?? 1, t = G.t;
  ctx.save(); ctx.translate(x, y + Math.sin(t * 2.6) * 6); ctx.scale(s, s);
  if (o.alpha != null) ctx.globalAlpha *= o.alpha;
  ink(ctx, ellipse(0, 78, 46, 8, 18), { fill: 'rgba(40,30,25,0.12)', stroke: null, amp: 0 });
  line(ctx, [[0, -58], [4, -82]], { lw: 4 }); dot(ctx, 5, -88, 8, C.amber);
  ink(ctx, ellipse(0, 0, 64, 58, 30), { fill: C.lav, lw: 4.5, seed: 900, hatch: { angle: -0.9, gap: 8, alpha: 0.18 } });
  ink(ctx, ellipse(0, -8, 44, 30, 24), { fill: '#EEEAFE', lw: 3, seed: 901 });
  const e = o.eyes || 'open';
  if (e === 'happy') { line(ctx, arcPts(-14, -4, 8, Math.PI * 1.1, Math.PI * 1.9, 8), { lw: 4 }); line(ctx, arcPts(14, -4, 8, Math.PI * 1.1, Math.PI * 1.9, 8), { lw: 4 }); }
  else if (e === 'oops') { line(ctx, seg(-20, -12, -8, -4, 6), { lw: 4 }); line(ctx, seg(-20, -4, -8, -12, 6), { lw: 4 }); dot(ctx, 14, -8, 5, C.ink); }
  else { dot(ctx, -14, -8, 5.5, C.ink); dot(ctx, 14, -8, 5.5, C.ink); }
  zt(ctx, 'AI', 0, 34, { size: 30, font: 'stamp', color: '#3a2f7a' });
  // little arms
  line(ctx, [[-60, 10], [-84, o.armUp ? -20 : 26]], { lw: 5 }); line(ctx, [[60, 10], [84, o.armUp ? -20 : 26]], { lw: 5 });
  ctx.restore();
}
// price tag on a string. (x,y) = top of string
export function priceTag(ctx, x, y, s, o = {}) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(o.rot ?? Math.sin(G.t * 1.5 + x) * 0.05);
  line(ctx, seg(0, 0, 0, 30, 6), { lw: 2.5 });
  const w = zw(ctx, s, o.size || 34) + 46;
  ink(ctx, poly([[-w / 2 + 16, 30], [w / 2, 30], [w / 2, 88], [-w / 2 + 16, 88], [-w / 2, 59]], 8), { fill: o.fill || '#FFF3C4', lw: 3.5, seed: 910 + s.length });
  dot(ctx, -w / 2 + 16, 59, 5, C.ink);
  zt(ctx, s, 8, 60, { size: o.size || 34, color: o.color || C.ink });
  ctx.restore();
}
// a parchment map card for the journey. returns node positions
export const MAPNODES = [[560, 330], [880, 260], [1220, 300], [1450, 470], [1330, 690], [990, 760], [650, 720], [440, 540]];
export function journeyMap(ctx, t, o = {}) {
  const a = o.alpha ?? 1, done = o.done ?? 0, p = o.p ?? 1;
  ctx.save(); ctx.globalAlpha *= a;
  ink(ctx, rrect(250 + 12, 140 + 14, 1420, 760, 26), { fill: 'rgba(40,28,20,0.2)', stroke: null, amp: 0 });
  ink(ctx, rrect(250, 140, 1420, 760, 26), { fill: '#F6ECD6', lw: 5, seed: 920, hatch: { angle: 0.3, gap: 30, alpha: 0.06 } });
  // little doodles: hills, trees, a river
  for (let k = 0; k < 6; k++) { const x = 330 + k * 250, y = 860 - (k % 2) * 20; line(ctx, arcPts(x, y + 40, 50, Math.PI, Math.PI * 2, 10), { lw: 3, stroke: rgba(C.ink, 0.3) }); }
  line(ctx, catmull([[260, 420], [380, 460], [330, 600], [270, 680]], 10), { lw: 6, stroke: rgba('#8FD0E8', 0.8) });
  const path = catmull([...MAPNODES, MAPNODES[0]], 14);
  dashed(ctx, path, { p, lw: 4, color: rgba(C.ink, 0.65), dash: 18, gap: 14 });
  MAPNODES.forEach(([x, y], i) => {
    const k = clamp(p * 8 - i);
    if (k <= 0) return;
    ink(ctx, circle(x, y, 44, 26), { fill: i < done ? C.amber : C.cream, lw: 4.5, seed: 930 + i });
    zt(ctx, String(i + 1), x, y + 2, { size: 40, font: 'hand' });
    const lx = x + (x > 960 ? 0 : 0), ly = y + (y > 520 ? 78 : -76);
    ink(ctx, rrect(lx - 64, ly - 26, 128, 52, 14), { fill: '#FFFDF5', lw: 3, seed: 940 + i });
    zt(ctx, STATIONS[i], lx, ly + 1, { size: 36, font: 'hand' });
  });
  ctx.restore();
}

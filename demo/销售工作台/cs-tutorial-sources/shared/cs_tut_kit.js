// Shared hand-drawn + real desktop GUI tutorial helpers for External CS V3 node videos.
// Zero pets/mascots; uses warm paper backdrop + crisp 1440x900 desktop captures + Qwen Serena VO.
import {
  W, H, C, G,
  clamp, lerp, prog, ease, E,
  rrect, circle, poly, seg,
  ink, line, paper, grain, vignette,
  text, stamp, rgba,
} from '../../engine/kit.js';

export { W, H, C, G, clamp, lerp, prog, ease, E, rrect, circle, poly, seg, ink, line, paper, grain, vignette, text, stamp, rgba };

export const P = {
  paper: C.paper,
  cream: '#FBF7EE',
  card: '#FFFDF8',
  ink: '#26201D',
  ink2: '#5D5148',
  muted: '#8A7E74',
  teal: '#1F8A80',
  tealBg: '#E6F5F3',
  blue: '#265D9E',
  blueBg: '#EBF2FC',
  amber: '#D97B18',
  amberBg: '#FFF3DF',
  red: '#C93A32',
  redBg: '#FDECEB',
  green: '#238651',
  greenBg: '#E9F7EF',
  lineSoft: '#D9CFC1',
};

export const FONT_BODY = '"WenKai", "Noto Sans CJK SC", sans-serif';
export const FONT_HAND = '"KuaiLe", "WenKai", sans-serif';
export const FONT_STAMP = '"HuangYou", "KuaiLe", sans-serif';
export const FONT_MONO = '"Courier Prime", "WenKai", monospace';

export const ASSETS = {};

export async function loadCsAssets(entries) {
  await Promise.all(
    Object.entries(entries).map(([key, filename]) => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => { ASSETS[key] = img; resolve(img); };
      img.onerror = (e) => reject(new Error(`Failed to load asset ${key} (${filename}): ${e?.message || 'err'}`));
      img.src = new URL(`./assets/${filename}`, import.meta.url).href;
    }))
  );
  return ASSETS;
}

export function drawPaperBg(ctx, { grid = true, vig = 0.14 } = {}) {
  paper(ctx);
  if (grid) {
    ctx.save();
    ctx.strokeStyle = 'rgba(130, 114, 96, 0.11)';
    ctx.lineWidth = 1;
    for (let x = 48; x < W; x += 64) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 48; y < H; y += 64) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    ctx.restore();
  }
  grain(ctx, 0.045);
  if (vig > 0) vignette(ctx, vig, '#241812');
}

export function zhText(ctx, s, x, y, {
  font = FONT_BODY,
  size = 30,
  color = P.ink,
  align = 'left',
  base = 'middle',
  alpha = 1,
  bold = false,
  lw = 1.4,
} = {}) {
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = `${bold ? 700 : 500} ${size}px ${font}`;
  ctx.textAlign = align;
  ctx.textBaseline = base;
  if (bold) {
    ctx.lineJoin = 'round';
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.strokeText(s, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
  ctx.restore();
}

export function wrapLines(ctx, str, maxW, fontSpec) {
  ctx.save();
  ctx.font = fontSpec;
  const paras = String(str || '').split('\n');
  const out = [];
  for (const para of paras) {
    let cur = '';
    for (const ch of para) {
      const next = cur + ch;
      if (ctx.measureText(next).width > maxW && cur) {
        out.push(cur);
        cur = ch;
      } else {
        cur = next;
      }
    }
    if (cur || para === '') out.push(cur);
  }
  ctx.restore();
  return out;
}

export function zhParagraph(ctx, str, x, y, maxW, {
  size = 26,
  lineHeight = 38,
  color = P.ink,
  font = FONT_BODY,
  bold = false,
  alpha = 1,
  maxLines = 99,
} = {}) {
  const fontSpec = `${bold ? 700 : 500} ${size}px ${font}`;
  const lines = wrapLines(ctx, str, maxW, fontSpec).slice(0, maxLines);
  lines.forEach((ln, i) => {
    zhText(ctx, ln, x, y + i * lineHeight, { font, size, color, bold, alpha, base: 'top', align: 'left', lw: 0.9 });
  });
  return lines.length * lineHeight;
}

export function handCard(ctx, x, y, w, h, {
  fill = P.card,
  stroke = P.ink,
  lw = 3.5,
  r = 18,
  shadow = true,
  alpha = 1,
  seed = 1,
  hatch = null,
} = {}) {
  if (alpha <= 0.01) return;
  ctx.save();
  ctx.globalAlpha *= alpha;
  if (shadow) {
    ink(ctx, rrect(x + 6, y + 8, w, h, r), { fill: 'rgba(38, 32, 29, 0.13)', stroke: null, amp: 0 });
  }
  ink(ctx, rrect(x, y, w, h, r), { fill, stroke, lw, amp: 1.2, seed, hatch });
  ctx.restore();
}

export function handPill(ctx, label, x, y, {
  bg = P.blueBg,
  stroke = P.blue,
  color = P.blue,
  size = 24,
  padX = 20,
  h = 44,
  alpha = 1,
  font = FONT_BODY,
  seed = 2,
} = {}) {
  if (alpha <= 0.01) return 0;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.font = `600 ${size}px ${font}`;
  const w = Math.max(88, Math.ceil(ctx.measureText(label).width) + padX * 2);
  ink(ctx, rrect(x, y, w, h, h / 2), { fill: bg, stroke, lw: 2.5, amp: 0.9, seed });
  zhText(ctx, label, x + w / 2, y + h / 2 + 1, { font, size, color, align: 'center', base: 'middle', bold: true, lw: 0.7 });
  ctx.restore();
  return w;
}

export function drawTopHeader(ctx, { nodeId, badge, title, stepText = '' }) {
  let leftX = 56 + handPill(ctx, nodeId, 56, 26, { bg: P.ink, stroke: P.ink, color: P.cream, size: 22, h: 40, seed: 11 }) + 16;
  if (badge) {
    const bw = handPill(ctx, badge, leftX, 26, { bg: P.amberBg, stroke: P.amber, color: P.amber, size: 22, h: 40, seed: 12 });
    leftX += bw + 18;
  }
  zhText(ctx, title, leftX, 46, { font: FONT_HAND, size: 32, color: P.ink, align: 'left', base: 'middle', bold: true, lw: 0.8 });
  if (stepText) {
    ctx.save();
    ctx.font = `600 21px ${FONT_BODY}`;
    const sw = Math.max(88, Math.ceil(ctx.measureText(stepText).width) + 40);
    ctx.restore();
    handPill(ctx, stepText, W - 52 - sw, 26, { bg: P.tealBg, stroke: P.teal, color: P.teal, size: 21, h: 40, seed: 13 });
  }
}

export function penArrow(ctx, x1, y1, x2, y2, tProg = 1, {
  color = P.red,
  lw = 5,
  head = 18,
  curve = 0,
  seed = 4,
} = {}) {
  const p = clamp(tProg, 0, 1);
  if (p <= 0.01) return;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const cx = mx + nx * curve, cy = my + ny * curve;

  const steps = Math.max(10, Math.ceil(len / 14));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const u = (i / steps) * p;
    const inv = 1 - u;
    pts.push([
      inv * inv * x1 + 2 * inv * u * cx + u * u * x2,
      inv * inv * y1 + 2 * inv * u * cy + u * u * y2,
    ]);
  }
  line(ctx, pts, { stroke: color, lw, amp: 1.0, seed });
  if (p > 0.72) {
    const hp = ease.out(prog(p, 0.72, 1));
    const end = pts[pts.length - 1];
    const prev = pts[Math.max(0, pts.length - 3)];
    const ang = Math.atan2(end[1] - prev[1], end[0] - prev[0]);
    const hs = head * hp;
    line(ctx, [
      [end[0] - hs * Math.cos(ang - 0.52), end[1] - hs * Math.sin(ang - 0.52)],
      [end[0], end[1]],
      [end[0] - hs * Math.cos(ang + 0.52), end[1] - hs * Math.sin(ang + 0.52)],
    ], { stroke: color, lw, amp: 0.7, seed: seed + 1 });
  }
}

export function penBox(ctx, x, y, w, h, tProg = 1, {
  color = P.red,
  lw = 5,
  r = 14,
  fill = null,
  seed = 5,
} = {}) {
  const p = ease.out(clamp(tProg, 0, 1));
  if (p <= 0.01) return;
  const pts = rrect(x, y, w, h, r, 10);
  if (fill && p > 0.2) {
    ink(ctx, pts, { fill: rgba(color, fill * p), stroke: null, amp: 0 });
  }
  const n = Math.max(2, Math.round(pts.length * p));
  line(ctx, pts.slice(0, n), { stroke: color, lw, amp: 1.4, seed });
}

export function penEllipse(ctx, cx, cy, rx, ry, tProg = 1, {
  color = P.red,
  lw = 5,
  fill = 0.08,
  seed = 6,
} = {}) {
  const p = ease.out(clamp(tProg, 0, 1));
  if (p <= 0.01) return;
  const total = 44;
  const pts = [];
  for (let i = 0; i <= total; i++) {
    const a = -Math.PI * 0.65 + (i / total) * Math.PI * 2.15 * p;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  if (fill && p > 0.4) {
    ctx.save();
    ctx.globalAlpha *= fill * prog(p, 0.4, 1);
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  line(ctx, pts, { stroke: color, lw, amp: 1.4, seed });
}

export function calloutTag(ctx, x, y, txt, tProg = 1, {
  color = P.red,
  bg = P.card,
  arrowTo = null,
  seed = 8,
} = {}) {
  const p = ease.outBack(clamp(tProg, 0, 1));
  if (p <= 0.02) return;
  ctx.save();
  ctx.font = `700 24px ${FONT_BODY}`;
  const tw = Math.ceil(ctx.measureText(txt).width);
  const w = tw + 34, h = 48;
  ctx.restore();
  if (arrowTo && p > 0.25) {
    const dx = arrowTo[0] - x;
    const dy = arrowTo[1] - y;
    let sx = x;
    let sy = y;
    if (Math.abs(dx) > w * 0.45 && Math.abs(dy) < h * 1.4) {
      sx = x + (dx >= 0 ? w / 2 + 4 : -w / 2 - 4);
      sy = y;
    } else {
      sy = y + (dy >= 0 ? h / 2 + 4 : -h / 2 - 4);
    }
    penArrow(ctx, sx, sy, arrowTo[0], arrowTo[1], prog(tProg, 0.2, 0.9), { color, lw: 4.5, curve: 18, seed: seed + 2 });
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(p, p);
  handCard(ctx, -w / 2, -h / 2, w, h, { fill: bg, stroke: color, lw: 3, r: 12, seed });
  zhText(ctx, txt, 0, 2, { font: FONT_BODY, size: 23, color, align: 'center', base: 'middle', bold: true, lw: 0.7 });
  ctx.restore();
}

// Scene Type 1: Opening Title Card + Role/Flow Overview
export function drawTitleScene(ctx, st, cfg) {
  drawPaperBg(ctx);
  const t = st.t;
  const aCard = ease.out(prog(t, 0.05, 0.55));
  handCard(ctx, 110, 74, W - 220, 748, { fill: P.cream, stroke: P.ink, lw: 4, r: 26, alpha: aCard, seed: 10 });

  // Top tags (chained widths so long IDs never overlap adjacent badges)
  let px = 168;
  px += handPill(ctx, cfg.nodeId, px, 126, { bg: P.ink, stroke: P.ink, color: P.cream, size: 25, h: 48, alpha: aCard }) + 16;
  px += handPill(ctx, cfg.roleTag || '外部客服 · 电脑端实操', px, 126, { bg: P.tealBg, stroke: P.teal, color: P.teal, size: 24, h: 48, alpha: aCard }) + 16;
  handPill(ctx, cfg.badge || '独立节点教程', px, 126, { bg: P.amberBg, stroke: P.amber, color: P.amber, size: 24, h: 48, alpha: aCard });

  // Big Title & Subtitle
  const aTitle = ease.out(prog(t, 0.25, 0.8));
  zhText(ctx, cfg.title, 168, 250, { font: FONT_HAND, size: 64, color: P.ink, align: 'left', bold: true, lw: 1.6, alpha: aTitle });
  zhText(ctx, cfg.subtitle, 168, 326, { font: FONT_BODY, size: 32, color: P.ink2, align: 'left', bold: false, alpha: aTitle });

  // Divider line
  line(ctx, seg(168, 376, W - 168, 376), { stroke: P.lineSoft, lw: 3, amp: 1.1, alpha: aTitle });

  // 3/4-step horizontal hand-drawn preview flow
  const steps = cfg.miniSteps || [];
  const n = steps.length;
  const totalW = W - 336;
  const gap = 44;
  const boxW = (totalW - gap * Math.max(0, n - 1)) / Math.max(1, n);
  steps.forEach((s, i) => {
    const dt = 0.25 + i * 0.28;
    const p = ease.outBack(prog(t, dt, dt + 0.45));
    const bx = 168 + i * (boxW + gap);
    const by = 418;
    const tone = s.tone === 'red' ? { bg: P.redBg, st: P.red } : s.tone === 'green' ? { bg: P.greenBg, st: P.green } : s.tone === 'amber' ? { bg: P.amberBg, st: P.amber } : { bg: P.blueBg, st: P.blue };
    if (p > 0.02) {
      ctx.save();
      ctx.translate(bx + boxW / 2, by + 115);
      ctx.scale(lerp(0.86, 1, p), lerp(0.86, 1, p));
      ctx.globalAlpha = clamp(p, 0, 1);
      handCard(ctx, -boxW / 2, -115, boxW, 230, { fill: tone.bg, stroke: tone.st, lw: 3.5, r: 20, seed: 20 + i });
      handPill(ctx, `第 ${i + 1} 步`, -boxW / 2 + 22, -92, { bg: tone.st, stroke: tone.st, color: '#FFF', size: 21, h: 36, seed: 30 + i });
      zhText(ctx, s.label, -boxW / 2 + 22, -24, { font: FONT_HAND, size: 30, color: P.ink, align: 'left', bold: true, lw: 0.8 });
      zhParagraph(ctx, s.desc, -boxW / 2 + 22, 8, boxW - 44, { size: 23, lineHeight: 33, color: P.ink2 });
      ctx.restore();
    }
    if (i < n - 1) {
      penArrow(ctx, bx + boxW + 4, by + 115, bx + boxW + gap - 4, by + 115, prog(t, dt + 0.25, dt + 0.55), { color: P.ink, lw: 4, seed: 40 + i });
    }
  });

  // Goal strip at bottom of card
  const aGoal = ease.out(prog(t, 1.4, 2.0));
  if (cfg.goalLine && aGoal > 0.02) {
    handCard(ctx, 168, 690, W - 336, 92, { fill: '#FFF7E8', stroke: P.amber, lw: 3, r: 16, alpha: aGoal, seed: 55 });
    zhText(ctx, `🎯 本节学完能做到：${cfg.goalLine}`, 202, 736, { font: FONT_BODY, size: 28, color: P.ink, align: 'left', bold: true, lw: 0.7, alpha: aGoal });
  }
}

// Scene Type 2: Hand-drawn Workflow & Decision Branch Diagram (with active beat highlight)
export function drawWorkflowScene(ctx, st, cfg) {
  drawPaperBg(ctx);
  const t = st.t;
  drawTopHeader(ctx, { nodeId: cfg.nodeId, badge: cfg.badge || '业务逻辑图解', title: cfg.heading, stepText: cfg.stepText || '' });

  // Which beat is active based on st.t
  const beats = cfg.beats || [];
  let activeIdx = 0;
  for (let i = 0; i < beats.length; i++) {
    if (t >= beats[i].at) activeIdx = i;
  }

  // Case strip
  if (cfg.caseStrip) {
    const ac = ease.out(prog(t, 0.05, 0.4));
    handCard(ctx, 56, 86, W - 112, 64, { fill: P.amberBg, stroke: P.amber, lw: 2.8, r: 14, alpha: ac, seed: 70 });
    zhText(ctx, cfg.caseStrip, 84, 118, { font: FONT_BODY, size: 25, color: P.ink, align: 'left', bold: true, lw: 0.6, alpha: ac });
  }

  // Main horizontal cards
  const cards = cfg.cards || [];
  const startY = cfg.caseStrip ? 186 : 124;
  const cardH = 290;
  const marginX = 56;
  const gap = 54;
  const cardW = (W - marginX * 2 - gap * Math.max(0, cards.length - 1)) / Math.max(1, cards.length);

  cards.forEach((c, i) => {
    const dt = i * 0.45;
    const appear = ease.outBack(prog(t, dt, dt + 0.45));
    const x = marginX + i * (cardW + gap);
    const isAct = i === activeIdx;
    const tone = c.tone === 'red' ? { bg: P.redBg, st: P.red } : c.tone === 'green' ? { bg: P.greenBg, st: P.green } : c.tone === 'amber' ? { bg: P.amberBg, st: P.amber } : { bg: P.blueBg, st: P.blue };
    if (appear > 0.02) {
      handCard(ctx, x, startY, cardW, cardH, {
        fill: isAct ? tone.bg : P.card,
        stroke: isAct ? tone.st : P.ink,
        lw: isAct ? 5.5 : 3,
        r: 20,
        alpha: appear,
        seed: 80 + i,
      });
      handPill(ctx, c.tag, x + 22, startY + 22, { bg: tone.st, stroke: tone.st, color: '#FFF', size: 21, h: 38, alpha: appear, seed: 90 + i });
      zhText(ctx, c.title, x + 22, startY + 96, { font: FONT_HAND, size: 32, color: P.ink, align: 'left', bold: true, lw: 0.9, alpha: appear });
      zhParagraph(ctx, c.body, x + 22, startY + 132, cardW - 44, { size: 24, lineHeight: 35, color: P.ink2, alpha: appear });
      if (isAct && c.pulseNote) {
        zhText(ctx, `👉 ${c.pulseNote}`, x + 22, startY + cardH - 32, { font: FONT_BODY, size: 22, color: tone.st, bold: true, lw: 0.6 });
      }
    }
    if (i < cards.length - 1) {
      penArrow(ctx, x + cardW + 4, startY + cardH / 2, x + cardW + gap - 4, startY + cardH / 2, prog(t, dt + 0.2, dt + 0.55), { color: P.ink, lw: 4.5, seed: 100 + i });
    }
  });

  // Exception / Branch Row below
  const branches = cfg.branches || [];
  if (branches.length) {
    const by = startY + cardH + 54;
    const bh = 250;
    const bw = (W - marginX * 2 - 40 * Math.max(0, branches.length - 1)) / branches.length;
    branches.forEach((b, idx) => {
      const dt = 0.8 + idx * 0.55;
      const p = ease.out(prog(t, dt, dt + 0.5));
      const bx = marginX + idx * (bw + 40);
      const isOk = b.ok;
      const stC = isOk ? P.green : P.red;
      const bgC = isOk ? P.greenBg : P.redBg;
      if (p > 0.02) {
        handCard(ctx, bx, by, bw, bh, { fill: bgC, stroke: stC, lw: 3.5, r: 18, alpha: p, seed: 120 + idx });
        handPill(ctx, b.pill, bx + 22, by + 20, { bg: stC, stroke: stC, color: '#FFF', size: 22, h: 38, alpha: p, seed: 130 + idx });
        zhText(ctx, b.title, bx + 22, by + 90, { font: FONT_HAND, size: 30, color: P.ink, bold: true, lw: 0.8, alpha: p });
        zhParagraph(ctx, b.desc, bx + 22, by + 124, bw - 44, { size: 24, lineHeight: 34, color: P.ink2, alpha: p });
        if (b.stampLabel && t > dt + 0.55) {
          stamp(ctx, b.stampLabel, bx + bw - 122, by + 46, t - (dt + 0.55), { color: stC, size: 30, rot: -0.09 });
        }
      }
    });
  }
}

// Map an original 1440x900 desktop coordinate box into our GUI viewport rectangle
export function mapRect(rect, vp) {
  const [ox, oy, ow, oh] = rect;
  const sx = vp.w / 1440;
  const sy = vp.h / 900;
  return [vp.x + ox * sx, vp.y + oy * sy, ow * sx, oh * sy];
}

// Scene Type 3: Real 1440x900 Desktop GUI + Timed Hand-Drawn Annotations + Right Action Pad
export function drawGuiScene(ctx, st, cfg) {
  drawPaperBg(ctx);
  const t = st.t;
  drawTopHeader(ctx, { nodeId: cfg.nodeId, badge: cfg.badge || '真实桌面实操', title: cfg.heading, stepText: cfg.stepText || '' });

  const img = ASSETS[cfg.imgKey];
  // Display desktop window cleanly on left (or wide) leaving y >= 856 free for captions
  const sideMode = cfg.sideNotes && cfg.sideNotes.length > 0;
  const vp = sideMode
    ? { x: 52, y: 84, w: 1232, h: 770 }   // exact 1440:900 (1.6) aspect!
    : { x: 256, y: 82, w: 1408, h: 880 }; // wait: y=82+770=852 keeps caption at y=950 unobstructed! Wait use h=760 -> w=1216 centered
  const box = sideMode ? vp : { x: 352, y: 82, w: 1216, h: 760 };

  // Window bezel card
  handCard(ctx, box.x - 8, box.y - 8, box.w + 16, box.h + 16, { fill: '#111827', stroke: P.ink, lw: 4, r: 16, seed: 200 });
  if (img) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(box.x, box.y, box.w, box.h, 10);
    ctx.clip();
    // Optional zoom focus transform if cfg.zoom is set
    if (cfg.zoom) {
      const zt = ease.inOut(prog(t, cfg.zoom.t0 ?? 0.5, cfg.zoom.t1 ?? 1.5));
      const sc = lerp(1, cfg.zoom.scale ?? 1.35, zt);
      const [fx, fy, fw, fh] = mapRect(cfg.zoom.rect, box);
      const cx = fx + fw / 2, cy = fy + fh / 2;
      ctx.translate(cx, cy);
      ctx.scale(sc, sc);
      ctx.translate(-cx, -cy);
    }
    ctx.drawImage(img, box.x, box.y, box.w, box.h);
    ctx.restore();
  }

  // Timed hand-drawn annotations synced to st.t
  for (const ann of (cfg.annotations || [])) {
    const t0 = ann.at ?? 0;
    const t1 = ann.until ?? 999;
    if (t < t0 || t > t1) continue;
    const p = prog(t, t0, t0 + (ann.dur ?? 0.55));
    const col = ann.color === 'green' ? P.green : ann.color === 'amber' ? P.amber : ann.color === 'teal' ? P.teal : P.red;
    if (ann.type === 'box') {
      const [rx, ry, rw, rh] = mapRect(ann.rect, box);
      penBox(ctx, rx - 5, ry - 5, rw + 10, rh + 10, p, { color: col, lw: 5.5, fill: ann.fill ?? 0.08, seed: ann.seed ?? 210 });
      if (ann.label) {
        const lx = ann.labelPos ? box.x + ann.labelPos[0] * (box.w / 1440) : Math.max(box.x + 120, Math.min(box.x + box.w - 140, rx + rw / 2));
        const ly = ann.labelPos ? box.y + ann.labelPos[1] * (box.h / 900) : (ry > box.y + 80 ? ry - 36 : ry + rh + 42);
        const ax = Math.abs(lx - (rx + rw / 2)) > rw * 0.55 ? (lx < rx ? rx - 6 : rx + rw + 6) : (rx + rw / 2);
        const ay = Math.abs(lx - (rx + rw / 2)) > rw * 0.55 ? (ry + rh / 2) : (ly < ry ? ry - 6 : ry + rh + 6);
        calloutTag(ctx, lx, ly, ann.label, p, { color: col, bg: '#FFFDF8', arrowTo: [ax, ay] });
      }
    } else if (ann.type === 'ring') {
      const [rx, ry, rw, rh] = mapRect(ann.rect, box);
      penEllipse(ctx, rx + rw / 2, ry + rh / 2, rw / 2 + 12, rh / 2 + 10, p, { color: col, lw: 5.5, seed: ann.seed ?? 220 });
      if (ann.label) {
        const lx = ann.labelPos ? box.x + ann.labelPos[0] * (box.w / 1440) : Math.max(box.x + 140, Math.min(box.x + box.w - 140, rx + rw / 2));
        const ly = ann.labelPos ? box.y + ann.labelPos[1] * (box.h / 900) : (ry > box.y + 90 ? ry - 44 : ry + rh + 48);
        calloutTag(ctx, lx, ly, ann.label, p, { color: col, bg: '#FFFDF8', arrowTo: [rx + rw / 2, ry > box.y + 90 ? ry - 10 : ry + rh + 10] });
      }
    } else if (ann.type === 'arrow') {
      const [x1, y1] = mapRect([ann.from[0], ann.from[1], 0, 0], box);
      const [x2, y2] = mapRect([ann.to[0], ann.to[1], 0, 0], box);
      penArrow(ctx, x1, y1, x2, y2, p, { color: col, lw: 6, curve: ann.curve ?? 20, seed: ann.seed ?? 230 });
    } else if (ann.type === 'stamp') {
      const [sx, sy] = mapRect([ann.atPos[0], ann.atPos[1], 0, 0], box);
      stamp(ctx, ann.label, sx, sy, t - t0, { color: col, size: ann.size ?? 44, rot: ann.rot ?? -0.1 });
    }
  }

  // Right Hand-Drawn Checklist Notepad (sideMode)
  if (sideMode) {
    const sx = box.x + box.w + 26;
    const sw = W - sx - 44;
    handCard(ctx, sx, 84, sw, 770, { fill: P.cream, stroke: P.ink, lw: 3.5, r: 22, seed: 250 });
    zhText(ctx, cfg.sideTitle || '👉 当前动作清单', sx + 26, 128, { font: FONT_HAND, size: 32, color: P.ink, bold: true, lw: 0.9 });
    line(ctx, seg(sx + 24, 156, sx + sw - 24, 156), { stroke: P.lineSoft, lw: 2.5 });

    let curY = 180;
    cfg.sideNotes.forEach((item, idx) => {
      const at = item.at ?? (idx * 1.4);
      const active = t >= at && (idx === cfg.sideNotes.length - 1 || t < (cfg.sideNotes[idx + 1].at ?? 999));
      const done = t >= at + 0.1;
      const col = item.tone === 'red' ? P.red : item.tone === 'green' ? P.green : item.tone === 'amber' ? P.amber : P.blue;
      const bg = active ? (item.tone === 'red' ? P.redBg : item.tone === 'green' ? P.greenBg : P.amberBg) : '#FFFFFF';
      const boxH = item.h || 126;
      const ap = ease.out(prog(t, Math.max(0, at - 0.35), at + 0.2));
      if (ap > 0.02) {
        handCard(ctx, sx + 22, curY, sw - 44, boxH, { fill: bg, stroke: active ? col : P.lineSoft, lw: active ? 4 : 2, r: 16, alpha: ap, seed: 260 + idx });
        handPill(ctx, item.tag || `动作 ${idx + 1}`, sx + 38, curY + 14, { bg: done ? col : P.muted, stroke: done ? col : P.muted, color: '#FFF', size: 19, h: 32, alpha: ap, seed: 270 + idx });
        zhText(ctx, item.title, sx + 160, curY + 30, { font: FONT_BODY, size: 24, color: P.ink, bold: true, lw: 0.7, alpha: ap });
        zhParagraph(ctx, item.desc, sx + 38, curY + 56, sw - 76, { size: 21, lineHeight: 30, color: P.ink2, alpha: ap });
      }
      curY += boxH + 16;
    });

    if (cfg.bottomWarn && t >= (cfg.bottomWarn.at ?? 1)) {
      const aw = ease.out(prog(t, cfg.bottomWarn.at ?? 1, (cfg.bottomWarn.at ?? 1) + 0.4));
      handCard(ctx, sx + 22, 728, sw - 44, 108, { fill: P.redBg, stroke: P.red, lw: 3, r: 16, alpha: aw, seed: 299 });
      zhText(ctx, `⚠️ ${cfg.bottomWarn.title}`, sx + 40, 756, { font: FONT_BODY, size: 22, color: P.red, bold: true, lw: 0.6, alpha: aw });
      zhParagraph(ctx, cfg.bottomWarn.desc, sx + 40, 774, sw - 80, { size: 20, lineHeight: 26, color: P.ink, alpha: aw });
    }
  }
}

// Scene Type 4: Codex / Skill + Expected Output + Stop Condition / Manual Takeover Boundary
export function drawCodexBoundaryScene(ctx, st, cfg) {
  drawPaperBg(ctx);
  const t = st.t;
  drawTopHeader(ctx, { nodeId: cfg.nodeId, badge: 'AI 协作与人工兜底', title: cfg.heading || '怎么交代 Codex / Skill，什么时候必须停手', stepText: '核验与兜底' });

  const a1 = ease.outBack(prog(t, 0.1, 0.6));
  const a2 = ease.outBack(prog(t, 0.7, 1.2));
  const a3 = ease.outBack(prog(t, 1.4, 1.9));

  // Left-top: Codex & Skill prompt card
  handCard(ctx, 56, 98, 880, 340, { fill: P.blueBg, stroke: P.blue, lw: 3.5, r: 22, alpha: a1, seed: 301 });
  handPill(ctx, `✅ 已核验 Skill：${cfg.skillName}`, 84, 124, { bg: P.blue, stroke: P.blue, color: '#FFF', size: 22, h: 40, alpha: a1 });
  zhText(ctx, '日常遇到卡点或要核账，怎么向 Codex 交代：', 84, 198, { font: FONT_HAND, size: 30, color: P.ink, bold: true, lw: 0.8, alpha: a1 });
  handCard(ctx, 84, 226, 824, 186, { fill: '#FFF', stroke: P.lineSoft, lw: 2.5, r: 14, shadow: false, alpha: a1, seed: 302 });
  zhParagraph(ctx, `“${cfg.codexPrompt}”`, 108, 246, 776, { size: 25, lineHeight: 38, color: P.ink, alpha: a1 });

  // Right-top: Expected Output & Verification
  handCard(ctx, 972, 98, 892, 340, { fill: P.greenBg, stroke: P.green, lw: 3.5, r: 22, alpha: a2, seed: 303 });
  handPill(ctx, '🔍 预期结果与核验凭证', 1000, 124, { bg: P.green, stroke: P.green, color: '#FFF', size: 22, h: 40, alpha: a2 });
  zhText(ctx, '做到什么才算完成（看页面哪几个信号）：', 1000, 198, { font: FONT_HAND, size: 30, color: P.ink, bold: true, lw: 0.8, alpha: a2 });
  zhParagraph(ctx, cfg.expectedOutput, 1000, 232, 836, { size: 25, lineHeight: 39, color: P.ink2, alpha: a2 });

  // Bottom full-width: Red Stop Conditions & Human Takeover
  handCard(ctx, 56, 466, W - 112, 378, { fill: P.redBg, stroke: P.red, lw: 4, r: 24, alpha: a3, seed: 304 });
  const stopPw = handPill(ctx, '🛑 失败边界 · 停手条件', 88, 496, { bg: P.red, stroke: P.red, color: '#FFF', size: 24, h: 44, alpha: a3 });
  zhText(ctx, cfg.stopHeadline || '遇到下面情况立刻停手，不要硬编或越权承诺：', 88 + stopPw + 20, 518, { font: FONT_HAND, size: 32, color: P.red, bold: true, lw: 0.9, alpha: a3 });
  zhParagraph(ctx, cfg.stopConditions, 88, 564, 1140, { size: 26, lineHeight: 40, color: P.ink, alpha: a3 });

  // Right side inside bottom card: Who takes over + How to verify
  handCard(ctx, 1260, 558, 576, 258, { fill: '#FFFDF8', stroke: P.ink, lw: 3, r: 18, alpha: a3, seed: 305 });
  zhText(ctx, `🤝 接管角色：${cfg.ownerRole || '内部销售 / 对应主管'}`, 1288, 594, { font: FONT_BODY, size: 25, color: P.red, bold: true, lw: 0.8, alpha: a3 });
  zhParagraph(ctx, cfg.takeoverAction, 1288, 626, 520, { size: 24, lineHeight: 36, color: P.ink2, alpha: a3 });

  if (t >= 2.2) {
    stamp(ctx, '严禁瞎猜', 1730, 522, t - 2.2, { color: P.red, size: 38, rot: -0.14 });
  }
}

// Scene Type 5: Clean Closing Checklist (standalone ending for single node)
export function drawSummaryScene(ctx, st, cfg) {
  drawPaperBg(ctx);
  const t = st.t;
  handCard(ctx, 130, 82, W - 260, 742, { fill: P.cream, stroke: P.ink, lw: 4, r: 26, alpha: ease.out(prog(t, 0, 0.45)), seed: 401 });
  const sumPw = handPill(ctx, `${cfg.nodeId} · 本节小结`, 188, 128, { bg: P.green, stroke: P.green, color: '#FFF', size: 24, h: 46 });
  zhText(ctx, cfg.heading || '记住这几条，上岗零失误', 188 + sumPw + 22, 151, { font: FONT_HAND, size: 44, color: P.ink, bold: true, lw: 1.1 });

  (cfg.checklist || []).forEach((item, i) => {
    const dt = 0.4 + i * 0.65;
    const p = ease.outBack(prog(t, dt, dt + 0.45));
    const y = 216 + i * 134;
    if (p > 0.02) {
      handCard(ctx, 188, y, W - 376, 112, { fill: '#FFF', stroke: P.teal, lw: 3, r: 18, alpha: p, seed: 410 + i });
      handPill(ctx, `✓ 要点 ${i + 1}`, 216, y + 32, { bg: P.tealBg, stroke: P.teal, color: P.teal, size: 22, h: 44, alpha: p, seed: 420 + i });
      zhText(ctx, item.title, 366, y + 36, { font: FONT_BODY, size: 28, color: P.ink, bold: true, lw: 0.7, alpha: p });
      zhText(ctx, item.desc, 366, y + 76, { font: FONT_BODY, size: 24, color: P.ink2, alpha: p });
    }
  });

  const aFoot = ease.out(prog(t, 1.8, 2.4));
  if (aFoot > 0.02) {
    zhText(ctx, cfg.outro || '👉 回到工作台本步「？」入口，跟着真实页面实操一遍即可熟练上手', W / 2, 772, {
      font: FONT_HAND, size: 30, color: P.blue, align: 'center', bold: true, lw: 0.8, alpha: aFoot,
    });
  }
}

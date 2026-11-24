// Shared subtle acoustic BGM + UI sound effects for External CS V3 tutorial videos.
// Automatically ducked under Qwen Serena voiceover by engine/mix.mjs.
import * as S from '../../engine/audio/synth.js';

export function buildCsMusic(ac, m, { SECS, DURATION }) {
  const chords = [
    ['F3', 'C4', 'A4'],
    ['D3', 'A3', 'F4'],
    ['Bb2', 'F3', 'D4'],
    ['C3', 'G3', 'E4'],
  ];
  const motif = ['F5', 'A5', 'C6', 'A5', 'G5'];
  const stepSec = 4.0;
  for (let t = 0, i = 0; t < DURATION - 1.0; t += stepSec, i++) {
    const ch = chords[i % chords.length];
    S.pad(ac, m, t, Math.min(t + stepSec, DURATION - 0.5), ch, { v: 0.055, cut: 900, a: 0.9, r: 1.4 });
    S.bass(ac, m, t + 0.06, ch[0].replace('3', '2'), 1.3, 0.11, { cut: 280 });
  }
  for (const sec of SECS) {
    motif.forEach((note, idx) => {
      const nt = sec.start + 0.08 + idx * 0.22;
      if (nt < DURATION - 0.5) {
        S.kalimba(ac, m, nt, note, 0.11, { pan: idx % 2 ? 0.2 : -0.2, decay: 1.2 });
      }
    });
  }
  S.pad(ac, m, Math.max(0, DURATION - 3.0), DURATION, chords[0], { v: 0.075, cut: 1100 });
  S.bell(ac, m, Math.max(0, DURATION - 1.8), 'C6', 0.045, { decay: 2.2 });
}

export function buildCsSfx(ac, m, { SECS, LINES, MARKS, stamps = [] }) {
  SECS.slice(1).forEach((sec) => {
    if (sec.start > 0.35) {
      S.whoosh(ac, m, sec.start - 0.2, 0.4, 0.065, { f0: 460, f1: 2400 });
    }
  });
  Object.entries(LINES).forEach(([, ln], idx) => {
    S.wood(ac, m, ln.at + 0.04, 840 + (idx % 3) * 65, 0.038, { pan: idx % 2 ? 0.14 : -0.14 });
    const mk = MARKS[ln.id] || [];
    mk.slice(1).forEach((mt, mi) => {
      S.burst(ac, m, mt, 0.02, 0.04, { f: 2600 + (mi % 2) * 400, q: 2.0 });
    });
  });
  stamps.forEach((st) => {
    if (st > 0) {
      S.blip(ac, m, st + 0.12, 130, 72, 0.12, 0.2);
      S.burst(ac, m, st + 0.12, 0.05, 0.15, { type: 'lowpass', f: 650, noise: 'brown' });
    }
  });
}

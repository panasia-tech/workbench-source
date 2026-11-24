import { SECS, LINES, MARKS, DURATION } from './layout-main.js';
import {
  s01Intro,
  s02Logic,
  s03GuiMatch,
  s04GuiSend,
  s05Codex,
  s06Summary,
} from './scenes/scenes.js';
export { CAPTIONS } from './captions-main.js';

export const CUT = 'main';
export const TITLE = 'CS-REALSHOT-01 · 三栏极简接待、WMS四关全绿选机与一键实拍直发';
export { DURATION };

const sec = (id) => SECS.find((s) => s.sec === id) || { start: 0, end: 5 };
const S1 = sec('s01');
const S2 = sec('s02');
const S3 = sec('s03');
const S4 = sec('s04');
const S5 = sec('s05');
const S6 = sec('s06');

const rel = (lineId, section) => {
  const ln = LINES[lineId];
  return ln ? Math.max(0, ln.at - section.start) : 0;
};

export const SCENES = [
  { start: 0, end: S2.start, draw: (ctx, t) => s01Intro(ctx, { t: t - S1.start, dur: S2.start - S1.start, LINES, MARKS }) },
  { start: S2.start, end: S3.start, draw: (ctx, t) => s02Logic(ctx, { t: t - S2.start, dur: S3.start - S2.start, LINES, MARKS }, [rel('r03', S2), rel('r04', S2), rel('r05', S2)]) },
  { start: S3.start, end: S4.start, draw: (ctx, t) => s03GuiMatch(ctx, { t: t - S3.start, dur: S4.start - S3.start, LINES, MARKS }, [rel('r06', S3), rel('r07', S3), rel('r08', S3)]) },
  { start: S4.start, end: S5.start, draw: (ctx, t) => s04GuiSend(ctx, { t: t - S4.start, dur: S5.start - S4.start, LINES, MARKS }, [rel('r09', S4), rel('r10', S4)]) },
  { start: S5.start, end: S6.start, draw: (ctx, t) => s05Codex(ctx, { t: t - S5.start, dur: S6.start - S5.start, LINES, MARKS }) },
  { start: S6.start, end: DURATION + 1, draw: (ctx, t) => s06Summary(ctx, { t: t - S6.start, dur: DURATION - S6.start, LINES, MARKS }) },
];

export const OVERLAYS = [];

export const KEYFRAMES = [
  [S1.start + 1.8, 's01', '开场手绘标题卡'],
  [S2.start + 3.5, 's02', '四关全检与阻塞分支'],
  [S3.start + rel('r07', S3) + 0.8, 's03', '右栏选绿灯避灰锁'],
  [S4.start + 1.5, 's04a', '放大看唯一货号条码'],
  [S4.start + rel('r10', S4) + 0.8, 's04b', '蓝按钮一键直发实拍'],
  [S5.start + 2.5, 's05', 'Codex Skill 与停手条件'],
  [S6.start + 2.5, 's06', '三点上岗小结'],
  [DURATION - 0.6, 'end', '独立片尾'],
];

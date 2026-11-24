import { SECS, LINES, MARKS, DURATION } from './layout-main.js';
import { s01Intro, s02Logic, s03GuiGate, s04GuiDesk, s05Codex, s06Summary } from './scenes/scenes.js';
export { CAPTIONS } from './captions-main.js';

export const CUT = 'main';
export const TITLE = 'CS-ONBOARD-01 · 外部新人3关情景通关与三栏极简上岗';
export { DURATION };

const sec = (id) => SECS.find((s) => s.sec === id) || { start: 0, end: 5 };
const S1 = sec('s01'), S2 = sec('s02'), S3 = sec('s03'), S4 = sec('s04'), S5 = sec('s05'), S6 = sec('s06');
const rel = (id, s) => (LINES[id] ? Math.max(0, LINES[id].at - s.start) : 0);

export const SCENES = [
  { start: 0, end: S2.start, draw: (ctx, t) => s01Intro(ctx, { t: t - S1.start, dur: S2.start - S1.start, LINES, MARKS }) },
  { start: S2.start, end: S3.start, draw: (ctx, t) => s02Logic(ctx, { t: t - S2.start, dur: S3.start - S2.start, LINES, MARKS }, [rel('o03', S2), rel('o04', S2), rel('o05', S2)]) },
  { start: S3.start, end: S4.start, draw: (ctx, t) => s03GuiGate(ctx, { t: t - S3.start, dur: S4.start - S3.start, LINES, MARKS }, [rel('o06', S3), rel('o07', S3)]) },
  { start: S4.start, end: S5.start, draw: (ctx, t) => s04GuiDesk(ctx, { t: t - S4.start, dur: S5.start - S4.start, LINES, MARKS }, [rel('o08', S4), rel('o09', S4)]) },
  { start: S5.start, end: S6.start, draw: (ctx, t) => s05Codex(ctx, { t: t - S5.start, dur: S6.start - S5.start, LINES, MARKS }) },
  { start: S6.start, end: DURATION + 1, draw: (ctx, t) => s06Summary(ctx, { t: t - S6.start, dur: DURATION - S6.start, LINES, MARKS }) },
];
export const OVERLAYS = [];
export const KEYFRAMES = [
  [S1.start + 1.8, 's01', '开场标题卡'],
  [S2.start + 4.0, 's02', '保护锁与三栏分支'],
  [S3.start + 1.4, 's03a', '锁定提示条点击'],
  [S3.start + rel('o07', S3) + 1.2, 's03b', '三关沙盒模拟题'],
  [S4.start + 1.4, 's04a', '三栏极简工作台'],
  [S4.start + rel('o09', S4) + 1.2, 's04b', '问号十要素抽屉'],
  [S5.start + 2.5, 's05', 'Skill与越权边界'],
  [DURATION - 0.6, 'end', '上岗三句口诀'],
];

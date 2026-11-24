import { SECS, LINES, MARKS, DURATION } from './layout-main.js';
import { s01Intro, s02Logic, s03GuiGuard, s04GuiKpi, s05Codex, s06Summary } from './scenes/scenes.js';
export { CAPTIONS } from './captions-main.js';
export const CUT = 'main';
export const TITLE = 'CS-GUARD-KPI-04 · 外发合规守卫、防作弊与五防绩效考核口径';
export { DURATION };
const sec = (id) => SECS.find((s) => s.sec === id) || { start: 0, end: 5 };
const S1 = sec('s01'), S2 = sec('s02'), S3 = sec('s03'), S4 = sec('s04'), S5 = sec('s05'), S6 = sec('s06');
const rel = (id, s) => (LINES[id] ? Math.max(0, LINES[id].at - s.start) : 0);
export const SCENES = [
  { start: 0, end: S2.start, draw: (ctx, t) => s01Intro(ctx, { t: t - S1.start, dur: S2.start - S1.start }) },
  { start: S2.start, end: S3.start, draw: (ctx, t) => s02Logic(ctx, { t: t - S2.start, dur: S3.start - S2.start }, [rel('g03', S2), rel('g04', S2), rel('g05', S2)]) },
  { start: S3.start, end: S4.start, draw: (ctx, t) => s03GuiGuard(ctx, { t: t - S3.start, dur: S4.start - S3.start }, [rel('g06', S3), rel('g07', S3)]) },
  { start: S4.start, end: S5.start, draw: (ctx, t) => s04GuiKpi(ctx, { t: t - S4.start, dur: S5.start - S4.start }, [rel('g08', S4), rel('g09', S4)]) },
  { start: S5.start, end: S6.start, draw: (ctx, t) => s05Codex(ctx, { t: t - S5.start, dur: S6.start - S5.start }) },
  { start: S6.start, end: DURATION + 1, draw: (ctx, t) => s06Summary(ctx, { t: t - S6.start, dur: DURATION - S6.start }) },
];
export const OVERLAYS = [];
export const KEYFRAMES = [
  [S1.start + 1.8, 's01', '开场标题卡'],
  [S2.start + 4.2, 's02', '外发防封与反作弊图解'],
  [S3.start + rel('g07', S3) + 1.0, 's03', '手机号拦截与快捷短语'],
  [S4.start + rel('g09', S4) + 1.0, 's04', '五防全维大盘与CSV导出'],
  [S5.start + 2.5, 's05', 'Skill与谐音绕过红线'],
  [DURATION - 0.6, 'end', '小结收尾'],
];

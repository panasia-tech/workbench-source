import { SECS, LINES, MARKS, DURATION } from './layout-main.js';
import { s01Intro, s02Logic, s03GuiAgree, s04GuiPanels, s05Codex, s06Summary } from './scenes/scenes.js';
export { CAPTIONS } from './captions-main.js';
export const CUT = 'main';
export const TITLE = 'CS-WARRANTY-02 · 富阳法院保修激活卡自动触发与发问毫秒熔断';
export { DURATION };
const sec = (id) => SECS.find((s) => s.sec === id) || { start: 0, end: 5 };
const S1 = sec('s01'), S2 = sec('s02'), S3 = sec('s03'), S4 = sec('s04'), S5 = sec('s05'), S6 = sec('s06');
const rel = (id, s) => (LINES[id] ? Math.max(0, LINES[id].at - s.start) : 0);
export const SCENES = [
  { start: 0, end: S2.start, draw: (ctx, t) => s01Intro(ctx, { t: t - S1.start, dur: S2.start - S1.start }) },
  { start: S2.start, end: S3.start, draw: (ctx, t) => s02Logic(ctx, { t: t - S2.start, dur: S3.start - S2.start }, [rel('w03', S2), rel('w04', S2), rel('w05', S2)]) },
  { start: S3.start, end: S4.start, draw: (ctx, t) => s03GuiAgree(ctx, { t: t - S3.start, dur: S4.start - S3.start }, [rel('w06', S3), rel('w07', S3)]) },
  { start: S4.start, end: S5.start, draw: (ctx, t) => s04GuiPanels(ctx, { t: t - S4.start, dur: S5.start - S4.start }, [rel('w08', S4), rel('w09', S4)]) },
  { start: S5.start, end: S6.start, draw: (ctx, t) => s05Codex(ctx, { t: t - S5.start, dur: S6.start - S5.start }) },
  { start: S6.start, end: DURATION + 1, draw: (ctx, t) => s06Summary(ctx, { t: t - S6.start, dur: DURATION - S6.start }) },
];
export const OVERLAYS = [];
export const KEYFRAMES = [
  [S1.start + 1.8, 's01', '开场标题卡'],
  [S2.start + 4.2, 's02', '保修推仓与熔断图解'],
  [S3.start + 1.5, 's03a', '陈工保修卡富阳管辖'],
  [S3.start + rel('w07', S3) + 1.0, 's03b', '同意激活并推仓波次'],
  [S4.start + 1.5, 's04a', '自动发图配置抽屉'],
  [S4.start + rel('w09', S4) + 1.0, 's04b', '自动发货池4列泳道'],
  [S5.start + 2.5, 's05', 'Skill与严禁强发边界'],
  [DURATION - 0.6, 'end', '小结收尾'],
];

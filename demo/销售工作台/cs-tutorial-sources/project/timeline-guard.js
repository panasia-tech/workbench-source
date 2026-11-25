// 外部客服工作台 V3 · CS-GUARD-KPI-04：外发守卫防引流与五防绩效考核
import { DURATION, LINES } from './layout-guard.js';
import { desk, loadAll } from './lib/sup.js';
import { scene } from './scenes/guard.js';
export { CAPTIONS } from './captions-guard.js';
export const CUT = 'guard';
export const TITLE = '外部客服工作台 V3 · 外发防引流拦截与五防考核';
export { DURATION };
export const SCENES = [{ start: 0, end: DURATION + 1, draw: (ctx, t) => { desk(ctx); scene(ctx, t); } }];
export const OVERLAYS = [];
export const KEYFRAMES = [[1.2, 'title', ''], ...Object.entries(LINES).map(([id, l]) => [+(l.at + l.dur * 0.7).toFixed(2), id, ''])];
await loadAll();

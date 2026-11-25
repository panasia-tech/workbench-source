// 外部客服工作台 V3 · CS-TAKEOVER-06：大额砍价转内部销售与排他接管
import { DURATION, LINES } from './layout-takeover.js';
import { desk, loadAll } from './lib/sup.js';
import { scene } from './scenes/takeover.js';
export { CAPTIONS } from './captions-takeover.js';
export const CUT = 'takeover';
export const TITLE = '外部客服工作台 V3 · 砍价超限交给内部销售';
export { DURATION };
export const SCENES = [{ start: 0, end: DURATION + 1, draw: (ctx, t) => { desk(ctx); scene(ctx, t); } }];
export const OVERLAYS = [];
export const KEYFRAMES = [[1.2, 'title', ''], ...Object.entries(LINES).map(([id, l]) => [+(l.at + l.dur * 0.7).toFixed(2), id, ''])];
await loadAll();

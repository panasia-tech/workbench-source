// 外部客服工作台 V3 · CS-REFUND-409-03：退款三步引导与拣货中红屏急停
import { DURATION, LINES } from './layout-refund.js';
import { desk, loadAll } from './lib/sup.js';
import { scene } from './scenes/refund.js';
export { CAPTIONS } from './captions-refund.js';
export const CUT = 'refund';
export const TITLE = '外部客服工作台 V3 · 三步秒退与拣货中红屏急停';
export { DURATION };
export const SCENES = [{ start: 0, end: DURATION + 1, draw: (ctx, t) => { desk(ctx); scene(ctx, t); } }];
export const OVERLAYS = [];
export const KEYFRAMES = [[1.2, 'title', ''], ...Object.entries(LINES).map(([id, l]) => [+(l.at + l.dur * 0.7).toFixed(2), id, ''])];
await loadAll();

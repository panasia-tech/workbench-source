// 外部客服工作台 V3 · CS-ONBOARD-01：新人首日三关练兵与解锁上岗
import { DURATION, LINES } from './layout-onboard.js';
import { desk, loadAll } from './lib/sup.js';
import { scene } from './scenes/onboard.js';
export { CAPTIONS } from './captions-onboard.js';
export const CUT = 'onboard';
export const TITLE = '外部客服工作台 V3 · 新人上岗三关练兵解锁';
export { DURATION };
export const SCENES = [{ start: 0, end: DURATION + 1, draw: (ctx, t) => { desk(ctx); scene(ctx, t); } }];
export const OVERLAYS = [];
export const KEYFRAMES = [[1.2, 'title', ''], ...Object.entries(LINES).map(([id, l]) => [+(l.at + l.dur * 0.7).toFixed(2), id, ''])];
await loadAll();

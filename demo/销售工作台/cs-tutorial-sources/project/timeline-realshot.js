// 外部客服工作台 V3 · CS-REALSHOT-01：发货前挑货与一键发实拍视频
import { SECS, DURATION, LINES } from './layout-realshot.js';
import { desk, loadAll } from './lib/sup.js';
import { scene } from './scenes/realshot.js';
export { CAPTIONS } from './captions-realshot.js';
export const CUT = 'realshot';
export const TITLE = '外部客服工作台 V3 · 发货前挑绿灯真机与一件一拍';
export { DURATION };
export const SCENES = [{ start: 0, end: DURATION + 1, draw: (ctx, t) => { desk(ctx); scene(ctx, t); } }];
export const OVERLAYS = [];
export const KEYFRAMES = [[1.2, 'title', ''], ...Object.entries(LINES).map(([id, l]) => [+(l.at + l.dur * 0.7).toFixed(2), id, ''])];
await loadAll();

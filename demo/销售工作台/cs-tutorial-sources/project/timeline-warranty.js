// 外部客服工作台 V3 · CS-WARRANTY-02：保修激活卡、富阳法院条款与提问暂停
import { DURATION, LINES } from './layout-warranty.js';
import { desk, loadAll } from './lib/sup.js';
import { scene } from './scenes/warranty.js';
export { CAPTIONS } from './captions-warranty.js';
export const CUT = 'warranty';
export const TITLE = '外部客服工作台 V3 · 激活保修与买家提问暂停';
export { DURATION };
export const SCENES = [{ start: 0, end: DURATION + 1, draw: (ctx, t) => { desk(ctx); scene(ctx, t); } }];
export const OVERLAYS = [];
export const KEYFRAMES = [[1.2, 'title', ''], ...Object.entries(LINES).map(([id, l]) => [+(l.at + l.dur * 0.7).toFixed(2), id, ''])];
await loadAll();

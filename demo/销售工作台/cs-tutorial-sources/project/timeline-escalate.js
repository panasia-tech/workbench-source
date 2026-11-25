// 外部客服工作台 V3 · CS-ESCALATE-05：问题订单缺视频与未绑货号一键呼救
import { DURATION, LINES } from './layout-escalate.js';
import { desk, loadAll } from './lib/sup.js';
import { scene } from './scenes/escalate.js';
export { CAPTIONS } from './captions-escalate.js';
export const CUT = 'escalate';
export const TITLE = '外部客服工作台 V3 · 问题订单一键找人处理';
export { DURATION };
export const SCENES = [{ start: 0, end: DURATION + 1, draw: (ctx, t) => { desk(ctx); scene(ctx, t); } }];
export const OVERLAYS = [];
export const KEYFRAMES = [[1.2, 'title', ''], ...Object.entries(LINES).map(([id, l]) => [+(l.at + l.dur * 0.7).toFixed(2), id, ''])];
await loadAll();

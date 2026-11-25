// Minimal headless-Chrome driver for capturing the real sales workbench desktop GUI (127.0.0.1:5341).
// Viewport 1440×900 CSS px (the workbench design baseline), deviceScaleFactor 2 → PNG 2880×1800.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const BASE = process.env.CS_BASE || 'http://127.0.0.1:5391';
export const DPR = 2;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    };
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
}

export async function launch({ w = 1440, h = 900 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales5-'));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--mute-audio', `--window-size=${w},${h}`, '--disable-dev-shm-usage', 'about:blank'], { stdio: 'ignore' });
  const portFile = path.join(dir, 'DevToolsActivePort'); let port = null;
  for (let i = 0; i < 150 && !port; i++) { if (fs.existsSync(portFile)) port = fs.readFileSync(portFile, 'utf8').split('\n')[0] || null; if (!port) await sleep(100); }
  if (!port) throw new Error('Chrome failed to start');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const cdp = new CDP(ws);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: DPR, mobile: false });
  return { cdp, close: async () => { try { ws.close(); } catch {} proc.kill(); await sleep(300); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

export async function settle(cdp, ms = 700) {
  await sleep(ms);
  await cdp.eval(`(async () => { await Promise.all([...document.images].map(i => i.complete ? 0 : new Promise(r => { const t = setTimeout(r, 2500); i.onload = i.onerror = () => { clearTimeout(t); r(); }; }))); return 1; })()`);
  await sleep(200);
}
export async function nav(cdp, hashPath, as = 'chenxm') {
  await cdp.send('Page.navigate', { url: `${BASE}/?as=${as}&skin=light&_=${Date.now()}#${hashPath}` });
  await settle(cdp, 1200);
}
export async function snap(cdp, file) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}
// find visible element whose own trimmed text matches (string = includes, or /regex/) within optional CSS scope; returns rect in CSS px
export const FIND = `
window.__find = (q, sel = 'button,a,[role=tab],input,textarea,label,span,div,h1,h2,h3,h4,p,li,strong,b,td,th,article,section', nth = 0) => {
  const re = q.startsWith('/') ? new RegExp(q.slice(1, q.lastIndexOf('/'))) : null;
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const txt = (e) => (e.placeholder || e.value || e.innerText || '').replace(/\\s+/g, ' ').trim();
  let c = [...document.querySelectorAll(sel)].filter(vis).filter((e) => re ? re.test(txt(e)) : txt(e).includes(q));
  // prefer the deepest (smallest) match
  c = c.filter((e) => !c.some((o) => o !== e && e.contains(o)));
  c.sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return ra.top - rb.top || ra.left - rb.left; });
  return c[nth] || null;
};
window.__rect = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round); };
`;
export async function inject(cdp) { await cdp.eval(FIND + ';1'); }
export async function rectOf(cdp, q, sel, nth = 0) { await inject(cdp); return cdp.eval(`window.__rect(window.__find(${JSON.stringify(q)}, ${sel ? JSON.stringify(sel) : 'undefined'}, ${nth}))`); }
export async function click(cdp, q, sel, nth = 0) {
  await inject(cdp);
  const ok = await cdp.eval(`(() => { const e = window.__find(${JSON.stringify(q)}, ${sel ? JSON.stringify(sel) : 'undefined'}, ${nth}); if (!e) return false; e.scrollIntoView({block:'nearest'}); e.click(); return true; })()`);
  if (!ok) throw new Error('click target not found: ' + q);
  await settle(cdp, 700);
}
export async function type(cdp, q, value, sel = 'input,textarea') {
  await inject(cdp);
  const ok = await cdp.eval(`(() => { const e = window.__find(${JSON.stringify(q)}, ${JSON.stringify(sel)}); if (!e) return false; e.focus();
    const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(value)}); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  if (!ok) throw new Error('input not found: ' + q);
  await settle(cdp, 400);
}
export async function scrollTo(cdp, y, sel) {
  await cdp.eval(`(() => { const el = ${sel ? `document.querySelector(${JSON.stringify(sel)})` : 'null'}; if (el) el.scrollTop = ${y}; else { window.scrollTo(0, ${y}); const m = document.querySelector('main, .main, .content, #app > div'); if (m) m.scrollTop = ${y}; } })()`);
  await settle(cdp, 400);
}
// dump visible clickable / labelled things, for exploring a page
export async function dump(cdp) {
  await inject(cdp);
  return cdp.eval(`(() => {
    const out = []; const seen = new Set();
    for (const e of document.querySelectorAll('button,a,[role=tab],input,textarea,h1,h2,h3,h4,.tag,.chip,.badge')) {
      const r = e.getBoundingClientRect(); if (r.width < 3 || r.height < 3 || r.bottom < 0 || r.top > innerHeight) continue;
      const t = (e.placeholder ? '[ph]' + e.placeholder : (e.innerText || e.value || '')).replace(/\\s+/g, ' ').trim().slice(0, 60);
      const k = t + Math.round(r.left) + Math.round(r.top); if (!t || seen.has(k)) continue; seen.add(k);
      out.push(e.tagName.toLowerCase() + ' ' + [r.left, r.top, r.width, r.height].map(Math.round).join(',') + ' ' + t);
    }
    return out.join('\\n');
  })()`);
}

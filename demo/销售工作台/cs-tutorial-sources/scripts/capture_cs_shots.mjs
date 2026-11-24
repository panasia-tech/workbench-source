import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = process.argv[2] || '/Users/user/Documents/ChatGPT/行政管理/outputs/外部客服V3-独立节点教程与源码-20261124/assets';
const BASE_URL = process.argv[3] || 'http://127.0.0.1:5391';
fs.mkdirSync(OUT_DIR, { recursive: true });

const chromeBin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const udir = '/tmp/cs_shot_chrome_' + Date.now();
fs.mkdirSync(udir, { recursive: true });

const proc = spawn(chromeBin, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-debugging-port=9392',
  `--user-data-dir=${udir}`,
  '--window-size=1440,900',
  'about:blank',
], { stdio: 'ignore' });

async function getWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:9392/json/list');
      const pages = await r.json();
      const p = pages.find((x) => x.type === 'page');
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Chrome CDP timeout');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rectsLog = {};

try {
  const wsUrl = await getWs();
  const ws = new WebSocket(wsUrl);
  await new Promise((res) => ws.addEventListener('open', res, { once: true }));
  let seq = 1;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = seq++;
    const onMsg = (ev) => {
      const d = JSON.parse(ev.data);
      if (d.id === id) {
        ws.removeEventListener('message', onMsg);
        if (d.error) reject(new Error(JSON.stringify(d.error)));
        else resolve(d.result);
      }
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const evalJs = async (expr) => {
    const res = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) {
      throw new Error('JS err: ' + JSON.stringify(res.exceptionDetails));
    }
    return res.result?.value;
  };

  const nav = async (url, ms = 1800) => {
    await call('Page.navigate', { url });
    await wait(ms);
  };

  const clickByText = async (selector, substr) => {
    const ok = await evalJs(`(() => {
      const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
      const el = els.find((e) => (e.innerText || '').replace(/\\s+/g, ' ').includes(${JSON.stringify(substr)}));
      if (!el) return { ok: false, avail: els.map((e) => (e.innerText || '').replace(/\\s+/g, ' ').trim()).slice(0, 20) };
      el.scrollIntoView({ block: 'nearest' });
      el.click();
      return { ok: true, text: (el.innerText || '').replace(/\\s+/g, ' ').trim() };
    })()`);
    await wait(550);
    return ok;
  };

  const snap = async (filename, probes = {}) => {
    await wait(350);
    const { data } = await call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT_DIR, filename), Buffer.from(data, 'base64'));
    const probeRects = await evalJs(`(() => {
      const out = {};
      const specs = ${JSON.stringify(probes)};
      for (const [k, s] of Object.entries(specs)) {
        const els = [...document.querySelectorAll(s.sel || 'button')];
        const el = s.text ? els.find((e) => (e.innerText || '').replace(/\\s+/g, ' ').includes(s.text)) : els[s.idx || 0];
        if (el) {
          const r = el.getBoundingClientRect();
          out[k] = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
        }
      }
      return out;
    })()`);
    rectsLog[filename] = probeRects;
    console.log('SNAP:', filename, JSON.stringify(probeRects));
  };

  // 1 & 2: Newbie locked + 3-level gate practice modal
  await nav(`${BASE_URL}/?as=cs_newbie`, 2000);
  await snap('cs_newbie_locked.png', {
    lock_banner: { sel: '.guard-live-alert.lock', text: '锁定' },
    unlock_btn: { sel: 'button', text: '立即去做 3 关练习解锁' },
    role_pill: { sel: '.duty-pill', text: '周小萌' },
  });
  await clickByText('button', '立即去做 3 关练习解锁');
  await snap('cs_onboard_practice.png', {
    modal: { sel: '.wide-drawer, .modal-card, .practice-card, .onboard-modal, .drawer-backdrop', text: '' },
    opt: { sel: 'button', text: 'A' },
  });

  // 3: Outsource default workspace
  await nav(`${BASE_URL}/?as=outsource_lu`, 2200);
  await snap('cs_outsource_workspace.png', {
    top_kpi: { sel: '.kpi-inline-bar', text: '首响' },
    three_tabs: { sel: '.three-tabs', text: '售前' },
    copilot_cta: { sel: 'button', text: '发实拍图/视频' },
    composer: { sel: '.chat-composer', text: '发送' },
  });

  // 4 & 5: C1 match & realshot gallery + 全检四关 accordion expanded
  await clickByText('.session-row', '林先生8821');
  await clickByText('.fold-head', '全检四关');
  await snap('cs_realshot_c1_match.png', {
    send_cta: { sel: 'button', text: '发实拍图/视频' },
    photo1: { sel: '.photo-item', text: '主机' },
    video_btn: { sel: '.video-btn', text: '通电实拍视频' },
    inspection_fold: { sel: '.fold-head', text: '全检四关' },
    blocked_slot: { sel: '.slot-btn.blocked', text: '阻塞' },
  });
  await clickByText('.photo-item', '主机');
  await wait(450);
  await snap('cs_realshot_gallery.png', {
    lightbox: { sel: '.modal-card, .drawer-backdrop, .lightbox, .img-modal', text: '' },
  });

  // 6 & 7: C2 warranty pre + triggered "同意"
  await nav(`${BASE_URL}/?as=outsource_lu`, 1800);
  await clickByText('.session-row', '陈工');
  await snap('cs_warranty_pre.png', {
    manual_card: { sel: '.q-chip.highlight', text: '手动发场景图' },
    fuyang_msg: { sel: '.msg-row, .chat-body, .card-box', text: '富阳区人民法院' },
    wait_pill: { sel: '.badge, .pill, .status-tag, .conv-pill', text: '同意' },
  });
  await clickByText('.fold-head', '演示测试模拟');
  const simRes = await clickByText('button', '模拟买家回复“同意”');
  console.log('Sim warranty:', simRes);
  if (!simRes.ok) {
    await clickByText('button', '回复“同意”');
  }
  await wait(650);
  await snap('cs_warranty_agree.png', {
    activated_pill: { sel: '.activated-pill, .pill, span, div', text: '已激活' },
  });

  // 8 & 9: 售后 tab C4 refund + C5 409 conflict
  await nav(`${BASE_URL}/?as=outsource_lu`, 1800);
  await clickByText('.tab-btn', '售后');
  await snap('cs_refund_after_c4.png', {
    after_tab: { sel: '.tab-btn.active', text: '售后' },
    refund_cta: { sel: 'button', text: '改对' },
  });
  const c5Click = await clickByText('.session-row', '拣货');
  if (!c5Click.ok) await clickByText('.session-row', 'C5');
  // try clicking second session row in after_sale if still not C5
  await evalJs(`(() => { const rows = [...document.querySelectorAll('.session-row')]; if (rows[1]) rows[1].click(); })()`);
  await wait(550);
  await clickByText('.fold-head', '跨部门协同');
  await clickByText('button', '拦截');
  await wait(550);
  await snap('cs_refund_409_c5.png', {
    wms_409: { sel: '.msg-row, .card-box, .copilot-card, .fold-body', text: '409' },
    intercept_btn: { sel: 'button', text: '拦截' },
  });

  // 10 & 11: 问题订单 tab C6/C7/C8 + escalate
  await nav(`${BASE_URL}/?as=outsource_lu`, 1800);
  await clickByText('.tab-btn', '问题订单');
  await snap('cs_issue_tabs.png', {
    issue_tab: { sel: '.tab-btn.active', text: '问题订单' },
    row0: { sel: '.session-row', text: '' },
  });
  await evalJs(`(() => { const rows = [...document.querySelectorAll('.session-row')]; if (rows[1]) rows[1].click(); })()`);
  await wait(500);
  await clickByText('.fold-head', '跨部门协同');
  await snap('cs_escalate_c6_c7.png', {
    collab_fold: { sel: '.fold-head', text: '跨部门协同' },
    escalate_btn: { sel: 'button', text: '仓管' },
  });

  // 12: Internal sales takeover view chenxm
  await nav(`${BASE_URL}/?as=chenxm#/cs-workbench`, 2200);
  await clickByText('.fold-head', '跨部门协同');
  await snap('cs_takeover_internal.png', {
    internal_bar: { sel: '.internal-banner, .merged-banner, .cs-header, header', text: '陈小满' },
    takeover_btn: { sel: 'button', text: '接管' },
  });

  // 13: Guard red block
  await nav(`${BASE_URL}/?as=outsource_lu`, 1800);
  await evalJs(`(() => {
    const ta = document.querySelector('.chat-composer textarea');
    if (ta) {
      ta.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '加我微信13800138000私下发图');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  await wait(450);
  await snap('cs_guard_red_block.png', {
    red_alert: { sel: '.guard-live-alert', text: '外发守卫实时拦截' },
    send_btn: { sel: '.send-btn', text: '发送' },
  });

  // 14: KPI Drawer
  await nav(`${BASE_URL}/?as=outsource_lu`, 1600);
  await clickByText('button', '全维考核');
  await snap('cs_kpi_drawer.png', {
    drawer: { sel: '.wide-drawer', text: '五防' },
    q_kpi: { sel: '.q-pill', text: '?' },
  });

  // 15: AutoRules Drawer
  await nav(`${BASE_URL}/?as=outsource_lu`, 1600);
  await clickByText('button', '自动发图');
  await snap('cs_autorules_drawer.png', {
    drawer: { sel: '.wide-drawer', text: '自动发图' },
  });

  // 16: AutoShip Drawer
  await nav(`${BASE_URL}/?as=outsource_lu`, 1600);
  await clickByText('button', '自动发货池');
  await snap('cs_autoship_drawer.png', {
    drawer: { sel: '.wide-drawer', text: '自动发货' },
  });

  // 17: HelpDrawer
  await nav(`${BASE_URL}/?as=outsource_lu`, 1600);
  await clickByText('.q-pill', '?');
  await snap('cs_help_drawer.png', {
    help_drawer: { sel: '.drawer, .help-drawer, .wide-drawer, .side-drawer', text: '' },
  });

  // 18: CsTutorialDrawer
  await nav(`${BASE_URL}/?as=outsource_lu`, 1600);
  await clickByText('button', '教程台账');
  await snap('cs_tutorial_drawer.png', {
    tut_drawer: { sel: '.drawer, .tut-drawer, .wide-drawer, .side-drawer', text: '教程' },
  });

  fs.writeFileSync(path.join(OUT_DIR, 'rects.json'), JSON.stringify(rectsLog, null, 2) + '\n', 'utf-8');
  console.log('ALL 18 SHOTS CAPTURED TO:', OUT_DIR);
  ws.close();
} finally {
  proc.kill('SIGKILL');
  await wait(250);
  fs.rmSync(udir, { recursive: true, force: true });
}

import { reactive } from 'vue';
import { apiRequest, getStoredToken, setStoredToken } from '../api/client.js';

export const store = reactive({
  staff: null,
  token: getStoredToken(),
  counts: { today: 0, issue: 0, done: 0 },
  accounts: [],
  reconcileSummary: null,
  hitsCount: 0,
  toasts: [],
  videoModal: { open: false, chapterId: 'ch1', startSec: 0 },
  helpDrawerOpen: false,
  helpPageKey: 'home',
  tourState: { active: false, pageKey: 'home', stepIndex: 0 },
  lightbox: { open: false, title: '', images: [], meta: '' },
  sseSource: null,
});

export function pushToast(message, type = 'info', duration = 4500) {
  const id = `${Date.now()}-${Math.random()}`;
  store.toasts.push({ id, message, type });
  setTimeout(() => {
    const idx = store.toasts.findIndex((t) => t.id === id);
    if (idx >= 0) store.toasts.splice(idx, 1);
  }, duration);
}

export function handleApiError(err, fallback = '操作失败') {
  const msg = err?.message || fallback;
  const level = err?.status === 409 || err?.status === 422 || err?.status === 403 ? 'warn' : 'error';
  pushToast(msg, level, 6500);
}

export function openVideoTutorial(chapterId = 'ch1', startSec = 0) {
  store.videoModal = { open: true, chapterId, startSec };
}

export function openHelpDrawer(pageKey = 'home') {
  store.helpPageKey = pageKey;
  store.helpDrawerOpen = true;
}

export function startPageTour(pageKey = 'home') {
  store.tourState = { active: true, pageKey, stepIndex: 0 };
}

export function openLightbox(title, images, meta = '') {
  store.lightbox = {
    open: true,
    title,
    images: Array.isArray(images) && images.length ? images : ['/evidence/snapshot-description.png'],
    meta,
  };
}

export async function restoreSession() {
  const tok = getStoredToken();
  if (!tok) {
    store.staff = null;
    return null;
  }
  try {
    const res = await apiRequest('/api/auth/me');
    store.staff = res.staff;
    store.token = tok;
    connectSse();
    await refreshGlobalSummary();
    return res.staff;
  } catch {
    setStoredToken('');
    store.token = '';
    store.staff = null;
    return null;
  }
}

export async function loginWithPassword(username, password) {
  const res = await apiRequest('/api/auth/login', {
    method: 'POST',
    body: { username, password },
  });
  setStoredToken(res.token);
  store.token = res.token;
  store.staff = res.staff;
  connectSse();
  await refreshGlobalSummary();
  return res.staff;
}

export function logout() {
  if (store.sseSource) {
    store.sseSource.close();
    store.sseSource = null;
  }
  setStoredToken('');
  store.token = '';
  store.staff = null;
}

export async function refreshGlobalSummary() {
  if (!getStoredToken()) return;
  try {
    const res = await apiRequest('/api/dashboard');
    store.counts = res.data.counts;
    store.accounts = res.data.accounts;
    store.reconcileSummary = res.data.reconcile_summary;
    store.hitsCount = res.data.monitor_stats?.hits_count || 0;
  } catch {
    // ignore background summary refresh errors
  }
}

export function connectSse() {
  if (store.sseSource) store.sseSource.close();
  const tok = getStoredToken();
  if (!tok) return;
  try {
    const es = new EventSource(`/api/events?token=${encodeURIComponent(tok)}`);
    es.addEventListener('monitor:hit', (ev) => {
      try {
        const d = JSON.parse(ev.data);
        pushToast(`🎯 监控新命中 ${d.hits?.length || 1} 条捡漏商品（任务 ${d.task_id}）`, 'info', 4500);
        refreshGlobalSummary();
      } catch {}
    });
    es.addEventListener('warehouse:10m_sla', (ev) => {
      try {
        const d = JSON.parse(ev.data);
        pushToast(`⏱ WIN-BG-03 顺丰派送盯梢：${d.model_name}（${d.waybill}）已秒推仓管 10m 验机！`, 'warn', 6000);
        refreshGlobalSummary();
      } catch {}
    });
    store.sseSource = es;
  } catch {}
}

export function fmtYuan(cents) {
  const n = Number(cents || 0) / 100;
  return `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

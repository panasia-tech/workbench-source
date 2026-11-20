import { reactive } from 'vue';
import { apiGet, apiPost } from './api.js';

export const LV = {
  red: { icon: '✕', text: '现在要办' },
  amb: { icon: '!', text: '跟进中' },
  grn: { icon: '✓', text: '不用管' },
};

export const BUCKET_META = {
  today: {
    key: 'today',
    label: '今天采购的',
    desc: '收货前 6 步：锁原始快照 → 判能否二次议价并给仓管打重点验机标（写几乎全新/图糊绝不追问！）→ 谈价 → 核改价付款 → 仓管按标深检',
  },
  issue: {
    key: 'issue',
    label: '二次议价 · 问题订单',
    desc: '核心利润锚点双轨 9 步陪跑：顺丰派送10m当场拒签加微闪电战 vs 已签收先锁退货等卖家开口/Plan B → 12大心理博弈 → 整单退走T+1对公 → 拿到货10%提成',
  },
  completed: {
    key: 'completed',
    label: '已经完结的',
    desc: '买前差额×10% + 到货实际退回差价×10%（两段独立核算绝不重算，瑕疵沉淀 ERP 供销售自取）已钱货两清的订单',
  },
};

export const store = reactive({
  loading: true,
  error: '',
  actorId: localStorage.getItem('pw_actor_id') || 'liming',
  selectedConvId: localStorage.getItem('pw_conv_id') || 'CONV-001',
  toast: null,
  ui: {
    theme: localStorage.getItem('pw_theme_v3') || 'light', // 默认明亮清爽 C 端风格，与销售工作台一致
    fontLarge: localStorage.getItem('pw_font_large') === 'true',
    tour: null, // { page, i }
    practice: null, // 'chat_guard' | 'price_pay' | 'return_planb' | null
    helpKey: null,
    termKey: null,
    askBossOpen: false,
    devReqOpen: false,
    devReqDefaultPage: '',
  },
  dashboard: {
    roles: [],
    cases: [],
    statement_reconciliation: null,
    account_risk_shield: null,
    quota_pool: null,
    quota_reservations: [],
    discovery_leads: [],
    window_leases: [],
    conversations: [],
    messages: [],
    negotiation_rounds: [],
    pricebook: [],
    policies: [],
    orders: [],
    rpa_events: [],
    aftersales_tickets: [],
    aftersales_bargain_logs: [],
    finance_ledger: [],
    corp_alipay_registrations: [],
    favorite_sellers: [],
    executor_jobs: [],
    item_snapshots: [],
    daily_earnings: null,
    g06_net_costs: [],
    commissions: [],
    audit_logs: [],
    onboarding_progress: {},
    help_requests: [],
    dev_requests: [],
    kpi_meta: null,
    server_time: '',
  },
});

export function applyUiPrefs() {
  const root = document.documentElement;
  if (store.ui.theme === 'dark' || store.ui.theme === 'light') {
    root.setAttribute('data-theme', store.ui.theme);
  } else {
    root.removeAttribute('data-theme');
  }
  if (store.ui.fontLarge) {
    root.setAttribute('data-font', 'large');
  } else {
    root.removeAttribute('data-font');
  }
}

export function setTheme(mode) {
  store.ui.theme = mode;
  localStorage.setItem('pw_theme_v3', mode);
  applyUiPrefs();
}

export function toggleFontLarge() {
  store.ui.fontLarge = !store.ui.fontLarge;
  localStorage.setItem('pw_font_large', String(store.ui.fontLarge));
  applyUiPrefs();
}

export function openHelp(key, triggerEl = null) {
  store.ui._lastHelpTrigger = triggerEl || document.activeElement;
  store.ui.helpKey = key || 'today';
}

export function closeHelp() {
  const el = store.ui._lastHelpTrigger;
  store.ui.helpKey = null;
  if (el && typeof el.focus === 'function') {
    setTimeout(() => el.focus(), 30);
  }
}

export function openTerm(key, triggerEl = null) {
  store.ui._lastTermTrigger = triggerEl || document.activeElement;
  store.ui.termKey = key;
}

export function closeTerm() {
  const el = store.ui._lastTermTrigger;
  store.ui.termKey = null;
  if (el && typeof el.focus === 'function') {
    setTimeout(() => el.focus(), 30);
  }
}

export function myOnboarding() {
  const row = store.dashboard.onboarding_progress?.[store.actorId];
  return row || { chat_guard: 0, price_pay: 0, return_planb: 0, first_order_checklist_done: 0 };
}

export function practiceDoneCount() {
  const p = myOnboarding();
  return [p.chat_guard >= 3, p.price_pay >= 3, p.return_planb >= 3].filter(Boolean).length;
}

export function isPracticeUnlocked() {
  return currentRole().role !== 'purchaser' || practiceDoneCount() >= 3;
}

let toastTimer = null;

export function notify(text, kind = 'ok') {
  store.toast = { text, kind };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    store.toast = null;
  }, 4200);
}

export function currentRole() {
  return (
    store.dashboard.roles.find((r) => r.id === store.actorId) || {
      id: store.actorId,
      name: '李明',
      role: 'purchaser',
      role_label: '采购业务员',
      max_single_cents: 1200000,
    }
  );
}

export function setActor(id) {
  store.actorId = id;
  localStorage.setItem('pw_actor_id', id);
}

export function findCaseByConv(convId) {
  return store.dashboard.cases.find((c) => c.conv_id === convId) || store.dashboard.cases[0] || null;
}

export async function refreshDashboard() {
  store.loading = true;
  store.error = '';
  try {
    const res = await apiGet('./api/dashboard');
    store.dashboard = res.data;
    if (
      store.dashboard.conversations.length > 0 &&
      !store.dashboard.conversations.some((c) => c.conv_id === store.selectedConvId)
    ) {
      store.selectedConvId = store.dashboard.conversations[0].conv_id;
    }
  } catch (e) {
    store.error = '读取本机演示数据失败：' + e.message;
    notify(e.message, 'err');
  } finally {
    store.loading = false;
  }
}

export async function callAction(path, body = {}, successMsg = '') {
  try {
    const res = await apiPost(`.${path}`, { actor_id: store.actorId, ...body });
    await refreshDashboard();
    if (successMsg) notify(successMsg, 'ok');
    return res;
  } catch (e) {
    notify(e.message, 'err');
    throw e;
  }
}

// server/scripts/demo/lib.mjs — Demo seed 公共库：环境加载 + HTTP 客户端（失败重试 1 次）+ 报告累积器
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const envUrl = new URL('../../../.env.local', import.meta.url);
if (existsSync(envUrl)) process.loadEnvFile(envUrl); // Node 22 内置，等价 dotenv（node_modules 未安装也能跑）

function requireEnv(k) {
  const v = process.env[k];
  if (!v) throw new Error(`缺少环境变量 ${k}（请检查项目根 .env.local）`);
  return v;
}

export const env = {
  planeBase: requireEnv('PLANE_BASE_URL'),
  planeKey: requireEnv('PLANE_API_KEY'),
  ws: process.env.PLANE_WORKSPACE_SLUG || 'panasia',
  frappeBase: requireEnv('FRAPPE_BASE_URL'),
  frappeKey: requireEnv('FRAPPE_API_KEY'),
  frappeSecret: requireEnv('FRAPPE_API_SECRET'),
};

const planeHeaders = () => ({ 'X-API-Key': env.planeKey, 'Content-Type': 'application/json' });
const frappeHeaders = () => ({ Authorization: `token ${env.frappeKey}:${env.frappeSecret}`, 'Content-Type': 'application/json' });

export function log(msg) {
  console.log(msg);
}

export function brief(e) {
  const status = e?.status ?? '?';
  const body = String(e?.body ?? e?.message ?? '').slice(0, 300).replace(/\s+/g, ' ');
  return `HTTP ${status}: ${body}`;
}

async function once(url, method, headers, body) {
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, ok: res.ok, data, text };
}

function httpError(label, r) {
  const e = new Error(`${label} 失败: ${brief({ status: r.status, body: r.text })}`);
  e.status = r.status;
  e.body = r.text;
  return e;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastReqAt = 0;

async function request(url, method, headers, body, label) {
  let last = null;
  for (let i = 0; i < 6; i += 1) {
    const gap = Date.now() - lastReqAt;
    if (gap < 250) await sleep(250 - gap);
    try {
      last = await once(url, method, headers, body);
      lastReqAt = Date.now();
    } catch (netErr) {
      last = { status: 0, ok: false, text: String(netErr), data: null };
      if (i < 5) { log(`  [重试] ${label} 网络错误: ${netErr}`); await sleep(1000 * (i + 1)); continue; }
      throw httpError(label, last);
    }
    if (last.ok) return last.data;
    if (last.status === 0 || last.status === 429 || last.status >= 500) {
      if (i < 5) {
        const wait = Math.min(30000, 2000 * 2 ** i);
        log(`  [退避] ${label} HTTP ${last.status}，等 ${Math.round(wait / 1000)}s 后重试`);
        await sleep(wait);
        continue;
      }
    }
    break; // 其它 4xx：不重试
  }
  throw httpError(label, last);
}

// ---- Plane（path 相对 /workspaces/{slug}）----
export const plane = {
  get: (p) => request(`${env.planeBase}/workspaces/${env.ws}${p}`, 'GET', planeHeaders(), undefined, `GET ${p}`),
  post: (p, body) => request(`${env.planeBase}/workspaces/${env.ws}${p}`, 'POST', planeHeaders(), body, `POST ${p}`),
  patch: (p, body) => request(`${env.planeBase}/workspaces/${env.ws}${p}`, 'PATCH', planeHeaders(), body, `PATCH ${p}`),
  delete: (p) => request(`${env.planeBase}/workspaces/${env.ws}${p}`, 'DELETE', planeHeaders(), undefined, `DELETE ${p}`),
};

// ---- Frappe（REST resource / method）----
function qs({ filters, fields, limit } = {}) {
  const q = new URLSearchParams();
  if (filters) q.set('filters', JSON.stringify(filters));
  if (fields) q.set('fields', JSON.stringify(fields));
  q.set('limit_page_length', String(limit ?? 0)); // 0 = 不分页
  return q.toString();
}

export const frappe = {
  list: async (dt, opt = {}) => {
    const raw = await request(`${env.frappeBase}/resource/${dt}?${qs(opt)}`, 'GET', frappeHeaders(), undefined, `LIST ${dt}`);
    const rows = raw?.data ?? raw ?? [];
    return Array.isArray(rows) ? rows : [];
  },
  get: async (dt, name) => {
    const raw = await request(`${env.frappeBase}/resource/${dt}/${encodeURIComponent(name)}`, 'GET', frappeHeaders(), undefined, `GET ${dt} ${name}`);
    return raw?.data ?? raw;
  },
  post: async (dt, body) => {
    const raw = await request(`${env.frappeBase}/resource/${dt}`, 'POST', frappeHeaders(), body, `POST ${dt}`);
    return raw?.data ?? raw;
  },
  put: async (dt, name, body) => {
    const raw = await request(`${env.frappeBase}/resource/${dt}/${encodeURIComponent(name)}`, 'PUT', frappeHeaders(), body, `PUT ${dt} ${name}`);
    return raw?.data ?? raw;
  },
  delete: async (dt, name) =>
    request(`${env.frappeBase}/resource/${dt}/${encodeURIComponent(name)}`, 'DELETE', frappeHeaders(), undefined, `DELETE ${dt} ${name}`),
  method: async (name, params) => {
    const raw = await request(`${env.frappeBase}/method/${name}`, 'POST', frappeHeaders(), params, `method ${name}`);
    return raw?.message ?? raw;
  },
};

// ---- 通用小工具 ----
export const asList = (d) => (Array.isArray(d) ? d : (d?.results ?? []));
export const docName = (d) => d?.name ?? d?.data?.name ?? null;

export async function tryCreate(dt, bodyVariants, label) {
  const errs = [];
  for (const body of bodyVariants) {
    try {
      const d = await frappe.post(dt, body);
      log(`  + ${label} → ${docName(d)}`);
      return d;
    } catch (e) {
      errs.push(brief(e));
    }
  }
  throw new Error(`${label} 全部尝试均失败：${errs.join(' | ')}`);
}

export function workdays(from, to) {
  const out = [];
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  for (let d = new Date(y1, m1 - 1, d1), end = new Date(y2, m2 - 1, d2); d <= end; d.setDate(d.getDate() + 1)) {
    const w = d.getDay();
    if (w >= 1 && w <= 5) out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}

// ---- 报告累积器（seed 与 wipe 共用结构）----
export const R = {
  startedAt: new Date().toISOString(),
  memberPath: null,
  planeMemberIds: null,
  plane: { projects: {}, invited: [], issueIds: {} },
  frappe: {
    company: null,
    employees: {},
    appraisal: null,
    goal: null,
    salaryStructure: null,
    salarySlip: null,
    leaveApplication: null,
    created: {
      company: null, departments: [], designations: [], leaveType: null,
      salaryComponents: [], appraisalCycle: null, payrollPeriod: null,
      member: null, kras: [], courses: [], quizzes: [], salaryStructure: null,
    },
  },
  fallbacks: [],
  notes: [],
  failures: [],
  verification: {},
};

// ---- Plane 状态保障（与 server/modules/integration/plane-mapping.ts 的映射规则一致）----
const KW = { BLOCKED: 'block', READY_FOR_REVIEW: 'review', WAITING: 'wait', REJECTED: 'reject' };
const KW_LIST = Object.values(KW);
const slugHasKw = (slug) => KW_LIST.some((k) => (slug || '').toLowerCase().includes(k));

export async function ensureStates(pid, states) {
  const sem = {};
  sem.TODO = states.find((s) => s.group === 'unstarted' && !slugHasKw(s.slug));
  sem.IN_PROGRESS = states.find((s) => s.group === 'started' && !slugHasKw(s.slug));
  sem.DONE = states.find((s) => s.group === 'completed');
  sem.CANCELLED = states.find((s) => s.group === 'cancelled');
  for (const [key, kw] of Object.entries(KW)) {
    let st = states.find((s) => (s.slug || '').toLowerCase().includes(kw));
    if (!st) {
      const def = { BLOCKED: ['Blocked', 'started', '#ef4444'], READY_FOR_REVIEW: ['In Review', 'started', '#8b5cf6'], WAITING: ['Waiting', 'started', '#f59e0b'], REJECTED: ['Rejected', 'started', '#dc2626'] }[key];
      st = await plane.post(`/projects/${pid}/states/`, { name: def[0], group: def[1], color: def[2] });
      let fresh = asList(await plane.get(`/projects/${pid}/states/`)).find((s) => s.id === st.id) ?? st;
      if (!slugHasKw(fresh.slug)) {
        try { await plane.patch(`/projects/${pid}/states/${st.id}/`, { slug: kw }); } catch { /* 保持默认 slug */ }
        fresh = asList(await plane.get(`/projects/${pid}/states/`)).find((s) => s.id === st.id) ?? fresh;
      }
      states.push(fresh);
      st = fresh;
    }
    sem[key] = st;
  }
  for (const k of ['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED', 'BLOCKED', 'READY_FOR_REVIEW', 'WAITING', 'REJECTED']) {
    if (!sem[k]) throw new Error(`项目 ${pid} 缺少可映射状态：${k}`);
  }
  return Object.fromEntries(Object.entries(sem).map(([k, v]) => [k, v.id]));
}

export async function allIssues(pid) {
  const out = [];
  let offset = 0;
  for (;;) {
    const raw = await plane.get(`/projects/${pid}/issues/?limit=100&offset=${offset}`);
    const rows = asList(raw);
    out.push(...rows);
    if (rows.length < 100) return out;
    offset += 100;
  }
}

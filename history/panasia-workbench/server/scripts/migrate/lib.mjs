// server/scripts/migrate/lib.mjs — 教程搬到 Learning（B5）两个脚本的公共库：
// 读 .env.local（已有的环境变量优先）、参数解析、Frappe / NocoBase 客户端、标题比对。
// 凭证全走环境变量：FRAPPE_BASE_URL / FRAPPE_API_KEY / FRAPPE_API_SECRET，
// NOCOBASE_BASE_URL / NOCOBASE_AUTHENTIK_UID / NOCOBASE_AUTHENTIK_EMAIL（只有搬迁脚本读 NocoBase 时要）。
import { existsSync } from 'node:fs';

const envUrl = new URL('../../../.env.local', import.meta.url);
if (existsSync(envUrl)) process.loadEnvFile(envUrl);

/** 方案 1.4 的 11 个字段；只读（Learning 里只看，改在工作台），编号类不随复制带走 */
export const PA_FIELDS = [
  { dt: 'LMS Course', fieldname: 'pa_code', fieldtype: 'Data', label: '工作台教程编号', insert_after: 'category', no_copy: 1,
    description: '有值 = 泛亚工作台维护的岗位教程（迁移来的是 nocobase-<id>-<code>）；请到工作台修改' },
  { dt: 'Course Chapter', fieldname: 'pa_description', fieldtype: 'Small Text', label: '阶段说明（工作台）', insert_after: 'course_title' },
  { dt: 'Course Chapter', fieldname: 'pa_duration_note', fieldtype: 'Data', label: '预计用时（工作台）', insert_after: 'pa_description' },
  { dt: 'Course Lesson', fieldname: 'pa_step_key', fieldtype: 'Data', unique: 1, label: '步骤编号（工作台）', insert_after: 'course', no_copy: 1,
    description: '工作台按它认步骤、挂提交记录，别改' },
  { dt: 'Course Lesson', fieldname: 'pa_guide', fieldtype: 'Long Text', label: '操作指引（工作台）', insert_after: 'pa_step_key' },
  { dt: 'Course Lesson', fieldname: 'pa_warn_text', fieldtype: 'Small Text', label: '易错提醒（工作台）', insert_after: 'pa_guide' },
  { dt: 'Course Lesson', fieldname: 'pa_deliver_note', fieldtype: 'Small Text', label: '交付标准（工作台）', insert_after: 'pa_warn_text' },
  { dt: 'Course Lesson', fieldname: 'pa_video_url', fieldtype: 'Small Text', label: '实操视频（工作台）', insert_after: 'pa_deliver_note' },
  { dt: 'Course Lesson', fieldname: 'pa_require_review', fieldtype: 'Check', label: '要老板审核（工作台）', insert_after: 'pa_video_url' },
  { dt: 'Course Lesson', fieldname: 'pa_require_confirm', fieldtype: 'Check', label: '要勾选确认（工作台）', insert_after: 'pa_require_review' },
  { dt: 'Course Lesson', fieldname: 'pa_materials', fieldtype: 'JSON', label: '要交的材料（工作台）', insert_after: 'pa_require_confirm',
    description: '数组，每项 {key, label, inputType, required, options, helpText}，顺序即排序' },
];

/** 迁移和工作台新建的教程课都放这个分类（只给人看；工作台判断是不是教程只看 pa_code） */
export const TUTORIAL_CATEGORY = '岗位教程';

export function log(message = '') {
  console.log(message);
}

/** --flag 布尔；--key value / --key=value 取值 */
export function parseArgs(argv, valueKeys = []) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) {
      args._.push(raw);
      continue;
    }
    const [key, inline] = raw.slice(2).split(/=(.*)/s);
    if (valueKeys.includes(key)) {
      args[key] = inline ?? argv[i + 1];
      if (inline === undefined) i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}（写进 panasia-workbench/.env.local 或直接 export）`);
  return value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Frappe 报错整理成一句话：_server_messages > exception > HTTP 状态 */
function frappeMessage(status, data, text) {
  if (data && typeof data._server_messages === 'string') {
    try {
      const list = JSON.parse(data._server_messages);
      const first = JSON.parse(list[0]);
      return String(first?.message ?? first).replace(/<[^>]+>/g, '').trim();
    } catch {
      // 解不开往下走
    }
  }
  if (data && typeof data.exception === 'string') return data.exception.slice(0, 300);
  if (data && typeof data.message === 'string') return data.message.slice(0, 300);
  return `HTTP ${status} ${String(text ?? '').slice(0, 200)}`;
}

export class HttpError extends Error {
  constructor(label, status, data, text) {
    super(`${label}：${frappeMessage(status, data, text)}`);
    this.status = status;
    this.excType = data?.exc_type ?? null;
  }
}

let lastRequestAt = 0;

/** 一次 HTTP：节流 150ms；网络错误、429、5xx 退避重试 3 次，其余 4xx 直接抛 */
async function httpJson(url, { method = 'GET', headers = {}, body, label }) {
  let last = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const gap = Date.now() - lastRequestAt;
    if (gap < 150) await sleep(150 - gap);
    lastRequestAt = Date.now();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Accept: 'application/json', ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      last = new HttpError(label, 0, null, String(error));
      await sleep(1000 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.ok) return data;
    last = new HttpError(label, res.status, data, text);
    if (res.status === 429 || res.status >= 500) {
      await sleep(Math.min(15_000, 1500 * 2 ** attempt));
      continue;
    }
    break;
  }
  throw last;
}

/** Frappe REST：/api/resource 与 /api/method */
export function frappeClient() {
  const base = (process.env.FRAPPE_BASE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
  const auth = `token ${requireEnv('FRAPPE_API_KEY')}:${requireEnv('FRAPPE_API_SECRET')}`;
  const headers = { Authorization: auth };
  const resource = (doctype, name) =>
    `${base}/resource/${encodeURIComponent(doctype)}${name === undefined ? '' : `/${encodeURIComponent(name)}`}`;
  return {
    base,
    siteUrl: base.replace(/\/api$/, ''),
    async list(doctype, fields) {
      const query = new URLSearchParams({ limit_page_length: '0' });
      if (fields) query.set('fields', JSON.stringify(fields));
      const data = await httpJson(`${resource(doctype)}?${query}`, { headers, label: `读 ${doctype}` });
      return Array.isArray(data?.data) ? data.data : [];
    },
    async get(doctype, name) {
      try {
        const data = await httpJson(resource(doctype, name), { headers, label: `读 ${doctype} ${name}` });
        return data?.data ?? null;
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) return null;
        throw error;
      }
    },
    async create(doctype, body) {
      const data = await httpJson(resource(doctype), { method: 'POST', headers, body, label: `建 ${doctype}` });
      return data?.data ?? data;
    },
    async update(doctype, name, body) {
      const data = await httpJson(resource(doctype, name), { method: 'PUT', headers, body, label: `改 ${doctype} ${name}` });
      return data?.data ?? data;
    },
    async method(name, params = {}, httpMethod = 'POST') {
      if (httpMethod === 'GET') {
        const query = new URLSearchParams(
          Object.entries(params).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]),
        );
        const data = await httpJson(`${base}/method/${name}?${query}`, { headers, label: name });
        return data?.message ?? null;
      }
      const data = await httpJson(`${base}/method/${name}`, { method: 'POST', headers, body: params, label: name });
      return data?.message ?? null;
    },
  };
}

/**
 * NocoBase：Authentik 头换 JWT（同工作台以前的 NocoBaseService）。list 只用分页、不用 filter：
 * NocoBase 的 :list filter 不生效、pageSize>20 不一定生效（老坑），按 20 一页翻到空为止，再按 id 去重、和 meta.count 对数
 */
export function nocobaseClient() {
  const base = (process.env.NOCOBASE_BASE_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
  const uid = requireEnv('NOCOBASE_AUTHENTIK_UID');
  const email = requireEnv('NOCOBASE_AUTHENTIK_EMAIL');
  let token = null;
  async function signIn() {
    const data = await httpJson(`${base}/api/auth:signIn`, {
      method: 'POST',
      headers: { 'X-Authenticator': 'panasia-authentik', 'x-authentik-uid': uid, 'x-authentik-email': email },
      body: {},
      label: 'NocoBase 登录',
    });
    token = data?.data?.token;
    if (!token) throw new Error('NocoBase 登录没拿到 token');
  }
  return {
    base,
    async listAll(collection) {
      if (!token) await signIn();
      const PAGE_SIZE = 20;
      const byId = new Map();
      let reportedCount = null;
      let relogins = 0;
      for (let page = 1; page <= 500; page += 1) {
        const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), sort: 'id' });
        let data;
        try {
          data = await httpJson(`${base}/api/${collection}:list?${query}`, {
            headers: { Authorization: `Bearer ${token}` },
            label: `读 NocoBase ${collection} 第 ${page} 页`,
          });
        } catch (error) {
          if (error instanceof HttpError && error.status === 401 && relogins < 2) {
            relogins += 1;
            await signIn();
            page -= 1;
            continue;
          }
          throw error;
        }
        const rows = Array.isArray(data?.data) ? data.data : [];
        if (typeof data?.meta?.count === 'number') reportedCount = data.meta.count;
        if (rows.length === 0) break;
        const fresh = rows.filter((row) => !byId.has(row.id));
        if (fresh.length === 0) {
          throw new Error(`NocoBase ${collection} 第 ${page} 页和前面的重复（分页没生效？），停下来别用这份导出`);
        }
        for (const row of fresh) byId.set(row.id, row);
        if (rows.length < PAGE_SIZE) break;
      }
      const rows = [...byId.values()].sort((a, b) => a.id - b.id);
      if (reportedCount !== null && reportedCount !== rows.length) {
        throw new Error(`NocoBase ${collection} 导出 ${rows.length} 条，和它自己报的总数 ${reportedCount} 对不上，停下来查`);
      }
      return rows;
    },
  };
}

/** 标题比对用：去掉空白和标点符号、全角转半角、小写 */
export function normTitle(title) {
  return String(title ?? '')
    .normalize('NFKC')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .toLowerCase();
}

/** 疑似同名：去掉空格标点后一边包含另一边（太短的只认完全相等，免得「教程」这种两个字到处撞） */
export function titlesMatch(a, b) {
  const x = normTitle(a);
  const y = normTitle(b);
  if (x === '' || y === '') return false;
  if (x.length < 4 || y.length < 4) return x === y;
  return x.includes(y) || y.includes(x);
}

/** sort 升序、同 sort 按 id */
export function bySortId(a, b) {
  return (a.sort ?? 0) - (b.sort ?? 0) || a.id - b.id;
}

export function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

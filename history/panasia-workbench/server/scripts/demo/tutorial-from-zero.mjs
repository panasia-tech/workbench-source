#!/usr/bin/env node
// server/scripts/demo/tutorial-from-zero.mjs — 学习中心演示案例：
// 为当前用户生成「协助客户开设网店 · 从零到一」案例（project 2，11 步）
// 默认 fresh = 0 进度（无提交、in_progress、第一步 active），供用户从零到一完整体验；
// 传 done 参数 = 全流程已完成重建。幂等：先删旧 case（何春荣 / 从零到一）及其 submissions 再重建。
// 产物：tutorial-from-zero-report.json
import { existsSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { URL } from 'node:url';

const envUrl = new URL('../../../.env.local', import.meta.url);
if (existsSync(envUrl)) process.loadEnvFile(envUrl);

const BASE = (process.env.NOCOBASE_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const UID = process.env.NOCOBASE_AUTHENTIK_UID || '';
const EMAIL = process.env.NOCOBASE_AUTHENTIK_EMAIL || '';
if (!UID || !EMAIL) throw new Error('缺少 NOCOBASE_AUTHENTIK_UID / NOCOBASE_AUTHENTIK_EMAIL（检查 .env.local）');

  const OWNER_USER_ID = '1871790158440555';
  const CLIENT_NAME = '从零到一';
  const LEGACY_CLIENT_NAMES = ['何春荣', '从零到一'];
const PROJECT_ID = 2;
const FINAL_STAGE_ID = 7;
const START = Date.UTC(2026, 8, 14); // 09-14 起，每天 1 步，11 步至 09-24
// 用法：node tutorial-hechunrong.mjs [fresh]
// fresh = 进度 0 重建（无提交、in_progress）；默认 = 全流程已完成重建
  const FRESH = process.argv[2] !== 'done';

const RESULT = { at: new Date().toISOString(), steps: [] };
const note = (step, ok, detail) => {
  RESULT.steps.push({ step, ok, detail });
  console.log(`  ${ok ? '√' : '×'} ${step}${detail ? `：${String(detail).slice(0, 200)}` : ''}`);
};

let token = null;
async function signIn() {
  const res = await fetch(`${BASE}/api/auth:signIn`, {
    method: 'POST',
    headers: {
      'X-Authenticator': 'panasia-authentik',
      'x-authentik-uid': UID,
      'x-authentik-email': EMAIL,
    },
  });
  if (!res.ok) throw new Error(`signIn ${res.status}`);
  const body = await res.json();
  token = body.data.token;
}

async function nb(method, path, { params, data, retried = false } = {}) {
  const search = params ? `?${new URLSearchParams(params).toString()}` : '';
  const res = await fetch(`${BASE}/api/${path}${search}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(data ? { 'Content-Type': 'application/json' } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  if (res.status === 401 && !retried) {
    await signIn();
    return nb(method, path, { params, data, retried: true });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

const list = (collection, filter) =>
  nb('POST', `${collection}:list`, {
    params: { pageSize: '200', filter: JSON.stringify(filter) },
  }).then((b) => b.data ?? []);
const create = (collection, values) =>
  nb('POST', `${collection}:create`, { data: values }).then((b) => b.data ?? b);
const destroy = (collection, filter) =>
  nb('POST', `${collection}:destroy`, { params: { filter: JSON.stringify(filter) }, data: {} });

const main = async () => {
  console.log('登录 NocoBase 教程中心…');
  await signIn();
  note('signIn', true, BASE);

  for (const name of LEGACY_CLIENT_NAMES) {
    const existing = await list('tutorial_cases', { client_name: name });
    for (const c of existing) {
      await destroy('tutorial_step_submissions', { case_id: c.id });
      await destroy('tutorial_cases', { id: c.id });
      note(`清理旧案例 #${c.id}`, true, `${name} submissions 已删`);
    }
  }

  await destroy('tutorial_step_submissions', { case_id: null });
  note('清理孤儿提交', true, 'case_id 为空的提交');

  const kase = await create('tutorial_cases', {
    project_id: PROJECT_ID,
    client_name: CLIENT_NAME,
    owner_user_id: OWNER_USER_ID,
    status: FRESH ? 'in_progress' : 'completed',
    current_stage_id: FRESH ? null : FINAL_STAGE_ID,
  });
  note(
    '创建案例',
    true,
    `id=${kase.id} client=${kase.client_name} status=${kase.status} 进度=${FRESH ? '0%' : '100%'}`,
  );

  const stages = await list('tutorial_stages', { project_id: PROJECT_ID });
  const stageIds = new Set(stages.map((s) => s.id));
  const allSteps = await list('tutorial_steps', {});
  const targetStepIds = allSteps
    .filter((s) => stageIds.has(s.stage_id))
    .map((s) => s.id)
    .sort((a, b) => a - b);
  if (targetStepIds.length !== 11) throw new Error(`步骤数量异常：${targetStepIds.length}（预期 11）`);

  for (let i = 0; !FRESH && i < targetStepIds.length; i += 1) {
    const day = new Date(START + i * 86400000);
    const dayStr = day.toISOString().slice(0, 10);
    const row = await create('tutorial_step_submissions', {
      case_id: kase.id,
      step_id: targetStepIds[i],
      status: 'approved',
      submitted_at: `${dayStr}T02:00:00.000Z`,
      reviewed_at: `${dayStr}T08:30:00.000Z`,
      submitted_by: OWNER_USER_ID,
      reviewer_id: UID,
      data: {},
    });
    note(`提交 step ${targetStepIds[i]}`, true, `${dayStr} approved #${row.id}`);
  }

  const finalCase = (await list('tutorial_cases', { id: kase.id }))[0];
  const finalSubs = await list('tutorial_step_submissions', { case_id: kase.id });
  const approved = finalSubs.filter((s) => s.status === 'approved').length;
  const expectedStatus = FRESH ? 'in_progress' : 'completed';
  const expectedApproved = FRESH ? 0 : 11;
  note(
    '回查',
    finalCase.status === expectedStatus && approved === expectedApproved,
    `case=${finalCase.status} submissions=${finalSubs.length} approved=${approved}`,
  );

  writeFileSync(new URL('./tutorial-from-zero-report.json', import.meta.url), JSON.stringify(RESULT, null, 2));
  const failed = RESULT.steps.filter((s) => !s.ok);
  console.log(
    failed.length === 0
      ? `完成：从零到一案例已生成（${FRESH ? '0 进度' : '全流程完成'}）`
      : `存在 ${failed.length} 个失败步骤，见 report`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
};

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});

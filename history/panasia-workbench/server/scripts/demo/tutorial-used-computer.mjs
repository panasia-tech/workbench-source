#!/usr/bin/env node
// server/scripts/demo/tutorial-used-computer.mjs — 创建《二手电脑上架》教程（project/stages/steps/materials + 用户案例）
// 幂等：按 project code=used-computer-resale 干净重建（清理旧 case/submissions/materials/steps/stages/project）
// 产物：tutorial-used-computer-report.json
import { existsSync, writeFileSync } from 'node:fs';
import { URL } from 'node:url';
import { PROJECT, STAGES, CASE } from './tutorial-used-computer-data.mjs';

const envUrl = new URL('../../../.env.local', import.meta.url);
if (existsSync(envUrl)) process.loadEnvFile(envUrl);

const BASE = (process.env.NOCOBASE_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const UID = process.env.NOCOBASE_AUTHENTIK_UID || '';
const EMAIL = process.env.NOCOBASE_AUTHENTIK_EMAIL || '';
if (!UID || !EMAIL) throw new Error('缺少 NOCOBASE_AUTHENTIK_UID / NOCOBASE_AUTHENTIK_EMAIL（检查 .env.local）');

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
  nb('POST', `${collection}:destroy`, {
    params: { filter: JSON.stringify(filter) },
    data: {},
  });

const cleanupLegacy = async () => {
  const projects = await list('tutorial_projects', { code: PROJECT.code });
  if (projects.length === 0) {
    note('清理旧数据', true, '无历史版本，跳过');
    return;
  }
  for (const project of projects) {
    const stages = await list('tutorial_stages', { project_id: project.id });
    const stageIds = stages.map((s) => s.id);
    const cases = await list('tutorial_cases', { project_id: project.id });
    for (const c of cases) {
      await destroy('tutorial_step_submissions', { case_id: c.id });
      await destroy('tutorial_cases', { id: c.id });
    }
    if (stageIds.length > 0) {
      const steps = await list('tutorial_steps', { stage_id: { $in: stageIds } });
      const stepIds = steps.map((s) => s.id);
      if (stepIds.length > 0) {
        await destroy('tutorial_step_materials', { step_id: { $in: stepIds } });
      }
      await destroy('tutorial_steps', { stage_id: { $in: stageIds } });
    }
    await destroy('tutorial_stages', { project_id: project.id });
    await destroy('tutorial_projects', { id: project.id });
    note(
      `清理旧数据 #${project.id}`,
      true,
      `cases=${cases.length} stages=${stages.length} 已删`,
    );
  }
};

const main = async () => {
  console.log('登录 NocoBase 教程中心…');
  await signIn();
  note('signIn', true, BASE);

  await cleanupLegacy();

  const project = await create('tutorial_projects', PROJECT);
  note('创建教程项目', true, `id=${project.id} ${project.name}`);

  let stepCount = 0;
  let materialCount = 0;
  for (let i = 0; i < STAGES.length; i += 1) {
    const stageDef = STAGES[i];
    const stage = await create('tutorial_stages', {
      project_id: project.id,
      title: stageDef.title,
      description: stageDef.description,
      duration_note: stageDef.duration_note,
      sort: i + 1,
    });
    note(`阶段 ${i + 1}`, true, `id=${stage.id} ${stage.title}`);

    for (let j = 0; j < stageDef.steps.length; j += 1) {
      const stepDef = stageDef.steps[j];
      const step = await create('tutorial_steps', {
        stage_id: stage.id,
        title: stepDef.title,
        guide: stepDef.guide,
        video_url: null,
        warn_text: stepDef.warn_text,
        deliver_note: stepDef.deliver_note,
        require_confirm: stepDef.require_confirm,
        require_review: stepDef.require_review,
        sort: j + 1,
      });
      stepCount += 1;
      for (let k = 0; k < stepDef.materials.length; k += 1) {
        const materialDef = stepDef.materials[k];
        await create('tutorial_step_materials', {
          step_id: step.id,
          material_key: materialDef.material_key,
          label: materialDef.label,
          input_type: materialDef.input_type,
          required: materialDef.required,
          options: [],
          help_text: materialDef.help_text,
          sort: k + 1,
        });
        materialCount += 1;
      }
    }
  }
  note(
    '写入步骤与材料',
    true,
    `stages=${STAGES.length} steps=${stepCount} materials=${materialCount}`,
  );

  const kase = await create('tutorial_cases', {
    project_id: project.id,
    client_name: CASE.client_name,
    owner_user_id: CASE.owner_user_id,
    status: 'in_progress',
    current_stage_id: null,
  });
  note('创建案例', true, `id=${kase.id} owner=${kase.owner_user_id} status=${kase.status}`);

  const finalProject = (await list('tutorial_projects', { code: PROJECT.code }))[0];
  const finalStages = await list('tutorial_stages', { project_id: project.id });
  const finalCases = await list('tutorial_cases', { project_id: project.id });
  const ok =
    finalProject != null &&
    finalStages.length === STAGES.length &&
    finalCases.length === 1;
  note(
    '回查',
    ok,
    `project=${finalProject?.id} stages=${finalStages.length} cases=${finalCases.length}`,
  );

  writeFileSync(
    new URL('./tutorial-used-computer-report.json', import.meta.url),
    JSON.stringify(RESULT, null, 2),
  );
  const failed = RESULT.steps.filter((s) => !s.ok);
  console.log(
    failed.length === 0
      ? `完成：二手电脑上架教程已生成（${STAGES.length} 阶段 / ${stepCount} 步 / ${materialCount} 材料）`
      : `存在 ${failed.length} 个失败步骤，见 report`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
};

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});

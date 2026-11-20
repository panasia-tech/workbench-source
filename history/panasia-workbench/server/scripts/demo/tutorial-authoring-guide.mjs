#!/usr/bin/env node
// server/scripts/demo/tutorial-authoring-guide.mjs — 创建元教程《教程制作工作法：和智能体协同产出教程》
// 幂等：按 project code=authoring-sop 干净重建（清理旧 case/submissions/materials/steps/stages/project）
// 运行：node server/scripts/demo/tutorial-authoring-guide.mjs
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { URL } from 'node:url';

const envUrl = new URL('../../../.env.local', import.meta.url);
if (existsSync(envUrl)) process.loadEnvFile(envUrl);

const BASE = (process.env.NOCOBASE_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const UID = process.env.NOCOBASE_AUTHENTIK_UID || '';
const EMAIL = process.env.NOCOBASE_AUTHENTIK_EMAIL || '';
if (!UID || !EMAIL) throw new Error('缺少 NOCOBASE_AUTHENTIK_UID / NOCOBASE_AUTHENTIK_EMAIL（检查 .env.local）');

// ---------- 教程内容（常量区） ----------
const PROJECT = {
  name: '教程制作工作法：和智能体协同产出教程',
  code: 'authoring-sop',
  description:
    '元教程：接到教程任务后怎么和豆包工作伙伴里的智能体协同——先亲手完整实操并录屏，把任务要求原样带给智能体搭骨架、补细节、挂视频，最后回到泛亚工作台提交任务凭证，产出文字教程与实操视频并通过老板验收。',
  status: 'published',
  sort: 3,
};

const STAGES = [
  {
    title: '领取与实操',
    description: '接到教程任务后先自己把业务完整做一遍并录屏，这一遍是教程内容的唯一事实来源。',
    duration_note: '当天完成',
    steps: [
      {
        title: '阅读教程任务要求',
        guide:
          '1. 打开泛亚工作台任务页，找到分配给你的教程任务；\n2. 看清任务标题、截止时刻（标题里的 HH:mm 前）与验收条件；\n3. 把任务要求原样带给智能体，不要自己转述加工。',
        warn_text: null,
        deliver_note: '任务要求已确认清楚，可开始实操',
        require_confirm: false,
        require_review: false,
        materials: [
          {
            material_key: 'task_brief',
            label: '任务要求确认',
            input_type: 'text',
            required: true,
            help_text: '一句话确认你看清了标题、截止时刻与验收条件',
          },
        ],
      },
      {
        title: '完整实操一遍业务',
        guide:
          '1. 把要做成教程的业务从头到尾亲手做一遍；\n2. 边做边记每一步实际点了哪里、填了什么、跳过了什么；\n3. 这一遍是教程内容的唯一事实来源，禁止凭想象写教程。',
        warn_text: '不要跳过实操直接编教程，与真实操作不符的教程会被打回',
        deliver_note: '业务已完整实操一遍并记录要点',
        require_confirm: false,
        require_review: false,
        materials: [
          {
            material_key: 'practice_notes',
            label: '实操过程要点',
            input_type: 'textarea',
            required: true,
            help_text: '每行一步：实际点了哪里、填了什么',
          },
        ],
      },
      {
        title: '录制实操视频',
        guide:
          '1. 重做一遍业务并录屏；\n2. 画面完整覆盖关键操作，讲清楚每步在干什么；\n3. 视频时长控制在业务实际耗时以内，不要拖。',
        warn_text: '录屏前关闭无关窗口，避免泄露无关信息',
        deliver_note: '实操录屏与关键画面截图已备好',
        require_confirm: false,
        require_review: false,
        materials: [
          {
            material_key: 'demo_video',
            label: '实操录屏',
            input_type: 'video',
            required: true,
            help_text: '完整覆盖关键操作的录屏视频',
          },
          {
            material_key: 'key_screenshots',
            label: '关键画面截图',
            input_type: 'image',
            required: true,
            help_text: '关键步骤的画面截图',
          },
        ],
      },
      {
        title: '上传视频到任务凭证',
        guide:
          '1. 回到泛亚工作台该任务的详情页；\n2. 用提交凭证入口上传实操视频与截图；\n3. 提交后视频链接会出现在任务凭证里，智能体可以取到。',
        warn_text: null,
        deliver_note: '视频与截图已上传到任务凭证',
        require_confirm: false,
        require_review: false,
        materials: [
          {
            material_key: 'upload_confirmed',
            label: '上传完成确认',
            input_type: 'text',
            required: true,
            help_text: '一句话确认视频与截图已提交到任务凭证',
          },
        ],
      },
    ],
  },
  {
    title: '与智能体协同',
    description: '把实操结果交给豆包工作伙伴里的智能体：搭骨架、补细节、挂视频，人负责核对事实。',
    duration_note: '当天完成',
    steps: [
      {
        title: '让智能体搭教程骨架',
        guide:
          '1. 在豆包工作伙伴里对智能体说「帮我做《XX》教程，任务号是 #N」；\n2. 智能体会建好教程项目与阶段骨架；\n3. 把任务的验收条件一起告诉它。',
        warn_text: null,
        deliver_note: '教程项目与阶段骨架已由智能体建好',
        require_confirm: false,
        require_review: false,
        materials: [
          {
            material_key: 'brief_to_agent',
            label: '口述要点',
            input_type: 'textarea',
            required: true,
            help_text: '你带给智能体的任务要求与验收条件',
          },
        ],
      },
      {
        title: '补全步骤细节与坑点',
        guide:
          '1. 智能体建出步骤后，逐条核对 guide 是否与你的实操一致；\n2. 把漏掉的点击位置、易错点、注意事项口述给它补进 warn_text；\n3. 每个学员要交材料的步骤提醒它加材料字段。',
        warn_text: null,
        deliver_note: '步骤细节与坑点已逐条核对补全',
        require_confirm: false,
        require_review: false,
        materials: [
          {
            material_key: 'guide_checked',
            label: '核对完成确认',
            input_type: 'text',
            required: true,
            help_text: '一句话确认已逐条核对 guide 与实操一致',
          },
        ],
      },
      {
        title: '挂载实操视频',
        guide:
          '1. 告诉智能体「视频已传到任务凭证」；\n2. 让它从任务详情取视频链接挂到对应步骤；\n3. 挂完让它报一遍结构摘要（几阶段几步骤几个视频）。',
        warn_text: '视频链接必须来自你自己上传的凭证，智能体禁止编造链接',
        deliver_note: '视频已挂到对应步骤，结构摘要已回报',
        require_confirm: false,
        require_review: false,
        materials: [
          {
            material_key: 'video_attached',
            label: '挂载确认',
            input_type: 'text',
            required: true,
            help_text: '粘贴智能体回报的结构摘要（几阶段几步骤几个视频）',
          },
        ],
      },
    ],
  },
  {
    title: '提交验收',
    description: '检查教程结构完整后回工作台提交任务凭证，等老板验收，通过即上线教程中心。',
    duration_note: '当天完成',
    steps: [
      {
        title: '提交任务凭证等验收',
        guide:
          '1. 检查教程结构完整：每步有文字指南、关键步骤有视频；\n2. 回到工作台提交任务凭证，并附一句教程摘要（几阶段几步骤几个视频）；\n3. 老板验收通过，本教程即上线教程中心。',
        warn_text: null,
        deliver_note: '任务凭证已提交，等老板验收',
        require_confirm: true,
        require_review: false,
        materials: [
          {
            material_key: 'tutorial_summary',
            label: '教程摘要',
            input_type: 'textarea',
            required: true,
            help_text: '一句话摘要：几阶段几步骤几个视频',
          },
        ],
      },
    ],
  },
];

const CASE = {
  client_name: '教程制作示范',
  owner_user_id: '1871790158440555',
};

// ---------- NocoBase 客户端（照抄 tutorial-xianyu.mjs） ----------
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

// ---------- main ----------
const main = async () => {
  console.log('登录 NocoBase 教程中心…');
  await signIn();
  note('signIn', true, BASE);

  await cleanupLegacy();

  const project = await create('tutorial_projects', PROJECT);
  note('创建教程项目', true, `id=${project.id} ${project.name}`);

  let stepCount = 0;
  let materialCount = 0;
  const stageStepCounts = [];
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

    let stageSteps = 0;
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
      stageSteps += 1;
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
    stageStepCounts.push({ stage: stageDef.title, steps: stageSteps });
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

  const reportUrl = new URL('../../../../tmp/code-act/tutorial-authoring-guide-report.json', import.meta.url);
  mkdirSync(new URL('./', reportUrl), { recursive: true });
  writeFileSync(reportUrl, JSON.stringify(RESULT, null, 2));
  const failed = RESULT.steps.filter((s) => !s.ok);
  console.log(
    failed.length === 0
      ? `完成：教程制作工作法元教程已生成（${STAGES.length} 阶段 / ${stepCount} 步 / ${materialCount} 材料 / case_id=${kase.id}）`
      : `存在 ${failed.length} 个失败步骤，见 report`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
};

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});

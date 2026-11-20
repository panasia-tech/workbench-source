#!/usr/bin/env node
// server/scripts/demo/tutorial-link-demo.mjs — 教程生产闭环 demo：Plane 任务「制作闲鱼矩阵开店教程」
// 幂等：按标题搜现有任务，无则建（Todo）→ PATCH 到 In Review；打印 task_id 供 tutorial_task_links 映射
// 运行：node server/scripts/demo/tutorial-link-demo.mjs
import { URL, fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { plane, asList, allIssues } from './lib.mjs';

const envUrl = new URL('../../../.env.local', import.meta.url);
if (existsSync(envUrl)) process.loadEnvFile(envUrl);

const PROJECT_ID = '45fe3411-2de5-40eb-b751-ef1200c7c5cc'; // 日常执行
const ZS_ID = 'a87f9e39-f55f-458c-9d1f-944b5cd397bb'; // 演示业务负责人（张三绑定）
const IN_REVIEW = 'd362862d-a283-4a55-b953-4cfedc91b51d';
const TITLE = '制作闲鱼矩阵开店教程 21:00前';
const DESC = [
  '目标=产出《闲鱼矩阵开店教程》完整文字教程与实操视频',
  '当前步骤=与智能体协同完成 P0-P3 全部阶段的图文步骤与视频挂载',
  '验收条件=教程已发布（4 阶段 13 步骤 15 材料齐全）、关键步骤挂实操视频、闲鱼店铺已按教程开出',
  '依赖=无',
];

export async function main() {
  const issues = await allIssues(PROJECT_ID);
  const found = issues.find((i) => i.name === TITLE);
  let taskId = found ? found.id : null;

  if (found) {
    console.log('任务已存在，复用:', taskId);
    if (found.state !== IN_REVIEW) {
      await plane.patch(`/projects/${PROJECT_ID}/issues/${taskId}/`, { state: IN_REVIEW });
      console.log('已流转到 In Review');
    }
  } else {
    const created = await plane.post(`/projects/${PROJECT_ID}/issues/`, {
      name: TITLE,
      description_html: DESC.map((t) => `<p>${t}</p>`).join(''),
      assignees: [ZS_ID],
      target_date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()),
    });
    taskId = created.id;
    console.log('任务已创建:', taskId);
    await plane.patch(`/projects/${PROJECT_ID}/issues/${taskId}/`, { state: IN_REVIEW });
    console.log('已流转到 In Review');
  }

  const states = asList(await plane.get(`/projects/${PROJECT_ID}/states/`));
  const issue = await plane.get(`/projects/${PROJECT_ID}/issues/${taskId}/`);
  const st = states.find((s) => s.id === issue.state);
  console.log('最终状态:', st ? `${st.name} (group=${st.group}, slug=${st.slug})` : issue.state);
  console.log('TASK_ID=' + taskId);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => {
  console.error(e);
  process.exit(1);
});

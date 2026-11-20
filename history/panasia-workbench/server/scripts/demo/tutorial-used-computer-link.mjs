#!/usr/bin/env node
// server/scripts/demo/tutorial-used-computer-link.mjs — 二手电脑上架教程闭环 demo
// 建 Plane 任务「二手电脑上架处置」（日常执行项目，张三绑定成员），打印 task_id 供 tutorial_task_links 映射
// 幂等：按标题搜现有任务，无则建（Todo）；已存在则复用
import { URL } from 'node:url';
import { existsSync } from 'node:fs';
import { allIssues } from './lib.mjs';
import { plane } from './lib.mjs';

const envUrl = new URL('../../../.env.local', import.meta.url);
if (existsSync(envUrl)) process.loadEnvFile(envUrl);

const PROJECT_ID = '45fe3411-2de5-40eb-b751-ef1200c7c5cc'; // 日常执行
const ZS_ID = 'a87f9e39-f55f-458c-9d1f-944b5cd397bb'; // 演示业务负责人（张三绑定）
const TITLE = '二手电脑上架处置 18:00前';
const DESC = [
  '目标=按《二手电脑上架》教程完成公司闲置电脑处置：图吧工具箱硬件识别 → AI 生成配置单 → 拼多多模板参考改写 → 电源机箱人工补充 → 闲鱼上架',
  '当前步骤=教程 P0 配置单制作（图吧工具箱截图 + AI 初稿 + 拼多多模板改写 + 电源机箱补充）',
  '验收条件=配置单终稿经审核（每个配件具体到品牌型号，如芝奇皇家戟 DDR5 6000C28 16G×2 / 利民 TG1000 / acer V333R）、闲鱼商品已上架、展示策略思考总结已提交',
  '依赖=无',
];

const main = async () => {
  const issues = await allIssues(PROJECT_ID);
  const found = issues.find((i) => i.name === TITLE);
  let taskId;

  if (found) {
    taskId = found.id;
    console.log('任务已存在，复用:', taskId);
  } else {
    const created = await plane.post(`/projects/${PROJECT_ID}/issues/`, {
      name: TITLE,
      description_html: DESC.map((t) => `<p>${t}</p>`).join(''),
      assignees: [ZS_ID],
      target_date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()),
    });
    taskId = created.id;
    console.log('任务已创建:', taskId);
  }
  console.log('TASK_ID=' + taskId);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

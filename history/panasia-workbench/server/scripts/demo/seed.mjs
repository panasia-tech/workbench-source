#!/usr/bin/env node
// server/scripts/demo/seed.mjs — Demo seed 编排：成员 → P1/P2/P3（Plane）→ Frappe → 只读 GET 校验 → seed-report.json
// 幂等：Plane 按项目名查重（issue 按合同数跳过）；Frappe 按 DEMO- 标记查重。
import { writeFileSync } from 'node:fs';
import { plane, asList, docName, log, brief, R, ensureStates, allIssues } from './lib.mjs';
import * as D from './data.mjs';
import { runFrappe, verifyFrappe } from './seed-frappe.mjs';

R.notes = D.REPORT_NOTES;

function saveReport() {
  R.finishedAt = new Date().toISOString();
  const url = new URL('./seed-report.json', import.meta.url);
  writeFileSync(url, JSON.stringify(R, null, 2));
  log(`\n报告已写入 ${url.pathname}`);
}

// ---------- 1) 成员（路径 A：已有/邀请；否则路径 B fallback）----------
async function resolveMembers() {
  const fetchAll = () => plane.get('/members/').then(asList);
  const find = (arr, label) => arr.find((m) =>
    [m.display_name, m.first_name, m.member?.display_name, m.member?.first_name]
      .filter(Boolean).join(' ').includes(label));
  let list = await fetchAll();
  let z = find(list, '张三'), l = find(list, '李四'), w = find(list, '王主管');
  if (!z || !l || !w) {
    log('  缺少 张三/李四/王主管 → 尝试发送 invitations（role 15）…');
    for (const key of ['zhangsan', 'lisi', 'wangzhuguan']) {
      try {
        await plane.post('/invitations/', { email: D.DEMO_MEMBER_EMAILS[key], role: D.INVITE_ROLE });
        R.plane.invited.push(D.DEMO_MEMBER_EMAILS[key]);
      } catch (e) { R.failures.push({ step: `invitation ${key}`, error: brief(e) }); }
    }
    list = await fetchAll();
    z = find(list, '张三'); l = find(list, '李四'); w = find(list, '王主管');
  }
  const ids = {};
  if (z && l && w) {
    R.memberPath = 'A（成员齐备）';
    ids.zhangsan = z.id ?? z.member?.id;
    ids.lisi = l.id ?? l.member?.id;
    ids.wangzhuguan = w.id ?? w.member?.id;
  } else {
    R.memberPath = 'B（fallback）';
    R.fallbacks.push('Plane 成员邀请未生效 → 路径 B：张三=现有成员 a87f9e39-f55f-458c-9d1f-944b5cd397bb（演示业务负责人）；李四/王主管无成员，子任务A assignees:[]');
    ids.zhangsan = D.FALLBACK_ZHANGSAN_MEMBER_ID;
    ids.lisi = null; ids.wangzhuguan = null;
  }
  R.planeMemberIds = ids;
  log(`  成员路径：${R.memberPath}；张三 member id = ${ids.zhangsan}`);
}

// ---------- 2) Plane 项目（项目→states→label→modules→issues→comments）----------
async function seedProject(def, memberIds) {
  const existing = asList(await plane.get('/projects/')).find((p) => p.name === def.name);
  let p;
  if (existing) { p = existing; log(`  = 项目已存在，跳过创建：${def.name}`); }
  else {
    try {
      p = await plane.post('/projects/', { name: def.name, start_date: def.start, end_date: def.end, identifier: def.identifier });
    } catch (e) {
      log(`  [fallback] 带 identifier 创建失败（${brief(e).slice(0, 120)}）→ 裸建后 PATCH identifier`);
      p = await plane.post('/projects/', { name: def.name, start_date: def.start, end_date: def.end });
      await plane.patch(`/projects/${p.id}/`, { identifier: def.identifier });
    }
    log(`  + 项目：${def.name}（${p.id}）`);
  }
  R.plane.projects[def.key] = p.id;

  const states = asList(await plane.get(`/projects/${p.id}/states/`));
  const stateIds = await ensureStates(p.id, states);

  let label = asList(await plane.get(`/projects/${p.id}/labels/`)).find((x) => x.name === D.LABEL_DEMO.name);
  if (!label) label = await plane.post(`/projects/${p.id}/labels/`, D.LABEL_DEMO);

  const modules = {};
  await plane.patch(`/projects/${p.id}/`, { module_view: true });
  const existingModules = asList(await plane.get(`/projects/${p.id}/modules/`));
  for (const name of def.modules) {
    let m = existingModules.find((x) => x.name === name);
    if (!m) m = await plane.post(`/projects/${p.id}/modules/`, { name });
    modules[name] = m.id;
  }
  log(`  states=${Object.keys(stateIds).length} label=${label.name} modules=${Object.keys(modules).length}`);

  // issue 幂等：项目 issue 总数已达合同数 → 跳过；未达标时按 name 续建
  R.plane.issueIds[def.key] = [];
  let issues = await allIssues(p.id);
  if (issues.length >= def.expectedIssues) {
    log(`  = issue 已达 ${issues.length} 条（合同 ${def.expectedIssues}），跳过创建`);
    return;
  }
  const byName = new Map(issues.map((x) => [x.name, x]));
  const created = {};
  const moduleLinks = {}; // 模块名 → 顶层任务 id 列表（子任务不挂模块，保住模块进度层次）
  for (const item of def.issues) {
    const exist = byName.get(item.title);
    let issueId;
    if (exist) {
      issueId = exist.id;
      created[item.ref] = issueId;
      R.plane.issueIds[def.key].push(issueId);
    } else {
      const payload = {
        name: item.title,
        state: stateIds[item.state],
        priority: item.priority || 'medium',
        labels: [label.id],
      };
      if (item.target) payload.target_date = item.target;
      const assigneeId = item.assignee ? memberIds[item.assignee] : null;
      payload.assignees = assigneeId ? [assigneeId] : [];
      if (item.desc) payload.description_html = item.desc.map((t) => `<p>${t}</p>`).join('');
      const issue = await plane.post(`/projects/${p.id}/issues/`, payload);
      issueId = issue.id;
      created[item.ref] = issue.id;
      R.plane.issueIds[def.key].push(issue.id);
    }
    if (item.module && modules[item.module] && !item.parentRef) {
      (moduleLinks[item.module] ??= []).push(issueId);
    }
    if (item.parentRef) {
      await plane.patch(`/projects/${p.id}/issues/${issueId}/`, { parent: created[item.parentRef] });
    }
    if (item.comments && item.comments.length > 0) {
      if (exist) {
        const cs = asList(await plane.get(`/projects/${p.id}/issues/${issueId}/comments/`));
        for (const c of item.comments.slice(cs.length)) {
          await plane.post(`/projects/${p.id}/issues/${issueId}/comments/`, { comment_html: c });
        }
      } else {
        for (const c of item.comments) {
          await plane.post(`/projects/${p.id}/issues/${issueId}/comments/`, { comment_html: c });
        }
      }
    }
  }
  // 模块关联：此 Plane 版本 issue PATCH module 字段无效，必须走 modules/{mid}/module-issues/ 批量端点
  for (const [modName, ids] of Object.entries(moduleLinks)) {
    const mod = modules[modName];
    if (!mod) continue;
    const linked = asList(await plane.get(`/projects/${p.id}/modules/${mod.id}/module-issues/`));
    const linkedIds = linked.map((x) => x.id);
    const missing = ids.filter((id) => !linkedIds.includes(id));
    if (missing.length > 0) {
      await plane.post(`/projects/${p.id}/modules/${mod.id}/module-issues/`, { issues: missing });
    }
    log(`  + 模块 ${modName}：新关联 ${missing.length}，共 ${ids.length} 顶层任务`);
  }
  log(`  + issue：项目共 ${R.plane.issueIds[def.key].length}/${def.expectedIssues} 条`);
}

// ---------- 3) 只读 GET 校验 ----------
async function verifyPlane() {
  const zsId = R.planeMemberIds?.zhangsan;
  const out = {};
  for (const def of [D.PROJECT_1, D.PROJECT_2, D.PROJECT_3]) {
    const pid = R.plane.projects[def.key];
    if (!pid) continue;
    const issues = await allIssues(pid);
    const states = asList(await plane.get(`/projects/${pid}/states/`));
    const grp = Object.fromEntries(states.map((s) => [s.id, s.group]));
    const mods = asList(await plane.get(`/projects/${pid}/modules/`));
    const s = { total: issues.length, nonCancelled: 0, done: 0, zhangsan: 0, zhangsanDone: 0, zhangsanOpen: 0, byModule: {}, byModuleDone: {} };
    const issueById = new Map(issues.map((x) => [x.id, x]));
    const grpOf = (id) => grp[issueById.get(id)?.state];
    for (const m of mods) {
      const linked = asList(await plane.get(`/projects/${pid}/modules/${m.id}/module-issues/`));
      for (const li of linked) {
        const g = grpOf(li.id);
        if (g !== 'cancelled') s.byModule[m.name] = (s.byModule[m.name] || 0) + 1;
        if (g === 'completed') s.byModuleDone[m.name] = (s.byModuleDone[m.name] || 0) + 1;
      }
    }
    for (const it of issues) {
      const g = grp[it.state];
      const isZs = (it.assignees || []).includes(zsId);
      if (g !== 'cancelled') s.nonCancelled += 1;
      if (g === 'completed') s.done += 1;
      if (isZs) {
        s.zhangsan += 1;
        if (g === 'completed') s.zhangsanDone += 1;
        else if (g !== 'cancelled') s.zhangsanOpen += 1;
      }
    }
    s.doneRate = s.nonCancelled ? `${Math.round((s.done / s.nonCancelled) * 100)}%` : null;
    out[def.name] = s;
    log(`  [${def.name}] total=${s.total} 非cancelled=${s.nonCancelled} done=${s.done}(${s.doneRate}) 张三=${s.zhangsan}(done=${s.zhangsanDone},open=${s.zhangsanOpen})`);
  }
  out.expected = {
    '员工采购工作台 V2': { total: 27, nonCancelled: 25, done: 18, doneRate: '72%', zhangsan: 22, byModule: { 采购报价: '12t/11d', 商品图片: '5t/4d', 行情价接入: '3t/2d', 员工端: '2t/1d', 上线测试: '1t/0d' } },
    '行情价自动化': { total: 9, nonCancelled: 8, done: 7, doneRate: '88%', zhangsan: 9, byModule: { 数据源接入: '2t/2d', 字段映射: '1t/1d', 批量抓取: '1t/1d', 快照生成: '1t/1d', 审计验证: '3t/2d' } },
    '日常执行': { total: 3, zhangsan: 3 },
  };
  R.verification.plane = out;
}

// ---------- 主流程 ----------
async function main() {
  log('== 1/5 成员 =='); await resolveMembers();
  log('== 2/5 项目1 员工采购工作台 V2 =='); await seedProject(D.PROJECT_1, R.planeMemberIds);
  log('== 3/5 项目2 行情价自动化 =='); await seedProject(D.PROJECT_2, R.planeMemberIds);
  log('== 4/5 项目3 日常执行 =='); await seedProject(D.PROJECT_3, R.planeMemberIds);
  log('== 5/5 Frappe（HR/LMS）=='); await runFrappe();
  log('== 校验（只读 GET）==');
  await verifyPlane();
  await verifyFrappe();
  saveReport();
  const summary = {
    memberPath: R.memberPath, zhangsanMemberId: R.planeMemberIds?.zhangsan,
    plane: R.verification.plane, frappe: R.verification.frappe,
    fallbacks: R.fallbacks, failures: R.failures.map((f) => `${f.step}: ${f.error.slice(0, 100)}`),
  };
  log('\n===== seed 摘要 =====');
  console.log(JSON.stringify(summary, null, 2));
}

try { await main(); } catch (e) {
  R.failures.push({ step: 'FATAL', error: brief(e) });
  saveReport();
  console.error('\n[FATAL] seed 中止：', brief(e));
  process.exitCode = 1;
}

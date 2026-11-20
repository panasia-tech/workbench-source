#!/usr/bin/env node
// server/scripts/demo/wipe.mjs — 按 seed-report.json 清除 demo 数据（幂等；本脚本不主动运行）
// 用法：node server/scripts/demo/wipe.mjs
import { readFileSync, existsSync } from 'node:fs';
import { plane, frappe, log, brief } from './lib.mjs';
import { PROTECTED_MEMBER_IDS } from './data.mjs';

const reportUrl = new URL('./seed-report.json', import.meta.url);
if (!existsSync(reportUrl)) {
  console.error('找不到 seed-report.json —— 请先运行 node server/scripts/demo/seed.mjs');
  process.exit(1);
}
const R = JSON.parse(readFileSync(reportUrl, 'utf8'));
const C = R.frappe?.created ?? {};
const S = { frappeDeleted: 0, planeProjects: 0, planeMembers: 0, failures: [] };

const del = async (dt, name) => {
  if (!name) return;
  try {
    await frappe.delete(dt, name);
    S.frappeDeleted += 1;
    log(`  - ${dt}: ${name}`);
  } catch (e) {
    const b = brief(e);
    if (b.includes(' 404:')) return; // 已不存在，幂等
    S.failures.push(`${dt} ${name} ${b}`);
  }
};

log('== Frappe（依赖序删除）==');
await del('Salary Slip', R.frappe?.salarySlip);
await del('Salary Structure', C.salaryStructure);
await del('Payroll Period', C.payrollPeriod);
for (const n of R.frappe?.attendanceNames ?? []) await del('Attendance', n);
await del('Leave Application', R.frappe?.leaveApplication);
await del('Appraisal', R.frappe?.appraisal);
await del('Appraisal Cycle', C.appraisalCycle);
for (const n of R.frappe?.goalNames ?? []) await del('Goal', n);
for (const n of R.frappe?.enrollmentNames ?? []) await del('LMS Enrollment', n);
for (const n of R.frappe?.quizResultNames ?? []) await del('LMS Quiz Result', n);
for (const n of C.quizzes ?? []) await del('LMS Quiz', n);
for (const n of C.courses ?? []) await del('LMS Course', n);
// Employee 按 DEMO- 前缀（后建先删）
for (const eid of ['DEMO-003', 'DEMO-002', 'DEMO-001']) await del('Employee', R.frappe?.employees?.[eid]);
await del('Member', C.member);
for (const n of C.kras ?? []) await del('KRA', n);
await del('Leave Type', C.leaveType);
for (const n of C.salaryComponents ?? []) await del('Salary Component', n);
for (const n of C.designations ?? []) await del('Designation', n);
for (const n of C.departments ?? []) await del('Department', n);
await del('Company', C.company);

log('== Plane（3 个 demo 项目 + 邀请过的成员）==');
for (const [key, pid] of Object.entries(R.plane?.projects ?? {})) {
  try {
    await plane.delete(`/projects/${pid}/`);
    S.planeProjects += 1;
    log(`  - Plane 项目 ${key}: ${pid}（连带子资源）`);
  } catch (e) { S.failures.push(`Plane 项目 ${pid} ${brief(e)}`); }
}
for (const mid of R.plane?.inviteMemberIds ?? []) {
  if (!mid || PROTECTED_MEMBER_IDS.includes(mid)) continue; // 白名单绝不删
  try { await plane.delete(`/members/${mid}/`); S.planeMembers += 1; }
  catch (e) {
    try { await plane.delete(`/workspace-members/${mid}/`); S.planeMembers += 1; }
    catch (e2) { S.failures.push(`Plane 成员 ${mid} ${brief(e2)}`); }
  }
}

log(`\nwipe 完成：Frappe 删除 ${S.frappeDeleted}，Plane 项目 ${S.planeProjects}，Plane 成员 ${S.planeMembers}，失败 ${S.failures.length}`);
if (S.failures.length) {
  log('失败清单（前 20 条）：');
  for (const f of S.failures.slice(0, 20)) log(` - ${f}`);
  process.exitCode = 1;
}

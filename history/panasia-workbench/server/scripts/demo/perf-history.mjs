#!/usr/bin/env node
// server/scripts/demo/perf-history.mjs — 绩效历史溯源数据：
// 1) 3 个历史 Appraisal Cycle（06/07/08）+ 各周期 Appraisal（评分编排到 92/83/77）
// 2) 奖惩事件 Salary Component（迟到扣款/绩效奖金扣减 Deduction）+ Additional Salary 3 条
// 3) 7 月 2 条迟到考勤（in_time > 09:00）
// 幂等：全部先查后写。产物：perf-history-report.json
import { writeFileSync } from 'node:fs';
import { frappe, docName, log, brief } from './lib.mjs';

const ZS = 'HR-EMP-00001';
const COMPANY = '杭州泛亚电子';
const RESULT = { at: new Date().toISOString(), steps: [] };
const note = (step, ok, detail) => {
  RESULT.steps.push({ step, ok, detail });
  log(`  ${ok ? '√' : '×'} ${step}${detail ? `：${String(detail).slice(0, 200)}` : ''}`);
};

// ---------- KRA 模板：直接读现有 9 月 Appraisal 的 goals 行，保证指标口径一致 ----------
async function kraTemplate() {
  const rows = await frappe.list('Appraisal', { filters: [['employee', '=', ZS]], fields: ['name'] });
  for (const r of rows) {
    const doc = await frappe.get('Appraisal', docName(r) ?? r.name);
    if ((doc.goals ?? []).length === 7) {
      return doc.goals.map((g) => ({ name: g.kra, weight: g.per_weightage ?? 0 }));
    }
  }
  throw new Error('找不到带 7 行 goals 的 Appraisal 作为 KRA 模板（先跑 seed/repair）');
}

// ---------- 1) 历史周期 + Appraisal ----------
const CYCLES = [
  { key: 'Demo 2026-06', start: '2026-06-01', end: '2026-06-30', ratings: [5, 5, 5, 5, 4, 4, 4] },
  { key: 'Demo 2026-07', start: '2026-07-01', end: '2026-07-31', ratings: [5, 4, 4, 4, 4, 4, 4] },
  { key: 'Demo 2026-08', start: '2026-08-01', end: '2026-08-31', ratings: [5, 4, 3, 4, 3, 4, 4] },
];

async function ensureCycle(cy) {
  const all = await frappe.list('Appraisal Cycle', { fields: ['name'] });
  if (!all.some((c) => c.name === cy.key)) {
    let created = null;
    for (const body of [
      { cycle_name: cy.key, company: COMPANY, start_date: cy.start, end_date: cy.end },
      { name: cy.key, company: COMPANY, start_date: cy.start, end_date: cy.end },
    ]) {
      try { created = await frappe.post('Appraisal Cycle', body); break; } catch (e) { log(`    试错：${brief(e)}`); }
    }
    if (!created) return note(`建周期 ${cy.key}`, false);
    note(`建周期 ${cy.key}`, true, docName(created));
  }
  // 已完成周期内不能建 Appraisal → 先切进行中，建完评估再切回已完成
  const cyc = await frappe.get('Appraisal Cycle', cy.key);
  if (cyc.status === 'Completed') {
    try { await frappe.put('Appraisal Cycle', cy.key, { status: 'In Progress' }); }
    catch (e) { note(`周期 ${cy.key} 切进行中`, false, brief(e)); }
  }
}

function mkRows(tpl, ratings, sf) {
  return tpl.map((t, i) => ({
    kra: t.name, per_weightage: t.weight, [sf]: ratings[i],
    score_earned: Math.round((ratings[i] * t.weight / 5) * 10) / 10,
  }));
}

async function ensureAppraisal(cy, tpl) {
  const rows = await frappe.list('Appraisal', { filters: [['employee', '=', ZS]], fields: ['name'] });
  let doc = null;
  for (const r of rows) {
    const d = await frappe.get('Appraisal', docName(r) ?? r.name);
    if (d.appraisal_cycle === cy.key) { doc = d; break; }
  }
  let name = doc ? doc.name : null;
  if (!name) {
    for (const body of [
      { employee: ZS, appraisal_cycle: cy.key, goals: mkRows(tpl, cy.ratings, 'score') },
      { employee: ZS, appraisal_cycle: cy.key, appraisal_kras: mkRows(tpl, cy.ratings, 'goal_score') },
      { employee: ZS, appraisal_cycle: cy.key },
    ]) {
      try { const d = await frappe.post('Appraisal', body); name = docName(d); break; }
      catch (e) { log(`    试错：${brief(e)}`); }
    }
  }
  if (!name) return note(`建 Appraisal ${cy.key}`, false);
  const full = await frappe.get('Appraisal', name);
  let goals = full.goals ?? [];
  if (goals.length === 0) {
    try {
      await frappe.put('Appraisal', name, { goals: mkRows(tpl, cy.ratings, 'score') });
      goals = (await frappe.get('Appraisal', name)).goals ?? [];
    } catch (e) { log(`    整表写入失败：${brief(e)}`); }
  }
  let fixed = 0;
  for (const g of goals) {
    const i = tpl.findIndex((t) => t.name === g.kra);
    if (i < 0) continue;
    const want = cy.ratings[i];
    if ((g.score ?? null) === want) continue;
    const earned = Math.round((want * (g.per_weightage ?? 0) / 5) * 10) / 10;
    try {
      await frappe.put(g.doctype ?? 'Appraisal Goal', g.name, { score: want, score_earned: earned });
      fixed += 1;
    } catch (e) { note(`子表行 ${g.kra} 调分`, false, brief(e)); }
  }
  // 周期收尾：切回已完成（历史周期语义）
  try { await frappe.put('Appraisal Cycle', cy.key, { status: 'Completed' }); } catch { /* 不阻塞 */ }
  const sum = Math.round(goals.reduce((s, g) => s + (g.score_earned ?? 0), 0) * 10) / 10;
  note(`Appraisal ${cy.key}`, goals.length === 7, `goals=${goals.length} 行，调分 ${fixed} 处，Σscore_earned=${sum}`);
}

// ---------- 2) 奖惩事件 ----------
const DEDUCTION_COMPONENTS = ['迟到扣款', '绩效奖金扣减'];
const ADDL_EVENTS = [
  { component: '其他奖励', amount: 500, date: '2026-06-30', remark: 'Q2 季度奖励' },
  { component: '迟到扣款', amount: 150, date: '2026-07-15', remark: '7 月两次迟到' },
  { component: '绩效奖金扣减', amount: 400, date: '2026-08-31', remark: '项目延期导致' },
];

async function ensureComponents() {
  for (const c of DEDUCTION_COMPONENTS) {
    const rows = await frappe.list('Salary Component', { filters: [['salary_component', '=', c]] });
    if (rows.length) { note(`Salary Component ${c} 已存在`, true); continue; }
    let d = null;
    for (const body of [{ salary_component: c, type: 'Deduction' }, { salary_component: c }]) {
      try { d = await frappe.post('Salary Component', body); break; } catch (e) { log(`    试错：${brief(e)}`); }
    }
    note(`建 Salary Component ${c}（Deduction）`, Boolean(d), d ? docName(d) : null);
  }
}

async function ensureAdditionalSalary() {
  for (const ev of ADDL_EVENTS) {
    const rows = await frappe.list('Additional Salary', {
      filters: [['employee', '=', ZS], ['payroll_date', '=', ev.date]],
      fields: ['name'],
    });
    if (rows.length > 0) { note(`事件 ${ev.component}@${ev.date} 已存在`, true); continue; }
    const base = { employee: ZS, salary_component: ev.component, amount: ev.amount, payroll_date: ev.date, company: COMPANY };
    let d = null;
    for (const body of [
      { ...base, recurring: 0, remarks: ev.remark },
      { ...base, recurring: 0 },
      base,
    ]) {
      try { d = await frappe.post('Additional Salary', body); break; } catch (e) { log(`    试错：${brief(e)}`); }
    }
    if (!d) { note(`建事件 ${ev.component}@${ev.date}`, false); continue; }
    const nm = docName(d);
    try { await frappe.put('Additional Salary', nm, { docstatus: 1 }); } catch { /* 提交失败不阻塞 */ }
    note(`建事件 ${ev.component}@${ev.date}`, true, nm);
  }
}

// ---------- 3) 7 月迟到考勤 ----------
const JULY_LATE = [
  { day: '2026-07-14', inTime: '09:23:00' },
  { day: '2026-07-15', inTime: '09:41:00' },
];

async function ensureJulyLate() {
  for (const a of JULY_LATE) {
    const rows = await frappe.list('Attendance', {
      filters: [['employee', '=', ZS], ['attendance_date', '=', a.day]],
      fields: ['name'],
    });
    if (rows.length > 0) { note(`考勤 ${a.day} 已存在`, true); continue; }
    try {
      const d = await frappe.post('Attendance', {
        employee: ZS, attendance_date: a.day, status: 'Present',
        in_time: `${a.day} ${a.inTime}`, company: COMPANY,
      });
      note(`补建迟到考勤 ${a.day}（in_time ${a.inTime}）`, true, docName(d));
    } catch (e) { note(`补建迟到考勤 ${a.day}`, false, brief(e)); }
  }
}

// ---------- 校验 ----------
async function verify() {
  const cycles = await frappe.list('Appraisal Cycle', { fields: ['name', 'start_date', 'end_date'] });
  const aprRows = await frappe.list('Appraisal', { filters: [['employee', '=', ZS]], fields: ['name'] });
  const byCycle = {};
  for (const r of aprRows) {
    const d = await frappe.get('Appraisal', docName(r) ?? r.name);
    const sum = Math.round((d.goals ?? []).reduce((s, g) => s + (g.score_earned ?? 0), 0) * 10) / 10;
    byCycle[d.appraisal_cycle ?? '(无周期)'] = sum;
  }
  const addl = await frappe.list('Additional Salary', { filters: [['employee', '=', ZS]], fields: ['name'] });
  const att = await frappe.list('Attendance', {
    filters: [['employee', '=', ZS], ['attendance_date', '>=', '2026-07-01'], ['attendance_date', '<=', '2026-07-31']],
    fields: ['name'],
  });
  RESULT.verify = { cycles: cycles.length, byCycle, additionalSalary: addl.length, julyAttendance: att.length };
  log(`\n校验：周期 ${cycles.length} 个；各周期得分 ${JSON.stringify(byCycle)}；Additional Salary ${addl.length} 条；7 月考勤 ${att.length} 条`);
}

// ---------- 0) 入职日期提前（June 周期/薪资事件要求 payroll_date ≥ date_of_joining） ----------
async function ensureJoiningDate() {
  const emp = await frappe.get('Employee', ZS);
  if ((emp.date_of_joining ?? '') <= '2026-06-30') {
    return note(`入职日期 ${emp.date_of_joining} 无需调整`, true);
  }
  try {
    await frappe.put('Employee', ZS, { date_of_joining: '2026-01-05' });
    note('入职日期调整为 2026-01-05（否则 6 月周期/薪资事件无法创建）', true);
  } catch (e) {
    note('入职日期调整失败（6 月数据将不可用）', false, brief(e));
  }
}

// ---------- 薪资结构分配（Additional Salary 前置） ----------
async function ensureSalaryStructureAssignment() {
  const rows = await frappe.list('Salary Structure Assignment', {
    filters: [['employee', '=', ZS]],
    fields: ['name'],
  });
  if (rows.length > 0) return note('Salary Structure Assignment 已存在', true, docName(rows[0]));
  const body = { employee: ZS, salary_structure: '采购专员-月度', from_date: '2026-01-05', company: COMPANY };
  let d = null;
  for (const v of [body, { ...body, base: 8000 }, { employee: ZS, salary_structure: '采购专员-月度', from_date: '2026-01-05' }]) {
    try { d = await frappe.post('Salary Structure Assignment', v); break; } catch (e) { log(`    试错：${brief(e)}`); }
  }
  if (!d) return note('建 Salary Structure Assignment', false);
  const nm = docName(d);
  try { await frappe.put('Salary Structure Assignment', nm, { docstatus: 1 }); } catch { /* 提交失败不阻塞 */ }
  note('建 Salary Structure Assignment（采购专员-月度）', true, nm);
}

try {
  log('== 绩效历史溯源数据（幂等）==');
  await ensureJoiningDate();
  const tpl = await kraTemplate();
  log(`KRA 模板：${tpl.map((t) => `${t.name}(${t.weight})`).join('、')}`);
  for (const cy of CYCLES) { await ensureCycle(cy); await ensureAppraisal(cy, tpl); }
  await ensureComponents();
  await ensureSalaryStructureAssignment();
  await ensureAdditionalSalary();
  await ensureJulyLate();
  await verify();
  const url = new URL('./perf-history-report.json', import.meta.url);
  writeFileSync(url, JSON.stringify(RESULT, null, 2));
  log(`报告已写入 ${url.pathname}`);
} catch (e) {
  RESULT.fatal = brief(e);
  const url = new URL('./perf-history-report.json', import.meta.url);
  writeFileSync(url, JSON.stringify(RESULT, null, 2));
  console.error('\n[FATAL] perf-history 中止：', brief(e));
  process.exitCode = 1;
}

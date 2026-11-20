#!/usr/bin/env node
// server/scripts/demo/repair.mjs — seed 后的一次性数据修补：
// 1) 删重复 Goal  2) 补 09-22 考勤(in_time 表迟到)  3) Appraisal final_score=86
// 4) Leave Application(0.5 天事假)  5) Plane DONE issue 回填 completed_at(及时率 92% 的数据基础)
// 6) 模块/周期关联  7) 任务类型标签 + 委派/定时演示任务（游戏化）
// 幂等：全部先查后写。产物：repair-report.json
import { writeFileSync } from 'node:fs';
import { plane, asList, frappe, docName, log, brief, allIssues } from './lib.mjs';
import { PROJECT_1, PROJECT_2 } from './data.mjs';

const ZS = 'HR-EMP-00001'; // 张三（DEMO-001）
const COMPANY = '杭州泛亚电子';
const RESULT = { at: new Date().toISOString(), steps: [] };

const note = (step, ok, detail) => {
  RESULT.steps.push({ step, ok, detail });
  log(`  ${ok ? '√' : '×'} ${step}${detail ? `：${String(detail).slice(0, 200)}` : ''}`);
};

// ---------- 1) Goal 去重 ----------
async function fixGoals() {
  const rows = await frappe.list('Goal', {
    filters: [['employee', '=', ZS]],
    fields: ['name', 'goal_name', 'progress', 'creation'],
  });
  const bySubject = new Map();
  const dup = [];
  for (const r of rows) {
    const key = r.goal_name ?? r.subject ?? r.name;
    if (bySubject.has(key)) dup.push(r);
    else bySubject.set(key, r);
  }
  log(`  Goal 共 ${rows.length} 条，重复 ${dup.length} 条`);
  for (const r of dup) {
    try {
      await frappe.delete('Goal', r.name);
      note(`删除重复 Goal ${r.name}（${r.goal_name}）`, true);
    } catch (e) {
      note(`删除重复 Goal ${r.name}`, false, brief(e));
    }
  }
  if (dup.length === 0) note('Goal 无重复', true);
}

// ---------- 2) 09-22 考勤（Present + in_time 09:23 表迟到）----------
async function fixAttendance() {
  const day = '2026-09-22';
  const rows = await frappe.list('Attendance', {
    filters: [['employee', '=', ZS], ['attendance_date', '=', day]],
    fields: ['name', 'in_time'],
  });
  if (rows.length > 0) {
    note(`考勤 ${day} 已存在`, true, rows[0].name);
    return;
  }
  try {
    const d = await frappe.post('Attendance', {
      employee: ZS, attendance_date: day, status: 'Present',
      in_time: `${day} 09:23:00`, company: COMPANY,
    });
    note(`补建考勤 ${day}（in_time 09:23）`, true, docName(d));
  } catch (e) {
    note(`补建考勤 ${day}`, false, brief(e));
  }
}

// ---------- 3) Appraisal 评分调到 86（逐行直写子表 score，再触发父单 validate 重算）----------
// 权重和 100，Σ(w×score)/5 = (15×5+15×5+14×4×5)/5 = 430/5 = 86
const GOAL_SCORES = { 采购任务及时率: 5, 项目任务完成率: 5 };
const scoreOf = (kra) =>
  GOAL_SCORES[Object.keys(GOAL_SCORES).find((k) => (kra ?? '').includes(k)) ?? ''] ?? 4;

async function fixAppraisal() {
  const rows = await frappe.list('Appraisal', { filters: [['employee', '=', ZS]], fields: ['name'] });
  if (rows.length === 0) return note('Appraisal 不存在', false);
  const name = docName(rows[0]);
  let doc = await frappe.get('Appraisal', name);
  const goalRows = Array.isArray(doc.goals) ? doc.goals : [];
  log(`  Appraisal ${name}: total_score=${doc.total_score} final_score=${doc.final_score} goals=${goalRows.length}`);
  if (goalRows.length === 0) return note('Appraisal 无 goals 子表行', false);
  if ((doc.total_score ?? doc.final_score) === 86) return note('Appraisal 已是 86', true);
  // total_score/final_score 为服务端计算字段，任何写入都会被重置为 0 → 后端从 Σ score_earned 兑算
  const childDoctype = goalRows[0].doctype ?? 'Appraisal Goal';
  for (const r of goalRows) {
    const score = scoreOf(r.kra);
    const earned = Math.round(((score * (r.per_weightage ?? 0)) / 5) * 10) / 10;
    try {
      await frappe.put(childDoctype, r.name, { score, score_earned: earned });
    } catch (e) {
      note(`子表行 ${r.kra} 写 score`, false, brief(e));
    }
  }
  doc = await frappe.get('Appraisal', name);
  const earnedSum = Math.round(
    (doc.goals ?? []).reduce((s, r) => s + (r.score_earned ?? 0), 0) * 10,
  ) / 10;
  note(
    'Appraisal Σscore_earned=86',
    earnedSum === 86,
    `total_score=${doc.total_score}（服务端强制 0）Σ=${earnedSum}`,
  );
}

// ---------- 4) Leave：Application 被 Holiday List 403 硬阻塞（两次验证）→ 降级为 Leave Allocation 0.5 天额度 ----------
function grantedOf(a) {
  return a.new_leaves_allocated ?? a.total_leaves_allocated ?? 0;
}

async function fixLeave() {
  const names = await frappe.list('Leave Allocation', {
    filters: [['employee', '=', ZS]],
    fields: ['name'],
  });
  const docs = [];
  for (const n of names) docs.push(await frappe.get('Leave Allocation', docName(n) ?? n.name));
  const monthAllocs = docs.filter(
    (a) => (a.from_date ?? '') <= '2026-09-30' && (a.to_date ?? '') >= '2026-09-01',
  );
  const granted = monthAllocs.reduce((s, a) => s + (grantedOf(a) ?? 0), 0);
  log(`  Leave Allocation（9 月）${monthAllocs.length} 条，已批额度合计 ${granted} 天`);
  if (granted === 0.5) return note('Leave Allocation 0.5 天已就位', true);
  for (const a of monthAllocs) {
    try {
      if (a.docstatus === 1) {
        await frappe.method('frappe.client.cancel', { doctype: 'Leave Allocation', name: a.name });
      }
      await frappe.delete('Leave Allocation', a.name);
      note(`删除旧额度 ${a.name}`, true);
    } catch (e) {
      note(`删除旧额度 ${a.name}`, false, brief(e));
    }
  }
  try {
    const d = await frappe.post('Leave Allocation', {
      employee: ZS, leave_type: '事假',
      from_date: '2026-09-01', to_date: '2026-09-30', new_leaves_allocated: 0.5,
    });
    const nm = docName(d);
    try {
      await frappe.put('Leave Allocation', nm, { docstatus: 1 });
    } catch (e) { log(`    Allocation 提交失败（不阻塞）：${brief(e)}`); }
    note('重建 Leave Allocation 0.5 天', true, nm);
  } catch (e) {
    note('重建 Leave Allocation', false, brief(e));
  }
}

// ---------- 5) Plane 逾期标记：completed_at 为服务端字段 PATCH 不生效 → 「逾期完成」标签 ----------
const LATE_TITLES = ['月度比价报告整理', '报价历史数据比对'];

async function fixLateLabels() {
  const projects = asList(await plane.get('/projects/'));
  const p1 = projects.find((p) => p.name === '员工采购工作台 V2');
  if (!p1) return note('P1 项目不存在', false);
  const labels = asList(await plane.get(`/projects/${p1.id}/labels/`));
  let late = labels.find((l) => l.name === '逾期完成');
  if (!late) late = await plane.post(`/projects/${p1.id}/labels/`, { name: '逾期完成', color: '#b91c1c' });
  const issues = await allIssues(p1.id);
  for (const title of LATE_TITLES) {
    const it = issues.find((x) => x.name === title);
    if (!it) { note(`找不到任务 ${title}`, false); continue; }
    const cur = Array.isArray(it.labels) ? it.labels : [];
    if (cur.includes(late.id)) { note(`标签已有 ${title}`, true); continue; }
    await plane.patch(`/projects/${p1.id}/issues/${it.id}/`, { labels: [...cur, late.id] });
    const after = await plane.get(`/projects/${p1.id}/issues/${it.id}/`);
    note(`逾期标签 ${title}`, (after.labels ?? []).includes(late.id));
  }
}

// ---------- 6) Plane 模块关联 + 周期（子任务不挂模块，保住模块进度层次；当前阶段=行情价接入） ----------
const CYCLE_DEFS = [
  { project: '员工采购工作台 V2', name: '行情价接入', start_date: '2026-09-14', end_date: '2026-10-09', module: '行情价接入' },
  { project: '员工采购工作台 V2', name: '上线测试', start_date: '2026-10-12', end_date: '2026-11-28', module: '上线测试' },
  { project: '行情价自动化', name: '审计验证', start_date: '2026-09-21', end_date: '2026-10-10', module: '审计验证' },
];

async function fixModuleCycleLinks() {
  const projects = asList(await plane.get('/projects/'));
  for (const def of [PROJECT_1, PROJECT_2]) {
    const p = projects.find((x) => x.name === def.name);
    if (!p) { note(`${def.name} 不存在`, false); continue; }
    const issues = await allIssues(p.id);
    const modules = asList(await plane.get(`/projects/${p.id}/modules/`));
    const byModule = new Map();
    for (const item of def.issues) {
      if (!item.module || item.parentRef) continue;
      if (!byModule.has(item.module)) byModule.set(item.module, []);
      byModule.get(item.module).push(item.title);
    }
    for (const [modName, titles] of byModule) {
      const mod = modules.find((x) => x.name === modName);
      if (!mod) { note(`模块 ${modName} 不存在`, false); continue; }
      const linkedIds = asList(await plane.get(`/projects/${p.id}/modules/${mod.id}/module-issues/`)).map((x) => x.id);
      const missing = titles
        .map((t) => issues.find((x) => x.name === t))
        .filter((it) => it && !linkedIds.includes(it.id));
      if (missing.length > 0) {
        await plane.post(`/projects/${p.id}/modules/${mod.id}/module-issues/`, { issues: missing.map((x) => x.id) });
      }
      note(`${def.name} 模块「${modName}」关联`, true, `新增 ${missing.length}/${titles.length} 顶层任务`);
    }
    try { await plane.patch(`/projects/${p.id}/`, { cycle_view: true }); } catch { /* 已开启则忽略 */ }
    let cycles = asList(await plane.get(`/projects/${p.id}/cycles/`));
    // 清理误建的空周期（Plane 禁止向已完结周期加任务，商品图片为过去周期无法使用）
    for (const c of cycles) {
      if (c.name === '商品图片') {
        const linked = asList(await plane.get(`/projects/${p.id}/cycles/${c.id}/cycle-issues/`));
        if (linked.length === 0) {
          await plane.delete(`/projects/${p.id}/cycles/${c.id}/`);
          note(`清理空周期「商品图片」`, true);
        }
      }
    }
    cycles = asList(await plane.get(`/projects/${p.id}/cycles/`));
    for (const cyc of CYCLE_DEFS.filter((c) => c.project === def.name)) {
      let c = cycles.find((x) => x.name === cyc.name);
      if (!c) {
        c = await plane.post(`/projects/${p.id}/cycles/`, {
          name: cyc.name, start_date: cyc.start_date, end_date: cyc.end_date,
        });
      }
      const linkedIds = asList(await plane.get(`/projects/${p.id}/cycles/${c.id}/cycle-issues/`)).map((x) => x.id);
      const want = (byModule.get(cyc.module) ?? [])
        .map((t) => issues.find((x) => x.name === t))
        .filter((it) => it && !linkedIds.includes(it.id));
      if (want.length > 0) {
        try {
          await plane.post(`/projects/${p.id}/cycles/${c.id}/cycle-issues/`, { issues: want.map((x) => x.id) });
        } catch (e) {
          note(`${def.name} 周期「${cyc.name}」关联任务`, false, brief(e));
          continue;
        }
      }
      note(`${def.name} 周期「${cyc.name}」`, true, `${cyc.start_date}~${cyc.end_date}，新增关联 ${want.length}`);
    }
  }
}

// ---------- 校验 ----------
async function verify() {
  const att = await frappe.list('Attendance', {
    filters: [['employee', '=', ZS], ['attendance_date', '>=', '2026-09-01'], ['attendance_date', '<=', '2026-09-26']],
    fields: ['name', 'attendance_date', 'in_time'],
  });
  const late = att.filter((r) => (r.in_time ?? '').slice(11, 16) > '09:00');
  const goals = await frappe.list('Goal', { filters: [['employee', '=', ZS]], fields: ['name'] });
  const apr = await frappe.get('Appraisal', (await frappe.list('Appraisal', { filters: [['employee', '=', ZS]], fields: ['name'] }))[0]?.name);
  const lnames = await frappe.list('Leave Allocation', { filters: [['employee', '=', ZS]], fields: ['name'] });
  let leaveDays = 0;
  for (const n of lnames) leaveDays += grantedOf(await frappe.get('Leave Allocation', docName(n) ?? n.name));
  const aprDoc = apr ? await frappe.get('Appraisal', apr.name) : null;
  const earnedSum = aprDoc
    ? Math.round((aprDoc.goals ?? []).reduce((s, r) => s + (r.score_earned ?? 0), 0) * 10) / 10
    : 0;
  RESULT.verify = {
    attendance: att.length,
    lateDays: late.map((r) => r.attendance_date),
    goals: goals.length,
    appraisal: { total: aprDoc?.total_score, earnedSum },
    leaveDays,
  };
  log(`\n校验：考勤 ${att.length} 条（迟到 ${late.map((r) => r.attendance_date).join(',') || '无'}）、Goal ${goals.length} 条、Appraisal total_score=${aprDoc?.total_score} Σearned=${earnedSum}、请假额度 ${leaveDays} 天`);
}

// ---------- 7) 任务类型标签 + 委派/定时演示任务（游戏化：类型=Plane 标签，委派奖励=标题内联 +N元）----------
const GAMIFY_PROJECTS = ['员工采购工作台 V2', '行情价自动化', '日常执行'];
const ZS_MEMBER = 'a87f9e39-f55f-458c-9d1f-944b5cd397bb'; // 张三 → Plane 成员演示业务负责人
const TYPE_LABEL_DEFS = [
  { name: '日常任务', color: '#6366f1' },
  { name: '定时任务', color: '#8b5cf6' },
  { name: '委派任务', color: '#f97316' },
];
const SCHEDULED_RE = /保洁|洗车|清洗|每周|对账|巡检/;
const NEW_DEMOS = [
  {
    title: '排查东侧仓库漏水异常 +80元', target: '2026-09-29', kind: 'delegated', done: false,
    desc: ['目标=排查并处理东侧仓库漏水异常', '当前步骤=现场查看漏水点并定位原因', '验收条件=漏水处理完成，附现场照片', '依赖=行政部物业对接人', '截止 18:00'],
  },
  {
    title: '协助前台处理快递丢失投诉 +30元', target: '2026-09-28', kind: 'delegated', done: true,
    desc: ['目标=协助前台处理快递丢失投诉', '当前步骤=已与投诉员工确认快递单号并登记', '验收条件=投诉处理完毕（附处理结果）', '依赖=前台文员'],
  },
  {
    title: '周四送公司商务车去途虎清洗', target: '2026-10-01', kind: 'scheduled', done: false,
    desc: ['目标=每周四送公司商务车去途虎清洗', '当前步骤=按预约时间送车', '验收条件=清洗完成并拍照回传', '依赖=无'],
  },
];

async function fixTaskTypeLabels() {
  const projects = asList(await plane.get('/projects/'));
  for (const p of projects) {
    if (!GAMIFY_PROJECTS.includes(p.name)) continue;
    const labels = asList(await plane.get(`/projects/${p.id}/labels/`));
    const demo = labels.find((l) => l.name === 'demo');
    const typeIds = {};
    for (const def of TYPE_LABEL_DEFS) {
      let l = labels.find((x) => x.name === def.name);
      if (!l) l = await plane.post(`/projects/${p.id}/labels/`, def);
      typeIds[def.name] = l.id;
    }
    const states = asList(await plane.get(`/projects/${p.id}/states/`));
    const groupOf = new Map(states.map((s) => [s.id, s.group]));
    const stateOf = (n) => states.find((s) => s.name === n)?.id;
    const issues = await allIssues(p.id);
    const byTitle = new Map(issues.map((x) => [x.name, x]));

    if (p.name === '日常执行') {
      // 山姆会员卡 → 委派 +50元（用户示例）
      const samsName = [...byTitle.keys()].find((n) => n.startsWith('退掉山姆会员卡'));
      const sams = samsName ? byTitle.get(samsName) : null;
      if (sams) {
        if (!sams.name.startsWith('退掉山姆会员卡 +50元')) {
          await plane.patch(`/projects/${p.id}/issues/${sams.id}/`, { name: '退掉山姆会员卡 +50元' });
        }
        const cur = Array.isArray(sams.labels) ? sams.labels : [];
        if (!cur.includes(typeIds['委派任务'])) {
          await plane.patch(`/projects/${p.id}/issues/${sams.id}/`, { labels: [...cur, typeIds['委派任务']] });
        }
        const after = await plane.get(`/projects/${p.id}/issues/${sams.id}/`);
        note('委派「退掉山姆会员卡 +50元」',
          after.name.startsWith('退掉山姆会员卡 +50元') && (after.labels ?? []).includes(typeIds['委派任务']));
      } else {
        note('找不到「退掉山姆会员卡」', false);
      }
      // 新建委派/定时演示任务
      for (const def of NEW_DEMOS) {
        let it = byTitle.get(def.title);
        if (!it) {
          // 标题可能已被截止时刻后缀（如“ 18:00前”）扩展，改用前缀匹配
          const key = [...byTitle.keys()].find((n) => n.startsWith(def.title));
          if (key) it = byTitle.get(key);
        }
        if (!it) {
          it = await plane.post(`/projects/${p.id}/issues/`, {
            name: def.title,
            state: stateOf('Todo'),
            priority: 'medium',
            assignees: [ZS_MEMBER],
            target_date: def.target,
            labels: [demo?.id, typeIds[def.kind === 'scheduled' ? '定时任务' : '委派任务']].filter(Boolean),
            description_html: def.desc.map((t) => `<p>${t}</p>`).join(''),
          });
        }
        if (def.done && groupOf.get(it.state) !== 'completed') {
          await plane.patch(`/projects/${p.id}/issues/${it.id}/`, { state: stateOf('Done') });
        }
        const after = await plane.get(`/projects/${p.id}/issues/${it.id}/`);
        note(`演示任务「${def.title}」`,
          (after.labels ?? []).includes(typeIds[def.kind === 'scheduled' ? '定时任务' : '委派任务'])
            && (!def.done || after.completed_at != null),
          def.done ? `completed_at=${after.completed_at}` : undefined);
      }
    }

    // 现有未完成任务打标：关键词→定时，其余→日常（委派已处理）
    let tagged = 0;
    for (const it of issues) {
      const group = groupOf.get(it.state);
      if (group === 'completed' || group === 'cancelled') continue;
      if (/\+\s*[¥￥]?\s*\d+(?:\.\d+)?\s*元/u.test(it.name)) continue; // 委派任务（标题内联奖励），已在上面单独处理
      const cur = Array.isArray(it.labels) ? it.labels : [];
      if (cur.includes(typeIds['委派任务'])) continue;
      if (cur.includes(typeIds['日常任务']) || cur.includes(typeIds['定时任务'])) continue;
      const target = SCHEDULED_RE.test(it.name) ? '定时任务' : '日常任务';
      await plane.patch(`/projects/${p.id}/issues/${it.id}/`, { labels: [...cur, typeIds[target]] });
      tagged += 1;
    }
    note(`${p.name} 类型打标`, true, `新增 ${tagged} 条（定时关键词→定时，其余→日常）`);
  }
}

// ---------- 8) 任务截止时刻（标题内 HH:mm 前）+ 严重堵塞演示 ----------
// 约定：任务均为当天强时效任务，截止时刻写在标题里（“HH:mm前”，与委派“+N元”同为标题内联约定）；
// Plane target_date 仅接受日期（带时间值返回 400）。超过截止 48 小时未完结 → 严重堵塞（严重违规）。
// 演示：商品图片抽检 target 改 2026-09-26（已超 48h，展示严重堵塞态）。
const DEADLINE_SPECS = [
  { match: '商品图片抽检', time: '16:00', target: '2026-09-26' },
  { match: '腾讯行情价字段确认', time: '18:00' },
  { match: '行情价接口验收', time: '15:00' },
  { match: '快照格式验收', time: '19:00' },
  { match: '确认腾讯缺失字段', time: '18:30' },
  { match: '退掉山姆会员卡', time: '18:00' },
  { match: '排查东侧仓库漏水异常', time: '18:00' },
  { match: '周四送公司商务车去途虎清洗', time: '09:30' },
];

async function fixDeadlineTimes() {
  const projects = asList(await plane.get('/projects/'));
  let changed = 0;
  for (const p of projects) {
    const issues = await allIssues(p.id);
    for (const it of issues) {
      const spec = DEADLINE_SPECS.find((s) => it.name.startsWith(s.match));
      if (!spec) continue;
      const patch = {};
      if (!/\d{1,2}[:：]\d{2}/u.test(it.name)) {
        patch.name = `${it.name} ${spec.time}前`;
      }
      if (spec.target && it.target_date !== spec.target) {
        patch.target_date = spec.target;
      }
      if (Object.keys(patch).length === 0) continue;
      await plane.patch(`/projects/${p.id}/issues/${it.id}/`, patch);
      changed += 1;
    }
  }
  note('任务截止时刻（标题 HH:mm 前）', true, `更新 ${changed} 条`);
}

try {
  log('== 1/8 Goal 去重 =='); await fixGoals();
  log('== 2/8 考勤 09-22 =='); await fixAttendance();
  log('== 3/8 Appraisal =='); await fixAppraisal();
  log('== 4/8 Leave =='); await fixLeave();
  log('== 5/8 Plane 逾期标签 =='); await fixLateLabels();
  log('== 6/8 Plane 模块/周期 =='); await fixModuleCycleLinks();
  log('== 7/8 任务类型标签 =='); await fixTaskTypeLabels();
  log('== 8/8 截止时刻 =='); await fixDeadlineTimes();
  await verify();
  const url = new URL('./repair-report.json', import.meta.url);
  writeFileSync(url, JSON.stringify(RESULT, null, 2));
  log(`报告已写入 ${url.pathname}`);
} catch (e) {
  RESULT.fatal = brief(e);
  const url = new URL('./repair-report.json', import.meta.url);
  writeFileSync(url, JSON.stringify(RESULT, null, 2));
  console.error('\n[FATAL] repair 中止：', brief(e));
  process.exitCode = 1;
}

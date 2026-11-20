// server/scripts/demo/seed-frappe.mjs — Frappe HR/LMS demo 数据（空站无元数据权限：POST 最小 → 按报错补 → GET 读回）
import { frappe, docName, tryCreate, workdays, log, brief, R } from './lib.mjs';
import { FRAPPE, DEMO_API_USER } from './data.mjs';

// 失败不阻塞：记录到 R.failures 并返回 null
const soft = async (step, fn) => {
  try { return await fn(); } catch (e) { R.failures.push({ step, error: brief(e) }); return null; }
};

// ============ 1) Company / Department / Designation / Employee ============
async function ensureCompany() {
  // 站内已有公司，只查不建（API 用户无 Company 写权限）
  const rows = await frappe.list('Company', { filters: [['company_name', '=', FRAPPE.company]] });
  if (rows.length) return docName(rows[0]);
  throw new Error(`站内未找到公司 ${FRAPPE.company}，且 API 用户无 Company 写权限`);
}

async function ensureDepartment(dep, company) {
  let rows = await frappe.list('Department', { filters: [['department_name', '=', dep]] });
  if (!rows.length) rows = await frappe.list('Department', { filters: [['name', 'like', `%${dep}%`]] });
  if (rows.length) return docName(rows[0]);
  const d = await tryCreate('Department', [
    { department_name: dep, company },
    { department: dep, company },
  ], `Department ${dep}`);
  const name = docName(d);
  R.frappe.created.departments.push(name);
  return name;
}

async function ensureDesignation(des) {
  const rows = await frappe.list('Designation', { filters: [['name', '=', des]] });
  if (rows.length) return docName(rows[0]);
  const d = await tryCreate('Designation', [{ designation_name: des }, { name: des }], `Designation ${des}`);
  const name = docName(d);
  R.frappe.created.designations.push(name);
  return name;
}

async function ensureEmployees(company, depNames, desNames) {
  const all = await frappe.list('Employee', { fields: ['*'] });
  const map = Object.fromEntries(all.filter((r) => (r.employee_id || '').startsWith('DEMO-')).map((r) => [r.employee_id, r.name]));
  for (const e of FRAPPE.employees) {
    if (map[e.employee_id]) { R.frappe.employees[e.employee_id] = map[e.employee_id]; continue; }
    const full = {
      employee_id: e.employee_id, first_name: e.first_name, status: e.status,
      date_of_joining: e.date_of_joining, gender: e.gender, date_of_birth: e.date_of_birth,
      company,
      designation: desNames[e.designation] ?? undefined,
      department: depNames[e.department] ?? undefined,
    };
    const d = await tryCreate('Employee', [
      full,
      { ...full, department: undefined },
      { ...full, department: undefined, designation: undefined },
      { employee_id: e.employee_id, first_name: e.first_name, status: e.status, date_of_joining: e.date_of_joining },
    ], `Employee ${e.employee_id}`);
    R.frappe.employees[e.employee_id] = docName(d);
  }
  log(`  员工：${Object.entries(R.frappe.employees).map(([k, v]) => `${k}→${v}`).join(', ')}`);
  return R.frappe.employees['DEMO-001'];
}

// ============ 2) Appraisal（total_score 必须读出 86）============
async function tuneAppraisalScore(name) {
  const target = FRAPPE.appraisal.target_total;
  for (let round = 0; round < 4; round += 1) {
    const doc = await frappe.get('Appraisal', name);
    const cur = doc.total_score ?? doc.final_score ?? null;
    if (cur === target) { R.verification.appraisalTotalScore = cur; return true; }
    const ratio = cur ? target / cur : null;
    if (cur == null || cur === 0 || ratio > 5 || ratio < 0.2) {
      // 0-5 分制 → 直接 PUT total_score / final_score
      const ok = await soft(`PUT Appraisal ${name} total_score=${target} (round ${round})`, () =>
        frappe.put('Appraisal', name, { total_score: target, final_score: target }));
      if (!ok) return false;
      continue;
    }
    // 按比例缩放子表评分行
    const tbl = doc.appraisal_kras ? 'appraisal_kras' : doc.ratings ? 'ratings' : doc.kras ? 'kras' : null;
    if (!tbl) { await soft(`PUT Appraisal ${name} score (round ${round})`, () => frappe.put('Appraisal', name, { total_score: target })); continue; }
    const rows = (doc[tbl] || []).map((row) => {
      const sf = row.goal_score != null ? 'goal_score' : 'rating';
      const v = Math.round(row[sf] * ratio * 10) / 10;
      return { ...row, [sf]: v };
    });
    await soft(`PUT Appraisal ${name} ${tbl} (round ${round})`, () => frappe.put('Appraisal', name, { [tbl]: rows }));
  }
  const doc = await frappe.get('Appraisal', name);
  R.verification.appraisalTotalScore = doc.total_score ?? doc.final_score ?? null;
  return R.verification.appraisalTotalScore === target;
}

async function ensureAppraisal(zs, company) {
  const APP = FRAPPE.appraisal;
  const rows = await frappe.list('Appraisal', { filters: [['employee', '=', zs]] });
  if (rows.length) { R.frappe.appraisal = docName(rows[0]); await tuneAppraisalScore(R.frappe.appraisal); return; }

  // KRA 主记录（子表 kra 若为 Link 则需要）
  const kraNames = [];
  for (const k of APP.kras) {
    let found = await frappe.list('KRA', { fields: ['name'] });
    let n = found.some((r) => r.name === k.title || docName(r) === k.title) ? k.title : null;
    if (!n) {
      const d = await soft(`KRA ${k.title}`, async () => {
        try { return await frappe.post('KRA', { title: k.title }); }
        catch { return await frappe.post('KRA', { kra: k.title }); }
      });
      if (d) { n = docName(d); R.frappe.created.kras.push(n); }
      else n = k.title; // KRA DocType 不可用 → 子表内直接用字符串（大概率随后失败走 fallback）
    }
    kraNames.push(n);
  }

  // Appraisal Cycle（部分版本必填）
  let cycle = null;
  cycle = await soft('Appraisal Cycle Demo 2026-09', async () => {
    const cyc = FRAPPE.appraisal.cycle;
    try { return docName(await frappe.post('Appraisal Cycle', { cycle_name: cyc.name, company, start_date: cyc.start, end_date: cyc.end })); }
    catch { return docName(await frappe.post('Appraisal Cycle', { name: cyc.name, company, start_date: cyc.start, end_date: cyc.end })); }
  });
  if (cycle) R.frappe.created.appraisalCycle = cycle;

  // 子表字段名试错：表名 × 分数字段名
  const mkRows = (sf) => APP.kras.map((k, i) => ({ kra: kraNames[i], per_weightage: k.per_weightage, [sf]: k.rating }));
  const mkBody = (tbl, sf) => ({ employee: zs, ...(cycle ? { appraisal_cycle: cycle } : {}), [tbl]: mkRows(sf) });
  let doc = null;
  let used = null;
  const combos = [
    ['appraisal_kras', 'goal_score'], ['appraisal_kras', 'rating'], ['appraisal_kras', 'score'],
    ['ratings', 'goal_score'], ['ratings', 'rating'], ['kras', 'rating'],
  ];
  for (const [tbl, sf] of combos) {
    const d = await soft(`Appraisal ${tbl}.${sf}`, () => frappe.post('Appraisal', mkBody(tbl, sf)));
    if (d) { doc = d; used = { table: tbl, scoreField: sf }; break; }
  }
  if (!doc) {
    // 兜底：不带子表直接建
    doc = await soft('Appraisal 裸建', () => frappe.post('Appraisal', { employee: zs, ...(cycle ? { appraisal_cycle: cycle } : {}), total_score: APP.target_total, final_score: APP.target_total }));
  }
  if (!doc) {
    R.fallbacks.push('Appraisal 彻底建不进 → fallback：为张三建 8 条 Goal（7 指标 + 九月 OKR 主目标）');
    await createGoals(zs, true);
    return;
  }
  R.frappe.appraisal = docName(doc);
  R.frappe.appraisalTable = used ?? { table: null, scoreField: null };
  const ok = await tuneAppraisalScore(R.frappe.appraisal);
  if (!ok) {
    R.fallbacks.push(`Appraisal total_score 未能调到 86（当前=${R.verification.appraisalTotalScore}）→ 补建 8 条 Goal fallback`);
    await createGoals(zs, true);
  }
}

// ============ 3) Goal ============
async function postGoal(emp, subject, progress) {
  return tryCreate('Goal', [
    { employee: emp, goal_name: subject, progress, status: 'Open', start_date: '2026-09-01', end_date: '2026-09-30' },
    { employee: emp, subject, progress, status: 'Open' },
    { employee: emp, goal_name: subject, progress },
    { employee_name: emp, goal_name: subject, progress },
  ], `Goal ${subject}`);
}

async function createGoals(zs, withMetrics) {
  R.frappe.goalNames = R.frappe.goalNames ?? [];
  if (withMetrics) {
    for (const k of FRAPPE.appraisal.kras) {
      const d = await soft(`Goal(指标) ${k.title}`, () => postGoal(zs, k.title, k.goal_value));
      if (d) R.frappe.goalNames.push(docName(d));
    }
  }
  const g = FRAPPE.goal;
  const d = await soft(`Goal(主) ${g.subject}`, () => postGoal(zs, g.subject, g.progress));
  if (d) { R.frappe.goal = docName(d); R.frappe.goalNames.push(R.frappe.goal); }
}

// ============ 4) Salary Component / Structure / Slip ============
async function ensureSalary(company, zs) {
  const compNames = {};
  for (const sc of FRAPPE.salaryComponents) {
    const rows = await frappe.list('Salary Component', { filters: [['salary_component', '=', sc.salary_component]] });
    if (rows.length) { compNames[sc.salary_component] = docName(rows[0]); continue; }
    const body = { salary_component: sc.salary_component, type: 'Earning', ...(sc.abbr ? { salary_component_abbr: sc.abbr } : {}) };
    const d = await tryCreate('Salary Component', [body, { salary_component: sc.salary_component, type: 'Earning' }], `Salary Component ${sc.salary_component}`);
    compNames[sc.salary_component] = docName(d);
    R.frappe.created.salaryComponents.push(compNames[sc.salary_component]);
  }
  const earnings = FRAPPE.salaryComponents.map((sc) => ({ salary_component: sc.salary_component, amount: sc.amount }));

  // Salary Structure
  const sst = FRAPPE.salaryStructure;
  const existing = await frappe.list('Salary Structure', { filters: [['name', '=', sst.name]] });
  if (existing.length) R.frappe.salaryStructure = docName(existing[0]);
  else {
    const body = { __newname: sst.name, company, currency: sst.currency, payroll_frequency: sst.payroll_frequency, is_active: 1, earnings, docstatus: 0 };
    const d = await tryCreate('Salary Structure', [
      body,
      { ...body, from_date: '2026-07-01' },
      { ...body, is_active: 0 },
    ], `Salary Structure ${sst.name}`);
    R.frappe.salaryStructure = docName(d);
    R.frappe.created.salaryStructure = R.frappe.salaryStructure;
  }
  // submit 尝试（失败仅报告）
  const submitted = await soft(`Submit Salary Structure ${sst.name}`, async () => {
    try { return await frappe.put('Salary Structure', R.frappe.salaryStructure, { docstatus: 1 }); }
    catch { return frappe.method('frappe.client.submit', { doctype: 'Salary Structure', docname: R.frappe.salaryStructure }); }
  });
  R.salaryStructureSubmitted = Boolean(submitted);

  // Payroll Period（Slip 可能必填）
  let pp = null;
  const pps = await frappe.list('Payroll Period', { filters: [['name', '=', FRAPPE.payrollPeriod.name]] });
  if (pps.length) pp = docName(pps[0]);
  else {
    const p = FRAPPE.payrollPeriod;
    pp = await soft(`Payroll Period ${p.name}`, async () => {
      try { return docName(await frappe.post('Payroll Period', { __newname: p.name, start_date: p.start, end_date: p.end, company })); }
      catch { return docName(await frappe.post('Payroll Period', { __newname: p.name, start_date: p.start, end_date: p.end, companies: [{ company }] })); }
    });
    if (pp) R.frappe.created.payrollPeriod = pp;
  }

  // Salary Slip（失败不阻塞）
  const sl = FRAPPE.salarySlip;
  const slipBody = {
    employee: zs, start_date: sl.start, end_date: sl.end, posting_date: sl.posting_date,
    company, earnings, ...(pp ? { payroll_period: pp } : {}),
  };
  const slip = await soft('Salary Slip（不阻塞）', async () => {
    try { return await frappe.post('Salary Slip', slipBody); }
    catch { return await frappe.post('Salary Slip', { ...slipBody, payroll_period: undefined }); }
  });
  if (slip) R.frappe.salarySlip = docName(slip);
}

// ============ 5) Attendance / Leave ============
async function ensureAttendance(zs) {
  const at = FRAPPE.attendance;
  const days = workdays(at.from, at.to); // 19 个工作日
  const existing = await frappe.list('Attendance', {
    filters: [['employee', '=', zs], ['attendance_date', '>=', at.from], ['attendance_date', '<=', at.to]],
    fields: ['name', 'attendance_date'],
  });
  const have = new Map(existing.map((r) => [r.attendance_date, r.name]));
  R.frappe.attendanceNames = R.frappe.attendanceNames ?? [];
  for (const day of days) {
    if (have.has(day)) { R.frappe.attendanceNames.push(have.get(day)); continue; }
    const status = day === at.lateDate ? 'Late' : 'Present';
    const d = await soft(`Attendance ${day} ${status}`, () => frappe.post('Attendance', { employee: zs, attendance_date: day, status }));
    if (d) R.frappe.attendanceNames.push(docName(d));
  }
  R.frappe.attendanceCount = R.frappe.attendanceNames.length;
  log(`  Attendance：${R.frappe.attendanceCount}/${days.length}（Late=${at.lateDate}）`);
}

async function ensureLeave(zs) {
  const lv = FRAPPE.leave;
  const rows = await frappe.list('Leave Type', { filters: [['name', '=', lv.leave_type]] });
  if (rows.length) R.frappe.created.leaveType = null; // 已存在，不删
  else {
    const d = await tryCreate('Leave Type', [{ leave_type_name: lv.leave_type }, { leave_type: lv.leave_type }, { name: lv.leave_type }], `Leave Type ${lv.leave_type}`);
    R.frappe.created.leaveType = docName(d);
  }
  const existing = await frappe.list('Leave Application', { filters: [['employee', '=', zs], ['from_date', '=', lv.date]] });
  if (existing.length) { R.frappe.leaveApplication = docName(existing[0]); return; }
  const body = {
    employee: zs, leave_type: lv.leave_type, from_date: lv.date, to_date: lv.date,
    half_day: 1, total_leave_days: 0.5,
  };
  const d = await soft('Leave Application', async () => {
    try { return await frappe.post('Leave Application', { ...body, status: lv.status, leave_approver: DEMO_API_USER }); }
    catch { try { return await frappe.post('Leave Application', { ...body, status: lv.status }); }
      catch { return frappe.post('Leave Application', body); } }
  });
  if (d) R.frappe.leaveApplication = docName(d);
}

// ============ 6) LMS Course / Enrollment / Quiz ============
async function ensureLms() {
  const existing = await frappe.list('LMS Course', { fields: ['name', 'course_code'] })
    .catch(async () => frappe.list('LMS Course', { fields: ['name'] }));
  const courseNameSet = new Set(existing.map((r) => r.name));
  const courseMap = Object.fromEntries(existing.filter((r) => r.course_code).map((r) => [r.course_code, r.name]));
  for (const c of FRAPPE.courses) {
    if (courseMap[c.code] || courseNameSet.has(c.name)) {
      if (!courseMap[c.code]) courseMap[c.code] = c.name;
      continue;
    }
    const d = await tryCreate('LMS Course', [
      { course_code: c.code, course_name: c.name },
      { course_code: c.code, title: c.name },
      { course_name: c.name },
    ], `LMS Course ${c.code}`);
    courseMap[c.code] = docName(d);
    R.frappe.created.courses.push(courseMap[c.code]);
  }
  log(`  课程：${Object.keys(courseMap).length}/${FRAPPE.courses.length}`);

  // Member（Enrollment 关联用）
  let memberName = null;
  const mrows = await frappe.list('Member', { filters: [['email', '=', DEMO_API_USER]] });
  if (mrows.length) memberName = docName(mrows[0]);
  else {
    const m = await soft(`Member ${DEMO_API_USER}`, async () => {
      try { return await frappe.post('Member', { email: DEMO_API_USER }); }
      catch { try { return await frappe.post('Member', { name: DEMO_API_USER, email: DEMO_API_USER }); }
        catch { return frappe.post('Member', { email: DEMO_API_USER, first_name: 'Demo' }); } }
    });
    if (m) { memberName = docName(m); R.frappe.created.member = memberName; }
  }

  // 进度：主路径 LMS Enrollment；失败 → course description 首行 [progress:x]
  R.frappe.enrollmentNames = [];
  let enrollOk = 0;
  for (const c of FRAPPE.courses) {
    const courseName = courseMap[c.code];
    const d = await soft(`LMS Enrollment ${c.code}`, async () => {
      try { return await frappe.post('LMS Enrollment', { course: courseName, member: memberName, progress: c.progress }); }
      catch { return frappe.post('LMS Enrollment', { course: courseName, member: memberName, progress: c.progress, status: 'In Progress' }); }
    });
    if (d) { R.frappe.enrollmentNames.push(docName(d)); enrollOk += 1; continue; }
    const ok = await soft(`Course ${c.code} description fallback`, () =>
      frappe.put('LMS Course', courseName, { description: `[progress:${c.progress}]` }));
    if (ok) R.fallbacks.push(`LMS Enrollment 建不进（${c.code}）→ course description [progress:${c.progress}]`);
  }
  R.lmsProgressPath = enrollOk === FRAPPE.courses.length ? 'LMS Enrollment'
    : enrollOk === 0 ? 'fallback-description' : `mixed（${enrollOk} Enrollment + ${FRAPPE.courses.length - enrollOk} description）`;

  // Quiz + 成绩
  R.frappe.quizResultNames = [];
  for (const q of FRAPPE.quizzes) {
    let quizName;
    try {
      quizName = docName(await tryCreate('LMS Quiz', [
        { title: q.name }, { quiz_name: q.name }, { name: q.name },
      ], `LMS Quiz ${q.name}`));
      R.frappe.created.quizzes.push(quizName);
    } catch (e) {
      R.failures.push({ step: `LMS Quiz ${q.name}`, error: brief(e) });
      continue;
    }
    const d = await soft(`LMS Quiz Result ${q.name}`, async () => {
      try { return await frappe.post('LMS Quiz Result', { quiz: quizName, score: q.score, passed: q.passed ? 1 : 0 }); }
      catch { return frappe.post('LMS Quiz Result', { quiz: quizName, score: q.score }); }
    });
    if (d) R.frappe.quizResultNames.push(docName(d));
    else {
      const ok = await soft(`Quiz ${q.name} description fallback`, () =>
        frappe.put('LMS Quiz', quizName, { description: `[score:${q.score}][passed:${q.passed ? 'true' : 'false'}]` }));
      if (ok) R.fallbacks.push(`LMS Quiz Result 建不进（${q.name}）→ quiz description [score:${q.score}][passed:true]`);
    }
  }
  R.quizResultPath = R.frappe.quizResultNames.length === FRAPPE.quizzes.length ? 'LMS Quiz Result'
    : R.frappe.quizResultNames.length === 0 ? 'fallback-description' : 'mixed';
}

// ============ 9) ERPNext 业务单据：今日询价 RFQ×2、待采购 Material Request×3 ============
const DEMO_TODAY = '2026-09-28';
const RFQ_DEFS = [
  { items: [['SKU010', 40], ['SKU007', 15]], suppliers: ['MA Inc.', 'Summit Traders Ltd.'] },
  { items: [['SKU009', 60], ['SKU004', 25]], suppliers: ['Zuckerman Security Ltd.', 'MA Inc.'] },
];
const DEMO_WAREHOUSE = '成品 - 泛亚';
const MR_DEFS = [
  { items: [['SKU010', 40], ['SKU009', 60], ['SKU004', 25]] },
  { items: [['SKU007', 15], ['SKU008', 30]] },
  { items: [['SKU002', 8]] },
];

export async function ensureErpNext() {
  R.frappe.created.rfqs ??= [];
  R.frappe.created.mrs ??= [];
  const company = FRAPPE.company;
  // RFQ：今日询价 2 张（幂等：已有今日 RFQ 则跳过）
  const todayRfqs = await frappe.list('Request for Quotation', {
    filters: [['transaction_date', '=', DEMO_TODAY]], fields: ['name'],
  });
  if (todayRfqs.length >= RFQ_DEFS.length) {
    log(`  = RFQ 已有 ${todayRfqs.length} 张，跳过`);
  } else {
    for (const def of RFQ_DEFS.slice(todayRfqs.length)) {
      const d = await soft(`RFQ（${def.items.map(([c]) => c).join('+')}）`, () =>
        frappe.post('Request for Quotation', {
          company,
          transaction_date: DEMO_TODAY,
          schedule_date: '2026-10-06',
          suppliers: def.suppliers.map((s) => ({ supplier: s })),
          items: def.items.map(([item_code, qty]) => ({
            item_code, qty, uom: 'Nos', conversion_factor: 1,
            schedule_date: '2026-10-06', warehouse: DEMO_WAREHOUSE,
          })),
        }));
      if (d) {
        const nm = docName(d);
        R.frappe.created.rfqs.push(nm);
        log(`  + RFQ ${nm}（${def.items.map(([c]) => c).join('、')} → ${def.suppliers.join('、')}）`);
      }
    }
  }
  // MR：待采购 3 张（幂等：已有今日 MR 则跳过）
  const todayMrs = await frappe.list('Material Request', {
    filters: [['transaction_date', '=', DEMO_TODAY]], fields: ['name'],
  });
  if (todayMrs.length >= MR_DEFS.length) {
    log(`  = Material Request 已有 ${todayMrs.length} 张，跳过`);
  } else {
    for (const def of MR_DEFS.slice(todayMrs.length)) {
      const d = await soft(`MR（${def.items.map(([c]) => c).join('+')}）`, () =>
        frappe.post('Material Request', {
          company,
          transaction_date: DEMO_TODAY,
          material_request_type: 'Purchase',
          items: def.items.map(([item_code, qty]) => ({
            item_code, qty, uom: 'Nos', conversion_factor: 1,
            schedule_date: '2026-10-06', warehouse: DEMO_WAREHOUSE,
          })),
        }));
      if (d) {
        const nm = docName(d);
        R.frappe.created.mrs.push(nm);
        log(`  + Material Request ${nm}（${def.items.map(([c]) => c).join('、')}）`);
      }
    }
  }
}

// ============ 入口 ============
export async function runFrappe() {
  const company = await ensureCompany();
  log(`  Company：${company}`);
  const depNames = {};
  for (const dep of FRAPPE.departments) depNames[dep] = await ensureDepartment(dep, company);
  const desNames = {};
  for (const des of FRAPPE.designations) desNames[des] = await ensureDesignation(des);
  const zs = await ensureEmployees(company, depNames, desNames);
  await ensureAppraisal(zs, company);
  await createGoals(zs, false); // 主目标 ≥1（KRA fallback 时指标 Goal 已在 ensureAppraisal 里建）
  await ensureSalary(company, zs);
  await ensureAttendance(zs);
  await ensureLeave(zs);
  await ensureLms();
  await ensureErpNext();
}

export async function verifyFrappe() {
  const v = {};
  const zs = R.frappe.employees['DEMO-001'];
  if (zs) {
    const emp = await soft('GET Employee DEMO-001（校验）', () => frappe.get('Employee', zs));
    v.employeeZhangsan = { name: zs, status: emp?.status, designation: emp?.designation, department: emp?.department };
  }
  if (R.frappe.appraisal) {
    const doc = await soft('GET Appraisal（校验）', () => frappe.get('Appraisal', R.frappe.appraisal));
    v.appraisalTotalScore = doc?.total_score ?? doc?.final_score ?? R.verification.appraisalTotalScore ?? null;
  }
  v.attendanceCount = R.frappe.attendanceCount ?? null;
  v.courses = R.frappe.created.courses.length + (R.frappe.created.courses.length ? 0 : Object.keys(R.frappe.created.courses).length);
  v.courseCount = R.frappe.created.courses.length;
  v.quizCount = R.frappe.created.quizzes.length;
  v.lmsProgressPath = R.lmsProgressPath ?? null;
  v.quizResultPath = R.quizResultPath ?? null;
  R.verification.frappe = v;
  return v;
}

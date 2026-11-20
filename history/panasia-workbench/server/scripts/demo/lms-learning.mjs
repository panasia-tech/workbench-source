// LMS 学习演示数据（幂等）：把 learning-demo.ts 的 5 门课 + 2 场考试建到 Frappe hr 站点
// 结构：LMS Category(必修/教程/进阶) + LMS Course ×5 + LMS Enrollment ×5(张三进度)
//      + LMS Quiz ×2 + LMS Quiz Submission ×2(92/88 分)
//      + LMS Certificate ×5(承载历史日期：3 课程完成 + 2 考试日期；Frappe creation 不可写)
// 依赖：张三 User 961000e173@example.invalid + Employee.user_id 回填（脚本内自建）
import { frappe } from './lib.mjs';

const ZHANGSAN = {
  email: '961000e173@example.invalid',
  name: '张三',
};

const COURSES = [
  { title: '采购岗位入门', category: '必修', progress: 100, completedAt: '2026-06-18' },
  { title: '商品验货基础', category: '必修', progress: 100, completedAt: '2026-09-12' },
  { title: '扫地机器人验货教程', category: '教程', progress: 70, completedAt: null },
  { title: '采购议价进阶', category: '进阶', progress: 0, completedAt: null },
  { title: '商品图片验收规范', category: null, progress: 100, completedAt: '2026-08-05' },
];

const EXAMS = [
  { title: '采购岗位基础考试', score: 92, examDate: '2026-09-15' },
  { title: '商品验货考试', score: 88, examDate: '2026-09-22' },
];

const CATEGORIES = ['必修', '教程', '进阶'];

const listAll = (dt, fields) => frappe.list(dt, { fields: JSON.stringify(fields), limit: 0 });
const docName = (r) => r?.name ?? r?.data?.name;

// 1. 张三 User + Employee user_id 回填
let zhangsanUser = null;
for (const u of await listAll('User', ['name'])) {
  if (u.name === ZHANGSAN.email) zhangsanUser = u.name;
}
if (!zhangsanUser) {
  zhangsanUser = docName(await frappe.post('User', {
    email: ZHANGSAN.email,
    first_name: ZHANGSAN.name,
    full_name: ZHANGSAN.name,
    enabled: 1,
  }));
  console.log(`User 创建: ${zhangsanUser}`);
}
let employeeName = null;
for (const e of await listAll('Employee', ['name', 'employee_name', 'user_id'])) {
  if (e.employee_name === ZHANGSAN.name) employeeName = e.name;
}
if (employeeName) {
  const emp = await frappe.get('Employee', employeeName);
  if (emp.user_id !== zhangsanUser) {
    await frappe.put('Employee', employeeName, { user_id: zhangsanUser });
    console.log(`Employee ${employeeName} user_id -> ${zhangsanUser}`);
  }
}

// 2. LMS Category
const catByName = new Map();
for (const c of await listAll('LMS Category', ['name', 'category'])) catByName.set(c.category, c.name);
for (const cat of CATEGORIES) {
  if (!catByName.has(cat)) {
    catByName.set(cat, docName(await frappe.post('LMS Category', { category: cat })));
    console.log(`LMS Category 创建: ${cat}`);
  }
}

// 3. LMS Course
const courseByTitle = new Map();
for (const c of await listAll('LMS Course', ['name', 'title'])) courseByTitle.set(c.title, c.name);
for (const c of COURSES) {
  if (courseByTitle.has(c.title)) continue;
  const body = {
    title: c.title,
    short_introduction: `${c.title}（泛亚员工学习课程）`,
    description: `<p>${c.title}：面向采购岗位的内部培训课程。</p>`,
    instructors: [{ instructor: 'Administrator' }],
    published: 1,
    paid_course: 0,
  };
  if (c.category) body.category = catByName.get(c.category);
  courseByTitle.set(c.title, docName(await frappe.post('LMS Course', body)));
  console.log(`Course 创建: ${c.title} -> ${courseByTitle.get(c.title)}`);
}

// 4. LMS Enrollment（张三注册 + 进度）
const enrollments = await listAll('LMS Enrollment', ['name', 'member', 'course', 'progress']);
const enrollKey = (r) => `${r.member}|${r.course}`;
const enrollByCourse = new Map();
for (const e of enrollments) enrollByCourse.set(enrollKey({ member: e.member, course: e.course }), e);
for (const c of COURSES) {
  const courseName = courseByTitle.get(c.title);
  const key = enrollKey({ member: zhangsanUser, course: courseName });
  const found = enrollByCourse.get(key);
  if (found) {
    if (found.progress !== c.progress) {
      await frappe.put('LMS Enrollment', found.name, { progress: c.progress });
      console.log(`Enrollment 进度修正: ${c.title} -> ${c.progress}`);
    }
    continue;
  }
  docName(await frappe.post('LMS Enrollment', {
    member: zhangsanUser,
    member_name: ZHANGSAN.name,
    member_type: 'Student',
    course: courseName,
    progress: c.progress,
  }));
  console.log(`Enrollment 创建: ${c.title} progress=${c.progress}`);
}

// 5. LMS Quiz + Quiz Submission
const quizByTitle = new Map();
for (const q of await listAll('LMS Quiz', ['name', 'title'])) quizByTitle.set(q.title, q.name);
for (const e of EXAMS) {
  if (!quizByTitle.has(e.title)) {
    quizByTitle.set(e.title, docName(await frappe.post('LMS Quiz', {
      title: e.title,
      total_marks: 100,
      passing_percentage: 60,
    })));
    console.log(`Quiz 创建: ${e.title}`);
  }
}
const quizSubs = await listAll('LMS Quiz Submission', ['name', 'member', 'quiz_title', 'score']);
const subByTitle = new Map();
for (const s of quizSubs) if (s.member === zhangsanUser) subByTitle.set(s.quiz_title, s);
for (const e of EXAMS) {
  if (subByTitle.has(e.title)) continue;
  docName(await frappe.post('LMS Quiz Submission', {
    quiz: quizByTitle.get(e.title),
    quiz_title: e.title,
    member: zhangsanUser,
    member_name: ZHANGSAN.name,
    score: e.score,
    score_out_of: 100,
    percentage: e.score,
    passing_percentage: 60,
  }));
  console.log(`QuizSubmission 创建: ${e.title} ${e.score} 分`);
}

// 6. LMS Certificate（历史日期载体）
const certs = await listAll('LMS Certificate', ['name', 'member', 'course_title']);
const certByTitle = new Map();
for (const cert of certs) {
  if (cert.member === zhangsanUser) certByTitle.set(cert.course_title, cert.name);
}
const certPayload = [];
for (const c of COURSES) {
  if (c.completedAt) {
    certPayload.push({ courseTitle: c.title, courseLink: courseByTitle.get(c.title), issueDate: c.completedAt });
  }
}
for (const e of EXAMS) {
  certPayload.push({ courseTitle: e.title, courseLink: null, issueDate: e.examDate });
}
for (const p of certPayload) {
  if (certByTitle.has(p.courseTitle)) continue;
  const body = {
    member: zhangsanUser,
    member_name: ZHANGSAN.name,
    course_title: p.courseTitle,
    issue_date: p.issueDate,
    template: 'Certificate',
    published: 1,
  };
  if (p.courseLink) body.course = p.courseLink;
  docName(await frappe.post('LMS Certificate', body));
  console.log(`Certificate 创建: ${p.courseTitle} @ ${p.issueDate}`);
}

// 7. 回读验证
const [coursesBack, enrollsBack, subsBack, certsBack] = await Promise.all([
  listAll('LMS Course', ['name', 'title', 'category']),
  listAll('LMS Enrollment', ['name', 'member', 'course', 'progress']),
  listAll('LMS Quiz Submission', ['name', 'quiz_title', 'score', 'member']),
  listAll('LMS Certificate', ['name', 'course_title', 'issue_date', 'member']),
]);
console.log('\n== 验证 ==');
console.log(`Courses: ${coursesBack.length} 门`);
console.log(`张三 Enrollments: ${enrollsBack.filter((e) => e.member === zhangsanUser).length} 条`);
console.log(`张三 QuizSubmissions: ${subsBack.filter((s) => s.member === zhangsanUser).length} 条`);
const zc = certsBack.filter((c) => c.member === zhangsanUser);
console.log(`张三 Certificates: ${zc.length} 条`);
for (const c of zc) console.log(`  ${c.course_title} @ ${c.issue_date}`);

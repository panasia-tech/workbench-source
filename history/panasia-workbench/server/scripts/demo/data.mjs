// server/scripts/demo/data.mjs — Demo seed 纯数据定义（无逻辑 / 无 HTTP）。今天 = 2026-09-28（周一）

export const INVITE_ROLE = 15;
export const DEMO_MEMBER_EMAILS = {
  zhangsan: '209bbc3498@example.invalid',
  lisi: 'f0a241cbdb@example.invalid',
  wangzhuguan: 'c94b018a90@example.invalid',
};
// 现有成员（绝不删除）
export const PROTECTED_MEMBER_IDS = ['7b812915-8c3a-44e6-87b6-1653f9b46b65', 'a87f9e39-f55f-458c-9d1f-944b5cd397bb'];
export const FALLBACK_ZHANGSAN_MEMBER_ID = 'a87f9e39-f55f-458c-9d1f-944b5cd397bb'; // 演示业务负责人
export const DEMO_API_USER = 'dade2cfbb3@example.invalid';

export const LABEL_DEMO = { name: 'demo', color: '#f59e0b' };

// DONE 填充 issue 的紧凑构造器
const done = (module, title, target) => ({
  state: 'DONE', priority: 'medium', assignee: 'zhangsan', module, title, target,
});

// ============ 项目 1：员工采购工作台 V2 ============
export const PROJECT_1 = {
  key: 'p1', name: '员工采购工作台 V2', start: '2026-09-01', end: '2026-12-01',
  identifier: 'PROCUREMENT', expectedIssues: 25,
  modules: ['采购报价', '商品图片', '行情价接入', '员工端', '上线测试'],
  issues: [
    { ref: 'tencent', title: '腾讯行情价字段确认', state: 'BLOCKED', priority: 'high',
      target: '2026-09-28', assignee: 'zhangsan', module: '行情价接入',
      desc: [
        '目标=完成腾讯行情价 API 契约中缺失的 3 个字段定义',
        '当前步骤=等待腾讯回复缺失字段说明',
        '验收条件=腾讯回复并确认字段清单',
        '依赖=腾讯接口人员',
        '截止 16:00',
      ],
      comments: ['<p>【阻塞】原因：腾讯尚未回复缺失字段；等待：腾讯接口人员；下一步：16:00 再次跟进</p>'] },
    { ref: 'sub-a', parentRef: 'tencent', title: '开发字段兼容逻辑', state: 'IN_PROGRESS', priority: 'medium',
      target: '2026-09-30', assignee: 'lisi', module: '行情价接入' },
    { ref: 'sub-b', parentRef: 'tencent', title: '确认腾讯缺失字段', state: 'BLOCKED', priority: 'medium',
      target: '2026-09-29', assignee: 'zhangsan', module: '行情价接入' },
    { ref: 'image-check', title: '商品图片抽检 100 条', state: 'TODO', priority: 'medium',
      target: '2026-09-28', assignee: 'zhangsan', module: '商品图片',
      desc: [
        '目标=完成今日新增商品图片质量抽检',
        '当前步骤=从今天 200 条新图中抽 100 条',
        '验收条件=输出抽检报告（附抽检报告链接）',
        '依赖=无',
        '截止 18:00',
        '教程：商品图片验收规范｜预计 3 分钟',
      ] },
    { ref: 'snapshot', title: '快照格式验收', state: 'IN_PROGRESS', priority: 'medium',
      target: '2026-09-29', assignee: 'zhangsan', module: '员工端',
      desc: [
        '目标=完成员工端行情价快照格式验收',
        '当前步骤=核对 09-26 快照样例',
        '验收条件=快照字段与格式确认通过',
        '依赖=行情价接入模块',
        '截止 18:00',
      ] },
    { ref: 'supplier', title: '供应商资质复审', state: 'TODO', priority: 'medium', module: '采购报价' },
    { ref: 'launch', title: '上线测试计划', state: 'TODO', priority: 'medium', module: '上线测试' },
    // 18 个 DONE 填充（target 散布 09-15~09-28，其中 2 个故意逾期 09-10 / 09-12）
    done('采购报价', '供应商报价单整理', '2026-09-15'),
    done('采购报价', '京东自营报价核价', '2026-09-16'),
    done('采购报价', '采购订单审核与归档', '2026-09-17'),
    done('采购报价', '供应商资质档案更新', '2026-09-18'),
    done('采购报价', '月度比价报告整理', '2026-09-10'),
    done('采购报价', '采购合同归档核对', '2026-09-19'),
    done('采购报价', '办公用品月度采购登记', '2026-09-21'),
    done('采购报价', '供应商联系方式维护', '2026-09-22'),
    done('采购报价', '报价历史数据比对', '2026-09-12'),
    done('采购报价', '采购流程总结文档', '2026-09-24'),
    done('采购报价', '供应商评估表更新', '2026-09-26'),
    done('商品图片', '商品图片规范文档', '2026-09-20'),
    done('商品图片', '批量改图脚本编写', '2026-09-23'),
    done('商品图片', '商品图片质量抽检记录', '2026-09-25'),
    done('商品图片', '图片库分类标签整理', '2026-09-27'),
    done('行情价接入', '行情价字段定义文档', '2026-09-22'),
    done('行情价接入', '行情价接口联调测试', '2026-09-25'),
    done('员工端', '员工端采购模块需求文档', '2026-09-26'),
  ],
};

// ============ 项目 2：行情价自动化 ============
export const PROJECT_2 = {
  key: 'p2', name: '行情价自动化', start: '2026-09-10', end: '2026-10-15',
  identifier: 'PRICING', expectedIssues: 9,
  modules: ['数据源接入', '字段映射', '批量抓取', '快照生成', '审计验证'],
  issues: [
    // 7 个 DONE（target 均不逾期）
    done('数据源接入', '数据源接口联调', '2026-09-12'),
    done('数据源接入', '数据源连接稳定性验证', '2026-09-15'),
    done('字段映射', '字段映射表评审', '2026-09-16'),
    done('批量抓取', '批量抓取脚本部署', '2026-09-18'),
    done('快照生成', '快照生成流水线验证', '2026-09-20'),
    done('审计验证', '行情价快照数据抽检', '2026-09-22'),
    done('审计验证', '行情价数据比对报告', '2026-09-24'),
    { ref: 'acceptance', title: '行情价接口验收', state: 'READY_FOR_REVIEW', priority: 'high',
      target: '2026-09-28', assignee: 'zhangsan', module: '审计验证',
      desc: ['验收腾讯行情价接口最新字段映射与快照结果', '验收人：王主管'] },
    { ref: 'research', title: '行情价邮件订阅方式调研', state: 'CANCELLED', priority: 'low',
      target: '2026-09-20', assignee: 'zhangsan' },
  ],
};

// ============ 项目 3：日常执行 ============
export const PROJECT_3 = {
  key: 'p3', name: '日常执行', start: '2026-09-01', end: '2026-09-30',
  identifier: 'DAILY', expectedIssues: 3, modules: [],
  issues: [
    { ref: 'sams', title: '退掉山姆会员卡', state: 'IN_PROGRESS', priority: 'medium',
      target: '2026-09-28', assignee: 'zhangsan',
      desc: ['老板张总要求今天退掉公司山姆会员卡（card ending 8821）', '已完成商家客服联系，等待处理'],
      comments: [
        '<p>12:01 张总（王主管代发）：提出任务——今天退掉山姆会员卡</p>',
        '<p>12:05 AI 生成：AI 草稿已生成，请确认后下发</p>',
        '<p>12:08 张三：修改截止时间为 17:00 前完成</p>',
        '<p>12:08 张三：确认下发执行</p>',
        '<p>12:10 王主管：查看任务进度</p>',
        '<p>12:15 张三：已联系山姆客服（工单号 SR-20260928-1142）</p>',
        '<p>12:20 张三：客服要求提供验证码</p>',
        '<p>12:22 张三：申请验证码（已发送至预留手机）</p>',
        '<p>12:25 张三：验证码已提供</p>',
        '<p>12:28 张三：上传退卡截图（对话记录与工单状态）</p>',
        '<p>12:31 AI 检查：检测到截图缺少退款金额页，标记为需补充</p>',
        '<p>12:32 张三：已补充截图，任务进入待验收</p>',
      ] },
    { ref: 'refund-shot', title: '补充退款截图', state: 'REJECTED', priority: 'medium',
      target: '2026-09-28', assignee: 'zhangsan',
      desc: ['退款截图缺少金额页，已打回，需补充后重新提交'],
      comments: ['<p>12:31 王主管：打回——退款金额页缺失，请补充后重新提交</p>'] },
    { ref: 'training', title: '采购岗位基础培训', state: 'DONE', priority: 'low',
      target: '2026-09-28', assignee: 'zhangsan',
      comments: ['<p>16:30 完成培训</p>'] },
  ],
};

// ============ Frappe（HR / LMS）============
export const FRAPPE = {
  company: '杭州泛亚电子',
  departments: ['采购部', '技术部', '管理部'],
  designations: ['采购专员', '程序员', '主管'],
  employees: [
    { employee_id: 'DEMO-001', first_name: '张三', designation: '采购专员', department: '采购部',
      status: 'Active', date_of_joining: '2026-07-01', gender: 'Male', date_of_birth: '1995-03-15' },
    { employee_id: 'DEMO-002', first_name: '李四', designation: '程序员', department: '技术部',
      status: 'Active', date_of_joining: '2026-07-01', gender: 'Male', date_of_birth: '1996-08-20' },
    { employee_id: 'DEMO-003', first_name: '王主管', designation: '主管', department: '管理部',
      status: 'Active', date_of_joining: '2026-07-01', gender: 'Female', date_of_birth: '1990-11-02' },
  ],
  // Appraisal KRA 子表方案：total = Σ(w×r)/5 = (15×5 + 15×5 + 14×4×5)/5 = 86
  appraisal: {
    kras: [
      { title: '采购任务及时率', per_weightage: 15, rating: 5, goal_value: 93 },
      { title: '项目任务完成率', per_weightage: 15, rating: 5, goal_value: 81 },
      { title: '一次验收通过率', per_weightage: 14, rating: 4, goal_value: 88 },
      { title: '平均响应时间（11 分钟）', per_weightage: 14, rating: 4, goal_value: 11 },
      { title: '阻塞升级次数（2）', per_weightage: 14, rating: 4, goal_value: 2 },
      { title: '必修课程完成率（100）', per_weightage: 14, rating: 4, goal_value: 100 },
      { title: '考试平均分（92）', per_weightage: 14, rating: 4, goal_value: 92 },
    ],
    target_total: 86,
    cycle: { name: 'Demo 2026-09', start: '2026-09-01', end: '2026-09-30' },
  },
  goal: { subject: '九月 OKR 目标', progress: 78 }, // KRA fallback 时另有 7 条指标 Goal
  salaryComponents: [
    { salary_component: 'Basic', abbr: null, amount: 6000 },
    { salary_component: '绩效奖金', abbr: 'JX', amount: 1250 },
    { salary_component: '全勤奖', abbr: 'QQ', amount: 300 },
    { salary_component: '其他奖励', abbr: 'QT', amount: 200 },
  ],
  salaryStructure: { name: '采购专员-月度', currency: 'CNY', payroll_frequency: 'Monthly' },
  salarySlip: { start: '2026-09-01', end: '2026-09-30', posting_date: '2026-09-28' },
  payrollPeriod: { name: 'Demo Payroll Period', start: '2026-09-01', end: '2026-09-30' },
  attendance: { from: '2026-09-01', to: '2026-09-26', lateDate: '2026-09-22' }, // 19 个工作日
  leave: { date: '2026-09-24', leave_type: '事假', status: 'Approved' },
  courses: [
    { code: 'DEMO-REQUIRED-01', name: '采购岗位入门', tag: 'DEMO-REQUIRED', progress: 100 },
    { code: 'DEMO-REQUIRED-02', name: '商品验货基础', tag: 'DEMO-REQUIRED', progress: 100 },
    { code: 'DEMO-TUTORIAL-01', name: '扫地机器人验货教程', tag: 'DEMO-TUTORIAL', progress: 70 },
    { code: 'DEMO-ADVANCED-01', name: '采购议价进阶', tag: 'DEMO-ADVANCED', progress: 0 },
    { code: 'DEMO-SHORT-01', name: '商品图片验收规范', tag: 'DEMO-SHORT', progress: 100 },
  ],
  quizzes: [
    { name: '采购岗位基础考试', score: 92, passed: true },
    { name: '商品验货考试', score: 88, passed: true },
  ],
};

// ============ 报告固定备注（已知口径）============
export const REPORT_NOTES = [
  '① 首页计数当前后端不过滤子任务，张三 BLOCKED 实际显示 2（腾讯行情价字段确认 + 子任务B「确认腾讯缺失字段」），接口改造时处理',
  '② Attendance 覆盖 2026-09-01~09-26 共 19 个工作日（周一~周五），其中 09-22 status=Late，其余 Present',
  '③ 「采购岗位基础培训」target=2026-09-28（不能是 09-27：逾期会破坏张三任务及时率 92% = 24/26）',
];

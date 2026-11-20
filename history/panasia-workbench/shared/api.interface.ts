/* 前后端共享的类型写在这里 */

export type EmployeeRole =
  | 'procurement'
  | 'sales'
  | 'warehouse'
  | 'general'
  | 'admin';

export type TaskStatus =
  | 'TODO'
  | 'IN_PROGRESS'
  | 'WAITING'
  | 'BLOCKED'
  | 'READY_FOR_REVIEW'
  | 'REJECTED'
  | 'DONE'
  | 'CANCELLED';

export type TaskType =
  | 'daily'
  | 'scheduled'
  | 'delegated'
  | 'workorder'
  | 'standard';

export interface TaskSummary {
  id: string;
  projectId: string;
  projectName: string;
  sequenceId: number | null;
  title: string;
  status: TaskStatus;
  statusLabel: string;
  priority: 'urgent' | 'high' | 'medium' | 'low' | 'none';
  priorityLabel: string;
  deadline: string | null;
  deadlineTime: string | null;
  currentAction: string | null;
  isToday: boolean;
  taskType: TaskType;
  rewardAmount: number | null;
  evidenceSummary: string | null;
  /** 描述里「工时=」一行换算成的小时数（天按 8 小时）；没写或认不出为 null */
  workHours: number | null;
  /** 「工时=」后面的原文，如「1.5天」；没写为 null */
  workHoursText: string | null;
  estimatedEarning: number | null;
  severeBlocked: boolean;
  completedAt: string | null;
  plannedTime?: string | null;
  /** Plane 状态名（如「工时报价」）；开发需求卡片用它显示走到哪一步 */
  stateName?: string | null;
  /** 这条任务是开发需求时为开发需求 ID：报价、交付、验收都去开发需求页，不走任务卡的通用按钮 */
  devRequestId?: string | null;
}

export interface TaskTimelineEntry {
  id: string;
  actorName: string;
  content: string;
  createdAt: string;
}

export interface TaskBlockedInfo {
  reason: string;
  waitingFor: string;
  nextAction: string;
  since: string;
}

export interface RelatedTutorial {
  title: string;
  durationMinutes: number | null;
}

export interface TaskEvidenceItem {
  name: string;
  submitted: boolean;
}

export interface TutorialTaskStageOutput {
  title: string;
  steps: {
    title: string;
    hasVideo: boolean;
  }[];
}

export interface TutorialTaskOutput {
  /** 教程课程 ID：Learning 的课程 name（10-19 起；以前是 NocoBase 项目数字 ID） */
  projectId: string;
  projectName: string;
  stageCount: number;
  stepCount: number;
  videoCount: number;
  stages: TutorialTaskStageOutput[];
}

export interface TaskDetail {
  task: TaskSummary;
  objective: string | null;
  ownerName: string;
  subTasks: TaskSummary[];
  timeline: TaskTimelineEntry[];
  blockedInfo: TaskBlockedInfo | null;
  relatedTutorial: RelatedTutorial | null;
  evidenceChecklist: TaskEvidenceItem[];
  evidenceFileUrls: string[];
  tutorialOutput: TutorialTaskOutput | null;
  blockDefer: BlockDeferInfo | null;
  /** 只能看不能操作：父任务是自己的、这条子任务指派给别人（员工只能操作指派给自己的任务）；boss/admin 恒为 false */
  readOnly: boolean;
  /** 这条任务是开发需求时为开发需求 ID（详情页不出通用按钮，引导去开发需求页） */
  devRequestId?: string | null;
}

export interface TaskStatusCounts {
  todo: number;
  inProgress: number;
  waiting: number;
  blocked: number;
  readyForReview: number;
  rejected: number;
  done: number;
  cancelled: number;
}

export interface TaskGamification {
  streakDays: number;
  todayTotal: number;
  todayDone: number;
  walletMonth: number;
  walletTotal: number;
  walletPending: number;
}

export interface TaskTemplateSchedule {
  kind: 'every_day' | 'workdays' | 'weekly';
  weekdays?: number[];
}

export interface TaskTemplateSummary {
  id: string;
  title: string;
  templateType: 'daily' | 'scheduled';
  schedule: TaskTemplateSchedule;
  scheduleLabel: string;
  planeProjectId: string;
  planeProjectName: string;
  assigneeMemberId: string | null;
  enabled: boolean;
  runsToday: boolean;
  todayTaskId: string | null;
}

export interface TasksOverview {
  bound: boolean;
  counts: TaskStatusCounts;
  gamification: TaskGamification;
  topTask: TaskSummary | null;
  todayTasks: TaskSummary[];
  openTasks: TaskSummary[];
  doneTasks: TaskSummary[];
  tutorialTasks: TutorialTask[];
  templates: TaskTemplateSummary[];
  progress: TodayProgress | null;
  deferMinutes: number;
}

export interface TaskHistoryQuery {
  date?: string;
  scope?: 'day' | 'week' | 'month';
  keyword?: string;
}

export interface TaskHistoryResponse {
  bound: boolean;
  items: TaskSummary[];
  total: number;
}

export interface TaskActionResult {
  ok: boolean;
  stateChanged: boolean;
  message: string;
}

export type BlockDeferStatus =
  | 'pending'
  | 'ai_passed'
  | 'ai_rejected'
  | 'approved'
  | 'rejected'
  | 'cancelled';

export interface BlockDeferInfo {
  status: BlockDeferStatus;
  deferMinutes: number;
  originalDeadline: string | null;
  requestedDeadline: string;
  reason: string;
  resolution: string;
  aiOpinion: string | null;
  bossComment: string | null;
  requestedAt: string;
}

export interface TodayProgress {
  todayTotal: number;
  todayDone: number;
  rhythmTarget: number;
  behindCount: number;
  expectedEndTime: string;
  overtimeMinutes: number;
  warn: boolean;
}

export interface BlockDeferConfigResponse {
  deferMinutes: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  identifier: string;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  progress: number;
  myTotal: number;
  myDone: number;
  myActive: number;
  myBlocked: number;
  totalTasks: number;
  openTasks: number;
  blockedTasks: number;
  moduleCount: number;
  cycleCount: number;
  memberCount: number;
  createdOn: string | null;
  myOpenTasks?: TaskSummary[];
}

export interface MyProjectsResponse {
  bound: boolean;
  projects: ProjectSummary[];
}

export interface ProjectModuleInfo {
  id: string;
  name: string;
  description: string | null;
  startDate: string | null;
  endDate: string | null;
  total: number;
  done: number;
  inProgress: number;
  blocked: number;
  review: number;
  progress: number;
  members: string[];
}

export interface ProjectCycleInfo {
  id: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  isActive: boolean;
  progress: number;
  total: number;
  done: number;
}

export interface ProjectTaskRow {
  id: string;
  title: string;
  sequenceId: number | null;
  status: TaskStatus;
  statusLabel: string;
  priorityLabel: string;
  moduleName: string | null;
  assigneeName: string | null;
  deadline: string | null;
  deadlineTime: string | null;
  isMine: boolean;
  taskType: TaskType;
  rewardAmount: number | null;
  severeBlocked: boolean;
}

export interface ProjectDetail {
  project: ProjectSummary;
  myProgress: number;
  currentStage: string | null;
  modules: ProjectModuleInfo[];
  cycles: ProjectCycleInfo[];
  myTasks: TaskSummary[];
  risks: TaskSummary[];
  taskRows: ProjectTaskRow[];
  /** taskRows / risks 的范围：员工只给自己的任务（mine），boss/admin 给全项目（all）；汇总数都按全项目算 */
  taskScope: 'all' | 'mine';
  memberNames: string[];
}

export interface WorkEntry {
  key: string;
  title: string;
  description: string;
  count: number | null;
  externalUrl: string | null;
}

export interface WorkOverview {
  role: EmployeeRole;
  roleLabel: string;
  workbenchName: string;
  hint: string | null;
  entries: WorkEntry[];
}

export interface PerformanceKraRow {
  name: string;
  weight: number;
  rating: number;
  earned: number;
}

export interface PerformanceCycle {
  id: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  score: number | null;
  ratingLabel: string | null;
  active: boolean;
  kras: PerformanceKraRow[];
}

export type PerformanceEventType =
  | 'bonus'
  | 'deduction'
  | 'attendance'
  | 'leave'
  | 'course'
  | 'exam'
  | 'problem';

export interface PerformanceEvent {
  id: string;
  date: string;
  type: PerformanceEventType;
  title: string;
  detail: string | null;
  amount: number | null;
  source: string;
}

export interface ProblemDiscoverySummary {
  discovered: number;
  adopted: number;
  repaired: number;
  bountyTotal: number;
}

export interface PerformanceOverview {
  currentCycleId: string | null;
  expectedBonus: number | null;
  cycles: PerformanceCycle[];
  events: PerformanceEvent[];
  problemDiscovery: ProblemDiscoverySummary | null;
}

export interface EmployeeBinding {
  planeMemberId: string;
  planeMemberName: string | null;
  role: EmployeeRole;
  frappeEmployeeId: string | null;
}

export interface HrEmployee {
  id: string;
  name: string;
  designation: string | null;
  department: string | null;
  status: string | null;
}

export interface LearningCourse {
  id: string;
  title: string;
}

export interface MyHrCounts {
  salarySlips: number | null;
  leaveApplications: number | null;
  attendances: number | null;
  appraisals: number | null;
}

export interface MyOverview {
  userId: string;
  userName: string | null;
  frappeSiteUrl: string;
  binding: EmployeeBinding | null;
  /** 当前登录人能否改员工绑定（boss/admin 才能；员工只读，找管理员改） */
  canEditBinding?: boolean;
  employee: HrEmployee | null;
  hrCounts: MyHrCounts;
  learning: {
    courseCount: number;
    courses: LearningCourse[];
  };
}

export interface BindingOption {
  planeMemberId: string;
  planeMemberName: string;
}

export interface BindingOptionsResponse {
  members: BindingOption[];
  employees: HrEmployee[];
}

export interface UpdateBindingRequest {
  planeMemberId: string;
  role: EmployeeRole;
  frappeEmployeeId?: string | null;
}

export interface ErpBindingInfo {
  erpUserId: string;
  erpUsername: string | null;
  boundAt: string;
}

export interface ErpBindingResponse {
  binding: ErpBindingInfo | null;
  /**
   * 当前登录人用 ERP 账号登的统一登录、工作台用户 ID 就是 ERP 员工 ID（演示视角不算）：
   * 没绑定时自动绑到自己的 ERP 账号，不用手填（10-19）
   */
  erpIdentity: boolean;
  /** 进 ERP 免输密码：ERP 身份，且绑定的就是自己的 ERP 账号（手动改绑成别的账号就要输一次密码） */
  passwordFree: boolean;
}

export interface ErpBindingDeletedResponse {
  deleted: boolean;
}

export interface UpdateErpBindingRequest {
  erpUserId: string;
  erpUsername?: string;
}

export interface ErpEntryResponse {
  url: string;
  expiresInSeconds: number;
}

export interface ErpVerifyRequest {
  token: string;
}

export interface ErpVerifyResponse {
  miaodaUserId: string;
  erpUserId: string;
  erpUsername: string | null;
  /**
   * 工作台担保（10-19）：这个入口是本人登录时开的（不是老板的演示视角）、他的工作台 ID 来自 ERP 身份（统一登录的 erp_sub）、
   * 绑定的 erpUserId 就是这个 ID。ERP 只认 JSON 的 true，true 且 miaodaUserId 就是 ERP 员工 ID 时免输密码直接登录
   */
  erpVerified: boolean;
}

// ===== ERP 业务接口（/api/erp-api/*，服务端代持员工 JWT 转发，字段照 server/app/schemas/common.py）=====

/** ERP GET /api/auth/me 的返回（server/app/routers/auth.py） */
export interface ErpMe {
  staff: {
    id: string;
    staff_no: string;
    username: string;
    name: string;
    role: string;
    shop: string | null;
    status: string;
  };
  tabs: { key: string; text: string; pagePath: string }[];
  landing_page: string;
}

export interface ErpDashboardSummary {
  pending_inspect: number;
  in_stock: number;
  today_purchase: number;
  today_outbound: number;
}

export interface ErpWorkloadStats {
  today_purchase: number;
  today_inspection: number;
  today_sales: number;
}

export interface ErpCommissionStats {
  period: string;
  purchase_commission: number;
  warehouse_commission: number;
  sales_commission: number;
  total_commission: number;
  platform_fee_rate: number;
  net_received_hint: number | null;
  detail: Record<string, unknown>;
}

export interface ErpPayslipItem {
  kind: string;
  ref_no: string;
  product_name: string | null;
  sku_code: string | null;
  occurred_at: string | null;
  base_amount: number;
  commission: number;
  is_overdue: boolean;
}

export interface ErpPayslipSection {
  role: string;
  title: string;
  commission_total: number;
  note: string | null;
  overdue_count: number;
  items: ErpPayslipItem[];
}

export interface ErpPayslip {
  date_from: string;
  date_to: string;
  total_commission: number;
  sections: ErpPayslipSection[];
}

export interface ErpAdminPeriodStats {
  period: string;
  purchase_count: number;
  purchase_amount: number;
  inspection_count: number;
  inbound_count: number;
  outbound_count: number;
  sales_amount: number;
  gross_profit: number;
}

export interface ErpRecentActivity {
  event_type: string;
  ref_no: string | null;
  summary: string;
  created_at: string;
}

export interface TaskStatusUpdateRequest {
  projectId: string;
  status: TaskStatus;
}

export interface TaskBlockRequest {
  projectId: string;
  reason: string;
  waitingFor: string;
  nextAction: string;
  resolution: string;
  category?: string;
  deferRequested?: boolean;
  deriveProblem?: boolean;
}

export interface TaskEvidenceRequest {
  projectId: string;
  notes: string;
  links?: string[];
  materials?: string[];
}

export interface TaskAssistRequest {
  projectId: string;
  message: string;
}

export interface SalaryEarning {
  key: string;
  label: string;
  amount: number;
}

export interface MySalary {
  month: string;
  total: number;
  earnings: SalaryEarning[];
}

export interface MyContract {
  status: string;
  statusLabel: string;
  startDate: string | null;
  endDate: string | null;
  contractType: string;
}

export interface MyAttendance {
  month: string;
  presentDays: number;
  lateCount: number;
  earlyLeaveCount: number;
  leaveDays: number;
  anomalyCount: number;
}

export type LearningCourseCategory = 'required' | 'tutorial' | 'advanced' | null;

export interface LearningCourseProgress {
  id: string;
  title: string;
  category: LearningCourseCategory;
  progress: number;
  completedAt: string | null;
  currentStageTitle?: string | null;
  stagesTotal?: number;
  stepsTotal?: number;
  stepsDone?: number;
  startedAt?: string | null;
  hasRejectedStep?: boolean;
}

export interface TutorialTask extends LearningCourseProgress {
  caseId: number;
  rewardScore: number;
  rewardAmount: number | null;
  severeBlocked: boolean;
  blockedReason: 'step_rejected' | 'overdue' | null;
  overdueDays: number | null;
}

export interface LearningExamRecord {
  id: string;
  title: string;
  score: number | null;
  passed: boolean;
  examDate: string | null;
}

/** 学习中心「培训视频」：媒体资料服务里这个人能看的视频，按课程分组（GET /api/my/learning/videos） */
export interface MyLearningVideos {
  /** 没配媒体服务地址或令牌时为 false，页面不显示这一区 */
  configured: boolean;
  series: { name: string; items: { id: string; title: string; url: string }[] }[];
  error: string | null;
}

export interface MyLearning {
  requiredTotal: number;
  requiredDone: number;
  courses: LearningCourseProgress[];
  exams: LearningExamRecord[];
  averageScore: number | null;
  tutorialSiteUrl?: string | null;
}

export interface TutorialCaseMaterial {
  key: string;
  label: string;
  inputType: string;
  required: boolean;
  options: string[];
  helpText: string | null;
}

export interface TutorialSubmissionView {
  status: string;
  data: Record<string, unknown>;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
}

export interface TutorialCaseStepDetail {
  /** 步骤编号：Learning 课时上的 pa_step_key（短串，能直接放进网址和页面元素 id） */
  id: string;
  title: string;
  guide: string | null;
  warnText: string | null;
  deliverNote: string | null;
  videoUrl: string | null;
  requireConfirm: boolean;
  requireReview: boolean;
  approved: boolean;
  submissionStatus: string | null;
  state:
    | 'approved'
    | 'submitted'
    | 'rejected'
    | 'skipped'
    | 'active'
    | 'locked';
  materials: TutorialCaseMaterial[];
  submission: TutorialSubmissionView | null;
  /** 当前用户对该步骤最新一次跳过申请状态（pending 审核中 / rejected 已拒绝可重申 / 无则 null） */
  skipRequestStatus?: TutorialSkipStatus | null;
  /** 最近一次跳过申请被拒绝的原因（无则 null） */
  skipReviewerNote?: string | null;
}

export interface TutorialCaseStageDetail {
  /** 阶段 = Learning 章节，id 是章节 name */
  id: string;
  title: string;
  steps: TutorialCaseStepDetail[];
}

export interface TutorialCaseDetail {
  caseId: number;
  title: string;
  projectName: string | null;
  clientName: string | null;
  status: string;
  progress: number;
  /** 当前阶段（第一个还有没做完步骤的章节）；全做完时是最后一个章节 */
  currentStageId: string | null;
  completedAt: string | null;
  rewardScore: number;
  rewardAmount: number | null;
  overdueDays: number | null;
  hasRejectedStep: boolean;
  stages: TutorialCaseStageDetail[];
  tutorialSiteUrl: string | null;
}

/** 教程步骤跳过申请状态：pending 待 boss 审核 / approved 已通过（步骤已跳过）/ rejected 已拒绝 */
export type TutorialSkipStatus = 'pending' | 'approved' | 'rejected';

export interface TutorialSkipRequestInfo {
  id: string;
  caseId: number;
  caseTitle: string;
  stepId: string;
  stepTitle: string;
  reason: string;
  status: TutorialSkipStatus;
  reviewerNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface MyTutorialSkipListResponse {
  items: TutorialSkipRequestInfo[];
}

export interface SubmitTutorialSkipRequest {
  reason: string;
}

export interface TutorialSkipReviewItem {
  id: string;
  caseId: number;
  caseTitle: string;
  stepId: string;
  stepTitle: string;
  userId: string;
  employeeName: string;
  reason: string;
  status: TutorialSkipStatus;
  reviewerNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface TutorialSkipReviewListResponse {
  items: TutorialSkipReviewItem[];
}

export interface TutorialSkipVerdictRequest {
  action: 'approve' | 'reject';
  comment?: string;
}

export interface SubmitTutorialStepRequest {
  data: Record<string, unknown>;
  confirmed?: boolean;
}

export type TutorialMaterialInputType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'date'
  | 'image'
  | 'video'
  | 'file';

export interface TutorialAuthoringMaterialInput {
  label: string;
  inputType: TutorialMaterialInputType;
  required: boolean;
  helpText?: string;
}

export interface TutorialAuthoringStepInput {
  title: string;
  guide?: string;
  warnText?: string;
  deliverNote?: string;
  videoUrl?: string;
  requireConfirm: boolean;
  requireReview: boolean;
  materials: TutorialAuthoringMaterialInput[];
}

export interface TutorialAuthoringStageInput {
  title: string;
  description?: string;
  durationNote?: string;
  steps: TutorialAuthoringStepInput[];
}

export interface TutorialAuthoringCreateRequest {
  name: string;
  description?: string;
  stages: TutorialAuthoringStageInput[];
}

export interface TutorialAuthoringMaterialView {
  label: string;
  inputType: TutorialMaterialInputType;
  required: boolean;
  helpText: string | null;
}

export interface TutorialAuthoringStepView {
  title: string;
  guide: string | null;
  warnText: string | null;
  deliverNote: string | null;
  videoUrl: string | null;
  requireConfirm: boolean;
  requireReview: boolean;
  materials: TutorialAuthoringMaterialView[];
}

export interface TutorialAuthoringStageView {
  title: string;
  description: string | null;
  durationNote: string | null;
  steps: TutorialAuthoringStepView[];
}

export interface TutorialAuthoringProjectView {
  /** Learning 课程 name */
  projectId: string;
  name: string;
  description: string | null;
  /** 课程在 Learning 前台的地址（老板 / 管理员有 Moderator 才打得开；教程课默认不发布） */
  learningUrl: string | null;
  published: boolean;
  stageCount: number;
  stepCount: number;
  stages: TutorialAuthoringStageView[];
}

export interface TutorialAuthoringListResponse {
  items: TutorialAuthoringProjectView[];
}

export interface TutorialAuthoringCreateResponse {
  /** Learning 课程 name */
  projectId: string;
  name: string;
  stageCount: number;
  stepCount: number;
  materialCount: number;
}

export interface SubmitTutorialStepResponse {
  submission: TutorialSubmissionView;
  caseProgress: number;
  caseStatus: string;
}

// ===== 管理端 · 给员工分配教程（开案例） =====

/** 案例状态：学习中 / 已学完 / 已取消（分配错了由老板取消） */
export type TutorialCaseStatus = 'in_progress' | 'completed' | 'cancelled';

/** POST /api/admin/tutorial-cases：同一个人、同一套教程、同一个对象只能有一个进行中的案例 */
export interface TutorialCaseAssignRequest {
  /** 教程课程 ID（Learning 课程 name，即 TutorialAuthoringProjectView.projectId） */
  lmsCourse: string;
  /** 员工的工作台用户 ID（= ERP 员工 ID） */
  ownerUserId: string;
  /** 对象名（比如在帮哪位客户开店），可不填 */
  clientName?: string;
}

export interface TutorialCaseAdminItem {
  caseId: number;
  lmsCourse: string;
  courseTitle: string;
  ownerUserId: string;
  ownerName: string;
  clientName: string | null;
  status: TutorialCaseStatus;
  progress: number;
  stepsDone: number;
  stepsTotal: number;
  assignedBy: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface TutorialCaseAdminListResponse {
  items: TutorialCaseAdminItem[];
}

export interface SalarySlipComponent {
  label: string;
  amount: number;
}

export interface SalarySlipSummary {
  name: string;
  postingDate: string | null;
  startDate: string | null;
  endDate: string | null;
  grossPay: number | null;
  netPay: number | null;
  status: string | null;
}

export interface SalarySlipDetail extends SalarySlipSummary {
  earnings: SalarySlipComponent[];
  deductions: SalarySlipComponent[];
  totalDeduction: number | null;
}

export interface MySalarySlipsResponse {
  items: SalarySlipSummary[];
}

export interface LeaveApplicationRecord {
  name: string;
  leaveType: string | null;
  fromDate: string | null;
  toDate: string | null;
  totalDays: number | null;
  status: string | null;
  reason: string | null;
}

export interface MyLeaveApplicationsResponse {
  items: LeaveApplicationRecord[];
}

// ==================== 工单引擎（2026-10-02 管理端 v1） ====================

export type WorkOrderStatus =
  | 'draft'
  | 'pending'
  | 'executing'
  | 'pending_submit'
  | 'ai_reviewing'
  | 'needs_revision'
  | 'rejected'
  | 'pending_boss'
  | 'approved'
  | 'refused';

export type WorkOrderType = 'purchase' | 'sales' | 'special_delegation' | 'other';

export type WorkOrderComplexity = 'simple' | 'medium' | 'complex';

export type WorkOrderSource =
  | 'manual'
  | 'webhook'
  | 'ai'
  | 'auto_event'
  | 'mcp';

export type WorkOrderAiVerdictKind = 'pass' | 'reject' | 'revise' | 'need_human';

export interface WorkOrderChecklistItem {
  key: string;
  name: string;
  required?: boolean;
  type?: string;
  /** 要人到现场做（验货、拍实物、跑腿这类 Agent 替不了的），员工端单独标出 */
  onSite?: boolean;
}

/** 三条业务线（销售工作台 A01，11-10）：二手实物 / 虚拟商品 / 技术服务 */
export type WorkOrderBusinessLine = 'used_goods' | 'virtual_goods' | 'tech_service';

/** 工单关联对象的种类：商品 / 同行 / 客户 / 学习对象 / ERP 单据 / 其他 */
export type WorkOrderSubjectKind =
  | 'product'
  | 'peer'
  | 'customer'
  | 'study'
  | 'erp_doc'
  | 'other';

export interface WorkOrderSubject {
  kind: WorkOrderSubjectKind;
  /** 给人看的名字，如「iPhone 15 Pro 256G」「张三的店」 */
  name: string;
  /** 编号或链接，选填 */
  ref?: string;
}

/** 转交记录：转交时必须写清已做了什么、下一步、材料，接手人能看到 */
export interface WorkOrderHandoverView {
  id: string;
  fromUserId: string | null;
  fromName: string | null;
  toUserId: string;
  toName: string | null;
  done: string;
  next: string;
  materials: string;
  materialUrls: string[];
  createdAt: string;
}

export interface WorkOrderHandoverRequest {
  toUserId: string;
  /** 已做了什么 */
  done: string;
  /** 下一步 */
  next: string;
  /** 材料在哪、是什么（文字）；和 materialUrls 至少有一样 */
  materials?: string;
  materialUrls?: string[];
}

export interface WorkOrderHandoverCandidate {
  userId: string;
  name: string;
}

export interface WorkOrderHandoverCandidatesResponse {
  items: WorkOrderHandoverCandidate[];
}

// ───────── 提交版本与三类验收记录（销售工作台 A02，11-10）─────────

/** 带版本的提交挂在哪：工单 / Plane 任务 */
export type AcceptanceSubjectType = 'work_order' | 'task';

/** 一次提交 = 一版，重提不覆盖 */
export interface SubmissionVersionView {
  id: string;
  version: number;
  /** 这一版交了什么（工单：每项凭证的文件与备注；任务：说明、材料、链接） */
  items: { name: string; fileUrls: string[]; note: string | null }[];
  summary: string | null;
  submittedBy: string | null;
  createdAt: string;
}

/**
 * 验收记录分四类，各记各的：
 * review 验收（通过 / 退回 / 拒绝）、research_pass 研究通过、business_approval 经营批准（只有管理员给，可暂停 / 恢复 / 退出）、
 * listing_confirm 上架确认。研究通过不等于经营批准，经营批准也不等于已上架。
 */
export type AcceptanceRecordKind =
  | 'review'
  | 'research_pass'
  | 'business_approval'
  | 'listing_confirm';

export type AcceptanceDecision = 'approved' | 'returned' | 'refused';

/** 经营批准的状态：生效 / 暂停 / 已退出（退出后不能再恢复） */
export type BusinessApprovalState = 'active' | 'paused' | 'exited';

export interface AcceptanceRecordView {
  id: string;
  subjectType: AcceptanceSubjectType;
  subjectId: string;
  kind: AcceptanceRecordKind;
  decision: AcceptanceDecision;
  /** 指向哪一版提交；没有提交过的为 null */
  version: number | null;
  reason: string | null;
  /** 经营批准的范围 */
  scope: string | null;
  state: BusinessApprovalState | null;
  history: { action: string; at: string; by: string | null; reason: string | null }[];
  operatorId: string | null;
  operatorName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AcceptanceOverviewResponse {
  versions: SubmissionVersionView[];
  records: AcceptanceRecordView[];
}

export interface AcceptanceRecordCreateRequest {
  subjectType: AcceptanceSubjectType;
  subjectId: string;
  kind: 'research_pass' | 'business_approval' | 'listing_confirm';
  /** 指向的版本；不传 = 最新一版 */
  version?: number;
  /** 经营批准必填：批准做到什么范围 */
  scope?: string;
  note?: string;
}

export interface AcceptanceRecordStateRequest {
  action: 'pause' | 'resume' | 'exit';
  /** 暂停、退出必填 */
  reason?: string;
}

export interface AcceptanceRecordResponse {
  record: AcceptanceRecordView;
}

export interface WorkOrderAiVerdict {
  verdict?: WorkOrderAiVerdictKind;
  checkedItems?: { name: string; pass: boolean }[];
  summary?: string;
  at?: string;
  engine?: 'rule' | 'aily';
}

export interface WorkOrderHumanVerdict {
  result?: 'approved' | 'refused' | 'returned';
  comment?: string;
  at?: string;
  /** 审的是第几版提交（11-10 起有） */
  version?: number;
}

export interface WorkOrderContactBossFields {
  contact?: string;
  urgency?: string;
  reportPoints?: string[];
}

export interface WorkOrderSpecialTutorial {
  title?: string;
  steps?: string[];
  generated?: boolean;
}

export interface WorkOrderEvidenceItem {
  id: string;
  workOrderId: string;
  itemKey: string;
  itemName: string | null;
  fileUrls: string[];
  note: string | null;
  submittedBy: string | null;
  aiCheckStatus: string;
  createdAt: string;
}

export interface WorkOrderEventView {
  id: string;
  fromStatus: WorkOrderStatus | null;
  toStatus: WorkOrderStatus;
  operatorType: 'user' | 'ai' | 'boss' | 'webhook' | 'system';
  operatorId: string | null;
  comment: string | null;
  createdAt: string;
}

export interface WorkOrderSummary {
  id: string;
  code: string;
  title: string;
  catalogCode: string;
  catalogName?: string;
  orderType: WorkOrderType;
  complexity: WorkOrderComplexity;
  status: WorkOrderStatus;
  assigneeId: string | null;
  assigneeName?: string | null;
  taskId: string | null;
  autoGenerated: boolean;
  source: WorkOrderSource;
  erpDocName: string | null;
  /** 业务线；老工单没有 */
  businessLine: WorkOrderBusinessLine | null;
  subjects: WorkOrderSubject[];
  /** 截止（日期 + 时刻）；没给时效为 null */
  dueAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkOrderDetail extends WorkOrderSummary {
  prompt: string | null;
  contactBossFields: WorkOrderContactBossFields | null;
  checklist: WorkOrderChecklistItem[];
  tutorialId: string | null;
  specialTutorial: WorkOrderSpecialTutorial | null;
  aiVerdict: WorkOrderAiVerdict | null;
  humanVerdict: WorkOrderHumanVerdict | null;
  evidence: WorkOrderEvidenceItem[];
  events: WorkOrderEventView[];
  remark: string | null;
  handovers: WorkOrderHandoverView[];
  /** 每次提交一版，新的在前 */
  versions: SubmissionVersionView[];
  acceptanceRecords: AcceptanceRecordView[];
}

export interface WorkOrdersResponse {
  items: WorkOrderSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CreateWorkOrderRequest {
  title: string;
  catalogCode: string;
  assigneeId?: string;
  taskId?: string;
  contactBossFields?: WorkOrderContactBossFields;
  remark?: string;
  /** 不传用种类上设的业务线 */
  businessLine?: WorkOrderBusinessLine;
  subjects?: WorkOrderSubject[];
}

export interface SubmitEvidenceRequest {
  items: { itemKey: string; fileUrls: string[]; note?: string }[];
}

export type WorkOrderTransitionKind =
  | 'start'
  | 'revoke_submit'
  | 'resubmit'
  | 'confirm_review'
  | 'return_revision';

export interface WorkOrderTransitionRequest {
  action: WorkOrderTransitionKind;
  comment?: string;
}

export interface CreateWorkOrderResponse {
  workOrder: WorkOrderDetail;
}

export interface WorkOrderDetailResponse {
  workOrder: WorkOrderDetail;
}

export interface WorkOrderCatalogResponse {
  items: WorkOrderCatalogItem[];
}

export interface WorkOrderActionResult {
  ok: boolean;
  status: WorkOrderStatus;
  message?: string;
}

// ==================== 管理端工单发单 / 草稿箱 / 队列（2026-10-02） ====================

/** 发单优先级，与 Plane issue priority 同值：urgent 紧急 / high 高 / medium 普通 / low 低 */
export type WorkOrderPriority = 'urgent' | 'high' | 'medium' | 'low';

export interface AdminWorkOrderCreateRequest {
  title: string;
  catalogCode: string;
  assigneeId?: string;
  remark?: string;
  saveAsDraft: boolean;
  source?: WorkOrderSource;
  /** 不传按普通；写进 Plane 任务卡的 priority */
  priority?: WorkOrderPriority;
  /** 截止时刻 HH:mm，按约定拼进标题「HH:mm前」 */
  deadlineTime?: string;
  /** 截止日期 YYYY-MM-DD，跨天的活用（Plane target_date 跟着它走）；不传 = 当天 */
  deadlineDate?: string;
  /** 不传用种类上设的业务线 */
  businessLine?: WorkOrderBusinessLine;
  subjects?: WorkOrderSubject[];
}

export interface AdminWorkOrderDraftRow {
  id: string;
  code: string;
  title: string;
  catalogCode: string;
  catalogName: string | null;
  orderType: WorkOrderType;
  complexity: WorkOrderComplexity;
  assigneeId: string | null;
  assigneeName: string | null;
  /** 指派员工名下在途工单数（待执行/执行中/待提交/AI初审中/需修改） */
  activeWorkOrders: number;
  remark: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminWorkOrderDraftsResponse {
  items: AdminWorkOrderDraftRow[];
}

export interface AdminWorkOrderQueueRow extends WorkOrderSummary {
  assigneeName: string | null;
  /** SLA 到期时间（system_configs 配置的 SLA 小时数算出，未配置为 null） */
  slaDeadline: string | null;
  slaOverdue: boolean;
}

export interface AdminWorkOrderQueueResponse {
  items: AdminWorkOrderQueueRow[];
}

export interface AdminWorkOrderPublishResponse {
  workOrder: WorkOrderSummary;
}

export interface AdminWorkOrderDeleteResponse {
  ok: boolean;
}

export interface WorkOrderCatalogItem {
  id: string;
  code: string;
  name: string;
  orderType: WorkOrderType;
  complexity: WorkOrderComplexity;
  checklistTemplate: WorkOrderChecklistItem[];
  /** 这类工单默认的业务线 */
  businessLine: WorkOrderBusinessLine | null;
  promptTemplate: string | null;
  autoTriggerRules: { event?: string; conditions?: Record<string, string> } | null;
  erpAction: string | null;
  notifyTargets: { roles?: string[]; userIds?: string[] } | null;
  enabled: boolean;
  sort: number;
}

export interface DefectUploadRequest {
  taskId?: string;
  productName: string;
  defectType: string;
  fileUrls: string[];
  remark?: string;
}

export interface DefectUploadResponse {
  workOrder: WorkOrderDetail;
}

export interface AutoCreateWorkOrderRequest {
  catalogCode: string;
  businessKey: string;
  title?: string;
  assigneeId?: string;
  materialUrls?: string[];
  remark?: string;
  idempotencyKey: string;
}

// ==================== 管理端五 Dock ====================

export interface AdminKpiRow {
  label: string;
  value: string | number;
  hint?: string;
}

export interface AdminAttentionItem {
  id: string;
  kind:
    | 'blocker'
    | 'overdue_workorder'
    | 'overdue_task'
    | 'pending_review'
    | 'problem_candidate'
    | 'problem_overdue';
  title: string;
  detail?: string;
  href?: string;
  severity: 'normal' | 'high' | 'critical';
  occurredAt: string;
}

export interface AdminProjectProgress {
  projectId: string;
  name: string;
  progress: number;
  openTasks: number;
  totalTasks: number;
  risky: boolean;
}

export interface AdminOverviewResponse {
  kpis: AdminKpiRow[];
  attentions: AdminAttentionItem[];
  projects: AdminProjectProgress[];
  problemSummary: { candidateCount: number; confirmedCount: number; observingCount: number };
}

export interface AdminTaskDraft {
  title: string;
  projectId?: string;
  assigneeMemberId?: string;
  description?: string;
  dueDate?: string;
  confidence: number;
}

export interface QuickTaskDraftRequest {
  input: string;
}

export interface QuickTaskDraftResponse {
  draft: AdminTaskDraft | null;
  fallback: boolean;
  message?: string;
}

export interface QuickTaskCreateRequest {
  title: string;
  projectId: string;
  assigneeMemberId?: string;
  description?: string;
  dueDate?: string;
}

export interface QuickTaskCreateResponse {
  taskId: string;
  taskUrl?: string;
}

export interface TaskTemplateUpsertRequest {
  title: string;
  templateType: 'daily' | 'scheduled';
  schedule: TaskTemplateSchedule;
  planeProjectId: string;
  planeProjectName: string;
  assigneeMemberId?: string | null;
  description?: string | null;
  enabled?: boolean;
}

export interface TaskTemplateGenerateResponse {
  created: number;
  skipped: number;
  details: string[];
}

export interface AdminExecuteTaskRow {
  id: string;
  sequenceId: string;
  title: string;
  projectName: string;
  assigneeName: string | null;
  status: string;
  stateGroup: string;
  priority: string;
  targetDate: string | null;
  isOverdue: boolean;
  labels: string[];
}

export interface AdminExecuteProject {
  id: string;
  name: string;
  leadName: string | null;
  progress: number;
  openTasks: number;
  totalTasks: number;
  isRoutine: boolean;
}

export interface AdminExecuteResponse {
  projects: AdminExecuteProject[];
  tasks: AdminExecuteTaskRow[];
}

export interface AdminMemberSlot {
  userId: string;
  name: string;
  planeMemberId: string;
  role: EmployeeRole;
  todayTotal: number;
  todayDone: number;
  openCount: number;
  blockedCount: number;
  deferPending: number;
  rhythmTarget: number;
  behindCount: number;
  expectedEndTime: string | null;
}

export interface AdminExecuteMembersResponse {
  members: AdminMemberSlot[];
}

export interface BlockDeferReviewItem {
  id: string;
  taskId: string;
  title: string;
  sequenceId: number | null;
  projectName: string;
  assigneeName: string;
  userId: string;
  reason: string;
  resolution: string;
  category: string;
  deferMinutes: number;
  originalDeadline: string | null;
  requestedDeadline: string;
  status: BlockDeferStatus;
  aiOpinion: string | null;
  sopId: string | null;
  sopTitle: string | null;
  requestedAt: string;
}

export interface BlockDeferReviewResponse {
  items: BlockDeferReviewItem[];
}

export interface BlockDeferVerdictRequest {
  action: 'approve' | 'reject';
  comment?: string;
}

export interface SopRecord {
  id: string;
  title: string;
  category: string;
  status: string;
  wikiUrl: string | null;
  syncError: string | null;
  sourceTaskId: string | null;
  sourceTitle: string | null;
  authorName: string | null;
  content: string;
  createdAt: string;
}

export interface AdminMemberDetailResponse {
  member: AdminMemberSlot;
  progress: TodayProgress | null;
  todayTasks: TaskSummary[];
  blockers: TaskSummary[];
  deferRequests: BlockDeferReviewItem[];
  history: TaskSummary[];
  historyTotal: number;
  sops: SopRecord[];
}

/** 按日期看里截止任务的口径：done 按时完成 / done_late 逾期完成 / overdue 逾期未完成 / open 还没到截止 */
export type AdminDayDueState = 'done' | 'done_late' | 'overdue' | 'open';

export interface AdminDayTaskItem {
  taskId: string;
  projectId: string;
  sequenceId: number | null;
  title: string;
  projectName: string;
  status: TaskStatus;
  statusLabel: string;
  deadline: string | null;
  deadlineTime: string | null;
  /** 完成日期（上海，YYYY-MM-DD）与时刻（HH:mm），没完成为 null */
  completedAt: string | null;
  completedTime: string | null;
  /** 有截止日期才有 */
  dueState: AdminDayDueState | null;
  /** 当天第一次提交堵塞的时刻（上海 HH:mm）与阻塞分类，当天没提交为 null */
  blockedAt: string | null;
  blockCategory: string | null;
  workHours: number | null;
  workHoursText: string | null;
}

export interface AdminDayMemberActivity {
  userId: string;
  name: string;
  role: EmployeeRole;
  /** 当天完成的任务 */
  completed: AdminDayTaskItem[];
  /** 截止日期是当天的任务（含已完成） */
  due: AdminDayTaskItem[];
  /** 当天提交过堵塞的任务 */
  blocked: AdminDayTaskItem[];
}

export interface AdminDayActivityResponse {
  date: string;
  members: AdminDayMemberActivity[];
  generatedAt: string;
}

export interface AdminReviewEvidence {
  itemKey: string;
  itemName: string;
  fileUrls: string[];
  note?: string | null;
}

export interface AdminReviewItem {
  id: string;
  kind: 'work_order' | 'plane_task';
  refCode: string;
  title: string;
  ownerName: string | null;
  submittedAt: string;
  complexity?: WorkOrderComplexity;
  orderType?: WorkOrderType;
  aiVerdict: WorkOrderAiVerdict | null;
  evidence: AdminReviewEvidence[];
}

export interface AdminReviewListResponse {
  items: AdminReviewItem[];
  total: number;
}

export interface AdminReviewActionRequest {
  action: 'approve' | 'reject' | 'return';
  comment?: string;
}

export interface AdminReviewActionResponse {
  ok: boolean;
  status?: WorkOrderStatus | string;
  erpDocName?: string | null;
  message?: string;
}

// ==================== 问题域（阻塞 SOP） ====================

export type BlockerCategory =
  | 'tool'
  | 'system'
  | 'permission'
  | 'process'
  | 'external_supplier'
  | 'logistics'
  | 'customer'
  | 'resource'
  | 'knowledge'
  | 'coordination'
  | 'quality'
  | 'policy'
  | 'finance'
  | 'data'
  | 'other';

export type BlockerSeverity = 'normal' | 'high' | 'critical';

export interface BlockerItem {
  id: string;
  reporterId: string | null;
  reporterName?: string | null;
  title: string;
  description: string | null;
  category: BlockerCategory;
  severity: BlockerSeverity;
  waitingFor: string | null;
  status: string;
  taskId: string | null;
  lossHours: number | null;
  createdAt: string;
  resolvedAt: string | null;
  derivedProblem?: DerivedProblemStatus | null;
}

export interface SubmitBlockerRequest {
  title: string;
  description?: string;
  category?: BlockerCategory;
  severity?: BlockerSeverity;
  taskId?: string;
  lossHours?: number;
}

export interface MyBlockersResponse {
  items: BlockerItem[];
}

export interface SubmitBlockerResponse {
  blocker: BlockerItem;
}

export interface BlockerListResponse {
  items: BlockerItem[];
}

export interface ProblemPoolActionRequest {
  action: 'confirm' | 'dismiss' | 'flag' | 'unflag' | 'ack' | 'reject';
  comment?: string;
  reason?: string;
}

export interface ProblemPoolActionResponse {
  poolItem: ProblemPoolItem;
  improvement?: ImprovementProjectItem | null;
}

export interface ProblemThresholds {
  days: number;
  count: number;
  users: number;
  lossHours: number;
  overdue: number;
}

export interface ProblemPoolItem {
  id: string;
  recurrenceKey: string;
  title: string;
  category: string | null;
  occurrenceCount: number;
  affectedUsers: number;
  totalLossHours: number;
  overdueCount: number;
  lastOccurredAt: string | null;
  status:
    | 'candidate'
    | 'confirmed'
    | 'dismissed'
    | 'projected'
    | 'pending_response';
  thresholdMet: {
    days7Count?: number;
    users?: number;
    lossHours?: number;
    overdueCount?: number;
    manual?: boolean;
  } | null;
  manualFlagged: boolean;
  reporterId?: string | null;
  reporterName?: string | null;
  responseAt?: string | null;
  respondedAt?: string | null;
  rejectReason?: string | null;
  bountyAmount?: number;
  sourceTaskId?: string | null;
  repairedAt?: string | null;
  slaExceeded?: boolean;
}

export interface ProblemLampConfig {
  bountyAmount: number;
  slaHours: number;
}

export interface DerivedProblemStatus {
  poolId: string;
  poolStatus: ProblemPoolItem['status'];
  bountyAmount: number;
  rejectReason: string | null;
  respondedAt: string | null;
  repairedAt: string | null;
  slaExceeded: boolean;
}

export interface ProblemPoolResponse {
  items: ProblemPoolItem[];
  thresholds: ProblemThresholds;
  config?: ProblemLampConfig;
}

export type ImprovementStage =
  | 'define'
  | 'root_cause'
  | 'design'
  | 'implement'
  | 'verify'
  | 'standardize'
  | 'observe'
  | 'closed';

export interface ImprovementProjectItem {
  id: string;
  problemId: string | null;
  planeProjectId: string | null;
  planeProjectName: string | null;
  planeProjectUrl: string | null;
  title: string;
  stage: ImprovementStage;
  ownerName: string | null;
  expectedBenefit: string | null;
  observeStartedAt: string | null;
  observeUntil: string | null;
  closedAt: string | null;
  createdAt: string;
}

export interface ImprovementProjectsResponse {
  items: ImprovementProjectItem[];
}

export interface CreateImprovementRequest {
  problemId: string;
  title?: string;
  expectedBenefit?: string;
}

export interface CreateImprovementResponse {
  project: ImprovementProjectItem;
}

export interface UpdateImprovementStageRequest {
  stage: ImprovementStage;
}

// ==================== 系统配置 ====================

export interface SystemConfigItem {
  configKey: string;
  configValue: Record<string, unknown>;
  description: string | null;
  updatedAt: string;
}

export interface SystemConfigsResponse {
  items: SystemConfigItem[];
}

export interface WorkOrderEvidenceView {
  evidence: WorkOrderEvidenceItem[];
}

export interface AdminConfigResponse {
  items: SystemConfigItem[];
}

export interface UpdateConfigResponse {
  item: SystemConfigItem;
}

export interface UpdateSystemConfigRequest {
  configKey: string;
  configValue: Record<string, unknown>;
}

// ==================== 验收 Dock（boss 终审） ====================

export interface ReviewWorkOrderRow {
  id: string;
  code: string;
  title: string;
  catalogName: string | null;
  orderType: WorkOrderType;
  complexity: WorkOrderComplexity;
  status: WorkOrderStatus;
  assigneeName: string | null;
  prompt: string | null;
  contactBossFields: WorkOrderContactBossFields | null;
  checklist: WorkOrderChecklistItem[];
  evidence: WorkOrderEvidenceItem[];
  aiVerdict: WorkOrderAiVerdict | null;
  humanVerdict: WorkOrderHumanVerdict | null;
  erpDocType: string | null;
  erpDocName: string | null;
  businessLine: WorkOrderBusinessLine | null;
  subjects: WorkOrderSubject[];
  dueAt: string | null;
  /** 每次提交一版，新的在前；终审指向第一条（最新那版） */
  versions: SubmissionVersionView[];
  acceptanceRecords: AcceptanceRecordView[];
  createdAt: string;
  updatedAt: string;
}

export interface ReviewWorkOrdersResponse {
  items: ReviewWorkOrderRow[];
}

export interface ReviewVerdictRequest {
  /** returned = 退回修改（回到员工手里重交），refused = 拒绝（结束）；这两种 comment 必填 */
  result: 'approved' | 'refused' | 'returned';
  comment?: string;
  /** 审的是哪一版；员工这期间又交了新版会被拒，刷新后再审 */
  version?: number;
  /** 终审通过时的绩效入账金额（可选，>0 时写 Frappe Additional Salary） */
  performanceAmount?: number;
}

export interface ReviewVerdictResponse {
  order: WorkOrderDetail;
  /** 绩效入账结果：true=已写 Frappe，false/undefined=未入账（未填金额或入账失败） */
  erpSettled?: boolean;
  erpSettleError?: string | null;
}

export interface ReviewPlaneTaskRow {
  taskId: string;
  sequenceId: number;
  title: string;
  projectName: string | null;
  assigneeName: string | null;
  targetDate: string | null;
  evidenceSummary: string | null;
  /** 描述里「工时=」的报价，口径同 TaskSummary */
  workHours: number | null;
  workHoursText: string | null;
  tutorialOutput: TutorialTaskOutput | null;
  /** 员工交过几版材料（工作台里交的才算）；没交过为 null */
  latestVersion: number | null;
}

export interface ReviewPlaneTasksResponse {
  items: ReviewPlaneTaskRow[];
}

export interface ReviewPlaneTaskActionRequest {
  action: 'approve' | 'reject';
  /** 打回必填 */
  comment?: string;
  /** 审的是哪一版；员工这期间又交了新版会被拒 */
  version?: number;
}

export interface ReviewPlaneTaskActionResponse {
  ok: boolean;
  message?: string;
}

// ==================== 管理 Dock（admin） ====================

export interface AdminCatalogUpsertRequest {
  code: string;
  name: string;
  orderType: WorkOrderType;
  complexity: WorkOrderComplexity;
  checklistTemplate?: WorkOrderChecklistItem[];
  /** null = 不设 */
  businessLine?: WorkOrderBusinessLine | null;
  promptTemplate?: string;
  erpAction?: string;
  notifyTargets?: { roles?: string[]; userIds?: string[] } | null;
  enabled?: boolean;
  sort?: number;
}

export interface AdminCatalogDeleteResponse {
  ok: boolean;
}

export interface AdminEmployeeBindingRow {
  id: string;
  miaodaUserId: string;
  userName: string | null;
  planeMemberId: string;
  planeMemberName: string | null;
  role: string;
  frappeEmployeeId: string | null;
  nocobaseUserId: string | null;
}

/** 用统一账号登录过工作台、还没绑定 Plane 成员的人（管理端「员工」页「待绑定」） */
export interface AdminUnboundAccountRow {
  /** 工作台用户 ID（ERP 员工 ID） */
  miaodaUserId: string;
  userName: string | null;
  /** 统一登录用户名（= ERP 登录账号） */
  loginName: string | null;
  lastLoginAt: string | null;
}

export interface AdminEmployeeBindingsResponse {
  items: AdminEmployeeBindingRow[];
  unbound?: AdminUnboundAccountRow[];
}

export interface DemoAccountItem {
  userId: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  roleLabel: string | null;
}

export interface AccountCenterResponse {
  realUser: { userId: string; name: string | null };
  viewUserId: string;
  isDemoView: boolean;
  viewProfile: DemoAccountItem | null;
  demoAccounts: DemoAccountItem[];
  canAdmin: boolean;
}

export interface UpdateAccountProfileRequest {
  name: string;
  email?: string | null;
  avatarUrl?: string | null;
}

export interface UpdateAccountProfileResponse {
  viewProfile: DemoAccountItem;
}

// ===== 管理端 · 教程审核闭环 =====

export interface TutorialReviewMaterial {
  key: string;
  name: string;
  type: string;
  value: string[];
}

export interface TutorialReviewItem {
  submissionId: number;
  caseId: number;
  caseTitle: string;
  projectName: string;
  stageTitle: string;
  stepId: string;
  stepTitle: string;
  stepSort: number;
  ownerUserId: string;
  submittedAt: string;
  materials: TutorialReviewMaterial[];
}

export interface TutorialReviewListResponse {
  items: TutorialReviewItem[];
}

export interface TutorialReviewVerdictRequest {
  action: 'approved' | 'rejected';
  comment?: string;
}

export interface TutorialReviewVerdictResponse {
  submissionId: number;
  status: string;
}

// ===== 管理端 · HR 绩效看板 =====

export interface AdminPerformanceEmployee {
  userId: string;
  name: string;
  planeMemberName: string | null;
  role: string;
  latestTotalScore: number | null;
  latestGrade: string | null;
  latestCycleName: string | null;
}

export interface AdminPerformanceEmployeeListResponse {
  items: AdminPerformanceEmployee[];
}

export interface AdminPerformanceDetailResponse {
  userId: string;
  name: string;
  overview: PerformanceOverview;
}

// ===== 管理端 · OKR =====

export type OkrObjectiveStatus = 'on_track' | 'at_risk' | 'behind' | 'completed';

export interface OkrKeyResultItem {
  id: string;
  objectiveId: string;
  title: string;
  unit: string | null;
  targetValue: string;
  currentValue: string;
  sort: number;
}

export interface OkrObjectiveItem {
  id: string;
  period: string;
  title: string;
  status: OkrObjectiveStatus;
  sort: number;
  keyResults: OkrKeyResultItem[];
}

export interface AdminOkrListResponse {
  periods: string[];
  objectives: OkrObjectiveItem[];
}

export interface OkrObjectiveCreateRequest {
  period: string;
  title: string;
}

export interface OkrObjectivePatchRequest {
  title?: string;
  status?: OkrObjectiveStatus;
  sort?: number;
}

export interface OkrKeyResultCreateRequest {
  title: string;
  unit?: string | null;
  targetValue?: string;
}

export interface OkrKeyResultPatchRequest {
  title?: string;
  unit?: string | null;
  targetValue?: string;
  currentValue?: string;
}

export interface OkrMutationResponse {
  id: string;
}

// ===== 管理端 · 审计日志 =====

export interface AdminAuditLogItem {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  detail: { summary?: string; changes?: Record<string, unknown> } | null;
  operatorUserId: string | null;
  /** 操作人姓名（服务端按 userId 回填，查不到为 null） */
  operatorName?: string | null;
  createdAt: string;
}

export interface AdminAuditLogListResponse {
  items: AdminAuditLogItem[];
  total: number;
  page: number;
  pageSize: number;
}

// ===== 管理端 · 任务统筹 =====

export interface AdminCoordinationTask {
  taskId: string;
  sequenceId: number | null;
  title: string;
  projectName: string | null;
  statusLabel: string;
  targetDate: string | null;
  overdue: boolean;
}

export interface AdminCoordinationEmployee {
  userId: string;
  name: string;
  role: string;
  todayTotal: number;
  todayDone: number;
  overdueCount: number;
  tasks: AdminCoordinationTask[];
}

export interface AdminTaskCoordinationResponse {
  items: AdminCoordinationEmployee[];
  generatedAt: string;
}

// ===== 管理端 · 员工绑定管理 =====

export interface AdminEmployeeBindingUpsertRequest {
  miaodaUserId: string;
  planeMemberId: string;
  planeMemberName: string;
  role: EmployeeRole;
  frappeEmployeeId?: string | null;
}

export interface AdminEmployeeBindingUpsertResponse {
  item: AdminEmployeeBindingRow;
}

// ===== OpenAPI 对外接口 · 委派任务审核（豆包技能 HTTP 兜底通道）=====

export interface OpenApiTaskReviewItem {
  taskId: string;
  sequenceId: number | null;
  title: string;
  projectName: string;
  assigneeName: string;
  rewardAmount: number | null;
  deadline: string | null;
  submittedAt: string | null;
  evidenceText: string | null;
  evidenceFileUrls: string[];
}

export interface OpenApiTaskReviewListResponse {
  items: OpenApiTaskReviewItem[];
}

export interface OpenApiTaskReviewVerdictRequest {
  taskId: string;
  verdict: 'pass' | 'revise';
  reason: string;
}

export interface OpenApiTaskReviewVerdictResult {
  taskId: string;
  verdict: 'pass' | 'revise';
  stateChanged: boolean;
  notified: boolean;
  message: string;
}

export interface OpenApiTaskReviewApproveRequest {
  taskId: string;
  action: 'approve' | 'reject';
  comment?: string;
}

export interface OpenApiTaskReviewApproveResult {
  taskId: string;
  action: 'approve' | 'reject';
  stateChanged: boolean;
  message: string;
}

export interface CreateAgentTaskRequest {
  title: string;
  taskType?: 'config' | 'verify';
  instruction: string;
}

export interface AgentTaskCreated {
  taskId: string;
  title: string;
  taskType: string;
  instruction: string;
  status: string;
  resultNote: string | null;
  createdAt: string;
  notified: boolean;
  notifyDetail: string;
}

/** 托管客户档案维度：企业支付宝/闲鱼/电话卡/其他 */
export type HostedCustomerDimension =
  | 'enterprise_alipay'
  | 'xianyu'
  | 'phone_card'
  | 'other';

export type HostedCustomerStatus = 'hosting' | 'paused' | 'returned';

export interface HostedCustomerInfo {
  id: string;
  customerName: string;
  dimension: HostedCustomerDimension;
  contactName: string | null;
  contactPhone: string | null;
  /** 法人姓名（关键实名操作的主体） */
  legalPersonName: string | null;
  /** 法人主设备手机号（法人本人实名手机，企业支付宝绑定等关键操作用） */
  mainDevicePhone: string | null;
  /** 主邮箱（腾讯邮箱，工商局登记等政务通知接收） */
  mainEmail: string | null;
  content: string | null;
  status: HostedCustomerStatus;
  ownerUserId: string;
  ownerName: string | null;
  startedAt: string | null;
  remark: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HostedCustomerListResponse {
  items: HostedCustomerInfo[];
}

export interface CreateHostedCustomerRequest {
  customerName: string;
  dimension: HostedCustomerDimension;
  contactName?: string;
  contactPhone?: string;
  legalPersonName?: string;
  mainDevicePhone?: string;
  mainEmail?: string;
  content?: string;
  status?: HostedCustomerStatus;
  /** 负责员工（管理端可指定；员工端固定为本人） */
  ownerUserId?: string;
  startedAt?: string;
  remark?: string;
}

export interface UpdateHostedCustomerRequest {
  customerName?: string;
  dimension?: HostedCustomerDimension;
  contactName?: string | null;
  contactPhone?: string | null;
  legalPersonName?: string | null;
  mainDevicePhone?: string | null;
  mainEmail?: string | null;
  content?: string | null;
  status?: HostedCustomerStatus;
  ownerUserId?: string;
  startedAt?: string | null;
  remark?: string | null;
}

// ==================== 登录（独立部署，替代妙搭网关） ====================

/** GET /api/auth/options：登录页按它决定显示哪些登录方式 */
export interface AuthOptionsResponse {
  oidcEnabled: boolean;
  /** 统一登录按钮上的名字，默认「统一账号」 */
  oidcProviderName: string;
  /** 仅本机开发（AUTH_DEV_LOGIN=true 且非生产）为 true */
  devLoginEnabled: boolean;
}

/** GET /api/auth/me：当前登录人（未登录 401） */
export interface AuthMeResponse {
  userId: string;
  name: string;
  roles: string[];
}

/** POST /api/files/upload：文件网关返回的上传结果 */
export interface WorkbenchUploadResult {
  url: string;
  name: string;
  size: number;
}

// ==================== 站内消息（独立部署，替代飞书通知） ====================

/** 消息类别：前端按它挑图标 */
export type NotificationCategory =
  | 'task'
  | 'task_review'
  | 'block_defer'
  | 'workorder'
  | 'tutorial'
  | 'dev_request'
  | 'general';

export interface NotificationItem {
  id: string;
  title: string;
  body: string;
  /** 站内跳转路径（前端路由，如 /tasks/xxx?projectId=yyy）；null = 只看不跳 */
  link: string | null;
  category: NotificationCategory;
  /** 已读时间；null = 未读 */
  readAt: string | null;
  createdAt: string;
}

/** GET /api/notifications?page=&pageSize=：我的消息（新的在前） */
export interface NotificationListResponse {
  items: NotificationItem[];
  total: number;
  page: number;
  pageSize: number;
  unreadCount: number;
}

/** GET /api/notifications/unread-count */
export interface NotificationUnreadResponse {
  unreadCount: number;
}

/** POST /api/notifications/:id/read 与 POST /api/notifications/read-all */
export interface NotificationReadResponse {
  /** 这次标记的条数（已读过的不算） */
  updated: number;
  unreadCount: number;
}

/**
 * GET /api/integrations：飞书 / 豆包可选集成的开关（环境变量，默认全开）。
 * 只反映开关本身；开了但凭证、智能体 ID 没配时，功能照旧降级。
 */
export interface OptionalIntegrations {
  /** FEISHU_NOTIFY_ENABLED：站内消息之外同时发飞书卡片 */
  feishuNotify: boolean;
  /** FEISHU_WIKI_SYNC_ENABLED：SOP、顺延制度条文同步飞书 Wiki */
  feishuWikiSync: boolean;
  /** AILY_TASK_REVIEW_ENABLED：委派材料推豆包 AI 审核 */
  aiTaskReview: boolean;
  /** AILY_BLOCK_DEFER_REVIEW_ENABLED：顺延申请推豆包 AI 初审 */
  aiBlockDeferReview: boolean;
  /** AILY_WORKORDER_REVIEW_ENABLED：工单豆包 AI 初审 */
  aiWorkorderReview: boolean;
  /** AILY_QUICK_TASK_DRAFT_ENABLED：快速下任务 AI 草稿 */
  aiQuickTaskDraft: boolean;
  /** AILY_SOP_ENABLED：堵塞后 AI 生成 SOP */
  aiSop: boolean;
  /** AILY_AGENT_TASK_PUSH_ENABLED：新建配置任务推豆包 */
  aiAgentTaskPush: boolean;
}

// ==================== 开发需求（2026-10-19 老板定） ====================
// A 发需求给 B → B 报工时和价格 → A 确认报价才开工 → B 交付 → A 验收 → 结束。
// 状态以 Plane 为准（开发类项目的五步状态：需求提交 / 需求评审 / 工时报价 / 开发交付 / 结果验收），
// 报价、确认、交付、验收这些流程数据存工作台库；价格只记账、不进钱包（验收通过记一笔开发需求台账）。

/**
 * 开发需求走到哪一步：前五个按 Plane 状态名认，done / cancelled 按 Plane 状态分组，
 * blocked = 开发中报了阻塞（Plane 的阻塞状态），other = 在 Plane 里被改成了流程外的状态，
 * missing = Plane 里找不到这条任务（被删或归档）
 */
export type DevRequestStage =
  | 'submitted'
  | 'clarifying'
  | 'quoted'
  | 'developing'
  | 'reviewing'
  | 'done'
  | 'cancelled'
  | 'blocked'
  | 'other'
  | 'missing';

/** 当前用户此刻能做的动作：服务端按环节和身份算好，前端只按它出按钮 */
export type DevRequestAction =
  | 'quote'
  | 'return'
  | 'clarify'
  | 'confirm_quote'
  | 'reject_quote'
  | 'deliver'
  | 'block'
  | 'unblock'
  | 'accept'
  | 'reject_delivery'
  | 'cancel';

/** 当前有效的报价（被退回的不算，历史在事件里） */
export interface DevRequestQuote {
  hours: number;
  /** 报价（元，最多两位小数），只记账不进钱包 */
  amount: number;
  note: string | null;
  /** 承诺交付日期 YYYY-MM-DD */
  promisedDate: string | null;
  quotedAt: string;
  quotedByName: string | null;
  /** 发布人（或老板）确认的时间；null = 还没确认 */
  confirmedAt: string | null;
  confirmedByName: string | null;
}

export interface DevRequestSummary {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  /** Plane 任务 ID 与序号 */
  issueId: string;
  sequenceId: number | null;
  stage: DevRequestStage;
  /** 显示用的环节名：五步用 Plane 状态名，完成组「已验收」/「完成」，撤销组「已撤销」 */
  stageLabel: string;
  /** 下一步轮到谁做什么，如「等开发者报价」 */
  nextStep: string;
  publisherId: string;
  publisherName: string;
  developerId: string;
  developerName: string;
  quote: DevRequestQuote | null;
  /** 验收金额（元）；没验收为 null */
  finalAmount: number | null;
  acceptedAt: string | null;
  cancelledAt: string | null;
  /** 和流程对不上的情况（如在 Plane 里直接拖成完成），原话给人看；正常为 null */
  warning: string | null;
  /** 当前用户在这条需求里的身份；boss = 老板（不是发布人也不是开发者） */
  myRole: 'publisher' | 'developer' | 'boss' | 'viewer';
  /** 轮到当前用户处理（撤销不算） */
  needsMe: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DevRequestEventView {
  id: string;
  action: string;
  /** 「发布」「报价」「确认报价」… */
  actionLabel: string;
  actorName: string | null;
  /** 这一步之后的环节；只记事、不挪状态的为 null */
  toStage: DevRequestStage | null;
  note: string | null;
  /** 报价、验收金额、交付链接等，按 action 显示 */
  detail: {
    hours?: number;
    amount?: number;
    promisedDate?: string | null;
    quoteAmount?: number;
    finalAmount?: number;
    adjustReason?: string | null;
    links?: string[];
  } | null;
  createdAt: string;
}

export interface DevRequestDelivery {
  note: string;
  links: string[];
  deliveredAt: string;
}

export interface DevRequestDetail extends DevRequestSummary {
  /** Plane 描述正文（去掉验收条件、发布人、工时、报价这些行） */
  description: string;
  /** 验收条件 */
  acceptance: string | null;
  /** 最近一次交付（打回后清空，历史在事件里） */
  delivery: DevRequestDelivery | null;
  /** 验收金额和报价不一样时写的原因 */
  adjustReason: string | null;
  acceptedByName: string | null;
  cancelReason: string | null;
  events: DevRequestEventView[];
  actions: DevRequestAction[];
}

export interface DevRequestListResponse {
  items: DevRequestSummary[];
  /** 当前用户能看全部（boss / admin 本人；演示视角不算） */
  canSeeAll: boolean;
}

export interface DevRequestProjectOption {
  projectId: string;
  name: string;
  identifier: string;
}

export interface DevRequestDeveloperOption {
  userId: string;
  name: string;
}

/** GET /api/dev-requests/options：能发需求的开发类项目 */
export interface DevRequestOptionsResponse {
  projects: DevRequestProjectOption[];
}

/** GET /api/dev-requests/options/developers?projectId=：这个项目里能派的开发者（项目成员且绑定了员工） */
export interface DevRequestDevelopersResponse {
  developers: DevRequestDeveloperOption[];
}

export interface CreateDevRequestRequest {
  projectId: string;
  developerId: string;
  title: string;
  description: string;
  /** 验收条件 */
  acceptance: string;
}

export interface DevRequestQuoteRequest {
  hours: number;
  amount: number;
  note?: string;
  promisedDate?: string;
}

export interface DevRequestReasonRequest {
  reason: string;
}

export interface DevRequestClarifyRequest {
  description: string;
  acceptance: string;
  note?: string;
}

export interface DevRequestDeliverRequest {
  note: string;
  links?: string[];
}

export interface DevRequestAcceptRequest {
  /** 验收金额（元），不填 = 确认过的报价；和报价不一样必须写 adjustReason */
  finalAmount?: number;
  adjustReason?: string;
  note?: string;
}

export interface DevRequestActionResponse {
  ok: boolean;
  message: string;
  id: string;
  stage: DevRequestStage;
}

export interface DevRequestLedgerRow {
  id: string;
  devRequestId: string;
  title: string;
  projectId: string;
  projectName: string;
  sequenceId: number | null;
  publisherId: string;
  publisherName: string;
  developerId: string;
  developerName: string;
  quoteHours: number;
  quoteAmount: number;
  finalAmount: number;
  adjustReason: string | null;
  acceptedByName: string | null;
  acceptedAt: string;
  /** 上海日 YYYY-MM-DD */
  acceptedDate: string;
}

export interface DevRequestLedgerGroup {
  id: string;
  name: string;
  count: number;
  quoteAmount: number;
  finalAmount: number;
}

/** GET /api/admin/dev-requests/ledger?month=YYYY-MM&developerId=&projectId= */
export interface DevRequestLedgerResponse {
  /** 筛选的月份；null = 全部 */
  month: string | null;
  rows: DevRequestLedgerRow[];
  total: { count: number; hours: number; quoteAmount: number; finalAmount: number };
  byDeveloper: DevRequestLedgerGroup[];
  byProject: DevRequestLedgerGroup[];
  /** 筛选下拉的选项：台账里出现过的开发者、项目 */
  developerOptions: { id: string; name: string }[];
  projectOptions: { id: string; name: string }[];
}

// ───────── 个人 API Key（2026-10-22）─────────

export interface ApiKeyListItem {
  id: string;
  name: string;
  /** 展示用前缀（wk_ + 前 8 位） */
  keyPrefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** GET /api/my/api-keys */
export interface ApiKeyListResponse {
  items: ApiKeyListItem[];
}

/** POST /api/my/api-keys：key 只返回这一次，之后只有前缀 */
export interface ApiKeyIssueResponse {
  id: string;
  name: string;
  key: string;
  createdAt: string;
}

// ───────── OAuth 授权的 AI 应用（2026-10-25）─────────

export interface OAuthGrantListItem {
  id: string;
  /** 应用自报的名字（如 ChatGPT），没报为空串 */
  clientName: string;
  /** 授权后回到的站点（如 chatgpt.com；桌面工具为「本机程序」） */
  redirectLabel: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** GET /api/my/oauth-grants：还有效的授权（收回的、过期的不列） */
export interface OAuthGrantListResponse {
  items: OAuthGrantListItem[];
}

// ───────── 外部 MCP 登记（销售工作台 A03，11-10）─────────

export interface ExternalMcpTestResult {
  ok: boolean;
  at: string;
  /** 一句话结果：成功时是服务名，失败时是原因 */
  message: string;
  toolCount: number | null;
  /** 工具名（最多 100 个） */
  tools: string[];
  latencyMs: number | null;
}

export interface ExternalMcpServerView {
  id: string;
  name: string;
  url: string;
  /** 密钥放在哪个请求头；null = Authorization: Bearer */
  authHeader: string | null;
  /** 只告诉有没有填，密钥本身不回显 */
  hasSecret: boolean;
  purpose: string | null;
  enabled: boolean;
  lastTest: ExternalMcpTestResult | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalMcpListResponse {
  items: ExternalMcpServerView[];
}

export interface ExternalMcpUpsertRequest {
  name: string;
  url: string;
  authHeader?: string | null;
  /** 新建时填了就存；修改时不传 = 不动，传空串 = 清掉 */
  secret?: string;
  purpose?: string | null;
  enabled?: boolean;
}

export interface ExternalMcpServerResponse {
  item: ExternalMcpServerView;
}

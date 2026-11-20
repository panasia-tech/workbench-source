import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, isNotNull } from 'drizzle-orm';
import {
  problemPool,
  rewardLedger,
} from '@server/database/schema';
import { BindingService } from '../integration/binding.service';
import { FrappeService } from '../integration/frappe.service';
import type {
  PerformanceCycle,
  PerformanceEvent,
  PerformanceEventType,
  PerformanceKraRow,
  PerformanceOverview,
  ProblemDiscoverySummary,
} from '@shared/api.interface';

interface FrappeCycleRaw {
  name: string;
  cycle_name: string | null;
  start_date: string | null;
  end_date: string | null;
}

interface FrappeAppraisalRaw {
  name: string;
  appraisal_cycle: string | null;
  goals: Array<{
    kra: string | null;
    per_weightage: number | null;
    score: number | null;
    score_earned: number | null;
  }> | null;
}

interface FrappeAdditionalSalaryRaw {
  name: string;
  salary_component: string | null;
  amount: number | null;
  payroll_date: string | null;
  remarks: string | null;
}

interface FrappeComponentRaw {
  name: string;
  type: string | null;
}

interface FrappeAttendanceRaw {
  name: string;
  attendance_date: string | null;
  status: string | null;
  in_time: string | null;
}

interface FrappeLeaveAllocationRaw {
  name: string;
  leave_type: string | null;
  new_leaves_allocated: number | null;
  from_date: string | null;
}

interface FrappeSalaryStructureRaw {
  name: string;
  is_active: number;
  earnings: Array<{ salary_component: string; amount: number | null }>;
}

interface FrappeEmployeeRaw {
  designation: string | null;
  user_id: string | null;
}

interface FrappeCertificateRaw {
  name: string;
  member: string | null;
  course: string | null;
  course_title: string | null;
  issue_date: string | null;
}

interface FrappeQuizSubmissionRaw {
  name: string;
  quiz_title: string | null;
  member: string | null;
  percentage: number | null;
  passing_percentage: number | null;
}

interface FrappeLmsLearning {
  certificates: FrappeCertificateRaw[];
  quizSubmissions: FrappeQuizSubmissionRaw[];
  courseCategoryByLink: Map<string, string | null>;
}

function ratingLabel(score: number): string {
  if (score >= 90) return '优秀';
  if (score >= 80) return '良好';
  if (score >= 70) return '合格';
  return '待改进';
}

@Injectable()
export class PerformanceService {
  private readonly logger = new Logger(PerformanceService.name);
  private readonly bonusCache = new Map<
    string,
    { at: number; value: number | null }
  >();

  constructor(
    private readonly frappe: FrappeService,
    private readonly bindingService: BindingService,
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async getExpectedBonusForEmployee(userId: string): Promise<number | null> {
    const hit = this.bonusCache.get(userId);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    let value: number | null = null;
    const binding = await this.bindingService.getBinding(userId);
    if (binding?.frappeEmployeeId) {
      const employee = await this.frappe
        .getOptional<FrappeEmployeeRaw>('Employee', binding.frappeEmployeeId)
        .catch((): null => null);
      value = await this.getExpectedBonus(employee?.designation ?? null);
    }
    this.bonusCache.set(userId, { at: Date.now(), value });
    return value;
  }

  async getPerformanceOverview(userId: string): Promise<PerformanceOverview> {
    const binding = await this.bindingService.getBinding(userId);
    if (!binding || !binding.frappeEmployeeId) {
      return {
        currentCycleId: null,
        expectedBonus: null,
        cycles: [],
        events: [],
        problemDiscovery: null,
      };
    }
    const employeeId = binding.frappeEmployeeId;

    const [cyclesRaw, appraisalNames, salaryNames, attendance, leaveNames, employee] =
      await Promise.all([
        this.listCycles(),
        this.listNames(
          'Appraisal',
          employeeId,
        ),
        this.listNames('Additional Salary', employeeId),
        this.listAttendance(employeeId),
        this.listNames('Leave Allocation', employeeId),
        this.frappe
          .getOptional<FrappeEmployeeRaw>('Employee', employeeId)
          .catch(() => null),
      ]);

    const [appraisals, salaryDocs, leaveDocs, components] = await Promise.all([
      Promise.all(
        appraisalNames.map((row: { name: string }) =>
          this.frappe
            .getOptional<FrappeAppraisalRaw>('Appraisal', row.name)
            .catch(() => null),
        ),
      ),
      Promise.all(
        salaryNames.map((row: { name: string }) =>
          this.frappe
            .getOptional<FrappeAdditionalSalaryRaw>('Additional Salary', row.name)
            .catch(() => null),
        ),
      ),
      Promise.all(
        leaveNames.map((row: { name: string }) =>
          this.frappe
            .getOptional<FrappeLeaveAllocationRaw>('Leave Allocation', row.name)
            .catch(() => null),
        ),
      ),
      this.frappe
        .list<FrappeComponentRaw>('Salary Component', {
          fields: ['name', 'type'],
        })
        .catch(() => [] as FrappeComponentRaw[]),
    ]);

    const today = this.todayShanghai();
    const cycles: PerformanceCycle[] = cyclesRaw
      .filter((c: FrappeCycleRaw) => c.start_date !== null && c.end_date !== null)
      .sort((a: FrappeCycleRaw, b: FrappeCycleRaw) =>
        a.start_date === b.start_date ? 0 : a.start_date! < b.start_date! ? -1 : 1,
      )
      .map((c: FrappeCycleRaw) => {
        const appraisal = appraisals.find(
          (a: FrappeAppraisalRaw | null) => a?.appraisal_cycle === c.name,
        );
        const kras: PerformanceKraRow[] = (appraisal?.goals ?? []).map(
          (g): PerformanceKraRow => ({
            name: g.kra ?? '未命名指标',
            weight: g.per_weightage ?? 0,
            rating: g.score ?? 0,
            earned: g.score_earned ?? 0,
          }),
        );
        const earnedSum = kras.reduce(
          (sum: number, k: PerformanceKraRow) => sum + k.earned,
          0,
        );
        const score = kras.length > 0 ? Math.round(earnedSum) : null;
        return {
          id: c.name,
          name: (c.cycle_name ?? c.name).replace(/^Demo\s*/u, ''),
          startDate: c.start_date,
          endDate: c.end_date,
          score,
          ratingLabel: score === null ? null : ratingLabel(score),
          active: c.end_date! >= today,
          kras,
        };
      });

    const activeCycle = cycles.find((c: PerformanceCycle) => c.active);
    const currentCycleId =
      activeCycle?.id ?? (cycles.length > 0 ? cycles[cycles.length - 1].id : null);

    const componentType = new Map<string, string>(
      components.map((c: FrappeComponentRaw) => [c.name, c.type ?? '']),
    );
    const lmsLearning = await this.listLmsLearning(employee?.user_id ?? null);
    const events = this.buildEvents(
      salaryDocs,
      componentType,
      attendance,
      leaveDocs,
      lmsLearning,
    );
    const expectedBonus = await this.getExpectedBonus(
      employee?.designation ?? null,
    );

    // 安灯链路：问题发现故事线（summary + problem 事件），失败降级不阻断主数据
    let problemDiscovery: ProblemDiscoverySummary | null = null;
    let problemEvents: PerformanceEvent[] = [];
    try {
      const lamp = await this.buildProblemDiscovery(userId);
      problemDiscovery = lamp.summary;
      problemEvents = lamp.events;
    } catch (error) {
      this.logger.warn(
        `问题发现故事线组装失败（用户 ${userId}）：${
          error instanceof Error ? error.stack : String(error)
        }`,
      );
    }

    const allEvents: PerformanceEvent[] = [...events, ...problemEvents].sort(
      (a: PerformanceEvent, b: PerformanceEvent) => (a.date < b.date ? 1 : -1),
    );

    return {
      currentCycleId,
      expectedBonus,
      cycles,
      events: allEvents,
      problemDiscovery,
    };
  }

  /** 安灯链路：按报告人聚合问题池 + 奖励流水，产出故事线摘要与事件。 */
  private async buildProblemDiscovery(
    userId: string,
  ): Promise<{
    summary: ProblemDiscoverySummary;
    events: PerformanceEvent[];
  }> {
    const month = this.todayShanghai().slice(0, 7);
    const poolRows = await this.db
      .select({
        id: problemPool.id,
        title: problemPool.title,
        category: problemPool.category,
        status: problemPool.status,
        responseAt: problemPool.responseAt,
        respondedAt: problemPool.respondedAt,
        rejectReason: problemPool.rejectReason,
        bountyAmount: problemPool.bountyAmount,
        repairedAt: problemPool.repairedAt,
      })
      .from(problemPool)
      .where(
        and(
          eq(problemPool.reporterId, userId),
          isNotNull(problemPool.responseAt),
        ),
      );
    const ledgerRows = await this.db
      .select({
        amount: rewardLedger.amount,
        createdAt: rewardLedger.createdAt,
      })
      .from(rewardLedger)
      .where(
        and(
          eq(rewardLedger.beneficiary, userId),
          eq(rewardLedger.type, 'problem_bounty'),
        ),
      );

    let discovered = 0;
    let adopted = 0;
    let repaired = 0;
    let bountyTotal = 0;
    const events: PerformanceEvent[] = [];

    for (const row of poolRows) {
      if (row.responseAt === null) continue;
      if (this.shanghaiMonthOf(row.responseAt) === month) discovered += 1;
      if (
        row.respondedAt !== null &&
        (row.status === 'confirmed' || row.status === 'projected') &&
        this.shanghaiMonthOf(row.respondedAt) === month
      ) {
        adopted += 1;
      }
      if (
        row.repairedAt !== null &&
        this.shanghaiMonthOf(row.repairedAt) === month
      ) {
        repaired += 1;
      }
      const bounty = Number(row.bountyAmount);
      let detail: string;
      if (row.status === 'pending_response') {
        detail = '问题工单待响应';
      } else if (row.status === 'confirmed') {
        detail =
          bounty > 0 ? `已确认有效 +¥${bounty} 已入钱包` : '已确认有效';
      } else if (row.status === 'projected') {
        detail = '已立项跟进';
      } else {
        detail =
          row.rejectReason !== null
            ? `已驳回：${row.rejectReason}`
            : '已驳回';
      }
      events.push({
        id: `problem-${row.id}`,
        date: row.responseAt.toISOString(),
        type: 'problem',
        title: `发现问题：${row.title}`.slice(0, 80),
        detail,
        amount: bounty > 0 ? bounty : null,
        source: '安灯链路',
      });
      if (row.repairedAt !== null) {
        events.push({
          id: `problem-repaired-${row.id}`,
          date: row.repairedAt.toISOString(),
          type: 'problem',
          title: `问题已修复：${row.title}`.slice(0, 80),
          detail: '改进项目结项回访',
          amount: null,
          source: '安灯链路',
        });
      }
    }

    for (const ledger of ledgerRows) {
      if (this.shanghaiMonthOf(ledger.createdAt) !== month) continue;
      const amount = Number(ledger.amount);
      if (Number.isFinite(amount)) bountyTotal += amount;
    }

    return {
      summary: { discovered, adopted, repaired, bountyTotal },
      events,
    };
  }

  private shanghaiMonthOf(date: Date): string {
    return new Date(date.getTime() + 8 * 3600 * 1000)
      .toISOString()
      .slice(0, 7);
  }

  private async listLmsLearning(
    userEmail: string | null,
  ): Promise<FrappeLmsLearning> {
    const empty: FrappeLmsLearning = {
      certificates: [],
      quizSubmissions: [],
      courseCategoryByLink: new Map(),
    };
    if (!userEmail) return empty;
    // 魔改 Frappe 对 LMS 表禁用 list filters，全拉后内存过滤
    const [certs, quizSubs, courses, categories] = await Promise.all([
      this.frappe
        .list<FrappeCertificateRaw>('LMS Certificate', {
          fields: ['name', 'member', 'course', 'course_title', 'issue_date'],
        })
        .catch(() => [] as FrappeCertificateRaw[]),
      this.frappe
        .list<FrappeQuizSubmissionRaw>('LMS Quiz Submission', {
          fields: ['name', 'quiz_title', 'member', 'percentage', 'passing_percentage'],
        })
        .catch(() => [] as FrappeQuizSubmissionRaw[]),
      this.frappe
        .list<{ name: string; category: string | null }>('LMS Course', {
          fields: ['name', 'category'],
        })
        .catch(() => [] as Array<{ name: string; category: string | null }>),
      this.frappe
        .list<{ name: string; category: string | null }>('LMS Category', {
          fields: ['name', 'category'],
        })
        .catch(() => [] as Array<{ name: string; category: string | null }>),
    ]);
    const categoryTextByLink = new Map<string, string | null>();
    for (const c of categories) categoryTextByLink.set(c.name, c.category);
    const courseCategoryByLink = new Map<string, string | null>();
    for (const c of courses) {
      courseCategoryByLink.set(
        c.name,
        c.category ? categoryTextByLink.get(c.category) ?? null : null,
      );
    }
    return {
      certificates: certs.filter((c: FrappeCertificateRaw) => c.member === userEmail),
      quizSubmissions: quizSubs.filter(
        (s: FrappeQuizSubmissionRaw) => s.member === userEmail,
      ),
      courseCategoryByLink,
    };
  }

  private buildEvents(
    salaryDocs: Array<FrappeAdditionalSalaryRaw | null>,
    componentType: Map<string, string>,
    attendance: FrappeAttendanceRaw[],
    leaveDocs: Array<FrappeLeaveAllocationRaw | null>,
    lms: FrappeLmsLearning,
  ): PerformanceEvent[] {
    const events: PerformanceEvent[] = [];

    for (const s of salaryDocs) {
      if (!s || !s.payroll_date) continue;
      const type = componentType.get(s.salary_component ?? '') ?? '';
      const isDeduction = type.includes('Deduction');
      events.push({
        id: s.name,
        date: s.payroll_date.slice(0, 10),
        type: isDeduction ? 'deduction' : 'bonus',
        title: s.salary_component ?? '薪资事件',
        detail: s.remarks ?? null,
        amount: (s.amount ?? 0) * (isDeduction ? -1 : 1),
        source: 'Frappe HR',
      });
    }

    for (const a of attendance) {
      if (!a.attendance_date) continue;
      if (a.status === 'Absent') {
        events.push({
          id: a.name,
          date: a.attendance_date,
          type: 'attendance',
          title: '缺勤一天',
          detail: null,
          amount: null,
          source: 'Frappe HR',
        });
        continue;
      }
      const hhmm = a.in_time ? a.in_time.slice(11, 16) : '';
      if (hhmm > '09:10') {
        events.push({
          id: a.name,
          date: a.attendance_date,
          type: 'attendance',
          title: `迟到（${hhmm} 到岗）`,
          detail: null,
          amount: null,
          source: 'Frappe HR',
        });
      }
    }

    for (const l of leaveDocs) {
      if (!l || !l.from_date) continue;
      const days = l.new_leaves_allocated ?? 0;
      if (days <= 0) continue;
      events.push({
        id: l.name,
        date: l.from_date,
        type: 'leave',
        title: `${l.leave_type ?? '请假'} ${days} 天`,
        detail: null,
        amount: null,
        source: 'Frappe HR',
      });
    }

    const certDateByTitle = new Map<string, string>();
    for (const cert of lms.certificates) {
      if (cert.course_title && cert.issue_date) {
        certDateByTitle.set(cert.course_title, cert.issue_date);
      }
    }

    for (const cert of lms.certificates) {
      if (!cert.course || !cert.issue_date || !cert.course_title) continue;
      events.push({
        id: `course-${cert.name}`,
        date: cert.issue_date,
        type: 'course',
        title: `完成《${cert.course_title}》`,
        detail:
          lms.courseCategoryByLink.get(cert.course) === '必修'
            ? '必修课程'
            : '自学课程',
        amount: null,
        source: 'Frappe LMS',
      });
    }

    for (const s of lms.quizSubmissions) {
      if (!s.quiz_title) continue;
      const date = certDateByTitle.get(s.quiz_title);
      if (!date) continue;
      const percentage = s.percentage ?? 0;
      events.push({
        id: `exam-${s.name}`,
        date,
        type: 'exam',
        title: `${s.quiz_title} · ${percentage} 分`,
        detail:
          percentage >= (s.passing_percentage ?? 60) ? '通过' : '未通过',
        amount: null,
        source: 'Frappe LMS',
      });
    }

    return events.sort((a: PerformanceEvent, b: PerformanceEvent) =>
      a.date < b.date ? 1 : -1,
    );
  }

  private async getExpectedBonus(
    designation: string | null,
  ): Promise<number | null> {
    const structures = await this.frappe
      .list<FrappeSalaryStructureRaw>('Salary Structure', {
        fields: ['name', 'is_active'],
      })
      .catch(() => [] as FrappeSalaryStructureRaw[]);
    const target =
      structures.find(
        (s: FrappeSalaryStructureRaw) =>
          designation !== null && s.name.includes(designation),
      ) ?? structures[0];
    if (target === undefined) return null;
    const matched = await this.frappe
      .getOptional<FrappeSalaryStructureRaw>('Salary Structure', target.name)
      .catch(() => null);
    return (
      (matched?.earnings ?? []).find((e: { salary_component: string }) =>
        e.salary_component.includes('绩效奖金'),
      )?.amount ?? null
    );
  }

  private listCycles(): Promise<FrappeCycleRaw[]> {
    return this.frappe
      .list<FrappeCycleRaw>('Appraisal Cycle', {
        fields: ['name', 'cycle_name', 'start_date', 'end_date'],
      })
      .catch(() => [] as FrappeCycleRaw[]);
  }

  private listNames(
    doctype: string,
    employeeId: string,
  ): Promise<Array<{ name: string }>> {
    return this.frappe
      .list<{ name: string }>(doctype, {
        fields: ['name'],
        filters: [['employee', '=', employeeId]],
      })
      .catch(() => [] as Array<{ name: string }>);
  }

  private listAttendance(employeeId: string): Promise<FrappeAttendanceRaw[]> {
    return this.frappe
      .list<FrappeAttendanceRaw>('Attendance', {
        fields: ['name', 'attendance_date', 'status', 'in_time'],
        filters: [['employee', '=', employeeId]],
      })
      .catch(() => [] as FrappeAttendanceRaw[]);
  }

  private todayShanghai(): string {
    return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }
}

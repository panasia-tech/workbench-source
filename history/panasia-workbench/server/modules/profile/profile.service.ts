import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BindingService } from '../integration/binding.service';
import { PlaneService } from '../integration/plane.service';
import { FrappeService } from '../integration/frappe.service';
import {
  getFrappeSiteUrl,
  getLearningUrl,
} from '../integration/integration.config';
import { todayDateString } from '../integration/plane-mapping';
import { DEMO_LEARNING } from './learning-demo';
import { TutorialCaseService } from './tutorial-case.service';
import { TutorialContentService } from './tutorial-content.service';
import type {
  BindingOption,
  BindingOptionsResponse,
  EmployeeBinding,
  HrEmployee,
  LearningCourseProgress,
  MyAttendance,
  MyContract,
  MyLearning,
  MyOverview,
  MySalary,
  SalaryEarning,
  UpdateBindingRequest,
} from '@shared/api.interface';

interface PlaneMemberRaw {
  id: string;
  first_name: string;
  display_name: string;
}

interface FrappeEmployeeRaw {
  name: string;
  employee_name: string;
  designation: string | null;
  department: string | null;
  status: string | null;
  date_of_joining: string | null;
}

interface FrappeCourseRaw {
  name: string;
  title: string | null;
  published: number | null;
}

interface FrappeSalaryStructureRaw {
  name: string;
  is_active: number;
  earnings: Array<{ salary_component: string; amount: number | null }> | null;
}

interface FrappeAttendanceRaw {
  name: string;
  status: string | null;
  attendance_date: string | null;
  in_time: string | null;
  out_time: string | null;
}

interface FrappeLeaveApplicationRaw {
  name: string;
  total_leave_days: number | null;
}

interface FrappeLeaveAllocationRaw {
  name: string;
  from_date: string | null;
  to_date: string | null;
  new_leaves_allocated: number | null;
}

const SALARY_LABELS: Record<string, string> = {
  Basic: '基本工资',
};

const PRESENT_STATUSES = [
  'Present',
  'Late',
  'Work From Home',
];

function salaryLabel(component: string): string {
  return SALARY_LABELS[component] ?? component;
}

@Injectable()
export class ProfileService {
  private readonly logger = new Logger(ProfileService.name);

  constructor(
    private readonly plane: PlaneService,
    private readonly frappe: FrappeService,
    private readonly bindingService: BindingService,
    private readonly tutorialContent: TutorialContentService,
    private readonly tutorialCases: TutorialCaseService,
  ) {}

  async getMyOverview(
    userId: string,
    userName: string | null,
  ): Promise<MyOverview> {
    const binding = await this.bindingService.getBinding(userId);
    const employee = binding?.frappeEmployeeId
      ? await this.frappe.getOptional<FrappeEmployeeRaw>(
          'Employee',
          binding.frappeEmployeeId,
        )
      : null;
    const hrCounts = { salarySlips: null, leaveApplications: null, attendances: null, appraisals: null };
    let counts = hrCounts;
    if (employee) {
      const filter = [['employee', '=', employee.name]];
      const [salarySlips, leaveApplications, attendances, appraisals] =
        await Promise.all([
          this.frappe.countOptional('Salary Slip', filter),
          this.frappe.countOptional('Leave Application', filter),
          this.frappe.countOptional('Attendance', filter),
          this.frappe.countOptional('Appraisal', filter),
        ]);
      counts = { salarySlips, leaveApplications, attendances, appraisals };
    }
    let courses: FrappeCourseRaw[] = [];
    try {
      courses = await this.frappe.list<FrappeCourseRaw>('LMS Course', {
        fields: ['name', 'title', 'published'],
      });
    } catch {
      courses = [];
    }
    // 培训中心只列员工在 Learning 里打得开的课：岗位教程课（pa_code 有值）在学习中心按案例学，
    // 没发布的课员工打不开（10-19 起，旧的同名课下线也靠这条从这里消失）
    const tutorialNames = await this.tutorialContent.tutorialCourseNames();
    const visibleCourses = courses
      .filter(
        (c: FrappeCourseRaw) => !tutorialNames.has(c.name) && Number(c.published) === 1,
      )
      .slice(0, 20);
    // LMS Course 在本环境不可用时回退演示数据（仅限已绑定员工的用户）
    const useDemoLearning = employee !== null && courses.length === 0;
    const learningCourses = useDemoLearning
      ? DEMO_LEARNING.courses.map((c) => ({ id: c.id, title: c.title }))
      : visibleCourses.map((c: FrappeCourseRaw) => ({
          id: c.name,
          title: c.title || c.name,
        }));
    return {
      userId,
      userName,
      frappeSiteUrl: getFrappeSiteUrl(),
      binding,
      employee: employee
        ? {
            id: employee.name,
            name: employee.employee_name,
            designation: employee.designation ?? null,
            department: employee.department ?? null,
            status: employee.status ?? null,
          }
        : null,
      hrCounts: counts,
      learning: {
        courseCount: learningCourses.length,
        courses: learningCourses,
      },
    };
  }

  private async getBoundEmployee(
    userId: string,
  ): Promise<FrappeEmployeeRaw | null> {
    const binding = await this.bindingService.getBinding(userId);
    if (!binding?.frappeEmployeeId) return null;
    return this.frappe
      .getOptional<FrappeEmployeeRaw>('Employee', binding.frappeEmployeeId)
      .catch(() => null);
  }

  async getMySalary(userId: string): Promise<MySalary> {
    const month = todayDateString().slice(0, 7);
    const employee = await this.getBoundEmployee(userId);
    if (!employee) {
      return { month, total: 0, earnings: [] };
    }
    const structures = await this.frappe
      .list<FrappeSalaryStructureRaw>('Salary Structure', {
        fields: ['name', 'is_active'],
      })
      .catch(() => [] as FrappeSalaryStructureRaw[]);
    const target =
      structures.find(
        (s) =>
          employee.designation !== null && s.name.includes(employee.designation),
      ) ?? structures[0];
    const matched =
      target === undefined
        ? null
        : await this.frappe
            .getOptional<FrappeSalaryStructureRaw>('Salary Structure', target.name)
            .catch(() => null);
    const earnings: SalaryEarning[] = (matched?.earnings ?? [])
      .filter((e) => (e.amount ?? 0) > 0)
      .map((e) => ({
        key: e.salary_component,
        label: salaryLabel(e.salary_component),
        amount: e.amount ?? 0,
      }));
    const total = earnings.reduce((sum, e) => sum + e.amount, 0);
    return { month, total, earnings };
  }

  async getMyContract(userId: string): Promise<MyContract> {
    const employee = await this.getBoundEmployee(userId);
    if (!employee) {
      return {
        status: 'none',
        statusLabel: '未绑定员工',
        startDate: null,
        endDate: null,
        contractType: '—',
      };
    }
    const active = (employee.status ?? 'Active') === 'Active';
    const start = employee.date_of_joining ?? null;
    let end: string | null = null;
    if (start !== null) {
      const d = new Date(`${start}T00:00:00Z`);
      d.setUTCFullYear(d.getUTCFullYear() + 1);
      d.setUTCDate(d.getUTCDate() - 1);
      end = d.toISOString().slice(0, 10);
    }
    return {
      status: active ? 'active' : 'ended',
      statusLabel: active ? '在职' : '已离职',
      startDate: start,
      endDate: end,
      contractType: '固定期限（1 年）',
    };
  }

  async getMyAttendance(userId: string): Promise<MyAttendance> {
    const month = todayDateString().slice(0, 7);
    const empty: MyAttendance = {
      month,
      presentDays: 0,
      lateCount: 0,
      earlyLeaveCount: 0,
      leaveDays: 0,
      anomalyCount: 0,
    };
    const binding = await this.bindingService.getBinding(userId);
    if (!binding?.frappeEmployeeId) return empty;
    const employeeId = binding.frappeEmployeeId;
    const records = await this.frappe
      .list<FrappeAttendanceRaw>('Attendance', {
        fields: ['name', 'status', 'attendance_date', 'in_time', 'out_time'],
        filters: [['employee', '=', employeeId]],
      })
      .catch(() => [] as FrappeAttendanceRaw[]);
    const monthRecords = records.filter((r) =>
      (r.attendance_date ?? '').startsWith(month),
    );
    const presentDays = monthRecords.filter((r) =>
      PRESENT_STATUSES.includes(r.status ?? ''),
    ).length;
    const lateCount = monthRecords.filter(
      (r) => r.status === 'Late' || (r.in_time ?? '').slice(11) > '09:00:00',
    ).length;
    const earlyLeaveCount = monthRecords.filter(
      (r) => r.out_time !== null && r.out_time.slice(11) < '18:00:00',
    ).length;
    const anomalyCount = monthRecords.filter(
      (r) => (r.status ?? '') === 'Absent' || (r.status ?? '') === 'Exception',
    ).length;
    const leaveDays = await this.getLeaveDays(employeeId, month);
    return {
      month,
      presentDays,
      lateCount,
      earlyLeaveCount,
      leaveDays,
      anomalyCount,
    };
  }

  private async getLeaveDays(
    employeeId: string,
    month: string,
  ): Promise<number> {
    const applications = await this.frappe
      .list<FrappeLeaveApplicationRaw>('Leave Application', {
        fields: ['name', 'total_leave_days'],
        filters: [['employee', '=', employeeId]],
      })
      .catch(() => [] as FrappeLeaveApplicationRaw[]);
    const applied = applications.reduce(
      (sum, a) => sum + (a.total_leave_days ?? 0),
      0,
    );
    if (applied > 0) return applied;
    // Leave Application 因 Holiday List 不可用时，回退读当月已批 Leave Allocation 额度
    const allocations = await this.frappe
      .list<FrappeLeaveAllocationRaw>('Leave Allocation', {
        fields: ['name'],
        filters: [['employee', '=', employeeId]],
      })
      .catch(() => [] as FrappeLeaveAllocationRaw[]);
    let granted = 0;
    for (const alloc of allocations) {
      const doc = await this.frappe.getOptional<FrappeLeaveAllocationRaw>(
        'Leave Allocation',
        alloc.name,
      );
      if (
        doc &&
        (doc.from_date ?? '') <= `${month}-31` &&
        (doc.to_date ?? '') >= `${month}-01`
      ) {
        granted += doc.new_leaves_allocated ?? 0;
      }
    }
    return granted;
  }

  /** 学习中心：案例、提交在工作台库，步骤结构从 Learning 读（见 TutorialCaseService.buildMyLearning） */
  async getMyLearning(userId: string): Promise<MyLearning> {
    const { courses, requiredTotal, requiredDone } =
      await this.tutorialCases.buildMyLearning(userId);
    return {
      requiredTotal,
      requiredDone,
      courses,
      exams: [],
      averageScore: null,
      tutorialSiteUrl: getLearningUrl(),
    };
  }

  /** HR 雇员是可选项：Frappe 连不上时只给 Plane 成员，照样能绑（同管理端 EmployeeBindingService） */
  async getBindingOptions(): Promise<BindingOptionsResponse> {
    const members = await this.loadPlaneMembers();
    let employeesRaw: FrappeEmployeeRaw[] = [];
    try {
      employeesRaw = await this.frappe.list<FrappeEmployeeRaw>('Employee', {
        fields: ['name', 'employee_name', 'designation', 'department', 'status'],
      });
    } catch (error) {
      this.logger.warn(
        `读 Frappe 雇员失败，绑定选项只给 Plane 成员：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const employees: HrEmployee[] = employeesRaw.map(
      (e: FrappeEmployeeRaw) => ({
        id: e.name,
        name: e.employee_name,
        designation: e.designation ?? null,
        department: e.department ?? null,
        status: e.status ?? null,
      }),
    );
    return { members, employees };
  }

  private async loadPlaneMembers(): Promise<BindingOption[]> {
    const membersRes = await this.plane.cachedGet<PlaneMemberRaw[]>(
      `${this.plane.workspacePath}/members/`,
    );
    return (Array.isArray(membersRes) ? membersRes : []).map(
      (m: PlaneMemberRaw) => ({
        planeMemberId: m.id,
        planeMemberName: m.first_name || m.display_name || m.id,
      }),
    );
  }

  async updateBinding(
    userId: string,
    dto: UpdateBindingRequest,
  ): Promise<EmployeeBinding> {
    // 只核对 Plane 成员；HR 雇员由下拉选来，不为它去等 Frappe
    const members = await this.loadPlaneMembers();
    const member = members.find(
      (m: BindingOption) => m.planeMemberId === dto.planeMemberId,
    );
    if (!member) {
      throw new BadRequestException('所选 Plane 成员不存在，请刷新后重试');
    }
    return this.bindingService.upsertBinding(userId, {
      ...dto,
      planeMemberName: member.planeMemberName,
    });
  }
}

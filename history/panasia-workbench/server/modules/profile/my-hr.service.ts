import { Injectable, NotFoundException } from '@nestjs/common';
import { BindingService } from '../integration/binding.service';
import { FrappeService } from '../integration/frappe.service';
import type {
  LeaveApplicationRecord,
  MyLeaveApplicationsResponse,
  MySalarySlipsResponse,
  SalarySlipComponent,
  SalarySlipDetail,
  SalarySlipSummary,
} from '@shared/api.interface';

interface FrappeSalarySlipRowRaw {
  name: string;
  posting_date: string | null;
  start_date: string | null;
  end_date: string | null;
  net_pay: number | null;
  gross_pay: number | null;
  status: string | null;
}

interface FrappeSalarySlipDetailRaw extends FrappeSalarySlipRowRaw {
  employee: string | null;
  total_deduction: number | null;
  earnings: Array<{ salary_component: string; amount: number | null }> | null;
  deductions: Array<{ salary_component: string; amount: number | null }> | null;
}

interface FrappeLeaveApplicationRowRaw {
  name: string;
  leave_type: string | null;
  from_date: string | null;
  to_date: string | null;
  total_leave_days: number | null;
  status: string | null;
  description: string | null;
}

const COMPONENT_LABELS: Record<string, string> = {
  Basic: '基本工资',
};

const componentLabel = (component: string): string =>
  COMPONENT_LABELS[component] ?? component;

@Injectable()
export class MyHrService {
  constructor(
    private readonly frappe: FrappeService,
    private readonly bindingService: BindingService,
  ) {}

  private async getBoundEmployeeId(userId: string): Promise<string | null> {
    const binding = await this.bindingService.getBinding(userId);
    return binding?.frappeEmployeeId ?? null;
  }

  async getMySalarySlips(userId: string): Promise<MySalarySlipsResponse> {
    const employeeId = await this.getBoundEmployeeId(userId);
    if (!employeeId) return { items: [] };
    const rows = await this.frappe
      .list<FrappeSalarySlipRowRaw>('Salary Slip', {
        fields: [
          'name',
          'posting_date',
          'start_date',
          'end_date',
          'net_pay',
          'gross_pay',
          'status',
        ],
        filters: [['employee', '=', employeeId]],
        orderBy: 'posting_date desc',
      })
      .catch(() => [] as FrappeSalarySlipRowRaw[]);
    const items: SalarySlipSummary[] = rows
      .slice()
      .sort((a: FrappeSalarySlipRowRaw, b: FrappeSalarySlipRowRaw) =>
        (b.posting_date ?? '').localeCompare(a.posting_date ?? ''),
      )
      .map((row: FrappeSalarySlipRowRaw) => ({
        name: row.name,
        postingDate: row.posting_date ?? null,
        startDate: row.start_date ?? null,
        endDate: row.end_date ?? null,
        grossPay: row.gross_pay ?? null,
        netPay: row.net_pay ?? null,
        status: row.status ?? null,
      }));
    return { items };
  }

  async getMySalarySlipDetail(
    userId: string,
    name: string,
  ): Promise<SalarySlipDetail> {
    const employeeId = await this.getBoundEmployeeId(userId);
    if (!employeeId) {
      throw new NotFoundException('未绑定员工，无法查看工资单');
    }
    const slip = await this.frappe.getOptional<FrappeSalarySlipDetailRaw>(
      'Salary Slip',
      name,
    );
    if (!slip || (slip.employee !== null && slip.employee !== employeeId)) {
      throw new NotFoundException('工资单不存在或无权查看');
    }
    const toComponents = (
      rows: Array<{ salary_component: string; amount: number | null }> | null,
    ): SalarySlipComponent[] =>
      (rows ?? []).map((row) => ({
        label: componentLabel(row.salary_component),
        amount: row.amount ?? 0,
      }));
    return {
      name: slip.name,
      postingDate: slip.posting_date ?? null,
      startDate: slip.start_date ?? null,
      endDate: slip.end_date ?? null,
      grossPay: slip.gross_pay ?? null,
      netPay: slip.net_pay ?? null,
      status: slip.status ?? null,
      earnings: toComponents(slip.earnings),
      deductions: toComponents(slip.deductions),
      totalDeduction: slip.total_deduction ?? null,
    };
  }

  async getMyLeaveApplications(
    userId: string,
  ): Promise<MyLeaveApplicationsResponse> {
    const employeeId = await this.getBoundEmployeeId(userId);
    if (!employeeId) return { items: [] };
    const rows = await this.frappe
      .list<FrappeLeaveApplicationRowRaw>('Leave Application', {
        fields: [
          'name',
          'leave_type',
          'from_date',
          'to_date',
          'total_leave_days',
          'status',
          'description',
        ],
        filters: [['employee', '=', employeeId]],
        orderBy: 'from_date desc',
      })
      .catch(() => [] as FrappeLeaveApplicationRowRaw[]);
    const items: LeaveApplicationRecord[] = rows
      .slice()
      .sort(
        (a: FrappeLeaveApplicationRowRaw, b: FrappeLeaveApplicationRowRaw) =>
          (b.from_date ?? '').localeCompare(a.from_date ?? ''),
      )
      .map((row: FrappeLeaveApplicationRowRaw) => ({
        name: row.name,
        leaveType: row.leave_type ?? null,
        fromDate: row.from_date ?? null,
        toDate: row.to_date ?? null,
        totalDays: row.total_leave_days ?? null,
        status: row.status ?? null,
        reason: row.description ?? null,
      }));
    return { items };
  }
}

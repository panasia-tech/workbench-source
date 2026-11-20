import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type {
  ErpAdminPeriodStats,
  ErpCommissionStats,
  ErpDashboardSummary,
  ErpMe,
  ErpPayslip,
  ErpRecentActivity,
  ErpWorkloadStats,
} from '@shared/api.interface';

/**
 * ERP 业务数据（工作 tab 原生工作台 / 工资单 / 管理端经营统计）。
 * 走工作台服务端 /api/erp-api/*：那里校验 ERP 身份 + 绑定本人后代持员工 JWT 调 ERP，
 * 员工 JWT 不下发浏览器。
 */
export async function fetchErpMe(): Promise<ErpMe> {
  try {
    const response = await axiosForBackend({
      url: '/api/erp-api/me',
      method: 'GET',
    });
    return response.data as ErpMe;
  } catch (error) {
    logger.error('获取 ERP 员工信息失败', error);
    throw error;
  }
}

export async function fetchErpSummary(): Promise<ErpDashboardSummary> {
  try {
    const response = await axiosForBackend({
      url: '/api/erp-api/dashboard/summary',
      method: 'GET',
    });
    return response.data as ErpDashboardSummary;
  } catch (error) {
    logger.error('获取 ERP 今日概览失败', error);
    throw error;
  }
}

export async function fetchErpWorkload(): Promise<ErpWorkloadStats> {
  try {
    const response = await axiosForBackend({
      url: '/api/erp-api/dashboard/workload',
      method: 'GET',
    });
    return response.data as ErpWorkloadStats;
  } catch (error) {
    logger.error('获取 ERP 工作量统计失败', error);
    throw error;
  }
}

export async function fetchErpCommission(
  period = 'today',
): Promise<ErpCommissionStats> {
  try {
    const response = await axiosForBackend({
      url: `/api/erp-api/dashboard/commission?period=${encodeURIComponent(period)}`,
      method: 'GET',
    });
    return response.data as ErpCommissionStats;
  } catch (error) {
    logger.error('获取 ERP 提成统计失败', error);
    throw error;
  }
}

export async function fetchErpPayslip(
  dateFrom: string,
  dateTo: string,
): Promise<ErpPayslip> {
  try {
    const response = await axiosForBackend({
      url: `/api/erp-api/dashboard/payslip?date_from=${encodeURIComponent(
        dateFrom,
      )}&date_to=${encodeURIComponent(dateTo)}`,
      method: 'GET',
    });
    return response.data as ErpPayslip;
  } catch (error) {
    logger.error('获取 ERP 工资单失败', error);
    throw error;
  }
}

export async function fetchErpAdminStats(
  period = 'today',
): Promise<ErpAdminPeriodStats> {
  try {
    const response = await axiosForBackend({
      url: `/api/erp-api/dashboard/admin-stats?period=${encodeURIComponent(period)}`,
      method: 'GET',
    });
    return response.data as ErpAdminPeriodStats;
  } catch (error) {
    logger.error('获取 ERP 经营统计失败', error);
    throw error;
  }
}

export async function fetchErpActivities(
  offset = 0,
  limit = 20,
): Promise<ErpRecentActivity[]> {
  try {
    const response = await axiosForBackend({
      url: `/api/erp-api/dashboard/activities?offset=${offset}&limit=${limit}`,
      method: 'GET',
    });
    return response.data as ErpRecentActivity[];
  } catch (error) {
    logger.error('获取 ERP 业务动态失败', error);
    throw error;
  }
}

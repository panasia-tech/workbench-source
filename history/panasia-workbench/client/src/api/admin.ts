import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { isAxiosError } from 'axios';

import type {
  AdminCatalogDeleteResponse,
  AdminWorkOrderDeleteResponse,
  AdminWorkOrderDraftsResponse,
  AdminWorkOrderPublishResponse,
  AdminWorkOrderQueueResponse,
  AdminCatalogUpsertRequest,
  AdminConfigResponse,
  AdminEmployeeBindingsResponse,
  AdminExecuteResponse,
  AdminOverviewResponse,
  QuickTaskCreateRequest,
  QuickTaskCreateResponse,
  QuickTaskDraftResponse,
  TaskTemplateGenerateResponse,
  TaskTemplateSummary,
  TaskTemplateUpsertRequest,
  UpdateConfigResponse,
  UpdateSystemConfigRequest,
  WorkOrderCatalogItem,
  WorkOrderCatalogResponse,
  TutorialReviewListResponse,
  TutorialReviewVerdictRequest,
  TutorialReviewVerdictResponse,
  AdminPerformanceEmployeeListResponse,
  AdminPerformanceDetailResponse,
  AdminOkrListResponse,
  OkrObjectiveCreateRequest,
  OkrObjectivePatchRequest,
  OkrKeyResultCreateRequest,
  OkrKeyResultPatchRequest,
  OkrMutationResponse,
  AdminAuditLogListResponse,
  AdminTaskCoordinationResponse,
  AdminEmployeeBindingUpsertRequest,
  AdminEmployeeBindingUpsertResponse,
  BindingOptionsResponse,
  TutorialAuthoringCreateRequest,
  TutorialAuthoringCreateResponse,
  TutorialAuthoringListResponse,
  AdminExecuteMembersResponse,
  AdminMemberDetailResponse,
  AdminDayActivityResponse,
  BlockDeferReviewResponse,
  BlockDeferVerdictRequest,
  TutorialSkipStatus,
  TutorialSkipReviewItem,
  TutorialSkipReviewListResponse,
  TutorialSkipVerdictRequest,
  TutorialCaseAdminItem,
  TutorialCaseAdminListResponse,
  TutorialCaseAssignRequest,
  HostedCustomerDimension,
  HostedCustomerStatus,
  HostedCustomerInfo,
  HostedCustomerListResponse,
  CreateHostedCustomerRequest,
  UpdateHostedCustomerRequest,
} from '@shared/api.interface';

/** 403 等 HTTP 错误统一转成可读文案（管理端 API 层统一拦截） */
function normalizeAdminError(error: unknown, fallback: string): Error {
  if (isAxiosError(error)) {
    if (error.response?.status === 403) {
      return new Error('无操作权限，请联系管理员分配角色');
    }
    const data = error.response?.data as { message?: unknown } | undefined;
    if (typeof data?.message === 'string' && data.message) {
      return new Error(data.message);
    }
  }
  if (error instanceof Error && error.message) return error;
  return new Error(fallback);
}

export async function getOverview(): Promise<AdminOverviewResponse> {
  try {
    const response = await axiosForBackend.get<AdminOverviewResponse>(
      '/api/admin/overview',
    );
    return response.data;
  } catch (error) {
    logger.error('获取管理端总览失败', error);
    throw normalizeAdminError(error, '获取总览数据失败');
  }
}

export async function getExecute(): Promise<AdminExecuteResponse> {
  try {
    const response = await axiosForBackend.get<AdminExecuteResponse>(
      '/api/admin/execute',
    );
    return response.data;
  } catch (error) {
    logger.error('获取管理端执行数据失败', error);
    throw normalizeAdminError(error, '获取执行数据失败');
  }
}

export async function createQuickTask(
  body: QuickTaskCreateRequest,
): Promise<QuickTaskCreateResponse> {
  try {
    const response = await axiosForBackend.post<QuickTaskCreateResponse>(
      '/api/admin/quick-task',
      body,
    );
    return response.data;
  } catch (error) {
    logger.error('快速创建任务失败', error);
    throw normalizeAdminError(error, '创建任务失败');
  }
}

export async function generateQuickTaskDraft(
  input: string,
): Promise<QuickTaskDraftResponse> {
  try {
    const response = await axiosForBackend.post<QuickTaskDraftResponse>(
      '/api/admin/quick-task/draft',
      { input },
    );
    return response.data;
  } catch (error) {
    logger.error('AI 草稿生成失败', error);
    throw normalizeAdminError(error, 'AI 草稿生成失败');
  }
}

export async function getAdminConfig(): Promise<AdminConfigResponse> {
  try {
    const response = await axiosForBackend.get<AdminConfigResponse>(
      '/api/admin/config',
    );
    return response.data;
  } catch (error) {
    logger.error('获取系统配置失败', error);
    throw normalizeAdminError(error, '获取系统配置失败');
  }
}

export async function updateAdminConfig(
  body: UpdateSystemConfigRequest,
): Promise<UpdateConfigResponse> {
  try {
    const response = await axiosForBackend.put<UpdateConfigResponse>(
      '/api/admin/config',
      body,
    );
    return response.data;
  } catch (error) {
    logger.error('更新系统配置失败', error);
    throw normalizeAdminError(error, '保存配置失败');
  }
}

export async function getAdminCatalog(): Promise<WorkOrderCatalogResponse> {
  try {
    const response = await axiosForBackend.get<WorkOrderCatalogResponse>(
      '/api/admin/catalog',
    );
    return response.data;
  } catch (error) {
    logger.error('获取工单目录失败', error);
    throw normalizeAdminError(error, '获取工单目录失败');
  }
}

export async function createAdminCatalog(
  body: AdminCatalogUpsertRequest,
): Promise<WorkOrderCatalogItem> {
  try {
    const response = await axiosForBackend.post<WorkOrderCatalogItem>(
      '/api/admin/catalog',
      body,
    );
    return response.data;
  } catch (error) {
    logger.error('新建工单目录失败', error);
    throw normalizeAdminError(error, '新建目录失败');
  }
}

export async function updateAdminCatalog(
  id: string,
  body: Partial<AdminCatalogUpsertRequest>,
): Promise<WorkOrderCatalogItem> {
  try {
    const response = await axiosForBackend.patch<WorkOrderCatalogItem>(
      `/api/admin/catalog/${id}`,
      body,
    );
    return response.data;
  } catch (error) {
    logger.error('更新工单目录失败', error);
    throw normalizeAdminError(error, '保存目录失败');
  }
}

export async function deleteAdminCatalog(
  id: string,
): Promise<AdminCatalogDeleteResponse> {
  try {
    const response = await axiosForBackend.delete<AdminCatalogDeleteResponse>(
      `/api/admin/catalog/${id}`,
    );
    return response.data;
  } catch (error) {
    logger.error('删除工单目录失败', error);
    throw normalizeAdminError(error, '删除目录失败');
  }
}

export async function listAdminWorkOrderDrafts(): Promise<AdminWorkOrderDraftsResponse> {
  try {
    const response = await axiosForBackend.get<AdminWorkOrderDraftsResponse>(
      '/api/admin/work-orders/drafts',
    );
    return response.data;
  } catch (error) {
    logger.error('获取草稿箱工单失败', error);
    throw normalizeAdminError(error, '获取草稿箱失败');
  }
}

export async function publishAdminWorkOrderDraft(
  id: string,
): Promise<AdminWorkOrderPublishResponse> {
  try {
    const response = await axiosForBackend.post<AdminWorkOrderPublishResponse>(
      `/api/admin/work-orders/${id}/publish`,
    );
    return response.data;
  } catch (error) {
    logger.error('发布草稿工单失败', error);
    throw normalizeAdminError(error, '发布工单失败');
  }
}

export async function deleteAdminWorkOrderDraft(
  id: string,
): Promise<AdminWorkOrderDeleteResponse> {
  try {
    const response = await axiosForBackend.delete<AdminWorkOrderDeleteResponse>(
      `/api/admin/work-orders/${id}`,
    );
    return response.data;
  } catch (error) {
    logger.error('删除草稿工单失败', error);
    throw normalizeAdminError(error, '删除草稿失败');
  }
}

export async function listAdminWorkOrderQueue(): Promise<AdminWorkOrderQueueResponse> {
  try {
    const response = await axiosForBackend.get<AdminWorkOrderQueueResponse>(
      '/api/admin/work-orders/queue',
    );
    return response.data;
  } catch (error) {
    logger.error('获取工单队列失败', error);
    throw normalizeAdminError(error, '获取工单队列失败');
  }
}

export async function getAdminEmployees(): Promise<AdminEmployeeBindingsResponse> {
  try {
    const response = await axiosForBackend.get<AdminEmployeeBindingsResponse>(
      '/api/admin/employees',
    );
    return response.data;
  } catch (error) {
    logger.error('获取员工绑定列表失败', error);
    throw normalizeAdminError(error, '获取员工绑定失败');
  }
}

export async function listTaskTemplates(): Promise<TaskTemplateSummary[]> {
  try {
    const response = await axiosForBackend.get<TaskTemplateSummary[]>(
      '/api/admin/task-templates',
    );
    return response.data;
  } catch (error) {
    logger.error('获取任务模板列表失败', error);
    throw normalizeAdminError(error, '获取任务模板失败');
  }
}

export async function createTaskTemplate(
  body: TaskTemplateUpsertRequest,
): Promise<TaskTemplateSummary> {
  try {
    const response = await axiosForBackend.post<TaskTemplateSummary>(
      '/api/admin/task-templates',
      body,
    );
    return response.data;
  } catch (error) {
    logger.error('新建任务模板失败', error);
    throw normalizeAdminError(error, '新建模板失败');
  }
}

export async function updateTaskTemplate(
  id: string,
  body: TaskTemplateUpsertRequest,
): Promise<TaskTemplateSummary> {
  try {
    const response = await axiosForBackend.patch<TaskTemplateSummary>(
      `/api/admin/task-templates/${id}`,
      body,
    );
    return response.data;
  } catch (error) {
    logger.error('更新任务模板失败', error);
    throw normalizeAdminError(error, '保存模板失败');
  }
}

export async function deleteTaskTemplate(
  id: string,
): Promise<{ ok: boolean }> {
  try {
    const response = await axiosForBackend.delete<{ ok: boolean }>(
      `/api/admin/task-templates/${id}`,
    );
    return response.data;
  } catch (error) {
    logger.error('删除任务模板失败', error);
    throw normalizeAdminError(error, '删除模板失败');
  }
}

export async function generateTodayTemplates(): Promise<TaskTemplateGenerateResponse> {
  try {
    const response = await axiosForBackend.post<TaskTemplateGenerateResponse>(
      '/api/admin/task-templates/generate',
    );
    return response.data;
  } catch (error) {
    logger.error('生成今日任务失败', error);
    throw normalizeAdminError(error, '生成今日任务失败');
  }
}

// ===== 管理端 · 教程审核 =====

export async function fetchTutorialReviewQueue(): Promise<TutorialReviewListResponse> {
  try {
    const response = await axiosForBackend.get<TutorialReviewListResponse>(
      '/api/admin/tutorial-review/pending',
    );
    return response.data;
  } catch (error) {
    logger.error('获取教程待审队列失败', error);
    throw normalizeAdminError(error, '获取教程待审队列失败');
  }
}

export async function submitTutorialReviewVerdict(
  submissionId: number,
  request: TutorialReviewVerdictRequest,
): Promise<TutorialReviewVerdictResponse> {
  try {
    const response = await axiosForBackend.post<TutorialReviewVerdictResponse>(
      `/api/admin/tutorial-review/${submissionId}/verdict`,
      request,
    );
    return response.data;
  } catch (error) {
    logger.error('提交教程审核结论失败', error);
    throw normalizeAdminError(error, '提交教程审核结论失败');
  }
}

// ===== 管理端 · HR 绩效看板 =====

export async function fetchAdminPerformanceEmployees(): Promise<AdminPerformanceEmployeeListResponse> {
  try {
    const response =
      await axiosForBackend.get<AdminPerformanceEmployeeListResponse>(
        '/api/admin/performance/employees',
      );
    return response.data;
  } catch (error) {
    logger.error('获取员工绩效列表失败', error);
    throw normalizeAdminError(error, '获取员工绩效列表失败');
  }
}

export async function fetchAdminPerformanceDetail(
  userId: string,
): Promise<AdminPerformanceDetailResponse> {
  try {
    const response = await axiosForBackend.get<AdminPerformanceDetailResponse>(
      `/api/admin/performance/employees/${userId}`,
    );
    return response.data;
  } catch (error) {
    logger.error('获取员工绩效详情失败', error);
    throw normalizeAdminError(error, '获取员工绩效详情失败');
  }
}

// ===== 管理端 · OKR =====

export async function fetchAdminOkr(): Promise<AdminOkrListResponse> {
  try {
    const response = await axiosForBackend.get<AdminOkrListResponse>(
      '/api/admin/okr',
    );
    return response.data;
  } catch (error) {
    logger.error('获取 OKR 列表失败', error);
    throw normalizeAdminError(error, '获取 OKR 列表失败');
  }
}

export async function createOkrObjective(
  request: OkrObjectiveCreateRequest,
): Promise<OkrMutationResponse> {
  try {
    const response = await axiosForBackend.post<OkrMutationResponse>(
      '/api/admin/okr/objectives',
      request,
    );
    return response.data;
  } catch (error) {
    logger.error('创建 OKR 目标失败', error);
    throw normalizeAdminError(error, '创建 OKR 目标失败');
  }
}

export async function patchOkrObjective(
  objectiveId: string,
  request: OkrObjectivePatchRequest,
): Promise<OkrMutationResponse> {
  try {
    const response = await axiosForBackend.patch<OkrMutationResponse>(
      `/api/admin/okr/objectives/${objectiveId}`,
      request,
    );
    return response.data;
  } catch (error) {
    logger.error('更新 OKR 目标失败', error);
    throw normalizeAdminError(error, '更新 OKR 目标失败');
  }
}

export async function deleteOkrObjective(objectiveId: string): Promise<void> {
  try {
    await axiosForBackend.delete(`/api/admin/okr/objectives/${objectiveId}`);
  } catch (error) {
    logger.error('删除 OKR 目标失败', error);
    throw normalizeAdminError(error, '删除 OKR 目标失败');
  }
}

export async function createOkrKeyResult(
  objectiveId: string,
  request: OkrKeyResultCreateRequest,
): Promise<OkrMutationResponse> {
  try {
    const response = await axiosForBackend.post<OkrMutationResponse>(
      `/api/admin/okr/objectives/${objectiveId}/key-results`,
      request,
      );
    return response.data;
  } catch (error) {
    logger.error('创建关键结果失败', error);
    throw normalizeAdminError(error, '创建关键结果失败');
  }
}

export async function patchOkrKeyResult(
  keyResultId: string,
  request: OkrKeyResultPatchRequest,
): Promise<OkrMutationResponse> {
  try {
    const response = await axiosForBackend.patch<OkrMutationResponse>(
      `/api/admin/okr/key-results/${keyResultId}`,
      request,
    );
    return response.data;
  } catch (error) {
    logger.error('更新关键结果失败', error);
    throw normalizeAdminError(error, '更新关键结果失败');
  }
}

export async function deleteOkrKeyResult(keyResultId: string): Promise<void> {
  try {
    await axiosForBackend.delete(`/api/admin/okr/key-results/${keyResultId}`);
  } catch (error) {
    logger.error('删除关键结果失败', error);
    throw normalizeAdminError(error, '删除关键结果失败');
  }
}

// ===== 管理端 · 审计日志 =====

export async function fetchAdminAuditLogs(
  page: number,
  pageSize: number,
): Promise<AdminAuditLogListResponse> {
  try {
    const response = await axiosForBackend.get<AdminAuditLogListResponse>(
      `/api/admin/audit-logs?page=${page}&pageSize=${pageSize}`,
    );
    return response.data;
  } catch (error) {
    logger.error('获取审计日志失败', error);
    throw normalizeAdminError(error, '获取审计日志失败');
  }
}

// ===== 管理端 · 任务统筹 =====

export async function fetchTaskCoordination(): Promise<AdminTaskCoordinationResponse> {
  try {
    const response = await axiosForBackend.get<AdminTaskCoordinationResponse>(
      '/api/admin/tasks/coordination',
    );
    return response.data;
  } catch (error) {
    logger.error('获取任务统筹数据失败', error);
    throw normalizeAdminError(error, '获取任务统筹数据失败');
  }
}

// ===== 管理端 · 员工绑定管理 =====

export async function fetchAdminBindingOptions(): Promise<BindingOptionsResponse> {
  try {
    const response = await axiosForBackend.get<BindingOptionsResponse>(
      '/api/admin/employees/options',
    );
    return response.data;
  } catch (error) {
    logger.error('获取绑定选项失败', error);
    throw normalizeAdminError(error, '获取绑定选项失败');
  }
}

export async function upsertEmployeeBinding(
  request: AdminEmployeeBindingUpsertRequest,
): Promise<AdminEmployeeBindingUpsertResponse> {
  try {
    const response = await axiosForBackend.post<AdminEmployeeBindingUpsertResponse>(
      '/api/admin/employees/binding',
      request,
    );
    return response.data;
  } catch (error) {
    logger.error('保存员工绑定失败', error);
    throw normalizeAdminError(error, '保存员工绑定失败');
  }
}

// ===== 管理端 · 执行 Dock 员工槽位与详情四视图 =====

export async function fetchAdminExecuteMembers(): Promise<AdminExecuteMembersResponse> {
  try {
    const response = await axiosForBackend.get<AdminExecuteMembersResponse>(
      '/api/admin/tasks/execute-members',
    );
    return response.data;
  } catch (error) {
    logger.error('获取员工槽位列表失败', error);
    throw normalizeAdminError(error, '获取员工槽位列表失败');
  }
}

export async function fetchAdminMemberDetail(
  userId: string,
): Promise<AdminMemberDetailResponse> {
  try {
    const response = await axiosForBackend.get<AdminMemberDetailResponse>(
      `/api/admin/tasks/execute-members/${encodeURIComponent(userId)}`,
    );
    return response.data;
  } catch (error) {
    logger.error('获取员工详情失败', error);
    throw normalizeAdminError(error, '获取员工详情失败');
  }
}

/** 按日期看：date=YYYY-MM-DD，当天每人完成 / 截止 / 提交堵塞的任务 */
export async function fetchAdminDayActivity(
  date: string,
): Promise<AdminDayActivityResponse> {
  try {
    const response = await axiosForBackend.get<AdminDayActivityResponse>(
      `/api/admin/tasks/day-activity?date=${encodeURIComponent(date)}`,
    );
    return response.data;
  } catch (error) {
    logger.error('获取按日期看数据失败', error);
    throw normalizeAdminError(error, '获取按日期看数据失败');
  }
}

// ===== 管理端 · 堵塞顺延审核 =====

export async function fetchBlockDeferReviews(): Promise<BlockDeferReviewResponse> {
  try {
    const response = await axiosForBackend.get<BlockDeferReviewResponse>(
      '/api/admin/tasks/block-defers',
    );
    return response.data;
  } catch (error) {
    logger.error('获取顺延审核列表失败', error);
    throw normalizeAdminError(error, '获取顺延审核列表失败');
  }
}

export async function submitBlockDeferVerdict(
  id: string,
  request: BlockDeferVerdictRequest,
): Promise<BlockDeferReviewResponse> {
  try {
    const response = await axiosForBackend.post<BlockDeferReviewResponse>(
      `/api/admin/tasks/block-defers/${encodeURIComponent(id)}/verdict`,
      request,
    );
    return response.data;
  } catch (error) {
    logger.error('提交顺延终审失败', error);
    throw normalizeAdminError(error, '提交顺延终审失败');
  }
}

// ===== 管理端 · 教程模板配置 =====

export async function fetchTutorialAuthoringList(): Promise<TutorialAuthoringListResponse> {
  try {
    const response = await axiosForBackend.get<TutorialAuthoringListResponse>(
      '/api/admin/tutorial-authoring',
    );
    return response.data;
  } catch (error) {
    logger.error('获取教程模板列表失败', error);
    throw normalizeAdminError(error, '获取教程模板列表失败');
  }
}

export async function createTutorialProject(
  request: TutorialAuthoringCreateRequest,
): Promise<TutorialAuthoringCreateResponse> {
  try {
    const response = await axiosForBackend.post<TutorialAuthoringCreateResponse>(
      '/api/admin/tutorial-authoring',
      request,
    );
    return response.data;
  } catch (error) {
    logger.error('创建教程失败', error);
    throw normalizeAdminError(error, '创建教程失败');
  }
}

// ===== 管理端 · 给员工分配教程 =====

export async function fetchTutorialCases(
  lmsCourse?: string,
): Promise<TutorialCaseAdminListResponse> {
  try {
    const query = lmsCourse ? `?lmsCourse=${encodeURIComponent(lmsCourse)}` : '';
    const response = await axiosForBackend.get<TutorialCaseAdminListResponse>(
      `/api/admin/tutorial-cases${query}`,
    );
    return response.data;
  } catch (error) {
    logger.error('获取教程分配列表失败', error);
    throw normalizeAdminError(error, '获取教程分配列表失败');
  }
}

export async function assignTutorialCase(
  request: TutorialCaseAssignRequest,
): Promise<TutorialCaseAdminItem> {
  try {
    const response = await axiosForBackend.post<TutorialCaseAdminItem>(
      '/api/admin/tutorial-cases',
      request,
    );
    return response.data;
  } catch (error) {
    logger.error('分配教程失败', error);
    throw normalizeAdminError(error, '分配教程失败');
  }
}

export async function cancelTutorialCase(
  caseId: number,
): Promise<TutorialCaseAdminItem> {
  try {
    const response = await axiosForBackend.post<TutorialCaseAdminItem>(
      `/api/admin/tutorial-cases/${caseId}/cancel`,
    );
    return response.data;
  } catch (error) {
    logger.error('取消教程案例失败', error);
    throw normalizeAdminError(error, '取消教程案例失败');
  }
}

// ===== 管理端 · 教程跳过审核 =====

export async function fetchTutorialSkipReviews(
  status?: TutorialSkipStatus,
): Promise<TutorialSkipReviewListResponse> {
  try {
    const query =
      status !== undefined ? `?status=${encodeURIComponent(status)}` : '';
    const response = await axiosForBackend.get<TutorialSkipReviewListResponse>(
      `/api/admin/tutorial-skips${query}`,
    );
    return response.data;
  } catch (error) {
    logger.error('获取教程跳过审核列表失败', error);
    throw normalizeAdminError(error, '获取跳过审核列表失败');
  }
}

export async function submitTutorialSkipVerdict(
  id: string,
  request: TutorialSkipVerdictRequest,
): Promise<TutorialSkipReviewItem> {
  try {
    const response = await axiosForBackend.post<TutorialSkipReviewItem>(
      `/api/admin/tutorial-skips/${encodeURIComponent(id)}/verdict`,
      request,
    );
    return response.data;
  } catch (error) {
    logger.error('提交教程跳过审核结论失败', error);
    throw normalizeAdminError(error, '提交跳过审核结论失败');
  }
}

// ===== 管理端 · 托管客户档案 =====

export interface HostedCustomerQueryParams {
  dimension?: HostedCustomerDimension;
  status?: HostedCustomerStatus;
}

export async function fetchAdminHostedCustomers(
  params?: HostedCustomerQueryParams,
): Promise<HostedCustomerListResponse> {
  try {
    const search = new URLSearchParams();
    if (params?.dimension) search.set('dimension', params.dimension);
    if (params?.status) search.set('status', params.status);
    const query = search.toString();
    const response = await axiosForBackend.get<HostedCustomerListResponse>(
      `/api/admin/hosted-customers${query !== '' ? `?${query}` : ''}`,
    );
    return response.data;
  } catch (error) {
    logger.error('获取托管客户档案列表失败', error);
    throw normalizeAdminError(error, '获取托管客户档案失败');
  }
}

export async function createAdminHostedCustomer(
  data: CreateHostedCustomerRequest,
): Promise<HostedCustomerInfo> {
  try {
    const response = await axiosForBackend.post<HostedCustomerInfo>(
      '/api/admin/hosted-customers',
      data,
    );
    return response.data;
  } catch (error) {
    logger.error('新建托管客户档案失败', error);
    throw normalizeAdminError(error, '新建托管客户档案失败');
  }
}

export async function updateAdminHostedCustomer(
  id: string,
  data: UpdateHostedCustomerRequest,
): Promise<HostedCustomerInfo> {
  try {
    const response = await axiosForBackend.patch<HostedCustomerInfo>(
      `/api/admin/hosted-customers/${encodeURIComponent(id)}`,
      data,
    );
    return response.data;
  } catch (error) {
    logger.error('更新托管客户档案失败', error);
    throw normalizeAdminError(error, '保存托管客户档案失败');
  }
}

export async function deleteAdminHostedCustomer(id: string): Promise<void> {
  try {
    await axiosForBackend.delete(
      `/api/admin/hosted-customers/${encodeURIComponent(id)}`,
    );
  } catch (error) {
    logger.error('删除托管客户档案失败', error);
    throw normalizeAdminError(error, '删除托管客户档案失败');
  }
}

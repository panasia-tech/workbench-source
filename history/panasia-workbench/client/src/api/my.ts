import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type {
  AccountCenterResponse,
  BindingOptionsResponse,
  CreateHostedCustomerRequest,
  EmployeeBinding,
  HostedCustomerDimension,
  HostedCustomerInfo,
  HostedCustomerListResponse,
  MyAttendance,
  MyTutorialSkipListResponse,
  MyContract,
  MyLeaveApplicationsResponse,
  MyLearning,
  MyLearningVideos,
  MyOverview,
  MySalary,
  MySalarySlipsResponse,
  SalarySlipDetail,
  SubmitTutorialSkipRequest,
  SubmitTutorialStepRequest,
  SubmitTutorialStepResponse,
  TutorialCaseDetail,
  TutorialSkipRequestInfo,
  UpdateAccountProfileRequest,
  UpdateAccountProfileResponse,
  UpdateBindingRequest,
  UpdateHostedCustomerRequest,
} from '@shared/api.interface';

export async function fetchMyOverview(): Promise<MyOverview> {
  try {
    const response = await axiosForBackend({
      url: '/api/my',
      method: 'GET',
    });
    return response.data as MyOverview;
  } catch (error) {
    logger.error('获取我的信息失败', error);
    throw error;
  }
}

export async function fetchBindingOptions(): Promise<BindingOptionsResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/my/binding-options',
      method: 'GET',
    });
    return response.data as BindingOptionsResponse;
  } catch (error) {
    logger.error('获取绑定选项失败', error);
    throw error;
  }
}

export async function updateMyBinding(
  body: UpdateBindingRequest,
): Promise<EmployeeBinding> {
  try {
    const response = await axiosForBackend({
      url: '/api/my/binding',
      method: 'PUT',
      data: body,
    });
    return response.data as EmployeeBinding;
  } catch (error) {
    logger.error('保存员工绑定失败', error);
    throw error;
  }
}

export async function fetchMySalary(): Promise<MySalary> {
  try {
    const response = await axiosForBackend({
      url: '/api/my/salary',
      method: 'GET',
    });
    return response.data as MySalary;
  } catch (error) {
    logger.error('获取预计薪资失败', error);
    throw error;
  }
}

export async function fetchMyContract(): Promise<MyContract> {
  try {
    const response = await axiosForBackend({
      url: '/api/my/contract',
      method: 'GET',
    });
    return response.data as MyContract;
  } catch (error) {
    logger.error('获取合同信息失败', error);
    throw error;
  }
}

export async function fetchMyAttendance(): Promise<MyAttendance> {
  try {
    const response = await axiosForBackend({
      url: '/api/my/attendance',
      method: 'GET',
    });
    return response.data as MyAttendance;
  } catch (error) {
    logger.error('获取考勤数据失败', error);
    throw error;
  }
}

export async function fetchMyLearning(): Promise<MyLearning> {
  try {
    const response = await axiosForBackend({
      url: '/api/my/learning',
      method: 'GET',
    });
    return response.data as MyLearning;
  } catch (error) {
    logger.error('获取学习数据失败', error);
    throw error;
  }
}

export async function fetchMyLearningVideos(): Promise<MyLearningVideos> {
  try {
    const response = await axiosForBackend({
      url: '/api/my/learning/videos',
      method: 'GET',
    });
    return response.data as MyLearningVideos;
  } catch (error) {
    logger.error('获取培训视频失败', error);
    throw error;
  }
}

export async function fetchTutorialCase(
  caseId: number,
): Promise<TutorialCaseDetail> {
  try {
    const response = await axiosForBackend({
      url: `/api/my/learning/case/${caseId}`,
      method: 'GET',
    });
    return response.data as TutorialCaseDetail;
  } catch (error) {
    logger.error('获取教程案例详情失败', error);
    throw error;
  }
}

/** stepId 是 Learning 课时的步骤编号（pa_step_key，短串） */
export async function submitTutorialStep(
  caseId: number,
  stepId: string,
  body: SubmitTutorialStepRequest,
): Promise<SubmitTutorialStepResponse> {
  try {
    const response = await axiosForBackend({
      url: `/api/my/learning/case/${caseId}/steps/${encodeURIComponent(stepId)}/submit`,
      method: 'POST',
      data: body,
    });
    return response.data as SubmitTutorialStepResponse;
  } catch (error) {
    logger.error('提交教程步骤失败', error);
    throw error;
  }
}

export async function submitTutorialSkipRequest(
  caseId: number,
  stepId: string,
  reason: string,
): Promise<TutorialSkipRequestInfo> {
  try {
    const response = await axiosForBackend({
      url: `/api/my/learning/case/${caseId}/steps/${encodeURIComponent(stepId)}/skip-request`,
      method: 'POST',
      data: { reason } satisfies SubmitTutorialSkipRequest,
    });
    return response.data as TutorialSkipRequestInfo;
  } catch (error) {
    logger.error('提交跳过申请失败', error);
    throw error;
  }
}

export async function fetchMyTutorialSkipRequests(): Promise<MyTutorialSkipListResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/my/learning/skip-requests',
      method: 'GET',
    });
    return response.data as MyTutorialSkipListResponse;
  } catch (error) {
    logger.error('获取跳过申请列表失败', error);
    throw error;
  }
}

export async function fetchHostedCustomers(
  dimension?: HostedCustomerDimension,
): Promise<HostedCustomerListResponse> {
  try {
    const response = await axiosForBackend({
      url: `/api/my/hosted-customers${
        dimension ? `?dimension=${encodeURIComponent(dimension)}` : ''
      }`,
      method: 'GET',
    });
    return response.data as HostedCustomerListResponse;
  } catch (error) {
    logger.error('获取托管客户档案失败', error);
    throw error;
  }
}

export async function createHostedCustomer(
  body: CreateHostedCustomerRequest,
): Promise<HostedCustomerInfo> {
  try {
    const response = await axiosForBackend({
      url: '/api/my/hosted-customers',
      method: 'POST',
      data: body,
    });
    return response.data as HostedCustomerInfo;
  } catch (error) {
    logger.error('新建托管客户档案失败', error);
    throw error;
  }
}

export async function updateHostedCustomer(
  id: string,
  body: UpdateHostedCustomerRequest,
): Promise<HostedCustomerInfo> {
  try {
    const response = await axiosForBackend({
      url: `/api/my/hosted-customers/${encodeURIComponent(id)}`,
      method: 'PATCH',
      data: body,
    });
    return response.data as HostedCustomerInfo;
  } catch (error) {
    logger.error('保存托管客户档案失败', error);
    throw error;
  }
}

export async function fetchMySalarySlips(): Promise<MySalarySlipsResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/my/salary-slips',
      method: 'GET',
    });
    return response.data as MySalarySlipsResponse;
  } catch (error) {
    logger.error('获取工资单失败', error);
    throw error;
  }
}

export async function fetchMySalarySlipDetail(
  name: string,
): Promise<SalarySlipDetail> {
  try {
    const response = await axiosForBackend({
      url: `/api/my/salary-slips/${encodeURIComponent(name)}`,
      method: 'GET',
    });
    return response.data as SalarySlipDetail;
  } catch (error) {
    logger.error('获取工资单明细失败', error);
    throw error;
  }
}

export async function fetchMyLeaveApplications(): Promise<MyLeaveApplicationsResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/my/leave-applications',
      method: 'GET',
    });
    return response.data as MyLeaveApplicationsResponse;
  } catch (error) {
    logger.error('获取请假记录失败', error);
    throw error;
  }
}

export async function fetchAccountCenter(): Promise<AccountCenterResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/my/account',
      method: 'GET',
    });
    return response.data as AccountCenterResponse;
  } catch (error) {
    logger.error('获取账户中心信息失败', error);
    throw error;
  }
}

export async function updateAccountProfile(
  body: UpdateAccountProfileRequest,
): Promise<UpdateAccountProfileResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/my/account',
      method: 'PUT',
      data: body,
    });
    return response.data as UpdateAccountProfileResponse;
  } catch (error) {
    logger.error('保存账户资料失败', error);
    throw error;
  }
}

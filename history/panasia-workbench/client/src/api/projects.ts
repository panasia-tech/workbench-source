import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type {
  MyProjectsResponse,
  ProjectDetail,
} from '@shared/api.interface';

export async function fetchMyProjects(): Promise<MyProjectsResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/projects',
      method: 'GET',
    });
    return response.data as MyProjectsResponse;
  } catch (error) {
    logger.error('获取项目列表失败', error);
    throw error;
  }
}

export async function fetchProjectDetail(
  projectId: string,
): Promise<ProjectDetail> {
  try {
    const response = await axiosForBackend({
      url: `/api/projects/${projectId}`,
      method: 'GET',
    });
    return response.data as ProjectDetail;
  } catch (error) {
    logger.error('获取项目详情失败', error);
    throw error;
  }
}

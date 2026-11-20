import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { logger } from '@lark-apaas/client-toolkit/logger';

import type { WorkbenchUploadResult } from '@shared/api.interface';

interface WorkbenchUploadResponse {
  url?: string;
  name?: string;
  size?: number;
  error?: string;
}

/** 上传一个文件：传给工作台服务端，服务端带口令转给文件网关（wb-files），返回公开下载地址 */
export async function uploadToWorkbench(file: File): Promise<WorkbenchUploadResult> {
  const form = new FormData();
  form.append('file', file);
  try {
    const response = await axiosForBackend({
      url: '/api/files/upload',
      method: 'POST',
      data: form,
      timeout: 300000,
    });
    const data = response.data as WorkbenchUploadResponse;
    if (!data.url) throw new Error(data.error ?? '响应缺少 url');
    return { url: data.url, name: data.name ?? file.name, size: data.size ?? file.size };
  } catch (error) {
    logger.error('文件上传失败', { file: file.name, error });
    throw error;
  }
}

export async function uploadFileToWorkbench(file: File): Promise<string> {
  const result = await uploadToWorkbench(file);
  return result.url;
}

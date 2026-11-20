import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type {
  ErpBindingDeletedResponse,
  ErpBindingInfo,
  ErpBindingResponse,
  ErpEntryResponse,
  UpdateErpBindingRequest,
} from '@shared/api.interface';

/** 绑定 + 是否 ERP 身份 / 免密（用 ERP 账号登录的人，服务端读的时候没绑定就自动绑上） */
export async function fetchErpBindingState(): Promise<ErpBindingResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/erp/binding',
      method: 'GET',
    });
    return response.data as ErpBindingResponse;
  } catch (error) {
    logger.error('获取 ERP 绑定失败', error);
    throw error;
  }
}

export async function fetchErpBinding(): Promise<ErpBindingInfo | null> {
  return (await fetchErpBindingState()).binding;
}

export async function updateErpBinding(
  body: UpdateErpBindingRequest,
): Promise<ErpBindingResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/erp/binding',
      method: 'PUT',
      data: body,
    });
    const data = response.data as ErpBindingResponse;
    if (!data.binding) {
      throw new Error('保存 ERP 绑定失败');
    }
    return data;
  } catch (error) {
    logger.error('保存 ERP 绑定失败', error);
    throw error;
  }
}

export async function deleteErpBinding(): Promise<boolean> {
  try {
    const response = await axiosForBackend({
      url: '/api/erp/binding',
      method: 'DELETE',
    });
    const data = response.data as ErpBindingDeletedResponse;
    return data.deleted;
  } catch (error) {
    logger.error('解绑 ERP 账号失败', error);
    throw error;
  }
}

export async function createErpEntry(): Promise<ErpEntryResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/erp/entry',
      method: 'POST',
    });
    return response.data as ErpEntryResponse;
  } catch (error) {
    logger.error('获取 ERP 免登入口失败', error);
    throw error;
  }
}

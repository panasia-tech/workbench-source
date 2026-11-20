import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { logger } from '@lark-apaas/client-toolkit/logger';
import type {
  NotificationListResponse,
  NotificationReadResponse,
  NotificationUnreadResponse,
} from '@shared/api.interface';

/** 我的消息（新的在前），分页 */
export async function fetchNotifications(
  page: number,
  pageSize = 20,
): Promise<NotificationListResponse> {
  try {
    const response = await axiosForBackend({
      url: `/api/notifications?page=${page}&pageSize=${pageSize}`,
      method: 'GET',
    });
    return response.data as NotificationListResponse;
  } catch (error) {
    logger.error('获取消息列表失败', error);
    throw error;
  }
}

/** 铃铛红点用：只取未读数（失败由调用方静默处理，不打扰） */
export async function fetchUnreadCount(): Promise<number> {
  const response = await axiosForBackend({
    url: '/api/notifications/unread-count',
    method: 'GET',
  });
  return (response.data as NotificationUnreadResponse).unreadCount;
}

export async function markNotificationRead(
  id: string,
): Promise<NotificationReadResponse> {
  try {
    const response = await axiosForBackend({
      url: `/api/notifications/${encodeURIComponent(id)}/read`,
      method: 'POST',
    });
    return response.data as NotificationReadResponse;
  } catch (error) {
    logger.error('标记消息已读失败', error);
    throw error;
  }
}

export async function markAllNotificationsRead(): Promise<NotificationReadResponse> {
  try {
    const response = await axiosForBackend({
      url: '/api/notifications/read-all',
      method: 'POST',
    });
    return response.data as NotificationReadResponse;
  } catch (error) {
    logger.error('全部标记已读失败', error);
    throw error;
  }
}

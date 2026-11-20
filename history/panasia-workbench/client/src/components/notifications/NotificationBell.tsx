import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Bell, CheckCheck, Inbox, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  fetchNotifications,
  fetchUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
} from '@client/src/api/notifications';
import type {
  NotificationItem,
  NotificationListResponse,
} from '@shared/api.interface';
import NotificationCard from './NotificationCard';

const PAGE_SIZE = 20;
/** 页面可见时每分钟查一次未读数 */
const POLL_MS = 60_000;
/** 切路由、切回页面时 15 秒内不重复查 */
const MIN_REFRESH_GAP_MS = 15_000;

/** 只跳本站前端路由 */
function isInternalLink(link: string | null): link is string {
  return link !== null && link.startsWith('/') && !link.startsWith('//');
}

/**
 * 顶部窄条的铃铛：未读红点 + 点开消息列表（员工端、管理端共用）。
 * 点一条标已读并跳到对应页面；「全部已读」一次清掉。
 */
const NotificationBell: React.FC = () => {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const lastFetchAt = useRef(0);

  const refreshUnread = useCallback(async (force = false): Promise<void> => {
    if (!force && Date.now() - lastFetchAt.current < MIN_REFRESH_GAP_MS) return;
    lastFetchAt.current = Date.now();
    try {
      setUnread(await fetchUnreadCount());
    } catch {
      // 铃铛不打扰：查不到未读数就保持原样
    }
  }, []);

  // 进页面、切路由时刷新（15 秒内不重复）
  useEffect(() => {
    void refreshUnread();
  }, [pathname, refreshUnread]);

  // 可见时每分钟轮询；切回页面立即补一次
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshUnread(true);
    }, POLL_MS);
    const onVisible = (): void => {
      if (!document.hidden) void refreshUnread();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refreshUnread]);

  const applyPage = useCallback(
    (data: NotificationListResponse, append: boolean): void => {
      setItems((prev: NotificationItem[]) => {
        if (!append) return data.items;
        const seen = new Set(prev.map((item: NotificationItem) => item.id));
        return [...prev, ...data.items.filter((item: NotificationItem) => !seen.has(item.id))];
      });
      setTotal(data.total);
      setPage(data.page);
      setUnread(data.unreadCount);
      lastFetchAt.current = Date.now();
    },
    [],
  );

  const loadFirstPage = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      applyPage(await fetchNotifications(1, PAGE_SIZE), false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '消息加载失败');
    } finally {
      setLoading(false);
    }
  }, [applyPage]);

  useEffect(() => {
    if (open) void loadFirstPage();
  }, [open, loadFirstPage]);

  const loadMore = async (): Promise<void> => {
    setLoadingMore(true);
    try {
      applyPage(await fetchNotifications(page + 1, PAGE_SIZE), true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '消息加载失败');
    } finally {
      setLoadingMore(false);
    }
  };

  const openItem = (item: NotificationItem): void => {
    if (item.readAt === null) {
      const readAt = new Date().toISOString();
      setItems((prev: NotificationItem[]) =>
        prev.map((it: NotificationItem) => (it.id === item.id ? { ...it, readAt } : it)),
      );
      setUnread((count: number) => Math.max(0, count - 1));
      markNotificationRead(item.id)
        .then((res) => setUnread(res.unreadCount))
        .catch(() => undefined);
    }
    if (isInternalLink(item.link)) {
      const target = item.link;
      setOpen(false);
      // 等抽屉关掉再跳，避免弹层残留挡住新页面的点击
      requestAnimationFrame(() => navigate(target));
    }
  };

  const markAll = async (): Promise<void> => {
    setMarkingAll(true);
    try {
      const res = await markAllNotificationsRead();
      const readAt = new Date().toISOString();
      setItems((prev: NotificationItem[]) =>
        prev.map((it: NotificationItem) => (it.readAt === null ? { ...it, readAt } : it)),
      );
      setUnread(res.unreadCount);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败，请重试');
    } finally {
      setMarkingAll(false);
    }
  };

  const label = unread > 0 ? `消息，${unread} 条未读` : '消息';

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="relative rounded-full [&_svg]:size-5"
        aria-label={label}
        title={label}
        onClick={() => setOpen(true)}
      >
        <Bell />
        {unread > 0 && (
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500 ring-2 ring-background" />
        )}
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="w-full gap-0 p-0 sm:max-w-md"
          // 打开时别把焦点落在「全部已读」上，免得一个回车全清
          onOpenAutoFocus={(event: Event) => event.preventDefault()}
        >
          <div className="flex h-12 shrink-0 items-center gap-2 border-b pl-4 pr-12">
            <SheetTitle className="text-sm">消息</SheetTitle>
            <SheetDescription className="sr-only">
              任务、审核、工单的进展提醒
            </SheetDescription>
            {unread > 0 && (
              <span className="text-xs text-muted-foreground">{unread} 条未读</span>
            )}
            {unread > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                disabled={markingAll}
                onClick={() => void markAll()}
              >
                {markingAll ? <Loader2 className="animate-spin" /> : <CheckCheck />}
                全部已读
              </Button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            {loading && items.length === 0 && (
              <div className="space-y-3">
                <Skeleton className="h-24 w-full rounded-xl" />
                <Skeleton className="h-24 w-full rounded-xl" />
                <Skeleton className="h-24 w-full rounded-xl" />
              </div>
            )}

            {!loading && error !== null && (
              <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground">
                <p>{error}</p>
                <Button variant="outline" size="sm" onClick={() => void loadFirstPage()}>
                  <RefreshCw />
                  重试
                </Button>
              </div>
            )}

            {!loading && error === null && items.length === 0 && (
              <div className="flex flex-col items-center gap-1 py-12 text-center">
                <Inbox className="h-6 w-6 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">暂无消息</p>
                <p className="text-xs text-muted-foreground">
                  任务、审核、工单有进展时会在这里提醒你
                </p>
              </div>
            )}

            {error === null && items.length > 0 && (
              <div data-ai-section-type="card-list" className="space-y-3">
                {items.map((item: NotificationItem) => (
                  <NotificationCard key={item.id} item={item} onOpen={openItem} />
                ))}
                {items.length < total && (
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={loadingMore}
                    onClick={() => void loadMore()}
                  >
                    {loadingMore && <Loader2 className="animate-spin" />}
                    加载更多
                  </Button>
                )}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
};

export default NotificationBell;

import React, { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw, ScrollText } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchAdminAuditLogs } from '@client/src/api/admin';
import type { AdminAuditLogItem } from '@shared/api.interface';

const PAGE_SIZE = 20;

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

const AuditCard: React.FC<{ item: AdminAuditLogItem }> = ({ item }) => {
  const changesText =
    item.detail?.changes !== undefined && item.detail.changes !== null
      ? JSON.stringify(item.detail.changes, null, 2)
      : null;

  return (
    <div className="rounded-xl border p-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-primary/10 px-2 py-0.5 font-mono text-xs font-semibold text-primary">
          {item.action}
        </span>
        <span className="text-xs text-muted-foreground">
          {formatDateTime(item.createdAt)}
        </span>
      </div>

      {item.detail?.summary && (
        <p className="mt-2.5 text-sm leading-relaxed">{item.detail.summary}</p>
      )}
      {changesText !== null && (
        <pre className="mt-2.5 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted/50 p-3 text-xs leading-relaxed">
          {changesText}
        </pre>
      )}

      {(item.targetType !== null || item.targetId !== null) && (
        <p className="mt-2.5 text-xs text-muted-foreground">
          {item.targetType !== null && <>对象类型：{item.targetType}</>}
          {item.targetType !== null && item.targetId !== null && <> ｜ </>}
          {item.targetId !== null && (
            <span className="break-all">对象 ID：{item.targetId}</span>
          )}
        </p>
      )}

      <div className="mt-2.5 flex items-center gap-2 text-xs text-muted-foreground">
        <span>操作人：</span>
        <span>
          {item.operatorUserId !== null
            ? (item.operatorName ?? item.operatorUserId)
            : '系统'}
        </span>
      </div>
    </div>
  );
};

const AuditTab: React.FC = () => {
  const [items, setItems] = useState<AdminAuditLogItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (targetPage: number): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchAdminAuditLogs(targetPage, PAGE_SIZE);
      setItems(response.items);
      setTotal(response.total);
      setPage(response.page);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取审计日志失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(1);
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  if (error !== null) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
        <span>{error}</span>
        <Button variant="outline" size="sm" onClick={() => void load(page)}>
          <RefreshCw className="h-3.5 w-3.5" />
          重试
        </Button>
      </div>
    );
  }

  if (loading && items === null) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
    );
  }

  if (items !== null && items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        暂无操作记录
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div data-ai-section-type="card-list" className="space-y-4">
        {items?.map((item: AdminAuditLogItem) => (
          <AuditCard key={item.id} item={item} />
        ))}
      </div>

      <div className="flex items-center justify-between gap-3 pt-1">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1 || loading}
          onClick={() => void load(page - 1)}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          上一页
        </Button>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ScrollText className="h-3.5 w-3.5" />
          第 {page} 页 / 共 {totalPages} 页（{total} 条）
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages || loading}
          onClick={() => void load(page + 1)}
        >
          下一页
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
};

export default AuditTab;

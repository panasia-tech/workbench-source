import React from 'react';
import dayjs from 'dayjs';
import { Badge } from '@/components/ui/badge';
import {
  BLOCKER_CATEGORY_LABELS,
  BLOCKER_SEVERITY_LABELS,
} from '@client/src/api/problems';
import type { BlockerItem } from '@shared/api.interface';

const SEVERITY_BADGE_CLASS: Record<string, string> = {
  normal: 'bg-secondary text-secondary-foreground',
  high: 'bg-amber-100 text-amber-700',
  critical: 'bg-red-100 text-red-700',
};

const SEVERITY_DOT_CLASS: Record<string, string> = {
  normal: 'bg-muted-foreground',
  high: 'bg-amber-500',
  critical: 'bg-red-500',
};

interface AdminBlockersSectionProps {
  items: BlockerItem[];
  loading: boolean;
}

const AdminBlockersSection: React.FC<AdminBlockersSectionProps> = ({
  items,
  loading,
}) => {
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">阻塞流水</h2>
        <p className="text-xs text-muted-foreground">
          员工提交的 Blocker 全量记录，最新在前
        </p>
      </div>
      {loading ? (
        <div className="rounded-xl border p-6 text-center text-sm text-muted-foreground">
          加载中…
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          暂无阻塞记录
          <p className="mt-1 text-xs">
            员工在「我的-遇到问题」提交后，会出现在这里
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item: BlockerItem) => (
            <div key={item.id} className="rounded-xl border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    SEVERITY_DOT_CLASS[item.severity] ?? 'bg-muted-foreground'
                  }`}
                />
                <p className="min-w-0 flex-1 break-words text-sm font-medium">
                  {item.title}
                </p>
                <Badge
                  className={`shrink-0 ${
                    SEVERITY_BADGE_CLASS[item.severity] ?? ''
                  }`}
                >
                  {BLOCKER_SEVERITY_LABELS[item.severity] ?? item.severity}
                </Badge>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-muted-foreground sm:grid-cols-4">
                <p className="min-w-0 break-words">
                  {item.reporterName ?? '未知'}
                </p>
                <p className="min-w-0 break-words">
                  {item.category
                    ? BLOCKER_CATEGORY_LABELS[item.category] ?? item.category
                    : '未分类'}
                </p>
                <p>
                  损失 {item.lossHours === null ? '—' : `${item.lossHours}h`}
                </p>
                <p>{dayjs(item.createdAt).format('MM-DD HH:mm')}</p>
              </div>
            </div>
          ))}
        </div>
      )}
      {items.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          共 {items.length} 条（最多展示最近 200 条）
        </p>
      ) : null}
      {items.some((item: BlockerItem) => item.severity === 'critical') ? (
        <p className="flex items-center gap-1.5 text-xs text-red-600">
          <span
            className={`h-2 w-2 rounded-full ${
              SEVERITY_DOT_CLASS.critical ?? ''
            }`}
          />
          存在严重（资金/权限/合规）阻塞，已达单次候选条件
        </p>
      ) : null}
    </section>
  );
};

export default AdminBlockersSection;

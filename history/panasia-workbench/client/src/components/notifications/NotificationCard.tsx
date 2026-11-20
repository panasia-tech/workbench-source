import React from 'react';
import {
  Bell,
  BookOpen,
  CalendarClock,
  ClipboardCheck,
  Code2,
  FileCheck2,
  ListTodo,
  type LucideIcon,
} from 'lucide-react';

import type { NotificationCategory, NotificationItem } from '@shared/api.interface';

const CATEGORY_ICONS: Record<NotificationCategory, LucideIcon> = {
  task: ListTodo,
  task_review: FileCheck2,
  block_defer: CalendarClock,
  workorder: ClipboardCheck,
  tutorial: BookOpen,
  dev_request: Code2,
  general: Bell,
};

const pad = (n: number): string => String(n).padStart(2, '0');

/** 刚刚 / N 分钟前 / 今天 HH:mm / MM-DD HH:mm（跨年带年份） */
export function formatNotificationTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const diffMinutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (diffMinutes < 1) return '刚刚';
  if (diffMinutes < 60) return `${diffMinutes} 分钟前`;
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.toDateString() === now.toDateString()) return `今天 ${hm}`;
  const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return date.getFullYear() === now.getFullYear()
    ? `${md} ${hm}`
    : `${date.getFullYear()}-${md} ${hm}`;
}

interface NotificationCardProps {
  item: NotificationItem;
  onOpen: (item: NotificationItem) => void;
}

/** 消息卡片：单列、手机优先；未读带红点和浅底 */
const NotificationCard: React.FC<NotificationCardProps> = ({ item, onOpen }) => {
  const Icon = CATEGORY_ICONS[item.category] ?? Bell;
  const unread = item.readAt === null;
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className={`block w-full rounded-xl border p-4 text-left transition-colors hover:bg-accent ${
        unread ? 'border-primary/20 bg-primary/5' : 'bg-background'
      }`}
    >
      <div className="flex items-start gap-3">
        <Icon
          className={`mt-0.5 h-4 w-4 shrink-0 ${
            unread ? 'text-primary' : 'text-muted-foreground'
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p
              className={`break-words text-sm ${
                unread ? 'font-semibold' : 'font-medium text-muted-foreground'
              }`}
            >
              {item.title}
            </p>
            {unread && (
              <span
                className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-red-500"
                aria-label="未读"
              />
            )}
          </div>
          {item.body !== '' && (
            <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">
              {item.body}
            </p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            {formatNotificationTime(item.createdAt)}
          </p>
        </div>
      </div>
    </button>
  );
};

export default NotificationCard;

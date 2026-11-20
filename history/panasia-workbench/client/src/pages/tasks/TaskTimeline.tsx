import dayjs from 'dayjs';
import {
  BadgeCheck,
  LifeBuoy,
  MessageCircle,
  OctagonAlert,
  Plus,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import type { TaskDetail } from '@shared/api.interface';

type TimelineEntry = TaskDetail['timeline'][number];

type EntryKind = 'created' | 'block' | 'evidence' | 'assist' | 'comment';

interface ParsedEntry {
  kind: EntryKind;
  title: string;
  desc: string | null;
}

function parseEntry(content: string): ParsedEntry {
  if (content === '任务创建') {
    return { kind: 'created', title: '创建了任务', desc: null };
  }
  if (content.startsWith('【阻塞】')) {
    const desc = content.replace('【阻塞】', '');
    return { kind: 'block', title: '提交了阻塞', desc };
  }
  if (content.startsWith('【验收凭证】')) {
    const desc = content.replace('【验收凭证】', '');
    return { kind: 'evidence', title: '提交了验收凭证', desc };
  }
  if (content.startsWith('【协助】')) {
    const desc = content.replace('【协助】', '');
    return { kind: 'assist', title: '申请了协助', desc };
  }
  return { kind: 'comment', title: content.split('\n')[0], desc: null };
}

const KIND_STYLE: Record<
  EntryKind,
  { icon: typeof Plus; className: string }
> = {
  created: { icon: Plus, className: 'bg-primary/10 text-primary' },
  block: { icon: OctagonAlert, className: 'bg-red-50 text-red-600' },
  evidence: { icon: BadgeCheck, className: 'bg-green-50 text-green-600' },
  assist: { icon: LifeBuoy, className: 'bg-violet-50 text-violet-600' },
  comment: { icon: MessageCircle, className: 'bg-muted text-muted-foreground' },
};

function formatTime(iso: string): string {
  const t = dayjs(iso);
  const now = dayjs();
  if (now.isSame(t, 'day')) return `今天 ${t.format('HH:mm')}`;
  if (now.subtract(1, 'day').isSame(t, 'day')) return `昨天 ${t.format('HH:mm')}`;
  return t.format('MM-DD HH:mm');
}

interface TaskTimelineProps {
  timeline: TimelineEntry[];
}

export function TaskTimeline({ timeline }: TaskTimelineProps) {
  const entries = timeline.map((entry: TimelineEntry) => ({
    ...entry,
    parsed: parseEntry(entry.content),
  }));

  return (
    <Card>
      <CardContent className="p-5">
        {entries.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            暂无动态
          </p>
        ) : (
          <div>
            {entries.map((entry, i: number) => {
              const style = KIND_STYLE[entry.parsed.kind];
              const Icon = style.icon;
              const isLast = i === entries.length - 1;
              return (
                <div key={entry.id} className="relative flex gap-3 pb-5 last:pb-0">
                  {!isLast ? (
                    <div className="absolute left-[13px] top-8 h-[calc(100%-2rem)] w-px bg-border" />
                  ) : null}
                  <div
                    className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${style.className}`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1 pt-0.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <p className="text-sm font-medium">
                        {entry.parsed.title}
                        <span className="ml-1.5 font-normal text-muted-foreground">
                          {entry.actorName}
                        </span>
                      </p>
                      <time className="text-xs text-muted-foreground">
                        {formatTime(entry.createdAt)}
                      </time>
                    </div>
                    {entry.parsed.desc ? (
                      <p className="mt-1 whitespace-pre-wrap rounded-md bg-muted/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                        {entry.parsed.desc}
                      </p>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

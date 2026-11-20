import {
  Award,
  BookOpen,
  CalendarDays,
  Clock,
  Info,
  Lightbulb,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type {
  PerformanceEvent,
  PerformanceEventType,
} from '@shared/api.interface';

interface PerformanceEventTimelineProps {
  events: PerformanceEvent[];
}

const TYPE_META: Record<PerformanceEventType, {
  icon: LucideIcon;
  iconClass: string;
}> = {
  bonus: { icon: TrendingUp, iconClass: 'bg-emerald-500/10 text-emerald-600' },
  deduction: { icon: TrendingDown, iconClass: 'bg-red-500/10 text-red-600' },
  attendance: { icon: Clock, iconClass: 'bg-amber-500/10 text-amber-600' },
  leave: { icon: CalendarDays, iconClass: 'bg-sky-500/10 text-sky-600' },
  course: { icon: BookOpen, iconClass: 'bg-blue-500/10 text-blue-600' },
  exam: { icon: Award, iconClass: 'bg-violet-500/10 text-violet-600' },
  problem: { icon: Lightbulb, iconClass: 'bg-amber-500/10 text-amber-600' },
};

function formatAmount(amount: number): string {
  if (amount >= 0) return `+¥${amount}`;
  return `-¥${Math.abs(amount)}`;
}

const PerformanceEventTimeline = ({ events }: PerformanceEventTimelineProps) => {
  const groups = new Map<string, PerformanceEvent[]>();
  for (const e of events) {
    const month = e.date.slice(0, 7);
    groups.set(month, [...(groups.get(month) ?? []), e]);
  }
  const months = [...groups.keys()].sort((a: string, b: string) => (a < b ? 1 : -1));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>绩效事件时间线</span>
          <span className="text-xs font-normal text-muted-foreground">
            奖惩 · 考勤 · 学习
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            暂无绩效事件，奖励、扣减、考勤与学习记录产生后自动汇总
          </p>
        ) : (
          <div className="space-y-6">
            {months.map((month: string) => (
              <div key={month}>
                <p className="mb-3 text-sm font-medium text-muted-foreground">
                  {month}
                </p>
                <div className="space-y-4 border-l pl-5">
                  {groups.get(month)?.map((e: PerformanceEvent) => {
                    const meta = TYPE_META[e.type];
                    const Icon = meta.icon;
                    return (
                      <div key={e.id} className="relative flex items-start gap-3">
                        <span
                          className={`absolute -left-[34px] flex h-6 w-6 items-center justify-center rounded-full ${meta.iconClass}`}
                        >
                          <Icon className="h-3.5 w-3.5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium">{e.title}</p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {e.date}
                            {e.detail ? ` · ${e.detail}` : ''}
                          </p>
                        </div>
                        {e.amount !== null ? (
                          <span
                            className={`shrink-0 text-sm font-medium ${
                              e.amount >= 0
                                ? 'text-emerald-600'
                                : 'text-red-600'
                            }`}
                          >
                            {formatAmount(e.amount)}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default PerformanceEventTimeline;

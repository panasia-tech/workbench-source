import React, { useState } from 'react';
import dayjs from 'dayjs';
import { ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { UniversalLink } from '@lark-apaas/client-toolkit/components/UniversalLink';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  IMPROVEMENT_STAGE_OPTIONS,
  improvementStageLabel,
  updateImprovementStage,
} from '@client/src/api/problems';
import type {
  ImprovementProjectItem,
  ImprovementStage,
} from '@shared/api.interface';

const STAGE_BADGE_CLASS: Record<string, string> = {
  define: 'bg-secondary text-secondary-foreground',
  root_cause: 'bg-secondary text-secondary-foreground',
  design: 'bg-blue-100 text-blue-700',
  implement: 'bg-blue-100 text-blue-700',
  verify: 'bg-violet-100 text-violet-700',
  standardize: 'bg-violet-100 text-violet-700',
  observe: 'bg-amber-100 text-amber-700',
  closed: 'bg-emerald-100 text-emerald-700',
};

interface AdminImprovementsSectionProps {
  items: ImprovementProjectItem[];
  onStageChanged: () => void;
}

const AdminImprovementsSection: React.FC<AdminImprovementsSectionProps> = ({
  items,
  onStageChanged,
}) => {
  const [actingId, setActingId] = useState<string | null>(null);

  const changeStage = async (
    item: ImprovementProjectItem,
    stage: string,
  ): Promise<void> => {
    if (stage === item.stage) return;
    setActingId(item.id);
    try {
      await updateImprovementStage(item.id, stage as ImprovementStage);
      toast.success(`已流转到「${improvementStageLabel(stage)}」阶段`);
      onStageChanged();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : '阶段流转失败，请稍后重试',
      );
    } finally {
      setActingId(null);
    }
  };

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">改进项目</h2>
        <p className="text-xs text-muted-foreground">
          确认立项后建入 Plane，8 阶段跟踪 + 观察期
        </p>
      </div>
      {items.length === 0 ? (
        <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          暂无改进项目
          <p className="mt-1 text-xs">
            在问题池确认立项后，改进项目会出现在这里
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item: ImprovementProjectItem) => (
            <div key={item.id} className="rounded-xl border p-5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 break-words text-sm font-medium">
                  {item.title}
                </p>
                <Badge className={STAGE_BADGE_CLASS[item.stage] ?? ''}>
                  {improvementStageLabel(item.stage)}
                </Badge>
              </div>
              <p className="mt-1 break-words text-xs text-muted-foreground">
                负责人 {item.ownerName ?? '未指定'} · 创建于{' '}
                {dayjs(item.createdAt).format('YYYY-MM-DD')}
                {item.observeStartedAt
                  ? ` · 观察期从 ${dayjs(item.observeStartedAt).format('MM-DD')} 起`
                  : ''}
                {item.observeUntil
                  ? ` 至 ${dayjs(item.observeUntil).format('MM-DD')}`
                  : ''}
                {item.closedAt
                  ? ` · 已于 ${dayjs(item.closedAt).format('YYYY-MM-DD')} 关闭`
                  : ''}
              </p>
              {item.planeProjectUrl ? (
                <UniversalLink
                  to={item.planeProjectUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-flex items-center gap-1 break-all text-xs text-primary hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                  {item.planeProjectName ?? 'Plane 项目'}
                </UniversalLink>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  未关联 Plane 项目
                </p>
              )}
              <div className="mt-3">
                <Select
                  value={item.stage}
                  disabled={actingId === item.id}
                  onValueChange={(value: string) => changeStage(item, value)}
                >
                  <SelectTrigger className="w-full sm:w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {IMPROVEMENT_STAGE_OPTIONS.map(
                      (option: {
                        value: ImprovementStage;
                        label: string;
                      }) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

export default AdminImprovementsSection;

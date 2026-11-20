import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import {
  getProblemPool,
  listAllBlockers,
  listImprovements,
} from '@client/src/api/problems';
import AdminBlockersSection from './AdminBlockersSection';
import AdminPoolSection from './AdminPoolSection';
import AdminImprovementsSection from './AdminImprovementsSection';
import KpiStrip from './components/KpiStrip';
import type {
  AdminKpiRow,
  BlockerItem,
  ImprovementProjectItem,
  ProblemPoolItem,
  ProblemThresholds,
} from '@shared/api.interface';

const DEFAULT_THRESHOLDS: ProblemThresholds = {
  days: 7,
  count: 3,
  users: 2,
  lossHours: 4,
  overdue: 2,
};

const AdminProblemsPage: React.FC = () => {
  const [blockers, setBlockers] = useState<BlockerItem[]>([]);
  const [poolItems, setPoolItems] = useState<ProblemPoolItem[]>([]);
  const [thresholds, setThresholds] = useState<ProblemThresholds>(
    DEFAULT_THRESHOLDS,
  );
  const [improvements, setImprovements] = useState<
    ImprovementProjectItem[]
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([
      listAllBlockers(),
      getProblemPool(),
      listImprovements(),
    ])
      .then(([blockerRes, poolRes, improvementRes]) => {
        setBlockers(blockerRes.items ?? []);
        setPoolItems(poolRes.items ?? []);
        setThresholds(poolRes.thresholds ?? DEFAULT_THRESHOLDS);
        setImprovements(improvementRes.items ?? []);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof Error ? err.message : '问题域数据加载失败',
        );
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const candidateCount = poolItems.filter(
    (item: ProblemPoolItem) => item.status === 'candidate',
  ).length;
  const activeImprovements = improvements.filter(
    (item: ImprovementProjectItem) => item.stage !== 'closed',
  ).length;

  const kpiRows: AdminKpiRow[] = [
    { label: '阻塞记录', value: String(blockers.length) },
    { label: '问题池', value: String(poolItems.length) },
    { label: '候选', value: String(candidateCount) },
    {
      label: '改进项目',
      value: `${activeImprovements}/${improvements.length}`,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <AlertCircle className="h-5 w-5 text-primary" />
          问题
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          阻塞 → 问题池 → 改进项目：系统性问题的完整闭环。
        </p>
      </div>

      {error ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <>
          <KpiStrip rows={kpiRows} />

          <AdminBlockersSection items={blockers} loading={false} />

          <AdminPoolSection
            items={poolItems}
            thresholds={thresholds}
            onChanged={load}
          />

          <AdminImprovementsSection
            items={improvements}
            onStageChanged={load}
          />
        </>
      )}
    </div>
  );
};

export default AdminProblemsPage;

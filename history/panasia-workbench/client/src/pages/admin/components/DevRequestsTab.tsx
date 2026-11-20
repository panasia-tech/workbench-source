import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  devRequestErrorMessage,
  fetchAdminDevRequests,
} from '@client/src/api/dev-requests';
import type { DevRequestStage, DevRequestSummary } from '@shared/api.interface';
import DevRequestCard from '../../dev-requests/DevRequestCard';
import DevRequestLedgerSection from './DevRequestLedgerSection';

type View = 'list' | 'ledger';
type StageFilter = 'all' | 'warning' | DevRequestStage;

const STAGE_FILTERS: { key: StageFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'submitted', label: '需求提交' },
  { key: 'clarifying', label: '需求评审' },
  { key: 'quoted', label: '工时报价' },
  { key: 'developing', label: '开发交付' },
  { key: 'reviewing', label: '结果验收' },
  { key: 'done', label: '完成' },
  { key: 'cancelled', label: '已撤销' },
  { key: 'warning', label: '对不上的' },
];

/** 管理 Dock「开发需求」：全部需求（按环节筛，「对不上的」= 在 Plane 里直接改过状态的）+ 开发需求台账 */
const DevRequestsTab: React.FC = () => {
  const [view, setView] = useState<View>('list');
  const [filter, setFilter] = useState<StageFilter>('all');
  const [items, setItems] = useState<DevRequestSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    setItems(null);
    fetchAdminDevRequests()
      .then((response) => setItems(response.items))
      .catch((err: unknown) => setError(devRequestErrorMessage(err, '开发需求加载失败')));
  }, []);

  useEffect(() => {
    if (view === 'list') load();
  }, [view, load]);

  const visible = (items ?? []).filter((item: DevRequestSummary) =>
    filter === 'all' ? true : filter === 'warning' ? item.warning !== null : item.stage === filter,
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(['list', 'ledger'] as View[]).map((key: View) => (
          <button
            key={key}
            type="button"
            onClick={() => setView(key)}
            className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
              view === key
                ? 'border-primary bg-primary text-primary-foreground'
                : 'bg-background text-muted-foreground hover:text-foreground'
            }`}
          >
            {key === 'list' ? '全部需求' : '台账'}
          </button>
        ))}
      </div>

      {view === 'ledger' ? (
        <DevRequestLedgerSection />
      ) : (
        <>
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {STAGE_FILTERS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`whitespace-nowrap rounded-full border px-3 py-1 text-xs transition-colors ${
                  filter === key
                    ? 'border-primary/60 bg-primary/5 text-primary'
                    : 'bg-card text-muted-foreground hover:bg-muted/50'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>开发需求加载失败</AlertTitle>
              <AlertDescription className="flex items-center gap-3">
                <span>{error}</span>
                <Button variant="outline" size="sm" onClick={load}>
                  <RefreshCw className="h-3.5 w-3.5" />
                  重试
                </Button>
              </AlertDescription>
            </Alert>
          ) : items === null ? (
            <Skeleton className="h-40 w-full rounded-xl" />
          ) : visible.length === 0 ? (
            <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              暂无开发需求
            </p>
          ) : (
            <div data-ai-section-type="card-list" className="space-y-3">
              {visible.map((item: DevRequestSummary) => (
                <DevRequestCard key={item.id} item={item} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default DevRequestsTab;

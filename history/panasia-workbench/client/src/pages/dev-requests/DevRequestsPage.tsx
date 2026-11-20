import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronLeft, CircleAlert, Plus, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  devRequestErrorMessage,
  fetchDevRequests,
  type DevRequestScope,
} from '@client/src/api/dev-requests';
import type { DevRequestListResponse, DevRequestSummary } from '@shared/api.interface';
import DevRequestCard from './DevRequestCard';

const SCOPE_LABELS: Record<DevRequestScope, string> = {
  mine: '我发起的',
  assigned: '派给我的',
  all: '全部',
};

const EMPTY_TEXT: Record<DevRequestScope, string> = {
  mine: '还没发过开发需求，点右上角「发需求」',
  assigned: '暂时没有派给你的开发需求',
  all: '还没有开发需求',
};

/** 开发需求列表：我发起的 / 派给我的（老板、管理员多一个「全部」），轮到自己处理的排前面 */
const DevRequestsPage = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const scopeParam = searchParams.get('scope');
  const scope: DevRequestScope =
    scopeParam === 'assigned' || scopeParam === 'all' ? scopeParam : 'mine';
  const [data, setData] = useState<DevRequestListResponse | null>(null);
  const [canSeeAll, setCanSeeAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchDevRequests(scope)
      .then((response: DevRequestListResponse) => {
        setData(response);
        setCanSeeAll(response.canSeeAll);
      })
      .catch((err: unknown) => {
        setData(null);
        setError(devRequestErrorMessage(err, '开发需求加载失败，请稍后重试'));
      })
      .finally(() => setLoading(false));
  }, [scope]);

  useEffect(() => {
    load();
  }, [load]);

  const scopes: DevRequestScope[] = canSeeAll ? ['mine', 'assigned', 'all'] : ['mine', 'assigned'];
  const items: DevRequestSummary[] = [...(data?.items ?? [])].sort(
    (a: DevRequestSummary, b: DevRequestSummary) => Number(b.needsMe) - Number(a.needsMe),
  );

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link
            to="/my"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
          >
            <ChevronLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-lg font-semibold">开发需求</h1>
        </div>
        <Button size="sm" asChild>
          <Link to="/dev-requests/new">
            <Plus className="h-4 w-4" />
            发需求
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {scopes.map((key: DevRequestScope) => (
          <button
            key={key}
            type="button"
            onClick={() => setSearchParams(key === 'mine' ? {} : { scope: key }, { replace: true })}
            className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
              scope === key
                ? 'border-primary bg-primary text-primary-foreground'
                : 'bg-background text-muted-foreground hover:text-foreground'
            }`}
          >
            {SCOPE_LABELS[key]}
          </button>
        ))}
      </div>

      {error ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between">
          <span className="flex items-center gap-2">
            <CircleAlert className="h-4 w-4 shrink-0" />
            {error}
          </span>
          <Button size="sm" variant="outline" onClick={load}>
            <RotateCcw className="h-3.5 w-3.5" />
            重试
          </Button>
        </div>
      ) : loading ? (
        <div className="space-y-4">
          <Skeleton className="h-36 rounded-xl" />
          <Skeleton className="h-36 rounded-xl" />
        </div>
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          {EMPTY_TEXT[scope]}
        </p>
      ) : (
        <div data-ai-section-type="card-list" className="space-y-4">
          {items.map((item: DevRequestSummary) => (
            <DevRequestCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
};

export default DevRequestsPage;

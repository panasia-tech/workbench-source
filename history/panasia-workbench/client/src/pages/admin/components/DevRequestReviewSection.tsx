import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  devRequestErrorMessage,
  fetchAdminDevRequests,
} from '@client/src/api/dev-requests';
import type { DevRequestSummary } from '@shared/api.interface';
import DevRequestCard from '../../dev-requests/DevRequestCard';

/**
 * 验收 Dock：开发需求待验收（结果验收）。不在「Plane 任务验收」里出通过 / 打回——
 * 要核对报价和记账金额，点进开发需求页验收（老板能替发布人验收）
 */
const DevRequestReviewSection: React.FC = () => {
  const [items, setItems] = useState<DevRequestSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    fetchAdminDevRequests('reviewing')
      .then((response) => setItems(response.items))
      .catch((err: unknown) => {
        setItems(null);
        setError(devRequestErrorMessage(err, '开发需求待验收加载失败'));
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>开发需求待验收加载失败</AlertTitle>
        <AlertDescription className="flex items-center gap-3">
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5" />
            重试
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border bg-card p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">开发需求待验收</h2>
        <Badge variant="secondary" className="text-xs">
          待验收 {items?.length ?? 0}
        </Badge>
      </div>
      {items === null ? (
        <Skeleton className="h-24 w-full rounded-xl" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无待验收的开发需求</p>
      ) : (
        <div data-ai-section-type="card-list" className="space-y-3">
          {items.map((item: DevRequestSummary) => (
            <DevRequestCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
};

export default DevRequestReviewSection;

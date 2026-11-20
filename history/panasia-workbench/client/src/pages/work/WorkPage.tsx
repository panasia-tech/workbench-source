import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowUpRight,
  Boxes,
  CircleAlert,
  Package,
  ShoppingCart,
  TrendingUp,
  Truck,
  Warehouse,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { workApi } from '@client/src/api';
import { createErpEntry, fetchErpBinding } from '@client/src/api/erp';
import {
  fetchErpCommission,
  fetchErpMe,
  fetchErpSummary,
  fetchErpWorkload,
} from '@client/src/api/erpDashboard';
import DemoBadge from '@/components/demo-badge';
import { DEMO_MODE } from '@client/src/utils/config';
import type {
  ErpBindingInfo,
  ErpCommissionStats,
  ErpDashboardSummary,
  ErpMe,
  ErpWorkloadStats,
  WorkOverview,
} from '@shared/api.interface';
import DevRequestEntryCard from '../dev-requests/DevRequestEntryCard';
import NativeErpWorkbench from './NativeErpWorkbench';
import { UniversalLink } from '@lark-apaas/client-toolkit/components/UniversalLink';

const ROLE_ICONS: Record<string, React.ReactNode> = {
  procurement: <ShoppingCart className="h-6 w-6" />,
  sales: <Truck className="h-6 w-6" />,
  warehouse: <Warehouse className="h-6 w-6" />,
  general: <Boxes className="h-6 w-6" />,
};

const PHASE_TWO_ENTRIES: {
  key: string;
  title: string;
  description: string;
  icon: React.ReactNode;
}[] = [
  {
    key: 'procurement',
    title: '采购工作台',
    description: '采购下单、核价与供应商跟进',
    icon: <ShoppingCart className="h-6 w-6" />,
  },
  {
    key: 'sales',
    title: '销售工作台',
    description: '销售订单与客户跟进',
    icon: <TrendingUp className="h-6 w-6" />,
  },
  {
    key: 'warehouse',
    title: '仓储工作台',
    description: '出入库与库存管理',
    icon: <Package className="h-6 w-6" />,
  },
];

const DemoWorkPlaceholder = () => (
  <div className="space-y-6">
    <div>
      <div className="flex items-center gap-2">
        <h1 className="text-xl font-semibold">业务工作台</h1>
        <DemoBadge />
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        我去哪里真正完成业务
      </p>
    </div>

    <Card className="border-dashed">
      <CardContent className="p-5 text-center">
        <h2 className="text-base font-semibold">业务工作台将在第二期开放</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          采购、销售、仓储的日常业务操作（下单/核价/出入库）将在二期接入
          ERPNext 实时数据，当前 Demo 聚焦任务、项目与绩效
        </p>
      </CardContent>
    </Card>

    <div
      data-ai-section-type="card-menu"
      className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
    >
      {PHASE_TWO_ENTRIES.map((entry) => (
        <Card key={entry.key} className="cursor-not-allowed opacity-60">
          <CardContent className="flex h-full flex-col justify-between gap-3 p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">{entry.title}</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {entry.description}
                </p>
              </div>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                二期
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{entry.icon}</span>
              <span className="text-xs text-muted-foreground">待开放</span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  </div>
);

type WorkMode = 'checking' | 'native' | 'fallback';

const WorkPage = () => {
  const [mode, setMode] = useState<WorkMode>('checking');
  const [me, setMe] = useState<ErpMe | null>(null);
  const [summary, setSummary] = useState<ErpDashboardSummary | null>(null);
  const [workload, setWorkload] = useState<ErpWorkloadStats | null>(null);
  const [commission, setCommission] = useState<ErpCommissionStats | null>(null);
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  // 降级（未绑定 / 非 ERP 身份 / ERP 连不上）时回到原来的绑定引导视图
  const [overview, setOverview] = useState<WorkOverview | null>(null);
  const [binding, setBinding] = useState<ErpBindingInfo | null>(null);
  const [fallbackError, setFallbackError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setMode('checking');
    setFallbackError(null);
    try {
      const [meRes, summaryRes, workloadRes, commissionRes] =
        await Promise.all([
          fetchErpMe(),
          fetchErpSummary(),
          fetchErpWorkload(),
          fetchErpCommission('today'),
        ]);
      setMe(meRes);
      setSummary(summaryRes);
      setWorkload(workloadRes);
      setCommission(commissionRes);
      setMode('native');
    } catch {
      try {
        const [overviewRes, bindingRes] = await Promise.all([
          workApi.fetchWorkOverview(),
          fetchErpBinding(),
        ]);
        setOverview(overviewRes);
        setBinding(bindingRes);
      } catch {
        setOverview(null);
        setFallbackError('工作台数据加载失败，请稍后重试');
      }
      setMode('fallback');
    }
  }, []);

  useEffect(() => {
    if (DEMO_MODE) return;
    void load();
  }, [load]);

  /** 免登 H5 深链：现换 60s 一次性入口令牌，新标签页打开对应模块页 */
  const openH5 = useCallback(
    async (h5Path: string) => {
      if (openingPath) return;
      setOpeningPath(h5Path);
      try {
        const entry = await createErpEntry();
        window.open(
          `${entry.url}#${h5Path}`,
          '_blank',
          'noopener,noreferrer',
        );
      } catch {
        toast.error('打开 ERP 失败，请稍后重试');
      } finally {
        setOpeningPath(null);
      }
    },
    [openingPath],
  );

  if (DEMO_MODE) {
    return <DemoWorkPlaceholder />;
  }

  if (mode === 'checking') {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i: number) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      </div>
    );
  }

  if (mode === 'native' && me) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-xl font-semibold">业务工作台</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            我去哪里真正完成业务
          </p>
        </div>
        <NativeErpWorkbench
          me={me}
          summary={summary}
          workload={workload}
          commission={commission}
          onOpenH5={(h5Path: string) => void openH5(h5Path)}
          openingPath={openingPath}
        />
        <DevRequestEntryCard />
      </div>
    );
  }

  if (fallbackError || !overview) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <CircleAlert className="h-4 w-4" />
        <span>{fallbackError ?? '数据加载失败'}</span>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          重试
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{overview.workbenchName}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          我去哪里真正完成业务
        </p>
      </div>

      <Card className="border-primary/30">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div className="flex items-center gap-4">
            <span className="text-primary">
              <Boxes className="h-6 w-6" />
            </span>
            <div>
              <h2 className="text-base font-semibold">ERP 工作台</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {binding
                  ? '已绑定 ERP 账号，但 ERP 暂时连不上，请稍后重试'
                  : '公司 ERP 系统 · 绑定后解锁业务工作台'}
              </p>
            </div>
          </div>
          {binding ? (
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
          ) : (
            <Button size="sm" asChild>
              <Link to="/my">前往「我的」绑定</Link>
            </Button>
          )}
        </CardContent>
      </Card>

      <DevRequestEntryCard />

      {overview.hint ? (
        <Card data-ai-section-type="card-menu" className="mx-auto max-w-xl">
          <CardContent className="flex flex-col items-center gap-4 p-5 text-center">
            {ROLE_ICONS[overview.role]}
            <p className="text-sm text-muted-foreground">{overview.hint}</p>
            <Button asChild>
              <Link to="/my">前往「我的」设置岗位</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div
          data-ai-section-type="card-menu"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {overview.entries.map((entry) => (
            <Card key={entry.key} className="transition-shadow hover:shadow-md">
              <CardContent className="flex h-full flex-col justify-between gap-3 p-5">
                <div>
                  <h2 className="text-base font-semibold">{entry.title}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {entry.description}
                  </p>
                  <p className="mt-2 text-sm">
                    {entry.count === null ? (
                      <span className="text-muted-foreground">点击进入查看</span>
                    ) : (
                      <span>
                        <span className="font-semibold">{entry.count}</span>{' '}
                        <span className="text-muted-foreground">条记录</span>
                      </span>
                    )}
                  </p>
                </div>
                <Button variant="outline" size="sm" asChild>
                  <UniversalLink to={entry.externalUrl ?? '#'} target="_blank" rel="noreferrer">
                    进入
                    <ArrowUpRight className="h-4 w-4" />
                  </UniversalLink>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

export default WorkPage;

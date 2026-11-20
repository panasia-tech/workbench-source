import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ChevronLeft } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import DemoBadge from '@/components/demo-badge';
import { DEMO_MODE } from '@client/src/utils/config';
import { myApi } from '@client/src/api';
import type { MySalary } from '@shared/api.interface';

const SalaryPage = () => {
  const [data, setData] = useState<MySalary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    myApi
      .fetchMySalary()
      .then((salary: MySalary) => {
        if (!cancelled) setData(salary);
      })
      .catch(() => {
        if (!cancelled) setError('薪资数据加载失败，请稍后重试');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/my"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          返回我的
        </Link>
      </div>

      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">预计薪资</h1>
          {DEMO_MODE && <DemoBadge />}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          本月预计发放金额（估算）
        </p>
      </div>

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-28" />
          <Skeleton className="h-48" />
        </div>
      ) : error || !data ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {error ?? '数据加载失败'}
        </div>
      ) : data.earnings.length === 0 ? (
        <Card>
          <CardContent className="p-5 text-center text-sm text-muted-foreground">
            暂无薪资数据，绑定 HR 员工并产生工资记录后会出现在这里
          </CardContent>
        </Card>
      ) : (
        <>
          <Card data-ai-section-type="card-stat">
            <CardContent className="p-5">
              <p className="text-sm text-muted-foreground">
                {data.month} 月预计发放
              </p>
              <p className="mt-1 text-3xl font-semibold">¥{data.total}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">薪资明细</CardTitle>
            </CardHeader>
            <CardContent>
              <div data-ai-section-type="card-list" className="space-y-3">
                {data.earnings.map((earning) => (
                  <div
                    key={earning.key}
                    className="flex items-center justify-between gap-4 text-sm"
                  >
                    <span className="text-muted-foreground">
                      {earning.label}
                    </span>
                    <span className="font-medium">¥{earning.amount}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            Demo 数据，仅用于界面演示，非真实薪资
          </p>
        </>
      )}
    </div>
  );
};

export default SalaryPage;

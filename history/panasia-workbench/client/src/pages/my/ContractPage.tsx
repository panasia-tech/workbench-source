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
import type { MyContract } from '@shared/api.interface';

const ContractPage = () => {
  const [data, setData] = useState<MyContract | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    myApi
      .fetchMyContract()
      .then((contract: MyContract) => {
        if (!cancelled) setData(contract);
      })
      .catch(() => {
        if (!cancelled) setError('合同信息加载失败，请稍后重试');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const isEmpty =
    data !== null && !data.status && !data.contractType;

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
          <h1 className="text-xl font-semibold">合同</h1>
          {DEMO_MODE && <DemoBadge />}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">我的劳动合同概况</p>
      </div>

      {loading ? (
        <Skeleton className="h-48" />
      ) : error || !data ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {error ?? '数据加载失败'}
        </div>
      ) : isEmpty ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-5 text-center">
            <p className="text-sm text-muted-foreground">
              暂无合同数据，绑定 HR 员工并录入合同后会出现在这里
            </p>
            <Link
              to="/my"
              className="text-sm font-medium text-primary hover:underline"
            >
              前往「我的」绑定员工
            </Link>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">合同状态</CardTitle>
          </CardHeader>
          <CardContent>
            <p
              className={`text-3xl font-semibold ${
                data.status === 'Active' ? 'text-green-600' : 'text-amber-600'
              }`}
            >
              {data.statusLabel}
            </p>
            <div className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
              <div>
                <p className="text-muted-foreground">合同类型</p>
                <p className="mt-0.5 font-medium">{data.contractType}</p>
              </div>
              <div>
                <p className="text-muted-foreground">开始日期</p>
                <p className="mt-0.5 font-medium">
                  {data.startDate ?? '未记录'}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">结束日期</p>
                <p className="mt-0.5 font-medium">{data.endDate ?? '未记录'}</p>
              </div>
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              合同原件请通过人事系统查看
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default ContractPage;

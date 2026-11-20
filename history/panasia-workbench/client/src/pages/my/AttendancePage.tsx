import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ChevronLeft } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import DemoBadge from '@/components/demo-badge';
import { DEMO_MODE } from '@client/src/utils/config';
import { myApi } from '@client/src/api';
import type { MyAttendance } from '@shared/api.interface';

const METRICS = [
  { key: 'presentDays', label: '出勤天数', unit: '天' },
  { key: 'lateCount', label: '迟到', unit: '次' },
  { key: 'earlyLeaveCount', label: '早退', unit: '次' },
  { key: 'leaveDays', label: '请假', unit: '天' },
  { key: 'anomalyCount', label: '异常', unit: '次' },
] as const;

const AttendancePage = () => {
  const [data, setData] = useState<MyAttendance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    myApi
      .fetchMyAttendance()
      .then((attendance: MyAttendance) => {
        if (!cancelled) setData(attendance);
      })
      .catch(() => {
        if (!cancelled) setError('考勤数据加载失败，请稍后重试');
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
          <h1 className="text-xl font-semibold">考勤</h1>
          {DEMO_MODE && <DemoBadge />}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {data ? `${data.month} 月考勤概况` : '本月考勤概况'}
        </p>
      </div>

      {loading ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
          {METRICS.map((metric) => (
            <Skeleton key={metric.key} className="h-20" />
          ))}
        </div>
      ) : error || !data ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {error ?? '数据加载失败'}
        </div>
      ) : (
        <div
          data-ai-section-type="card-stat"
          className="grid grid-cols-2 gap-4 md:grid-cols-5"
        >
          {METRICS.map((metric) => (
            <Card key={metric.key}>
              <CardContent className="p-5">
                <p className="text-sm text-muted-foreground">
                  {metric.label}
                </p>
                <p className="mt-1 text-2xl font-semibold">
                  {data[metric.key]}
                  <span className="ml-1 text-sm font-normal text-muted-foreground">
                    {metric.unit}
                  </span>
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};

export default AttendancePage;

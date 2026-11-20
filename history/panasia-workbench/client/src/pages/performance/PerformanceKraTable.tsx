import { Info, Sparkles } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import type { PerformanceCycle } from '@shared/api.interface';

interface PerformanceKraTableProps {
  cycle: PerformanceCycle | undefined;
}

const PerformanceKraTable = ({ cycle }: PerformanceKraTableProps) => {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-base">
          <span>指标逐项溯源</span>
          <span className="text-xs font-normal text-muted-foreground">
            来源：Frappe HR
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!cycle || cycle.kras.length === 0 ? (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            该周期暂无评估明细，HR 录入 KRA 后自动展示
          </p>
        ) : (
          <div>
            <div className="flex items-center gap-4 pb-2 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1">考核指标</span>
              <span className="w-24 text-right">评分（1-5）</span>
              <span className="w-20 text-right">得分 / 权重</span>
            </div>
            <div className="divide-y">
              {cycle.kras.map((kra) => (
                <div key={kra.name} className="flex items-center gap-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-4 text-sm">
                      <span className="truncate">{kra.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        权重 {kra.weight}%
                      </span>
                    </div>
                    <Progress
                      value={(kra.rating / 5) * 100}
                      className="mt-2 h-1.5"
                    />
                  </div>
                  <div className="flex w-24 items-center justify-end gap-1.5">
                    {kra.rating < 5 ? (
                      <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">
                        <Sparkles className="h-3 w-3" />
                        可补 +{(kra.weight - kra.earned).toFixed(1)} 分
                      </span>
                    ) : null}
                    <span className="text-right text-sm font-medium">
                      {kra.rating}/5
                    </span>
                  </div>
                  <div className="w-20 text-right text-sm">
                    <span className="font-medium">{kra.earned}</span>
                    <span className="text-xs text-muted-foreground">
                      {' '}
                      / {kra.weight}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center justify-between border-t pt-3 text-sm">
              <span className="text-muted-foreground">周期总分</span>
              <span className="font-semibold">{cycle.score ?? '—'}</span>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              评分口径：每项得分 = 权重 × 评分 ÷ 5，总分 = 各项得分之和（四舍五入）
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default PerformanceKraTable;

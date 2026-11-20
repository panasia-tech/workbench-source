import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Download, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  devRequestErrorMessage,
  fetchDevRequestLedger,
} from '@client/src/api/dev-requests';
import type {
  AdminKpiRow,
  DevRequestLedgerGroup,
  DevRequestLedgerResponse,
  DevRequestLedgerRow,
} from '@shared/api.interface';
import { formatHours, formatYuan, todayShanghai } from '../../dev-requests/dev-request-ui';
import KpiStrip from './KpiStrip';

const ALL = 'all';

function csvCell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[",\n]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 导出当前筛选结果（带 BOM，Excel 直接打开不乱码） */
function downloadCsv(data: DevRequestLedgerResponse): void {
  const header = ['验收日期', '序号', '标题', '项目', '开发者', '发布人', '工时', '报价', '记账金额', '调整原因', '验收人'];
  const lines = data.rows.map((row: DevRequestLedgerRow) =>
    [
      row.acceptedDate,
      row.sequenceId,
      row.title,
      row.projectName,
      row.developerName,
      row.publisherName,
      row.quoteHours,
      row.quoteAmount.toFixed(2),
      row.finalAmount.toFixed(2),
      row.adjustReason,
      row.acceptedByName,
    ]
      .map(csvCell)
      .join(','),
  );
  const blob = new Blob([`\uFEFF${[header.join(','), ...lines].join('\n')}`], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `开发需求台账-${data.month ?? '全部'}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

const GroupList: React.FC<{ title: string; groups: DevRequestLedgerGroup[] }> = ({
  title,
  groups,
}) => (
  <div className="rounded-xl border bg-card p-4">
    <p className="mb-2 text-sm font-semibold">{title}</p>
    {groups.length === 0 ? (
      <p className="text-xs text-muted-foreground">暂无</p>
    ) : (
      <ul className="space-y-1.5">
        {groups.map((group: DevRequestLedgerGroup) => (
          <li key={group.id} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">
              {group.name}
              <span className="ml-1.5 text-xs text-muted-foreground">{group.count} 笔</span>
            </span>
            <span className="shrink-0 font-medium tabular-nums">{formatYuan(group.finalAmount)}</span>
          </li>
        ))}
      </ul>
    )}
  </div>
);

/** 开发需求台账：验收通过的才记，按月份 / 开发者 / 项目筛，按开发者、项目合计；只记账，不进钱包 */
const DevRequestLedgerSection: React.FC = () => {
  const [month, setMonth] = useState(todayShanghai().slice(0, 7));
  const [developerId, setDeveloperId] = useState(ALL);
  const [projectId, setProjectId] = useState(ALL);
  const [data, setData] = useState<DevRequestLedgerResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchDevRequestLedger({
      month,
      developerId: developerId === ALL ? '' : developerId,
      projectId: projectId === ALL ? '' : projectId,
    })
      .then(setData)
      .catch((err: unknown) => setError(devRequestErrorMessage(err, '台账加载失败')))
      .finally(() => setLoading(false));
  }, [month, developerId, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const kpis: AdminKpiRow[] = data
    ? [
        { label: '笔数', value: data.total.count },
        { label: '工时', value: formatHours(data.total.hours) },
        { label: '报价合计', value: formatYuan(data.total.quoteAmount) },
        { label: '记账合计', value: formatYuan(data.total.finalAmount) },
      ]
    : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          className="w-40"
          aria-label="月份"
        />
        <Button
          variant={month === '' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setMonth(month === '' ? todayShanghai().slice(0, 7) : '')}
        >
          全部月份
        </Button>
        <Select value={developerId} onValueChange={setDeveloperId}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder="开发者" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部开发者</SelectItem>
            {(data?.developerOptions ?? []).map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="项目" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>全部项目</SelectItem>
            {(data?.projectOptions ?? []).map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          disabled={!data || data.rows.length === 0}
          onClick={() => data && downloadCsv(data)}
        >
          <Download className="h-3.5 w-3.5" />
          导出 CSV
        </Button>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>台账加载失败</AlertTitle>
          <AlertDescription className="flex items-center gap-3">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={load}>
              <RefreshCw className="h-3.5 w-3.5" />
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : loading && !data ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : data ? (
        <>
          <KpiStrip rows={kpis} />
          <div className="grid gap-4 sm:grid-cols-2">
            <GroupList title="按开发者" groups={data.byDeveloper} />
            <GroupList title="按项目" groups={data.byProject} />
          </div>
          {data.rows.length === 0 ? (
            <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
              这个范围里还没有验收记账的开发需求
            </p>
          ) : (
            <div data-ai-section-type="card-list" className="space-y-3">
              {data.rows.map((row: DevRequestLedgerRow) => (
                <Link
                  key={row.id}
                  to={`/dev-requests/${row.devRequestId}`}
                  className="block rounded-xl border bg-card p-4 transition-colors hover:bg-muted/50"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="min-w-0 break-words text-sm font-semibold">
                      <span className="mr-1.5 text-xs font-normal text-muted-foreground">
                        #{row.sequenceId ?? '—'}
                      </span>
                      {row.title}
                    </p>
                    <span className="shrink-0 text-base font-bold tabular-nums">
                      {formatYuan(row.finalAmount)}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {row.projectName} · {row.developerName} 做 · {row.publisherName} 发 · {row.acceptedDate} 验收
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    报价 {formatYuan(row.quoteAmount)} · {formatHours(row.quoteHours)}
                    {row.acceptedByName ? ` · ${row.acceptedByName} 验收` : ''}
                  </p>
                  {row.adjustReason ? (
                    <p className="mt-1 rounded-md bg-amber-50 px-2 py-1 text-xs text-amber-800">
                      调整原因：{row.adjustReason}
                    </p>
                  ) : null}
                </Link>
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
};

export default DevRequestLedgerSection;

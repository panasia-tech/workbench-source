import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  fetchErpCommission,
  fetchErpPayslip,
} from '@client/src/api/erpDashboard';
import { getBackendErrorStatus } from '@client/src/utils/backend-error-guard';
import type { ErpCommissionStats, ErpPayslip } from '@shared/api.interface';

/**
 * ERP 工资单（移植 miniprogram/pages/profile/payslip）：
 * 周期今日/昨日/本周/本月/任意月，逐笔提成明细 + 同期提成汇总（以 ERP 后端算的为准）。
 */

const PERIODS = [
  { key: 'today', label: '今日' },
  { key: 'yesterday', label: '昨日' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'pick', label: '任意月' },
] as const;

type PeriodKey = (typeof PERIODS)[number]['key'];

/** 与 payslip 周期对应的 commission period（任意月 ERP 不支持，不汇总） */
const COMMISSION_PERIOD: Record<Exclude<PeriodKey, 'pick'>, string> = {
  today: 'today',
  yesterday: 'yesterday',
  week: '7d',
  month: 'month',
};

/** 强制中国时区（与 ERP 的中国日历口径一致，避免海外/系统时区差一天） */
function cnNow(): Date {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 8 * 3600000);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 预设周期对应的 [date_from, date_to]（中国日历，含首尾） */
function rangeForPeriod(key: PeriodKey, pickMonth: string): [string, string] {
  const today = cnNow();
  const todayStr = fmtDate(today);
  if (key === 'today') return [todayStr, todayStr];
  if (key === 'yesterday') {
    const y = cnNow();
    y.setDate(y.getDate() - 1);
    const s = fmtDate(y);
    return [s, s];
  }
  if (key === 'week') {
    const d = cnNow();
    const dow = d.getDay() === 0 ? 7 : d.getDay(); // 周一为一周起点
    d.setDate(d.getDate() - (dow - 1));
    return [fmtDate(d), todayStr];
  }
  if (key === 'month') {
    const d = cnNow();
    d.setDate(1);
    return [fmtDate(d), todayStr];
  }
  // pick：任意月，pickMonth = 'YYYY-MM'
  const pm = pickMonth || todayStr.slice(0, 7);
  const [yy, mm] = pm.split('-').map(Number);
  const lastDay = new Date(yy, mm, 0).getDate(); // 第 0 天即上月末 → 该月末
  return [`${pm}-01`, `${pm}-${pad(lastDay)}`];
}

function money(value: number | null | undefined): string {
  return `¥${Number(value ?? 0).toFixed(2)}`;
}

/** CNDatetime（北京时间 ISO）→ 'MM-DD HH:mm' */
function fmtDatetime(iso: string | null): string {
  if (!iso) return '';
  return iso.slice(5, 16).replace('T', ' ');
}

const ErpPayslipPage = () => {
  const [period, setPeriod] = useState<PeriodKey>('today');
  const [pickMonth, setPickMonth] = useState<string>(() => {
    const now = cnNow();
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  });
  const [range, setRange] = useState<[string, string]>(['', '']);
  const [payslip, setPayslip] = useState<ErpPayslip | null>(null);
  const [commission, setCommission] = useState<ErpCommissionStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (key: PeriodKey, month: string) => {
    const [dateFrom, dateTo] = rangeForPeriod(key, month);
    setRange([dateFrom, dateTo]);
    setLoading(true);
    setError(null);
    try {
      const slip = await fetchErpPayslip(dateFrom, dateTo);
      setPayslip(slip);
      const commissionPeriod =
        key === 'pick' ? null : COMMISSION_PERIOD[key];
      if (commissionPeriod) {
        setCommission(await fetchErpCommission(commissionPeriod));
      } else {
        setCommission(null);
      }
    } catch (err) {
      setPayslip(null);
      setCommission(null);
      setError(
        getBackendErrorStatus(err) === 403
          ? '需要 ERP 身份且绑定的就是本人账号（可在「我的」页绑定或改回本人）'
          : '工资单加载失败，请稍后重试',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(period, pickMonth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const pickPeriod = (key: PeriodKey) => {
    if (key === period && key !== 'pick') return;
    setPeriod(key);
    void load(key, pickMonth);
  };

  const sections = useMemo(
    () => payslip?.sections.filter((sec) => sec.items.length > 0) ?? [],
    [payslip],
  );

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/my"
          className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          我的
        </Link>
        <h1 className="text-xl font-semibold">工资单明细</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          逐笔提成 · 逾期采购显示 ¥0 · 以 ERP 计算的为准
        </p>
      </div>

      {/* 周期选择 */}
      <Card>
        <CardContent className="p-5">
          <div className="flex flex-wrap items-center gap-2">
            {PERIODS.map((item) =>
              item.key === 'pick' ? (
                <label
                  key={item.key}
                  className={`relative cursor-pointer rounded-full border px-3 py-1 text-sm transition-colors ${
                    period === 'pick'
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {period === 'pick' ? pickMonth : item.label}
                  <input
                    type="month"
                    value={pickMonth}
                    onChange={(e) => {
                      if (!e.target.value) return;
                      setPickMonth(e.target.value);
                      setPeriod('pick');
                      void load('pick', e.target.value);
                    }}
                    className="absolute h-0 w-0 opacity-0"
                    aria-label="选择任意月份"
                  />
                </label>
              ) : (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => pickPeriod(item.key)}
                  className={`rounded-full border px-3 py-1 text-sm transition-colors ${
                    period === item.key
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {item.label}
                </button>
              ),
            )}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {range[0]} 至 {range[1]}
          </p>
        </CardContent>
      </Card>

      {loading ? (
        <div className="space-y-4">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : error ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load(period, pickMonth)}
          >
            重试
          </Button>
        </div>
      ) : (
        <>
          {/* 合计 */}
          <Card>
            <CardContent className="flex items-center justify-between p-5">
              <span className="text-sm text-muted-foreground">
                预计工资合计
              </span>
              <span className="text-2xl font-semibold">
                {money(payslip?.total_commission)}
              </span>
            </CardContent>
          </Card>

          {/* 同期提成汇总 */}
          {period === 'pick' ? (
            <Card>
              <CardContent className="p-5 text-sm text-muted-foreground">
                任意月不支持提成汇总，明细以上方工资单为准
              </CardContent>
            </Card>
          ) : (
            commission && (
              <Card>
                <CardContent className="p-5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">同期提成汇总</span>
                    <span className="text-xs text-muted-foreground">
                      {
                        PERIODS.find((item) => item.key === period)?.label
                      }
                    </span>
                  </div>
                  <div className="mt-2 flex items-baseline justify-between">
                    <span className="text-sm text-muted-foreground">合计</span>
                    <span className="text-xl font-semibold">
                      {money(commission.total_commission)}
                    </span>
                  </div>
                  <div className="mt-3 space-y-1.5 border-t pt-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">采购提成</span>
                      <span>{money(commission.purchase_commission)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">仓管提成</span>
                      <span>{money(commission.warehouse_commission)}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">销售提成</span>
                      <span>{money(commission.sales_commission)}</span>
                    </div>
                    {commission.net_received_hint != null && (
                      <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>扣除平台手续费后约到手</span>
                        <span>{money(commission.net_received_hint)}</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          )}

          {/* 各角色明细 */}
          {sections.length === 0 ? (
            <Card>
              <CardContent className="p-5 text-center text-sm text-muted-foreground">
                本期暂无提成记录
              </CardContent>
            </Card>
          ) : (
            sections.map((sec) => (
              <Card key={sec.role}>
                <CardContent className="p-5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{sec.title}</span>
                    <span className="text-base font-semibold">
                      {money(sec.commission_total)}
                    </span>
                  </div>
                  {sec.note && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {sec.note}
                    </p>
                  )}
                  {sec.overdue_count > 0 && (
                    <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
                      含 {sec.overdue_count} 笔逾期采购不计提成（¥0）
                    </p>
                  )}
                  <div className="mt-3 space-y-3">
                    {sec.items.map((item, index) => (
                      <div
                        key={`${item.ref_no}-${index}`}
                        className="flex items-start justify-between gap-3 border-t pt-3 first:border-t-0 first:pt-0"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {item.product_name || item.ref_no}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {item.ref_no}
                            {item.sku_code ? ` · ${item.sku_code}` : ''}
                          </p>
                          {item.occurred_at && (
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {fmtDatetime(item.occurred_at)}
                            </p>
                          )}
                        </div>
                        <div className="shrink-0 text-right">
                          <p
                            className={`text-sm font-semibold ${
                              item.is_overdue
                                ? 'text-muted-foreground line-through'
                                : ''
                            }`}
                          >
                            {money(item.commission)}
                          </p>
                          {item.kind === 'purchase' && (
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              毛利 {money(item.base_amount)}
                            </p>
                          )}
                          {item.is_overdue && (
                            <p className="mt-0.5 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700 dark:bg-amber-950/40 dark:text-amber-400">
                              逾期·不发提成
                            </p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </>
      )}
    </div>
  );
};

export default ErpPayslipPage;

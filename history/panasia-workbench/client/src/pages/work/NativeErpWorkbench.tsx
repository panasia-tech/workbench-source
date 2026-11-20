import { Link } from 'react-router-dom';
import { ArrowUpRight, ChevronRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import type {
  ErpCommissionStats,
  ErpDashboardSummary,
  ErpMe,
  ErpWorkloadStats,
} from '@shared/api.interface';
import {
  ERP_ROLE_LABELS,
  ERP_STAT_H5_PATHS,
  erpEntriesForRole,
  erpWorkVisibility,
} from './erp-entries';

interface NativeErpWorkbenchProps {
  me: ErpMe;
  summary: ErpDashboardSummary | null;
  workload: ErpWorkloadStats | null;
  commission: ErpCommissionStats | null;
  /** 打开免登 H5 深链（createErpEntry 的 url + '#' + h5Path） */
  onOpenH5: (h5Path: string) => void;
  openingPath: string | null;
}

function money(value: number | null | undefined): string {
  return `¥${Number(value ?? 0).toFixed(2)}`;
}

/**
 * 绑定 ERP 后的原生业务工作台（替代原 /work/erp iframe）：
 * 今日概览 + 预计工资 + 业务入口。数据来自 /api/erp-api/*（服务端代持员工 JWT）。
 */
const NativeErpWorkbench = ({
  me,
  summary,
  workload,
  commission,
  onOpenH5,
  openingPath,
}: NativeErpWorkbenchProps) => {
  const role = me.staff.role;
  const visibility = erpWorkVisibility(role);
  const entries = erpEntriesForRole(role);
  const showStatsGrid =
    visibility.showInspectStat ||
    visibility.showInStockStat ||
    visibility.showPurchaseStat ||
    visibility.showOutboundStat;
  const showCommissionRows =
    visibility.showPurchaseCommission ||
    visibility.showWarehouseCommission ||
    visibility.showSalesCommission;

  const statCards: {
    key: string;
    label: string;
    value: number | null | undefined;
  }[] = [
    visibility.showInspectStat
      ? { key: 'inspect', label: '待验货', value: summary?.pending_inspect }
      : null,
    visibility.showInStockStat
      ? { key: 'inStock', label: '在库', value: summary?.in_stock }
      : null,
    visibility.showPurchaseStat
      ? { key: 'purchase', label: '今日采购', value: summary?.today_purchase }
      : null,
    visibility.showOutboundStat
      ? { key: 'outbound', label: '今日出库', value: summary?.today_outbound }
      : null,
  ].filter((card): card is NonNullable<typeof card> => card !== null);

  const commissionRows: { label: string; value: number | undefined }[] = [
    visibility.showPurchaseCommission
      ? {
          label: '采购提成',
          value: commission?.purchase_commission,
        }
      : null,
    visibility.showWarehouseCommission
      ? {
          label: '仓管提成',
          value: commission?.warehouse_commission,
        }
      : null,
    visibility.showSalesCommission
      ? { label: '销售提成', value: commission?.sales_commission }
      : null,
  ].filter((row): row is NonNullable<typeof row> => row !== null);

  return (
    <div className="space-y-6">
      {/* 用户信息 + 今日工作量（照 miniprogram profile 页头部） */}
      <Card>
        <CardContent className="p-5">
          <div className="flex items-center gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-lg font-semibold text-primary">
              {(me.staff.name || me.staff.username || '?').slice(0, 1)}
            </span>
            <div>
              <p className="text-base font-semibold">
                {me.staff.name || me.staff.username}
              </p>
              <p className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {ERP_ROLE_LABELS[role] ?? role}
                </span>
                <span>@{me.staff.username}</span>
              </p>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-3 divide-x rounded-lg border">
            {(
              [
                { label: '今日采购', value: workload?.today_purchase },
                { label: '验货', value: workload?.today_inspection },
                { label: '出库', value: workload?.today_sales },
              ] as const
            ).map((metric) => (
              <div key={metric.label} className="px-3 py-2 text-center">
                <p className="text-lg font-semibold">
                  {metric.value ?? '—'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {metric.label}
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* 库存概览（按角色控制可见卡，口径照 miniprogram profile 页） */}
      {showStatsGrid && (
        <div
          data-ai-section-type="card-stat"
          className="grid grid-cols-2 gap-4 lg:grid-cols-4"
        >
          {statCards.map((card) => (
            <button
              key={card.key}
              type="button"
              onClick={() => onOpenH5(ERP_STAT_H5_PATHS[card.key])}
              className="rounded-xl border bg-card p-5 text-left transition-shadow hover:shadow-md"
            >
              <p className="text-2xl font-semibold">{card.value ?? '—'}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {card.label}
              </p>
            </button>
          ))}
        </div>
      )}

      {/* 预计工资（今日提成摘要，明细去工资单页） */}
      {commission && (
        <Card>
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">预计工资</p>
              <span className="text-xs text-muted-foreground">今日</span>
            </div>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-sm text-muted-foreground">合计</span>
              <span className="text-xl font-semibold">
                {money(commission.total_commission)}
              </span>
            </div>
            {showCommissionRows && commissionRows.length > 0 && (
              <div className="mt-3 space-y-1.5 border-t pt-3">
                {commissionRows.map((row) => (
                  <div
                    key={row.label}
                    className="flex items-center justify-between text-sm"
                  >
                    <span className="text-muted-foreground">
                      {row.label}
                    </span>
                    <span>{money(row.value)}</span>
                  </div>
                ))}
              </div>
            )}
            <Link
              to="/my/erp-payslip"
              className="mt-3 flex items-center justify-between border-t pt-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              工资单明细（今日 / 昨日 / 本周 / 本月 / 任意月）
              <ChevronRight className="h-4 w-4" />
            </Link>
          </CardContent>
        </Card>
      )}

      {/* 业务入口：本期全部走免登 H5 深链新标签页打开（模块逐个原生化后切内部路由） */}
      <div>
        <h2 className="mb-3 text-base font-semibold">业务入口</h2>
        <div
          data-ai-section-type="card-menu"
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {entries.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => onOpenH5(entry.h5Path)}
              disabled={openingPath !== null}
              className="rounded-xl border bg-card p-5 text-left transition-shadow hover:shadow-md disabled:opacity-60"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold">{entry.title}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {entry.sub}
                  </p>
                </div>
                <span className="shrink-0 text-muted-foreground">
                  {entry.icon}
                </span>
              </div>
              <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                <span>在 ERP 手机版打开</span>
                {openingPath === entry.h5Path ? (
                  <span>打开中…</span>
                ) : (
                  <ArrowUpRight className="h-4 w-4" />
                )}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default NativeErpWorkbench;

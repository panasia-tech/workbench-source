import React from 'react';

import type { AdminKpiRow } from '@shared/api.interface';

interface KpiStripProps {
  rows: AdminKpiRow[];
}

/** 管理端 KPI 薄横条：border 卡内 px-4 py-2 单行，小灰 label + 中字数值，竖线分隔 */
const KpiStrip: React.FC<KpiStripProps> = ({ rows }) => {
  return (
    <div
      data-ai-section-type="card-stat"
      className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border bg-card px-4 py-2"
    >
      {rows.map((row: AdminKpiRow, index: number) => (
        <React.Fragment key={row.label}>
          {index > 0 && (
            <span className="hidden h-8 w-px bg-border sm:block" aria-hidden />
          )}
          <div className="flex items-baseline gap-2 whitespace-nowrap">
            <span className="text-xs text-muted-foreground">{row.label}</span>
            <span className="text-lg font-semibold tabular-nums">
              {row.value}
            </span>
            {row.hint && (
              <span className="hidden text-xs text-muted-foreground lg:inline">
                {row.hint}
              </span>
            )}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
};

export default KpiStrip;

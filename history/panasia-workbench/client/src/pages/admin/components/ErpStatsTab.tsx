import React from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';

import AdminErpStatsSection from '../AdminErpStatsSection';

/**
 * 管理 Dock「经营统计」Tab：ERP 周期统计 + 最近业务动态（要 ERP ADMIN 角色，403 友好提示）。
 * 也支持深链 /admin/erp-stats。
 */
const ErpStatsTab: React.FC = () => {
  return (
    <div className="space-y-4">
      <Link
        to="/admin/erp-stats"
        className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        打开独立页面
        <ChevronRight className="h-3.5 w-3.5" />
      </Link>
      <AdminErpStatsSection />
    </div>
  );
};

export default ErpStatsTab;

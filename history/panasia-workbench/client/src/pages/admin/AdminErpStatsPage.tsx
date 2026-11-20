import React from 'react';
import { BarChart3 } from 'lucide-react';

import AdminErpStatsSection from './AdminErpStatsSection';

/**
 * ERP 经营统计（管理端路由页 /admin/erp-stats）。
 * 入口：管理 Dock「管理 → 经营统计」Tab；数据要 ERP ADMIN 角色，页面内做 403 友好提示。
 */
const AdminErpStatsPage: React.FC = () => {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <BarChart3 className="h-5 w-5 text-primary" />
          经营统计
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          ERP 采购 / 销售周期统计与最近业务动态，数据以 ERP 为准。
        </p>
      </div>
      <AdminErpStatsSection />
    </div>
  );
};

export default AdminErpStatsPage;

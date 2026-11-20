import React from 'react';
import { Settings2 } from 'lucide-react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import AuditTab from './components/AuditTab';
import CatalogTab from './components/CatalogTab';
import DevRequestsTab from './components/DevRequestsTab';
import ConfigTab from './components/ConfigTab';
import EmployeesTab from './components/EmployeesTab';
import ErpStatsTab from './components/ErpStatsTab';
import ExternalMcpTab from './components/ExternalMcpTab';
import HostedCustomersTab from './components/HostedCustomersTab';
import OkrTab from './components/OkrTab';
import PerformanceTab from './components/PerformanceTab';
import TutorialAuthoringTab from './components/TutorialAuthoringTab';
import TutorialReviewTab from './components/TutorialReviewTab';

const AdminManagePage: React.FC = () => {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Settings2 className="h-5 w-5 text-primary" />
          管理
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          员工、目录、教程、开发需求、绩效、OKR、托管客户、外部 MCP、审计与系统配置入口。
        </p>
      </div>

      <Tabs defaultValue="config">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="employees">员工绑定</TabsTrigger>
          <TabsTrigger value="erp-stats">经营统计</TabsTrigger>
          <TabsTrigger value="catalog">工单目录</TabsTrigger>
          <TabsTrigger value="hosted-customers">托管客户</TabsTrigger>
          <TabsTrigger value="tutorial">教程审核</TabsTrigger>
          <TabsTrigger value="tutorial-authoring">教程模板</TabsTrigger>
          <TabsTrigger value="dev-requests">开发需求</TabsTrigger>
          <TabsTrigger value="performance">绩效看板</TabsTrigger>
          <TabsTrigger value="okr">OKR</TabsTrigger>
          <TabsTrigger value="external-mcp">外部 MCP</TabsTrigger>
          <TabsTrigger value="audit">审计日志</TabsTrigger>
          <TabsTrigger value="config">系统配置</TabsTrigger>
        </TabsList>

        <TabsContent value="employees" className="mt-4">
          <EmployeesTab />
        </TabsContent>
        <TabsContent value="erp-stats" className="mt-4">
          <ErpStatsTab />
        </TabsContent>
        <TabsContent value="catalog" className="mt-4">
          <CatalogTab />
        </TabsContent>
        <TabsContent value="hosted-customers" className="mt-4">
          <HostedCustomersTab />
        </TabsContent>
        <TabsContent value="tutorial-authoring" className="mt-4">
          <TutorialAuthoringTab />
        </TabsContent>
        <TabsContent value="tutorial" className="mt-4">
          <TutorialReviewTab />
        </TabsContent>
        <TabsContent value="dev-requests" className="mt-4">
          <DevRequestsTab />
        </TabsContent>
        <TabsContent value="performance" className="mt-4">
          <PerformanceTab />
        </TabsContent>
        <TabsContent value="okr" className="mt-4">
          <OkrTab />
        </TabsContent>
        <TabsContent value="external-mcp" className="mt-4">
          <ExternalMcpTab />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <AuditTab />
        </TabsContent>
        <TabsContent value="config" className="mt-4">
          <ConfigTab />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default AdminManagePage;

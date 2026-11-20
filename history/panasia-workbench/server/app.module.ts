import { APP_FILTER } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { PlatformModule } from '@lark-apaas/fullstack-nestjs-core';

import { GlobalExceptionFilter } from './common/filters/exception.filter';
import { ViewModule } from './modules/view/view.module';
import { IntegrationModule } from './modules/integration/integration.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { ProfileModule } from './modules/profile/profile.module';
import { WorkModule } from './modules/work/work.module';
import { PerformanceModule } from './modules/performance/performance.module';
import { WorkordersModule } from './modules/workorders/workorders.module';
import { DemoModule } from './modules/demo/demo.module';
import { AdminModule } from './modules/admin/admin.module';
import { ProblemsModule } from './modules/problems/problems.module';
import { OkrModule } from './modules/okr/okr.module';
import { McpOpenApiModule } from './modules/mcp-openapi/mcp-openapi.module';
import { HostedCustomersModule } from './modules/hosted-customers/hosted-customers.module';
import { ErpBridgeModule } from './modules/erp-bridge/erp-bridge.module';
import { ErpApiModule } from './modules/erp-api/erp-api.module';
import { AuthModule } from './modules/auth/auth.module';
import { FilesModule } from './modules/files/files.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { DevRequestsModule } from './modules/dev-requests/dev-requests.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { OAuthModule } from './modules/oauth/oauth.module';
import { AcceptanceModule } from './modules/acceptance/acceptance.module';
import { ExternalMcpModule } from './modules/external-mcp/external-mcp.module';

@Module({
  imports: [
    // 平台 Module，提供平台能力
    PlatformModule.forRoot({
      mcp: {
        serverName: 'panasia-workbench',
        serverVersion: '1.0.0',
        instructions:
          '泛亚员工工作台：教程中心步骤表单字段管理与查询（豆包工作伙伴可用）',
      },
    }),
    // ====== @route-section: business-modules START ======
    // Place all business modules here.Do NOT add fallback modules here.
    // 独立部署的登录（Authentik + 自签会话 + 开放接口 key），须在 ViewModule 之前注册 /auth 路由
    AuthModule,
    IntegrationModule,
    TasksModule,
    ProjectsModule,
    ProfileModule,
    WorkModule,
    PerformanceModule,
    WorkordersModule,
    DemoModule,
    AdminModule,
    ProblemsModule,
    OkrModule,
    McpOpenApiModule,
    HostedCustomersModule,
    ErpBridgeModule,
    // ERP 业务接口原生代理（员工 JWT 服务端代持，业务工作台不再 iframe）
    ErpApiModule,
    FilesModule,
    // 站内消息（通知主通道；飞书只是可选的第二通道）
    NotificationsModule,
    // 开发需求（10-19）：报价确认、交付验收、只记账的台账
    DevRequestsModule,
    // 个人 API Key（10-22）：每人签自己的 key 调 /openapi/mcp，身份=本人
    ApiKeysModule,
    // OAuth 授权（10-25）：ChatGPT 网页版等填不了请求头的 MCP 客户端走 OAuth，身份=授权的人
    OAuthModule,
    // 提交版本与验收记录（11-10 销售工作台 A02）：研究通过 / 经营批准 / 上架确认各记各的
    AcceptanceModule,
    // 外部 MCP 登记与连通测试（11-10 销售工作台 A03）
    ExternalMcpModule,
    // ====== @route-section: business-modules END ======

    // ⚠️ @route-order: last
    // ViewModule is the fallback route module, must be registered last.
    ViewModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}

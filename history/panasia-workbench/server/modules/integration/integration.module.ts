import { Global, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { NotificationsModule } from '../notifications/notifications.module';
import { CredentialsService } from './credentials.service';
import { PlaneService } from './plane.service';
import { FrappeService } from './frappe.service';
import { BindingService } from './binding.service';
import { AilyOpenApiService } from './aily-openapi.service';
import { AilyWebhookService } from './aily-webhook.service';
import { AuditService } from './audit.service';
import { NotifyService } from './notify.service';
import { FeishuWikiService } from './feishu-wiki.service';
import { IntegrationsController } from './integrations.controller';

@Global()
@Module({
  // NotifyService 先写站内消息（InboxService），飞书只是可选的第二通道
  imports: [HttpModule, NotificationsModule],
  controllers: [IntegrationsController],
  providers: [
    CredentialsService,
    PlaneService,
    FrappeService,
    BindingService,
    AilyOpenApiService,
    AilyWebhookService,
    AuditService,
    NotifyService,
    FeishuWikiService,
  ],
  exports: [
    CredentialsService,
    PlaneService,
    FrappeService,
    BindingService,
    AilyOpenApiService,
    AilyWebhookService,
    AuditService,
    NotifyService,
    FeishuWikiService,
  ],
})
export class IntegrationModule {}

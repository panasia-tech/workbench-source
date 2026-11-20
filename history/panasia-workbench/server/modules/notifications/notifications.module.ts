import { Module } from '@nestjs/common';

import { DemoModule } from '../demo/demo.module';
import { InboxService } from './inbox.service';
import { NotificationsController } from './notifications.controller';

/**
 * 站内消息（10-18 定：工作台脱离飞书独立使用，通知以站内消息为主通道）。
 * InboxService 由 IntegrationModule 的 NotifyService 引用，所以这里导出。
 */
@Module({
  imports: [DemoModule],
  controllers: [NotificationsController],
  providers: [InboxService],
  exports: [InboxService],
})
export class NotificationsModule {}

import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request } from 'express';

import { DemoViewService } from '../demo/demo-view.service';
import { InboxService } from './inbox.service';
import type {
  NotificationListResponse,
  NotificationReadResponse,
  NotificationUnreadResponse,
} from '@shared/api.interface';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 员工端 / 管理端共用 · 站内消息（只看、只标自己的；演示视角按被演示的账号算） */
@Controller('api/notifications')
export class NotificationsController {
  constructor(
    private readonly inbox: InboxService,
    private readonly demoView: DemoViewService,
  ) {}

  @NeedLogin()
  @Get()
  async list(
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<NotificationListResponse> {
    const view = await this.demoView.resolve(req);
    return this.inbox.list(view.userId, page, pageSize);
  }

  @NeedLogin()
  @Get('unread-count')
  async unreadCount(@Req() req: Request): Promise<NotificationUnreadResponse> {
    const view = await this.demoView.resolve(req);
    return { unreadCount: await this.inbox.unreadCount(view.userId) };
  }

  @NeedLogin()
  @Post('read-all')
  async markAllRead(@Req() req: Request): Promise<NotificationReadResponse> {
    const view = await this.demoView.resolve(req);
    const updated = await this.inbox.markAllRead(view.userId);
    return { updated, unreadCount: await this.inbox.unreadCount(view.userId) };
  }

  @NeedLogin()
  @Post(':id/read')
  async markRead(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<NotificationReadResponse> {
    const view = await this.demoView.resolve(req);
    // 不是 UUID 直接 404，别让库报类型错变 500；别人的消息同样 404
    const updated = UUID_PATTERN.test(id)
      ? await this.inbox.markRead(view.userId, id)
      : null;
    if (updated === null) {
      throw new NotFoundException('消息不存在');
    }
    return { updated, unreadCount: await this.inbox.unreadCount(view.userId) };
  }
}

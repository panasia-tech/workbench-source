import { Controller, Get, Render, Req } from '@nestjs/common';
import type { Request } from 'express';
import { safeEscapeDeep } from '@lark-apaas/fullstack-nestjs-core';

import { AuthConfig } from '../auth/auth.config';

const APP_NAME = '泛亚工作台';
const APP_DESCRIPTION = '泛亚员工工作台';

@Controller()
export class ViewController {
  constructor(private readonly authConfig: AuthConfig) {}

  @Get(['/', '*'])
  @Render('index')
  async render(@Req() req: Request): Promise<Record<string, unknown>>  {
    // 独立部署：平台 ViewContextMiddleware 取不到应用信息（应用名、basename、是否显示「妙搭生成」角标），
    // 这里给定值覆盖。返回值会盖过 res.locals 里的同名模板变量。
    const basename = this.authConfig.basePath || '/';
    const appAvatar = `${this.authConfig.basePath}/favicon.svg`;
    const standalone = safeEscapeDeep({
      appId: '',
      appName: APP_NAME,
      appAvatar,
      appDescription: APP_DESCRIPTION,
      basename,
      showBadge: false,
      // 前端 getInitialInfo 优先读预置数据，有了它就不再去请求平台的 get_published，角标也不显示
      appPublished: {
        app_info: {
          app_name: APP_NAME,
          app_avatar: appAvatar,
          app_description: APP_DESCRIPTION,
          show_badge: false,
        },
      },
    });
    const platformData = { ...(req.__platform_data__ ?? {}), ...standalone };
    return {
      appId: '',
      appName: standalone.appName,
      appAvatar: standalone.appAvatar,
      appDescription: standalone.appDescription,
      basename: standalone.basename,
      // don't delete this line, it's used by client to get platform info
      __platform__: JSON.stringify(platformData),
    };
  }
}

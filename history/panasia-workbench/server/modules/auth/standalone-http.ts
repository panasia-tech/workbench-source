import { join } from 'path';
import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AuthConfig } from './auth.config';
import { AuthGateService } from './auth-gate.service';

/**
 * 独立部署要在 Nest 模块中间件之前装上的 Express 层：
 * 1. /healthz：给反代和容器探活，不登录、不碰库
 * 2. /assets/*：前端构建产物（妙搭上走 CDN，平台静态中间件特意跳过了 assets/）
 * 3. 登录闸门：剥外来身份头、按会话 / 开放接口 key 写回身份头
 *
 * 必须在 configureApp() 之后（要用它装的 cookie-parser）、app.listen() 之前调用：
 * app.use() 立即生效，而模块中间件（平台 UserContextMiddleware 等）要到 init 时才挂，
 * 所以闸门一定排在它们前面。
 */
export function installStandaloneHttp(app: NestExpressApplication): void {
  const config = app.get(AuthConfig);
  const gate = app.get(AuthGateService);
  const base = config.basePath;

  app.use(`${base}/healthz`, (_req: Request, res: Response): void => {
    res.json({ ok: true });
  });

  app.useStaticAssets(join(process.cwd(), 'dist/client/assets'), {
    prefix: `${base}/assets/`,
    index: false,
    immutable: true,
    maxAge: '365d',
  });
  // 文件名带哈希，找不到就是 404，别落到页面渲染里去
  app.use(`${base}/assets`, (_req: Request, res: Response): void => {
    res.status(404).end();
  });

  app.use((req: Request, res: Response, next: NextFunction): void => {
    gate.handle(req, res, next).catch(next);
  });
}

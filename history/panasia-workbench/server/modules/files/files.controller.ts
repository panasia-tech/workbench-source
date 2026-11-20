import { Controller, Post, Req, Res } from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request, Response } from 'express';

import { FilesService } from './files.service';

/** 文件上传：员工端头像、任务/工单/教程凭证都走这里，由服务端带口令转给文件网关 */
@Controller('api/files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @NeedLogin()
  @Post('upload')
  async upload(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.files.forwardUpload(req, res, String(req.userContext.userId ?? ''));
  }
}

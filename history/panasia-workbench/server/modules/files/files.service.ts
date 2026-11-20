import { Injectable, Logger } from '@nestjs/common';
import { Readable } from 'stream';
import type { Request, Response } from 'express';

import { CredentialsService } from '../integration/credentials.service';

/** 公司文件网关（京东云 wb-files，文件进阿里云 OSS），下载 URL 公开、上传要口令 */
const DEFAULT_FILES_BASE = 'http://127.0.0.1:8000';
const DEFAULT_MAX_MB = 500;
const UPLOAD_TIMEOUT_MS = 300_000;

function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message, timestamp: Date.now() } });
}

/**
 * 上传转发：前端把文件传给工作台服务端，服务端带口令转给文件网关。
 * 口令（WORKBENCH_UPLOAD_TOKEN）只在服务端环境变量 / system_configs，不再打进前端包。
 * 请求体原样流式转发，不落盘、不进内存。
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(private readonly credentials: CredentialsService) {}

  async forwardUpload(req: Request, res: Response, userId: string): Promise<void> {
    const token = await this.credentials.get('WORKBENCH_UPLOAD_TOKEN');
    if (!token) {
      sendError(res, 503, 'SERVICE_UNAVAILABLE', '文件上传还没配置好（缺 WORKBENCH_UPLOAD_TOKEN）');
      return;
    }
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      sendError(res, 400, 'BAD_REQUEST', '上传要用 multipart/form-data');
      return;
    }
    const length = Number(req.headers['content-length']);
    if (!Number.isFinite(length) || length <= 0) {
      sendError(res, 411, 'BAD_REQUEST', '上传请求缺 Content-Length');
      return;
    }
    const maxMb = Number(process.env.WORKBENCH_UPLOAD_MAX_MB ?? DEFAULT_MAX_MB);
    const maxBytes = (Number.isFinite(maxMb) && maxMb > 0 ? maxMb : DEFAULT_MAX_MB) * 1024 * 1024;
    if (length > maxBytes) {
      sendError(res, 413, 'BAD_REQUEST', `文件太大，单次上传不超过 ${Math.round(maxBytes / 1024 / 1024)} MB`);
      return;
    }
    const base = (process.env.WORKBENCH_FILES_BASE ?? DEFAULT_FILES_BASE).replace(/\/+$/, '');
    // 流式请求体必须带 duplex: 'half'（Node fetch 要求；DOM 版 RequestInit 类型里没有这个字段）
    const init: RequestInit & { duplex: 'half' } = {
      method: 'POST',
      headers: {
        'content-type': contentType,
        'content-length': String(length),
        'x-upload-token': token,
      },
      body: Readable.toWeb(req) as unknown as BodyInit,
      duplex: 'half',
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    };
    let upstream: Awaited<ReturnType<typeof fetch>>;
    try {
      upstream = await fetch(`${base}/upload`, init);
    } catch (error) {
      this.logger.warn(
        `上传转发失败（user=${userId}）：${error instanceof Error ? error.message : String(error)}`,
      );
      sendError(res, 502, 'BAD_GATEWAY', '文件网关连不上，请稍后重试');
      return;
    }
    const text = await upstream.text();
    if (!upstream.ok) {
      this.logger.warn(
        `文件网关拒绝上传（user=${userId}）：HTTP ${upstream.status} ${text.slice(0, 200)}`,
      );
      // 网关的 401/403 是口令问题，不能原样回给前端（前端会当成登录过期）
      if (upstream.status === 413) {
        sendError(res, 413, 'BAD_REQUEST', '文件太大，文件网关拒收');
      } else {
        sendError(res, 502, 'BAD_GATEWAY', `文件网关拒绝了上传（HTTP ${upstream.status}）`);
      }
      return;
    }
    res
      .status(200)
      .type(upstream.headers.get('content-type') ?? 'application/json')
      .send(text);
  }
}

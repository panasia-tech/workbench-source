/**
 * 采购工作台 × 闲鱼监控助手 v6.0 全栈服务端入口
 * 职责：SQLite WAL 数据引擎 + REST/SSE/xy-sxjk 鉴权路由 + 206 视频流 + Vite 编译前端静态托管
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db/database.js';
import { handleApiRoute } from './routes/api.js';
import { startBackgroundMonitorLoop, stopBackgroundMonitorLoop } from './services/monitor-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.ico': 'image/x-icon',
};

function safeResolveUnder(baseDir, reqSubPath) {
  const clean = decodeURIComponent(reqSubPath).replace(/^\/+/, '');
  const resolved = path.resolve(baseDir, clean);
  if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
    return null;
  }
  return resolved;
}

function serveFileWithRange(req, res, filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('not file');
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, code: 'FILE_NOT_FOUND', message: '资源文件不存在' }));
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_MAP[ext] || 'application/octet-stream';
  const total = stat.size;
  const range = req.headers.range;

  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
    if (start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'Accept-Ranges': 'bytes',
    'Content-Length': total,
    'Content-Type': contentType,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  fs.createReadStream(filePath).pipe(res);
}

export function createAppServer(opts = {}) {
  const dbPath = opts.dbPath || process.env.DB_PATH || path.join(ROOT_DIR, 'data', 'panasia_v6.sqlite');
  const db = openDatabase(dbPath);
  if (!opts.disableBackgroundLoop) {
    startBackgroundMonitorLoop(db);
  }

  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = urlObj.pathname;

    if (pathname.startsWith('/api/') || pathname.startsWith('/app/xy-sxjk/')) {
      await handleApiRoute(db, req, res, urlObj);
      return;
    }

    if (pathname.startsWith('/media/')) {
      const fp = safeResolveUnder(path.join(PUBLIC_DIR, 'media'), pathname.slice('/media/'.length));
      if (!fp) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      serveFileWithRange(req, res, fp);
      return;
    }

    if (pathname.startsWith('/evidence/')) {
      const fp = safeResolveUnder(path.join(PUBLIC_DIR, 'evidence'), pathname.slice('/evidence/'.length));
      if (!fp) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      serveFileWithRange(req, res, fp);
      return;
    }

    // 静态托管 Vite 编译产物 dist/
    const relPath = pathname === '/' ? 'index.html' : pathname.slice(1);
    const candidate = safeResolveUnder(DIST_DIR, relPath);
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      serveFileWithRange(req, res, candidate);
      return;
    }

    const indexHtml = path.join(DIST_DIR, 'index.html');
    if (fs.existsSync(indexHtml)) {
      serveFileWithRange(req, res, indexHtml);
      return;
    }

    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('前端尚未构建，请先运行 npm run build:web');
  });

  async function start(port = Number(process.env.PORT || 5860), host = process.env.HOST || '127.0.0.1') {
    await new Promise((resolve) => server.listen(port, host, resolve));
    return server.address();
  }

  async function close() {
    stopBackgroundMonitorLoop();
    await new Promise((resolve) => server.close(resolve));
    try {
      db.close();
    } catch {
      // ignore close err
    }
  }

  return { server, db, start, close };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const app = createAppServer();
  const port = Number(process.env.PORT || 5860);
  const host = process.env.HOST || '127.0.0.1';
  const addr = await app.start(port, host);
  console.log(`[PanAsia Workbench × Xianyu Monitor v6.0] listening at http://${addr.address}:${addr.port}`);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      await app.close();
      process.exit(0);
    });
  }
}

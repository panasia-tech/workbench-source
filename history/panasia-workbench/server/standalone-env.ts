/**
 * 独立部署（脱离妙搭）的启动前环境准备，必须是 main.ts 的第一个 import。
 *
 * 平台的 ConfigModule 要等 AppModule 加载时才读 .env，而平台 SDK 有些变量在那之前就要用，
 * 所以这里先读一遍 .env.local / .env（不覆盖已有的进程环境变量），再补齐外面没有的平台变量。
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { config as loadDotenv } from 'dotenv';

for (const file of ['.env.local', '.env']) {
  const fullPath = join(process.cwd(), file);
  if (existsSync(fullPath)) {
    loadDotenv({ path: fullPath, quiet: true });
  }
}

// 平台 HttpClient 构造时必须有平台内网域名，否则启动直接抛错。外面没有平台，
// 指向本机一个不监听的端口：残留的平台调用（权限查询、通讯录、HTML 热更新等）立即失败而不是挂起。
if (!process.env.FORCE_AUTHN_INNERAPI_DOMAIN) {
  process.env.FORCE_AUTHN_INNERAPI_DOMAIN = 'http://127.0.0.1:9';
}

// 数据库连接串：平台注入的是 SUDA_DATABASE_URL，独立部署也认通用的 DATABASE_URL
if (!process.env.SUDA_DATABASE_URL && process.env.DATABASE_URL) {
  process.env.SUDA_DATABASE_URL = process.env.DATABASE_URL;
}

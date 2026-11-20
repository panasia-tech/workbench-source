import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'crypto';

/**
 * 外部 MCP 密钥加密存（AES-256-GCM）。加密密钥由 AUTH_SESSION_SECRET 派生（用途串单独一份，和登录票据互不通用）。
 * 换了 AUTH_SESSION_SECRET 以后旧密钥解不开，「测试连接」会提示重填。格式 v1.<iv>.<tag>.<密文>（base64url）。
 */
const PURPOSE = 'panasia-workbench/external-mcp-secret/v1';

export function deriveSecretKey(sessionSecret: Buffer): Buffer {
  return createHmac('sha256', sessionSecret).update(PURPOSE).digest();
}

export function sealSecret(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv, tag, encrypted].map((part) => (typeof part === 'string' ? part : part.toString('base64url'))).join('.');
}

/** 解不开（格式不对、密钥换过）返回 null */
export function openSecret(key: Buffer, sealed: string): string | null {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const data = Buffer.from(parts[3], 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

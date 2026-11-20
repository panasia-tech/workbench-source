/**
 * 正式身份鉴权与安全会话（Node.js 原生 crypto: scrypt + HMAC-SHA256 JWT）
 * 严禁信任客户端在 body 中传入的伪造 actor_id / role，所有接口一律以已验证 JWT 内的数据库角色为准。
 */
import crypto from 'node:crypto';

const JWT_SECRET = crypto.randomBytes(32);
const TOKEN_TTL_SEC = 7 * 24 * 3600;
const MAX_LOGIN_FAILS = 5;
const LOCK_WINDOW_MS = 5 * 60 * 1000;

export const ROLE_LABELS = {
  ADMIN: '采购主管',
  PURCHASER: '采购业务员',
  WAREHOUSE: '仓库质检',
  FINANCE: '财务出纳',
};

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hex] = parts;
  try {
    const derived = crypto.scryptSync(String(password), salt, 32);
    const expected = Buffer.from(hex, 'hex');
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function b64url(objOrBuf) {
  const buf = Buffer.isBuffer(objOrBuf) ? objOrBuf : Buffer.from(JSON.stringify(objOrBuf), 'utf8');
  return buf.toString('base64url');
}

export function signToken(staff, ttlSec = TOKEN_TTL_SEC) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({
    sub: staff.id,
    username: staff.username,
    role: staff.role,
    iat: now,
    exp: now + ttlSec,
    jti: crypto.randomUUID(),
  });
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

export function verifyToken(token) {
  const raw = String(token || '').trim();
  const parts = raw.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!decoded.sub || !decoded.exp || decoded.exp * 1000 <= Date.now()) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function extractTokenFromHeaders(headers = {}) {
  const auth = String(headers.authorization || headers.Authorization || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const xErp = String(headers['x-erp-token'] || headers['X-Erp-Token'] || '').trim();
  return xErp || '';
}

export function sanitizeStaff(row) {
  if (!row) return null;
  let passed = [];
  try {
    passed = JSON.parse(row.practice_passed_gates || '[]');
  } catch {
    passed = [];
  }
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    role_label: ROLE_LABELS[row.role] || row.role,
    practice_passed_gates: passed,
    practice_unlocked: row.role !== 'PURCHASER' || passed.length >= 3,
    status: row.status,
    last_login_at: row.last_login_at,
  };
}

export function checkLoginThrottle(db, username, ip = '127.0.0.1') {
  const sinceIso = new Date(Date.now() - LOCK_WINDOW_MS).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS cnt FROM login_attempts
       WHERE username = ? AND ip = ? AND ok = 0 AND created_at >= ?`
    )
    .get(String(username || ''), String(ip || ''), sinceIso);
  return Number(row?.cnt || 0) >= MAX_LOGIN_FAILS;
}

export function recordLoginAttempt(db, username, ip, ok) {
  if (ok) {
    db.prepare(`DELETE FROM login_attempts WHERE username = ?`).run(String(username || ''));
    return;
  }
  db.prepare(
    `INSERT INTO login_attempts (id, username, ip, ok, created_at) VALUES (?, ?, ?, 0, ?)`
  ).run(crypto.randomUUID(), String(username || ''), String(ip || ''), new Date().toISOString());
}

export function resolveAuthenticatedStaff(db, headers) {
  const token = extractTokenFromHeaders(headers);
  if (!token) return null;
  const decoded = verifyToken(token);
  if (!decoded) return null;
  const row = db
    .prepare(`SELECT * FROM staff_users WHERE id = ? AND status = 'active'`)
    .get(String(decoded.sub));
  return sanitizeStaff(row);
}

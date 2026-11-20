import type { Request } from 'express';

/**
 * 这次请求的登录会话里只有服务端知道的事。登录闸门验过会话票据（服务端签名）后按请求对象记在这里，
 * 不经请求头，客户端带什么头都改不了。开放接口的系统身份、没登录的请求没有。
 */
export interface SessionFacts {
  kind: 'oidc' | 'dev';
  /** 会话里的工作台用户 ID（演示视角之前的真实登录人） */
  userId: string;
  /** 统一登录对照行 ID；开发登录为 null */
  accountId: string | null;
  /**
   * 工作台用户 ID 来自 ERP 身份：统一登录时 Authentik 给的 erp_sub 就是这个用户 ID（登录回调里核对，记进会话票据）。
   * 开发登录、10-19 之前签的会话都是 false
   */
  erpIdentity: boolean;
  /** 统一登录的登录名（Authentik 用户名，ERP 同步来的号就是 ERP 登录账号）；没有为 null */
  loginName: string | null;
}

const factsByRequest = new WeakMap<Request, SessionFacts>();

export function setSessionFacts(req: Request, facts: SessionFacts): void {
  factsByRequest.set(req, facts);
}

export function getSessionFacts(req: Request): SessionFacts | null {
  return factsByRequest.get(req) ?? null;
}

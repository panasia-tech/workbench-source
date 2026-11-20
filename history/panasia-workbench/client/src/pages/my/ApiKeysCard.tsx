import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  fetchApiKeys,
  fetchOAuthGrants,
  issueApiKey,
  revokeApiKey,
  revokeOAuthGrant,
} from '@client/src/api/apiKeys';
import type { ApiKeyListItem, OAuthGrantListItem } from '@shared/api.interface';

const MCP_ENDPOINT = 'http://127.0.0.1:8000';

function formatTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

/**
 * 个人 API Key（每人仅一把，可更换）：给 AI 工具（Codex / Kimi Code / lark cli 等）调工作台 MCP，
 * 调用身份 = 本人，能用的工具按本人平台角色分档（员工 task_*；boss 多 10 件管理工具；教程类不对个人 key 开放）。
 * 填不了请求头的（ChatGPT 网页版等）走 OAuth 授权，授权过的应用列在下面，可收回（10-25）
 */
const ApiKeysCard = () => {
  const [items, setItems] = useState<ApiKeyListItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [issuing, setIssuing] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [grants, setGrants] = useState<OAuthGrantListItem[]>([]);
  const [revokingGrantId, setRevokingGrantId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetchApiKeys()
      .then((res) => setItems(res.items))
      .catch(() => toast.error('获取 API Key 失败'))
      .finally(() => setLoading(false));
  }, []);

  // 授权列表读不到不打扰：没有授权时这块本来就不显示
  const loadGrants = useCallback(() => {
    fetchOAuthGrants()
      .then((res) => setGrants(res.items))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    loadGrants();
  }, [load, loadGrants]);

  const active = (items ?? []).find((item) => item.revokedAt === null) ?? null;

  const handleIssue = () => {
    setIssuing(true);
    issueApiKey('默认')
      .then((res) => {
        setFreshKey(res.key);
        setConfirmRotate(false);
        load();
      })
      .catch(() => toast.error('签发失败，请稍后重试'))
      .finally(() => setIssuing(false));
  };

  const handleRevoke = () => {
    if (!active) return;
    setRevoking(true);
    revokeApiKey(active.id)
      .then(() => {
        toast.success('已吊销');
        load();
      })
      .catch(() => toast.error('吊销失败，请稍后重试'))
      .finally(() => setRevoking(false));
  };

  const handleRevokeGrant = (id: string) => {
    setRevokingGrantId(id);
    revokeOAuthGrant(id)
      .then(() => {
        toast.success('已收回');
        loadGrants();
      })
      .catch(() => toast.error('收回失败，请稍后重试'))
      .finally(() => setRevokingGrantId(null));
  };

  const copyFreshKey = () => {
    if (!freshKey) return;
    navigator.clipboard
      .writeText(freshKey)
      .then(() => toast.success('已复制'))
      .catch(() => toast.error('复制失败，请手动选择复制'));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">API Key（给 AI 工具用）</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          每人一把 key，填进 AI 工具（Codex / Kimi Code / lark cli 等）它就能以<strong>你的身份</strong>调工作台
          MCP 接口。能用什么工具跟着你的角色走：员工可查自己的任务；老板另有发单 / 委派 / 审核工具；
          教程管理类不开放给个人 key。
        </p>

        {freshKey && (
          <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-3">
            <p className="text-sm font-medium text-amber-900">
              新 key 只显示这一次，请马上复制保存（旧 key 已立即失效）：
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="break-all rounded bg-white px-2 py-1 text-xs">{freshKey}</code>
              <Button size="sm" variant="outline" onClick={copyFreshKey}>
                复制
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFreshKey(null)}>
                我已保存
              </Button>
            </div>
          </div>
        )}

        {loading ? (
          <Skeleton className="h-16 w-full" />
        ) : active ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
              <div>
                <span className="font-medium">当前 key</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {active.keyPrefix}… ｜ 创建于 {formatTime(active.createdAt)} ｜ 最近使用{' '}
                  {formatTime(active.lastUsedAt)}
                </span>
              </div>
              <Button size="sm" variant="outline" onClick={handleRevoke} disabled={revoking}>
                吊销
              </Button>
            </div>
            {confirmRotate ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <span>更换后旧 key 立即失效，AI 工具里要重新填，确定更换？</span>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleIssue} disabled={issuing}>
                    确定更换
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirmRotate(false)}>
                    取消
                  </Button>
                </div>
              </div>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setConfirmRotate(true)}>
                更换新 key
              </Button>
            )}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">还没有 key，签一把就能用。</p>
            <Button size="sm" onClick={handleIssue} disabled={issuing}>
              签发我的 key
            </Button>
          </div>
        )}

        {grants.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">已授权的应用</p>
            {grants.map((grant) => (
              <div
                key={grant.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <div>
                  <span className="font-medium">{grant.clientName || '未命名应用'}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {grant.redirectLabel} ｜ 授权于 {formatTime(grant.createdAt)} ｜ 最近使用{' '}
                    {formatTime(grant.lastUsedAt)}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleRevokeGrant(grant.id)}
                  disabled={revokingGrantId === grant.id}
                >
                  收回
                </Button>
              </div>
            ))}
          </div>
        )}

        <details className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            接入方法（MCP 客户端配置）
          </summary>
          <div className="mt-2 space-y-2">
            <p>
              端点：<code className="rounded bg-white px-1">{MCP_ENDPOINT}</code>（POST，MCP
              streamable HTTP），请求头带{' '}
              <code className="rounded bg-white px-1">Authorization: Bearer 你的key</code>
            </p>
            <pre className="overflow-x-auto rounded bg-white p-2">{`# Codex / Kimi Code 等 MCP 客户端配置示例
{
  "mcpServers": {
    "panasia-workbench": {
      "url": "${MCP_ENDPOINT}",
      "headers": { "Authorization": "Bearer wk_xxxxxxxx" }
    }
  }
}`}</pre>
            <p>
              ChatGPT 网页版这类填不了请求头的：地址同上，认证选 OAuth，跳到工作台点「同意」就行，不用 key。
            </p>
            <p>key 泄露了马上来这里更换或吊销，旧 key 即时失效（最迟 1 分钟）。</p>
          </div>
        </details>
      </CardContent>
    </Card>
  );
};

export default ApiKeysCard;

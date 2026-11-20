import React, { useCallback, useEffect, useState } from 'react';
import dayjs from 'dayjs';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  createExternalMcp,
  deleteExternalMcp,
  listExternalMcp,
  testExternalMcp,
  updateExternalMcp,
} from '@client/src/api/externalMcp';
import type {
  ExternalMcpServerView,
  ExternalMcpUpsertRequest,
} from '@shared/api.interface';

interface FormState {
  name: string;
  url: string;
  authHeader: string;
  secret: string;
  /** 编辑时：勾了才清掉已存的密钥 */
  clearSecret: boolean;
  purpose: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  url: '',
  authHeader: '',
  secret: '',
  clearSecret: false,
  purpose: '',
  enabled: true,
};

function TestResult({ item }: { item: ExternalMcpServerView }) {
  const [showTools, setShowTools] = useState(false);
  const test = item.lastTest;
  if (!test) return <p className="text-xs text-muted-foreground">还没测过</p>;
  return (
    <div className="space-y-1 text-xs">
      <p className={`flex items-center gap-1 ${test.ok ? 'text-green-700' : 'text-destructive'}`}>
        {test.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
        {test.message}
        <span className="text-muted-foreground">
          · {dayjs(test.at).format('MM-DD HH:mm')}
          {test.latencyMs !== null ? ` · ${test.latencyMs} ms` : ''}
        </span>
      </p>
      {test.ok && test.tools.length > 0 ? (
        <div>
          <button
            type="button"
            className="text-muted-foreground underline-offset-2 hover:underline"
            onClick={() => setShowTools((prev: boolean) => !prev)}
          >
            {showTools ? '收起工具' : '看工具'}
          </button>
          {showTools ? (
            <div className="mt-1 flex flex-wrap gap-1">
              {test.tools.map((name: string) => (
                <span key={name} className="rounded bg-muted px-1.5 py-0.5 font-mono">
                  {name}
                </span>
              ))}
              {test.toolCount !== null && test.toolCount > test.tools.length ? (
                <span className="text-muted-foreground">等 {test.toolCount} 个</span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 管理 → 外部 MCP：登记要接的外部 MCP（名称、地址、密钥、用途、启停），「测试连接」真去连一次 */
const ExternalMcpTab: React.FC = () => {
  const [items, setItems] = useState<ExternalMcpServerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ExternalMcpServerView | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ExternalMcpServerView | null>(null);

  const load = useCallback(() => {
    setError(null);
    listExternalMcp()
      .then((res) => setItems(res.items))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const replaceItem = (next: ExternalMcpServerView) => {
    setItems((prev) =>
      prev === null ? [next] : prev.some((i) => i.id === next.id)
        ? prev.map((i) => (i.id === next.id ? next : i))
        : [...prev, next],
    );
  };

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormOpen(true);
  };

  const openEdit = (item: ExternalMcpServerView) => {
    setEditing(item);
    setForm({
      name: item.name,
      url: item.url,
      authHeader: item.authHeader ?? '',
      secret: '',
      clearSecret: false,
      purpose: item.purpose ?? '',
      enabled: item.enabled,
    });
    setFormOpen(true);
  };

  const runTest = (id: string) => {
    setTestingId(id);
    testExternalMcp(id)
      .then((res) => {
        replaceItem(res.item);
        if (res.item.lastTest?.ok) toast.success(res.item.lastTest.message);
        else toast.error(res.item.lastTest?.message ?? '没连上');
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : '测试没跑起来'))
      .finally(() => setTestingId(null));
  };

  const save = (andTest: boolean) => {
    if (form.name.trim() === '' || form.url.trim() === '') {
      toast.error('名称、地址都要填');
      return;
    }
    const body: Partial<ExternalMcpUpsertRequest> = {
      name: form.name.trim(),
      url: form.url.trim(),
      authHeader: form.authHeader.trim(),
      purpose: form.purpose.trim(),
      enabled: form.enabled,
    };
    if (form.secret.trim() !== '') body.secret = form.secret.trim();
    else if (editing && form.clearSecret) body.secret = '';
    setSaving(true);
    const request = editing
      ? updateExternalMcp(editing.id, body)
      : createExternalMcp(body as ExternalMcpUpsertRequest);
    request
      .then((res) => {
        replaceItem(res.item);
        setFormOpen(false);
        toast.success('已保存');
        if (andTest) runTest(res.item.id);
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : '没存上'))
      .finally(() => setSaving(false));
  };

  const toggleEnabled = (item: ExternalMcpServerView, enabled: boolean) => {
    updateExternalMcp(item.id, { enabled })
      .then((res) => replaceItem(res.item))
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : '没改成'));
  };

  const confirmDelete = () => {
    if (!deleting) return;
    const target = deleting;
    deleteExternalMcp(target.id)
      .then(() => {
        setItems((prev) => (prev ?? []).filter((i) => i.id !== target.id));
        setDeleting(null);
        toast.success('已删除');
      })
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : '没删掉'));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Plug className="h-4 w-4 text-primary" />
          外部 MCP
        </h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-4 w-4" />
            刷新
          </Button>
          <Button size="sm" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            登记
          </Button>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>加载失败</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : items === null ? (
        <Skeleton className="h-32 w-full rounded-xl" />
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          还没登记外部 MCP
        </p>
      ) : (
        <div data-ai-section-type="card-list" className="space-y-3">
          {items.map((item: ExternalMcpServerView) => (
            <div key={item.id} className="space-y-2 rounded-xl border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium">
                    {item.name}
                    {!item.enabled ? <Badge variant="secondary">已停用</Badge> : null}
                  </p>
                  <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
                    {item.url}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    密钥：
                    {item.hasSecret
                      ? `已填（${item.authHeader ? `放在 ${item.authHeader}` : 'Bearer'}）`
                      : '没填'}
                  </p>
                  {item.purpose ? <p className="mt-1 text-sm">{item.purpose}</p> : null}
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={item.enabled}
                    onCheckedChange={(checked: boolean) => toggleEnabled(item, checked)}
                    aria-label="启用"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={testingId !== null}
                    onClick={() => runTest(item.id)}
                  >
                    {testingId === item.id ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    测试连接
                  </Button>
                  <Button size="icon" variant="ghost" aria-label="编辑" onClick={() => openEdit(item)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="icon" variant="ghost" aria-label="删除" onClick={() => setDeleting(item)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <TestResult item={item} />
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={formOpen}
        onOpenChange={(open: boolean) => {
          if (!saving) setFormOpen(open);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? `改「${editing.name}」` : '登记外部 MCP'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="mcp-name">名称</Label>
              <Input
                id="mcp-name"
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mcp-url">地址</Label>
              <Input
                id="mcp-url"
                value={form.url}
                onChange={(e) => setForm((prev) => ({ ...prev, url: e.target.value }))}
                placeholder="https://example.com/mcp"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="mcp-secret">密钥</Label>
                <Input
                  id="mcp-secret"
                  type="password"
                  autoComplete="new-password"
                  value={form.secret}
                  onChange={(e) => setForm((prev) => ({ ...prev, secret: e.target.value }))}
                  placeholder={editing?.hasSecret ? '已填，不改留空' : '没有就留空'}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mcp-header">放在哪个请求头</Label>
                <Input
                  id="mcp-header"
                  value={form.authHeader}
                  onChange={(e) => setForm((prev) => ({ ...prev, authHeader: e.target.value }))}
                  placeholder="留空 = Authorization: Bearer"
                />
              </div>
            </div>
            {editing?.hasSecret ? (
              <label className="flex items-center gap-2 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  checked={form.clearSecret}
                  onChange={(e) => setForm((prev) => ({ ...prev, clearSecret: e.target.checked }))}
                />
                清掉已存的密钥
              </label>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="mcp-purpose">用途</Label>
              <Textarea
                id="mcp-purpose"
                rows={2}
                value={form.purpose}
                onChange={(e) => setForm((prev) => ({ ...prev, purpose: e.target.value }))}
                placeholder="接它做什么、谁在用"
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={form.enabled}
                onCheckedChange={(checked: boolean) =>
                  setForm((prev) => ({ ...prev, enabled: checked }))
                }
              />
              启用
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button variant="outline" onClick={() => save(false)} disabled={saving}>
              保存
            </Button>
            <Button onClick={() => save(true)} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              保存并测试
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{deleting?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>存的密钥一起删掉，不能恢复。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={confirmDelete}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default ExternalMcpTab;

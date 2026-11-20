import React, { useCallback, useEffect, useState } from 'react';
import { Bot, Clock, KeyRound, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  getAdminConfig,
  updateAdminConfig,
} from '@client/src/api/admin';
import { useOptionalIntegrations } from '@client/src/hooks/use-optional-integrations';
import type { OptionalIntegrations, SystemConfigItem } from '@shared/api.interface';

type AgentConfigMeta = {
  configKey: string;
  /** 要编辑的子字段：agent_id 项为 agent_id，发单助手为 chat_url */
  field: string;
  name: string;
  description: string;
  placeholder: string;
  /** 用到这项配置的可选集成：一个都没开时卡片标「未启用」（悬停看开关名） */
  features?: { key: keyof OptionalIntegrations; env: string }[];
};

const AGENT_CONFIGS: AgentConfigMeta[] = [
  {
    configKey: 'quick_task.draft_agent_id',
    field: 'agent_id',
    name: '快任务 AI 草稿',
    description: '豆包智能体 ID：快速下任务的 AI 草稿、堵塞后 AI 生成 SOP 共用',
    placeholder: '智能体 ID，如 aily_xxx',
    features: [
      { key: 'aiQuickTaskDraft', env: 'AILY_QUICK_TASK_DRAFT_ENABLED' },
      { key: 'aiSop', env: 'AILY_SOP_ENABLED' },
    ],
  },
  {
    configKey: 'workorder.dispatch_agent',
    field: 'chat_url',
    name: '豆包发单助手',
    description: '发单助手聊天链接，填入后执行 Dock 出现「去豆包发单」按钮',
    placeholder: '豆包发单助手的聊天链接',
  },
  {
    configKey: 'workorder.ai_review_agent_id',
    field: 'agent_id',
    name: '工单 AI 初审',
    description:
      '豆包智能体 ID，填入后工单提交凭证先过 AI 初审，未配置则直接送老板终审',
    placeholder: '智能体 ID，如 aily_xxx',
    features: [{ key: 'aiWorkorderReview', env: 'AILY_WORKORDER_REVIEW_ENABLED' }],
  },
  {
    configKey: 'task_review.webhook_url',
    field: 'webhook_url',
    name: '豆包 Webhook',
    description:
      '委派材料 AI 审核、顺延申请 AI 初审共用；未配置则不推豆包，委派材料由老板直接验、顺延直接进老板终审',
    placeholder: '豆包 Webhook 地址（…/webhook/whk_xxx）',
    features: [
      { key: 'aiTaskReview', env: 'AILY_TASK_REVIEW_ENABLED' },
      { key: 'aiBlockDeferReview', env: 'AILY_BLOCK_DEFER_REVIEW_ENABLED' },
      { key: 'aiAgentTaskPush', env: 'AILY_AGENT_TASK_PUSH_ENABLED' },
    ],
  },
];

/** 用到这项配置的开关一个都没开：返回悬停提示，否则 null */
function disabledHint(
  meta: AgentConfigMeta,
  integrations: OptionalIntegrations | null,
): string | null {
  if (!meta.features || integrations === null) return null;
  if (meta.features.some(({ key }) => integrations[key])) return null;
  return `环境变量 ${meta.features.map(({ env }) => env).join(' / ')} 没打开，这里填了也不生效`;
}

type NumericConfigMeta = {
  configKey: string;
  /** 要编辑的数字子字段 */
  field: string;
  name: string;
  description: string;
  placeholder: string;
  min: number;
  max: number;
  unit: string;
};

const NUMERIC_CONFIGS: NumericConfigMeta[] = [
  {
    configKey: 'block.defer_minutes',
    field: 'minutes',
    name: '堵塞顺延时长（分钟）',
    description: '员工提交堵塞时申请顺延的默认时长（分钟），审核通过后生效',
    placeholder: '如 30',
    min: 5,
    max: 480,
    unit: '分钟',
  },
];

const numericDraftKey = (meta: NumericConfigMeta): string =>
  `${meta.configKey}.${meta.field}`;

const agentDraftKey = (meta: AgentConfigMeta): string =>
  `${meta.configKey}.${meta.field}`;

const ConfigTab: React.FC = () => {
  const integrations = useOptionalIntegrations();
  const [items, setItems] = useState<SystemConfigItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SystemConfigItem | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [agentDrafts, setAgentDrafts] = useState<Record<string, string>>({});
  const [savingAgentKey, setSavingAgentKey] = useState<string | null>(null);
  const [numericDrafts, setNumericDrafts] = useState<Record<string, string>>({});
  const [numericErrors, setNumericErrors] = useState<Record<string, string>>({});
  const [savingNumericKey, setSavingNumericKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await getAdminConfig();
      const configItems: SystemConfigItem[] = response.items ?? [];
      setItems(configItems);
      const nextDrafts: Record<string, string> = {};
      for (const meta of AGENT_CONFIGS) {
        const item: SystemConfigItem | undefined = configItems.find(
          (it: SystemConfigItem) => it.configKey === meta.configKey,
        );
        const raw: unknown = item?.configValue?.[meta.field];
        nextDrafts[agentDraftKey(meta)] = typeof raw === 'string' ? raw : '';
      }
      setAgentDrafts(nextDrafts);
      const nextNumericDrafts: Record<string, string> = {};
      const nextNumericErrors: Record<string, string> = {};
      for (const meta of NUMERIC_CONFIGS) {
        const item: SystemConfigItem | undefined = configItems.find(
          (it: SystemConfigItem) => it.configKey === meta.configKey,
        );
        const raw: unknown = item?.configValue?.[meta.field];
        nextNumericDrafts[numericDraftKey(meta)] =
          typeof raw === 'number'
            ? String(raw)
            : typeof raw === 'string'
              ? raw
              : '';
        nextNumericErrors[numericDraftKey(meta)] = '';
      }
      setNumericDrafts(nextNumericDrafts);
      setNumericErrors(nextNumericErrors);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取系统配置失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openEdit = (item: SystemConfigItem): void => {
    setEditing(item);
    setDraft(JSON.stringify(item.configValue, null, 2));
  };

  const handleSave = async (): Promise<void> => {
    if (!editing) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(draft) as Record<string, unknown>;
    } catch {
      toast.error('JSON 格式不正确，请检查后再保存');
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      toast.error('配置值必须为 JSON 对象');
      return;
    }
    setSaving(true);
    try {
      await updateAdminConfig({ configKey: editing.configKey, configValue: parsed });
      toast.success('配置已保存');
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存配置失败');
    } finally {
      setSaving(false);
    }
  };

  const saveAgentConfig = async (meta: AgentConfigMeta): Promise<void> => {
    const draftKey = agentDraftKey(meta);
    const existing: SystemConfigItem | undefined = (items ?? []).find(
      (it: SystemConfigItem) => it.configKey === meta.configKey,
    );
    const base: Record<string, unknown> = existing?.configValue ?? {};
    const value: string = agentDrafts[draftKey] ?? '';
    const nextValue: Record<string, unknown> = { ...base, [meta.field]: value };
    setSavingAgentKey(draftKey);
    try {
      await updateAdminConfig({ configKey: meta.configKey, configValue: nextValue });
      toast.success(`「${meta.name}」已保存`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存配置失败');
    } finally {
      setSavingAgentKey(null);
    }
  };

  const saveNumericConfig = async (meta: NumericConfigMeta): Promise<void> => {
    const draftKey = numericDraftKey(meta);
    const raw: string = (numericDrafts[draftKey] ?? '').trim();
    const parsed: number = Number(raw);
    if (
      raw === '' ||
      !Number.isInteger(parsed) ||
      parsed < meta.min ||
      parsed > meta.max
    ) {
      setNumericErrors((prev: Record<string, string>) => ({
        ...prev,
        [draftKey]: `请输入 ${meta.min}-${meta.max} 之间的整数`,
      }));
      return;
    }
    setNumericErrors((prev: Record<string, string>) => ({
      ...prev,
      [draftKey]: '',
    }));
    const existing: SystemConfigItem | undefined = (items ?? []).find(
      (it: SystemConfigItem) => it.configKey === meta.configKey,
    );
    const base: Record<string, unknown> = existing?.configValue ?? {};
    const nextValue: Record<string, unknown> = { ...base, [meta.field]: parsed };
    setSavingNumericKey(draftKey);
    try {
      await updateAdminConfig({ configKey: meta.configKey, configValue: nextValue });
      toast.success(`「${meta.name}」已保存`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存配置失败');
    } finally {
      setSavingNumericKey(null);
    }
  };

  const renderNumericSection = (): React.ReactNode => (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Clock className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">业务参数配置</h3>
      </div>
      <div data-ai-section-type="card-list" className="space-y-4">
        {NUMERIC_CONFIGS.map((meta: NumericConfigMeta) => {
          const draftKey = numericDraftKey(meta);
          const draftValue = numericDrafts[draftKey] ?? '';
          const draftError = numericErrors[draftKey] ?? '';
          return (
            <div key={meta.configKey} className="rounded-xl border p-5">
              <div className="text-sm font-semibold">{meta.name}</div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {meta.description}
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="flex-1 space-y-1">
                  <Input
                    value={draftValue}
                    onChange={(
                      e: React.ChangeEvent<HTMLInputElement>,
                    ) => {
                      setNumericDrafts((prev: Record<string, string>) => ({
                        ...prev,
                        [draftKey]: e.target.value,
                      }));
                      setNumericErrors((prev: Record<string, string>) => ({
                        ...prev,
                        [draftKey]: '',
                      }));
                    }}
                    placeholder={meta.placeholder}
                    inputMode="numeric"
                    className="sm:max-w-[200px]"
                  />
                  {draftError !== '' && (
                    <p className="text-xs text-destructive">{draftError}</p>
                  )}
                </div>
                <Button
                  size="sm"
                  className="sm:shrink-0"
                  disabled={savingNumericKey !== null}
                  onClick={() => void saveNumericConfig(meta)}
                >
                  {savingNumericKey === draftKey ? '保存中…' : '保存'}
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                取值范围 {meta.min}-{meta.max} {meta.unit}，超出范围时将回退默认值。
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );

  const renderAgentSection = (): React.ReactNode => (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Bot className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">豆包（可选）</h3>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        不接豆包也能正常使用；留空或开关没开，对应功能自动降级。智能体 ID
        在豆包工作伙伴开发后台对应智能体的详情页获取。
      </p>
      <div data-ai-section-type="card-list" className="space-y-4">
        {AGENT_CONFIGS.map((meta: AgentConfigMeta) => {
          const draftKey = agentDraftKey(meta);
          const value = agentDrafts[draftKey] ?? '';
          const offHint = disabledHint(meta, integrations);
          return (
            <div key={meta.configKey} className="rounded-xl border p-5">
              <div className="flex items-center gap-2 text-sm font-semibold">
                {meta.name}
                {offHint !== null && (
                  <span
                    title={offHint}
                    className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground"
                  >
                    未启用
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {meta.description}
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  value={value}
                  onChange={(
                    e: React.ChangeEvent<HTMLInputElement>,
                  ) =>
                    setAgentDrafts((prev: Record<string, string>) => ({
                      ...prev,
                      [draftKey]: e.target.value,
                    }))
                  }
                  placeholder={meta.placeholder}
                  className="font-mono text-xs"
                />
                <Button
                  size="sm"
                  className="sm:shrink-0"
                  disabled={savingAgentKey !== null}
                  onClick={() => void saveAgentConfig(meta)}
                >
                  {savingAgentKey === draftKey ? '保存中…' : '保存'}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );

  if (error !== null) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">
        <span>{error}</span>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="h-3.5 w-3.5" />
          重试
        </Button>
      </div>
    );
  }

  if (items === null) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="space-y-6">
        {renderNumericSection()}
        {renderAgentSection()}
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          暂无系统配置项。
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {renderNumericSection()}
      {renderAgentSection()}
      <div data-ai-section-type="card-list" className="space-y-4">
      {items.map((item: SystemConfigItem) => (
        <button
          key={item.configKey}
          type="button"
          onClick={() => openEdit(item)}
          className="block w-full rounded-xl border p-5 text-left transition-colors hover:bg-accent"
        >
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            <span className="font-mono text-sm font-semibold">
              {item.configKey}
            </span>
          </div>
          {item.description !== null && (
            <p className="mt-1.5 text-sm text-muted-foreground">
              {item.description}
            </p>
          )}
          <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-muted/50 p-3 text-xs leading-relaxed">
            {JSON.stringify(item.configValue, null, 2)}
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">
            点击卡片编辑配置值
          </p>
        </button>
      ))}
      </div>

      <Dialog
        open={editing !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono">
              编辑配置：{editing?.configKey}
            </DialogTitle>
            <DialogDescription>
              配置值为 JSON 对象，保存前会校验格式。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="config-json">配置值（JSON）</Label>
            <Textarea
              id="config-json"
              value={draft}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                setDraft(e.target.value)
              }
              className="min-h-[180px] font-mono text-xs"
              placeholder='{"key": "value"}'
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              取消
            </Button>
            <Button disabled={saving} onClick={() => void handleSave()}>
              {saving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ConfigTab;

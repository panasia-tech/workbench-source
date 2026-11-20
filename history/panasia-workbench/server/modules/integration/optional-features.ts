import type { OptionalIntegrations } from '@shared/api.interface';

/**
 * 飞书 / 豆包可选集成的开关：全部是环境变量，默认全开（老板 10-18 定：要默认开启）。
 *
 * 默认开不等于必须配：工作台不配任何飞书、豆包也能完整使用（10-18 定的「脱离飞书独立使用」）——
 * 开着但没配好对应凭证与系统配置（智能体 ID、Webhook 地址等）时自动降级、不报错：通知只写站内消息，
 * AI 初审直接进老板终审，SOP 不生成、不同步 Wiki。配齐了就照妙搭时期的做法走。
 * 要关就设成 false / 0 / no / off；没设或别的值都算开。每次调用现读 process.env，改了重启生效。
 *
 * 豆包调我们的 MCP（/openapi/mcp）、审凭证兜底（/openapi/task-review/*）是外部调进来，不归这里管。
 */
export const OPTIONAL_FEATURES: Record<keyof OptionalIntegrations, string> = {
  /** 站内消息之外同时发飞书卡片（要 FEISHU_APP_ID / FEISHU_APP_SECRET） */
  feishuNotify: 'FEISHU_NOTIFY_ENABLED',
  /** SOP、顺延制度条文同步飞书 Wiki（要 AILY_APP_ID / AILY_APP_SECRET + 系统配置 sop.wiki_space_id） */
  feishuWikiSync: 'FEISHU_WIKI_SYNC_ENABLED',
  /** 委派任务交材料后推豆包 AI 审核（要 AILY_WEBHOOK_SECRET + 系统配置 task_review.webhook_url） */
  aiTaskReview: 'AILY_TASK_REVIEW_ENABLED',
  /** 顺延申请推豆包 AI 初审（Webhook 同上）；关着直接进老板终审 */
  aiBlockDeferReview: 'AILY_BLOCK_DEFER_REVIEW_ENABLED',
  /** 工单凭证齐后过豆包 AI 初审（要 AILY_APP_SECRET + 系统配置 workorder.ai_review_agent_id）；关着直接进老板终审 */
  aiWorkorderReview: 'AILY_WORKORDER_REVIEW_ENABLED',
  /** 快速下任务的「AI 草稿」（要 AILY_APP_SECRET + 系统配置 quick_task.draft_agent_id） */
  aiQuickTaskDraft: 'AILY_QUICK_TASK_DRAFT_ENABLED',
  /** 提交堵塞后豆包把「解决情况和方案」写成 SOP（智能体同快速下任务） */
  aiSop: 'AILY_SOP_ENABLED',
  /** 新建配置任务（POST /api/agent-tasks）时推豆包（Webhook 同委派材料审核） */
  aiAgentTaskPush: 'AILY_AGENT_TASK_PUSH_ENABLED',
};

export type OptionalFeature = keyof OptionalIntegrations;

function readFlag(raw: string | undefined): boolean {
  return !['0', 'false', 'no', 'off'].includes((raw ?? '').trim().toLowerCase());
}

export function isFeatureEnabled(feature: OptionalFeature): boolean {
  return readFlag(process.env[OPTIONAL_FEATURES[feature]]);
}

/** 各开关当前状态（GET /api/integrations，前端据此隐藏没开的按钮、改提示语） */
export function optionalFeatureStates(): OptionalIntegrations {
  const states = {} as OptionalIntegrations;
  for (const feature of Object.keys(OPTIONAL_FEATURES) as OptionalFeature[]) {
    states[feature] = isFeatureEnabled(feature);
  }
  return states;
}

/** 关着时的统一说明（日志、接口降级文案用） */
export function featureOffNote(feature: OptionalFeature): string {
  return `未启用（${OPTIONAL_FEATURES[feature]} 设成了关）`;
}

/**
 * 飞书开放平台地址：通知、Wiki 同步、豆包 OpenAPI 共用。
 * 国际版 Lark 改成 https://open.larksuite.com；本机验证时可指到桩上。
 */
export function feishuOpenBaseUrl(): string {
  return (
    (process.env.FEISHU_OPEN_BASE_URL ?? '').trim().replace(/\/+$/, '') ||
    'https://open.feishu.cn'
  );
}

// ---- plugin:panya_workbench_ai_assistant_1 ----
// ============================================================
// 插件 panya_workbench_ai_assistant_1 (泛亚工作台智能助手) 的类型定义
// 由 get_plugin_ai_json 自动生成
// ============================================================

export interface PanyaWorkbenchAiAssistantOneInput {
  /** 组装完成的完整提示词，包含系统人设、员工今日任务上下文、多轮对话历史和用户当前问题 */
  full_prompt: string;
}

/**
 * capabilityClient.load('panya_workbench_ai_assistant_1').callStream<PanyaWorkbenchAiAssistantOneOutput>('textGenerate', input)
 * 每个 chunk 就是下面这个扁平对象，字段名与 PanyaWorkbenchAiAssistantOneOutput 一致，外面没有 data / choices / message 包装：
 *   {"content":"示例文本","response":"示例文本"}
 * 返回值可能是 AsyncIterable<chunk>，也可能是 { output: AsyncIterable<chunk> }，取流前先归一化。
 * 逐段累加：
 *   for await (const chunk of stream) { result += chunk.content ?? ''; }
 */
export interface PanyaWorkbenchAiAssistantOneOutput {
  /** [object Object] */
  content: string;
  /** [object Object] */
  response?: string;
}
// ---- end:panya_workbench_ai_assistant_1 ----

// ---- plugin:panya_workbench_notification_1 ----
// ============================================================
// 插件 panya_workbench_notification_1 (泛亚工作台通知) 的类型定义
// 由 get_plugin_ai_json 自动生成
// ============================================================

export interface PanyaWorkbenchNotificationOneInput {
  /** 接收人用户ID列表 */
  receiverIds: string[];
  /** 消息卡片标题 */
  title: string;
  /** markdown格式正文内容 */
  content: string;
}

/**
 * capabilityClient.load('panya_workbench_notification_1').call<PanyaWorkbenchNotificationOneOutput>('send_feishu_message', input)
 * 直接返回此类型，无 .data 包装，直接解构使用：
 * const { success } = result;
 * 返回值形如：
 *   {"success":false}
 */
export interface PanyaWorkbenchNotificationOneOutput {
  /** [object Object] */
  success: boolean;
}
// ---- end:panya_workbench_notification_1 ----
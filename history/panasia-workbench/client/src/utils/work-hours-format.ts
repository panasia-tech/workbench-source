/** 任务描述里「工时=」报价的展示口径（服务端已换算成小时，天按 8 小时） */
export interface WorkHoursInput {
  workHours: number | null;
  workHoursText: string | null;
}

/**
 * 「6 小时」；原文不是按小时写的（「1.5天」「90分钟」）在后面括上原文；
 * 认不出数的只显示原文；没写工时返回 null（不渲染）。
 */
export function formatWorkHours(input: WorkHoursInput): string | null {
  const { workHours, workHoursText } = input;
  if (workHours === null) return workHoursText;
  const hours = `${Number(workHours.toFixed(2))} 小时`;
  const plain = (workHoursText ?? '').replace(/\s+/gu, '');
  return /^\d+(\.\d+)?(h|小时)?$/iu.test(plain) ? hours : `${hours}（${workHoursText}）`;
}

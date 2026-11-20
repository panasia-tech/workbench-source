import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';

import { TaskTemplateService } from './task-template.service';

/** 上海时间，无夏令时 */
const SHANGHAI_OFFSET_MS = 8 * 3600_000;
const DAY_MS = 24 * 3600_000;
const DEFAULT_AT = '08:00';

function parseClock(raw: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** 距下一个上海时间 hour:minute 的毫秒数 */
function msUntilNext(hour: number, minute: number, now: number): number {
  const shanghai = new Date(now + SHANGHAI_OFFSET_MS);
  let target =
    Date.UTC(
      shanghai.getUTCFullYear(),
      shanghai.getUTCMonth(),
      shanghai.getUTCDate(),
      hour,
      minute,
    ) - SHANGHAI_OFFSET_MS;
  if (target <= now) target += DAY_MS;
  return target - now;
}

/**
 * 每天按模板生成今日任务（原妙搭平台定时 task_template_daily_generate，一直没开）。
 * 默认关闭；TASK_TEMPLATE_DAILY_ENABLED=true 打开，TASK_TEMPLATE_DAILY_AT 改时刻（上海时间，默认 08:00）。
 * 生成本身按「同项目同标题同日」幂等，多实例同时跑也只会建一份。
 */
@Injectable()
export class TasksAutomationService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TasksAutomationService.name);
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly taskTemplateService: TaskTemplateService) {}

  onApplicationBootstrap(): void {
    if (process.env.TASK_TEMPLATE_DAILY_ENABLED !== 'true') {
      this.logger.log('每日模板任务未开启（TASK_TEMPLATE_DAILY_ENABLED=true 打开）');
      return;
    }
    const raw = process.env.TASK_TEMPLATE_DAILY_AT ?? DEFAULT_AT;
    const clock = parseClock(raw);
    if (!clock) {
      this.logger.error(`TASK_TEMPLATE_DAILY_AT「${raw}」不是 HH:mm，每日模板任务不启动`);
      return;
    }
    this.scheduleNext(clock.hour, clock.minute);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async generateTodayTasks() {
    this.logger.log('开始按模板生成今日任务');
    const result = await this.taskTemplateService.generateTodayTasks();
    this.logger.log(
      `模板生成完成：created=${result.created} skipped=${result.skipped}；${result.details.join('；')}`,
    );
    return result;
  }

  private scheduleNext(hour: number, minute: number): void {
    if (this.stopped) return;
    const delay = msUntilNext(hour, minute, Date.now());
    this.logger.log(
      `下次按模板生成今日任务：${Math.round(delay / 60_000)} 分钟后（上海时间 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}）`,
    );
    this.timer = setTimeout(() => {
      this.generateTodayTasks()
        .catch((error: unknown) => {
          this.logger.error(
            `每日模板任务失败：${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => this.scheduleNext(hour, minute));
    }, delay);
  }
}
